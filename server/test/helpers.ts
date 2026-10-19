import { buildApp } from '../src/app'
import { migrate, openPglite, type Db } from '../src/db'
import { normaliseMobile } from '../src/routes/auth'
import { seed } from '../src/seed'
import { totpCode } from '../src/totp'

// A fresh in-memory resort with a signed-in MD, for API tests.

export async function testResort(today = '2026-11-01') {
  const db: Db = await openPglite()
  await migrate(db)
  await seed(db, { today, mdMobile: '+919840000001' })
  let clock = new Date(`${today}T09:00:00+05:30`).getTime()
  const sms: Record<string, string> = {}
  const app = buildApp(db, { now: () => new Date(clock), sms: { async sendOtp(m, c) { sms[m] = c } } })

  const post = (url: string, token: string, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
  const get = (url: string, token: string) => app.inject({ url, headers: { authorization: `Bearer ${token}` } })

  async function signIn(mobile: string) {
    const { challengeId } = (await app.inject({ method: 'POST', url: '/auth/otp', payload: { mobile } })).json()
    return app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { challengeId, code: sms[normaliseMobile(mobile)] } })
  }

  // MD: first sign-in enrols the authenticator, which leaves a full session.
  const first = (await signIn('9840000001')).json()
  const { secret } = (await post('/auth/totp/enroll', first.token)).json()
  await post('/auth/totp/confirm', first.token, { code: totpCode(secret, clock) })
  const md = first.token as string

  async function staff(name: string, mobile: string, roles: string[]) {
    await post('/api/users', md, { name, mobile, roles })
    return (await signIn(mobile)).json().token as string
  }

  return {
    db, app, md, post, get, staff,
    advance: (minutes: number) => { clock += minutes * 60_000 },
    now: () => clock,
    close: async () => { await app.close(); await db.close() },
  }
}
