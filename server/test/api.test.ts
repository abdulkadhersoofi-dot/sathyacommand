import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { migrate, openPglite, type Db } from '../src/db'
import { seed } from '../src/seed'

// Runs against a real Postgres engine (PGlite, in memory) with the real migrations and seed.

let db: Db
let app: ReturnType<typeof buildApp>
const MD = { 'x-user-id': 'u-md' }
const RECEPTION = { 'x-user-id': 'u-fd1' }

beforeAll(async () => {
  db = await openPglite()
  await migrate(db)
  await seed(db, { today: '2026-11-01' })
  await db.query(`insert into app_user (id, name) values ('u-fd1', 'Priya (front desk)')`)
  await db.query(`insert into user_role (user_id, role_id) values ('u-fd1', 'reception')`)
  app = buildApp(db)
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

  it('skips package rates that would cross ₹7,500 a night', async () => {
    const res = await app.inject({ url: '/api/rate-plans', headers: MD })
    const priced = res.json().filter((r: { room_type_id: string | null }) => r.room_type_id)
    expect(priced.every((r: { amount_paise: number }) => r.amount_paise <= 750000)).toBe(true)
    expect(priced.find((r: { code: string; room_type_id: string }) => r.code === 'CP' && r.room_type_id === 'suite')).toBeUndefined()
  })
})

describe('API', () => {
  it('rejects calls without a user', async () => {
    const res = await app.inject({ url: '/api/spaces' })
    expect(res.statusCode).toBe(401)
  })

  it('lists rooms and venues', async () => {
    const res = await app.inject({ url: '/api/spaces', headers: RECEPTION })
    const spaces = res.json()
    expect(spaces.filter((s: { sellable: boolean }) => s.sellable)).toHaveLength(47)
    expect(spaces.map((s: { id: string }) => s.id)).toContain('LAWN-GRAND')
  })

  it('quotes a stay night by night with 5% GST', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/quote', headers: RECEPTION,
      payload: { roomTypeId: 'deluxe', plan: 'EP', checkIn: '2026-11-14', nights: 2 } })
    const q = res.json()
    expect(res.statusCode).toBe(200)
    expect(q.lines.map((l: { rate: number }) => l.rate)).toEqual([5, 5])
    expect(q.taxable).toBe(840000)
    expect(q.cgst + q.sgst).toBe(42000)
  })

  it('blocks reception from setting a rate above ₹7,500 and logs the attempt', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/rates', headers: RECEPTION,
      payload: { plan: 'EP', roomTypeId: 'suite', validFrom: '2026-12-24', validTo: '2026-12-31', amount: 8200 } })
    expect(res.statusCode).toBe(403)
    expect(res.json().requires).toBe('managing_director_approval')
    const audit = await app.inject({ url: '/api/audit?entityId=EP/suite/2026-12-24', headers: MD })
    expect(audit.json()[0].action).toBe('rate.blocked_by_guard')
  })

  it('lets the MD set it, records who approved, and logs it', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/rates', headers: MD,
      payload: { plan: 'EP', roomTypeId: 'suite', validFrom: '2026-12-24', validTo: '2026-12-31', amount: 8200 } })
    expect(res.json()).toMatchObject({ ok: true, aboveLimit: true })
    const [rate] = await db.query<{ approved_by: string }>(`select approved_by from rate where valid_from = '2026-12-24'`)
    expect(rate.approved_by).toBe('u-md')
    const quote = await app.inject({ method: 'POST', url: '/api/quote', headers: MD,
      payload: { roomTypeId: 'suite', plan: 'EP', checkIn: '2026-12-24', nights: 1 } })
    expect(quote.json().lines[0].rate).toBe(18)
  })

  it('hides the audit log from non-God Mode users', async () => {
    expect((await app.inject({ url: '/api/audit', headers: RECEPTION })).statusCode).toBe(403)
  })
})

describe('God Mode log in the database', () => {
  it('verifies the stored chain', async () => {
    const res = await app.inject({ url: '/api/audit/verify', headers: MD })
    expect(res.json()).toMatchObject({ ok: true })
    expect(res.json().entries).toBeGreaterThanOrEqual(3)
  })

  it('refuses updates, deletes and truncation at the database level', async () => {
    await expect(db.query(`update audit_log set action = 'x' where seq = 1`)).rejects.toThrow(/append-only/)
    await expect(db.query('delete from audit_log where seq = 1')).rejects.toThrow(/append-only/)
    await expect(db.query('truncate audit_log')).rejects.toThrow(/append-only/)
  })
})
