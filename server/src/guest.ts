import { splitGst } from '@sathya/tax'
import { appendAudit } from './audit-store'
import { ONLINE, linkSecret, linkToken, signFor } from './channels'
import type { Caller, Ctx } from './context'
import type { Db } from './db'
import { addDays, newId } from './eng-core'
import { businessDate } from './fo-core'

// The guest journey: the messages a guest gets at each step of a stay (queued here, sent by the WhatsApp
// provider when one is set up, or from the desk's own WhatsApp until then), the signed link to each room's
// QR page, and charges to the room for activities.

export interface WhatsAppSender { name: string; send(mobile: string, body: string, template: string): Promise<{ ref: string }> }

/** The address guests' links start with: PUBLIC_URL, else the address Render gives the service. */
export const publicBase = () => (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:8080').replace(/\/$/, '')

export async function roomToken(db: Db, spaceId: string) { return signFor(await linkSecret(db), `room:${spaceId}`) }
export async function roomLink(db: Db, spaceId: string) { return `${publicBase()}/room.html?s=${encodeURIComponent(spaceId)}&t=${await roomToken(db, spaceId)}` }

const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/** Each step's message: the booking confirmed, the day before arrival, on arrival, after the stay. */
export const TEMPLATES = ['confirmation', 'pre_arrival', 'welcome', 'feedback'] as const

/**
 * Queues the messages each live stay is due, once each: confirmation for a new booking, the day before
 * arrival (with directions and online check-in), a welcome with the room's QR page on check-in, and a
 * feedback link after check-out. Stays cancelled before a message went out have it skipped.
 */
export async function planMessages(db: Db, now: Date) {
  return db.tx(async (t) => {
    const today = await businessDate(t)
    const [p] = await t.query<{ name: string; address: string | null; city: string | null }>('select name, address, city from property limit 1')
    const map = process.env.RESORT_MAP_URL ?? (p.address ? `https://maps.google.com/?q=${encodeURIComponent([p.name, p.address, p.city].filter(Boolean).join(', '))}` : null)
    const rows = await t.query<{ id: string; status: string; guest: string; mobile: string | null; arrival: string; departure: string; room_type: string; space_id: string | null; created_at: Date; checked_out_at: Date | null }>(
      `select r.id, r.status, g.name as guest, g.mobile, r.arrival::text, r.departure::text, rt.name as room_type, r.space_id, r.created_at, r.checked_out_at
         from reservation r join guest g on g.id = r.guest_id join room_type rt on rt.id = r.room_type_id
        where g.mobile is not null and r.departure >= $1 and r.arrival <= $2`, [addDays(today, -3), addDays(today, 30)])
    let queued = 0
    const queue = async (r: (typeof rows)[number], template: string, body: string) => {
      const ins = await t.query(`insert into guest_message (id, reservation_id, mobile, template, body, due_at, created_at) values ($1,$2,$3,$4,$5,$6,$6) on conflict (reservation_id, template) do nothing returning id`,
        [newId('GM'), r.id, r.mobile, template, body, now])
      queued += ins.length
    }
    for (const r of rows) {
      const first = r.guest.split(' ')[0]
      const checkin = `${publicBase()}/checkin.html?r=${r.id}&t=${await linkToken(t, r.id)}`
      if (r.status === 'confirmed' && now.getTime() - new Date(r.created_at).getTime() < 7 * 86_400_000) {
        await queue(r, 'confirmation', `Dear ${first}, your stay at ${p.name} is confirmed: ${r.room_type}, ${day(r.arrival)} to ${day(r.departure)} (booking ${r.id}). Check in online to save time at the desk: ${checkin}`)
      }
      if (r.status === 'confirmed' && r.arrival <= addDays(today, 1) && r.arrival >= today) {
        await queue(r, 'pre_arrival', `Dear ${first}, we look forward to welcoming you on ${day(r.arrival)}.${map ? ` Directions: ${map}` : ''} Check-in is from 2 pm; if you have not yet, check in online: ${checkin}`)
      }
      if (r.status === 'in_house' && r.space_id) {
        await queue(r, 'welcome', `Welcome to ${p.name}, ${first}. Room service, housekeeping, things to do and help are on your room's page: ${await roomLink(t, r.space_id)} (also on the QR card in your room).`)
      }
      if (r.status === 'checked_out' && r.checked_out_at && now.getTime() - new Date(r.checked_out_at).getTime() < 3 * 86_400_000) {
        await queue(r, 'feedback', `Thank you for staying with us, ${first}. How was it? Two minutes of your time helps us a lot: ${publicBase()}/feedback.html?r=${r.id}&t=${await linkToken(t, r.id)}`)
      }
    }
    // A stay cancelled before its messages went out: they are not sent.
    await t.query(`update guest_message m set status = 'skipped' where m.status = 'queued' and exists (select 1 from reservation r where r.id = m.reservation_id and r.status in ('cancelled','no_show'))`)
    return queued
  })
}

/** Sends what is due through the WhatsApp provider, when there is one. */
export async function sendDue(db: Db, sender: WhatsAppSender | undefined, now: Date) {
  if (!sender) return 0
  const due = await db.query<{ id: string; mobile: string; body: string; template: string }>(`select id, mobile, body, template from guest_message where status = 'queued' and due_at <= $1 order by due_at limit 50`, [now])
  for (const m of due) {
    try {
      const r = await sender.send(m.mobile, m.body, m.template)
      await db.query(`update guest_message set status = 'sent', sent_at = $2, provider_ref = $3 where id = $1`, [m.id, now, r.ref])
    } catch (e) {
      await db.query(`update guest_message set status = 'failed', error = $2 where id = $1`, [m.id, String((e as Error).message).slice(0, 300)])
    }
  }
  return due.length
}

/** A charge on the guest's bill, with GST on top (an activity, for instance). */
export async function chargeRoom(ctx: Ctx, t: Db, who: Caller, reservationId: string, description: string, taxablePaise: number, gstRate: number) {
  const [f] = await t.query<{ id: string; status: string }>('select id, status from folio where reservation_id = $1 order by created_at limit 1 for update', [reservationId])
  if (!f || f.status !== 'open') return null
  const g = splitGst(taxablePaise, gstRate)
  const lineId = newId('L')
  await t.query(`insert into folio_line (id, folio_id, business_date, posted_at, kind, description, sac, gst_rate, taxable_paise, cgst_paise, sgst_paise, amount_paise, posted_by)
                 values ($1,$2,$3,$4,'misc',$5,$6,$7,$8,$9,$10,$11,$12)`,
    [lineId, f.id, await businessDate(t), ctx.now(), description, ctx.tax.gst.other_services?.activities_and_sports?.sac ?? null, gstRate, g.taxable, g.cgst, g.sgst, g.total, who.userId])
  await appendAudit(t, { actor: who, action: 'folio.charge', entity: { type: 'folio', id: f.id }, amount: g.total, after: { lineId, kind: 'misc', description, gstRate } }, ctx.now())
  return { lineId, total: g.total }
}

/** The stay in a room now, if any (for its QR page). */
export async function stayIn(t: Db, spaceId: string) {
  const [r] = await t.query<{ id: string; guest: string; departure: string }>(
    `select r.id, g.name as guest, r.departure::text from reservation r join guest g on g.id = r.guest_id where r.space_id = $1 and r.status = 'in_house' order by r.checked_in_at desc limit 1`, [spaceId])
  return r ?? null
}

/** Placeholder activities until the resort's own are entered. */
export async function ensureActivities(db: Db, now = new Date()) {
  const [{ c }] = await db.query<{ c: number }>('select count(*)::int as c from activity')
  if (c > 0) return
  const list: [string, string, string | null, number, string, number | null, string, string][] = [
    ['ACT-POOL', 'Swimming pool', 'POOL', 0, 'person', 40, '06:00', '20:00'],
    ['ACT-CRICKET', 'Cricket ground (nets and pitch)', 'GROUND-CRICKET', 1500, 'hour', 1, '06:00', '18:30'],
    ['ACT-CYCLE', 'Cycle hire', null, 200, 'hour', 10, '06:00', '18:00'],
    ['ACT-TOUR', 'Village and temple tour', null, 800, 'person', 12, '07:00', '12:00'],
  ]
  for (const [id, name, place, price, per, cap, opens, closes] of list) {
    await db.query('insert into activity (id, name, place, price_paise, per, capacity, opens, closes, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing', [id, name, place, price * 100, per, cap, opens, closes, now])
  }
}

export { ONLINE }
