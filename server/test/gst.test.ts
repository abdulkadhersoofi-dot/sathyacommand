import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// GST returns for November: a company stay with an October advance, restaurant and bar sales, a credit note,
// a vendor bill in GSTR-2B and one not yet, reverse charge on a security agency, IMS, the common-credit
// reversal, the upload file, and both returns filed (the set-off posted, the month's credit closed).

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', NA = '', CAP = '', BM = '', AC = '', AC2 = '', GM = ''
let RES = '', FOLIO = '', INVOICE = '', REPAIR = '', SECURITY = '', LATE = ''
const COMPANY_GSTIN = '29AABCT1332L1ZA'
const VENDOR_GSTIN = '33AAACS1234A1Z9'
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const twoB = `GSTIN of supplier,Trade/Legal name,Invoice number,Invoice type,Invoice Date,Invoice Value,Place of supply,Supply Attract Reverse Charge,Rate(%),Taxable Value,Integrated Tax,Central Tax,State/UT Tax,Cess,ITC Availability,Reason
${VENDOR_GSTIN},SRI GANESH ELECTRICALS,SGE/112,Regular,02-11-2026,11800.00,Tamil Nadu,N,18,10000.00,0,900.00,900.00,0,Yes,
33AAACM9999A1Z5,MYSTERY TRADERS,MT-55,Regular,05-11-2026,1180.00,Tamil Nadu,N,18,1000.00,0,90.00,90.00,0,Yes,`
const gst = async () => (await R.get('/api/gst/2026-11', AC)).json()
const bal = async (code: string) => (await R.get(`/api/accounts/ledger?code=${code}&from=2026-04-01`, AC)).json().closingPaise as number
async function order(outletId: string, tableId: string, items: { itemId: string; qty?: number }[], token = CAP) {
  const o = (await R.post('/api/fnb/orders', token, { outletId, tableId, covers: 2 })).json()
  await R.post(`/api/fnb/orders/${o.id}/items`, token, { items })
  await R.post(`/api/fnb/orders/${o.id}/send`, token)
  return (await R.post(`/api/fnb/orders/${o.id}/bill`, token, {})).json().bills[0]
}

beforeAll(async () => {
  R = await testResort('2026-11-04')
  // The clock is in November; the books start with October's last days (and the rates from October).
  await R.db.query(`update property set business_date = '2026-10-30'`)
  await R.db.query(`update rate set valid_from = '2026-10-01'`)
  FD = await R.staff('Priya', '9840001201', ['reception'])
  NA = await R.staff('Senthil', '9840001202', ['night_auditor'])
  CAP = await R.staff('Murugan', '9840001203', ['captain'])
  BM = await R.staff('Joseph', '9840001204', ['bar_manager'])
  AC = await R.staff('Meena', '9840001205', ['accounts'])
  AC2 = await R.staff('Ganesh', '9840001206', ['accounts'])
  GM = await R.staff('Karthik', '9840001207', ['general_manager'])
  await put('/api/fnb/bar-settings', GM, { open: '00:00', close: '23:59' })
  await put('/api/vat-rates/beer', AC, { rate: 14.5 })
  await R.post('/api/licences', AC, { kind: 'tn_vat', name: 'TN VAT registration', number: '33123456789' })
  await R.post('/api/licences', AC, { kind: 'fssai', name: 'FSSAI', number: '12423008000123' })
  await R.post('/api/cashier/open', FD, { openingFloat: 0 })
  await R.post('/api/cashier/open', CAP, { openingFloat: 0 })
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM, AC, AC2]) await R.get('/api/business-date', t) })

describe('November\'s supplies', () => {
  it('records an October advance, a November company stay, consumer and liquor sales, and a credit note', async () => {
    const rr = await R.post('/api/reservations', FD, { guest: { name: 'Ravi Shankar' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-02', departure: '2026-11-03',
      billToCompany: 'Tvs Logistics Private Limited', billToGstin: COMPANY_GSTIN, billToAddress: '12 Residency Road', billToCity: 'Bengaluru', billToPin: '560025' })
    RES = rr.json().id
    FOLIO = (await R.get(`/api/reservations/${RES}`, FD)).json().folios[0].id
    await R.post(`/api/folios/${FOLIO}/payments`, FD, { method: 'upi', amount: 2100, reference: 'UPI-4471' })   // ₹2,000 + 5% GST, in October
    for (let i = 0; i < 3; i++) await R.post('/api/night-audit', NA)                                         // to 11-02
    await R.post(`/api/reservations/${RES}/check-in`, FD, { spaceId: 'RM-110', idType: 'passport', idNumber: 'Z1234567' })
    await R.post(`/api/folios/${FOLIO}/charges`, FD, { kind: 'laundry', description: 'Laundry', amount: 300 })
    const food = await order('DINE', 'DINE-T1', [{ itemId: 'DINE-BF02', qty: 2 }, { itemId: 'DINE-BV01', qty: 2 }])
    await R.post(`/api/fnb/bills/${food.id}/settle`, CAP, { payments: [{ method: 'cash', amount: food.amounts.payable / 100 }] })
    const beer = await order('BAR', 'BAR-B1', [{ itemId: 'BAR-BR01', qty: 2 }], BM)
    await R.post(`/api/fnb/bills/${beer.id}/settle`, BM, { payments: [{ method: 'card', amount: beer.amounts.payable / 100, reference: 'SLIP 7' }] })
    await R.post('/api/night-audit', NA)                                                                     // to 11-03
    const due = (await R.post(`/api/reservations/${RES}/check-out`, FD)).json().balance
    await R.post(`/api/folios/${FOLIO}/payments`, FD, { method: 'company', amount: due / 100 })
    INVOICE = (await R.post(`/api/reservations/${RES}/check-out`, FD)).json().invoice.id
    expect((await R.post(`/api/tax-documents/${INVOICE}/credit-notes`, AC, { amount: 400, gstRate: 5, reason: 'Late check-out waived' })).statusCode).toBe(201)
  })

  it('takes reverse charge on a security agency\'s bill: the GST is owed to the government, not the agency', async () => {
    const repairs = (await R.post('/api/vendors', AC, { name: 'Sri Ganesh Electricals', gstin: VENDOR_GSTIN })).json().id
    const guards = (await R.post('/api/vendors', AC, { name: 'Raman Security Services', pan: 'ABCPR1234K' })).json().id
    const r1 = (await R.post('/api/bills', AC, { vendorId: repairs, billNo: 'SGE/112', billDate: '2026-11-02', lines: [{ description: 'Pump panel repair', sac: '998714', qty: 1, rate: 10000, gstRate: 18 }] })).json()
    REPAIR = r1.id
    await R.post(`/api/bills/${REPAIR}/approve`, GM, { reason: 'Emergency repair' })
    const r2 = (await R.post('/api/bills', AC, { vendorId: guards, billNo: 'RSS-11', billDate: '2026-11-02', lines: [{ description: 'Security guards, November', sac: '998525', qty: 1, rate: 20000, gstRate: 18, rcm: true }] })).json()
    expect(r2).toMatchObject({ totalPaise: 2000000, rcmPaise: 360000 })
    SECURITY = r2.id
    await R.post(`/api/bills/${SECURITY}/approve`, GM, { reason: 'Monthly contract' })
    expect(await bal('2202') + await bal('2203')).toBe(-360000)
    const r3 = (await R.post('/api/bills', AC, { vendorId: repairs, billNo: 'SGE/118', billDate: '2026-11-03', lines: [{ description: 'Wiring', sac: '998714', qty: 1, rate: 5000, gstRate: 18 }] })).json()
    LATE = r3.id
    await R.post(`/api/bills/${LATE}/approve`, GM, { reason: 'Repair' })
    expect((await R.post('/api/bills', AC, { vendorId: guards, billNo: 'X', billDate: '2026-11-02', lines: [{ description: 'Guards', qty: 1, rate: 100, gstRate: 0, rcm: true }] })).statusCode).toBe(400)
  })
})

describe('GSTR-1', () => {
  it('tables the month: B2B, consumer summary, credit notes, advances adjusted, HSN, documents, liquor outside GST', async () => {
    const g = (await gst()).gstr1
    expect(g.b2b).toHaveLength(1)
    expect(g.b2b[0]).toMatchObject({ gstin: COMPANY_GSTIN, pos: '33' })
    expect(g.b2b[0].items.map((i: { rate: number }) => i.rate).sort((a: number, b: number) => a - b)).toEqual([5, 18])
    expect(g.b2cs).toEqual([expect.objectContaining({ rate: 5, taxable: 40000, cgst: 1000, sgst: 1000 })])
    expect(g.cdnr).toEqual([expect.objectContaining({ gstin: COMPANY_GSTIN, items: [expect.objectContaining({ rate: 5, taxable: 40000 })] })])
    expect(g.at).toEqual([])
    expect(g.atadj).toEqual([expect.objectContaining({ rate: 5, taxable: 200000, cgst: 5000, sgst: 5000 })])
    expect(g.nonGst).toBe(64000)
    expect(g.documents.map((d: { type: string; total: number }) => `${d.type}:${d.total}`).sort()).toEqual(['credit_note:1', 'fnb_invoice:1', 'invoice:1'])
    expect(g.hsnB2c).toEqual([expect.objectContaining({ sac: '996331', rate: 5, taxable: 40000 })])
  })

  it('gives the upload file for the portal\'s offline tool', async () => {
    const j = (await R.get('/api/gst/2026-11/gstr1.json', AC)).json()
    expect(j).toMatchObject({ gstin: '33AAACS1234A1Z9', fp: '112026' })
    expect(j.b2b[0]).toMatchObject({ ctin: COMPANY_GSTIN, inv: [expect.objectContaining({ pos: '33', rchrg: 'N', inv_typ: 'R' })] })
    expect(j.b2cs).toEqual([{ sply_ty: 'INTRA', pos: '33', typ: 'OE', txval: 400, rt: 5, camt: 10, samt: 10, csamt: 0 }])
    expect(j.txpd).toEqual([{ pos: '33', sply_ty: 'INTRA', itms: [{ rt: 5, ad_amt: 2000, camt: 50, samt: 50, csamt: 0 }] }])
    expect(j.nil).toEqual({ inv: [{ sply_ty: 'INTRAB2C', nil_amt: 0, expt_amt: 0, ngsup_amt: 640 }] })
    expect(j.doc_issue.doc_det.map((d: { doc_num: number }) => d.doc_num).sort()).toEqual([1, 5])
  })
})

describe('GSTR-2B, IMS and GSTR-3B', () => {

  it('claims credit only for bills in GSTR-2B, and lists the rest as waiting', async () => {
    const r = (await R.post('/api/gst/2b/import', AC, { period: '2026-11', text: twoB, fileName: 'GSTR2B_112026.csv' })).json()
    expect(r).toMatchObject({ lines: 2, matched: 1 })
    const g = await gst()
    expect(g.twoB.lines.map((l: { doc_no: string; status: string }) => `${l.doc_no}:${l.status}`).sort()).toEqual(['MT-55:unmatched', 'SGE/112:matched'])
    expect(g.twoB.waiting.map((w: { bill_no: string }) => w.bill_no)).toEqual(['SGE/118'])
    const b3 = g.gstr3b
    expect(b3.from2b).toBe(true)
    expect(b3.itc.otherBills).toEqual({ igst: 0, cgst: 90000, sgst: 90000 })
    expect(b3.itc.rcm).toEqual({ igst: 0, cgst: 180000, sgst: 180000 })
    expect(b3.rcm).toMatchObject({ taxable: 2000000, cgst: 180000, sgst: 180000 })
    expect(b3.nonGst).toBe(64000)
  })

  it('reverses the credit in the share of supplies that carry none, and pays reverse charge in cash', async () => {
    const b3 = (await gst()).gstr3b
    const g1 = (await gst()).gstr1
    expect(b3.outward.cgst).toBe(g1.totals.cgst + g1.totals.advances.cgst)
    expect(b3.itc.reversalShare).toBeGreaterThan(80)
    expect(Math.abs(b3.itc.reversal.cgst - b3.itc.total.cgst * b3.itc.reversalShare / 100)).toBeLessThan(b3.itc.total.cgst / 10000 + 1)   // the share is shown to 2 decimals
    expect(b3.payment.cash.cgst).toBeGreaterThanOrEqual(180000)
    expect(b3.payment.cashTotal).toBe(b3.payment.cash.cgst + b3.payment.cash.sgst + b3.payment.cash.igst)
  })

  it('leaves a rejected invoice out of the credit', async () => {
    expect((await R.post(`/api/bills/${REPAIR}/ims`, AC, { action: 'rejected' })).json().error).toMatch(/Why/)
    await R.post(`/api/bills/${REPAIR}/ims`, AC, { action: 'rejected', note: 'Rate should be 12%' })
    expect((await gst()).gstr3b.itc.otherBills).toEqual({ igst: 0, cgst: 0, sgst: 0 })
    await R.post(`/api/bills/${REPAIR}/ims`, AC, { action: 'accepted' })
  })
})

describe('filing', () => {
  it('files GSTR-1 and GSTR-3B: figures kept, set-off posted, late fee worked out, the month\'s credit closed', async () => {
    expect((await R.post('/api/gst/returns', AC, { period: '2026-11', form: 'GSTR1', arn: 'AA3311260012345' })).json().error).toMatch(/not over/)
    await R.db.query(`update property set business_date = '2026-12-25'`)
    expect((await R.post('/api/gst/returns', AC, { period: '2026-11', form: 'GSTR1', arn: 'AA3311260012345', filedOn: '2026-12-10' })).statusCode).toBe(201)
    const before = (await gst()).gstr3b
    const r = (await R.post('/api/gst/returns', AC, { period: '2026-11', form: 'GSTR3B', arn: 'AA3311260054321', filedOn: '2026-12-25' })).json()
    expect(r).toMatchObject({ cashPaise: before.payment.cashTotal, lateFeePaise: 25000 })        // 5 days after the 20th
    expect(await bal('2220')).toBe(-before.payment.cashTotal)
    expect(await bal('2202') + await bal('2203')).toBe(0)
    expect(await bal('6090')).toBe(before.itc.reversal.cgst + before.itc.reversal.sgst + before.itc.reversal.igst)
    expect((await R.post('/api/gst/returns', AC, { period: '2026-11', form: 'GSTR3B', arn: 'AA3311260054322' })).statusCode).toBe(409)
    expect((await R.post(`/api/bills/${REPAIR}/ims`, AC, { action: 'rejected', note: 'too late' })).json().error).toMatch(/already filed/)
    expect((await R.post('/api/gst/2b/import', AC, { period: '2026-11', text: twoB })).statusCode).toBe(409)
    expect((await gst()).filed.map((f: { form: string }) => f.form).sort()).toEqual(['GSTR1', 'GSTR3B'])
    const t = (await R.get('/api/accounts/trial-balance?from=2026-04-01', AC)).json()
    expect(t.totals.closingDebitPaise).toBe(t.totals.closingCreditPaise)
  })
})
