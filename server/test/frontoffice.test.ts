import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Two business days at the front desk, end to end, on a real Postgres engine.

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', NA = ''
const ids: Record<string, string> = {}

const book = (body: Record<string, unknown>) => R.post('/api/reservations', FD, {
  roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-03', ...body,
})
const detail = async (id: string) => (await R.get(`/api/reservations/${id}`, FD)).json()

beforeAll(async () => {
  R = await testResort('2026-11-01')
  FD = await R.staff('Priya', '9840000002', ['reception'])
  NA = await R.staff('Senthil', '9840000004', ['night_auditor'])
}, 30_000)
afterAll(() => R.close())

describe('booking', () => {
  it('shows availability per room type and night', async () => {
    const av = (await R.post('/api/availability', FD, { from: '2026-11-01', to: '2026-11-03' })).json()
    expect(av.find((t: { roomTypeId: string }) => t.roomTypeId === 'suite').nights).toEqual([
      { night: '2026-11-01', free: 3 }, { night: '2026-11-02', free: 3 },
    ])
  })

  it('books until a room type is full, then refuses', async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await book({ guest: { name: `Suite guest ${i}` }, roomTypeId: 'suite' })
      expect(r.statusCode).toBe(201)
    }
    const full = await book({ guest: { name: 'One too many' }, roomTypeId: 'suite' })
    expect(full.statusCode).toBe(409)
    expect(full.json().fullNights).toEqual(['2026-11-01', '2026-11-02'])
  })

  it('fixes the price per night at booking', async () => {
    const r = await book({ guest: { name: 'Arun Kumar', mobile: '98400 11111' }, eta: '14:00' })
    expect(r.json()).toMatchObject({ nights: 2, roomTotal: 840000 })
    ids.A = r.json().id
  })

  it('refuses arrivals before the business date', async () => {
    expect((await book({ guest: { name: 'Late' }, arrival: '2026-10-30' })).statusCode).toBe(400)
  })

  it('never puts two reservations in one room on the same night', async () => {
    expect((await R.post(`/api/reservations/${ids.A}/assign-room`, FD, { spaceId: 'RM-101' })).json()).toMatchObject({ ok: true, roomNo: '101' })
    ids.B = (await book({ guest: { name: 'Bala' } })).json().id
    const clash = await R.post(`/api/reservations/${ids.B}/assign-room`, FD, { spaceId: 'RM-101' })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error).toMatch(/already booked/)
  })

  it('applies a discount within the role limit, and sends a bigger one for approval', async () => {
    const small = await R.post(`/api/reservations/${ids.A}/discount`, FD, { percent: 10, reason: 'Repeat guest' })
    expect(small.json()).toMatchObject({ ok: true, nightsRepriced: 2 })
    const big = await R.post(`/api/reservations/${ids.A}/discount`, FD, { percent: 20, reason: 'Corporate tie-up' })
    expect(big.statusCode).toBe(202)
    expect((await R.post(`/api/approvals/${big.json().approvalId}/decide`, R.md, { decision: 'approve' })).json().status).toBe('approved')
    const d = await detail(ids.A)
    expect(d.nights.map((n: { amount_paise: number }) => n.amount_paise)).toEqual([336000, 336000])
  })

  it('cancels a reservation and puts its nights back on sale', async () => {
    const before = (await R.post('/api/availability', FD, { from: '2026-11-01', to: '2026-11-02' })).json()
    await R.post(`/api/reservations/${ids.B}/cancel`, FD, { reason: 'Plans changed' })
    const after = (await R.post('/api/availability', FD, { from: '2026-11-01', to: '2026-11-02' })).json()
    const free = (x: { roomTypeId: string; nights: { free: number }[] }[]) => x.find((t) => t.roomTypeId === 'deluxe')!.nights[0].free
    expect(free(after)).toBe(free(before) + 1)
  })
})

describe('check-in', () => {
  it('needs the guest ID, and keeps only its last 4 characters', async () => {
    expect((await R.post(`/api/reservations/${ids.A}/check-in`, FD, {})).statusCode).toBe(400)
    const ok = await R.post(`/api/reservations/${ids.A}/check-in`, FD, { idType: 'aadhaar', idNumber: '1234 5678 9012' })
    expect(ok.json()).toMatchObject({ ok: true, formCDue: null })
    const d = await detail(ids.A)
    expect(d.status).toBe('in_house')
    expect(d.guest).toMatchObject({ id_type: 'aadhaar', id_last4: '9012' })
    expect(JSON.stringify(d)).not.toContain('5678')
  })

  it('opens a Form C task, due in 24 hours, for a foreign guest', async () => {
    ids.C = (await book({ guest: { name: 'Emma Clarke', nationality: 'GB' }, departure: '2026-11-02' })).json().id
    const r = await R.post(`/api/reservations/${ids.C}/check-in`, FD, { spaceId: 'RM-103', idType: 'passport', idNumber: 'K1234567' })
    expect(r.json().formCDue).toBe(new Date(R.now() + 24 * 3600_000).toISOString())
    expect((await R.post(`/api/form-c/${ids.C}`, FD, { reference: 'FC-TN-77812' })).json()).toEqual({ ok: true })
  })
})

describe('bills and payments', () => {
  it('needs an open cashier shift for cash, and blocks ₹2 lakh or more in cash', async () => {
    const folio = (await detail(ids.A)).folios[0].id
    ids.FA = folio
    expect((await R.post(`/api/folios/${folio}/payments`, FD, { method: 'cash', amount: 1000 })).statusCode).toBe(409)
    expect((await R.post('/api/cashier/open', FD, { openingFloat: 5000 })).statusCode).toBe(201)
    expect((await R.post(`/api/folios/${folio}/payments`, FD, { method: 'upi', amount: 1000 })).statusCode).toBe(400)
    const big = await R.post(`/api/folios/${folio}/payments`, FD, { method: 'cash', amount: 210000 })
    expect(big.statusCode).toBe(403)
    const ok = await R.post(`/api/folios/${folio}/payments`, FD, { method: 'cash', amount: 1000 })
    expect(ok.json().balance).toBe(-100000)
  })

  it('adds laundry at 18% GST', async () => {
    const r = await R.post(`/api/folios/${ids.FA}/charges`, FD, { kind: 'laundry', description: '3 shirts', amount: 500 })
    expect(r.json()).toMatchObject({ total: 59000, balance: -41000 })
    ids.laundry = r.json().lineId
  })

  it('lets only a manager reverse a charge, and only once', async () => {
    expect((await R.post(`/api/folio-lines/${ids.laundry}/reverse`, FD, { reason: 'Wrong room' })).statusCode).toBe(403)
    const ok = await R.post(`/api/folio-lines/${ids.laundry}/reverse`, R.md, { reason: 'Wrong room' })
    expect(ok.json().balance).toBe(-100000)
    expect((await R.post(`/api/folio-lines/${ids.laundry}/reverse`, R.md, { reason: 'Again' })).statusCode).toBe(409)
  })
})

describe('night audit', () => {
  it('is only for the night auditor or managers', async () => {
    expect((await R.post('/api/night-audit', FD)).statusCode).toBe(403)
  })

  it('marks no-shows, posts room charges with GST, and moves to the next business day', async () => {
    const res = await R.post('/api/night-audit', NA)
    const s = res.json()
    expect(s.businessDate).toBe('2026-11-01')
    expect(s.nextBusinessDate).toBe('2026-11-02')
    expect(s.roomsSold).toBe(2)
    expect(s.noShows).toHaveLength(3)                      // the three suites never arrived
    expect(s.roomRevenue).toBe(336000 + 420000)
    expect(s.roomGst).toBe(16800 + 21000)                  // 5% on both nights
    expect(s.payments).toEqual({ cash: 100000 })
    const room = (await detail(ids.A)).lines.find((l: { kind: string }) => l.kind === 'room')
    expect(room).toMatchObject({ gst_rate: '5.00', taxable_paise: 336000, cgst_paise: 8400, sgst_paise: 8400, amount_paise: 352800 })
    expect((await R.get('/api/business-date', FD)).json().businessDate).toBe('2026-11-02')
  })

  it('applies 18% when an extra bed takes the night above ₹7,500', async () => {
    const r = await R.post('/api/reservations', FD, { guest: { name: 'Family Rao' }, roomTypeId: 'premium', plan: 'EP',
      arrival: '2026-11-02', departure: '2026-11-03', adults: 3, children: 1 })
    ids.D = r.json().id
    await R.post(`/api/reservations/${ids.D}/extra-bed`, FD, { amount: 2000 })
    await R.post(`/api/reservations/${ids.D}/check-in`, FD, { spaceId: 'RM-301', idType: 'dl', idNumber: 'TN0920230001234' })
    const s = (await R.post('/api/night-audit', NA)).json()
    expect(s.businessDate).toBe('2026-11-02')
    const line = (await detail(ids.D)).lines.find((l: { kind: string }) => l.kind === 'room')
    expect(line).toMatchObject({ gst_rate: '18.00', taxable_paise: 780000 })
  })
})

describe('check-out and cashier close', () => {
  it('refuses check-out with money due, then releases unused nights after payment', async () => {
    // Business date is now 11-03 (two audits run), Arun's departure date.
    const d = await detail(ids.A)
    expect(d.balance).toBeGreaterThan(0)
    const due = await R.post(`/api/reservations/${ids.A}/check-out`, FD)
    expect(due.statusCode).toBe(409)
    await R.post(`/api/folios/${ids.FA}/payments`, FD, { method: 'card', amount: due.json().balance / 100, reference: 'POS-88123' })
    const out = await R.post(`/api/reservations/${ids.A}/check-out`, FD)
    expect(out.json()).toEqual({ ok: true, releasedNights: [] })
    expect((await detail(ids.A)).status).toBe('checked_out')
  })

  it('records the cash variance at shift close and flags it above ₹500', async () => {
    expect((await R.post('/api/cashier/close', FD, { countedCash: 5000, denominations: { 500: 9 } })).statusCode).toBe(400)
    const r = await R.post('/api/cashier/close', FD, { countedCash: 5000, denominations: { 500: 10 } })
    expect(r.json()).toMatchObject({ expected: 600000, counted: 500000, variance: -100000, flagged: true })
  })

  it('logged every step in God Mode and the chain verifies', async () => {
    const actions = (await R.get('/api/audit?limit=1000', R.md)).json().map((e: { action: string }) => e.action)
    for (const a of ['reservation.create', 'reservation.assign_room', 'reservation.discount', 'reservation.discount_requested', 'reservation.cancel',
      'reservation.check_in', 'form_c.submitted', 'payment.cash_blocked', 'payment.receive', 'folio.charge', 'folio.reverse',
      'night_audit.run', 'reservation.check_out', 'cashier.open', 'cashier.close_with_variance']) {
      expect(actions, a).toContain(a)
    }
    expect((await R.get('/api/audit/verify', R.md)).json()).toMatchObject({ ok: true })
  })
})
