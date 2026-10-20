import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { distanceM, geoSettings, spacePosition, toMap } from '../geo'
import { requireCaller } from './auth'

// The staff app: shifts and rosters, attendance inside the resort boundary (optional selfie), location
// while on duty only (GPS outdoors, Bluetooth beacons indoors), SOS, broadcasts and a task inbox.
// Privacy: no location is accepted from anyone who is not clocked in, it is kept for 90 days, and each
// employee accepts the tracking policy before their first clock-in.

const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
export const CONSENT_VERSION = 1
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10)
const istMinutes = (d: Date) => { const s = new Date(d.getTime() + 330 * 60_000).toISOString(); return Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16)) }
const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))

interface Fix { lat?: number; lng?: number; accuracy?: number }
const validFix = (f: Fix) => typeof f.lat === 'number' && typeof f.lng === 'number' && Math.abs(f.lat) <= 90 && Math.abs(f.lng) <= 180

async function openShift(t: Db, userId: string) {
  const [a] = await t.query<{ id: string; day: string; outside_since: string | null; outside_alerted: boolean }>(
    'select id, day::text, outside_since, outside_alerted from attendance where user_id = $1 and clock_out_at is null', [userId])
  return a ?? null
}

export function staffRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()
  const historyDays = Number((ctx.roles as unknown as { staff_location?: { history_days?: number } }).staff_location?.history_days ?? 90)
  const outsideAlertMin = Number(ctx.roles.god_mode_alerts?.find((a) => a.id === 'staff_outside_zone_minutes')?.value ?? 15)

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }

  // ---------- settings ----------
  app.get('/api/staff/settings', async (req) => {
    await requireCaller(ctx, req)
    return geoSettings(db)
  })

  app.put('/api/staff/settings', async (req) => {
    const who = await need(req, 'staff.settings')
    const b = req.body as { lat?: number; lng?: number; radiusM?: number; mapX?: number; mapZ?: number; rotation?: number; selfieRequired?: boolean }
    if ((b.lat !== undefined || b.lng !== undefined) && !validFix(b)) throw new HttpError(400, 'Send both lat and lng (degrees).')
    if (b.radiusM !== undefined && !(Number.isInteger(b.radiusM) && b.radiusM >= 50 && b.radiusM <= 5000)) throw new HttpError(400, 'Boundary radius: 50–5000 m.')
    return db.tx(async (t) => {
      const before = await geoSettings(t)
      await t.query(
        `update property set geo_lat = coalesce($1, geo_lat), geo_lng = coalesce($2, geo_lng), geo_radius_m = coalesce($3, geo_radius_m),
           geo_map_x = coalesce($4, geo_map_x), geo_map_z = coalesce($5, geo_map_z), geo_rotation = coalesce($6, geo_rotation), selfie_required = coalesce($7, selfie_required)`,
        [b.lat ?? null, b.lng ?? null, b.radiusM ?? null, b.mapX ?? null, b.mapZ ?? null, b.rotation ?? null, b.selfieRequired ?? null])
      const after = await geoSettings(t)
      await appendAudit(t, { actor: who, action: 'staff.settings', entity: { type: 'property', id: 'sathya' }, before, after }, now())
      return after
    })
  })

  // ---------- shifts and rosters ----------
  app.get('/api/staff/shifts', async (req) => {
    await requireCaller(ctx, req)
    return db.query('select id, name, starts, ends, active from shift order by active desc, starts')
  })

  app.post('/api/staff/shifts', async (req, reply) => {
    const who = await need(req, 'roster.manage')
    const b = req.body as { name?: string; starts?: string; ends?: string }
    if (!b?.name?.trim() || !HHMM.test(b.starts ?? '') || !HHMM.test(b.ends ?? '')) throw new HttpError(400, 'Name, start and end time (HH:MM).')
    const id = newId('SF')
    await db.tx(async (t) => {
      await t.query('insert into shift (id, name, starts, ends) values ($1,$2,$3,$4)', [id, b.name!.trim(), b.starts, b.ends])
      await appendAudit(t, { actor: who, action: 'shift.add', entity: { type: 'shift', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/staff/shifts/:id', async (req) => {
    const who = await need(req, 'roster.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; starts?: string; ends?: string; active?: boolean }
    if ((b.starts && !HHMM.test(b.starts)) || (b.ends && !HHMM.test(b.ends))) throw new HttpError(400, 'Times as HH:MM.')
    return db.tx(async (t) => {
      const [before] = await t.query('select * from shift where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such shift.')
      await t.query('update shift set name = coalesce($2, name), starts = coalesce($3, starts), ends = coalesce($4, ends), active = coalesce($5, active) where id = $1', [id, b.name?.trim() ?? null, b.starts ?? null, b.ends ?? null, b.active ?? null])
      const [after] = await t.query('select * from shift where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'shift.update', entity: { type: 'shift', id }, before, after }, now())
      return after
    })
  })

  app.get('/api/staff/roster', async (req) => {
    const who = await requireCaller(ctx, req)
    const q = req.query as { from?: string; to?: string }
    const from = q.from ?? istDay(now()), to = q.to ?? from
    if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, 'from and to as YYYY-MM-DD.')
    const all = can(who, 'roster.manage') || can(who, 'attendance.view')
    return db.query(
      `select r.user_id, u.name, r.day::text, r.shift_id, s.name as shift, s.starts, s.ends from roster r join app_user u on u.id = r.user_id left join shift s on s.id = r.shift_id
        where r.day between $1 and $2 and ($3 or r.user_id = $4) order by r.day, u.name`, [from, to, all, who.userId])
  })

  app.put('/api/staff/roster', async (req) => {
    const who = await need(req, 'roster.manage')
    const b = req.body as { entries?: { userId: string; day: string; shiftId: string | null }[] }
    if (!Array.isArray(b?.entries) || !b.entries.length || b.entries.length > 1000) throw new HttpError(400, 'Send entries: user, day and shift (null for a weekly off).')
    return db.tx(async (t) => {
      for (const e of b.entries!) {
        if (!DATE.test(e.day)) throw new HttpError(400, 'Days as YYYY-MM-DD.')
        await t.query('insert into roster (user_id, day, shift_id) values ($1,$2,$3) on conflict (user_id, day) do update set shift_id = excluded.shift_id', [e.userId, e.day, e.shiftId])
      }
      await appendAudit(t, { actor: who, action: 'roster.update', entity: { type: 'roster', id: b.entries![0].day }, after: { entries: b.entries!.length } }, now())
      return { ok: true }
    })
  })

  // Active staff with their roles, for rosters and attendance.
  app.get('/api/staff/people', async (req) => {
    await need(req, 'roster.manage', 'attendance.view', 'broadcast.send')
    return db.query(`select u.id, u.name, array_agg(ur.role_id order by ur.role_id) as roles from app_user u join user_role ur on ur.user_id = u.id
                      where u.active group by u.id order by u.name`)
  })

  // ---------- consent ----------
  app.post('/api/staff/consent', async (req) => {
    const who = await requireCaller(ctx, req)
    if ((req.body as { accept?: boolean })?.accept !== true) throw new HttpError(400, 'Send accept: true.')
    await db.query(`insert into consent (user_id, kind, version, accepted_at) values ($1, 'location', $2, $3) on conflict (user_id, kind) do update set version = excluded.version, accepted_at = excluded.accepted_at`,
      [who.userId, CONSENT_VERSION, now()])
    await appendAudit(db, { actor: who, action: 'staff.consent', entity: { type: 'user', id: who.userId }, after: { kind: 'location', version: CONSENT_VERSION } }, now())
    return { ok: true }
  })

  // ---------- me ----------
  app.get('/api/staff/me', async (req) => {
    const who = await requireCaller(ctx, req)
    const day = istDay(now())
    const [c] = await db.query<{ version: number }>(`select version from consent where user_id = $1 and kind = 'location'`, [who.userId])
    const open = await openShift(db, who.userId)
    const [a] = open ? await db.query('select id, day::text, clock_in_at, late_minutes, shift_id from attendance where id = $1', [open.id]) : []
    const [shift] = await db.query(`select s.id, s.name, s.starts, s.ends from roster r join shift s on s.id = r.shift_id where r.user_id = $1 and r.day = $2`, [who.userId, day])
    const [{ unread }] = await db.query<{ unread: number }>(
      `select count(*)::int as unread from broadcast b where b.at > $2 and (b.roles is null or b.roles && $3::text[])
          and not exists (select 1 from broadcast_read r where r.broadcast_id = b.id and r.user_id = $1)`, [who.userId, new Date(now().getTime() - 7 * 86_400_000), who.roles])
    return { name: who.name, roles: who.roles, consent: (c?.version ?? 0) >= CONSENT_VERSION, onDuty: !!a, attendance: a ?? null, shift: shift ?? null, unread, settings: await geoSettings(db) }
  })

  // ---------- attendance ----------
  app.post('/api/staff/clock-in', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    const b = (req.body ?? {}) as Fix & { selfieId?: string }
    return db.tx(async (t) => {
      const [c] = await t.query(`select 1 from consent where user_id = $1 and kind = 'location' and version >= $2`, [who.userId, CONSENT_VERSION])
      if (!c) throw new HttpError(409, 'Read and accept the location policy first.', { stage: 'consent' })
      if (await openShift(t, who.userId)) throw new HttpError(409, 'You are already clocked in.')
      const g = await geoSettings(t)
      if (g.lat != null) {
        if (!validFix(b)) throw new HttpError(400, 'Turn on location so the app can confirm you are at the resort.')
        const d = distanceM(b.lat!, b.lng!, g.lat, g.lng!)
        if (d > g.radiusM + Math.min(b.accuracy ?? 0, 100)) throw new HttpError(403, `You are about ${Math.round(d - g.radiusM)} m outside the resort. Clock in when you arrive.`, { distanceM: Math.round(d) })
      }
      if (g.selfieRequired && !b.selfieId) throw new HttpError(400, 'Take a selfie to clock in.', { stage: 'selfie' })
      const day = istDay(now())
      const [shift] = await t.query<{ id: string; starts: string }>(`select s.id, s.starts from roster r join shift s on s.id = r.shift_id where r.user_id = $1 and r.day = $2`, [who.userId, day])
      const late = shift ? Math.max(0, istMinutes(now()) - hm(shift.starts) - 5) : 0       // 5 minutes' grace
      const id = newId('AT')
      await t.query(`insert into attendance (id, user_id, day, shift_id, clock_in_at, in_lat, in_lng, in_accuracy_m, selfie_id, late_minutes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, who.userId, day, shift?.id ?? null, now(), b.lat ?? null, b.lng ?? null, b.accuracy == null ? null : Math.round(b.accuracy), b.selfieId ?? null, late])
      if (validFix(b)) {
        const m = toMap(g, b.lat!, b.lng!)
        await t.query(`insert into location_ping (user_id, at, source, lat, lng, accuracy, x, z, inside) values ($1,$2,'gps',$3,$4,$5,$6,$7,true)`, [who.userId, now(), b.lat, b.lng, b.accuracy ?? null, m?.x ?? null, m?.z ?? null])
      }
      await appendAudit(t, { actor: who, action: late ? 'staff.clock_in_late' : 'staff.clock_in', entity: { type: 'attendance', id }, after: { lateMinutes: late, shift: shift?.id ?? null } }, now())
      return reply.status(201).send({ id, lateMinutes: late })
    })
  })

  app.post('/api/staff/clock-out', async (req) => {
    const who = await requireCaller(ctx, req)
    const b = (req.body ?? {}) as Fix
    return db.tx(async (t) => {
      const a = await openShift(t, who.userId)
      if (!a) throw new HttpError(409, 'You are not clocked in.')
      await t.query('update attendance set clock_out_at = $2, out_lat = $3, out_lng = $4 where id = $1', [a.id, now(), b.lat ?? null, b.lng ?? null])
      const [r] = await t.query<{ minutes: number }>('select (extract(epoch from (clock_out_at - clock_in_at)) / 60)::int as minutes from attendance where id = $1', [a.id])
      await appendAudit(t, { actor: who, action: 'staff.clock_out', entity: { type: 'attendance', id: a.id }, after: { minutes: r.minutes } }, now())
      return { ok: true, minutes: r.minutes }
    })
  })

  app.get('/api/staff/attendance', async (req) => {
    const who = await requireCaller(ctx, req)
    const q = req.query as { day?: string; userId?: string }
    const all = can(who, 'attendance.view')
    const day = q.day ?? istDay(now())
    if (!DATE.test(day)) throw new HttpError(400, 'day as YYYY-MM-DD.')
    return db.query(
      `select a.id, a.user_id, u.name, a.day::text, s.name as shift, s.starts, a.clock_in_at, a.clock_out_at, a.late_minutes, a.selfie_id,
              (extract(epoch from (coalesce(a.clock_out_at, $3) - a.clock_in_at)) / 60)::int as minutes,
              (select string_agg(distinct ur.role_id, ', ') from user_role ur where ur.user_id = a.user_id) as roles
         from attendance a join app_user u on u.id = a.user_id left join shift s on s.id = a.shift_id
        where ($1::date is null or a.day = $1) and ($2::text is null or a.user_id = $2) order by a.clock_in_at`,
      [q.userId && !all ? null : day, all ? q.userId ?? null : who.userId, now()])
  })

  // Who is rostered today but has not clocked in (no-shows and late arrivals).
  app.get('/api/staff/absent', async (req) => {
    await need(req, 'attendance.view')
    const day = (req.query as { day?: string }).day ?? istDay(now())
    return db.query(
      `select r.user_id, u.name, s.name as shift, s.starts from roster r join app_user u on u.id = r.user_id join shift s on s.id = r.shift_id
        where r.day = $1 and u.active and not exists (select 1 from attendance a where a.user_id = r.user_id and a.day = $1) order by s.starts, u.name`, [day])
  })

  // ---------- location ----------
  app.post('/api/staff/location', async (req) => {
    const who = await requireCaller(ctx, req)
    const b = (req.body ?? {}) as Fix & { beaconId?: string; spaceId?: string }
    return db.tx(async (t) => {
      const a = await openShift(t, who.userId)
      if (!a) throw new HttpError(409, 'Off duty: location is not recorded.', { offDuty: true })
      const g = await geoSettings(t)
      let source: 'gps' | 'beacon' | 'qr' = 'gps', pos: { x: number; z: number } | null = null, place: string | null = null, inside: boolean | null = null
      if (b.beaconId) {
        const [bc] = await t.query<{ name: string; space_id: string | null; x: string | null; z: string | null }>('select name, space_id, x, z from beacon where id = $1', [b.beaconId])
        if (!bc) throw new HttpError(404, 'Unknown beacon.')
        source = 'beacon'; place = bc.name; inside = true
        pos = bc.x != null ? { x: Number(bc.x), z: Number(bc.z) } : bc.space_id ? await spacePosition(t, bc.space_id) : null
      } else if (b.spaceId) {
        source = 'qr'; inside = true
        const [s] = await t.query<{ name: string }>('select name from space where id = $1', [b.spaceId]); place = s?.name ?? null
        pos = await spacePosition(t, b.spaceId)
      } else {
        if (!validFix(b)) throw new HttpError(400, 'Send lat and lng.')
        pos = toMap(g, b.lat!, b.lng!)
        if (g.lat != null) inside = distanceM(b.lat!, b.lng!, g.lat, g.lng!) <= g.radiusM + Math.min(b.accuracy ?? 0, 100)
      }
      await t.query('insert into location_ping (user_id, at, source, lat, lng, accuracy, x, z, inside, place) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [who.userId, now(), source, b.lat ?? null, b.lng ?? null, b.accuracy == null ? null : Math.round(b.accuracy), pos?.x ?? null, pos?.z ?? null, inside, place])
      // Away from the resort while on duty for longer than allowed: tell the operations manager once.
      let alert = false
      if (inside === false) {
        const since = a.outside_since ? new Date(a.outside_since) : now()
        if (!a.outside_since) await t.query('update attendance set outside_since = $2 where id = $1', [a.id, now()])
        if (!a.outside_alerted && now().getTime() - since.getTime() >= outsideAlertMin * 60_000) {
          await t.query('update attendance set outside_alerted = true where id = $1', [a.id])
          await appendAudit(t, { actor: who, action: 'staff.outside_zone', entity: { type: 'attendance', id: a.id }, after: { minutes: Math.round((now().getTime() - since.getTime()) / 60_000) } }, now())
          alert = true
        }
      } else if (inside === true && a.outside_since) await t.query('update attendance set outside_since = null, outside_alerted = false where id = $1', [a.id])
      if (Math.random() < 0.02) await t.query('delete from location_ping where at < $1', [new Date(now().getTime() - historyDays * 86_400_000)])
      return { ok: true, x: pos?.x ?? null, z: pos?.z ?? null, inside, alert }
    })
  })

  // Everyone on duty and where they were last seen (managers and security).
  app.get('/api/staff/live', async (req) => {
    await need(req, 'staff.track')
    const rows = await db.query(
      `select a.user_id, u.name, (select string_agg(distinct ur.role_id, ', ') from user_role ur where ur.user_id = a.user_id) as roles, a.clock_in_at,
              p.at, p.source, p.x, p.z, p.inside, p.place,
              exists (select 1 from sos s where s.user_id = a.user_id and s.status <> 'resolved') as sos
         from attendance a join app_user u on u.id = a.user_id
         left join lateral (select at, source, x, z, inside, place from location_ping l where l.user_id = a.user_id order by at desc limit 1) p on true
        where a.clock_out_at is null order by u.name`)
    return rows
  })

  app.get('/api/staff/my-locations', async (req) => {
    const who = await requireCaller(ctx, req)
    const day = (req.query as { day?: string }).day ?? istDay(now())
    return db.query(`select at, source, x, z, inside, place from location_ping where user_id = $1 and (at + interval '330 minutes')::date = $2 order by at`, [who.userId, day])
  })

  // ---------- beacons ----------
  app.get('/api/staff/beacons', async (req) => {
    await requireCaller(ctx, req)
    return db.query('select b.id, b.name, b.space_id, s.name as space, b.floor, b.x, b.z from beacon b left join space s on s.id = b.space_id order by b.name')
  })

  app.post('/api/staff/beacons', async (req, reply) => {
    const who = await need(req, 'staff.settings')
    const b = req.body as { id?: string; name?: string; spaceId?: string; floor?: number }
    if (!b?.id?.trim() || !b.name?.trim()) throw new HttpError(400, 'Beacon id (as the phone reads it) and a name are required.')
    await db.tx(async (t) => {
      try {
        await t.query('insert into beacon (id, name, space_id, floor) values ($1,$2,$3,$4)', [b.id!.trim(), b.name!.trim(), b.spaceId ?? null, b.floor ?? null])
      } catch { throw new HttpError(409, 'That beacon is already registered.') }
      await appendAudit(t, { actor: who, action: 'beacon.add', entity: { type: 'beacon', id: b.id! }, after: b }, now())
    })
    return reply.status(201).send({ id: b.id })
  })

  // ---------- SOS ----------
  app.post('/api/staff/sos', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    const b = (req.body ?? {}) as Fix
    return db.tx(async (t) => {
      const g = await geoSettings(t)
      let pos = validFix(b) ? toMap(g, b.lat!, b.lng!) : null
      let place: string | null = null
      if (!pos) {
        const [last] = await t.query<{ x: string | null; z: string | null; place: string | null }>('select x, z, place from location_ping where user_id = $1 order by at desc limit 1', [who.userId])
        if (last?.x != null) pos = { x: Number(last.x), z: Number(last.z) }
        place = last?.place ?? null
      }
      const id = newId('SOS')
      await t.query('insert into sos (id, user_id, at, lat, lng, x, z, place) values ($1,$2,$3,$4,$5,$6,$7,$8)', [id, who.userId, now(), b.lat ?? null, b.lng ?? null, pos?.x ?? null, pos?.z ?? null, place])
      await appendAudit(t, { actor: who, action: 'staff.sos', entity: { type: 'sos', id }, after: { x: pos?.x ?? null, z: pos?.z ?? null, place } }, now())
      return reply.status(201).send({ id, located: !!pos })
    })
  })

  app.get('/api/staff/sos', async (req) => {
    await need(req, 'staff.track')
    const status = (req.query as { status?: string }).status ?? 'open'
    return db.query(
      `select s.id, s.user_id, u.name, s.at, s.x, s.z, s.place, s.status, a.name as ack_by, s.ack_at, s.note
         from sos s join app_user u on u.id = s.user_id left join app_user a on a.id = s.ack_by
        where ($1 = 'all' or ($1 = 'open' and s.status <> 'resolved') or s.status = $1) order by s.at desc limit 100`, [status])
  })

  app.post('/api/staff/sos/:id/:action', async (req) => {
    const who = await need(req, 'staff.track')
    const { id, action } = req.params as { id: string; action: string }
    if (action !== 'ack' && action !== 'resolve') throw new HttpError(404, 'Use ack or resolve.')
    const note = (req.body as { note?: string })?.note?.trim()
    if (action === 'resolve' && !note) throw new HttpError(400, 'Say what happened.')
    return db.tx(async (t) => {
      const [s] = await t.query<{ status: string }>('select status from sos where id = $1 for update', [id])
      if (!s) throw new HttpError(404, 'No such SOS.')
      if (s.status === 'resolved') throw new HttpError(409, 'Already resolved.')
      if (action === 'ack') await t.query(`update sos set status = 'acknowledged', ack_by = $2, ack_at = $3 where id = $1`, [id, who.userId, now()])
      else await t.query(`update sos set status = 'resolved', resolved_by = $2, resolved_at = $3, note = $4, ack_by = coalesce(ack_by, $2), ack_at = coalesce(ack_at, $3) where id = $1`, [id, who.userId, now(), note])
      await appendAudit(t, { actor: who, action: `staff.sos_${action}`, entity: { type: 'sos', id }, note }, now())
      return { ok: true }
    })
  })

  // ---------- broadcasts ----------
  app.post('/api/staff/broadcasts', async (req, reply) => {
    const who = await need(req, 'broadcast.send')
    const b = req.body as { text?: string; roles?: string[] | null; urgent?: boolean }
    if (!b?.text?.trim() || b.text.length > 500) throw new HttpError(400, 'Write the message (up to 500 characters).')
    const id = newId('BC')
    await db.tx(async (t) => {
      await t.query('insert into broadcast (id, from_user, at, text, roles, urgent) values ($1,$2,$3,$4,$5,$6)', [id, who.userId, now(), b.text!.trim(), b.roles?.length ? b.roles : null, !!b.urgent])
      await appendAudit(t, { actor: who, action: b.urgent ? 'staff.broadcast_urgent' : 'staff.broadcast', entity: { type: 'broadcast', id }, after: { roles: b.roles ?? 'everyone' }, note: b.text!.trim().slice(0, 120) }, now())
    })
    return reply.status(201).send({ id })
  })

  app.get('/api/staff/broadcasts', async (req) => {
    const who = await requireCaller(ctx, req)
    return db.query(
      `select b.id, u.name as from_name, b.at, b.text, b.roles, b.urgent, exists (select 1 from broadcast_read r where r.broadcast_id = b.id and r.user_id = $1) as read
         from broadcast b join app_user u on u.id = b.from_user
        where b.at > $2 and (b.roles is null or b.roles && $3::text[] or b.from_user = $1) order by b.at desc limit 50`,
      [who.userId, new Date(now().getTime() - 14 * 86_400_000), who.roles])
  })

  app.post('/api/staff/broadcasts/:id/read', async (req) => {
    const who = await requireCaller(ctx, req)
    await db.query('insert into broadcast_read (broadcast_id, user_id, read_at) values ($1,$2,$3) on conflict do nothing', [(req.params as { id: string }).id, who.userId, now()])
    return { ok: true }
  })

  // ---------- task inbox ----------
  app.get('/api/staff/inbox', async (req) => {
    const who: Caller = await requireCaller(ctx, req)
    const items: { kind: string; title: string; detail: string; at: string | null; ref: string }[] = []
    const hk = await db.query<{ id: string; room_no: string | null; area: string | null; kind: string; status: string; created_at: string }>(
      `select k.id, s.room_no, k.area, k.kind, k.status, k.created_at from hk_task k left join space s on s.id = k.space_id
        where k.assigned_to = $1 and k.status in ('pending', 'in_progress', 'reclean') order by k.priority desc, k.created_at`, [who.userId])
    for (const k of hk) items.push({ kind: 'housekeeping', title: k.room_no ? `Room ${k.room_no}` : k.area ?? '', detail: `${k.kind.replace('_', ' ')} · ${k.status.replace('_', ' ')}`, at: k.created_at, ref: k.id })
    const eng = await db.query<{ id: string; title: string; priority: string; status: string; place: string | null; reported_at: string }>(
      `select k.id, k.title, k.priority, k.status, coalesce(s.name, a.name) as place, k.reported_at from ticket k left join space s on s.id = k.space_id left join asset a on a.id = k.asset_id
        where k.status in ('open', 'in_progress', 'on_hold') and (k.assigned_to = $1 or ($2 and k.assigned_to is null and k.priority in ('urgent', 'high')))
        order by case k.priority when 'urgent' then 0 when 'high' then 1 else 2 end, k.reported_at`, [who.userId, can(who, 'eng.work')])
    for (const k of eng) items.push({ kind: 'engineering', title: k.title, detail: `${k.priority}${k.place ? ` · ${k.place}` : ''} · ${k.status.replace('_', ' ')}`, at: k.reported_at, ref: k.id })
    if (can(who, 'fnb.order')) {
      const ready = await db.query<{ id: string; number: number; kind: string; room_no: string | null; table_label: string | null; ready_at: string }>(
        `select k.id, k.number, k.kind, s.room_no, tb.label as table_label, k.ready_at from kot k join fnb_order o on o.id = k.order_id
           left join dining_table tb on tb.id = o.table_id left join reservation r on r.id = o.reservation_id left join space s on s.id = r.space_id
          where k.status = 'ready' order by k.ready_at`)
      for (const k of ready) items.push({ kind: 'pickup', title: `${k.kind} ${k.number} ready`, detail: k.room_no ? `Room service · room ${k.room_no}` : `Table ${k.table_label ?? ''}`, at: k.ready_at, ref: k.id })
    }
    if (can(who, 'staff.track')) {
      const sos = await db.query<{ id: string; name: string; at: string; place: string | null }>(`select s.id, u.name, s.at, s.place from sos s join app_user u on u.id = s.user_id where s.status = 'open' order by s.at`)
      for (const s of sos) items.unshift({ kind: 'sos', title: `SOS · ${s.name}`, detail: s.place ?? 'See the map', at: s.at, ref: s.id })
    }
    return items
  })
}
