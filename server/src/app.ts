import { existsSync } from 'node:fs'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { accommodationNight, addDays, loadTaxConfig, priceGuard, rupees, type NightTax } from '@sathya/tax'
import { appendAudit, readAudit, verifyStoredChain } from './audit-store'
import { consoleSms, HttpError, loadRolesConfig, type Ctx } from './context'
import type { Db } from './db'
import { approvalRoutes, createApproval } from './routes/approvals'
import { authRoutes, requireCaller } from './routes/auth'
import { inventoryRoutes } from './routes/inventory'
import { userRoutes } from './routes/users'
import { frontOfficeRoutes } from './routes/frontoffice'
import { nightAuditRoutes } from './routes/nightaudit'
import { invoiceRoutes } from './routes/invoices'
import { dashboardRoutes } from './routes/dashboard'
import { siteRoutes } from './routes/site'
import { fnbRoutes } from './routes/fnb'
import { settingsRoutes } from './routes/settings'
import { fnbBillingRoutes } from './routes/fnb-billing'
import { barRoutes } from './routes/bar'
import { kitchenStockRoutes } from './routes/kitchen-stock'
import { idempotency, printingRoutes } from './routes/printing'
import { uploadRoutes } from './routes/uploads'
import { housekeepingRoutes } from './routes/housekeeping'
import { linenLaundryRoutes } from './routes/linen-laundry'
import { staffRoutes } from './routes/staff'
import { engineeringRoutes } from './routes/engineering'
import { utilityRoutes } from './routes/utilities'
import { securityRoutes } from './routes/security'
import { storesRoutes } from './routes/stores'
import { purchaseRoutes } from './routes/purchase'
import { receiptRoutes } from './routes/receipts'
import { payablesRoutes } from './routes/payables'
import { stockOpsRoutes } from './routes/stock-ops'
import { exciseRoutes } from './routes/excise'
import { monthCloseRoutes } from './routes/month-close'
import { accountsRoutes } from './routes/accounts'
import { receivablesRoutes } from './routes/receivables'
import { bankRoutes } from './routes/bank'
import { otaRoutes } from './routes/ota'
import { gstRoutes } from './routes/gst'

export function buildApp(db: Db, opts: Partial<Omit<Ctx, 'db'>> & { logger?: boolean; appDir?: string } = {}) {
  const ctx: Ctx = {
    db,
    tax: opts.tax ?? loadTaxConfig(),
    roles: opts.roles ?? loadRolesConfig(),
    sms: opts.sms ?? consoleSms,
    now: opts.now ?? (() => new Date()),
    einvoice: opts.einvoice,
    printAgentKey: opts.printAgentKey,
  }
  const app = Fastify({ logger: opts.logger ?? false })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, ...err.extra })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status === 500) { app.log.error(err); if (process.env.DEBUG_500) console.error(err) }
    return reply.status(status).send({ error: status === 500 ? 'Something went wrong on the server.' : err.message })
  })

  idempotency(app, ctx)
  authRoutes(app, ctx)
  approvalRoutes(app, ctx)
  inventoryRoutes(app, ctx)
  userRoutes(app, ctx)
  frontOfficeRoutes(app, ctx)
  nightAuditRoutes(app, ctx)
  invoiceRoutes(app, ctx)
  dashboardRoutes(app, ctx)
  siteRoutes(app, ctx)
  fnbRoutes(app, ctx)
  settingsRoutes(app, ctx)
  fnbBillingRoutes(app, ctx)
  barRoutes(app, ctx)
  kitchenStockRoutes(app, ctx)
  printingRoutes(app, ctx)
  uploadRoutes(app, ctx)
  housekeepingRoutes(app, ctx)
  linenLaundryRoutes(app, ctx)
  staffRoutes(app, ctx)
  engineeringRoutes(app, ctx)
  utilityRoutes(app, ctx)
  securityRoutes(app, ctx)
  storesRoutes(app, ctx)
  purchaseRoutes(app, ctx)
  receiptRoutes(app, ctx)
  payablesRoutes(app, ctx)
  stockOpsRoutes(app, ctx)
  exciseRoutes(app, ctx)
  monthCloseRoutes(app, ctx)
  accountsRoutes(app, ctx)
  receivablesRoutes(app, ctx)
  bankRoutes(app, ctx)
  otaRoutes(app, ctx)
  gstRoutes(app, ctx)

  // Serve the built 3D app and front desk screens from the same address as the API.
  if (opts.appDir && existsSync(opts.appDir)) app.register(fastifyStatic, { root: opts.appDir, index: 'index.html' })

  app.get('/health', async () => ({ ok: true, db: db.engine }))

  app.get('/api/property', async (req) => {
    await requireCaller(ctx, req)
    const [p] = await db.query('select id, name, legal_name, entity_type, gstin, state_code from property limit 1')
    return p
  })

  app.get('/api/spaces', async (req) => {
    await requireCaller(ctx, req)
    return db.query(`select id, kind, name, room_no, room_type_id, building, floor, capacity, twin_id, sellable, placeholder
                       from space where active order by sellable desc, building, floor, room_no, name`)
  })

  app.get('/api/room-types', async (req) => {
    await requireCaller(ctx, req)
    return db.query(`select t.id, t.name, t.base_rate_paise, t.max_occupancy, t.active, count(s.id)::int as rooms
                       from room_type t left join space s on s.room_type_id = t.id and s.active
                      group by t.id order by t.active desc, t.base_rate_paise`)
  })

  app.get('/api/rate-plans', async (req) => {
    await requireCaller(ctx, req)
    return db.query(`select p.code, p.name, p.meal_plan, r.room_type_id, r.valid_from::text, r.valid_to::text, r.amount_paise, r.approved_by
                       from rate_plan p left join rate r on r.rate_plan_id = p.id
                      where p.active order by p.code, r.room_type_id, r.valid_from`)
  })

  // Price a stay night by night with GST, using the live rate table and the tax engine.
  app.post('/api/quote', async (req) => {
    await requireCaller(ctx, req)
    const b = req.body as { roomTypeId: string; plan: string; checkIn: string; nights: number; extrasPerNight?: number }
    if (!b?.roomTypeId || !b.plan || !/^\d{4}-\d{2}-\d{2}$/.test(b.checkIn ?? '') || !(b.nights >= 1 && b.nights <= 60)) {
      throw new HttpError(400, 'Send roomTypeId, plan, checkIn (YYYY-MM-DD) and nights (1–60).')
    }
    const lines: NightTax[] = []
    for (let i = 0; i < b.nights; i++) {
      const date = addDays(b.checkIn, i)
      const [rate] = await db.query<{ amount_paise: number }>(
        `select r.amount_paise from rate r join rate_plan p on p.id = r.rate_plan_id
          where p.code = $1 and r.room_type_id = $2 and $3::date between r.valid_from and r.valid_to
          order by r.valid_from desc limit 1`, [b.plan, b.roomTypeId, date])
      if (!rate) throw new HttpError(422, `No ${b.plan} rate for ${b.roomTypeId} on ${date}.`)
      lines.push(accommodationNight(ctx.tax, { date, charged: rate.amount_paise, extras: rupees(b.extrasPerNight ?? 0) }))
    }
    const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'total') => lines.reduce((a, l) => a + l[k], 0)
    return { lines, taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), total: sum('total') }
  })

  // Set a rate. Above ₹7,500 a night goes to the MD's approval inbox, because it would move the restaurant to 18% GST.
  app.put('/api/rates', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    const b = req.body as { plan: string; roomTypeId: string; validFrom: string; validTo: string; amount: number }
    if (!b?.plan || !b.roomTypeId || !b.validFrom || !b.validTo || !(b.amount > 0)) {
      throw new HttpError(400, 'Send plan, roomTypeId, validFrom, validTo and amount (₹).')
    }
    const [plan] = await db.query<{ id: string }>('select id from rate_plan where code = $1', [b.plan])
    if (!plan) throw new HttpError(404, `No rate plan ${b.plan}.`)
    const amount = rupees(b.amount)
    const guard = priceGuard(ctx.tax, amount)
    const entity = { type: 'rate', id: `${b.plan}/${b.roomTypeId}/${b.validFrom}` }
    const payload = { planId: plan.id, plan: b.plan, roomTypeId: b.roomTypeId, validFrom: b.validFrom, validTo: b.validTo, amount }

    if (!guard.allowed && !who.permissions.has('*')) {
      const approvalId = await db.tx(async (t) => {
        const id = await createApproval(ctx, t, 'rate.above_limit', who.userId, payload, guard.message ?? undefined)
        await appendAudit(t, { actor: who, action: 'rate.approval_requested', entity, after: payload, amount, note: guard.message ?? undefined }, ctx.now())
        return id
      })
      return reply.status(202).send({ pending: true, approvalId, requires: guard.requires, message: guard.message })
    }
    const result = await db.tx(async (t) => {
      const [before] = await t.query('select valid_to::text, amount_paise from rate where rate_plan_id = $1 and room_type_id = $2 and valid_from = $3',
        [plan.id, b.roomTypeId, b.validFrom])
      await t.query(
        `insert into rate (rate_plan_id, room_type_id, valid_from, valid_to, amount_paise, approved_by) values ($1, $2, $3, $4, $5, $6)
         on conflict (rate_plan_id, room_type_id, valid_from) do update set valid_to = excluded.valid_to,
           amount_paise = excluded.amount_paise, approved_by = excluded.approved_by`,
        [plan.id, b.roomTypeId, b.validFrom, b.validTo, amount, guard.allowed ? null : who.userId])
      return appendAudit(t, {
        actor: who, action: guard.allowed ? 'rate.set' : 'rate.set_above_limit', entity,
        before: before ?? null, after: { valid_to: b.validTo, amount_paise: amount }, amount,
        note: guard.allowed ? undefined : guard.message ?? undefined,
      }, ctx.now())
    })
    return { ok: true, auditSeq: result.seq, aboveLimit: !guard.allowed }
  })

  app.get('/api/audit', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!who.godMode) throw new HttpError(403, 'Only God Mode users can see this.')
    const q = req.query as { limit?: string; entityId?: string; actorId?: string }
    return readAudit(db, { limit: Math.min(Number(q.limit ?? 100), 1000), entityId: q.entityId, actorId: q.actorId })
  })

  app.get('/api/audit/verify', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!who.godMode) throw new HttpError(403, 'Only God Mode users can see this.')
    return verifyStoredChain(db)
  })

  return app
}
