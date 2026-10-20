import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { loadRolesConfig } from '../src/context'
import { migrate, openPglite, type Db } from '../src/db'
import { seed } from '../src/seed'
import { totpCode } from '../src/totp'
import { normaliseMobile } from '../src/routes/auth'

// Runs against a real Postgres engine (PGlite, in memory) with the real migrations, seed and roles file,
// with sign-in by SMS code switched on (email and password sign-in is in passwords.test.ts).

let db: Db
let app: ReturnType<typeof buildApp>
let clock = new Date('2026-11-01T09:00:00+05:30').getTime()
const sms: Record<string, string> = {}
const MD_MOBILE = '+919840000001'
let MD = ''          // bearer tokens
let FD = ''
let mdSecret = ''

const advance = (minutes: number) => { clock += minutes * 60_000 }
const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function requestCode(mobile: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/otp', payload: { mobile } })
  return res.json().challengeId as string
}

async function signIn(mobile: string, extra: Record<string, string> = {}) {
  const challengeId = await requestCode(mobile)
  return app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { challengeId, code: sms[normaliseMobile(mobile)], ...extra } })
}

beforeAll(async () => {
  db = await openPglite()
  await migrate(db)
  await seed(db, { today: '2026-11-01', mdMobile: MD_MOBILE })
  app = buildApp(db, {
    now: () => new Date(clock),
    sms: { async sendOtp(mobile, code) { sms[mobile] = code } },
    roles: (() => { const r = loadRolesConfig(); r.sign_in.mobile_otp = true; return r })(),
  })
}, 30_000)

afterAll(async () => { await app.close(); await db.close() })

describe('database set-up', () => {
  it('applies migrations once', async () => {
    expect(await migrate(db)).toEqual([])
  })

  it('seeds 47 sellable rooms, all flagged as placeholders', async () => {
    const [r] = await db.query<{ n: number; p: number }>('select count(*)::int n, count(*) filter (where placeholder)::int p from space where sellable')
    expect(r).toEqual({ n: 47, p: 47 })
  })

  it('does not seed twice', async () => {
    expect(await seed(db)).toEqual({ seeded: false })
  })
})

describe('sign-in', () => {
  it('answers unknown numbers the same way but sends no SMS', async () => {
    const id = await requestCode('9000000009')
    expect(id).toBeTruthy()
    expect(sms['+919000000009']).toBeUndefined()
  })

  it('takes the MD through authenticator set-up on first sign-in', async () => {
    const res = await signIn('98400 00001')
    expect(res.json(), res.body).toMatchObject({ stage: 'enroll_2fa' })
    const token = res.json().token
    const blocked = await app.inject({ url: '/api/spaces', headers: auth(token) })
    expect(blocked.statusCode).toBe(403)
    const enroll = await app.inject({ method: 'POST', url: '/auth/totp/enroll', headers: auth(token) })
    mdSecret = enroll.json().secret
    expect(enroll.json().otpauthUrl).toMatch(/^otpauth:\/\/totp\//)
    const bad = await app.inject({ method: 'POST', url: '/auth/totp/confirm', headers: auth(token), payload: { code: '000000' } })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({ method: 'POST', url: '/auth/totp/confirm', headers: auth(token), payload: { code: totpCode(mdSecret, clock) } })
    expect(ok.json()).toEqual({ ok: true })
    expect((await app.inject({ url: '/api/spaces', headers: auth(token) })).statusCode).toBe(200)
  })

  it('asks the MD for the authenticator code on later sign-ins', async () => {
    advance(1)
    const first = await signIn(MD_MOBILE)
    expect(first.json().stage).toBe('second_factor')
    const wrong = await app.inject({ method: 'POST', url: '/auth/second-factor', payload: { loginChallengeId: first.json().loginChallengeId, code: '123456' } })
    expect(wrong.statusCode).toBe(401)
    const right = await app.inject({ method: 'POST', url: '/auth/second-factor',
      payload: { loginChallengeId: first.json().loginChallengeId, code: totpCode(mdSecret, clock) } })
    expect(right.json()).toMatchObject({ stage: 'done', user: { godMode: true }, idleMinutes: 15 })
    MD = right.json().token
  })

  it('rejects a wrong SMS code and stops after 5 attempts', async () => {
    const id = await requestCode(MD_MOBILE)
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { challengeId: id, code: '999999' } })
      expect(r.statusCode).toBe(401)
    }
    const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { challengeId: id, code: sms[MD_MOBILE] } })
    expect(r.statusCode).toBe(401)
  })

  it('limits how many codes one number can request', async () => {
    for (let i = 0; i < 6; i++) await app.inject({ method: 'POST', url: '/auth/otp', payload: { mobile: '9000000123' } })
    const r = await app.inject({ method: 'POST', url: '/auth/otp', payload: { mobile: '9000000123' } })
    expect(r.statusCode).toBe(429)
  })

  it('lets the MD add a receptionist, who signs in with just the SMS code', async () => {
    const add = await app.inject({ method: 'POST', url: '/api/users', headers: auth(MD), payload: { name: 'Priya', email: 'priya@sathya.test', mobile: '9840000002', roles: ['reception'] } })
    expect(add.statusCode).toBe(201)
    const res = await signIn('9840000002')
    expect(res.json()).toMatchObject({ stage: 'done', idleMinutes: 240 })
    FD = res.json().token
  })

  it('ends a God Mode session after 15 idle minutes, and activity keeps it alive', async () => {
    advance(14)
    expect((await app.inject({ url: '/auth/me', headers: auth(MD) })).statusCode).toBe(200)
    advance(14)
    expect((await app.inject({ url: '/auth/me', headers: auth(MD) })).statusCode).toBe(200)
    advance(16)
    expect((await app.inject({ url: '/auth/me', headers: auth(MD) })).statusCode).toBe(401)
    advance(1)
    const again = await signIn(MD_MOBILE)
    const done = await app.inject({ method: 'POST', url: '/auth/second-factor',
      payload: { loginChallengeId: again.json().loginChallengeId, code: totpCode(mdSecret, clock) } })
    MD = done.json().token
    FD = (await signIn('9840000002')).json().token
  })

  it('holds a new accounts device until the MD or GM approves it', async () => {
    await app.inject({ method: 'POST', url: '/api/users', headers: auth(MD), payload: { name: 'Karthik', email: 'karthik@sathya.test', mobile: '9840000003', roles: ['accounts'] } })
    const first = await signIn('9840000003', { deviceId: 'acc-pc-1', deviceLabel: 'Accounts PC' })
    expect(first.statusCode).toBe(403)
    expect(first.json().stage).toBe('device_pending')
    const inbox = await app.inject({ url: '/api/approvals', headers: auth(MD) })
    expect(inbox.json().map((a: { kind: string }) => a.kind)).toContain('device.register')
    const ok = await app.inject({ method: 'POST', url: `/api/approvals/${first.json().approvalId}/decide`, headers: auth(MD), payload: { decision: 'approve' } })
    expect(ok.json()).toEqual({ ok: true, status: 'approved' })
    const second = await signIn('9840000003', { deviceId: 'acc-pc-1' })
    expect(second.json().stage).toBe('enroll_2fa')
  })

  it('only the MD can give God Mode or lock people out', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/users', headers: auth(FD), payload: { name: 'X', email: 'x@sathya.test', mobile: '9840000009', roles: ['reception'] } })
    expect(r.statusCode).toBe(403)
    const [u] = await db.query<{ id: string }>(`select id from app_user where mobile = '+919840000002'`)
    const lock = await app.inject({ method: 'POST', url: `/api/users/${u.id}/lock`, headers: auth(MD), payload: { reason: 'Test' } })
    expect(lock.json().sessionsEnded).toBeGreaterThan(0)
    expect((await app.inject({ url: '/auth/me', headers: auth(FD) })).statusCode).toBe(401)
    await app.inject({ method: 'POST', url: `/api/users/${u.id}/unlock`, headers: auth(MD) })
    FD = (await signIn('9840000002')).json().token
  })
})

describe('rooms and room types are editable', () => {
  it('stops reception from changing rooms', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(FD), payload: { roomNo: '401', kind: 'room', roomTypeId: 'deluxe' } })
    expect(r.statusCode).toBe(403)
  })

  it('adds a room type and a room; the total is not fixed', async () => {
    const t = await app.inject({ method: 'POST', url: '/api/room-types', headers: auth(MD), payload: { name: 'Family Cottage', baseRate: 6500, maxOccupancy: 5 } })
    expect(t.json()).toEqual({ id: 'family-cottage' })
    const r = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(MD),
      payload: { roomNo: 'C1', kind: 'cottage', roomTypeId: 'family-cottage', building: 'Cottages', floor: 0 } })
    expect(r.statusCode).toBe(201)
    const rooms = (await app.inject({ url: '/api/rooms', headers: auth(FD) })).json()
    expect(rooms).toHaveLength(48)
  })

  it('refuses a duplicate room number', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(MD), payload: { roomNo: 'C1', kind: 'cottage', roomTypeId: 'family-cottage' } })
    expect(r.statusCode).toBe(409)
  })

  it('renumbers and retypes a room, keeping its identity and logging before and after', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/api/rooms/RM-101', headers: auth(MD), payload: { roomNo: '1101', roomTypeId: 'premium' } })
    expect(r.json()).toMatchObject({ id: 'RM-101', room_no: '1101', room_type_id: 'premium', placeholder: false, name: 'Room 1101' })
    const log = (await app.inject({ url: '/api/audit?entityId=RM-101', headers: auth(MD) })).json()
    expect(log[0]).toMatchObject({ action: 'room.update', before: { room_no: '101' }, after: { room_no: '1101' } })
  })

  it('archives a room instead of deleting it', async () => {
    await app.inject({ method: 'DELETE', url: '/api/rooms/RM-102', headers: auth(MD) })
    const active = (await app.inject({ url: '/api/rooms', headers: auth(MD) })).json()
    const all = (await app.inject({ url: '/api/rooms?includeArchived=true', headers: auth(MD) })).json()
    expect(active.find((x: { id: string }) => x.id === 'RM-102')).toBeUndefined()
    expect(all.find((x: { id: string }) => x.id === 'RM-102').active).toBe(false)
  })

  it('will not archive a room type that rooms still use', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/api/room-types/deluxe', headers: auth(MD), payload: { active: false } })
    expect(r.statusCode).toBe(409)
  })

  it('imports the real room list and archives leftover placeholders', async () => {
    const rooms = [
      { roomNo: '101', kind: 'room', roomTypeId: 'deluxe', building: 'Main Block', floor: 1 },
      { roomNo: '102', kind: 'room', roomTypeId: 'deluxe', building: 'Main Block', floor: 1 },
      { roomNo: 'V1', kind: 'villa', roomTypeId: 'villa', building: 'Garden Villas', floor: 0 },
    ]
    const r = await app.inject({ method: 'POST', url: '/api/rooms/import', headers: auth(MD), payload: { rooms, replacePlaceholders: true } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ created: 1, updated: 2 })
    // the imported rooms, the renumbered 1101 (now confirmed) and the C1 cottage remain
    expect(r.json().activeRooms).toBe(5)
  })
})

describe('approvals', () => {
  it('sends a reception rate above ₹7,500 to the MD instead of applying it', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/rates', headers: auth(FD),
      payload: { plan: 'EP', roomTypeId: 'suite', validFrom: '2026-12-24', validTo: '2026-12-31', amount: 8200 } })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ pending: true, requires: 'managing_director_approval' })
    const id = res.json().approvalId
    const self = await app.inject({ method: 'POST', url: `/api/approvals/${id}/decide`, headers: auth(FD), payload: { decision: 'approve' } })
    expect(self.statusCode).toBe(403)
    const ok = await app.inject({ method: 'POST', url: `/api/approvals/${id}/decide`, headers: auth(MD), payload: { decision: 'approve' } })
    expect(ok.json().status).toBe('approved')
    const [rate] = await db.query<{ approved_by: string; amount_paise: number }>(`select approved_by, amount_paise from rate where valid_from = '2026-12-24'`)
    expect(rate).toEqual({ approved_by: 'u-md', amount_paise: 820000 })
    const quote = await app.inject({ method: 'POST', url: '/api/quote', headers: auth(FD),
      payload: { roomTypeId: 'suite', plan: 'EP', checkIn: '2026-12-24', nights: 1 } })
    expect(quote.json().lines[0].rate).toBe(18)
  })

  it('quotes a normal stay night by night with 5% GST', async () => {
    const q = (await app.inject({ method: 'POST', url: '/api/quote', headers: auth(FD),
      payload: { roomTypeId: 'deluxe', plan: 'EP', checkIn: '2026-11-14', nights: 2 } })).json()
    expect(q.lines.map((l: { rate: number }) => l.rate)).toEqual([5, 5])
    expect(q.cgst + q.sgst).toBe(42000)
  })
})

describe('God Mode log', () => {
  it('is hidden from non-God Mode users', async () => {
    expect((await app.inject({ url: '/api/audit', headers: auth(FD) })).statusCode).toBe(403)
  })

  it('recorded sign-ins, failures, approvals and room changes, and the chain verifies', async () => {
    const actions = (await app.inject({ url: '/api/audit?limit=500', headers: auth(MD) })).json().map((e: { action: string }) => e.action)
    for (const a of ['auth.sign_in', 'auth.sign_in_failed', 'auth.second_factor_failed', 'auth.totp_enabled', 'device.approval_requested',
      'approval.approved', 'user.create', 'user.lock', 'room.create', 'room.update', 'room.archive', 'room.import', 'rate.approval_requested']) {
      expect(actions).toContain(a)
    }
    expect((await app.inject({ url: '/api/audit/verify', headers: auth(MD) })).json()).toMatchObject({ ok: true })
  })

  it('refuses updates, deletes and truncation at the database level', async () => {
    await expect(db.query(`update audit_log set action = 'x' where seq = 1`)).rejects.toThrow(/append-only/)
    await expect(db.query('delete from audit_log where seq = 1')).rejects.toThrow(/append-only/)
    await expect(db.query('truncate audit_log')).rejects.toThrow(/append-only/)
  })
})

describe('authenticator codes', () => {
  it('matches the RFC 6238 test vector', async () => {
    const { base32Encode } = await import('../src/totp')
    const secret = base32Encode(Buffer.from('12345678901234567890'))
    expect(totpCode(secret, 59_000, 8)).toBe('94287082')
    expect(totpCode(secret, 1_111_111_109_000, 8)).toBe('07081804')
  })
})
