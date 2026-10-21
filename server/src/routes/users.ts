import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import { hashPassword, normaliseEmail, tempPassword, validEmail, weakPassword } from '../password'
import { normaliseMobile, requireCaller } from './auth'

// Staff logins: an email and a password (temporary until the person signs in and sets their own).
// HR and the GM can add staff, assign roles and reset passwords; only the MD can grant God Mode roles,
// touch a God Mode login, lock a user out, or unlock them.

export function userRoutes(app: FastifyInstance, ctx: Ctx) {
  async function checkRoles(roles: unknown, grantGod: boolean) {
    if (!Array.isArray(roles) || !roles.length) throw new HttpError(400, 'Give at least one role.')
    const rows = await ctx.db.query<{ id: string; god_mode: boolean }>('select id, god_mode from role where id = any($1)', [roles])
    const missing = roles.filter((r) => !rows.some((x) => x.id === r))
    if (missing.length) throw new HttpError(400, `Unknown role: ${missing.join(', ')}.`)
    if (rows.some((r) => r.god_mode) && !grantGod) throw new HttpError(403, 'Only the MD can give God Mode access.')
    return roles as string[]
  }
  const email = (e: unknown) => {
    const v = normaliseEmail(e)
    if (!validEmail(v)) throw new HttpError(400, 'Enter a valid email address.')
    return v
  }
  const mobile = (m: unknown) => (m == null || String(m).trim() === '' ? null : normaliseMobile(String(m)))
  /** The first password: the one given (if strong enough) or a made-up one; either way changed at first sign-in. */
  const firstPassword = (pw: unknown, mail: string) => {
    if (pw == null || pw === '') return tempPassword()
    const weak = weakPassword(String(pw), mail)
    if (weak) throw new HttpError(400, weak)
    return String(pw)
  }
  async function isGod(id: string) {
    return (await ctx.db.query('select 1 from user_role ur join role r on r.id = ur.role_id where ur.user_id = $1 and r.god_mode', [id])).length > 0
  }

  app.get('/api/roles', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'users.manage')) throw new HttpError(403, 'You cannot see roles.')
    return ctx.db.query('select id, god_mode from role order by god_mode desc, id')
  })

  app.get('/api/users', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'users.manage')) throw new HttpError(403, 'You cannot see staff logins.')
    const rows = await ctx.db.query<{ mobile: string | null }>(
      `select u.id, u.name, u.email, u.mobile, u.active, u.locked_reason, u.totp_enabled, u.access_until,
              u.password_hash is not null as has_password, u.must_change_password, u.locked_until,
              coalesce(array_agg(ur.role_id) filter (where ur.role_id is not null), '{}') as roles
         from app_user u left join user_role ur on ur.user_id = u.id where u.id <> 'system' group by u.id order by u.name`)
    const full = who.permissions.has('*')
    return rows.map((r) => ({ ...r, mobile: r.mobile && !full ? r.mobile.slice(0, 5) + '•••••' + r.mobile.slice(-3) : r.mobile }))
  })

  app.post('/api/users', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'users.manage')) throw new HttpError(403, 'You cannot add staff logins.')
    const b = req.body as { name?: string; email?: string; mobile?: string; password?: string; roles?: string[]; accessDays?: number }
    if (!b?.name?.trim()) throw new HttpError(400, 'Give the person\'s name.')
    const mail = email(b.email)
    const mob = mobile(b.mobile)
    const roles = await checkRoles(b.roles, who.permissions.has('*'))
    const password = firstPassword(b.password, mail)
    const hash = await hashPassword(password)
    return ctx.db.tx(async (t) => {
      if ((await t.query('select 1 from app_user where email = $1', [mail])).length) throw new HttpError(409, 'Someone already has a login with that email.')
      if (mob && (await t.query('select 1 from app_user where mobile = $1', [mob])).length) throw new HttpError(409, 'Someone already has a login with that mobile number.')
      const id = 'u-' + randomUUID().slice(0, 8)
      // The CA's login ends by itself (30 days unless set, at most 90): read-only access for the audit.
      const auditor = roles.includes('external_auditor')
      const days = auditor ? Math.min(90, Math.max(1, Number(b.accessDays ?? (ctx.roles.roles.external_auditor as { access_expires_days?: number } | undefined)?.access_expires_days ?? 30))) : null
      const until = days ? new Date(ctx.now().getTime() + days * 86_400_000) : null
      await t.query('insert into app_user (id, name, email, mobile, access_until, password_hash, must_change_password) values ($1, $2, $3, $4, $5, $6, true)',
        [id, b.name!.trim(), mail, mob, until, hash])
      for (const r of roles) await t.query('insert into user_role (user_id, role_id) values ($1, $2)', [id, r])
      await appendAudit(t, { actor: who, action: 'user.create', entity: { type: 'user', id }, after: { name: b.name, email: mail, roles, accessUntil: until } }, ctx.now())
      // The temporary password is shown once, to hand over; only its hash is kept.
      return reply.status(201).send({ id, accessUntil: until, tempPassword: password })
    })
  })

  app.patch('/api/users/:id', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'users.manage')) throw new HttpError(403, 'You cannot change logins.')
    const { id } = req.params as { id: string }
    if (await isGod(id) && !who.permissions.has('*') && id !== who.userId) throw new HttpError(403, 'Only the MD can change a God Mode login.')
    const b = (req.body ?? {}) as { name?: string; email?: string; mobile?: string | null }
    const [u] = await ctx.db.query<{ name: string; email: string | null; mobile: string | null }>('select name, email, mobile from app_user where id = $1', [id])
    if (!u) throw new HttpError(404, 'No such user.')
    const next = { name: b.name !== undefined ? String(b.name).trim() : u.name, email: b.email !== undefined ? email(b.email) : u.email, mobile: b.mobile !== undefined ? mobile(b.mobile) : u.mobile }
    if (!next.name) throw new HttpError(400, 'Give the person\'s name.')
    if (next.email && (await ctx.db.query('select 1 from app_user where email = $1 and id <> $2', [next.email, id])).length) throw new HttpError(409, 'Someone already has a login with that email.')
    if (next.mobile && (await ctx.db.query('select 1 from app_user where mobile = $1 and id <> $2', [next.mobile, id])).length) throw new HttpError(409, 'Someone already has a login with that mobile number.')
    await ctx.db.query('update app_user set name = $2, email = $3, mobile = $4 where id = $1', [id, next.name, next.email, next.mobile])
    await appendAudit(ctx.db, { actor: who, action: 'user.update', entity: { type: 'user', id }, before: u, after: next }, ctx.now())
    return { id, ...next }
  })

  /** A new temporary password for someone who forgot theirs: their sessions end and the lock-out clears. */
  app.post('/api/users/:id/reset-password', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'users.manage')) throw new HttpError(403, 'You cannot reset passwords.')
    const { id } = req.params as { id: string }
    if (id === who.userId) throw new HttpError(400, 'Change your own password from your login instead.')
    if (await isGod(id) && !who.permissions.has('*')) throw new HttpError(403, 'Only the MD can reset a God Mode login.')
    const [u] = await ctx.db.query<{ email: string | null }>('select email from app_user where id = $1', [id])
    if (!u) throw new HttpError(404, 'No such user.')
    if (!u.email) throw new HttpError(400, 'Give this login an email first.')
    const password = firstPassword((req.body as { password?: string } | null)?.password, u.email)
    await ctx.db.query('update app_user set password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = null where id = $1', [id, await hashPassword(password)])
    const ended = await ctx.db.query('update user_session set revoked_at = $2 where user_id = $1 and revoked_at is null returning id', [id, ctx.now()])
    await appendAudit(ctx.db, { actor: who, action: 'user.password_reset', entity: { type: 'user', id }, after: { sessionsEnded: ended.length } }, ctx.now())
    return { id, tempPassword: password }
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

  // Extending (or ending) a time-limited login, such as the CA's.
  app.put('/api/users/:id/access', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'users.manage')) throw new HttpError(403, 'You cannot change logins.')
    const { id } = req.params as { id: string }
    const days = Number((req.body as { days?: number } | null)?.days)
    if (!(days >= 0 && days <= 90)) throw new HttpError(400, 'Days from today: 0 (ends now) to 90.')
    const until = new Date(ctx.now().getTime() + days * 86_400_000)
    const [u] = await ctx.db.query<{ id: string }>('update app_user set access_until = $2 where id = $1 and access_until is not null returning id', [id, until])
    if (!u) throw new HttpError(404, 'No time-limited login with that id.')
    await appendAudit(ctx.db, { actor: who, action: 'user.access', entity: { type: 'user', id }, after: { accessUntil: until } }, ctx.now())
    return { id, accessUntil: until }
  })
}
