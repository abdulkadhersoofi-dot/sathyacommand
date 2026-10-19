import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { requireCaller } from './auth'

// The approval inbox. Each kind says who may decide it and what happens when it is approved.

interface Kind {
  permission: string                 // '*' means God Mode only
  apply(t: Db, payload: Record<string, unknown>, decider: Caller): Promise<void>
}

const KINDS: Record<string, Kind> = {
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
  'device.register': {
    permission: 'devices.approve',
    async apply(t, p, decider) {
      await t.query('update device set approved = true, approved_by = $2 where id = $1', [p.deviceId, decider.userId])
    },
  },
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
    return rows.filter((a) => canDecide(who, a.kind) || a.requested_by === who.userId)
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
      if (b.decision === 'approve') await KINDS[a.kind].apply(t, a.payload, who)
      const status = b.decision === 'approve' ? 'approved' : 'rejected'
      await t.query('update approval set status = $2, decided_by = $3, decided_at = $4 where id = $1', [id, status, who.userId, ctx.now()])
      await appendAudit(t, { actor: who, action: `approval.${status}`, entity: { type: 'approval', id },
        after: { kind: a.kind, payload: a.payload }, note: b.note }, ctx.now())
      return { ok: true, status }
    })
  })
}
