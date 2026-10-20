import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertMonthOpen } from '../src/stock'
import { testResort } from './helpers'

// Month close: October valued store by store, the closing count found, the variance held against each
// store's limit, the GM's sign-off, food cost for the kitchen, and the month locked once closed.

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', ST = '', CHEF = ''
let RICE = '', GLASS = '', ONION = '', V = ''
const setDay = (d: string) => R.db.query('update property set business_date = $1', [d])
const row = async (store: string, month = '2026-10', token = ST) => (await R.get(`/api/month-close?month=${month}`, token)).json().stores.find((s: { storeId: string }) => s.storeId === store)

beforeAll(async () => {
  R = await testResort('2026-10-26')
  GM = await R.staff('Karthik', '9840000801', ['general_manager'])
  ST = await R.staff('Mani', '9840000802', ['stores'])
  CHEF = await R.staff('Bala', '9840000803', ['chef'])
  await R.post('/api/items/from-departments', ST)
  ONION = (await R.get('/api/items?q=onion', ST)).json()[0].id
  RICE = (await R.post('/api/items', ST, { name: 'Ponni rice', category: 'food', unit: 'g', purchaseUnit: 'bag of 25 kg', purchaseFactor: 25000, hsn: '1006', gstRate: 5, defaultStoreId: 'ST-MAIN' })).json().id
  GLASS = (await R.post('/api/items', ST, { name: 'Water glass', category: 'crockery', unit: 'pcs', purchaseUnit: 'box of 12', purchaseFactor: 12, hsn: '7013', gstRate: 18, defaultStoreId: 'ST-MAIN' })).json().id
  V = (await R.post('/api/vendors', ST, { name: 'Kumar Provisions', pan: 'ABCPK1234L' })).json().id
  // October: opening stock, a receipt, issues to the restaurant, the kitchen and housekeeping.
  await R.post('/api/stock/opening', ST, { storeId: 'ST-MAIN', lines: [{ itemId: RICE, qty: 4, rate: 1400 }, { itemId: GLASS, qty: 10, rate: 600 }] })
  await R.post('/api/grns', ST, { vendorId: V, storeId: 'ST-MAIN', note: 'Market', lines: [{ itemId: ONION, qtyReceived: 20, rate: 30 }] })
  await R.post('/api/stock/issue', ST, { fromStoreId: 'ST-MAIN', department: 'restaurant', lines: [{ itemId: RICE, qty: 2 }] })
  await R.post('/api/stock/issue', ST, { fromStoreId: 'ST-MAIN', toStoreId: 'ST-KITCHEN', lines: [{ itemId: ONION, qty: 15 }] })
  await R.post('/api/stock/issue', ST, { fromStoreId: 'ST-MAIN', toStoreId: 'ST-HK', lines: [{ itemId: GLASS, qty: 2 }] })
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM]) await R.get('/api/business-date', t) })

describe('before the month is over', () => {
  it('values the month from the book and will not close it early', async () => {
    const m = await row('ST-MAIN')
    // Opening ₹5,600 + ₹6,000 glass; onion ₹600 in; rice ₹2,800 out; onion ₹450 and glass ₹1,200 transferred.
    expect(m.figures).toMatchObject({ openingPaise: 0, receiptsPaise: 1220000, issuesPaise: -445000, closingPaise: 775000, variancePaise: 0 })
    expect(m).toMatchObject({ limitPercent: 1, countNeeded: true, count: null, close: null })
    expect((await R.post('/api/month-close', ST, { storeId: 'ST-MAIN', month: '2026-10' })).json().error).toMatch(/not over yet/)
  })

  it('counts any store, a department book too, as the closing count', async () => {
    await setDay('2026-10-30')
    // Main store: 100 g of rice short (₹5.60) against ₹4,450 given out.
    expect((await R.post('/api/stock/counts', ST, { storeId: 'ST-MAIN', lines: [{ itemId: RICE, counted: 49900 }, { itemId: GLASS, counted: 96 }] })).json().status).toBe('pending_approval')
    const [c] = (await R.get('/api/stock/counts', GM)).json()
    const [a] = (await R.get('/api/approvals', GM)).json().filter((x: { kind: string }) => x.kind === 'stock.count')
    await R.post(`/api/approvals/${a.id}/decide`, GM, { decision: 'approve' })
    expect((await row('ST-MAIN')).count).toMatchObject({ ref: c.number, date: '2026-10-30' })
    // Housekeeping: 3 of its 24 glasses gone.
    const hk = (await R.post('/api/stock/counts', GM, { storeId: 'ST-HK', lines: [{ itemId: GLASS, counted: 21 }] })).json()
    expect(hk).toMatchObject({ status: 'applied', varianceValuePaise: -15000 })
    // The kitchen counts in its own screen.
    const ing = (await R.get('/api/items?q=onion', ST)).json()[0].ingredient_id
    await R.post('/api/kitchen/counts', CHEF, { lines: [{ ingredientId: ing, qty: 15000 }] })
  })
})

describe('closing October', () => {
  it('needs the closing count, and an explanation over the limit', async () => {
    await setDay('2026-11-01')
    const hk = await row('ST-HK')
    expect(hk.figures).toMatchObject({ receiptsPaise: 120000, variancePaise: -15000, closingPaise: 105000, basePaise: 120000, variancePercent: 12.5 })
    expect(hk.withinLimit).toBe(false)
    expect((await R.post('/api/month-close', ST, { storeId: 'ST-HK', month: '2026-10' })).json().error).toMatch(/over the 1% agreed/)
    expect((await R.post('/api/month-close', ST, { storeId: 'ST-ENG', month: '2026-10' })).statusCode).toBe(201)   // nothing held: no count needed
  })

  it('closes the main store under its limit once the GM signs off', async () => {
    const m = await row('ST-MAIN')
    expect(m.figures).toMatchObject({ variancePaise: -560, basePaise: 445000, variancePercent: 0.13 })
    expect(m.withinLimit).toBe(true)
    const r = (await R.post('/api/month-close', ST, { storeId: 'ST-MAIN', month: '2026-10' })).json()
    expect(r).toMatchObject({ status: 'pending_approval', closingPaise: 774440, withinLimit: true })
    expect((await R.post('/api/month-close', ST, { storeId: 'ST-MAIN', month: '2026-10' })).json().error).toMatch(/already with the GM/)
    expect((await R.post(`/api/approvals/${r.approvalId}/decide`, ST, { decision: 'approve' })).statusCode).toBe(403)
    await R.post(`/api/approvals/${r.approvalId}/decide`, GM, { decision: 'approve' })
    expect((await row('ST-MAIN')).close).toMatchObject({ status: 'closed', decided_by_name: 'Karthik', count_ref: m.count.ref })
  })

  it('lets the GM agree a store\'s limit, and sends a close back to be redone', async () => {
    expect((await R.post('/api/stores/ST-HK/variance-limit', ST, { percent: 15 })).statusCode).toBe(403)
    await R.post('/api/stores/ST-HK/variance-limit', GM, { percent: 15 })
    const r = (await R.post('/api/month-close', ST, { storeId: 'ST-HK', month: '2026-10' })).json()
    expect(r).toMatchObject({ withinLimit: true, limitPercent: 15 })
    await R.post(`/api/approvals/${r.approvalId}/decide`, GM, { decision: 'reject', note: 'Recount the glasses' })
    expect((await row('ST-HK')).close.status).toBe('rejected')
    expect((await R.post('/api/month-close', ST, { storeId: 'ST-HK', month: '2026-10', note: 'Three glasses broken in rooms, not entered.' })).statusCode).toBe(201)
  })

  it('shows the kitchen\'s theoretical against actual food cost, and closes it on its own count', async () => {
    const k = await row('ST-KITCHEN', '2026-10', GM)
    expect(k.count.date).toBe('2026-10-30')
    expect(k.food).toMatchObject({ salesPaise: 0, theoreticalCostPaise: 0 })
    expect(k.figures.receiptsPaise).toBe(45000)
    expect((await R.post('/api/month-close', GM, { storeId: 'ST-KITCHEN', month: '2026-10' })).json().status).toBe('closed')
  })

  it('locks the closed month and keeps the months in order', async () => {
    await expect(R.db.tx((t) => assertMonthOpen(t, 'ST-MAIN', '2026-10-31'))).rejects.toThrow(/2026-10 is closed/)
    await R.db.tx((t) => assertMonthOpen(t, 'ST-MAIN', '2026-11-01'))
    await setDay('2027-01-02')
    expect((await R.post('/api/month-close', ST, { storeId: 'ST-MAIN', month: '2026-12' })).json().error).toMatch(/close 2026-11 first/)
    expect((await R.get('/api/month-close/print?month=2026-10', GM)).body).toContain('Month-end stock statement · 2026-10')
  })
})
