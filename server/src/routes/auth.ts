import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { appendAudit } from '../audit-store'
import { HttpError, type Caller, type Ctx } from '../context'
import { hashPassword, normaliseEmail, verifyPassword, weakPassword } from '../password'
import { newTotpSecret, otpauthUrl, verifyTotp } from '../totp'
import { createApproval } from './approvals'

// Sign-in: email and password → (new device approval) → a new password if the one given was temporary → session.
// SMS codes (with the authenticator app for owner roles) are kept for later, behind sign_in.mobile_otp.

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const OTP_MINUTES = 5
const MAX_ATTEMPTS = 5
const MAX_OTPS_PER_15_MIN = 5
const MAX_WRONG_PASSWORDS = 5
const LOCK_MINUTES = 15
const ANON = { userId: 'anonymous', name: 'Unknown', role: 'none' }

export const normaliseMobile = (m: string) => {
  const digits = String(m ?? '').replace(/\D/g, '')
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits
  if (!/^[6-9]\d{9}$/.test(local)) throw new HttpError(400, 'Enter a 10-digit Indian mobile number.')
  return '+91' + local
}

interface UserRow { id: string; name: string; totp_enabled: boolean; totp_secret: string | null; roles: string[]; god: boolean }

async function loadUser(ctx: Ctx, where: string, param: string): Promise<UserRow | undefined> {
  const [u] = await ctx.db.query<UserRow>(
    `select u.id, u.name, u.totp_enabled, u.totp_secret,
            coalesce(array_agg(ur.role_id) filter (where ur.role_id is not null), '{}') as roles,
            coalesce(bool_or(r.god_mode), false) as god
       from app_user u left join user_role ur on ur.user_id = u.id left join role r on r.id = ur.role_id
      where ${where} and u.active and (u.access_until is null or u.access_until > now()) group by u.id`, [param])
  return u
}

function idleMinutes(ctx: Ctx, u: UserRow) {
  const t = ctx.roles.sign_in.session_timeout_minutes
  if (u.god) return t.god_mode
  if (u.roles.some((r) => ['accounts', 'hr_payroll', 'stores'].includes(r))) return t.back_office
  return t.operations
}

type Scope = 'full' | 'enroll_2fa' | 'set_password'

async function issueSession(ctx: Ctx, u: UserRow, deviceId: string | null, scope: Scope) {
  const token = randomBytes(32).toString('base64url')
  const idle = idleMinutes(ctx, u)
  await ctx.db.query(
    `insert into user_session (id, token_hash, user_id, device_id, scope, idle_minutes, expires_at) values ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), sha(token), u.id, deviceId, scope, idle, new Date(ctx.now().getTime() + idle * 60_000)],
  )
  await appendAudit(ctx.db, { actor: { userId: u.id, name: u.name, role: u.roles[0] ?? 'none', deviceId: deviceId ?? undefined },
    action: 'auth.sign_in', entity: { type: 'user', id: u.id }, after: { scope } }, ctx.now())
  return { token, user: { id: u.id, name: u.name, roles: u.roles, godMode: u.god }, idleMinutes: idle }
}

/** Resolves the signed-in caller from `Authorization: Bearer <token>` and slides the session expiry. */
export async function requireCaller(ctx: Ctx, req: FastifyRequest, opts: { allowEnroll?: boolean } = {}): Promise<Caller> {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) throw new HttpError(401, 'Sign in first.')
  const [s] = await ctx.db.query<{ id: string; user_id: string; device_id: string | null; scope: Scope; idle_minutes: number }>(
    `select s.id, s.user_id, s.device_id, s.scope, s.idle_minutes from user_session s join app_user u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2 and u.active and (u.access_until is null or u.access_until > $2)`, [sha(token), ctx.now()])
  if (!s) throw new HttpError(401, 'Your session has ended. Sign in again.')
  if (s.scope === 'enroll_2fa' && !opts.allowEnroll) throw new HttpError(403, 'Set up your authenticator app to continue.', { stage: 'enroll_2fa' })
  if (s.scope === 'set_password' && !opts.allowEnroll) throw new HttpError(403, 'Set a new password to continue.', { stage: 'set_password' })
  await ctx.db.query('update user_session set expires_at = $2 where id = $1', [s.id, new Date(ctx.now().getTime() + s.idle_minutes * 60_000)])
  const [u] = await ctx.db.query<{ name: string; roles: string[]; god: boolean; perms: string[] }>(
    `select u.name, coalesce(array_agg(distinct r.id) filter (where r.id is not null), '{}') as roles, coalesce(bool_or(r.god_mode), false) as god,
            coalesce(array_agg(distinct p) filter (where p is not null), '{}') as perms
       from app_user u left join user_role ur on ur.user_id = u.id left join role r on r.id = ur.role_id
       left join lateral unnest(r.permissions) p on true
      where u.id = $1 group by u.id`, [s.user_id])
  return {
    userId: s.user_id, name: u.name, role: u.roles[0] ?? 'none', deviceId: s.device_id ?? undefined,
    roles: u.roles, godMode: u.god, permissions: new Set(u.perms), sessionId: s.id, scope: s.scope,
  }
}

/** Back-office roles may only sign in from a device the MD or GM has approved. Returns the refusal, if any. */
async function checkDevice(ctx: Ctx, u: UserRow, deviceId: string | null, label?: string) {
  if (!u.roles.some((r) => ctx.roles.sign_in.device_registration_required.includes(r))) return null
  if (!deviceId) throw new HttpError(400, 'This login needs a registered device.')
  const [d] = await ctx.db.query<{ approved: boolean; user_id: string }>('select approved, user_id from device where id = $1', [deviceId])
  if (!d) {
    await ctx.db.query('insert into device (id, user_id, label) values ($1, $2, $3)', [deviceId, u.id, label ?? null])
    const approvalId = await createApproval(ctx, ctx.db, 'device.register', u.id, { deviceId, userId: u.id, label: label ?? null })
    await appendAudit(ctx.db, { actor: { userId: u.id, name: u.name, role: u.roles[0], deviceId },
      action: 'device.approval_requested', entity: { type: 'device', id: deviceId } }, ctx.now())
    return { error: 'This device needs approval from the MD or GM before you can sign in.', stage: 'device_pending', approvalId }
  }
  if (d.user_id !== u.id || !d.approved) return { error: 'This device is waiting for approval from the MD or GM.', stage: 'device_pending' }
  await ctx.db.query('update device set last_seen = $2 where id = $1', [deviceId, ctx.now()])
  return null
}

/** The authenticator step, or a session. `second` is off for password sign-ins unless sign_in.password_second_factor is on. */
async function finishSignIn(ctx: Ctx, u: UserRow, deviceId: string | null, opts: { second: boolean; setPassword?: boolean }) {
  const needs2fa = opts.second && (u.god || u.roles.some((r) => ctx.roles.sign_in.second_factor_required.includes(r)))
  if (needs2fa && u.totp_enabled) {
    const id = randomUUID()
    await ctx.db.query('insert into login_challenge (id, user_id, device_id, expires_at) values ($1, $2, $3, $4)',
      [id, u.id, deviceId, new Date(ctx.now().getTime() + OTP_MINUTES * 60_000)])
    return { stage: 'second_factor', loginChallengeId: id }
  }
  const scope: Scope = opts.setPassword ? 'set_password' : needs2fa ? 'enroll_2fa' : 'full'
  const session = await issueSession(ctx, u, deviceId, scope)
  return { stage: scope === 'full' ? 'done' : scope, ...session }
}

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/auth/login', async (req, reply) => {
    const b = req.body as { email?: string; password?: string; deviceId?: string; deviceLabel?: string }
    const email = normaliseEmail(b?.email)
    const password = String(b?.password ?? '')
    if (!email || !password) throw new HttpError(400, 'Enter your email and password.')
    const [row] = await ctx.db.query<{ id: string; password_hash: string | null; failed_logins: number; locked_until: Date | null; must_change_password: boolean }>(
      'select id, password_hash, failed_logins, locked_until, must_change_password from app_user where email = $1', [email])
    if (row?.locked_until && new Date(row.locked_until) > ctx.now()) {
      const mins = Math.ceil((new Date(row.locked_until).getTime() - ctx.now().getTime()) / 60_000)
      throw new HttpError(429, `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or ask the MD or GM to reset it.`)
    }
    const ok = await verifyPassword(password, row?.password_hash ?? null)
    const u = ok && row ? await loadUser(ctx, 'u.id = $1', row.id) : undefined
    if (!u) {
      if (row) {
        const lock = row.failed_logins + 1 >= MAX_WRONG_PASSWORDS
        await ctx.db.query('update app_user set failed_logins = $2, locked_until = $3 where id = $1',
          [row.id, lock ? 0 : row.failed_logins + 1, lock ? new Date(ctx.now().getTime() + LOCK_MINUTES * 60_000) : null])
      }
      await appendAudit(ctx.db, { actor: ANON, action: 'auth.sign_in_failed', entity: { type: 'email', id: email } }, ctx.now())
      throw new HttpError(401, 'That email or password is wrong.')
    }
    await ctx.db.query('update app_user set failed_logins = 0, locked_until = null where id = $1', [u.id])
    const deviceId = b.deviceId ?? null
    const pending = await checkDevice(ctx, u, deviceId, b.deviceLabel)
    if (pending) return reply.status(403).send(pending)
    return finishSignIn(ctx, u, deviceId, { second: !!ctx.roles.sign_in.password_second_factor, setPassword: row!.must_change_password })
  })

  /** Changing one's own password; also the step after signing in with a temporary one. Other sessions are ended. */
  app.post('/auth/password', async (req) => {
    const who = await requireCaller(ctx, req, { allowEnroll: true })
    if (who.scope === 'enroll_2fa') throw new HttpError(403, 'Set up your authenticator app to continue.', { stage: 'enroll_2fa' })
    const b = req.body as { current?: string; next?: string }
    const [u] = await ctx.db.query<{ email: string | null; password_hash: string | null }>('select email, password_hash from app_user where id = $1', [who.userId])
    if (!(await verifyPassword(String(b?.current ?? ''), u?.password_hash ?? null))) throw new HttpError(400, 'Your current password is wrong.')
    const next = String(b?.next ?? '')
    const weak = weakPassword(next, u.email)
    if (weak) throw new HttpError(400, weak)
    if (next === b.current) throw new HttpError(400, 'Choose a password different from the current one.')
    await ctx.db.query('update app_user set password_hash = $2, must_change_password = false where id = $1', [who.userId, await hashPassword(next)])
    await ctx.db.query('update user_session set revoked_at = $3 where user_id = $1 and id <> $2 and revoked_at is null', [who.userId, who.sessionId, ctx.now()])
    await ctx.db.query(`update user_session set scope = 'full' where id = $1 and scope = 'set_password'`, [who.sessionId])
    await appendAudit(ctx.db, { actor: who, action: 'auth.password_changed', entity: { type: 'user', id: who.userId } }, ctx.now())
    return { ok: true }
  })

  // SMS codes: off until an SMS provider is set up (sign_in.mobile_otp).
  const otpOn = () => { if (!ctx.roles.sign_in.mobile_otp) throw new HttpError(404, 'Sign-in by SMS code is not switched on. Use your email and password.') }

  app.post('/auth/otp', async (req) => {
    otpOn()
    const mobile = normaliseMobile((req.body as { mobile?: string })?.mobile ?? '')
    const since = new Date(ctx.now().getTime() - 15 * 60_000)
    const [{ n }] = await ctx.db.query<{ n: number }>('select count(*)::int n from otp_challenge where mobile = $1 and created_at > $2', [mobile, since])
    if (n >= MAX_OTPS_PER_15_MIN) throw new HttpError(429, 'Too many codes requested. Try again in 15 minutes.')
    const id = randomUUID()
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    await ctx.db.query('insert into otp_challenge (id, mobile, code_hash, expires_at, created_at) values ($1, $2, $3, $4, $5)',
      [id, mobile, sha(id + code), new Date(ctx.now().getTime() + OTP_MINUTES * 60_000), ctx.now()])
    // Unknown numbers get the same answer but no SMS, so the endpoint can't be used to find staff numbers.
    if (await loadUser(ctx, 'u.mobile = $1', mobile)) await ctx.sms.sendOtp(mobile, code)
    return { challengeId: id, expiresInMinutes: OTP_MINUTES }
  })

  app.post('/auth/otp/verify', async (req, reply) => {
    otpOn()
    const b = req.body as { challengeId?: string; code?: string; deviceId?: string; deviceLabel?: string }
    const [c] = await ctx.db.query<{ id: string; mobile: string; code_hash: string; expires_at: Date; attempts: number; used: boolean }>(
      'select * from otp_challenge where id = $1', [b?.challengeId ?? ''])
    const fail = async (msg = 'That code is wrong or has expired.') => {
      await appendAudit(ctx.db, { actor: ANON, action: 'auth.sign_in_failed', entity: { type: 'mobile', id: c?.mobile ?? 'unknown' } }, ctx.now())
      throw new HttpError(401, msg)
    }
    if (!c || c.used || new Date(c.expires_at) < ctx.now() || c.attempts >= MAX_ATTEMPTS) return fail()
    await ctx.db.query('update otp_challenge set attempts = attempts + 1 where id = $1', [c.id])
    if (sha(c.id + String(b.code ?? '')) !== c.code_hash) return fail()
    await ctx.db.query('update otp_challenge set used = true where id = $1', [c.id])
    const u = await loadUser(ctx, 'u.mobile = $1', c.mobile)
    if (!u) return fail()

    const deviceId = b.deviceId ?? null
    const pending = await checkDevice(ctx, u, deviceId, b.deviceLabel)
    if (pending) return reply.status(403).send(pending)

    return finishSignIn(ctx, u, deviceId, { second: true })
  })

  app.post('/auth/second-factor', async (req) => {
    const b = req.body as { loginChallengeId?: string; code?: string }
    const [c] = await ctx.db.query<{ id: string; user_id: string; device_id: string | null; expires_at: Date; attempts: number; used: boolean }>(
      'select * from login_challenge where id = $1', [b?.loginChallengeId ?? ''])
    if (!c || c.used || new Date(c.expires_at) < ctx.now() || c.attempts >= MAX_ATTEMPTS) throw new HttpError(401, 'Sign-in timed out. Start again.')
    await ctx.db.query('update login_challenge set attempts = attempts + 1 where id = $1', [c.id])
    const u = await loadUser(ctx, 'u.id = $1', c.user_id)
    if (!u?.totp_secret || !verifyTotp(u.totp_secret, String(b.code ?? ''), ctx.now().getTime())) {
      await appendAudit(ctx.db, { actor: ANON, action: 'auth.second_factor_failed', entity: { type: 'user', id: c.user_id } }, ctx.now())
      throw new HttpError(401, 'That authenticator code is wrong.')
    }
    await ctx.db.query('update login_challenge set used = true where id = $1', [c.id])
    const [{ must }] = await ctx.db.query<{ must: boolean }>('select must_change_password as must from app_user where id = $1', [u.id])
    const scope = must ? 'set_password' : 'full'
    return { stage: must ? scope : 'done', ...(await issueSession(ctx, u, c.device_id, scope)) }
  })

  app.post('/auth/totp/enroll', async (req) => {
    const who = await requireCaller(ctx, req, { allowEnroll: true })
    const secret = newTotpSecret()
    await ctx.db.query('update app_user set totp_secret = $2, totp_enabled = false where id = $1', [who.userId, secret])
    return { secret, otpauthUrl: otpauthUrl(secret, who.name) }
  })

  app.post('/auth/totp/confirm', async (req) => {
    const who = await requireCaller(ctx, req, { allowEnroll: true })
    const [u] = await ctx.db.query<{ totp_secret: string | null }>('select totp_secret from app_user where id = $1', [who.userId])
    const code = String((req.body as { code?: string })?.code ?? '')
    if (!u?.totp_secret || !verifyTotp(u.totp_secret, code, ctx.now().getTime())) throw new HttpError(400, 'That code does not match. Check the time on your phone and try again.')
    await ctx.db.query('update app_user set totp_enabled = true where id = $1', [who.userId])
    await ctx.db.query(`update user_session set scope = 'full' where id = $1`, [who.sessionId])
    await appendAudit(ctx.db, { actor: who, action: 'auth.totp_enabled', entity: { type: 'user', id: who.userId } }, ctx.now())
    return { ok: true }
  })

  app.post('/auth/sign-out', async (req) => {
    const who = await requireCaller(ctx, req, { allowEnroll: true })
    await ctx.db.query('update user_session set revoked_at = $2 where id = $1', [who.sessionId, ctx.now()])
    await appendAudit(ctx.db, { actor: who, action: 'auth.sign_out', entity: { type: 'user', id: who.userId } }, ctx.now())
    return { ok: true }
  })

  app.get('/auth/me', async (req) => {
    const who = await requireCaller(ctx, req, { allowEnroll: true })
    return { id: who.userId, name: who.name, roles: who.roles, godMode: who.godMode, permissions: [...who.permissions], scope: who.scope }
  })
}
