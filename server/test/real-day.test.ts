import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// A real day on a fresh install, nothing prepared beforehand (no legal name, no GSTIN), done the way staff
// do it: the MD fills in the profile, reception books, checks in, takes payment and checks out with an
// invoice; the restaurant bills a walk-in; the day closes by itself overnight; the books show it all.

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', CAP = '', AC = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })

beforeAll(async () => {
  R = await testResort('2026-11-01', { taxDetails: false })
  FD = await R.staff('Priya', '9840009301', ['reception'])
  CAP = await R.staff('Murugan', '9840009302', ['captain'])
  AC = await R.staff('Meena', '9840009303', ['accounts'])
}, 60_000)
afterAll(() => R.close())

describe('a day on a fresh install', () => {
  it('starts with the profile from Settings', async () => {
    const steps = (await R.get('/api/setup-status', R.md)).json().steps.map((s: { key: string; done: boolean }) => [s.key, s.done])
    expect(steps).toContainEqual(['profile', false])
    const r = await patch('/api/property', R.md, { legalName: 'Sathya Park Resorts Private Limited', gstin: '33AAACS1234A1Z9', address: 'Sathya Resorts Road', city: 'Coimbatore', pin: '641008' })
    expect(r.statusCode).toBe(200)
    expect(r.json().pan).toBe('AAACS1234A')
  })

  it('books, checks in, takes payment and checks out with a tax invoice', async () => {
    const id = (await R.post('/api/reservations', FD, { guest: { name: 'Anand Raghavan', mobile: '98400 11223' }, roomTypeId: 'deluxe', plan: 'CP', arrival: '2026-11-01', departure: '2026-11-03', adults: 2 })).json().id
    expect((await R.get(`/api/reservations?q=${encodeURIComponent('anand')}`, FD)).json()[0].id).toBe(id)
    const ci = await R.post(`/api/reservations/${id}/check-in`, FD, { spaceId: 'RM-101', idType: 'aadhaar', idNumber: '4521 8890 1234' })
    expect(ci.statusCode).toBe(200)
    // Room service charged to the room.
    const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'DINE', kind: 'room_service', reservationId: id })).json()
    expect(o.id).toBeTruthy()
    {
      await R.post(`/api/fnb/orders/${o.id}/items`, CAP, { items: [{ itemId: 'DINE-BF02', qty: 1 }] })
      await R.post(`/api/fnb/orders/${o.id}/send`, CAP)
      const [bill] = (await R.post(`/api/fnb/orders/${o.id}/bill`, CAP, {})).json().bills
      expect((await R.post(`/api/fnb/bills/${bill.id}/settle`, CAP, { payments: [{ method: 'room', amount: bill.amounts.payable / 100 }], reservationId: id })).statusCode).toBe(200)
    }
    // Two nights pass: the day is closed each night.
    await R.post('/api/night-audit', R.md)
    await R.post('/api/night-audit', R.md)
    const d = (await R.get(`/api/reservations/${id}`, FD)).json()
    expect(d.balance).toBeGreaterThan(0)
    await R.post('/api/cashier/open', FD, { openingFloat: 0 })
    await R.post(`/api/folios/${d.folios[0].id}/payments`, FD, { method: 'upi', amount: d.balance / 100, reference: 'UPI 5512' })
    const out = (await R.post(`/api/reservations/${id}/check-out`, FD)).json()
    expect(out.invoice.number).toMatch(/^SPR\/26-27\//)
    const print = await R.app.inject({ url: `/api/tax-documents/${out.invoice.id}/print`, headers: { authorization: `Bearer ${FD}` } })
    expect(print.body).toContain('Anand Raghavan')
    expect(print.body).toContain('Total (with GST)')
  })

  it('shows the stay and the restaurant in the books once the day closes', async () => {
    await R.post('/api/night-audit', R.md)
    const tb = (await R.get('/api/accounts/trial-balance?from=2026-04-01&to=2026-11-30', AC)).json()
    expect(tb.rows.length).toBeGreaterThan(3)
    expect(tb.totals.debitPaise).toBe(tb.totals.creditPaise)
    const pl = (await R.get('/api/accounts/pnl?from=2026-11-01&to=2026-11-30', AC)).json()
    expect(JSON.stringify(pl)).toMatch(/Room/)
  })
})
