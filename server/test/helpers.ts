import { buildApp } from '../src/app'
import { migrate, openPglite, type Db } from '../src/db'
import { normaliseMobile } from '../src/routes/auth'
import { seed } from '../src/seed'
import { totpCode } from '../src/totp'

// A fresh in-memory resort with a signed-in MD, for API tests.

export async function testResort(today = '2026-11-01', opts: { taxDetails?: boolean; einvoice?: import('../src/einvoice').EInvoiceProvider; printAgentKey?: string } = {}) {
  const db: Db = await openPglite()
  await migrate(db)
  await seed(db, { today, mdMobile: '+919840000001' })
  if (opts.taxDetails !== false) {
    await db.query(`update property set legal_name = 'Sathya Park Resorts Private Limited', gstin = '33AAACS1234A1Z9',
                      address = 'Sathya Resorts Road', city = 'Coimbatore', pin = '641001'`)
  }
  let clock = new Date(`${today}T09:00:00+05:30`).getTime()
  const sms: Record<string, string> = {}
  const app = buildApp(db, { now: () => new Date(clock), sms: { async sendOtp(m, c) { sms[m] = c } }, einvoice: opts.einvoice, printAgentKey: opts.printAgentKey })

  const post = (url: string, token: string, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
  const get = (url: string, token: string) => app.inject({ url, headers: { authorization: `Bearer ${token}` } })

  async function signIn(mobile: string, deviceId?: string) {
    const { challengeId } = (await app.inject({ method: 'POST', url: '/auth/otp', payload: { mobile } })).json()
    return app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { challengeId, code: sms[normaliseMobile(mobile)], deviceId } })
  }

  // MD: first sign-in enrols the authenticator, which leaves a full session.
  const first = (await signIn('9840000001')).json()
  const { secret } = (await post('/auth/totp/enroll', first.token)).json()
  await post('/auth/totp/confirm', first.token, { code: totpCode(secret, clock) })
  const md = first.token as string

  async function staff(name: string, mobile: string, roles: string[]) {
    await post('/api/users', md, { name, mobile, roles })
    const deviceId = `test-device-${mobile}`
    let r = (await signIn(mobile, deviceId)).json()
    if (r.stage === 'device_pending') {   // accounts, HR, stores: the MD approves the device first
      await post(`/api/approvals/${r.approvalId}/decide`, md, { decision: 'approve' })
      r = (await signIn(mobile, deviceId)).json()
    }
    if (r.stage === 'enroll_2fa') {   // GM, accounts, HR: set up the authenticator on first sign-in
      const { secret } = (await post('/auth/totp/enroll', r.token)).json()
      await post('/auth/totp/confirm', r.token, { code: totpCode(secret, clock) })
    }
    return r.token as string
  }

  return {
    db, app, md, post, get, staff,
    advance: (minutes: number) => { clock += minutes * 60_000 },
    now: () => clock,
    close: async () => { await app.close(); await db.close() },
  }
}
