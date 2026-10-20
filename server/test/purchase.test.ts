import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Indents, purchase orders within purchase limits, the printed PO and the market list.

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', ST = '', CHEF = '', OPS = ''
let RICE = '', ONION = '', TISSUE = '', V1 = '', V2 = '', ONION_ING = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })

beforeAll(async () => {
  R = await testResort('2026-11-01')
  GM = await R.staff('Karthik', '9840000501', ['general_manager'])
  ST = await R.staff('Mani', '9840000502', ['stores'])
  CHEF = await R.staff('Bala', '9840000503', ['chef'])
  OPS = await R.staff('Deepa', '9840000504', ['operations_manager'])
  await R.post('/api/items/from-departments', ST)
  const items = (await R.get('/api/items', ST)).json()
  const onion = items.find((i: { name: string }) => i.name === 'Onion')
  ONION = onion.id
  ONION_ING = (await R.get('/api/kitchen/ingredients', GM)).json().find((g: { name: string }) => g.name === 'Onion').id
  await patch(`/api/items/${ONION}`, ST, { hsn: '0703', gstRate: 0, perishable: true, parLevel: 20000, reorderQty: 25000 })
  RICE = (await R.post('/api/items', ST, { name: 'Ponni rice', category: 'food', unit: 'g', purchaseUnit: 'bag of 25 kg', purchaseFactor: 25000, hsn: '1006', gstRate: 5, defaultStoreId: 'ST-MAIN', parLevel: 50000 })).json().id
  TISSUE = (await R.post('/api/items', ST, { name: 'Toilet roll', category: 'housekeeping', unit: 'pcs', purchaseUnit: 'case of 48', purchaseFactor: 48, hsn: '4818', gstRate: 18, defaultStoreId: 'ST-HK' })).json().id
  V1 = (await R.post('/api/vendors', ST, { name: 'Kumar Provisions', pan: 'ABCPK1234L' })).json().id
  V2 = (await R.post('/api/vendors', ST, { name: 'Bangalore Paper Co', gstin: '29AAGCB7383J1Z4' })).json().id
  for (const [v, i, rate] of [[V1, RICE, 1450], [V1, ONION, 32], [V2, TISSUE, 1150], [V2, RICE, 1500]] as const) {
    await R.post('/api/rate-contracts', ST, { vendorId: v, itemId: i, rate, validFrom: '2026-10-01', validTo: '2027-03-31' })
  }
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM]) await R.get('/api/business-date', t) })

describe('indents', () => {
  let IND = ''
  it('lets a department ask for goods, with an estimate at the best rate', async () => {
    expect((await R.post('/api/indents', ST, { storeId: 'ST-KITCHEN', lines: [] })).statusCode).toBe(400)
    const r = (await R.post('/api/indents', CHEF, { storeId: 'ST-KITCHEN', neededBy: '2026-11-03', lines: [{ itemId: RICE, qty: 2 }, { itemId: ONION, qty: 30, note: 'big onions' }] })).json()
    IND = r.id
    expect(r.number).toBe('IND/26-27/000001')
    const [mine] = (await R.get('/api/indents', CHEF)).json()
    expect(mine).toMatchObject({ status: 'submitted', store: 'Kitchen store', estimatePaise: 2 * 145000 + 30 * 3200 })
    expect(mine.lines[0]).toMatchObject({ item: 'Ponni rice', qty: '50000.000', purchaseQty: 2 })
  })

  it('is approved by the GM or operations manager, never by the person who asked', async () => {
    expect((await R.post(`/api/indents/${IND}/approve`, CHEF)).statusCode).toBe(403)
    expect((await R.post(`/api/indents/${IND}/approve`, ST)).statusCode).toBe(403)
    expect((await R.post(`/api/indents/${IND}/reject`, OPS, {})).json().error).toMatch(/why/)
    await R.post(`/api/indents/${IND}/approve`, OPS, { note: 'ok' })
    expect((await R.get('/api/indents', CHEF)).json()[0]).toMatchObject({ status: 'approved', decided_by: 'Deepa' })
  })

  it('turns approved indents into POs with the best-rate vendor', async () => {
    const r = (await R.post('/api/indents/order', ST, { indentIds: [IND] })).json()
    expect(r.pos).toHaveLength(1)                            // rice and onion are both cheapest at Kumar
    expect(r.pos[0]).toMatchObject({ number: 'PO/26-27/000001', total: Math.round(2 * 145000 * 1.05) + 30 * 3200 })
    expect((await R.get('/api/indents?status=all', CHEF)).json()[0]).toMatchObject({ status: 'ordered' })
    expect((await R.get('/api/indents?status=all', CHEF)).json()[0].lines[0].po_number).toBe('PO/26-27/000001')
    expect((await R.post('/api/indents/order', ST, { indentIds: [IND] })).statusCode).toBe(409)
  })
})

describe('purchase orders', () => {
  let PO = ''
  it('works out GST line by line, as IGST for a vendor outside Tamil Nadu', async () => {
    expect((await R.post('/api/pos', CHEF, { vendorId: V2, storeId: 'ST-HK', lines: [] })).statusCode).toBe(403)
    expect((await R.post('/api/pos', ST, { vendorId: V2, storeId: 'ST-HK', lines: [{ itemId: ONION, qty: 1 }] })).json().error).toMatch(/No rate agreed/)
    const r = (await R.post('/api/pos', ST, { vendorId: V2, storeId: 'ST-HK', expectedDate: '2026-11-05', lines: [{ itemId: TISSUE, qty: 10 }] })).json()
    PO = r.id
    expect(r).toMatchObject({ subtotal: 1150000, gst: 207000, total: 1357000 })
    const po = (await R.get(`/api/pos/${PO}`, ST)).json()
    expect(po).toMatchObject({ igst: true, status: 'draft', vendor: 'Bangalore Paper Co' })
    const print = (await R.get(`/api/pos/${PO}/print`, ST)).body
    expect(print).toContain('IGST')
    expect(print).toContain('NOT APPROVED: DRAFT')
  })

  it('is approved at once within the raiser\'s limit (stores ₹25,000)', async () => {
    expect((await R.post(`/api/pos/${PO}/send`, ST)).statusCode).toBe(409)
    expect((await R.post(`/api/pos/${PO}/submit`, ST)).json()).toMatchObject({ status: 'approved' })
    expect((await patch(`/api/pos/${PO}`, ST, { terms: 'x' })).statusCode).toBe(409)
    await R.post(`/api/pos/${PO}/send`, ST)
    expect((await R.get(`/api/pos/${PO}`, ST)).json().status).toBe('sent')
    expect((await R.get(`/api/pos/${PO}/print`, ST)).body).not.toContain('DRAFT')
  })

  it('waits for the GM above the limit, and the GM cannot go past his own', async () => {
    const big = (await R.post('/api/pos', ST, { vendorId: V1, storeId: 'ST-MAIN', lines: [{ itemId: RICE, qty: 20 }] })).json()
    const s = (await R.post(`/api/pos/${big.id}/submit`, ST)).json()
    expect(s).toMatchObject({ status: 'pending_approval' })
    expect((await R.post(`/api/approvals/${s.approvalId}/decide`, ST, { decision: 'approve' })).statusCode).toBe(403)
    await R.post(`/api/approvals/${s.approvalId}/decide`, GM, { decision: 'approve' })
    expect((await R.get(`/api/pos/${big.id}`, ST)).json()).toMatchObject({ status: 'approved' })
    const huge = (await R.post('/api/pos', ST, { vendorId: V1, storeId: 'ST-MAIN', lines: [{ itemId: RICE, qty: 400 }] })).json()   // ₹6.09 lakh
    const h = (await R.post(`/api/pos/${huge.id}/submit`, ST)).json()
    expect((await R.post(`/api/approvals/${h.approvalId}/decide`, GM, { decision: 'approve' })).json().error).toMatch(/above your own purchase limit/)
    await R.post(`/api/approvals/${h.approvalId}/decide`, R.md, { decision: 'approve' })
    expect((await R.get(`/api/pos/${huge.id}`, ST)).json().status).toBe('approved')
  })

  it('cancels with a reason, freeing indent lines to be ordered again', async () => {
    const [po1] = (await R.get('/api/pos?status=all', ST)).json().filter((p: { number: string }) => p.number === 'PO/26-27/000001')
    expect((await R.post(`/api/pos/${po1.id}/cancel`, ST, {})).statusCode).toBe(400)
    await R.post(`/api/pos/${po1.id}/cancel`, ST, { reason: 'Vendor out of stock' })
    const [ind] = (await R.get('/api/indents?status=all', CHEF)).json()
    expect(ind.status).toBe('approved')
    expect(ind.lines.every((l: { po_id: string | null }) => l.po_id === null)).toBe(true)
  })
})

describe('market list', () => {
  it('lists perishables below their level at the best rate, counting what is already on order', async () => {
    const sug = (await R.get('/api/purchase/suggestions?perishable=1', ST)).json()
    const onion = sug.find((s: { itemId: string }) => s.itemId === ONION)
    // Kitchen stock of onion from its book, below the 20 kg level: order the 25 kg reorder quantity.
    expect(onion).toMatchObject({ vendor: 'Kumar Provisions', ratePaise: 3200, purchaseUnit: 'kg', storeId: 'ST-KITCHEN' })
    expect(onion.qty).toBeGreaterThanOrEqual(25)
    const r = (await R.post('/api/purchase/suggestions/order', ST, { marketList: true, lines: [{ itemId: ONION, qty: onion.qty }] })).json()
    expect(r.pos).toHaveLength(1)
    expect((await R.get(`/api/pos/${r.pos[0].id}`, ST)).json()).toMatchObject({ market_list: true, store_id: 'ST-KITCHEN' })
    expect((await R.get('/api/purchase/suggestions?perishable=1', ST)).json().find((s: { itemId: string }) => s.itemId === ONION)).toBeUndefined()
    expect(ONION_ING).toBeTruthy()
  })
})
