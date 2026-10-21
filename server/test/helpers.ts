import { buildApp } from '../src/app'
import { migrate, openPglite, type Db } from '../src/db'
import { ensureMdLogin } from '../src/password'
import { seed } from '../src/seed'
import { totpCode } from '../src/totp'

// A fresh in-memory resort with a signed-in MD, for API tests.

export async function testResort(today = '2026-11-01', opts: { taxDetails?: boolean; einvoice?: import('../src/einvoice').EInvoiceProvider; printAgentKey?: string; payments?: import('../src/channels').PaymentProvider; channelKey?: string } = {}) {
  const db: Db = await openPglite()
  await migrate(db)
  await seed(db, { today, mdMobile: '+919840000001' })
  await ensureMdLogin(db, { email: 'md@sathya.test', password: 'first-md-pass' })
  if (opts.taxDetails !== false) {
    await db.query(`update property set legal_name = 'Sathya Park Resorts Private Limited', gstin = '33AAACS1234A1Z9',
                      address = 'Sathya Resorts Road', city = 'Coimbatore', pin = '641001'`)
  }
  let clock = new Date(`${today}T09:00:00+05:30`).getTime()
  const app = buildApp(db, { now: () => new Date(clock), sms: { async sendOtp() {} }, einvoice: opts.einvoice, printAgentKey: opts.printAgentKey, payments: opts.payments, channelKey: opts.channelKey })

  const post = (url: string, token: string, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
  const get = (url: string, token: string) => app.inject({ url, headers: { authorization: `Bearer ${token}` } })

  async function signIn(email: string, password: string, deviceId?: string) {
    return app.inject({ method: 'POST', url: '/auth/login', payload: { email, password, deviceId } })
  }
  /** Signs in with a temporary password and sets the person's own, as the sign-in screen does. */
  async function firstSignIn(email: string, temp: string, deviceId?: string) {
    let r = (await signIn(email, temp, deviceId)).json()
    if (r.stage === 'device_pending') {   // accounts, HR, stores: the MD approves the device first
      await post(`/api/approvals/${r.approvalId}/decide`, md, { decision: 'approve' })
      r = (await signIn(email, temp, deviceId)).json()
    }
    if (r.stage === 'set_password') await post('/auth/password', r.token, { current: temp, next: `own-${temp}-pass` })
    if (r.stage === 'enroll_2fa') {   // only with sign_in.password_second_factor on
      const { secret } = (await post('/auth/totp/enroll', r.token)).json()
      await post('/auth/totp/confirm', r.token, { code: totpCode(secret, clock) })
    }
    return r.token as string
  }

  const md = await firstSignIn('md@sathya.test', 'first-md-pass')

  async function staff(name: string, mobile: string, roles: string[]) {
    const email = `${mobile.replace(/\D/g, '')}@sathya.test`
    const { tempPassword } = (await post('/api/users', md, { name, email, mobile, roles })).json()
    return firstSignIn(email, tempPassword, `test-device-${mobile}`)
  }

  return {
    db, app, md, post, get, staff, signIn,
    advance: (minutes: number) => { clock += minutes * 60_000 },
    now: () => clock,
    close: async () => { await app.close(); await db.close() },
  }
}
