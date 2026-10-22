import { addDays } from '@sathya/tax'
import { HttpError } from './context'
import type { Db } from './db'

// Shared front-office rules used by reservations, approvals and the night audit.

export const PROPERTY = 'sathya'
export const LODGING = ['room', 'villa', 'suite', 'cottage', 'tent', 'dormitory']

export async function businessDate(db: Db): Promise<string> {
  const [p] = await db.query<{ d: string }>('select business_date::text as d from property where id = $1', [PROPERTY])
  return p.d
}

export function nightsOf(arrival: string, departure: string): string[] {
  const out: string[] = []
  for (let d = arrival; d < departure; d = addDays(d, 1)) out.push(d)
  return out
}

export async function rateFor(db: Db, plan: string, roomTypeId: string, date: string): Promise<number | null> {
  const [r] = await db.query<{ amount_paise: number }>(
    `select r.amount_paise from rate r join rate_plan p on p.id = r.rate_plan_id
      where p.code = $1 and r.room_type_id = $2 and $3::date between r.valid_from and r.valid_to
      order by r.valid_from desc limit 1`, [plan, roomTypeId, date])
  return r?.amount_paise ?? null
}

/**
 * Rooms of a type still free on each night: active rooms, less any out of order that night, minus live booked
 * nights, minus rooms still held (not yet picked up) in open room blocks other than `excludeBlock`.
 */
export async function freeByNight(db: Db, roomTypeId: string, nights: string[], excludeReservation?: string, excludeBlock?: string) {
  const rows = await db.query<{ night: string; free: number }>(
    `select n::date::text as night,
            (select count(*) from space s where s.room_type_id = $1 and s.active and s.sellable and s.kind = any($3)
                and not exists (select 1 from room_hk h where h.space_id = s.id and h.status = 'out_of_order'
                                  and (h.ooo_from is null or h.ooo_from <= n::date) and (h.ooo_to is null or h.ooo_to >= n::date)))
          - (select count(*) from room_night rn where rn.room_type_id = $1 and rn.night = n::date and not rn.released
               and rn.reservation_id is distinct from $4)
          - (select coalesce(sum(greatest(0, l.rooms - (select count(*) from room_night rn join reservation r on r.id = rn.reservation_id
                                                          where r.block_id = k.id and rn.room_type_id = $1 and rn.night = n::date and not rn.released))), 0)
               from room_block k join room_block_line l on l.block_id = k.id
              where l.room_type_id = $1 and k.status = 'open' and n::date >= k.arrival and n::date < k.departure and k.id is distinct from $5) as free
       from unnest($2::date[]) n`, [roomTypeId, nights, LODGING, excludeReservation ?? null, excludeBlock ?? null])
  return rows.map((r) => ({ night: r.night, free: Number(r.free) }))
}

export async function folioBalance(db: Db, folioId: string): Promise<number> {
  const [r] = await db.query<{ b: number }>('select coalesce(sum(amount_paise), 0)::bigint as b from folio_line where folio_id = $1', [folioId])
  return Number(r.b)
}

export async function reservationBalance(db: Db, reservationId: string): Promise<number> {
  const [r] = await db.query<{ b: number }>(
    `select coalesce(sum(l.amount_paise), 0)::bigint as b from folio_line l join folio f on f.id = l.folio_id where f.reservation_id = $1`, [reservationId])
  return Number(r.b)
}

/** Sets every unposted night to the rate-table price less `percent`. Repeating it replaces, never compounds. */
export async function applyDiscount(db: Db, reservationId: string, percent: number) {
  const [res] = await db.query<{ rate_plan_code: string; room_type_id: string; status: string }>(
    'select rate_plan_code, room_type_id, status from reservation where id = $1', [reservationId])
  if (!res) throw new HttpError(404, 'No such reservation.')
  if (!['confirmed', 'in_house'].includes(res.status)) throw new HttpError(409, `Reservation is ${res.status}.`)
  const nights = await db.query<{ night: string }>(
    'select night::text from room_night where reservation_id = $1 and not released and posted_line_id is null order by night', [reservationId])
  for (const n of nights) {
    const base = await rateFor(db, res.rate_plan_code, res.room_type_id, n.night)
    if (base == null) continue
    await db.query('update room_night set amount_paise = $3 where reservation_id = $1 and night = $2',
      [reservationId, n.night, Math.round(base * (100 - percent) / 100)])
  }
  return nights.length
}

/** What a guest still has open besides the room bill: orders not yet charged to the room, laundry not yet delivered. */
export interface OpenStayItems {
  orders: { id: string; number: number; outlet: string; kind: string; status: string; subtotal_paise: number; sent_items: number; pending_items: number; opened_at: string }[]
  laundry: { id: string; items: { name: string; qty: number }[]; express: boolean; total_paise: number; picked_at: string }[]
}
export async function openStayItems(db: Db, reservationId: string): Promise<OpenStayItems> {
  const orders = await db.query<OpenStayItems['orders'][number]>(
    `select o.id, o.number, ot.name as outlet, o.kind, o.status, o.opened_at,
            coalesce((select sum(i.price_paise * i.qty) from order_item i where i.order_id = o.id and i.status <> 'void'), 0)::bigint as subtotal_paise,
            (select count(*)::int from order_item i where i.order_id = o.id and i.status = 'sent') as sent_items,
            (select count(*)::int from order_item i where i.order_id = o.id and i.status = 'pending') as pending_items
       from fnb_order o join outlet ot on ot.id = o.outlet_id
      where o.reservation_id = $1 and o.status in ('open', 'billed') order by o.opened_at`, [reservationId])
  const laundry = await db.query<OpenStayItems['laundry'][number]>(
    `select id, items, express, total_paise, picked_at from laundry_order where reservation_id = $1 and status = 'picked_up' order by picked_at`, [reservationId])
  return { orders: orders.map((o) => ({ ...o, subtotal_paise: Number(o.subtotal_paise) })), laundry: laundry.map((l) => ({ ...l, total_paise: Number(l.total_paise) })) }
}
/** One line per open item, for a refusal message. */
export function describeOpenItems(items: OpenStayItems) {
  return [
    ...items.orders.map((o) => `${o.outlet} order ${o.number} (₹${(o.subtotal_paise / 100).toFixed(0)}) is not on the room bill`),
    ...items.laundry.map((l) => `laundry (${l.items.reduce((a, i) => a + i.qty, 0)} items) is not delivered`),
  ]
}
