import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// A fresh install, as the MD finds it: no legal name or GSTIN yet. Invoices wait for the resort profile, which
// the MD fills in from Settings; the getting-started checklist shows what is left.

let R: Awaited<ReturnType<typeof testResort>>
let FD = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })

beforeAll(async () => {
  R = await testResort('2026-11-01', { taxDetails: false })
  FD = await R.staff('Priya', '9840009001', ['reception'])
}, 60_000)
afterAll(() => R.close())

describe('the resort profile', () => {
  it('lists what is left to set up, profile first', async () => {
    const s = (await R.get('/api/setup-status', R.md)).json()
    expect(s.done).toBe(false)
    expect(s.steps.find((x: { key: string }) => x.key === 'profile').done).toBe(false)
    expect((await R.get('/api/setup-status', FD)).json()).toEqual({ steps: [], done: true })   // only the MD sees it
  })

  it('refuses a check-out invoice until the legal name and GSTIN are set, saying where to set them', async () => {
    const res = (await R.post('/api/reservations', FD, { guest: { name: 'Anitha' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-02' })).json()
    await R.post(`/api/reservations/${res.id}/check-in`, FD, { spaceId: 'RM-105', idType: 'aadhaar', idNumber: '1234 5678 9012' })
    await R.post('/api/night-audit', R.md)
    const folio = (await R.get(`/api/reservations/${res.id}`, FD)).json().folios[0].id
    await R.post('/api/cashier/open', FD, { openingFloat: 0 })
    await R.post(`/api/folios/${folio}/payments`, FD, { method: 'card', amount: 4410, reference: 'C1' })
    const out = await R.post(`/api/reservations/${res.id}/check-out`, FD)
    expect(out.statusCode).toBe(409)
    expect(out.json().error ?? '').toMatch(/Settings → Resort profile/)
  })

  it('takes the profile from the MD only, checking the GSTIN, TAN, PIN and day close time', async () => {
    expect((await patch('/api/property', FD, { legalName: 'X' })).statusCode).toBe(403)
    expect((await patch('/api/property', R.md, { gstin: '33AAACS1234A1Z8' })).json().error).toMatch(/GSTIN/)
    expect((await patch('/api/property', R.md, { tan: 'ABC123' })).json().error).toMatch(/TAN/)
    expect((await patch('/api/property', R.md, { pin: '6410' })).json().error).toMatch(/PIN/)
    expect((await patch('/api/property', R.md, { dayCloseAt: '14:00' })).json().error).toMatch(/at night/)
    const p = (await patch('/api/property', R.md, { legalName: 'Sathya Park Resorts Private Limited', gstin: '33aaacs1234a1z9', address: 'Sathya Resorts Road', city: 'Coimbatore', pin: '641001',
      phone: '0422 2345678', email: 'Front@SathyaResorts.in', tan: 'ches12345a', invoicePrefix: 'spr', tdsResponsible: 'A. Sathya', tdsDesignation: 'Director', dayCloseAt: '02:30' })).json()
    expect(p).toMatchObject({ gstin: '33AAACS1234A1Z9', pan: 'AAACS1234A', tan: 'CHES12345A', invoice_prefix: 'SPR', email: 'front@sathyaresorts.in', day_close_at: '02:30', auto_close: true })
    expect((await R.get('/api/property', FD)).json().legal_name).toBe('Sathya Park Resorts Private Limited')
    const s = (await R.get('/api/setup-status', R.md)).json()
    expect(s.steps.filter((x: { done: boolean }) => x.done).map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining(['profile', 'tan', 'logins']))
    const [a] = await R.db.query<{ action: string }>(`select action from audit_log where action = 'property.profile' order by seq desc limit 1`)
    expect(a.action).toBe('property.profile')
  })
})
