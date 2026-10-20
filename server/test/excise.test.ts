import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Excise: the stock register in bottles and bulk litres for a day or a period, printed; TCS on TASMAC
// purchases; liquor kept out of ordinary purchasing; peg measures and scales on the compliance calendar.

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', BM = '', ST = '', AC = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })

beforeAll(async () => {
  R = await testResort('2026-11-01')
  GM = await R.staff('Karthik', '9840000801', ['general_manager'])
  BM = await R.staff('Arul', '9840000802', ['bar_manager'])
  ST = await R.staff('Mani', '9840000803', ['stores'])
  AC = await R.staff('Lakshmi', '9840000804', ['accounts'])
  await R.post('/api/bar/purchases', BM, { supplier: 'TASMAC', invoiceNo: 'TSM/1', invoiceDate: '2026-10-31', permitNo: 'TP/CBE/1', vat: 0,
    lines: [{ brandId: 'BR-BEER650', bottles: 24, cost: 150 }, { brandId: 'BR-WHISKY750', bottles: 6, cost: 900 }] })
  await R.post('/api/bar/breakage', BM, { brandId: 'BR-BEER650', ml: 650, reason: 'Dropped while stocking the fridge' })
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM, AC]) await R.get('/api/business-date', t) })

describe('stock register', () => {
  it('gives each brand and size in bottles and bulk litres', async () => {
    expect((await R.get('/api/excise/register', ST)).statusCode).toBe(403)
    const r = (await R.get('/api/excise/register?from=2026-11-01&to=2026-11-01', BM)).json()
    const beer = r.brands.find((b: { id: string }) => b.id === 'BR-BEER650')
    expect(beer).toMatchObject({ bottle_ml: 650, bottles: { opening: 0, received: 24, breakage: 1, closing: 23 }, bulkLitres: { received: 15.6, closing: 14.95 } })
    const whisky = r.brands.find((b: { id: string }) => b.id === 'BR-WHISKY750')
    expect(whisky.bottles).toMatchObject({ received: 6, closing: 6 })
  })

  it('carries the closing into the next day\'s opening', async () => {
    const r = (await R.get('/api/excise/register?from=2026-11-02&to=2026-11-02', BM)).json()
    expect(r.brands.find((b: { id: string }) => b.id === 'BR-BEER650').bottles).toMatchObject({ opening: 23, received: 0, closing: 23 })
    expect((await R.get('/api/excise/register?from=2026-11-01&to=2027-03-01', BM)).statusCode).toBe(400)
  })

  it('prints the register day by day with the FL-3 licence number', async () => {
    await R.post('/api/licences', GM, { kind: 'fl3', name: 'FL-3 bar licence', number: 'FL3/CBE/2026/118', validUntil: '2027-03-31' })
    const html = (await R.get('/api/excise/register/print?from=2026-11-01&to=2026-11-02&daily=1', BM)).body
    expect(html).toContain('FL3/CBE/2026/118')
    expect(html.match(/<section>/g)).toHaveLength(2)
    expect(html).toContain('Liquor stock register')
  })
})

describe('TASMAC purchases', () => {
  it('records the TCS collected by quarter, as a credit to claim', async () => {
    const r = (await R.get('/api/excise/tcs?fy=2026-27', AC)).json()
    expect(r).toMatchObject({ section: '206C(1)' })
    expect(r.quarters[2]).toMatchObject({ quarter: 3, purchases: 1, tcsPaise: 9000 })      // October falls in October–December
    expect(r.quarters[1]).toMatchObject({ quarter: 2, purchases: 0 })
    expect(r.purchases[0]).toMatchObject({ invoice_no: 'TSM/1', permit_no: 'TP/CBE/1' })
    expect(r.quarters.reduce((a: number, q: { tcsPaise: number }) => a + q.tcsPaise, 0)).toBe(9000)
  })

  it('keeps liquor out of ordinary purchase orders and goods receipts', async () => {
    await R.post('/api/items/from-departments', ST)
    const beer = (await R.get('/api/items', ST)).json().find((i: { category: string }) => i.category === 'liquor')
    const v = (await R.post('/api/vendors', ST, { name: 'Local Wines', pan: 'ABCPW1234Q' })).json().id
    expect((await R.post('/api/pos', ST, { vendorId: v, storeId: 'ST-BAR', lines: [{ itemId: beer.id, qty: 1, rate: 100 }] })).json().error).toMatch(/only from TASMAC/)
    expect((await R.post('/api/grns', ST, { vendorId: v, storeId: 'ST-BAR', note: 'x', lines: [{ itemId: beer.id, qtyReceived: 1, rate: 100 }] })).json().error).toMatch(/TASMAC purchase/)
  })
})

describe('legal metrology', () => {
  it('keeps peg measures with their stamping due dates on the compliance calendar', async () => {
    expect((await R.post('/api/excise/measures', ST, { name: 'x', kind: 'scale' })).statusCode).toBe(403)
    const m = (await R.post('/api/excise/measures', BM, { name: 'Peg measure 30 ml #1', kind: 'peg_measure', capacity: '30 ml', location: 'Bar', stampNo: 'LM/CBE/7781', stampedOn: '2025-11-20' })).json()
    expect(m.dueOn).toBe('2026-11-20')
    await R.post('/api/excise/measures', BM, { name: 'Kitchen scale', kind: 'scale', capacity: '0–30 kg', stampedOn: '2026-06-01' })
    const cal = (await R.get('/api/compliance', GM)).json()
    expect(cal.items.find((i: { type: string; name: string }) => i.type === 'metrology' && i.name === 'Stamping: Peg measure 30 ml #1')).toMatchObject({ due: '2026-11-20', tier: 30, detail: '30 ml · Bar' })
    const reminders = (await R.get('/api/audit?limit=100', R.md)).json().filter((a: { action: string }) => a.action === 'compliance.reminder')
    expect(reminders.map((x: { after: { name: string } }) => x.after.name)).toContain('Stamping: Peg measure 30 ml #1')
    await patch(`/api/excise/measures/${m.id}`, BM, { stampedOn: '2026-11-10', stampNo: 'LM/CBE/9912' })
    expect((await R.get('/api/excise/measures', BM)).json().find((x: { id: string }) => x.id === m.id)).toMatchObject({ due_on: '2027-11-10', reminded: 0 })
  })
})
