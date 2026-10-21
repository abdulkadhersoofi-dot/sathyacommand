import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Store operations: opening stock at weighted average, issues and transfers (first to expire first out,
// into the kitchen book), counts with the variance approved, breakage charged to a guest, expiry write-off.

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', ST = '', CHEF = '', FD = ''
let RICE = '', ONION = '', GLASS = '', MILK = '', V = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const stockIn = async (store: string, itemId: string) => (await R.get(`/api/stock?storeId=${store}`, ST)).json().items.find((i: { itemId: string }) => i.itemId === itemId)

beforeAll(async () => {
  R = await testResort('2026-11-01')
  GM = await R.staff('Karthik', '9840000701', ['general_manager'])
  ST = await R.staff('Mani', '9840000702', ['stores'])
  CHEF = await R.staff('Bala', '9840000703', ['chef'])
  FD = await R.staff('Priya', '9840000704', ['reception'])
  await R.post('/api/items/from-departments', ST)
  ONION = (await R.get('/api/items?q=onion', ST)).json()[0].id
  await patch(`/api/items/${ONION}`, ST, { hsn: '0703', gstRate: 0 })
  RICE = (await R.post('/api/items', ST, { name: 'Ponni rice', category: 'food', unit: 'g', purchaseUnit: 'bag of 25 kg', purchaseFactor: 25000, hsn: '1006', gstRate: 5, defaultStoreId: 'ST-MAIN', parLevel: 100000 })).json().id
  GLASS = (await R.post('/api/items', ST, { name: 'Water glass', category: 'crockery', unit: 'pcs', purchaseUnit: 'box of 12', purchaseFactor: 12, hsn: '7013', gstRate: 18, defaultStoreId: 'ST-MAIN' })).json().id
  MILK = (await R.post('/api/items', ST, { name: 'Milk packet', category: 'food', unit: 'ml', purchaseUnit: 'litre', purchaseFactor: 1000, gstRate: 0, perishable: true, shelfLifeDays: 2, defaultStoreId: 'ST-MAIN' })).json().id
  V = (await R.post('/api/vendors', ST, { name: 'Kumar Provisions', pan: 'ABCPK1234L' })).json().id
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM]) await R.get('/api/business-date', t) })

describe('stock and value', () => {
  it('takes opening stock once, then values at the weighted average of what came in', async () => {
    expect((await R.post('/api/stock/opening', CHEF, { storeId: 'ST-MAIN', lines: [] })).statusCode).toBe(403)
    expect((await R.post('/api/stock/opening', ST, { storeId: 'ST-KITCHEN', lines: [{ itemId: RICE, qty: 1, rate: 1 }] })).json().error).toMatch(/department's book/)
    await R.post('/api/stock/opening', ST, { storeId: 'ST-MAIN', lines: [{ itemId: RICE, qty: 2, rate: 1400 }, { itemId: GLASS, qty: 10, rate: 600 }] })
    expect((await R.post('/api/stock/opening', ST, { storeId: 'ST-MAIN', lines: [{ itemId: RICE, qty: 1, rate: 1 }] })).statusCode).toBe(409)
    await R.post('/api/grns', ST, { vendorId: V, storeId: 'ST-MAIN', note: 'Rice ran short', lines: [{ itemId: RICE, qtyReceived: 2, rate: 1500 }] })
    const rice = await stockIn('ST-MAIN', RICE)
    expect(rice).toMatchObject({ stock: 100000, valuePaise: 580000, low: false })     // 2 at ₹1,400 and 2 at ₹1,500
    expect(rice.avgCostPaise).toBeCloseTo(5.8)
  })
})

describe('issues and transfers', () => {
  let IND = ''
  it('issues against an approved indent into the kitchen book, at average cost', async () => {
    IND = (await R.post('/api/indents', CHEF, { storeId: 'ST-KITCHEN', lines: [{ itemId: RICE, qty: 1 }] })).json().id
    await R.post(`/api/indents/${IND}/approve`, GM)
    // More rice than the main store holds: refused, and nothing moves (the kitchen link is tested in qa-fixes).
    expect((await R.post('/api/stock/issue', ST, { fromStoreId: 'ST-MAIN', toStoreId: 'ST-KITCHEN', indentId: IND, lines: [{ itemId: RICE, qty: 1000 }] })).json().error).toMatch(/Only .* of Ponni rice/)
    const before = await stockIn('ST-KITCHEN', ONION)
    // Onion: received into the main store, then sent to the kitchen.
    await R.post('/api/grns', ST, { vendorId: V, storeId: 'ST-MAIN', note: 'Market', lines: [{ itemId: ONION, qtyReceived: 20, rate: 30 }] })
    const ind2 = (await R.post('/api/indents', CHEF, { storeId: 'ST-KITCHEN', lines: [{ itemId: ONION, qty: 15 }] })).json().id
    await R.post(`/api/indents/${ind2}/approve`, GM)
    const r = (await R.post('/api/stock/issue', ST, { fromStoreId: 'ST-MAIN', toStoreId: 'ST-KITCHEN', indentId: ind2, lines: [{ itemId: ONION, qty: 15 }] })).json()
    expect(r).toMatchObject({ number: 'ISS/26-27/000001', valuePaise: 45000 })
    expect((await stockIn('ST-KITCHEN', ONION)).stock - before.stock).toBe(15000)
    expect((await stockIn('ST-MAIN', ONION)).stock).toBe(5000)
    expect((await R.get('/api/indents?status=all', CHEF)).json().find((i: { id: string }) => i.id === ind2).status).toBe('issued')
    expect((await R.post('/api/stock/issue', ST, { fromStoreId: 'ST-MAIN', toStoreId: 'ST-KITCHEN', lines: [{ itemId: ONION, qty: 6 }] })).json().error).toMatch(/Only 5 kg of Onion/)
  })

  it('issues to a department that uses it up, and to housekeeping\'s own store', async () => {
    expect((await R.post('/api/stock/issue', ST, { fromStoreId: 'ST-MAIN', department: 'lobby', lines: [{ itemId: GLASS, qty: 1 }] })).json().error).toMatch(/department/)
    await R.post('/api/stock/issue', ST, { fromStoreId: 'ST-MAIN', department: 'restaurant', lines: [{ itemId: GLASS, qty: 2 }] })
    await R.post('/api/stock/issue', ST, { fromStoreId: 'ST-MAIN', toStoreId: 'ST-HK', lines: [{ itemId: GLASS, qty: 1 }] })
    expect((await stockIn('ST-MAIN', GLASS)).stock).toBe(84)
    const hk = (await R.get('/api/stock?storeId=ST-HK', ST)).json().items.find((i: { itemId: string }) => i.itemId === GLASS)
    expect(hk).toMatchObject({ stock: 12, valuePaise: 600 * 100 })
    const issues = (await R.get('/api/stock/issues', ST)).json()
    expect(issues.map((i: { department: string | null; to_store: string | null }) => i.department ?? i.to_store)).toEqual(['Housekeeping store', 'restaurant', 'Kitchen store'])
  })

  it('issues perishables first to expire, first out', async () => {
    await R.post('/api/grns', ST, { vendorId: V, storeId: 'ST-MAIN', note: 'Milk', lines: [{ itemId: MILK, qtyReceived: 5, rate: 56, expiry: '2026-11-04', batchNo: 'LATE' }] })
    await R.post('/api/grns', ST, { vendorId: V, storeId: 'ST-MAIN', note: 'Milk', lines: [{ itemId: MILK, qtyReceived: 5, rate: 56, expiry: '2026-11-02', batchNo: 'EARLY' }] })
    await R.post('/api/stock/issue', ST, { fromStoreId: 'ST-MAIN', department: 'restaurant', lines: [{ itemId: MILK, qty: 7 }] })
    const exp = (await R.get('/api/stock/expiring?days=5', ST)).json()
    expect(exp.map((b: { batch_no: string; qty_left: string }) => `${b.batch_no}:${Number(b.qty_left)}`)).toEqual(['LATE:3000'])
  })
})

describe('counts', () => {
  it('corrects the book only after the GM approves a variance above the counter\'s limit', async () => {
    const r = (await R.post('/api/stock/counts', ST, { storeId: 'ST-MAIN', lines: [{ itemId: RICE, counted: 98000 }, { itemId: GLASS, counted: 85 }] })).json()
    expect(r).toMatchObject({ status: 'pending_approval', varianceValuePaise: -11600 + 5000 })   // 2 kg rice short at ₹5.80, 1 glass over at ₹50
    expect((await stockIn('ST-MAIN', RICE)).stock).toBe(100000)
    expect((await R.post(`/api/approvals/${r.approvalId}/decide`, ST, { decision: 'approve' })).statusCode).toBe(403)
    await R.post(`/api/approvals/${r.approvalId}/decide`, GM, { decision: 'approve' })
    expect((await stockIn('ST-MAIN', RICE)).stock).toBe(98000)
    expect((await stockIn('ST-MAIN', GLASS)).stock).toBe(85)
    const [c] = (await R.get('/api/stock/counts', GM)).json()
    expect(c).toMatchObject({ status: 'applied', decided_by_name: 'Karthik', number: 'CNT/26-27/000001' })
    expect(c.lines[0]).toMatchObject({ item: 'Ponni rice', variance_paise: -11600 })
  })

  it('applies a count with no difference at once', async () => {
    expect((await R.post('/api/stock/counts', ST, { storeId: 'ST-MAIN', lines: [{ itemId: GLASS, counted: 85 }] })).json().status).toBe('applied')
  })
})

describe('breakage and expiry', () => {
  it('charges a guest for breakage on their bill, at cost out of stock', async () => {
    const res = (await R.post('/api/reservations', FD, { roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-03', guest: { name: 'Arun' } })).json()
    await R.post(`/api/reservations/${res.id}/check-in`, FD, { spaceId: 'RM-101', idType: 'aadhaar', idNumber: '1234 5678 9012' })
    expect((await R.post('/api/stock/breakage', ST, { storeId: 'ST-MAIN', itemId: GLASS, qty: 1, department: 'rooms', chargeTo: 'staff' })).json().error).toMatch(/Name the member/)
    const r = (await R.post('/api/stock/breakage', ST, { storeId: 'ST-MAIN', itemId: GLASS, qty: 2, department: 'rooms', chargeTo: 'guest', reservationId: res.id, charge: 150 })).json()
    expect(r).toMatchObject({ valuePaise: 10000, chargedPaise: 17700 })            // two at ₹50 cost; ₹150 charged plus 18% GST
    const folio = (await R.get(`/api/reservations/${res.id}`, FD)).json().lines
    expect(JSON.stringify(folio)).toContain('Breakage · 2 × Water glass')
    expect((await stockIn('ST-MAIN', GLASS)).stock).toBe(83)
    expect((await R.get('/api/stock/breakage', ST)).json()[0]).toMatchObject({ item: 'Water glass', charge_to: 'guest', guest: 'Arun' })
  })

  it('writes off an expired batch at cost', async () => {
    const [b] = (await R.get('/api/stock/expiring?days=5', ST)).json()
    const r = (await R.post(`/api/stock/batches/${b.id}/expire`, ST)).json()
    expect(r.valuePaise).toBe(16800)                                             // 3 litres at ₹56
    expect((await R.get('/api/stock/expiring?days=5', ST)).json()).toHaveLength(0)
    expect((await stockIn('ST-MAIN', MILK)).stock).toBe(0)
  })

  it('prints QR labels for items and finds an item by its code', async () => {
    expect((await R.get('/api/items/labels?storeId=ST-MAIN', ST)).body).toContain('Water glass (box of 12)')
    expect((await R.get(`/api/items/by-code/${GLASS}`, ST)).json().name).toBe('Water glass')
  })
})
