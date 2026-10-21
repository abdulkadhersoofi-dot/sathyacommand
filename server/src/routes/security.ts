import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { istDay, newId, positionOf } from '../eng-core'
import { geoSettings, toMap } from '../geo'
import { qrLabelsPage } from '../qr-labels'
import { requireCaller } from './auth'

// Security: the gate register (vehicles, visitors, vendors, deliveries, guest vehicle tags, parking),
// guard patrols by QR checkpoint with missed-checkpoint alerts, incidents, CCTV cameras, the key
// register, and emergency mode with a roll-call of everyone on duty and assembly points on the map.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const GATE_KINDS = ['guest_vehicle', 'visitor', 'vendor', 'delivery', 'taxi', 'staff_vehicle']
const INCIDENT_KINDS = ['theft', 'injury', 'fire', 'fight', 'damage', 'trespass', 'guest_complaint', 'lost_child', 'other']
const SEVERITIES = ['low', 'medium', 'high', 'critical']
const PATROL_GRACE_MIN = 10
const SYSTEM: Caller = { userId: 'system', name: 'System', role: 'system', roles: [], godMode: false, permissions: new Set(), sessionId: '', scope: 'full' }

const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
const istMinutes = (d: Date) => { const s = new Date(d.getTime() + 330 * 60_000).toISOString(); return Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16)) }
const istAt = (day: string, minutes: number) => new Date(new Date(`${day}T00:00:00+05:30`).getTime() + minutes * 60_000)
const plate = (v?: string | null) => (v ? v.toUpperCase().replace(/[^A-Z0-9]/g, '') : null)

/** When the route's current patrol window began, or null when the route is not running now. */
export function windowStart(route: { starts: string; ends: string }, now: Date): Date | null {
  const m = istMinutes(now), s = hm(route.starts), e = hm(route.ends), today = istDay(now)
  if (s === e) return istAt(today, s) <= now ? istAt(today, s) : istAt(istDay(new Date(now.getTime() - 86_400_000)), s)   // all day
  if (s < e) return m >= s && m < e ? istAt(today, s) : null
  if (m >= s) return istAt(today, s)
  if (m < e) return istAt(istDay(new Date(now.getTime() - 86_400_000)), s)
  return null
}

/** Checkpoints whose patrol is overdue on a running route: last scan (or the window start) older than the interval plus grace. */
export async function overdueCheckpoints(db: Db, now: Date) {
  const routes = await db.query<{ id: string; name: string; checkpoint_ids: string[]; every_minutes: number; starts: string; ends: string }>('select * from patrol_route where active')
  const out = new Map<string, { since: Date; route: string; minutes: number }>()
  for (const r of routes) {
    const start = windowStart(r, now)
    if (!start) continue
    for (const cp of r.checkpoint_ids) {
      const [last] = await db.query<{ at: string }>('select at from patrol_scan where checkpoint_id = $1 order by at desc limit 1', [cp])
      const since = last && new Date(last.at) > start ? new Date(last.at) : start
      const late = (now.getTime() - since.getTime()) / 60_000 - r.every_minutes
      if (late > PATROL_GRACE_MIN && (!out.has(cp) || out.get(cp)!.since > since)) out.set(cp, { since, route: r.name, minutes: Math.round((now.getTime() - since.getTime()) / 60_000) })
    }
  }
  return out
}

/** Missed patrol checkpoints and keys not returned on time, alerted once each (runs every minute and before the lists are read). */
export async function sweepSecurity(db: Db, now: Date) {
  await db.tx(async (t) => {
    for (const [cp, o] of await overdueCheckpoints(t, now)) {
      const [c] = await t.query<{ name: string; missed_alert_at: string | null }>('select name, missed_alert_at from checkpoint where id = $1 and active', [cp])
      if (!c || (c.missed_alert_at && new Date(c.missed_alert_at) >= o.since)) continue
      await t.query('update checkpoint set missed_alert_at = $2 where id = $1', [cp, now])
      await appendAudit(t, { actor: SYSTEM, action: 'security.patrol_missed', entity: { type: 'checkpoint', id: cp }, after: { checkpoint: c.name, route: o.route, minutesSinceLastScan: o.minutes } }, now)
    }
    const keys = await t.query<{ id: string; key_id: string; label: string; issued_to: string }>(
      `select l.id, l.key_id, k.label, l.issued_to from key_log l join key_item k on k.id = l.key_id where l.back_at is null and l.due_back < $1 and not l.alerted`, [now])
    for (const k of keys) {
      await t.query('update key_log set alerted = true where id = $1', [k.id])
      await appendAudit(t, { actor: SYSTEM, action: 'security.key_overdue', entity: { type: 'key', id: k.key_id }, after: { key: k.label, with: k.issued_to } }, now)
    }
  })
}

export function securityRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  /** A place on the map from what the form sent: a pin, a room, or the phone's GPS. */
  async function place(t: Db, b: { x?: number; z?: number; spaceId?: string; lat?: number; lng?: number }) {
    if (b.x != null && b.z != null) return { x: Number(b.x), z: Number(b.z) }
    if (!b.spaceId && Number.isFinite(b.lat) && Number.isFinite(b.lng)) return toMap(await geoSettings(t), b.lat!, b.lng!)
    return null
  }

  // ---------- gate register ----------
  app.get('/api/security/gate', async (req) => {
    await need(req, 'security.gate', 'security.view')
    const q = req.query as { day?: string; inside?: string }
    const rows = await db.query(
      `select e.*, u.name as in_by_name, o.name as out_by_name, g.name as guest, s.room_no
         from gate_entry e join app_user u on u.id = e.in_by left join app_user o on o.id = e.out_by
         left join reservation r on r.id = e.reservation_id left join guest g on g.id = r.guest_id left join space s on s.id = r.space_id
        where ${q.inside ? 'e.out_at is null' : `(e.out_at is null or (e.in_at + interval '330 minutes')::date = $1::date)`} order by e.in_at desc limit 300`,
      q.inside ? [] : [q.day ?? istDay(now())])
    return rows
  })

  // Guests staying or arriving, to tag their vehicle at the gate.
  app.get('/api/security/gate/guests', async (req) => {
    await need(req, 'security.gate')
    return db.query(
      `select r.id, g.name, s.room_no, r.status, r.arrival::text, r.departure::text from reservation r join guest g on g.id = r.guest_id left join space s on s.id = r.space_id
        where r.status = 'in_house' or (r.status = 'confirmed' and r.arrival <= $1::date + 1 and r.departure >= $1::date) order by g.name`, [istDay(now())])
  })

  app.post('/api/security/gate', async (req, reply) => {
    const who = await need(req, 'security.gate')
    const b = (req.body ?? {}) as { kind?: string; name?: string; mobile?: string; vehicleNo?: string; pax?: number; purpose?: string; host?: string; reservationId?: string; tagNo?: string; parking?: string; x?: number; z?: number; lat?: number; lng?: number; photoId?: string; note?: string }
    if (!GATE_KINDS.includes(b.kind ?? '')) throw new HttpError(400, `Kind: ${GATE_KINDS.join(', ')}.`)
    if (b.kind === 'guest_vehicle' && !b.reservationId) throw new HttpError(400, 'Choose the guest the vehicle belongs to.')
    if (['guest_vehicle', 'taxi', 'staff_vehicle'].includes(b.kind!) && !plate(b.vehicleNo)) throw new HttpError(400, 'Enter the vehicle number.')
    if (['visitor', 'vendor', 'delivery'].includes(b.kind!) && !b.name?.trim()) throw new HttpError(400, 'Enter the name (person or company).')
    if (b.mobile && !/^[6-9]\d{9}$/.test(b.mobile.replace(/\D/g, '').slice(-10))) throw new HttpError(400, 'Enter a 10-digit Indian mobile number (with or without +91).')
    const id = newId('GE')
    return db.tx(async (t) => {
      const pos = await place(t, b)
      if (b.reservationId) { const [r] = await t.query('select 1 from reservation where id = $1', [b.reservationId]); if (!r) throw new HttpError(404, 'No such booking.') }
      if (b.tagNo?.trim()) { const [x] = await t.query('select 1 from gate_entry where tag_no = $1 and out_at is null', [b.tagNo.trim()]); if (x) throw new HttpError(409, `Tag ${b.tagNo.trim()} is already on a vehicle inside.`) }
      await t.query(
        `insert into gate_entry (id, kind, name, mobile, vehicle_no, pax, purpose, host, reservation_id, tag_no, parking, x, z, photo_id, in_at, in_by, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, b.kind, b.name?.trim() || null, b.mobile ? b.mobile.replace(/\D/g, '').slice(-10) : null, plate(b.vehicleNo), b.pax ?? null, b.purpose?.trim() || null, b.host?.trim() || null,
          b.reservationId ?? null, b.tagNo?.trim() || null, b.parking?.trim() || null, pos?.x ?? null, pos?.z ?? null, b.photoId ?? null, now(), who.userId, b.note?.trim() || null])
      await appendAudit(t, { actor: who, action: 'security.gate_in', entity: { type: 'gate_entry', id }, after: { kind: b.kind, vehicle: plate(b.vehicleNo), name: b.name ?? null } }, now())
      return reply.status(201).send({ id })
    })
  })

  app.post('/api/security/gate/:id/out', async (req) => {
    const who = await need(req, 'security.gate')
    const { id } = req.params as { id: string }
    return db.tx(async (t) => {
      const [e] = await t.query<{ out_at: string | null; vehicle_no: string | null; name: string | null }>('select out_at, vehicle_no, name from gate_entry where id = $1 for update', [id])
      if (!e) throw new HttpError(404, 'No such entry.')
      if (e.out_at) throw new HttpError(409, 'Already marked out.')
      await t.query('update gate_entry set out_at = $2, out_by = $3 where id = $1', [id, now(), who.userId])
      await appendAudit(t, { actor: who, action: 'security.gate_out', entity: { type: 'gate_entry', id }, after: { vehicle: e.vehicle_no, name: e.name } }, now())
      return { ok: true }
    })
  })

  // ---------- checkpoints and patrols ----------
  app.get('/api/security/checkpoints', async (req) => {
    await need(req, 'security.gate', 'security.view')
    await sweepSecurity(db, now())
    const overdue = await overdueCheckpoints(db, now())
    const rows = await db.query<{ id: string }>(
      `select c.id, c.name, c.code, c.space_id, s.name as space, c.x, c.z, c.active,
              (select max(at) from patrol_scan p where p.checkpoint_id = c.id) as last_scan,
              (select u.name from patrol_scan p join app_user u on u.id = p.by_user where p.checkpoint_id = c.id order by p.at desc limit 1) as last_by
         from checkpoint c left join space s on s.id = c.space_id order by c.active desc, c.name`)
    return rows.map((c) => ({ ...c, overdue: overdue.has(c.id), overdueMinutes: overdue.get(c.id)?.minutes ?? null }))
  })

  app.post('/api/security/checkpoints', async (req, reply) => {
    const who = await need(req, 'security.manage')
    const b = (req.body ?? {}) as { name?: string; spaceId?: string; x?: number; z?: number; lat?: number; lng?: number }
    if (!b.name?.trim()) throw new HttpError(400, 'Name the checkpoint (e.g. "Back gate", "DG room").')
    const id = newId('CP'), code = `SP-CP-${randomBytes(4).toString('hex').toUpperCase()}`
    await db.tx(async (t) => {
      const pos = await place(t, b)
      await t.query('insert into checkpoint (id, name, code, space_id, x, z) values ($1,$2,$3,$4,$5,$6)', [id, b.name!.trim(), code, b.spaceId || null, pos?.x ?? null, pos?.z ?? null])
      await appendAudit(t, { actor: who, action: 'security.checkpoint_add', entity: { type: 'checkpoint', id }, after: { name: b.name, code } }, now())
    })
    return reply.status(201).send({ id, code })
  })

  app.patch('/api/security/checkpoints/:id', async (req) => {
    const who = await need(req, 'security.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; active?: boolean; spaceId?: string | null; lat?: number; lng?: number; x?: number; z?: number }
    return db.tx(async (t) => {
      const [before] = await t.query('select * from checkpoint where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such checkpoint.')
      const pos = await place(t, { ...b, spaceId: b.spaceId ?? undefined })
      await t.query(`update checkpoint set name = coalesce($2, name), active = coalesce($3, active), space_id = case when $4::boolean then $5 else space_id end,
                       x = coalesce($6, x), z = coalesce($7, z) where id = $1`, [id, b.name?.trim() || null, b.active ?? null, b.spaceId !== undefined, b.spaceId || null, pos?.x ?? null, pos?.z ?? null])
      const [after] = await t.query('select * from checkpoint where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'security.checkpoint_update', entity: { type: 'checkpoint', id }, before, after }, now())
      return after
    })
  })

  app.get('/api/security/checkpoints/labels', async (req, reply) => {
    await need(req, 'security.manage')
    const cps = await db.query<{ name: string; code: string }>('select name, code from checkpoint where active order by name')
    return reply.type('text/html; charset=utf-8').send(qrLabelsPage('Patrol checkpoint QR codes', 'Security patrol: scan with the Sathya staff app', cps))
  })

  app.get('/api/security/routes', async (req) => {
    await need(req, 'security.gate', 'security.view')
    return db.query('select * from patrol_route order by active desc, starts')
  })

  function checkRoute(b: { name?: string; checkpointIds?: string[]; everyMinutes?: number; starts?: string; ends?: string }, partial: boolean) {
    if (!partial || b.name !== undefined) if (!b.name?.trim()) throw new HttpError(400, 'Name the round (e.g. "Night round").')
    if (!partial || b.checkpointIds !== undefined) if (!Array.isArray(b.checkpointIds) || !b.checkpointIds.length) throw new HttpError(400, 'Pick the checkpoints in order.')
    if (!partial || b.everyMinutes !== undefined) if (!(Number.isInteger(b.everyMinutes) && b.everyMinutes! >= 15 && b.everyMinutes! <= 1440)) throw new HttpError(400, 'Every 15–1440 minutes.')
    for (const k of ['starts', 'ends'] as const) if (!partial || b[k] !== undefined) if (!HHMM.test(b[k] ?? '')) throw new HttpError(400, 'Start and end times as HH:MM (the same time for all day).')
  }

  app.post('/api/security/routes', async (req, reply) => {
    const who = await need(req, 'security.manage')
    const b = (req.body ?? {}) as { name?: string; checkpointIds?: string[]; everyMinutes?: number; starts?: string; ends?: string }
    checkRoute(b, false)
    const id = newId('PR')
    await db.tx(async (t) => {
      const found = await t.query('select id from checkpoint where id = any($1)', [b.checkpointIds])
      if (found.length !== new Set(b.checkpointIds).size) throw new HttpError(404, 'Unknown checkpoint.')
      await t.query('insert into patrol_route (id, name, checkpoint_ids, every_minutes, starts, ends) values ($1,$2,$3,$4,$5,$6)', [id, b.name!.trim(), b.checkpointIds, b.everyMinutes, b.starts, b.ends])
      await appendAudit(t, { actor: who, action: 'security.route_add', entity: { type: 'patrol_route', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/security/routes/:id', async (req) => {
    const who = await need(req, 'security.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; checkpointIds?: string[]; everyMinutes?: number; starts?: string; ends?: string; active?: boolean }
    checkRoute(b, true)
    return db.tx(async (t) => {
      const [before] = await t.query('select * from patrol_route where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such round.')
      await t.query(`update patrol_route set name = coalesce($2, name), checkpoint_ids = coalesce($3, checkpoint_ids), every_minutes = coalesce($4, every_minutes),
                       starts = coalesce($5, starts), ends = coalesce($6, ends), active = coalesce($7, active) where id = $1`,
        [id, b.name?.trim() || null, b.checkpointIds ?? null, b.everyMinutes ?? null, b.starts ?? null, b.ends ?? null, b.active ?? null])
      const [after] = await t.query('select * from patrol_route where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'security.route_update', entity: { type: 'patrol_route', id }, before, after }, now())
      return after
    })
  })

  // The guard scans the QR label at a checkpoint: proof of the round, and their place on the map.
  app.post('/api/security/scan', async (req, reply) => {
    const who = await need(req, 'security.gate')
    const b = (req.body ?? {}) as { code?: string; note?: string; photoId?: string }
    return db.tx(async (t) => {
      const [c] = await t.query<{ id: string; name: string; space_id: string | null; x: string | null; z: string | null }>('select id, name, space_id, x, z from checkpoint where code = $1 and active', [String(b.code ?? '').trim()])
      if (!c) throw new HttpError(404, 'That QR code is not a patrol checkpoint.')
      const id = newId('PS')
      await t.query('insert into patrol_scan (id, checkpoint_id, by_user, at, note, photo_id) values ($1,$2,$3,$4,$5,$6)', [id, c.id, who.userId, now(), b.note?.trim() || null, b.photoId ?? null])
      const [onDuty] = await t.query('select 1 from attendance where user_id = $1 and clock_out_at is null', [who.userId])
      if (onDuty) {
        const pos = await positionOf(t, { x: c.x, z: c.z, space_id: c.space_id })
        await t.query(`insert into location_ping (user_id, at, source, x, z, inside, place) values ($1,$2,'qr',$3,$4,true,$5)`, [who.userId, now(), pos?.x ?? null, pos?.z ?? null, c.name])
      }
      await appendAudit(t, { actor: who, action: 'security.patrol_scan', entity: { type: 'checkpoint', id: c.id }, after: { checkpoint: c.name } }, now())
      return reply.status(201).send({ id, checkpoint: c.name })
    })
  })

  app.get('/api/security/patrols', async (req) => {
    await need(req, 'security.gate', 'security.view')
    const hours = Math.min(168, Number((req.query as { hours?: string }).hours ?? 24))
    return db.query(`select p.id, p.at, c.name as checkpoint, u.name as by, p.note, p.photo_id from patrol_scan p join checkpoint c on c.id = p.checkpoint_id join app_user u on u.id = p.by_user
                      where p.at >= $1 order by p.at desc limit 500`, [new Date(now().getTime() - hours * 3_600_000)])
  })

  // ---------- incidents ----------
  app.post('/api/security/incidents', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    const b = (req.body ?? {}) as { kind?: string; severity?: string; title?: string; detail?: string; spaceId?: string; x?: number; z?: number; lat?: number; lng?: number; photoIds?: string[]; policeInformed?: boolean }
    if (!INCIDENT_KINDS.includes(b.kind ?? '')) throw new HttpError(400, `Kind: ${INCIDENT_KINDS.join(', ')}.`)
    if (!SEVERITIES.includes(b.severity ?? '')) throw new HttpError(400, `Severity: ${SEVERITIES.join(', ')}.`)
    if (!b.title?.trim() || b.title.length > 120) throw new HttpError(400, 'Say what happened in a line.')
    const id = newId('IN')
    return db.tx(async (t) => {
      const pos = await place(t, b)
      await t.query(`insert into incident (id, kind, severity, title, detail, space_id, x, z, photos, police_informed, reported_by, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, b.kind, b.severity, b.title!.trim(), b.detail?.trim() || null, b.spaceId || null, pos?.x ?? null, pos?.z ?? null, (b.photoIds ?? []).slice(0, 6), !!b.policeInformed, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'security.incident', entity: { type: 'incident', id }, after: { kind: b.kind, severity: b.severity, title: b.title!.trim() } }, now())
      return reply.status(201).send({ id })
    })
  })

  app.get('/api/security/incidents', async (req) => {
    const who = await requireCaller(ctx, req)
    const status = (req.query as { status?: string }).status ?? 'open'
    const all = can(who, 'security.view') || can(who, 'security.gate')
    return db.query(
      `select i.*, s.name as space, r.name as reported_by_name, c.name as closed_by_name from incident i left join space s on s.id = i.space_id
         join app_user r on r.id = i.reported_by left join app_user c on c.id = i.closed_by
        where ($1 = 'all' or i.status = $1) and ($2 or i.reported_by = $3)
        order by case i.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, i.at desc limit 300`, [status, all, who.userId])
  })

  app.post('/api/security/incidents/:id/close', async (req) => {
    const who = await need(req, 'security.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { actionTaken?: string; policeInformed?: boolean }
    const action = b.actionTaken?.trim()
    if (!action) throw new HttpError(400, 'Say what was done.')
    return db.tx(async (t) => {
      const [i] = await t.query<{ status: string }>('select status from incident where id = $1 for update', [id])
      if (!i) throw new HttpError(404, 'No such incident.')
      if (i.status === 'closed') throw new HttpError(409, 'Already closed.')
      await t.query(`update incident set status = 'closed', action_taken = $2, police_informed = coalesce($3, police_informed), closed_by = $4, closed_at = $5 where id = $1`,
        [id, action, b.policeInformed ?? null, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'security.incident_close', entity: { type: 'incident', id }, note: action }, now())
      return { ok: true }
    })
  })

  // ---------- CCTV ----------
  function checkUrl(u: unknown) {
    if (u == null || u === '') return
    let url: URL
    try { url = new URL(String(u)) } catch { throw new HttpError(400, 'Live view: a full http(s) address.') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'Live view: an http(s) address (the NVR web page or its HLS stream).')
    if (url.username || url.password) throw new HttpError(400, 'Do not put the NVR password in the address: sign in on the NVR page instead.')
  }

  app.get('/api/security/cameras', async (req) => {
    await need(req, 'security.view', 'security.gate')
    return db.query('select c.*, s.name as space from camera c left join space s on s.id = c.space_id order by c.active desc, c.name')
  })

  app.post('/api/security/cameras', async (req, reply) => {
    const who = await need(req, 'security.manage')
    const b = (req.body ?? {}) as { name?: string; spaceId?: string; x?: number; z?: number; lat?: number; lng?: number; viewUrl?: string; channel?: string }
    if (!b.name?.trim()) throw new HttpError(400, 'Name the camera (e.g. "Main gate", "Lobby").')
    checkUrl(b.viewUrl)
    const id = newId('CAM')
    await db.tx(async (t) => {
      const pos = await place(t, b)
      await t.query('insert into camera (id, name, space_id, x, z, view_url, channel) values ($1,$2,$3,$4,$5,$6,$7)', [id, b.name!.trim(), b.spaceId || null, pos?.x ?? null, pos?.z ?? null, b.viewUrl?.trim() || null, b.channel?.trim() || null])
      await appendAudit(t, { actor: who, action: 'security.camera_add', entity: { type: 'camera', id }, after: { name: b.name, channel: b.channel ?? null } }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/security/cameras/:id', async (req) => {
    const who = await need(req, 'security.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; viewUrl?: string | null; channel?: string; active?: boolean; spaceId?: string | null; x?: number; z?: number; lat?: number; lng?: number }
    checkUrl(b.viewUrl)
    return db.tx(async (t) => {
      const [before] = await t.query('select * from camera where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such camera.')
      const pos = await place(t, { ...b, spaceId: b.spaceId ?? undefined })
      await t.query(`update camera set name = coalesce($2, name), view_url = case when $3::boolean then $4 else view_url end, channel = coalesce($5, channel), active = coalesce($6, active),
                       space_id = case when $7::boolean then $8 else space_id end, x = coalesce($9, x), z = coalesce($10, z) where id = $1`,
        [id, b.name?.trim() || null, b.viewUrl !== undefined, b.viewUrl?.trim() || null, b.channel?.trim() ?? null, b.active ?? null, b.spaceId !== undefined, b.spaceId || null, pos?.x ?? null, pos?.z ?? null])
      const [after] = await t.query('select * from camera where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'security.camera_update', entity: { type: 'camera', id }, before, after }, now())
      return after
    })
  })

  // ---------- key register ----------
  app.get('/api/security/keys', async (req) => {
    await need(req, 'security.gate', 'security.view')
    await sweepSecurity(db, now())
    return db.query(
      `select k.id, k.label, k.kind, k.active, l.id as log_id, l.issued_to, l.out_at, l.due_back, l.note, u.name as issued_by,
              (l.due_back is not null and l.due_back < $1) as overdue
         from key_item k left join key_log l on l.key_id = k.id and l.back_at is null left join app_user u on u.id = l.issued_by
        order by k.active desc, (l.id is null), k.label`, [now()])
  })

  app.post('/api/security/keys', async (req, reply) => {
    const who = await need(req, 'security.manage')
    const b = (req.body ?? {}) as { label?: string; kind?: string }
    if (!b.label?.trim()) throw new HttpError(400, 'Label the key (e.g. "Master key A", "DG room").')
    if (b.kind && !['master', 'room', 'store', 'plant', 'vehicle', 'other'].includes(b.kind)) throw new HttpError(400, 'Kind: master, room, store, plant, vehicle or other.')
    const id = newId('KEY')
    await db.tx(async (t) => {
      await t.query('insert into key_item (id, label, kind) values ($1,$2,$3)', [id, b.label!.trim(), b.kind ?? 'other'])
      await appendAudit(t, { actor: who, action: 'security.key_add', entity: { type: 'key', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.post('/api/security/keys/:id/:action', async (req) => {
    const who = await need(req, 'security.gate')
    const { id, action } = req.params as { id: string; action: string }
    const b = (req.body ?? {}) as { issuedTo?: string; userId?: string; hours?: number; note?: string }
    return db.tx(async (t) => {
      const [k] = await t.query<{ label: string; active: boolean }>('select label, active from key_item where id = $1', [id])
      if (!k) throw new HttpError(404, 'No such key.')
      const [open] = await t.query<{ id: string; issued_to: string }>('select id, issued_to from key_log where key_id = $1 and back_at is null for update', [id])
      if (action === 'issue') {
        if (!k.active) throw new HttpError(409, 'This key is retired.')
        if (open) throw new HttpError(409, `${k.label} is out with ${open.issued_to}.`)
        let to = b.issuedTo?.trim()
        if (b.userId) { const [u] = await t.query<{ name: string }>('select name from app_user where id = $1', [b.userId]); if (!u) throw new HttpError(404, 'No such person.'); to = u.name }
        if (!to) throw new HttpError(400, 'Who is taking it?')
        const due = b.hours ? new Date(now().getTime() + Number(b.hours) * 3_600_000) : null
        await t.query('insert into key_log (id, key_id, issued_to, user_id, issued_by, out_at, due_back, note) values ($1,$2,$3,$4,$5,$6,$7,$8)', [newId('KL'), id, to, b.userId ?? null, who.userId, now(), due, b.note?.trim() || null])
        await appendAudit(t, { actor: who, action: 'security.key_out', entity: { type: 'key', id }, after: { key: k.label, to, dueBack: due } }, now())
      } else if (action === 'return') {
        if (!open) throw new HttpError(409, `${k.label} is not out.`)
        await t.query('update key_log set back_at = $2, back_by = $3 where id = $1', [open.id, now(), who.userId])
        await appendAudit(t, { actor: who, action: 'security.key_back', entity: { type: 'key', id }, after: { key: k.label, from: open.issued_to } }, now())
      } else throw new HttpError(404, 'Use issue or return.')
      return { ok: true }
    })
  })

  // Staff names for issuing keys and marking the roll-call.
  app.get('/api/security/people', async (req) => {
    await need(req, 'security.gate', 'security.manage')
    return db.query('select id, name from app_user where active order by name')
  })

  app.get('/api/security/keys/log', async (req) => {
    await need(req, 'security.gate', 'security.view')
    return db.query(`select l.*, k.label, i.name as issued_by_name, r.name as back_by_name from key_log l join key_item k on k.id = l.key_id join app_user i on i.id = l.issued_by
                      left join app_user r on r.id = l.back_by order by l.out_at desc limit 200`)
  })

  // ---------- assembly points ----------
  app.get('/api/security/assembly-points', async (req) => {
    await requireCaller(ctx, req)
    return db.query('select id, name, x, z, active from assembly_point order by active desc, name')
  })

  app.post('/api/security/assembly-points', async (req, reply) => {
    const who = await need(req, 'security.manage')
    const b = (req.body ?? {}) as { name?: string; x?: number; z?: number; lat?: number; lng?: number; spaceId?: string }
    if (!b.name?.trim()) throw new HttpError(400, 'Name the assembly point (e.g. "Grand Lawn, near the gate").')
    const id = newId('AP')
    await db.tx(async (t) => {
      const pos = (await place(t, b)) ?? (b.spaceId ? await positionOf(t, { x: null, z: null, space_id: b.spaceId }) : null)
      if (!pos) throw new HttpError(400, 'Choose where it is: a place on the resort, or stand there and use your location.')
      await t.query('insert into assembly_point (id, name, x, z) values ($1,$2,$3,$4)', [id, b.name!.trim(), pos.x, pos.z])
      await appendAudit(t, { actor: who, action: 'security.assembly_add', entity: { type: 'assembly_point', id }, after: { name: b.name, ...pos } }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/security/assembly-points/:id', async (req) => {
    const who = await need(req, 'security.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; active?: boolean }
    await db.tx(async (t) => {
      const [before] = await t.query('select * from assembly_point where id = $1', [id])
      if (!before) throw new HttpError(404, 'No such assembly point.')
      await t.query('update assembly_point set name = coalesce($2, name), active = coalesce($3, active) where id = $1', [id, b.name?.trim() || null, b.active ?? null])
      await appendAudit(t, { actor: who, action: 'security.assembly_update', entity: { type: 'assembly_point', id }, before, after: b }, now())
    })
    return { ok: true }
  })

  // ---------- emergency and roll-call ----------
  async function active(t: Db) {
    const [e] = await t.query<{ id: string; kind: string; note: string | null; started_at: string; started_by: string }>(
      `select e.id, e.kind, e.note, e.started_at, u.name as started_by from emergency e join app_user u on u.id = e.started_by where e.ended_at is null`)
    return e ?? null
  }

  app.post('/api/security/emergency', async (req, reply) => {
    const who = await need(req, 'emergency.start')
    const b = (req.body ?? {}) as { kind?: string; note?: string }
    if (!['fire', 'evacuation', 'lockdown', 'medical', 'other'].includes(b.kind ?? '')) throw new HttpError(400, 'Kind: fire, evacuation, lockdown, medical or other.')
    return db.tx(async (t) => {
      if (await active(t)) throw new HttpError(409, 'An emergency is already running.')
      const id = newId('EM')
      await t.query('insert into emergency (id, kind, note, started_by, started_at) values ($1,$2,$3,$4,$5)', [id, b.kind, b.note?.trim() || null, who.userId, now()])
      // Everyone clocked in must be accounted for.
      await t.query(`insert into emergency_check (emergency_id, user_id, on_duty) select $1, user_id, true from attendance where clock_out_at is null on conflict do nothing`, [id])
      await appendAudit(t, { actor: who, action: 'security.emergency_start', entity: { type: 'emergency', id }, after: { kind: b.kind, note: b.note ?? null } }, now())
      return reply.status(201).send({ id })
    })
  })

  app.get('/api/security/emergency', async (req) => {
    const who = await requireCaller(ctx, req)
    const e = await active(db)
    const points = await db.query('select id, name, x, z from assembly_point where active order by name')
    if (!e) return { active: null, points }
    const [mine] = await db.query('select status, at, point_id from emergency_check where emergency_id = $1 and user_id = $2', [e.id, who.userId])
    const base = { active: e, points, mine: mine ?? null }
    if (!(can(who, 'staff.track') || can(who, 'security.view') || can(who, 'emergency.start'))) return base
    const people = await db.query<{ status: string | null }>(
      `select c.user_id, u.name, c.on_duty, c.status, c.at, p.name as point, m.name as marked_by,
              (select string_agg(distinct ur.role_id, ', ') from user_role ur where ur.user_id = c.user_id) as roles,
              (select l.place from location_ping l where l.user_id = c.user_id order by l.at desc limit 1) as last_place
         from emergency_check c join app_user u on u.id = c.user_id left join assembly_point p on p.id = c.point_id left join app_user m on m.id = c.marked_by
        where c.emergency_id = $1 order by case when c.status = 'need_help' then 0 when c.status is null then 1 else 2 end, u.name`, [e.id])
    const count = (s: string | null) => people.filter((p) => p.status === s).length
    return { ...base, people, counts: { total: people.length, safe: count('safe'), needHelp: count('need_help'), missing: count(null) } }
  })

  // Each person answers for themselves; a warden or guard can mark someone they can see.
  app.post('/api/security/emergency/check', async (req) => {
    const who = await requireCaller(ctx, req)
    const b = (req.body ?? {}) as { status?: string; pointId?: string; userId?: string; lat?: number; lng?: number }
    if (!['safe', 'need_help'].includes(b.status ?? '')) throw new HttpError(400, 'Status: safe or need_help.')
    const target = b.userId && b.userId !== who.userId ? b.userId : who.userId
    if (target !== who.userId && !(can(who, 'security.gate') || can(who, 'staff.track') || can(who, 'emergency.start'))) throw new HttpError(403, 'Only wardens and security mark others.')
    return db.tx(async (t) => {
      const e = await active(t)
      if (!e) throw new HttpError(409, 'There is no emergency running.')
      const pos = await place(t, b)
      await t.query(`insert into emergency_check (emergency_id, user_id, on_duty, status, at, point_id, x, z, marked_by) values ($1,$2,false,$3,$4,$5,$6,$7,$8)
                     on conflict (emergency_id, user_id) do update set status = excluded.status, at = excluded.at, point_id = coalesce(excluded.point_id, emergency_check.point_id),
                       x = coalesce(excluded.x, emergency_check.x), z = coalesce(excluded.z, emergency_check.z), marked_by = excluded.marked_by`,
        [e.id, target, b.status, now(), b.pointId || null, pos?.x ?? null, pos?.z ?? null, target === who.userId ? null : who.userId])
      await appendAudit(t, { actor: who, action: b.status === 'need_help' ? 'security.emergency_help' : 'security.emergency_safe', entity: { type: 'emergency', id: e.id }, after: { user: target } }, now())
      return { ok: true }
    })
  })

  app.post('/api/security/emergency/end', async (req) => {
    const who = await need(req, 'emergency.start')
    const b = (req.body ?? {}) as { summary?: string }
    const summary = b.summary?.trim()
    if (!summary) throw new HttpError(400, 'Write what happened and that everyone is accounted for.')
    return db.tx(async (t) => {
      const e = await active(t)
      if (!e) throw new HttpError(409, 'There is no emergency running.')
      const [{ missing }] = await t.query<{ missing: number }>(`select count(*)::int as missing from emergency_check where emergency_id = $1 and status is null`, [e.id])
      await t.query('update emergency set ended_by = $2, ended_at = $3, summary = $4 where id = $1', [e.id, who.userId, now(), summary])
      await appendAudit(t, { actor: who, action: 'security.emergency_end', entity: { type: 'emergency', id: e.id }, after: { unaccounted: missing }, note: summary }, now())
      return { ok: true, unaccounted: missing }
    })
  })

  app.get('/api/security/emergency/history', async (req) => {
    await need(req, 'security.view', 'emergency.start')
    return db.query(`select e.*, s.name as started_by_name, x.name as ended_by_name,
                            (select count(*)::int from emergency_check c where c.emergency_id = e.id) as people,
                            (select count(*)::int from emergency_check c where c.emergency_id = e.id and c.status = 'safe') as safe
                       from emergency e join app_user s on s.id = e.started_by left join app_user x on x.id = e.ended_by order by e.started_at desc limit 50`)
  })

  // ---------- the security layer of the 3D map ----------
  app.get('/api/security/map', async (req) => {
    await need(req, 'security.view', 'security.gate')
    await sweepSecurity(db, now())
    const overdue = await overdueCheckpoints(db, now())
    const pos = (r: { x: string | null; z: string | null; space_id?: string | null }) => positionOf(db, { x: r.x, z: r.z, space_id: r.space_id ?? null })
    const cams = await db.query<{ id: string; name: string; x: string | null; z: string | null; space_id: string | null; view_url: string | null }>('select id, name, x, z, space_id, view_url from camera where active')
    const cps = await db.query<{ id: string; name: string; x: string | null; z: string | null; space_id: string | null }>('select id, name, x, z, space_id from checkpoint where active')
    const inc = await db.query<{ id: string; title: string; severity: string; x: string | null; z: string | null; space_id: string | null; at: string }>(`select id, title, severity, x, z, space_id, at from incident where status = 'open'`)
    const cars = await db.query<{ id: string; vehicle_no: string | null; kind: string; tag_no: string | null; x: string | null; z: string | null }>(`select id, vehicle_no, kind, tag_no, x, z from gate_entry where out_at is null and vehicle_no is not null`)
    const aps = await db.query<{ id: string; name: string; x: string | null; z: string | null }>('select id, name, x, z from assembly_point where active')
    return {
      cameras: await Promise.all(cams.map(async (c) => ({ id: c.id, name: c.name, hasView: !!c.view_url, pos: await pos(c) }))),
      checkpoints: await Promise.all(cps.map(async (c) => ({ id: c.id, name: c.name, overdue: overdue.has(c.id), pos: await pos(c) }))),
      incidents: await Promise.all(inc.map(async (i) => ({ id: i.id, title: i.title, severity: i.severity, at: i.at, pos: await pos(i) }))),
      vehicles: cars.filter((v) => v.x != null).map((v) => ({ id: v.id, label: v.vehicle_no, kind: v.kind, tag: v.tag_no, pos: { x: Number(v.x), z: Number(v.z) } })),
      vehiclesInside: cars.length,
      assemblyPoints: aps.filter((a) => a.x != null).map((a) => ({ id: a.id, name: a.name, pos: { x: Number(a.x), z: Number(a.z) } })),
    }
  })
}
