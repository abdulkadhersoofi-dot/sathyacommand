import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { applyDiscount } from '../fo-core'
import { requireCaller } from './auth'

// The approval inbox. Each kind says who may decide it and what happens when it is approved.

export interface ApprovalKind {
  permission: string                 // '*' means God Mode only
  apply(t: Db, payload: Record<string, unknown>, decider: Caller, ctx: Ctx): Promise<void>
  /** Optional clean-up when the request is turned down. */
  reject?(t: Db, payload: Record<string, unknown>, decider: Caller, ctx: Ctx): Promise<void>
}

const KINDS: Record<string, ApprovalKind> = {
  'rate.above_limit': {
    permission: '*',
    async apply(t, p, decider) {
      await t.query(
        `insert into rate (rate_plan_id, room_type_id, valid_from, valid_to, amount_paise, approved_by) values ($1, $2, $3, $4, $5, $6)
         on conflict (rate_plan_id, room_type_id, valid_from) do update set valid_to = excluded.valid_to,
           amount_paise = excluded.amount_paise, approved_by = excluded.approved_by`,
        [p.planId, p.roomTypeId, p.validFrom, p.validTo, p.amount, decider.userId])
    },
  },
  'reservation.discount': {
    permission: 'discount.approve',
    async apply(t, p) {
      await applyDiscount(t, String(p.reservationId), Number(p.percent))
    },
  },
  'device.register': {
    permission: 'devices.approve',
    async apply(t, p, decider) {
      await t.query('update device set approved = true, approved_by = $2 where id = $1', [p.deviceId, decider.userId])
    },
  },
}

/** Modules add their own kinds (e.g. the restaurant's cancellations after KOT). */
export function registerApprovalKind(kind: string, k: ApprovalKind) { KINDS[kind] = k }

/** The highest of the caller's roles' limits for one key in roles-and-approvals.yaml (God Mode: no limit). */
export async function roleLimit(t: Db, who: Caller, key: string) {
  if (who.permissions.has('*')) return Infinity
  const rows = await t.query<{ limits: Record<string, unknown> }>('select limits from role where id = any($1)', [who.roles])
  return Math.max(0, ...rows.map((r) => Number(r.limits?.[key] ?? 0)))
}

export async function createApproval(ctx: Ctx, db: Db, kind: string, requestedBy: string, payload: Record<string, unknown>, reason?: string) {
  if (!KINDS[kind]) throw new Error(`Unknown approval kind ${kind}`)
  const [open] = await db.query<{ id: string }>(
    `select id from approval where kind = $1 and status = 'pending' and payload = $2::jsonb`, [kind, JSON.stringify(payload)])
  if (open) return open.id
  const id = randomUUID()
  await db.query('insert into approval (id, kind, requested_by, payload, reason, created_at) values ($1, $2, $3, $4, $5, $6)',
    [id, kind, requestedBy, JSON.stringify(payload), reason ?? null, ctx.now()])
  return id
}

const inr = (paise: unknown) => `₹${(Number(paise ?? 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const day = (d: unknown) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d ?? '') }
const PLAN: Record<string, string> = { EP: 'room only', CP: 'with breakfast', MAP: 'breakfast + 1 meal', AP: 'all meals' }

/** What the request is, in plain words, for the inbox. */
export function describeApproval(kind: string, p: Record<string, unknown>, by: string, reason: string | null): { title: string; detail: string } {
  const r = reason ?? ''
  switch (kind) {
    case 'device.register': return { title: `New device for ${by}`, detail: `${p.label ?? 'Unnamed browser'}. Approve only if ${by} is signing in on it now.` }
    case 'rate.above_limit': return { title: `Room rate ${inr(p.amount)} a night`, detail: `${p.roomTypeId} ${PLAN[String(p.plan)] ?? p.plan}, ${day(p.validFrom)} to ${day(p.validTo)}. ${r}` }
    case 'reservation.discount': return { title: `${p.percent}% discount on a room booking`, detail: `Booking ${p.reservationId}. ${r}` }
    case 'purchase.payment': return { title: `Vendor payment ${inr(p.net)} to ${p.vendor}`, detail: `${p.number}` }
    case 'purchase.po': return { title: `Purchase order ${p.number}: ${inr(p.total)}`, detail: r }
    case 'menu.price': return { title: `Menu price: ${p.item}`, detail: `${inr(p.from)} → ${inr(p.price)}` }
    case 'fnb.void_after_kot': return { title: `Cancel ${p.qty} × ${p.item} (${inr(p.amount)})`, detail: `Order ${p.order}, already sent to the kitchen. ${r}` }
    case 'fnb.discount': return { title: `${p.percent}% discount on restaurant order ${p.order}`, detail: `${p.outlet ?? ''}. ${r}` }
    case 'kitchen.wastage': return { title: `Kitchen wastage: ${p.ingredient}`, detail: r }
    case 'bar.breakage': return { title: `Bar breakage: ${p.ml} ml ${p.brand} (${inr(p.value)})`, detail: r }
    case 'bar.count': return { title: `Bar stock count: ${p.variancePercent}% difference`, detail: `${p.brands} brands counted` }
    case 'stock.count': return { title: `Store count ${p.number}: difference ${inr(p.net)}`, detail: r }
    case 'stock.month_close': return { title: `Store month close ${p.month}`, detail: r }
    case 'eng.spares': return { title: 'Spares for engineering', detail: r }
    case 'event.discount': return { title: `${p.percent}% discount on ${p.title}`, detail: `Event ${p.number}, quote ${inr(p.totalPaise)}` }
    default: return { title: kind, detail: r }
  }
}

const canDecide = (c: Caller, kind: string) => {
  const k = KINDS[kind]
  return !!k && (k.permission === '*' ? c.permissions.has('*') : can(c, k.permission))
}

export function approvalRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/approvals', async (req) => {
    const who = await requireCaller(ctx, req)
    const status = (req.query as { status?: string }).status ?? 'pending'
    const rows = await ctx.db.query<{ id: string; kind: string; requested_by: string }>(
      `select a.id, a.kind, a.status, a.payload, a.reason, a.requested_by, u.name as requested_by_name, a.created_at, a.decided_by, a.decided_at
         from approval a join app_user u on u.id = a.requested_by where a.status = $1 order by a.created_at`, [status])
    return rows.filter((a) => canDecide(who, a.kind) || a.requested_by === who.userId).map((a) => {
      const x = a as unknown as { payload: Record<string, unknown>; requested_by_name: string; reason: string | null }
      // A God Mode user may decide their own request; anyone else may not.
      const mayDecide = canDecide(who, a.kind) && (a.requested_by !== who.userId || who.permissions.has('*'))
      return { ...a, ...describeApproval(a.kind, x.payload, x.requested_by_name, x.reason), canDecide: mayDecide }
    })
  })

  app.post('/api/approvals/:id/decide', async (req) => {
    const who = await requireCaller(ctx, req)
    const { id } = req.params as { id: string }
    const b = req.body as { decision?: 'approve' | 'reject'; note?: string }
    if (b?.decision !== 'approve' && b?.decision !== 'reject') throw new HttpError(400, 'Send decision: approve or reject.')
    return ctx.db.tx(async (t) => {
      const [a] = await t.query<{ id: string; kind: string; status: string; requested_by: string; payload: Record<string, unknown> }>(
        'select * from approval where id = $1 for update', [id])
      if (!a) throw new HttpError(404, 'No such approval.')
      if (a.status !== 'pending') throw new HttpError(409, `Already ${a.status}.`)
      if (!canDecide(who, a.kind)) throw new HttpError(403, 'You cannot decide this approval.')
      if (a.requested_by === who.userId && !who.permissions.has('*')) throw new HttpError(403, 'You cannot approve your own request.')
      if (b.decision === 'approve') await KINDS[a.kind].apply(t, a.payload, who, ctx)
      else await KINDS[a.kind].reject?.(t, a.payload, who, ctx)
      const status = b.decision === 'approve' ? 'approved' : 'rejected'
      await t.query('update approval set status = $2, decided_by = $3, decided_at = $4 where id = $1', [id, status, who.userId, ctx.now()])
      await appendAudit(t, { actor: who, action: `approval.${status}`, entity: { type: 'approval', id },
        after: { kind: a.kind, payload: a.payload }, note: b.note }, ctx.now())
      return { ok: true, status }
    })
  })
}
