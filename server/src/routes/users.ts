import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import { normaliseMobile, requireCaller } from './auth'

// Staff logins. HR and the GM can add staff and assign roles; only the MD can grant
// God Mode roles, lock a user out, or unlock them.

export function userRoutes(app: FastifyInstance, ctx: Ctx) {
  async function checkRoles(roles: unknown, grantGod: boolean) {
    if (!Array.isArray(roles) || !roles.length) throw new HttpError(400, 'Give at least one role.')
    const rows = await ctx.db.query<{ id: string; god_mode: boolean }>('select id, god_mode from role where id = any($1)', [roles])
    const missing = roles.filter((r) => !rows.some((x) => x.id === r))
    if (missing.length) throw new HttpError(400, `Unknown role: ${missing.join(', ')}.`)
    if (rows.some((r) => r.god_mode) && !grantGod) throw new HttpError(403, 'Only the MD can give God Mode access.')
    return roles as string[]
  }

  app.get('/api/users', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'users.manage')) throw new HttpError(403, 'You cannot see staff logins.')
    const rows = await ctx.db.query<{ mobile: string | null }>(
      `select u.id, u.name, u.mobile, u.active, u.locked_reason, u.totp_enabled,
              coalesce(array_agg(ur.role_id) filter (where ur.role_id is not null), '{}') as roles
         from app_user u left join user_role ur on ur.user_id = u.id group by u.id order by u.name`)
    const full = who.permissions.has('*')
    return rows.map((r) => ({ ...r, mobile: r.mobile && !full ? r.mobile.slice(0, 5) + '•••••' + r.mobile.slice(-3) : r.mobile }))
  })

  app.post('/api/users', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'users.manage')) throw new HttpError(403, 'You cannot add staff logins.')
    const b = req.body as { name?: string; mobile?: string; roles?: string[] }
    if (!b?.name?.trim()) throw new HttpError(400, 'Give the person\'s name.')
    const mobile = normaliseMobile(b.mobile ?? '')
    const roles = await checkRoles(b.roles, who.permissions.has('*'))
    return ctx.db.tx(async (t) => {
      const [dup] = await t.query('select 1 from app_user where mobile = $1', [mobile])
      if (dup) throw new HttpError(409, 'Someone already has a login with that mobile number.')
      const id = 'u-' + randomUUID().slice(0, 8)
      await t.query('insert into app_user (id, name, mobile) values ($1, $2, $3)', [id, b.name!.trim(), mobile])
      for (const r of roles) await t.query('insert into user_role (user_id, role_id) values ($1, $2)', [id, r])
      await appendAudit(t, { actor: who, action: 'user.create', entity: { type: 'user', id }, after: { name: b.name, roles } }, ctx.now())
      return reply.status(201).send({ id })
    })
  })

  app.put('/api/users/:id/roles', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'users.manage')) throw new HttpError(403, 'You cannot change roles.')
    const { id } = req.params as { id: string }
    if (id === who.userId) throw new HttpError(403, 'You cannot change your own roles.')
    const roles = await checkRoles((req.body as { roles?: string[] })?.roles, who.permissions.has('*'))
    return ctx.db.tx(async (t) => {
      const before = (await t.query<{ role_id: string }>('select role_id from user_role where user_id = $1', [id])).map((r) => r.role_id)
      if (!before.length && !(await t.query('select 1 from app_user where id = $1', [id])).length) throw new HttpError(404, 'No such user.')
      const godBefore = (await t.query('select 1 from role where god_mode and id = any($1)', [before])).length > 0
      if (godBefore && !who.permissions.has('*')) throw new HttpError(403, 'Only the MD can change a God Mode user.')
      await t.query('delete from user_role where user_id = $1', [id])
      for (const r of roles) await t.query('insert into user_role (user_id, role_id) values ($1, $2)', [id, r])
      await appendAudit(t, { actor: who, action: 'user.roles_changed', entity: { type: 'user', id }, before, after: roles }, ctx.now())
      return { id, roles }
    })
  })

  app.post('/api/users/:id/lock', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!who.permissions.has('*')) throw new HttpError(403, 'Only the MD can lock a user.')
    const { id } = req.params as { id: string }
    if (id === who.userId) throw new HttpError(400, 'You cannot lock yourself out.')
    const reason = (req.body as { reason?: string })?.reason ?? null
    return ctx.db.tx(async (t) => {
      const res = await t.query('update app_user set active = false, locked_reason = $2 where id = $1 returning id', [id, reason])
      if (!res.length) throw new HttpError(404, 'No such user.')
      const ended = await t.query('update user_session set revoked_at = $2 where user_id = $1 and revoked_at is null returning id', [id, ctx.now()])
      await appendAudit(t, { actor: who, action: 'user.lock', entity: { type: 'user', id }, after: { reason, sessionsEnded: ended.length } }, ctx.now())
      return { ok: true, sessionsEnded: ended.length }
    })
  })

  app.post('/api/users/:id/unlock', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!who.permissions.has('*')) throw new HttpError(403, 'Only the MD can unlock a user.')
    const { id } = req.params as { id: string }
    const res = await ctx.db.query('update app_user set active = true, locked_reason = null where id = $1 returning id', [id])
    if (!res.length) throw new HttpError(404, 'No such user.')
    await appendAudit(ctx.db, { actor: who, action: 'user.unlock', entity: { type: 'user', id } }, ctx.now())
    return { ok: true }
  })
}
