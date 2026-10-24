import type { FastifyInstance } from 'fastify'
import { auditBus, type LiveEvent } from '../audit-store'
import { HttpError, type Ctx } from '../context'
import { businessDate, LODGING } from '../fo-core'
import { requireCaller } from './auth'

// Feeds the 3D Command dashboard: one snapshot call, then a live stream of what changes.

export function dashboardRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db

  app.get('/api/dashboard', async (req) => {
    const who = await requireCaller(ctx, req)
    const q = req.query as { from?: string; to?: string }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '')) throw new HttpError(400, 'Send from and to (YYYY-MM-DD).')
    const spaces = await db.query(
      `select s.id, s.twin_id, s.kind, s.name, s.room_no, s.room_type_id, t.name as room_type, t.base_rate_paise, t.max_occupancy,
              s.building, s.floor, s.capacity, s.sellable, h.status as hk_status, h.dnd
         from space s left join room_type t on t.id = s.room_type_id left join room_hk h on h.space_id = s.id where s.active order by s.building, s.floor, s.room_no, s.name`)
    const reservations = await db.query<{ mobile: string | null }>(
      `select r.id, r.status, g.name as guest, g.mobile, g.nationality, g.vip, r.adults + r.children as pax, r.arrival::text, r.departure::text,
              r.eta, r.checked_in_at, r.checked_out_at, r.source, r.requests, r.room_type_id, r.space_id, s.twin_id, s.room_no,
              r.bill_to_company, r.pay_by, r.ota_ref, exists (select 1 from online_checkin oc where oc.reservation_id = r.id) as online_checkin,
              (select count(*)::int from reservation p where p.guest_id = r.guest_id and p.status = 'checked_out' and p.id <> r.id) as past_stays,
              (select coalesce(round(avg(amount_paise)), 0)::bigint from room_night rn where rn.reservation_id = r.id) as rate_paise,
              (select coalesce(sum(l.amount_paise), 0)::bigint from folio_line l join folio f on f.id = l.folio_id where f.reservation_id = r.id) as balance_paise,
              (select id from folio f where f.reservation_id = r.id order by created_at limit 1) as folio_id,
              (select coalesce(-sum(l.amount_paise), 0)::bigint from folio_line l join folio f on f.id = l.folio_id where f.reservation_id = r.id and l.kind in ('payment', 'refund')) as paid_paise,
              (select coalesce(sum(round((rn.amount_paise + rn.extras_paise) * case when rn.amount_paise > 750000 then 1.18 else 1.05 end)), 0)::bigint
                 from room_night rn where rn.reservation_id = r.id and not rn.released and rn.posted_line_id is null) as pending_paise,
              (select count(*)::int from fnb_order o where o.reservation_id = r.id and o.status in ('open', 'billed'))
                + (select count(*)::int from laundry_order l where l.reservation_id = r.id and l.status = 'picked_up') as open_items
         from reservation r join guest g on g.id = r.guest_id left join space s on s.id = r.space_id
        where r.departure >= $1 and r.arrival <= $2 and r.status <> 'cancelled'
        order by r.arrival`, [q.from, q.to])
    const full = who.permissions.has('*')
    return {
      businessDate: await businessDate(db),
      lodgingKinds: LODGING,
      spaces,
      reservations: reservations.map((r) => ({ ...r, mobile: r.mobile && !full ? r.mobile.slice(0, 5) + '•••••' + r.mobile.slice(-3) : r.mobile })),
    }
  })

  // Server-sent events: one line per logged action, plus a heartbeat so proxies keep the connection open.
  app.get('/api/stream', async (req, reply) => {
    await requireCaller(ctx, req)
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    reply.raw.write(': connected\n\n')
    const send = (e: LiveEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    auditBus.on('event', send)
    const beat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    req.raw.on('close', () => { auditBus.off('event', send); clearInterval(beat) })
    return reply
  })
}
