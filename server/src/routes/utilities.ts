import type { FastifyInstance, FastifyRequest } from 'fastify'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, addTicket, daysBetween, istDay, newId, reminderTier, sweepEngineering } from '../eng-core'
import { requireCaller } from './auth'

// Daily utility readings (electricity, DG hours and diesel, solar, water, LPG) with cost per occupied
// room; pool, STP and fire-safety checks that raise a fault when out of range; the compliance calendar.

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Safe ranges for the daily checks. Pool: BIS / WHO guidance for public pools. STP outlet: TNPCB
 * consent limits for treated sewage used on gardens. Confirm against the resort's own consent order.
 */
export const LIMITS = {
  pool: { ph: [7.2, 7.8], chlorine: [1, 3] },
  stp: { ph: [6.5, 9], bod: [0, 30], tss: [0, 100] },
}
const inRange = (v: number, [lo, hi]: number[]) => v >= lo && v <= hi

export function utilityRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }

  // ---------- meters ----------
  app.get('/api/eng/meters', async (req) => {
    await need(req, 'eng.work', 'eng.manage', 'compliance.view')
    return db.query('select id, name, kind, unit, cumulative, rate_paise, active from meter order by active desc, kind, name')
  })

  app.post('/api/eng/meters', async (req, reply) => {
    const who = await need(req, 'eng.manage')
    const b = (req.body ?? {}) as { name?: string; kind?: string; unit?: string; cumulative?: boolean; rate?: number }
    if (!b.name?.trim() || !['electricity', 'dg_hours', 'diesel', 'solar', 'water', 'lpg'].includes(b.kind ?? '') || !b.unit?.trim()) throw new HttpError(400, 'Name, kind and unit.')
    const id = newId('MT')
    await db.tx(async (t) => {
      await t.query('insert into meter (id, name, kind, unit, cumulative, rate_paise) values ($1,$2,$3,$4,$5,$6)', [id, b.name!.trim(), b.kind, b.unit!.trim(), b.cumulative ?? true, Math.round((b.rate ?? 0) * 100)])
      await appendAudit(t, { actor: who, action: 'meter.add', entity: { type: 'meter', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/eng/meters/:id', async (req) => {
    const who = await need(req, 'eng.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; rate?: number; active?: boolean }
    if (b.rate !== undefined && !(b.rate >= 0)) throw new HttpError(400, 'Rate per unit in rupees.')
    return db.tx(async (t) => {
      const [before] = await t.query('select * from meter where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such meter.')
      await t.query('update meter set name = coalesce($2, name), rate_paise = coalesce($3, rate_paise), active = coalesce($4, active) where id = $1',
        [id, b.name?.trim() || null, b.rate === undefined ? null : Math.round(b.rate * 100), b.active ?? null])
      const [after] = await t.query('select * from meter where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'meter.update', entity: { type: 'meter', id }, before, after }, now())
      return after
    })
  })

  // The day's entry sheet: each meter with the last reading before the day and the day's own, if taken.
  app.get('/api/eng/readings', async (req) => {
    await need(req, 'eng.work', 'eng.manage')
    const day = (req.query as { day?: string }).day ?? istDay(now())
    if (!DATE.test(day)) throw new HttpError(400, 'day as YYYY-MM-DD.')
    return db.query(
      `select m.id, m.name, m.kind, m.unit, m.cumulative, r.reading, r.qty, r.reset, r.note, u.name as by,
              (select p.reading from meter_reading p where p.meter_id = m.id and p.day < $1 order by p.day desc limit 1) as previous,
              (select p.day::text from meter_reading p where p.meter_id = m.id and p.day < $1 order by p.day desc limit 1) as previous_day
         from meter m left join meter_reading r on r.meter_id = m.id and r.day = $1 left join app_user u on u.id = r.by_user
        where m.active order by m.kind, m.name`, [day])
  })

  /** A cumulative meter's use for a day is its reading less the one before (a reset starts again from zero). */
  async function recompute(t: Db, meterId: string, day: string) {
    const [m] = await t.query<{ cumulative: boolean }>('select cumulative from meter where id = $1', [meterId])
    const [r] = await t.query<{ reading: string; reset: boolean }>('select reading, reset from meter_reading where meter_id = $1 and day = $2', [meterId, day])
    if (!m || !r) return
    if (!m.cumulative) { await t.query('update meter_reading set qty = reading where meter_id = $1 and day = $2', [meterId, day]); return }
    const [prev] = await t.query<{ reading: string }>('select reading from meter_reading where meter_id = $1 and day < $2 order by day desc limit 1', [meterId, day])
    const qty = r.reset || !prev ? (r.reset ? Number(r.reading) : 0) : Number(r.reading) - Number(prev.reading)
    await t.query('update meter_reading set qty = $3 where meter_id = $1 and day = $2', [meterId, day, qty])
  }

  app.post('/api/eng/readings', async (req, reply) => {
    const who = await need(req, 'eng.work', 'eng.manage')
    const b = (req.body ?? {}) as { day?: string; readings?: { meterId: string; reading: number; reset?: boolean; note?: string }[] }
    const day = b.day ?? istDay(now())
    if (!DATE.test(day) || day > istDay(now())) throw new HttpError(400, 'Readings are for today or an earlier day.')
    if (!Array.isArray(b.readings) || !b.readings.length) throw new HttpError(400, 'Enter at least one reading.')
    return db.tx(async (t) => {
      for (const e of b.readings!) {
        const [m] = await t.query<{ name: string; cumulative: boolean; unit: string }>('select name, cumulative, unit from meter where id = $1 and active', [e.meterId])
        if (!m) throw new HttpError(404, 'No such meter.')
        if (!Number.isFinite(e.reading) || e.reading < 0) throw new HttpError(400, `${m.name}: enter the reading.`)
        if (m.cumulative && !e.reset) {
          const [prev] = await t.query<{ reading: string; day: string }>('select reading, day::text from meter_reading where meter_id = $1 and day < $2 order by day desc limit 1', [e.meterId, day])
          if (prev && e.reading < Number(prev.reading)) throw new HttpError(400, `${m.name}: ${e.reading} is below the ${prev.day} reading of ${Number(prev.reading)} ${m.unit}. If the meter was replaced or rolled over, tick “meter reset”.`)
        }
        const [had] = await t.query('select reading from meter_reading where meter_id = $1 and day = $2', [e.meterId, day])
        await t.query(`insert into meter_reading (meter_id, day, reading, qty, reset, note, by_user, at) values ($1,$2,$3,0,$4,$5,$6,$7)
                       on conflict (meter_id, day) do update set reading = excluded.reading, reset = excluded.reset, note = excluded.note, by_user = excluded.by_user, at = excluded.at`,
          [e.meterId, day, e.reading, !!e.reset, e.note?.trim() || null, who.userId, now()])
        await recompute(t, e.meterId, day)
        // A corrected reading changes the next day's use too.
        const [next] = await t.query<{ day: string }>('select day::text from meter_reading where meter_id = $1 and day > $2 order by day limit 1', [e.meterId, day])
        if (next) await recompute(t, e.meterId, next.day)
        if (had) await appendAudit(t, { actor: who, action: 'meter.correct', entity: { type: 'meter', id: e.meterId }, before: had, after: { day, reading: e.reading } }, now())
      }
      await appendAudit(t, { actor: who, action: 'meter.readings', entity: { type: 'meter_day', id: day }, after: { meters: b.readings!.length } }, now())
      return reply.status(201).send({ ok: true })
    })
  })

  // Use and cost by day, with occupied rooms: cost per occupied room, and diesel per DG running hour.
  app.get('/api/eng/utilities', async (req) => {
    await need(req, 'eng.work', 'eng.manage', 'compliance.view')
    const q = req.query as { from?: string; to?: string }
    const to = q.to ?? istDay(now()), from = q.from ?? addDays(to, -29)
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw new HttpError(400, 'from and to as YYYY-MM-DD.')
    const meters = await db.query<{ id: string; name: string; kind: string; unit: string; rate_paise: string }>('select id, name, kind, unit, rate_paise from meter where active order by kind, name')
    const rows = await db.query<{ meter_id: string; day: string; qty: string }>('select meter_id, day::text, qty from meter_reading where day between $1 and $2', [from, to])
    const occ = await db.query<{ day: string; n: number }>(
      `select rn.night::text as day, count(*)::int as n from room_night rn join reservation r on r.id = rn.reservation_id
        where rn.night between $1 and $2 and not rn.released and r.status in ('in_house', 'checked_out') group by rn.night`, [from, to])
    const occByDay = new Map(occ.map((o) => [o.day, o.n]))
    const rate = new Map(meters.map((m) => [m.id, Number(m.rate_paise)]))
    const days = new Map<string, { day: string; occupied: number; qty: Record<string, number>; costPaise: number }>()
    if (daysBetween(from, to) > 366) throw new HttpError(400, 'Up to a year at a time.')
    for (let d = from; d <= to; d = addDays(d, 1)) {
      days.set(d, { day: d, occupied: occByDay.get(d) ?? 0, qty: {}, costPaise: 0 })
    }
    const totals: Record<string, { qty: number; costPaise: number }> = Object.fromEntries(meters.map((m) => [m.id, { qty: 0, costPaise: 0 }]))
    for (const r of rows) {
      const d = days.get(r.day), q2 = Number(r.qty), cost = Math.round(q2 * (rate.get(r.meter_id) ?? 0))
      if (!d || !totals[r.meter_id]) continue
      d.qty[r.meter_id] = q2; d.costPaise += cost
      totals[r.meter_id].qty += q2; totals[r.meter_id].costPaise += cost
    }
    const list = [...days.values()]
    const occupied = list.reduce((a, d) => a + d.occupied, 0), cost = list.reduce((a, d) => a + d.costPaise, 0)
    const sumKind = (k: string) => meters.filter((m) => m.kind === k).reduce((a, m) => a + totals[m.id].qty, 0)
    const dgHours = sumKind('dg_hours'), diesel = sumKind('diesel')
    return {
      from, to, meters, days: list, totals, occupiedRoomNights: occupied, costPaise: cost,
      costPerOccupiedRoomPaise: occupied ? Math.round(cost / occupied) : null,
      kwhPerOccupiedRoom: occupied ? Math.round((sumKind('electricity') + sumKind('solar')) / occupied * 10) / 10 : null,
      dieselPerDgHour: dgHours ? Math.round((diesel / dgHours) * 10) / 10 : null,
    }
  })

  // ---------- pool, STP and fire checks ----------
  app.post('/api/eng/logs', async (req, reply) => {
    const who = await need(req, 'eng.work', 'eng.manage')
    const b = (req.body ?? {}) as { kind?: 'pool' | 'stp' | 'fire'; assetId?: string; data?: Record<string, unknown>; note?: string }
    const d = b.data ?? {}
    const issues: string[] = []
    const n = (k: string, label: string, required: boolean) => {
      const v = d[k]
      if (v == null || v === '') { if (required) throw new HttpError(400, `Enter ${label}.`); return null }
      const x = Number(v)
      if (!Number.isFinite(x) || x < 0) throw new HttpError(400, `${label}: a number.`)
      return x
    }
    if (b.kind === 'pool') {
      const ph = n('ph', 'pH', true)!, cl = n('chlorine', 'free chlorine (ppm)', true)!
      n('temperature', 'temperature', false)
      if (!inRange(ph, LIMITS.pool.ph)) issues.push(`pH ${ph} (keep ${LIMITS.pool.ph.join('–')})`)
      if (!inRange(cl, LIMITS.pool.chlorine)) issues.push(`chlorine ${cl} ppm (keep ${LIMITS.pool.chlorine.join('–')})`)
      if (d.clarity === 'cloudy') issues.push('water cloudy')
    } else if (b.kind === 'stp') {
      const ph = n('ph', 'outlet pH', true)!, bod = n('bod', 'BOD', false), tss = n('tss', 'TSS', false)
      n('flowKl', 'flow', false); n('mlss', 'MLSS', false); n('blowerHours', 'blower hours', false)
      if (!inRange(ph, LIMITS.stp.ph)) issues.push(`outlet pH ${ph} (keep ${LIMITS.stp.ph.join('–')})`)
      if (bod != null && !inRange(bod, LIMITS.stp.bod)) issues.push(`BOD ${bod} mg/L (limit ${LIMITS.stp.bod[1]})`)
      if (tss != null && !inRange(tss, LIMITS.stp.tss)) issues.push(`TSS ${tss} mg/L (limit ${LIMITS.stp.tss[1]})`)
      if (d.odour === true) issues.push('bad odour')
    } else if (b.kind === 'fire') {
      if (!b.assetId) throw new HttpError(400, 'Choose the extinguisher or hydrant checked.')
      const checks: [string, string][] = [['pressureOk', 'pressure not in the green'], ['sealOk', 'seal or pin broken'], ['accessible', 'blocked or hard to reach'], ['signage', 'sign missing']]
      for (const [k, bad] of checks) {
        if (typeof d[k] !== 'boolean') throw new HttpError(400, 'Answer every check (yes or no).')
        if (!d[k]) issues.push(bad)
      }
      if (d.nextRefill && !DATE.test(String(d.nextRefill))) throw new HttpError(400, 'Next refill as YYYY-MM-DD.')
    } else throw new HttpError(400, 'Kind: pool, stp or fire.')
    return db.tx(async (t) => {
      let space: string | null = null, assetName = ''
      if (b.assetId) {
        const [a] = await t.query<{ category: string; space_id: string | null; name: string }>('select category, space_id, name from asset where id = $1', [b.assetId])
        if (!a) throw new HttpError(404, 'No such asset.')
        if (b.kind === 'fire' && a.category !== 'fire') throw new HttpError(400, 'Choose a fire extinguisher or hydrant.')
        space = a.space_id; assetName = a.name
      }
      const label = { pool: 'Pool water check', stp: 'STP check', fire: `Fire check: ${assetName}` }[b.kind!]
      const ticketId = issues.length
        ? await addTicket(t, { kind: 'fault', title: `${label} failed: ${issues.join(', ')}`.slice(0, 120), priority: b.kind === 'stp' ? 'normal' : 'high', assetId: b.assetId ?? null, spaceId: space }, who, now())
        : null
      const id = newId('OL')
      await t.query('insert into ops_log (id, kind, asset_id, business_date, data, ok, issues, ticket_id, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [id, b.kind, b.assetId ?? null, istDay(now()), JSON.stringify(d), !issues.length, issues, ticketId, b.note?.trim() || null, who.userId, now()])
      await appendAudit(t, { actor: who, action: issues.length ? 'eng.check_failed' : 'eng.check', entity: { type: 'ops_log', id }, after: { kind: b.kind, issues } }, now())
      return reply.status(201).send({ id, ok: !issues.length, issues, ticketId })
    })
  })

  app.get('/api/eng/logs', async (req) => {
    await need(req, 'eng.work', 'eng.manage', 'compliance.view')
    const q = req.query as { kind?: string; days?: string }
    const since = new Date(now().getTime() - Math.min(366, Number(q.days ?? 30)) * 86_400_000)
    return db.query(
      `select l.id, l.kind, l.asset_id, a.name as asset, l.business_date::text, l.data, l.ok, l.issues, l.ticket_id, l.note, u.name as by, l.at
         from ops_log l left join asset a on a.id = l.asset_id join app_user u on u.id = l.by_user
        where ($1::text is null or l.kind = $1) and l.at >= $2 order by l.at desc limit 300`, [q.kind ?? null, since])
  })

  // ---------- compliance calendar ----------
  app.get('/api/compliance', async (req) => {
    const who = await need(req, 'compliance.view', 'licences.edit', 'eng.manage')
    await sweepEngineering(db, now())
    const today = istDay(now())
    const items: { type: string; id: string; name: string; due: string | null; daysLeft: number | null; tier: number; owner: string | null; detail: string | null; docIds?: string[] }[] = []
    const lic = await db.query<{ id: string; kind: string; name: string; number: string; authority: string | null; valid_until: string | null; owner: string | null; doc_ids: string[] }>(
      `select l.id, l.kind, l.name, l.number, l.authority, l.valid_until::text, u.name as owner, l.doc_ids from licence l left join app_user u on u.id = l.owner_id where l.active order by l.valid_until nulls last`)
    for (const l of lic) {
      items.push({ type: 'licence', id: l.id, name: l.name, due: l.valid_until, daysLeft: l.valid_until ? daysBetween(today, l.valid_until) : null, tier: l.valid_until ? reminderTier(today, l.valid_until) : 0,
        owner: l.owner, docIds: l.doc_ids, detail: [l.number, l.authority, l.doc_ids.length ? `${l.doc_ids.length} cop${l.doc_ids.length > 1 ? 'ies' : 'y'} on file` : 'no copy on file'].filter(Boolean).join(' · ') })
    }
    const amc = await db.query<{ id: string; name: string; amc_vendor: string | null; amc_until: string }>(`select id, name, amc_vendor, amc_until::text from asset where active and amc_until is not null`)
    for (const a of amc) items.push({ type: 'amc', id: a.id, name: `AMC: ${a.name}`, due: a.amc_until, daysLeft: daysBetween(today, a.amc_until), tier: reminderTier(today, a.amc_until), owner: null, detail: a.amc_vendor })
    // Legal metrology: peg measures and scales must be re-verified and stamped.
    const ms = await db.query<{ id: string; name: string; capacity: string | null; location: string | null; due_on: string }>(`select id, name, capacity, location, due_on::text from measure where active and due_on is not null`)
    for (const m of ms) items.push({ type: 'metrology', id: m.id, name: `Stamping: ${m.name}`, due: m.due_on, daysLeft: daysBetween(today, m.due_on), tier: reminderTier(today, m.due_on), owner: null, detail: [m.capacity, m.location].filter(Boolean).join(' · ') || null })
    // Statutory equipment checks (fire, lifts, transformer) and any planned maintenance that is overdue.
    const pm = await db.query<{ id: string; title: string; asset: string; category: string; next_due: string }>(
      `select p.id, p.title, a.name as asset, a.category, p.next_due::text from pm_plan p join asset a on a.id = p.asset_id
        where p.active and a.active and (a.category in ('fire', 'lift', 'transformer') or p.next_due < $1)`, [today])
    for (const p of pm) items.push({ type: 'maintenance', id: p.id, name: `${p.title}: ${p.asset}`, due: p.next_due, daysLeft: daysBetween(today, p.next_due), tier: reminderTier(today, p.next_due), owner: null, detail: p.category })
    items.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
    const people = can(who, 'licences.edit') ? await db.query('select id, name from app_user where active order by name') : []
    return { today, items, people }
  })

  app.patch('/api/compliance/licences/:id', async (req) => {
    const who = await need(req, 'licences.edit')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { ownerId?: string | null; docIds?: string[] }
    return db.tx(async (t) => {
      const [before] = await t.query<{ owner_id: string | null; doc_ids: string[] }>('select owner_id, doc_ids from licence where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such licence.')
      if (b.ownerId) { const [u] = await t.query('select 1 from app_user where id = $1 and active', [b.ownerId]); if (!u) throw new HttpError(404, 'No such person.') }
      await t.query('update licence set owner_id = $2, doc_ids = $3 where id = $1', [id, b.ownerId === undefined ? before.owner_id : b.ownerId, b.docIds ?? before.doc_ids])
      await appendAudit(t, { actor: who, action: 'licence.owner', entity: { type: 'licence', id }, before, after: { owner_id: b.ownerId, doc_ids: b.docIds } }, now())
      return { ok: true }
    })
  })
}
