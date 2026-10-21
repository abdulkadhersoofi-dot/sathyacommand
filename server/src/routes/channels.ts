import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, newId } from '../eng-core'
import { businessDate, nightsOf } from '../fo-core'
import { OTAS } from '../receivables'
import { buildAri, ONLINE } from '../channels'
import { requireCaller } from './auth'
import { bookStay } from './frontoffice'

// Rates and channels: selling rules (stop-sell, minimum stay, closed to arrival or departure), the channel
// manager's room codes, and its two calls: availability and rates out, OTA bookings in (new, changed,
// cancelled). A booking that cannot be placed is kept, flagged to God Mode and listed for the desk.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const n = (v: unknown) => Number(v ?? 0)

export function channelRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  /** The channel manager signs its calls with the shared key (CHANNEL_KEY). */
  function channelCaller(req: FastifyRequest) {
    if (!ctx.channelKey) throw new HttpError(404, 'No channel manager is set up.')
    const got = Buffer.from(String(req.headers['x-channel-key'] ?? '')), want = Buffer.from(ctx.channelKey)
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'Wrong channel key.')
  }

  // ---------- selling rules ----------
  app.get('/api/channels/restrictions', async (req) => {
    await need(req, 'revenue.manage', 'front_desk')
    const q = req.query as { from?: string; to?: string }
    const from = DATE.test(q.from ?? '') ? q.from! : await businessDate(db)
    const to = DATE.test(q.to ?? '') ? q.to! : addDays(from, 27)
    if (to < from || nightsOf(from, addDays(to, 1)).length > 92) throw new HttpError(400, 'Up to three months at a time.')
    const rows = await db.query('select room_type_id, day::text, stop_sell, min_stay, cta, ctd from rate_restriction where day between $1 and $2 order by day', [from, to])
    const types = await db.query('select id, name from room_type where active order by base_rate_paise')
    return { from, to, roomTypes: types, restrictions: rows }
  })

  /** Sets or clears a rule over a range of nights, for some room types and (optionally) only some weekdays. */
  app.put('/api/channels/restrictions', async (req) => {
    const who = await need(req, 'revenue.manage')
    const b = (req.body ?? {}) as { roomTypeIds?: string[]; from?: string; to?: string; weekdays?: number[]; stopSell?: boolean; minStay?: number | null; cta?: boolean; ctd?: boolean }
    if (!b.roomTypeIds?.length) throw new HttpError(400, 'Which room types?')
    if (!DATE.test(b.from ?? '') || !DATE.test(b.to ?? '') || b.to! < b.from!) throw new HttpError(400, 'From and to dates.')
    const days = nightsOf(b.from!, addDays(b.to!, 1)).filter((d) => !b.weekdays?.length || b.weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay()))
    if (days.length > 366) throw new HttpError(400, 'A year at most.')
    if (b.minStay != null && !(Number.isInteger(b.minStay) && b.minStay >= 1 && b.minStay <= 30)) throw new HttpError(400, 'Minimum stay: 1 to 30 nights.')
    const clear = !b.stopSell && !b.minStay && !b.cta && !b.ctd
    return db.tx(async (t) => {
      for (const rt of b.roomTypeIds!) {
        const [x] = await t.query('select 1 from room_type where id = $1', [rt])
        if (!x) throw new HttpError(400, `No room type ${rt}.`)
        for (const d of days) {
          if (clear) await t.query('delete from rate_restriction where room_type_id = $1 and day = $2', [rt, d])
          else await t.query(`insert into rate_restriction (room_type_id, day, stop_sell, min_stay, cta, ctd, set_by, set_at) values ($1,$2,$3,$4,$5,$6,$7,$8)
            on conflict (room_type_id, day) do update set stop_sell = excluded.stop_sell, min_stay = excluded.min_stay, cta = excluded.cta, ctd = excluded.ctd, set_by = excluded.set_by, set_at = excluded.set_at`,
            [rt, d, !!b.stopSell, b.minStay ?? null, !!b.cta, !!b.ctd, who.userId, now()])
        }
      }
      await appendAudit(t, { actor: who, action: clear ? 'rates.restrictions_cleared' : 'rates.restrictions_set', entity: { type: 'room_type', id: b.roomTypeIds!.join(',') }, after: { from: b.from, to: b.to, weekdays: b.weekdays ?? null, stopSell: !!b.stopSell, minStay: b.minStay ?? null, cta: !!b.cta, ctd: !!b.ctd } }, now())
      return { ok: true, nights: days.length }
    })
  })

  // ---------- room codes and the booking log ----------
  app.get('/api/channels/maps', async (req) => {
    await need(req, 'revenue.manage', 'front_desk')
    return { maps: await db.query('select * from channel_map order by channel, code'), connected: !!ctx.channelKey, channels: OTAS }
  })

  app.put('/api/channels/maps', async (req) => {
    const who = await need(req, 'revenue.manage')
    const b = (req.body ?? {}) as { channel?: string; code?: string; roomTypeId?: string; plan?: string; remove?: boolean }
    const channel = String(b.channel ?? '').trim().toLowerCase(), code = String(b.code ?? '').trim()
    if (!channel || !code) throw new HttpError(400, 'The channel and its room code.')
    return db.tx(async (t) => {
      if (b.remove) await t.query('delete from channel_map where channel = $1 and code = $2', [channel, code])
      else {
        const [rt] = await t.query('select 1 from room_type where id = $1', [b.roomTypeId]); if (!rt) throw new HttpError(400, 'Pick a room type.')
        const [p] = await t.query('select 1 from rate_plan where code = $1', [b.plan]); if (!p) throw new HttpError(400, 'Pick a meal plan.')
        await t.query('insert into channel_map (channel, code, room_type_id, plan_code) values ($1,$2,$3,$4) on conflict (channel, code) do update set room_type_id = excluded.room_type_id, plan_code = excluded.plan_code', [channel, code, b.roomTypeId, b.plan])
      }
      await appendAudit(t, { actor: who, action: 'channel.map', entity: { type: 'channel_map', id: `${channel}:${code}` }, after: b }, now())
      return { ok: true }
    })
  })

  app.get('/api/channels/bookings', async (req) => {
    await need(req, 'revenue.manage', 'front_desk')
    const status = (req.query as { status?: string }).status
    return db.query(`select c.id, c.channel, c.ota_ref, c.action, c.status, c.error, c.received_at, c.reservation_id, c.payload, u.name as resolved_by, c.resolved_at
                       from channel_booking c left join app_user u on u.id = c.resolved_by where ($1::text is null or c.status = $1) order by c.received_at desc limit 200`, [status ?? null])
  })

  app.post('/api/channels/bookings/:id/resolve', async (req) => {
    const who = await need(req, 'revenue.manage', 'front_desk')
    const note = String(((req.body ?? {}) as { note?: string }).note ?? '').trim()
    if (!note) throw new HttpError(400, 'What was done? (booked by hand as R-…, guest moved to another hotel…)')
    return db.tx(async (t) => {
      const r = await t.query<{ id: string }>(`update channel_booking set status = 'resolved', resolved_by = $2, resolved_at = $3, error = coalesce(error, '') || ' · ' || $4 where id = $1 and status = 'failed' returning id`, [(req.params as { id: string }).id, who.userId, now(), note])
      if (!r.length) throw new HttpError(404, 'No such failed booking.')
      await appendAudit(t, { actor: who, action: 'channel.booking_resolved', entity: { type: 'channel_booking', id: r[0].id }, note }, now())
      return { ok: true }
    })
  })

  app.get('/api/channels/ari', async (req) => {
    await need(req, 'revenue.manage', 'front_desk')
    const q = req.query as { from?: string; days?: string }
    return buildAri(db, DATE.test(q.from ?? '') ? q.from! : await businessDate(db), Math.min(90, Math.max(1, Number(q.days ?? 14))))
  })

  // ---------- the channel manager's calls ----------
  app.get('/channel/ari', async (req) => {
    channelCaller(req)
    const q = req.query as { from?: string; days?: string }
    return buildAri(db, DATE.test(q.from ?? '') ? q.from! : await businessDate(db), Math.min(365, Math.max(1, Number(q.days ?? 180))))
  })

  interface ChannelBooking { channel?: string; otaRef?: string; action?: 'new' | 'modify' | 'cancel'; roomCode?: string; roomTypeId?: string; plan?: string; arrival?: string; departure?: string
    adults?: number; children?: number; guest?: { name?: string; mobile?: string; email?: string }; nightly?: number[]; requests?: string }

  /**
   * An OTA booking from the channel manager, in the resort's own neutral form (the channel manager's adapter maps
   * its format to this): new, modify (dates, room or guests) or cancel, by the OTA's booking reference.
   */
  app.post('/channel/bookings', async (req) => {
    channelCaller(req)
    const b = (req.body ?? {}) as ChannelBooking
    const channel = String(b.channel ?? '').trim().toLowerCase(), otaRef = String(b.otaRef ?? '').trim(), action = b.action ?? 'new'
    if (!channel || !otaRef || !['new', 'modify', 'cancel'].includes(action)) throw new HttpError(400, 'channel, otaRef and action (new, modify, cancel).')
    const source = OTAS[channel] ? channel : 'travel_agent'
    const log = async (t: Db, status: string, reservationId: string | null, error: string | null) => {
      const id = newId('CB')
      await t.query('insert into channel_booking (id, channel, ota_ref, action, payload, reservation_id, status, error, received_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, channel, otaRef, action, JSON.stringify(b), reservationId, status, error, now()])
      return id
    }
    const live = async (t: Db) => (await t.query<{ id: string; status: string }>(
      `select id, status from reservation where ota_ref = $1 and source = $2 and status <> 'cancelled' order by created_at desc limit 1`, [otaRef, source]))[0]
    const place = async (t: Db) => {
      let roomTypeId = b.roomTypeId, plan = b.plan
      if (b.roomCode) {
        const [m] = await t.query<{ room_type_id: string; plan_code: string }>('select room_type_id, plan_code from channel_map where channel = $1 and code = $2', [channel, b.roomCode])
        if (!m) throw new HttpError(400, `Room code ${b.roomCode} from ${channel} is not mapped to a room type.`)
        roomTypeId = m.room_type_id; plan = m.plan_code
      }
      const nightly = b.nightly?.map((x) => Math.round(n(x)))
      const r = await bookStay(ctx, t, ONLINE, { guest: { name: b.guest?.name, mobile: b.guest?.mobile, email: b.guest?.email }, roomTypeId, plan: plan ?? 'EP', arrival: b.arrival, departure: b.departure,
        adults: b.adults ?? 2, children: b.children ?? 0, source, otaRef, requests: b.requests, nightAmounts: nightly?.length ? nightly : undefined })
      // An OTA price above ₹7,500 a night would move the restaurant to 18% next year: God Mode is told at once.
      if (nightly?.some((x) => x > 750_000)) await appendAudit(t, { actor: ONLINE, action: 'rate.above_limit_from_channel', entity: { type: 'reservation', id: r.id }, amount: Math.max(...nightly), note: `${channel} ${otaRef}` }, now())
      return r
    }
    try {
      return await db.tx(async (t) => {
        const cur = await live(t)
        if (action === 'new') {
          if (cur) { await log(t, 'duplicate', cur.id, null); return { accepted: true, reservationId: cur.id, duplicate: true } }
          const r = await place(t)
          await log(t, 'applied', r.id, null)
          await appendAudit(t, { actor: ONLINE, action: 'channel.booking', entity: { type: 'reservation', id: r.id }, amount: r.roomTotal, note: `${channel} ${otaRef}` }, now())
          return { accepted: true, reservationId: r.id }
        }
        if (!cur) throw new HttpError(404, `No live booking ${otaRef} from ${channel}.`)
        if (cur.status !== 'confirmed') throw new HttpError(409, `Booking ${otaRef} is ${cur.status.replace('_', ' ')}: the desk changes it.`)
        await t.query('update room_night set released = true where reservation_id = $1', [cur.id])
        await t.query(`update reservation set status = 'cancelled', cancel_reason = $2 where id = $1`, [cur.id, action === 'cancel' ? `Cancelled on ${channel}` : `Changed on ${channel}`])
        if (action === 'cancel') {
          await log(t, 'applied', cur.id, null)
          await appendAudit(t, { actor: ONLINE, action: 'channel.cancel', entity: { type: 'reservation', id: cur.id }, note: `${channel} ${otaRef}` }, now())
          return { accepted: true, reservationId: cur.id, cancelled: true }
        }
        const r = await place(t)
        await log(t, 'applied', r.id, null)
        await appendAudit(t, { actor: ONLINE, action: 'channel.modify', entity: { type: 'reservation', id: r.id }, before: { reservationId: cur.id }, note: `${channel} ${otaRef}` }, now())
        return { accepted: true, reservationId: r.id, replaces: cur.id }
      })
    } catch (e) {
      // Kept and flagged: an OTA guest the resort cannot place is a problem for today, not a lost message.
      const msg = (e as Error).message
      await db.tx(async (t) => {
        const id = await log(t, 'failed', null, msg)
        await appendAudit(t, { actor: ONLINE, action: 'channel.booking_failed', entity: { type: 'channel_booking', id }, note: `${channel} ${otaRef}: ${msg}` }, now())
      })
      return { accepted: false, reason: msg }
    }
  })
}
