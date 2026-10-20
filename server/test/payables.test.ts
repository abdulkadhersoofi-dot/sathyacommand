import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Goods received into the right book, the three-way match, bills passed by the right person, payments
// with TDS and the approval limit, the cash rule, and the MSME due dates.

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', ST = '', AC = '', AC2 = ''
let RICE = '', ONION = '', TISSUE = '', MILK = '', KUMAR = '', RAVI = '', SHAH = '', PO = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const audit = async (action: string) => (await R.get('/api/audit?limit=300', R.md)).json().filter((a: { action: string }) => a.action === action)
const onionStock = async () => (await R.get('/api/kitchen/ingredients', GM)).json().find((g: { name: string }) => g.name === 'Onion')

beforeAll(async () => {
  R = await testResort('2026-11-01')
  GM = await R.staff('Karthik', '9840000601', ['general_manager'])
  ST = await R.staff('Mani', '9840000602', ['stores'])
  AC = await R.staff('Lakshmi', '9840000603', ['accounts'])
  AC2 = await R.staff('Ganesh', '9840000604', ['accounts'])
  await R.post('/api/items/from-departments', ST)
  ONION = (await R.get('/api/items?q=onion', ST)).json()[0].id
  await patch(`/api/items/${ONION}`, ST, { hsn: '0703', gstRate: 0 })
  RICE = (await R.post('/api/items', ST, { name: 'Ponni rice', category: 'food', unit: 'g', purchaseUnit: 'bag of 25 kg', purchaseFactor: 25000, hsn: '1006', gstRate: 5, defaultStoreId: 'ST-MAIN' })).json().id
  TISSUE = (await R.post('/api/items', ST, { name: 'Toilet roll', category: 'housekeeping', unit: 'pcs', purchaseUnit: 'case of 48', purchaseFactor: 48, hsn: '4818', gstRate: 18, itc: 'blocked', defaultStoreId: 'ST-HK' })).json().id
  MILK = (await R.post('/api/items', ST, { name: 'Milk packet', category: 'food', unit: 'ml', purchaseUnit: 'litre', purchaseFactor: 1000, hsn: '0401', gstRate: 0, perishable: true, shelfLifeDays: 2, defaultStoreId: 'ST-MAIN' })).json().id
  KUMAR = (await R.post('/api/vendors', ST, { name: 'Kumar Provisions', pan: 'ABCPK1234L', msme: 'micro', udyamNo: 'UDYAM-TN-02-0012345', writtenAgreement: true, paymentTermsDays: 60 })).json().id
  SHAH = (await R.post('/api/vendors', ST, { name: 'Shah Paper', pan: 'ABCPS1234M', msme: 'small', udyamNo: 'UDYAM-TN-02-0099999' })).json().id
  RAVI = (await R.post('/api/vendors', ST, { name: 'Ravi Garden Contractors', pan: 'ABCPR1234K', tdsCode: 'contractor' })).json().id
  for (const [v, i, rate] of [[KUMAR, RICE, 1450], [KUMAR, ONION, 32], [SHAH, TISSUE, 1150]] as const) {
    await R.post('/api/rate-contracts', ST, { vendorId: v, itemId: i, rate, validFrom: '2026-10-01', validTo: '2027-03-31' })
  }
  PO = (await R.post('/api/pos', ST, { vendorId: KUMAR, storeId: 'ST-MAIN', lines: [{ itemId: RICE, qty: 4 }] })).json().id
  await R.post(`/api/pos/${PO}/submit`, ST)
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM, AC, AC2]) await R.get('/api/business-date', t) })

describe('goods received', () => {
  let KPO = ''
  it('posts accepted goods into the store\'s own ledger, at the PO rate', async () => {
    expect((await R.post('/api/grns', AC, { poId: PO, lines: [{ poLine: 1, qtyReceived: 4 }] })).statusCode).toBe(403)
    const g = (await R.post('/api/grns', ST, { poId: PO, challanNo: 'DC-881', lines: [{ poLine: 1, qtyReceived: 4 }] })).json()
    expect(g).toMatchObject({ number: 'GRN/26-27/000001', valuePaise: 580000 })
    expect((await R.get(`/api/pos/${PO}`, ST)).json().status).toBe('received')
    expect((await R.post('/api/grns', ST, { poId: PO, lines: [{ poLine: 1, qtyReceived: 1 }] })).json().error).toMatch(/already been received/)
  })

  it('posts into the kitchen book for a kitchen delivery, with rejects and the over-delivery limit', async () => {
    KPO = (await R.post('/api/pos', ST, { vendorId: KUMAR, storeId: 'ST-KITCHEN', lines: [{ itemId: ONION, qty: 30 }] })).json().id
    await R.post(`/api/pos/${KPO}/submit`, ST)
    const before = await onionStock()
    expect((await R.post('/api/grns', ST, { poId: KPO, lines: [{ poLine: 1, qtyReceived: 30, qtyAccepted: 28 }] })).json().error).toMatch(/say why 2 was rejected/)
    await R.post('/api/grns', ST, { poId: KPO, lines: [{ poLine: 1, qtyReceived: 30, qtyAccepted: 28, rejectReason: 'Rotten' }] })
    const after = await onionStock()
    expect(after.stock - before.stock).toBe(28000)
    expect(after.costPerPack).toBe(32)                       // ₹32 a kg, from this delivery
    expect((await R.get(`/api/pos/${KPO}`, ST)).json().status).toBe('partly_received')
    expect((await R.post('/api/grns', ST, { poId: KPO, lines: [{ poLine: 1, qtyReceived: 5 }] })).json().error).toMatch(/more than the 30 ordered/)
    await R.post('/api/grns', ST, { poId: KPO, lines: [{ poLine: 1, qtyReceived: 2 }] })
    expect((await R.get(`/api/pos/${KPO}`, ST)).json().status).toBe('received')
  })

  it('takes a cash market purchase without a PO only with the reason, and keeps perishable batches with expiry', async () => {
    expect((await R.post('/api/grns', ST, { vendorId: KUMAR, storeId: 'ST-MAIN', lines: [{ itemId: MILK, qtyReceived: 10, rate: 56 }] })).json().error).toMatch(/why there is no purchase order/)
    await R.post('/api/grns', ST, { vendorId: KUMAR, storeId: 'ST-MAIN', note: 'Milk short for breakfast', lines: [{ itemId: MILK, qtyReceived: 10, rate: 56, batchNo: 'AAVIN-1101' }] })
    expect((await audit('grn.without_po'))[0]).toMatchObject({ note: 'Milk short for breakfast' })
    const exp = (await R.get('/api/stock/expiring?days=3', ST)).json()
    expect(exp[0]).toMatchObject({ item: 'Milk packet', expiry: '2026-11-03', qty_left: '10000.000', batch_no: 'AAVIN-1101' })
  })
})

describe('vendor bills', () => {
  let B1 = ''
  it('matches a bill three ways and flags the differences', async () => {
    expect((await R.post('/api/bills', ST, { vendorId: KUMAR, billNo: 'K-1', billDate: '2026-11-01', poId: PO, lines: [] })).statusCode).toBe(403)
    const kpo = (await R.get('/api/pos?status=all', ST)).json().find((p: { store: string }) => p.store === 'Kitchen store').id
    const r = (await R.post('/api/bills', AC, { vendorId: KUMAR, billNo: 'K-1041', billDate: '2026-11-01', poId: kpo, lines: [{ itemId: ONION, qty: 31, rate: 34 }] })).json()
    B1 = r.id
    expect(r.match).toBe('difference')
    expect(r.differences).toEqual(['Onion: billed at ₹34.00, ordered at ₹32.00', 'Onion: billed 31, received and not yet billed 30'])
    // A micro supplier with a written agreement: 45 days; their own terms (60) cannot go past it.
    expect(r).toMatchObject({ msmeDueDate: '2026-12-16', dueDate: '2026-12-16' })
    expect((await R.post('/api/bills', AC, { vendorId: KUMAR, billNo: 'k-1041', billDate: '2026-11-01', lines: [{ itemId: ONION, qty: 1, rate: 1 }] })).statusCode).toBe(409)
  })

  it('needs the GM, with a reason, to pass a bill that does not match', async () => {
    expect((await R.post(`/api/bills/${B1}/approve`, AC2)).json().error).toMatch(/GM decides/)
    expect((await R.post(`/api/bills/${B1}/approve`, GM)).json().error).toMatch(/why/)
    await R.post(`/api/bills/${B1}/approve`, GM, { reason: 'Onion price went up; 1 kg extra agreed by phone' })
  })

  it('lets a second person in accounts pass a matching bill; blocked GST counts in the goods\' cost', async () => {
    const po = (await R.post('/api/pos', ST, { vendorId: SHAH, storeId: 'ST-HK', lines: [{ itemId: TISSUE, qty: 2 }] })).json().id
    await R.post(`/api/pos/${po}/submit`, ST)
    await R.post('/api/grns', ST, { poId: po, lines: [{ poLine: 1, qtyReceived: 2 }] })
    const stock = (await R.get('/api/audit?limit=5', R.md)).json()
    expect(stock[0]).toMatchObject({ action: 'grn.add', amount: 230000 })
    const r = (await R.post('/api/bills', AC, { vendorId: SHAH, billNo: 'SP/77', billDate: '2026-10-27', poId: po, lines: [{ itemId: TISSUE, qty: 2, rate: 1150 }] })).json()
    expect(r).toMatchObject({ match: 'matched', totalPaise: 271400, msmeDueDate: '2026-11-11' })   // small, no agreement: 15 days
    expect((await R.post(`/api/bills/${r.id}/approve`, AC)).json().error).toMatch(/Someone other/)
    await R.post(`/api/bills/${r.id}/approve`, AC2)
    const bill = (await R.get('/api/bills', AC)).json().find((b: { id: string }) => b.id === r.id)
    expect(bill).toMatchObject({ status: 'approved', daysToDue: 10 })
    expect(Number(bill.itc_paise)).toBe(0)                    // GST on toilet rolls is blocked here
  })

  it('alerts MSME bills ten days before the payment deadline', async () => {
    const alerts = await audit('msme.payment_due')
    expect(alerts.map((a: { after: { vendor: string } }) => a.after.vendor)).toEqual(['Shah Paper'])
  })
})

describe('payments', () => {
  it('pays approved bills, marked paid with the UTR', async () => {
    const [bill] = (await R.get(`/api/bills?vendorId=${SHAH}`, AC)).json()
    const pv = (await R.post('/api/payments/preview', AC, { vendorId: SHAH, billIds: [bill.id] })).json()
    expect(pv).toMatchObject({ gross: 271400, tds: 0, net: 271400 })
    const p = (await R.post('/api/payments', AC, { vendorId: SHAH, billIds: [bill.id], mode: 'bank' })).json()
    expect(p).toMatchObject({ number: 'PAY/26-27/000001', status: 'approved' })
    expect((await R.post('/api/payments', AC, { vendorId: SHAH, billIds: [bill.id], mode: 'bank' })).json().error).toMatch(/already on payment/)
    expect((await R.post(`/api/payments/${p.id}/paid`, AC)).json().error).toMatch(/UTR/)
    await R.post(`/api/payments/${p.id}/paid`, AC, { reference: 'SBIN226305123456' })
    const paid = (await R.get(`/api/bills?status=all&vendorId=${SHAH}`, AC)).json()[0]
    expect(paid.status).toBe('paid')
    expect(Number(paid.balance_paise)).toBe(0)
  })

  it('deducts contractor TDS on the value before GST, with the GM approving above the accounts limit', async () => {
    const bill = (await R.post('/api/bills', AC, { vendorId: RAVI, billNo: 'RGC-10', billDate: '2026-10-31', lines: [{ description: 'Garden maintenance, October', sac: '998131', qty: 1, rate: 35000, gstRate: 0 }] })).json()
    expect(bill.match).toBe('no_po')
    expect((await R.post(`/api/bills/${bill.id}/approve`, AC2)).json().error).toMatch(/without a purchase order/)
    await R.post(`/api/bills/${bill.id}/approve`, GM)
    const p = (await R.post('/api/payments', AC, { vendorId: RAVI, billIds: [bill.id], mode: 'bank' })).json()
    expect(p).toMatchObject({ gross: 3500000, tds: 35000, net: 3465000, section: '194C', status: 'pending_approval' })   // 1% for an individual
    expect((await R.post(`/api/payments/${p.id}/paid`, AC, { reference: 'X' })).json().error).toMatch(/waiting for the GM/)
    await R.post(`/api/approvals/${p.approvalId}/decide`, GM, { decision: 'approve' })
    await R.post(`/api/payments/${p.id}/paid`, AC, { reference: 'HDFC0012345' })
    const tds = (await R.get('/api/tds', AC)).json()
    expect(tds).toMatchObject({ fy: '2026-27', summary: [{ section: '194C', quarter: 3, entries: 1 }] })
    expect(Number(tds.summary[0].tds_paise)).toBe(35000)
    expect(tds.entries[0]).toMatchObject({ vendor: 'Ravi Garden Contractors', pan: 'ABCPR1234K' })
  })

  it('warns before paying one party more than ₹10,000 in cash in a day', async () => {
    const bill = (await R.post('/api/bills', AC, { vendorId: KUMAR, billNo: 'K-1100', billDate: '2026-11-01', lines: [{ description: 'Festival sweets for staff', qty: 1, rate: 15000, gstRate: 5 }] })).json()
    await R.post(`/api/bills/${bill.id}/approve`, GM)
    const r = await R.post('/api/payments', AC, { vendorId: KUMAR, billIds: [bill.id], mode: 'cash' })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ cashWarning: true, error: expect.stringMatching(/not deductible/) })
    expect((await R.post('/api/payments', AC, { vendorId: KUMAR, billIds: [bill.id], mode: 'bank' })).json().status).toBe('approved')
  })
})
