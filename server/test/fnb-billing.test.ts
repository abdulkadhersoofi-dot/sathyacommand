import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Restaurant and bar bills: GST invoice for food, TN VAT invoice for liquor, one payment; splits,
// discounts within limits, company bills, charging to the room, reprints and the day's figures.

let R: Awaited<ReturnType<typeof testResort>>
let CAP = '', FNB = '', GM = '', ACC = '', BAR = '', FD = '', NA = ''
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })

async function order(outletId: string, tableId: string, items: { itemId: string; qty?: number }[], token = CAP) {
  const o = (await R.post('/api/fnb/orders', token, { outletId, tableId, covers: 2 })).json()
  await R.post(`/api/fnb/orders/${o.id}/items`, token, { items })
  await R.post(`/api/fnb/orders/${o.id}/send`, token)
  return o.id as string
}
const ids: Record<string, string> = {}
const bills = async (orderId: string) => (await R.get(`/api/fnb/orders/${orderId}/bills`, CAP)).json()

beforeAll(async () => {
  R = await testResort('2026-11-01')
  CAP = await R.staff('Murugan', '9840000031', ['captain'])
  FNB = await R.staff('Lakshmi', '9840000032', ['fnb_manager'])
  GM = await R.staff('Karthik', '9840000033', ['general_manager'])
  ACC = await R.staff('Meena', '9840000034', ['accounts'])
  BAR = await R.staff('Joseph', '9840000035', ['bartender'])
  FD = await R.staff('Priya', '9840000036', ['reception'])
  NA = await R.staff('Senthil', '9840000037', ['night_auditor'])
  await put('/api/fnb/bar-settings', GM, { open: '00:00', close: '23:59' })
  await put('/api/vat-rates/beer', ACC, { rate: 14.5 })
}, 40_000)
afterAll(() => R.close())

describe('a food bill', () => {
  it('needs everything sent to the kitchen first, then bills with 5% GST', async () => {
    const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'DINE', tableId: 'DINE-T1', covers: 2 })).json()
    await R.post(`/api/fnb/orders/${o.id}/items`, CAP, { items: [{ itemId: 'DINE-BF02', qty: 2 }, { itemId: 'DINE-BV01', qty: 2 }] })
    expect((await R.post(`/api/fnb/orders/${o.id}/bill`, CAP, {})).json().error).toMatch(/not yet sent/)
    await R.post(`/api/fnb/orders/${o.id}/send`, CAP)
    const r = await R.post(`/api/fnb/orders/${o.id}/bill`, CAP, {})
    expect(r.statusCode).toBe(201)
    expect(r.json().bills[0].amounts).toMatchObject({ foodTaxable: 40000, cgst: 1000, sgst: 1000, total: 42000, payable: 42000, liquor: [] })
    expect((await R.post(`/api/fnb/orders/${o.id}/items`, CAP, { items: [{ itemId: 'DINE-BV02' }] })).statusCode).toBe(409)
    const tables = (await R.get('/api/fnb/tables?outletId=DINE', CAP)).json()
    expect(tables.find((t: { label: string }) => t.label === 'T1').order_status).toBe('billed')
    ids.T1 = o.id
  })

  it('takes cash only in an open cashier shift, then issues the GST invoice and frees the table', async () => {
    const [bill] = await bills(ids.T1)
    expect((await R.post(`/api/fnb/bills/${bill.id}/settle`, CAP, { payments: [{ method: 'cash', amount: 420 }] })).json().error).toMatch(/cashier shift/)
    await R.post('/api/cashier/open', CAP, { openingFloat: 1000 })
    expect((await R.post(`/api/fnb/bills/${bill.id}/settle`, CAP, { payments: [{ method: 'cash', amount: 400 }] })).json().error).toMatch(/add up to/)
    expect((await R.post(`/api/fnb/bills/${bill.id}/settle`, CAP, { payments: [{ method: 'upi', amount: 420 }] })).json().error).toMatch(/reference/)
    const s = (await R.post(`/api/fnb/bills/${bill.id}/settle`, CAP, { payments: [{ method: 'cash', amount: 200 }, { method: 'upi', amount: 220, reference: 'UTR123456' }] })).json()
    expect(s).toMatchObject({ ok: true, gstInvoice: 'RST/26-27/000001', vatInvoice: null, orderClosed: true })
    expect((await R.get('/api/cashier/current', CAP)).json()).toMatchObject({ cashTaken: 20000, expectedInDrawer: 120000 })
    const tables = (await R.get('/api/fnb/tables?outletId=DINE', CAP)).json()
    expect(tables.find((t: { label: string }) => t.label === 'T1').order_id).toBeNull()
    const docs = (await R.get('/api/tax-documents?type=fnb_invoice', ACC)).json()
    expect(docs[0]).toMatchObject({ number: 'RST/26-27/000001' })
    const doc = (await R.get(`/api/tax-documents/${docs[0].id}`, ACC)).json()
    expect(doc.lines[0]).toMatchObject({ description: '2 × Masala Dosa', sac: '996331', gstRate: 5, taxable: 28000, cgst: 700 })
  })

  it('cancels a bill to add more, and refuses to settle twice', async () => {
    const id = await order('DINE', 'DINE-T2', [{ itemId: 'DINE-SI03' }])
    await R.post(`/api/fnb/orders/${id}/bill`, CAP, {})
    expect((await R.post(`/api/fnb/orders/${id}/unbill`, CAP)).json()).toEqual({ ok: true })
    await R.post(`/api/fnb/orders/${id}/items`, CAP, { items: [{ itemId: 'DINE-BV02' }] })
    await R.post(`/api/fnb/orders/${id}/send`, CAP)
    const [b] = (await R.post(`/api/fnb/orders/${id}/bill`, CAP, {})).json().bills
    expect(b.amounts.foodTaxable).toBe(24000)
    await R.post(`/api/fnb/bills/${b.id}/settle`, CAP, { payments: [{ method: 'card', amount: 252, reference: 'SLIP 0042' }] })
    expect((await R.post(`/api/fnb/bills/${b.id}/settle`, CAP, { payments: [{ method: 'card', amount: 252, reference: 'x' }] })).statusCode).toBe(409)
  })
})

describe('splitting', () => {
  it('splits equally so the parts add back to the whole', async () => {
    const id = await order('DINE', 'DINE-T3', [{ itemId: 'DINE-NI01' }, { itemId: 'DINE-NI02' }])  // 320 + 70 = 390
    const r = (await R.post(`/api/fnb/orders/${id}/bill`, CAP, { parts: 3 })).json().bills
    expect(r.map((b: { amounts: { foodTaxable: number } }) => b.amounts.foodTaxable)).toEqual([13000, 13000, 13000])
    expect(r[0].amounts.food[0].description).toBe('1 × Paneer Butter Masala (share 1 of 3)')
    const id2 = await order('DINE', 'DINE-T4', [{ itemId: 'DINE-BV01' }])   // 60
    const r2 = (await R.post(`/api/fnb/orders/${id2}/bill`, CAP, { parts: 7 })).json().bills
    expect(r2.reduce((a: number, b: { amounts: { foodTaxable: number } }) => a + b.amounts.foodTaxable, 0)).toBe(6000)
  })

  it('splits item by item, and every item must be on exactly one bill', async () => {
    const id = await order('DINE', 'DINE-T5', [{ itemId: 'DINE-SI01' }, { itemId: 'DINE-SI02' }])
    const all = (await R.get(`/api/fnb/orders/${id}`, CAP)).json().items as { id: string; name: string }[]
    const items = ['Chettinad Chicken', 'Meals (unlimited)'].map((n) => all.find((i) => i.name === n)!.id)
    expect((await R.post(`/api/fnb/orders/${id}/bill`, CAP, { groups: [[items[0]]] })).statusCode).toBe(400)
    const r = (await R.post(`/api/fnb/orders/${id}/bill`, CAP, { groups: [[items[0]], [items[1]]] })).json().bills
    expect(r.map((b: { amounts: { foodTaxable: number } }) => b.amounts.foodTaxable)).toEqual([38000, 26000])
  })

  it('merges two tables into one order', async () => {
    const a = await order('DINE', 'DINE-T6', [{ itemId: 'DINE-BV01' }])
    const b = await order('DINE', 'DINE-T8', [{ itemId: 'DINE-BV02' }])
    expect((await R.post(`/api/fnb/orders/${a}/merge`, CAP, { fromOrderId: b })).json()).toEqual({ ok: true })
    const o = (await R.get(`/api/fnb/orders/${a}`, CAP)).json()
    expect(o.items).toHaveLength(2)
    expect(o.covers).toBe(4)
    const tables = (await R.get('/api/fnb/tables?outletId=DINE', CAP)).json()
    expect(tables.find((t: { label: string }) => t.label === 'T8').order_id).toBeNull()
  })
})

describe('discounts and service charge', () => {
  it('holds a discount above the role limit for a manager, then applies it', async () => {
    const id = await order('DINE', 'DINE-T9', [{ itemId: 'DINE-SI01' }])   // 380
    expect((await R.post(`/api/fnb/orders/${id}/bill`, CAP, { discountPercent: 10 })).json().error).toMatch(/reason/)
    const r = await R.post(`/api/fnb/orders/${id}/bill`, CAP, { discountPercent: 10, discountReason: 'Regular guest' })
    expect(r.statusCode).toBe(202)
    expect(r.json().bills[0].amounts.foodDiscount).toBe(0)
    const a = (await R.get('/api/approvals', FNB)).json().find((x: { kind: string }) => x.kind === 'fnb.discount')
    expect(a.payload).toMatchObject({ percent: 10, order: expect.any(Number) })
    expect((await R.post(`/api/approvals/${a.id}/decide`, FNB, { decision: 'approve' })).json().status).toBe('approved')
    const [b] = await bills(id)
    expect(b.amounts).toMatchObject({ foodDiscount: 3800, foodTaxable: 34200, cgst: 855, payable: 35900 })
    expect(b.discount_reason).toBe('Regular guest')
  })

  it('lets a manager discount within their own limit, and refuses an approver whose limit is lower', async () => {
    const id = await order('DINE', 'DINE-T10', [{ itemId: 'DINE-SI02' }])
    expect((await R.post(`/api/fnb/orders/${id}/bill`, FNB, { discountPercent: 15, discountReason: 'Late food' })).statusCode).toBe(201)
    const id2 = await order('DINE', 'DINE-T11', [{ itemId: 'DINE-SI02' }])
    await R.post(`/api/fnb/orders/${id2}/bill`, CAP, { discountPercent: 22, discountReason: 'Complaint' })
    const a = (await R.get('/api/approvals', FNB)).json().find((x: { kind: string; payload: { percent: number } }) => x.kind === 'fnb.discount' && x.payload.percent === 22)
    expect((await R.post(`/api/approvals/${a.id}/decide`, FNB, { decision: 'approve' })).json().error).toMatch(/limit is below 22%/)
    expect((await R.post(`/api/approvals/${a.id}/decide`, GM, { decision: 'approve' })).json().status).toBe('approved')
  })

  it('adds an optional service charge, taxed with the food, which the guest can decline', async () => {
    await put('/api/fnb/billing-settings', GM, { serviceChargePercent: 5, upiVpa: 'sathyaresorts@okaxis', upiPayee: 'Sathya Park Resorts' })
    const id = await order('DINE', 'DINE-T12', [{ itemId: 'DINE-SI01' }])   // 380
    const [b] = (await R.post(`/api/fnb/orders/${id}/bill`, CAP, {})).json().bills
    expect(b.amounts).toMatchObject({ service: 1900, foodTaxable: 39900, cgst: 998, sgst: 998, total: 41896, roundOff: 4, payable: 41900 })
    const [b2] = (await R.post(`/api/fnb/orders/${id}/bill`, CAP, { serviceCharge: false })).json().bills
    expect(b2.amounts.service).toBe(0)
    await put('/api/fnb/billing-settings', GM, { serviceChargePercent: 0 })
  })
})

describe('liquor', () => {
  it('needs every VAT rate and the TN VAT registration before a liquor bill can be paid', async () => {
    const id = await order('BAR', 'BAR-B1', [{ itemId: 'BAR-BR01', qty: 2 }, { itemId: 'BAR-SP01' }, { itemId: 'BAR-BS01' }], BAR)
    let [b] = (await R.post(`/api/fnb/orders/${id}/bill`, BAR, {})).json().bills
    expect(b.amounts.vatMissing).toEqual(['imfl_spirits'])
    expect((await R.post(`/api/fnb/bills/${b.id}/settle`, BAR, { payments: [{ method: 'card', amount: 1, reference: 'x' }] })).json().error).toMatch(/TN VAT rate for imfl_spirits/)
    await put('/api/vat-rates/imfl_spirits', ACC, { rate: 20 })
    ;[b] = (await R.post(`/api/fnb/orders/${id}/bill`, BAR, {})).json().bills
    // beer 640 + VAT 92.80; whisky 180 + VAT 36; peanuts 120 + GST 6
    expect(b.amounts).toMatchObject({ liquorTaxable: 82000, vat: 9280 + 3600, foodTaxable: 12000, cgst: 300, sgst: 300, total: 82000 + 12880 + 12600, payable: 107500 })
    expect((await R.post(`/api/fnb/bills/${b.id}/settle`, BAR, { payments: [{ method: 'card', amount: 1075, reference: 'SLIP 77' }] })).json().error).toMatch(/TN VAT registration/)
    await R.post('/api/licences', ACC, { kind: 'tn_vat', name: 'TN VAT registration', number: '33123456789' })
    await R.post('/api/licences', ACC, { kind: 'fssai', name: 'FSSAI', number: '12423008000123' })
    const s = (await R.post(`/api/fnb/bills/${b.id}/settle`, BAR, { payments: [{ method: 'card', amount: 1075, reference: 'SLIP 77' }] })).json()
    expect(s).toMatchObject({ gstInvoice: expect.stringMatching(/^RST\/26-27\//), vatInvoice: 'VAT/26-27/000001' })
  })

  it('keeps VAT invoices final', async () => {
    await expect(R.db.query(`update vat_invoice set total_paise = 1`)).rejects.toThrow(/cannot be changed/)
  })
})

describe('company bills and room charges', () => {
  it('issues a B2B GST invoice queued for e-invoicing', async () => {
    const id = await order('DINE', 'DINE-T13', [{ itemId: 'DINE-SI02', qty: 10 }])
    expect((await R.post(`/api/fnb/orders/${id}/bill`, CAP, { billTo: { company: 'Acme', gstin: '33AAACS1234A1Z1' } })).statusCode).toBe(400)
    const [b] = (await R.post(`/api/fnb/orders/${id}/bill`, CAP, { billTo: { company: 'Kovai Textiles Pvt Ltd', gstin: '33AAACS1234A1Z9', address: 'Avinashi Road', city: 'Coimbatore', pin: '641018' } })).json().bills
    const s = (await R.post(`/api/fnb/bills/${b.id}/settle`, CAP, { payments: [{ method: 'company', amount: 2730 }] })).json()
    const docs = (await R.get('/api/tax-documents?type=fnb_invoice', ACC)).json()
    const d = docs.find((x: { number: string }) => x.number === s.gstInvoice)
    expect(d).toMatchObject({ recipient: 'Kovai Textiles Pvt Ltd', gstin: '33AAACS1234A1Z9', irn_status: 'pending' })
  })

  it('charges food and liquor to a checked-in guest\'s room; the stay invoice carries the food, the VAT invoice the liquor', async () => {
    const res = (await R.post('/api/reservations', FD, { roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-02', guest: { name: 'Anand' } })).json()
    await R.post(`/api/reservations/${res.id}/check-in`, FD, { spaceId: 'RM-105', idType: 'aadhaar', idNumber: '1111 2222 3333' })
    const id = await order('DINE', 'DINE-T14', [{ itemId: 'DINE-SI01' }, { itemId: 'DINE-BR01' }])
    const [b] = (await R.post(`/api/fnb/orders/${id}/bill`, CAP, {})).json().bills
    expect((await R.post(`/api/fnb/bills/${b.id}/settle`, CAP, { payments: [{ method: 'room', amount: 1 }, { method: 'cash', amount: 1 }] })).statusCode).toBe(400)
    const s = (await R.post(`/api/fnb/bills/${b.id}/settle`, CAP, { payments: [{ method: 'room', amount: 1 }], reservationId: res.id })).json()
    // food 380 + 19 GST; beer 320 + 46.40 VAT
    expect(s).toMatchObject({ gstInvoice: null, vatInvoice: 'VAT/26-27/000002', roomBalance: 76540 })
    const detail = (await R.get(`/api/reservations/${res.id}`, FD)).json()
    const kinds = detail.lines.map((l: { kind: string }) => l.kind)
    expect(kinds).toEqual(expect.arrayContaining(['fnb', 'liquor']))

    // Night audit posts the room; pay and check out: the stay invoice has the room and the food, not the liquor.
    await R.post('/api/night-audit', NA)
    const bal = (await R.get(`/api/reservations/${res.id}`, FD)).json()
    await R.post(`/api/folios/${bal.folios[0].id}/payments`, FD, { method: 'card', amount: bal.balance / 100, reference: 'SLIP 9' })
    const out = (await R.post(`/api/reservations/${res.id}/check-out`, FD)).json()
    const inv = (await R.get(`/api/tax-documents/${out.invoice.id}`, ACC)).json()
    expect(inv.lines.map((l: { sac: string }) => l.sac).sort()).toEqual(['996311', '996331'])
    expect(inv.lines.find((l: { sac: string }) => l.sac === '996331')).toMatchObject({ taxable: 38000, gstRate: 5 })
  })
})

describe('printing and the day\'s figures', () => {
  it('prints the bill with FSSAI and a UPI QR, and marks reprints as duplicates', async () => {
    await put('/api/fnb/billing-settings', GM, { upiVpa: 'sathyaresorts@okaxis', upiPayee: 'Sathya Park Resorts' })
    const id = await order('POOL', 'POOL-P1', [{ itemId: 'POOL-BF02' }])
    const [b] = (await R.post(`/api/fnb/orders/${id}/bill`, CAP, {})).json().bills
    const first = (await R.post(`/api/fnb/bills/${b.id}/print`, CAP)).body
    expect(first).toContain('FSSAI Lic. No. 12423008000123')
    expect(first).toContain('<svg')
    expect(first).toContain('Scan to pay ₹157.50'.replace('157.50', (b.amounts.payable / 100).toFixed(0)))
    expect(first).not.toContain('DUPLICATE')
    const again = (await R.post(`/api/fnb/bills/${b.id}/print`, CAP)).body
    expect(again).toContain('DUPLICATE COPY')
    const audit = (await R.get('/api/audit?limit=3', R.md)).json()
    expect(audit[0]).toMatchObject({ action: 'fnb_bill.reprint' })
  })

  it('reports restaurant sales, GST, VAT and open orders in the night audit', async () => {
    const r = (await R.get('/api/night-audit/2026-11-01', R.md)).json()
    expect(r.summary.fnb).toMatchObject({ chargedToRooms: 1, liquorVat: 12880 + 4640 })
    expect(r.summary.fnb.foodSales).toBeGreaterThan(0)
    expect(r.summary.fnb.payments).toMatchObject({ cash: 20000, upi: 22000, room: 76540, company: 273000 })
    expect(r.summary.fnb.openOrders.length).toBeGreaterThan(0)
  })
})

