import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureMdLogin, hashPassword, verifyPassword } from '../src/password'
import { testResort } from './helpers'

// Sign-in by email and password: temporary passwords changed at first sign-in, lock-out after wrong
// passwords, resets by the MD or GM, and the MD's first login from the hosting settings.

let R: Awaited<ReturnType<typeof testResort>>
let GM = ''
const login = (email: string, password: string, deviceId?: string) => R.signIn(email, password, deviceId)
const me = (token: string) => R.get('/auth/me', token)

beforeAll(async () => {
  R = await testResort()
  GM = await R.staff('Karthik', '9840001501', ['general_manager'])
}, 60_000)
afterAll(() => R.close())

describe('passwords', () => {
  it('keeps only a salted hash', async () => {
    const a = await hashPassword('mango-tree-42'), b = await hashPassword('mango-tree-42')
    expect(a).toMatch(/^scrypt\$/)
    expect(a).not.toBe(b)
    expect(await verifyPassword('mango-tree-42', a)).toBe(true)
    expect(await verifyPassword('mango-tree-43', a)).toBe(false)
    expect(await verifyPassword('anything', null)).toBe(false)
  })
})

describe('email and password sign-in', () => {
  let temp = ''
  it('gives a new login a temporary password that only lets the person set their own', async () => {
    const r = await R.post('/api/users', GM, { name: 'Priya', email: ' Priya@Sathya.test ', roles: ['reception'] })
    expect(r.statusCode).toBe(201)
    temp = r.json().tempPassword
    expect(temp).toMatch(/^[a-z]+-\d{4}-[a-z]+$/)
    const [u] = await R.db.query<{ email: string; mobile: string | null; password_hash: string }>(`select email, mobile, password_hash from app_user where id = $1`, [r.json().id])
    expect(u).toMatchObject({ email: 'priya@sathya.test', mobile: null })
    expect(u.password_hash).not.toContain(temp)

    const first = (await login('PRIYA@sathya.test', temp)).json()
    expect(first).toMatchObject({ stage: 'set_password', user: { name: 'Priya' } })
    expect((await R.get('/api/spaces', first.token)).json().stage).toBe('set_password')
    expect((await me(first.token)).json().scope).toBe('set_password')
    expect((await R.post('/auth/password', first.token, { current: temp, next: 'short' })).json().error).toMatch(/8 characters/)
    expect((await R.post('/auth/password', first.token, { current: temp, next: 'priya-at-desk' })).json().error).toMatch(/email name/)
    expect((await R.post('/auth/password', first.token, { current: 'wrong', next: 'front-desk-2026' })).statusCode).toBe(400)
    expect((await R.post('/auth/password', first.token, { current: temp, next: 'front-desk-2026' })).json()).toEqual({ ok: true })
    expect((await R.get('/api/spaces', first.token)).statusCode).toBe(200)

    expect((await login('priya@sathya.test', temp)).statusCode).toBe(401)
    expect((await login('priya@sathya.test', 'front-desk-2026')).json()).toMatchObject({ stage: 'done', idleMinutes: 240 })
  })

  it('answers a wrong password and an unknown email the same way', async () => {
    const a = await login('priya@sathya.test', 'not-it-at-all')
    const b = await login('nobody@sathya.test', 'not-it-at-all')
    expect([a.statusCode, b.statusCode]).toEqual([401, 401])
    expect(a.json()).toEqual(b.json())
    expect((await login('', '')).statusCode).toBe(400)
  })

  it('locks the login for 15 minutes after 5 wrong passwords, and a reset clears it', async () => {
    await login('priya@sathya.test', 'front-desk-2026')   // a right one clears the earlier miss
    for (let i = 0; i < 5; i++) expect((await login('priya@sathya.test', `wrong-${i}-guess`)).statusCode).toBe(401)
    const locked = await login('priya@sathya.test', 'front-desk-2026')
    expect(locked.statusCode).toBe(429)
    expect(locked.json().error).toMatch(/15 minutes/)
    await R.db.query(`update app_user set locked_until = now() - interval '1 minute' where email = 'priya@sathya.test'`)   // 15 minutes on
    expect((await login('priya@sathya.test', 'front-desk-2026')).json().stage).toBe('done')

    for (let i = 0; i < 5; i++) await login('priya@sathya.test', `wrong-${i}-guess`)
    const [u] = await R.db.query<{ id: string }>(`select id from app_user where email = 'priya@sathya.test'`)
    const reset = (await R.post(`/api/users/${u.id}/reset-password`, GM)).json()
    expect(reset.tempPassword).toBeTruthy()
    const again = (await login('priya@sathya.test', reset.tempPassword)).json()
    expect(again.stage).toBe('set_password')
    await R.post('/auth/password', again.token, { current: reset.tempPassword, next: 'front-desk-2027' })
  })

  it('ends the person\'s other sessions when they change their password', async () => {
    const a = (await login('priya@sathya.test', 'front-desk-2027')).json().token
    const b = (await login('priya@sathya.test', 'front-desk-2027')).json().token
    expect((await R.post('/auth/password', b, { current: 'front-desk-2027', next: 'front-desk-2028' })).json()).toEqual({ ok: true })
    expect((await me(a)).statusCode).toBe(401)
    expect((await me(b)).statusCode).toBe(200)
  })

  it('still holds a back-office device until it is approved', async () => {
    const { tempPassword } = (await R.post('/api/users', R.md, { name: 'Meena', email: 'meena@sathya.test', roles: ['accounts'] })).json()
    const r = await login('meena@sathya.test', tempPassword, 'acc-pc-2')
    expect(r.statusCode).toBe(403)
    expect(r.json().stage).toBe('device_pending')
  })

  it('keeps emails unique and lets a manager correct one; God Mode logins are the MD\'s alone', async () => {
    expect((await R.post('/api/users', GM, { name: 'Again', email: 'priya@sathya.test', roles: ['reception'] })).statusCode).toBe(409)
    expect((await R.post('/api/users', GM, { name: 'No email', roles: ['reception'] })).json().error).toMatch(/valid email/)
    const [u] = await R.db.query<{ id: string }>(`select id from app_user where email = 'priya@sathya.test'`)
    expect((await R.app.inject({ method: 'PATCH', url: `/api/users/${u.id}`, headers: { authorization: `Bearer ${GM}` }, payload: { email: 'priya.fd@sathya.test', mobile: '98400 01502' } })).json())
      .toMatchObject({ email: 'priya.fd@sathya.test', mobile: '+919840001502' })
    expect((await login('priya.fd@sathya.test', 'front-desk-2028')).json().stage).toBe('done')
    expect((await R.post('/api/users/u-md/reset-password', GM)).statusCode).toBe(403)
    const list = (await R.get('/api/users', GM)).json()
    expect(list.find((x: { id: string }) => x.id === u.id)).toMatchObject({ email: 'priya.fd@sathya.test', has_password: true, must_change_password: false })
  })

  it('keeps SMS codes switched off for now', async () => {
    expect((await R.app.inject({ method: 'POST', url: '/auth/otp', payload: { mobile: '9840000001' } })).statusCode).toBe(404)
  })
})

describe('the MD\'s first login', () => {
  it('comes from the hosting settings once, and again only when a reset is asked for', async () => {
    await ensureMdLogin(R.db, { email: 'other@sathya.test', password: 'another-pass-1' })
    expect((await login('md@sathya.test', 'another-pass-1')).statusCode).toBe(401)   // already set: left alone
    await ensureMdLogin(R.db, { email: 'owner@sathya.test', password: 'forgot-it-once', reset: true })
    expect((await me(R.md)).statusCode).toBe(401)
    const r = (await login('owner@sathya.test', 'forgot-it-once')).json()
    expect(r).toMatchObject({ stage: 'set_password', user: { godMode: true } })
  })
})
