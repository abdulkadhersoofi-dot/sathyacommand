import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { accommodationNight, addDays, loadTaxConfig, priceGuard, rupees, type NightTax, type TaxConfig } from '@sathya/tax'
import type { Actor } from '@sathya/audit'
import { appendAudit, readAudit, verifyStoredChain } from './audit-store'
import type { Db } from './db'

interface Caller extends Actor { godMode: boolean; roles: string[] }

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message) }
}

export function buildApp(db: Db, opts: { tax?: TaxConfig; logger?: boolean } = {}) {
  const tax = opts.tax ?? loadTaxConfig()
  const app = Fastify({ logger: opts.logger ?? false })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, ...err.extra })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: status === 500 ? 'Something went wrong on the server.' : err.message })
  })

  // Temporary caller identification: the x-user-id header. Step 2.4 replaces this with
  // mobile OTP sign-in, two-factor for owner roles and registered devices.
  async function caller(req: FastifyRequest): Promise<Caller> {
    const id = req.headers['x-user-id']
    if (typeof id !== 'string' || !id) throw new HttpError(401, 'Sign in first.')
    const rows = await db.query<{ name: string; role_id: string; god_mode: boolean }>(
      `select u.name, r.id as role_id, r.god_mode from app_user u
         join user_role ur on ur.user_id = u.id join role r on r.id = ur.role_id
        where u.id = $1 and u.active`, [id])
    if (!rows.length) throw new HttpError(401, 'Unknown or inactive user.')
    return {
      userId: id, name: rows[0].name, role: rows[0].role_id, deviceId: req.headers['x-device-id'] as string | undefined,
      roles: rows.map((r) => r.role_id), godMode: rows.some((r) => r.god_mode),
    }
  }
  const requireGod = (c: Caller) => { if (!c.godMode) throw new HttpError(403, 'Only God Mode users can see this.') }

  app.get('/health', async () => ({ ok: true, db: db.engine }))

  app.get('/api/property', async (req) => {
    await caller(req)
    const [p] = await db.query('select id, name, legal_name, entity_type, gstin, state_code from property limit 1')
    return p
  })

  app.get('/api/spaces', async (req) => {
    await caller(req)
    return db.query(`select id, kind, name, room_no, room_type_id, building, floor, capacity, twin_id, sellable, placeholder
                       from space where active order by sellable desc, building, floor, room_no, name`)
  })

  app.get('/api/room-types', async (req) => {
    await caller(req)
    return db.query(`select t.id, t.name, t.base_rate_paise, t.max_occupancy, count(s.id)::int as rooms
                       from room_type t left join space s on s.room_type_id = t.id and s.active
                      group by t.id order by t.base_rate_paise`)
  })

  app.get('/api/rate-plans', async (req) => {
    await caller(req)
    return db.query(`select p.code, p.name, p.meal_plan, r.room_type_id, r.valid_from::text, r.valid_to::text, r.amount_paise
                       from rate_plan p left join rate r on r.rate_plan_id = p.id
                      where p.active order by p.code, r.room_type_id, r.valid_from`)
  })

  // Price a stay night by night with GST, using the live rate table and the tax engine.
  app.post('/api/quote', async (req) => {
    await caller(req)
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
      lines.push(accommodationNight(tax, { date, charged: rate.amount_paise, extras: rupees(b.extrasPerNight ?? 0) }))
    }
    const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'total') => lines.reduce((a, l) => a + l[k], 0)
    return { lines, taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), total: sum('total') }
  })

  // Set a rate. Above ₹7,500 a night needs God Mode, because it would move the restaurant to 18% GST.
  app.put('/api/rates', async (req, reply: FastifyReply) => {
    const who = await caller(req)
    const b = req.body as { plan: string; roomTypeId: string; validFrom: string; validTo: string; amount: number }
    if (!b?.plan || !b.roomTypeId || !b.validFrom || !b.validTo || !(b.amount > 0)) {
      throw new HttpError(400, 'Send plan, roomTypeId, validFrom, validTo and amount (₹).')
    }
    const amount = rupees(b.amount)
    const guard = priceGuard(tax, amount)
    const entity = { type: 'rate', id: `${b.plan}/${b.roomTypeId}/${b.validFrom}` }
    if (!guard.allowed && !who.godMode) {
      await appendAudit(db, { actor: who, action: 'rate.blocked_by_guard', entity, after: { amount }, amount, note: guard.message ?? undefined })
      throw new HttpError(403, guard.message ?? 'Needs approval.', { requires: guard.requires })
    }
    const [plan] = await db.query<{ id: string }>('select id from rate_plan where code = $1', [b.plan])
    if (!plan) throw new HttpError(404, `No rate plan ${b.plan}.`)
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
      })
    })
    return reply.status(200).send({ ok: true, auditSeq: result.seq, aboveLimit: !guard.allowed })
  })

  app.get('/api/audit', async (req) => {
    requireGod(await caller(req))
    const q = req.query as { limit?: string; entityId?: string; actorId?: string }
    return readAudit(db, { limit: Math.min(Number(q.limit ?? 100), 1000), entityId: q.entityId, actorId: q.actorId })
  })

  app.get('/api/audit/verify', async (req) => {
    requireGod(await caller(req))
    return verifyStoredChain(db)
  })

  return app
}
