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

/** Rooms of a type still free on each night (active rooms minus live booked nights). */
export async function freeByNight(db: Db, roomTypeId: string, nights: string[], excludeReservation?: string) {
  const rows = await db.query<{ night: string; free: number }>(
    `select n::date::text as night,
            (select count(*) from space s where s.room_type_id = $1 and s.active and s.sellable and s.kind = any($3))
          - (select count(*) from room_night rn where rn.room_type_id = $1 and rn.night = n::date and not rn.released
               and rn.reservation_id is distinct from $4) as free
       from unnest($2::date[]) n`, [roomTypeId, nights, LODGING, excludeReservation ?? null])
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
