import type { FastifyInstance, FastifyRequest } from 'fastify'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { addTicket, CATEGORIES, istDay, newId, PM_TEMPLATES, positionOf, SLA, sweepEngineering, type Priority } from '../eng-core'
import { geoSettings, toMap } from '../geo'
import { createApproval, registerApprovalKind, roleLimit } from './approvals'
import { requireCaller } from './auth'

// Engineering and maintenance: the asset register (pinned on the 3D map), planned maintenance,
// fault tickets from anyone with a photo and a place, the engineer's work on them, and the spares store.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low']
const OPEN = ['open', 'in_progress', 'on_hold']

interface Issue { spareId: string; qty: number; ticketId?: string | null; value: number; note?: string | null; spare: string; requestedBy: string }
async function issueSpare(t: Db, p: Issue, now: Date) {
  await t.query('insert into spare_move (id, spare_id, kind, qty, value_paise, ticket_id, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [newId('SM'), p.spareId, 'issue', -p.qty, -p.value, p.ticketId ?? null, p.note ?? null, p.requestedBy, now])
}

registerApprovalKind('eng.spares', {
  permission: 'eng.approve',
  apply: (t, p, _decider, ctx) => issueSpare(t, p as never, ctx.now()),
})

const num = (v: unknown) => (v == null || v === '' ? null : Number(v))

export function engineeringRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }

  // ---------- reference ----------
  app.get('/api/eng/meta', async (req) => {
    await requireCaller(ctx, req)
    return { categories: CATEGORIES, sla: SLA, templates: PM_TEMPLATES }
  })

  // Assets and open tickets with their place on the 3D map.
  app.get('/api/eng/map', async (req) => {
    const who = await requireCaller(ctx, req)
    const all = can(who, 'eng.work') || can(who, 'eng.manage')
    await sweepEngineering(db, now())
    const assets = await db.query<{ id: string; name: string; category: string; space_id: string | null; x: string | null; z: string | null; open: number }>(
      `select a.id, a.name, a.category, a.space_id, a.x, a.z, (select count(*)::int from ticket k where k.asset_id = a.id and k.status = any($1)) as open
         from asset a where a.active`, [OPEN])
    const tickets = await db.query<{ id: string; title: string; priority: string; status: string; asset_id: string | null; space_id: string | null; x: string | null; z: string | null; reported_at: string; escalation: number; kind: string }>(
      `select id, title, priority, status, asset_id, space_id, x, z, reported_at, escalation, kind from ticket where status = any($1) and ($2 or reported_by = $3)`, [OPEN, all, who.userId])
    return {
      assets: all ? await Promise.all(assets.map(async (a) => ({ id: a.id, name: a.name, category: a.category, open: a.open, pos: await positionOf(db, a) }))) : [],
      tickets: await Promise.all(tickets.map(async (k) => ({ id: k.id, title: k.title, priority: k.priority, status: k.status, kind: k.kind, reportedAt: k.reported_at, escalation: k.escalation, pos: await positionOf(db, k) }))),
    }
  })

  // ---------- assets ----------
  app.get('/api/eng/assets', async (req) => {
    await need(req, 'eng.work', 'eng.manage', 'compliance.view')
    return db.query(
      `select a.*, a.installed_on::text, a.warranty_until::text, a.amc_until::text, s.name as space,
              (select count(*)::int from ticket k where k.asset_id = a.id and k.status = any($1)) as open_tickets,
              (select min(p.next_due)::text from pm_plan p where p.asset_id = a.id and p.active) as next_pm
         from asset a left join space s on s.id = a.space_id order by a.active desc, a.category, a.name`, [OPEN])
  })

  /** An asset pinned where the engineer is standing: the phone's GPS onto the map. */
  async function pinFromGps(t: Db, b: Record<string, unknown>) {
    if (b.lat == null || b.lng == null || b.x != null) return
    const pos = toMap(await geoSettings(t), Number(b.lat), Number(b.lng))
    if (!pos) throw new HttpError(409, 'Set the resort boundary (Staff → Settings) before pinning by location.')
    b.x = pos.x; b.z = pos.z
  }

  function checkAsset(b: Record<string, unknown>, partial: boolean) {
    if (!partial || b.name !== undefined) if (!String(b.name ?? '').trim() || String(b.name).length > 80) throw new HttpError(400, 'Name the asset (up to 80 characters).')
    if (!partial || b.category !== undefined) if (!CATEGORIES.includes(b.category as never)) throw new HttpError(400, `Category: ${CATEGORIES.join(', ')}.`)
    for (const k of ['installedOn', 'warrantyUntil', 'amcUntil']) if (b[k] && !DATE.test(String(b[k]))) throw new HttpError(400, 'Dates as YYYY-MM-DD.')
    if (b.amcCost != null && !(Number(b.amcCost) >= 0)) throw new HttpError(400, 'AMC cost in rupees.')
  }
  const assetCols: [string, string, (v: unknown) => unknown][] = [
    ['name', 'name', (v) => String(v).trim()], ['category', 'category', String], ['spaceId', 'space_id', (v) => v || null], ['x', 'x', num], ['z', 'z', num],
    ['make', 'make', (v) => (v ? String(v).trim() : null)], ['model', 'model', (v) => (v ? String(v).trim() : null)], ['serial', 'serial', (v) => (v ? String(v).trim() : null)],
    ['installedOn', 'installed_on', (v) => v || null], ['warrantyUntil', 'warranty_until', (v) => v || null], ['amcVendor', 'amc_vendor', (v) => (v ? String(v).trim() : null)],
    ['amcUntil', 'amc_until', (v) => v || null], ['amcCost', 'amc_cost_paise', (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100))],
    ['notes', 'notes', (v) => (v ? String(v).trim() : null)], ['active', 'active', Boolean],
  ]

  app.post('/api/eng/assets', async (req, reply) => {
    const who = await need(req, 'eng.manage')
    const b = (req.body ?? {}) as Record<string, unknown>
    checkAsset(b, false)
    const id = newId('AS')
    await db.tx(async (t) => {
      await pinFromGps(t, b)
      const cols = assetCols.filter(([k]) => b[k] !== undefined)
      await t.query(`insert into asset (id, created_at, ${cols.map((c) => c[1]).join(', ')}) values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})`,
        [id, now(), ...cols.map(([k, , f]) => f(b[k]))])
      await appendAudit(t, { actor: who, action: 'asset.add', entity: { type: 'asset', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/eng/assets/:id', async (req) => {
    const who = await need(req, 'eng.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as Record<string, unknown>
    checkAsset(b, true)
    return db.tx(async (t) => {
      const [before] = await t.query('select * from asset where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such asset.')
      await pinFromGps(t, b)
      const cols = assetCols.filter(([k]) => b[k] !== undefined)
      if (cols.length) await t.query(`update asset set ${cols.map((c, i) => `${c[1]} = $${i + 2}`).join(', ')}${b.amcUntil !== undefined ? ', amc_reminded = 0' : ''} where id = $1`, [id, ...cols.map(([k, , f]) => f(b[k]))])
      const [after] = await t.query('select * from asset where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'asset.update', entity: { type: 'asset', id }, before, after }, now())
      return after
    })
  })

  // ---------- planned maintenance ----------
  app.get('/api/eng/plans', async (req) => {
    await need(req, 'eng.work', 'eng.manage')
    return db.query(
      `select p.id, p.asset_id, a.name as asset, a.category, p.title, p.every_days, p.checklist, p.next_due::text, p.last_done::text, p.active
         from pm_plan p join asset a on a.id = p.asset_id order by p.active desc, p.next_due, a.name`)
  })

  app.post('/api/eng/plans', async (req, reply) => {
    const who = await need(req, 'eng.manage')
    const b = (req.body ?? {}) as { assetId?: string; title?: string; everyDays?: number; checklist?: string[]; nextDue?: string }
    if (!b.title?.trim() || !Number.isInteger(b.everyDays) || b.everyDays! < 1 || b.everyDays! > 1095) throw new HttpError(400, 'Title, and how often (1–1095 days).')
    if (b.nextDue && !DATE.test(b.nextDue)) throw new HttpError(400, 'First due date as YYYY-MM-DD.')
    const checklist = (b.checklist ?? []).map((x) => String(x).trim()).filter(Boolean)
    if (!checklist.length) throw new HttpError(400, 'Add at least one checklist item.')
    const id = newId('PM')
    await db.tx(async (t) => {
      const [a] = await t.query('select 1 from asset where id = $1', [b.assetId])
      if (!a) throw new HttpError(404, 'No such asset.')
      await t.query('insert into pm_plan (id, asset_id, title, every_days, checklist, next_due) values ($1,$2,$3,$4,$5,$6)',
        [id, b.assetId, b.title!.trim(), b.everyDays, JSON.stringify(checklist), b.nextDue ?? istDay(now())])
      await appendAudit(t, { actor: who, action: 'pm.add', entity: { type: 'pm_plan', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/eng/plans/:id', async (req) => {
    const who = await need(req, 'eng.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { title?: string; everyDays?: number; checklist?: string[]; nextDue?: string; active?: boolean }
    if (b.everyDays !== undefined && !(Number.isInteger(b.everyDays) && b.everyDays >= 1 && b.everyDays <= 1095)) throw new HttpError(400, 'How often: 1–1095 days.')
    if (b.nextDue !== undefined && !DATE.test(b.nextDue)) throw new HttpError(400, 'Next due as YYYY-MM-DD.')
    return db.tx(async (t) => {
      const [before] = await t.query('select * from pm_plan where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such plan.')
      await t.query(`update pm_plan set title = coalesce($2, title), every_days = coalesce($3, every_days), checklist = coalesce($4, checklist), next_due = coalesce($5, next_due), active = coalesce($6, active) where id = $1`,
        [id, b.title?.trim() || null, b.everyDays ?? null, b.checklist ? JSON.stringify(b.checklist.map((x) => String(x).trim()).filter(Boolean)) : null, b.nextDue ?? null, b.active ?? null])
      const [after] = await t.query('select * from pm_plan where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'pm.update', entity: { type: 'pm_plan', id }, before, after }, now())
      return after
    })
  })

  // ---------- tickets ----------
  app.post('/api/eng/tickets', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    const b = (req.body ?? {}) as { title?: string; detail?: string; priority?: Priority; assetId?: string; spaceId?: string; x?: number; z?: number; lat?: number; lng?: number; photoIds?: string[] }
    if (!b.title?.trim() || b.title.length > 120) throw new HttpError(400, 'Say what is wrong (up to 120 characters).')
    const priority = b.priority ?? 'normal'
    if (!PRIORITIES.includes(priority)) throw new HttpError(400, `Priority: ${PRIORITIES.join(', ')}.`)
    return db.tx(async (t) => {
      let pos: { x: number; z: number } | null = b.x != null && b.z != null ? { x: Number(b.x), z: Number(b.z) } : null
      if (!pos && !b.assetId && !b.spaceId && Number.isFinite(b.lat) && Number.isFinite(b.lng)) pos = toMap(await geoSettings(t), b.lat!, b.lng!)
      if (b.assetId) { const [a] = await t.query('select 1 from asset where id = $1', [b.assetId]); if (!a) throw new HttpError(404, 'No such asset.') }
      const id = await addTicket(t, { kind: 'fault', title: b.title!.trim(), detail: b.detail?.trim() || null, priority, assetId: b.assetId ?? null, spaceId: b.spaceId ?? null,
        x: pos?.x ?? null, z: pos?.z ?? null, photos: (b.photoIds ?? []).slice(0, 6) }, who, now())
      return reply.status(201).send({ id, located: !!(pos || b.assetId || b.spaceId) })
    })
  })

  app.get('/api/eng/tickets', async (req) => {
    const who = await requireCaller(ctx, req)
    const q = req.query as { status?: string }
    const all = can(who, 'eng.work') || can(who, 'eng.manage')
    await sweepEngineering(db, now())
    const statuses = q.status === 'all' ? ['open', 'in_progress', 'on_hold', 'done', 'closed', 'cancelled'] : q.status === 'done' ? ['done'] : q.status === 'closed' ? ['closed', 'cancelled'] : OPEN
    const rows = await db.query<{ respond_by: string; resolve_by: string; responded_at: string | null; status: string }>(
      `select k.id, k.kind, k.title, k.detail, k.priority, k.status, k.asset_id, a.name as asset, a.category, k.space_id, s.name as space, k.photos, k.checklist,
              r.name as reported_by, k.reported_by as reporter_id, k.reported_at, k.assigned_to, u.name as assignee, k.responded_at, k.respond_by, k.resolve_by, k.done_at, k.resolution, k.hold_reason,
              k.escalation, k.closed_at, (select coalesce(-sum(m.value_paise), 0)::bigint from spare_move m where m.ticket_id = k.id) as spares_paise
         from ticket k left join asset a on a.id = k.asset_id left join space s on s.id = k.space_id left join app_user r on r.id = k.reported_by left join app_user u on u.id = k.assigned_to
        where k.status = any($1) and ($2 or k.reported_by = $3 or k.assigned_to = $3)
        order by case k.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, k.reported_at limit 300`, [statuses, all, who.userId])
    const t = now().getTime()
    return rows.map((k) => ({ ...k, responseLate: !k.responded_at && new Date(k.respond_by).getTime() < t, resolveLate: OPEN.includes(k.status) && new Date(k.resolve_by).getTime() < t }))
  })

  app.post('/api/eng/tickets/:id/:action', async (req) => {
    const who = await requireCaller(ctx, req)
    const { id, action } = req.params as { id: string; action: string }
    const b = (req.body ?? {}) as { userId?: string; reason?: string; resolution?: string; checklist?: { item: string; done: boolean }[]; photoIds?: string[] }
    const worker = can(who, 'eng.work') || can(who, 'eng.manage')
    return db.tx(async (t) => {
      const [k] = await t.query<{ status: string; kind: string; reported_by: string | null; assigned_to: string | null; pm_plan_id: string | null; checklist: { item: string; done: boolean }[]; title: string }>(
        'select status, kind, reported_by, assigned_to, pm_plan_id, checklist, title from ticket where id = $1 for update', [id])
      if (!k) throw new HttpError(404, 'No such ticket.')
      const set = async (sql: string, args: unknown[]) => t.query(`update ticket set ${sql} where id = $1`, [id, ...args])
      const isOpen = OPEN.includes(k.status)
      let note: string | undefined
      switch (action) {
        case 'take':
          if (!worker) throw new HttpError(403, 'Only engineering can take tickets.')
          if (!isOpen) throw new HttpError(409, `This ticket is ${k.status.replace('_', ' ')}.`)
          await set('assigned_to = $2, responded_at = coalesce(responded_at, $3)', [who.userId, now()])
          break
        case 'assign': {
          if (!can(who, 'eng.manage')) throw new HttpError(403, 'Only the engineering manager assigns tickets.')
          if (!isOpen) throw new HttpError(409, `This ticket is ${k.status.replace('_', ' ')}.`)
          const [u] = await t.query<{ name: string }>('select name from app_user where id = $1 and active', [b.userId])
          if (!u) throw new HttpError(404, 'No such person.')
          await set('assigned_to = $2, responded_at = coalesce(responded_at, $3)', [b.userId, now()])
          note = u.name
          break
        }
        case 'start':
          if (!worker) throw new HttpError(403, 'Only engineering can work on tickets.')
          if (!isOpen) throw new HttpError(409, `This ticket is ${k.status.replace('_', ' ')}.`)
          await set(`status = 'in_progress', hold_reason = null, assigned_to = coalesce(assigned_to, $2), responded_at = coalesce(responded_at, $3)`, [who.userId, now()])
          break
        case 'hold':
          if (!worker) throw new HttpError(403, 'Only engineering can put a ticket on hold.')
          if (!isOpen) throw new HttpError(409, `This ticket is ${k.status.replace('_', ' ')}.`)
          if (!b.reason?.trim()) throw new HttpError(400, 'Say what it is waiting for (spares, vendor, guest in room…).')
          await set(`status = 'on_hold', hold_reason = $2, responded_at = coalesce(responded_at, $3)`, [b.reason.trim(), now()])
          note = b.reason.trim()
          break
        case 'done': {
          if (!worker) throw new HttpError(403, 'Only engineering can finish tickets.')
          if (!isOpen) throw new HttpError(409, `This ticket is ${k.status.replace('_', ' ')}.`)
          if (!b.resolution?.trim()) throw new HttpError(400, 'Say what was done.')
          const list = b.checklist ?? k.checklist
          if (k.kind === 'pm' && list.some((c) => !c.done)) throw new HttpError(400, `Not ticked: ${list.filter((c) => !c.done).map((c) => c.item).join(', ')}. Note anything not done and tick it.`)
          await set(`status = 'done', done_at = $2, resolution = $3, checklist = $4, photos = photos || $5::text[], assigned_to = coalesce(assigned_to, $6), responded_at = coalesce(responded_at, $2)`,
            [now(), b.resolution.trim(), JSON.stringify(list), (b.photoIds ?? []).slice(0, 6), who.userId])
          if (k.pm_plan_id) await t.query(`update pm_plan set last_done = $2, next_due = ($2::date + every_days) where id = $1`, [k.pm_plan_id, istDay(now())])
          note = b.resolution.trim()
          break
        }
        case 'close':
          if (!(can(who, 'eng.manage') || k.reported_by === who.userId)) throw new HttpError(403, 'The person who reported it or the engineering manager confirms the fix.')
          if (k.status !== 'done') throw new HttpError(409, 'Only a finished ticket can be closed.')
          await set(`status = 'closed', closed_by = $2, closed_at = $3`, [who.userId, now()])
          break
        case 'reopen':
          if (!(can(who, 'eng.manage') || k.reported_by === who.userId)) throw new HttpError(403, 'The person who reported it or the engineering manager can reopen it.')
          if (!['done', 'closed'].includes(k.status)) throw new HttpError(409, 'The ticket is still open.')
          if (!b.reason?.trim()) throw new HttpError(400, 'Say what is still wrong.')
          await set(`status = 'open', done_at = null, closed_at = null, closed_by = null, escalation = 0, resolve_by = $2`, [new Date(now().getTime() + SLA.high.resolve * 60_000)])
          note = b.reason.trim()
          break
        case 'cancel':
          if (!can(who, 'eng.manage')) throw new HttpError(403, 'Only the engineering manager cancels tickets.')
          if (!isOpen) throw new HttpError(409, `This ticket is ${k.status.replace('_', ' ')}.`)
          if (!b.reason?.trim()) throw new HttpError(400, 'Say why (duplicate, not a fault…).')
          await set(`status = 'cancelled', closed_by = $2, closed_at = $3, resolution = $4`, [who.userId, now(), b.reason.trim()])
          if (k.pm_plan_id) await t.query(`update pm_plan set next_due = ($2::date + every_days) where id = $1`, [k.pm_plan_id, istDay(now())])
          note = b.reason.trim()
          break
        default: throw new HttpError(404, 'Use take, assign, start, hold, done, close, reopen or cancel.')
      }
      await appendAudit(t, { actor: who, action: `eng.${action}`, entity: { type: 'ticket', id }, after: { title: k.title }, note }, now())
      return { ok: true }
    })
  })

  // ---------- spares ----------
  app.get('/api/eng/spares', async (req) => {
    await need(req, 'eng.work', 'eng.manage')
    const rows = await db.query<{ stock: string; reorder_level: string | null; cost_paise: string }>(
      `select s.id, s.name, s.unit, s.reorder_level, s.cost_paise, s.active, coalesce(sum(m.qty), 0) as stock
         from spare s left join spare_move m on m.spare_id = s.id group by s.id order by s.active desc, s.name`)
    return rows.map((r) => ({ ...r, stock: Number(r.stock), costPaise: Math.round(Number(r.cost_paise)), low: r.reorder_level != null && Number(r.stock) <= Number(r.reorder_level) }))
  })

  app.post('/api/eng/spares', async (req, reply) => {
    const who = await need(req, 'eng.manage')
    const b = (req.body ?? {}) as { name?: string; unit?: string; reorderLevel?: number }
    if (!b.name?.trim()) throw new HttpError(400, 'Name the spare part.')
    const id = newId('SP')
    await db.tx(async (t) => {
      await t.query('insert into spare (id, name, unit, reorder_level) values ($1,$2,$3,$4)', [id, b.name!.trim(), b.unit?.trim() || 'nos', b.reorderLevel ?? null])
      await appendAudit(t, { actor: who, action: 'spare.add', entity: { type: 'spare', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  // Spares bought: stock goes up and the average cost follows the price paid.
  app.post('/api/eng/spares/:id/receive', async (req, reply) => {
    const who = await need(req, 'eng.manage', 'eng.work')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { qty?: number; cost?: number; vendor?: string; note?: string }
    if (!(Number(b.qty) > 0) || !(Number(b.cost) >= 0)) throw new HttpError(400, 'Quantity received and the total cost in rupees.')
    return db.tx(async (t) => {
      const [s] = await t.query<{ cost_paise: string; stock: string; name: string }>(
        'select s.cost_paise, s.name, coalesce((select sum(qty) from spare_move m where m.spare_id = s.id), 0) as stock from spare s where s.id = $1 for update', [id])
      if (!s) throw new HttpError(404, 'No such spare.')
      const value = Math.round(Number(b.cost) * 100), stock = Math.max(0, Number(s.stock))
      const avg = (stock * Number(s.cost_paise) + value) / (stock + Number(b.qty))
      await t.query('update spare set cost_paise = $2 where id = $1', [id, avg.toFixed(2)])
      await t.query('insert into spare_move (id, spare_id, kind, qty, value_paise, vendor, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [newId('SM'), id, 'receive', b.qty, value, b.vendor?.trim() || null, b.note?.trim() || null, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'spare.receive', entity: { type: 'spare', id }, amount: value, after: { qty: b.qty, spare: s.name, vendor: b.vendor ?? null } }, now())
      return reply.status(201).send({ ok: true })
    })
  })

  // Spares drawn from the store for a job; above the role's limit the issue waits for approval.
  app.post('/api/eng/spares/:id/issue', async (req, reply) => {
    const who = await need(req, 'eng.work', 'eng.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { qty?: number; ticketId?: string; note?: string }
    if (!(Number(b.qty) > 0)) throw new HttpError(400, 'How many?')
    return db.tx(async (t) => {
      const [s] = await t.query<{ cost_paise: string; stock: string; name: string; unit: string }>(
        'select s.cost_paise, s.name, s.unit, coalesce((select sum(qty) from spare_move m where m.spare_id = s.id), 0) as stock from spare s where s.id = $1', [id])
      if (!s) throw new HttpError(404, 'No such spare.')
      if (Number(s.stock) < Number(b.qty)) throw new HttpError(409, `Only ${Number(s.stock)} ${s.unit} of ${s.name} in the store.`)
      if (b.ticketId) { const [k] = await t.query('select 1 from ticket where id = $1', [b.ticketId]); if (!k) throw new HttpError(404, 'No such ticket.') }
      const value = Math.round(Number(b.qty) * Number(s.cost_paise))
      const p: Issue = { spareId: id, qty: Number(b.qty), ticketId: b.ticketId ?? null, value, note: b.note?.trim() || null, spare: s.name, requestedBy: who.userId }
      if (value > (await roleLimit(t, who, 'spares_issue')) * 100 && !can(who, 'eng.approve')) {
        const approvalId = await createApproval(ctx, t, 'eng.spares', who.userId, p as unknown as Record<string, unknown>, `${b.qty} ${s.unit} ${s.name}${b.ticketId ? ` for ${b.ticketId}` : ''}`)
        await appendAudit(t, { actor: who, action: 'spare.issue_requested', entity: { type: 'spare', id }, amount: value, after: { qty: b.qty, spare: s.name } }, now())
        return reply.status(202).send({ pending: true, approvalId })
      }
      await issueSpare(t, p, now())
      await appendAudit(t, { actor: who, action: 'spare.issue', entity: { type: 'spare', id }, amount: value, after: { qty: b.qty, spare: s.name, ticketId: b.ticketId ?? null } }, now())
      return reply.status(201).send({ ok: true, valuePaise: value })
    })
  })

  app.get('/api/eng/spares/moves', async (req) => {
    await need(req, 'eng.work', 'eng.manage')
    return db.query(`select m.id, m.at, m.kind, m.qty, m.value_paise, m.ticket_id, m.vendor, m.note, s.name as spare, s.unit, u.name as by
                       from spare_move m join spare s on s.id = m.spare_id join app_user u on u.id = m.by_user order by m.at desc limit 200`)
  })

  // People who can take engineering work, for assigning.
  app.get('/api/eng/people', async (req) => {
    await need(req, 'eng.manage')
    return db.query(`select distinct u.id, u.name, exists (select 1 from attendance a where a.user_id = u.id and a.clock_out_at is null) as on_duty
                       from app_user u join user_role ur on ur.user_id = u.id join role r on r.id = ur.role_id
                      where u.active and ('eng.work' = any(r.permissions) or 'eng.manage' = any(r.permissions)) order by u.name`)
  })
}

