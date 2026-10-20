import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// TDS from deduction to statement: a contractor, a professional with a lower-deduction certificate and a
// contractor without a PAN; November's tax deposited late with interest; the 26Q data and its late fee; a
// statement for the vendor; advance tax against the year's estimate; the tax calendar.

let R: Awaited<ReturnType<typeof testResort>>
let AC = '', GM = ''
const ids: Record<string, string> = {}
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const bal = async (code: string) => (await R.get(`/api/accounts/ledger?code=${code}&from=2026-04-01`, AC)).json().closingPaise as number

async function payBill(vendor: string, no: string, description: string, rate: number) {
  const bill = (await R.post('/api/bills', AC, { vendorId: vendor, billNo: no, billDate: '2026-11-04', lines: [{ description, qty: 1, rate, gstRate: 0 }] })).json()
  await R.post(`/api/bills/${bill.id}/approve`, GM, { reason: 'Contract' })
  const p = (await R.post('/api/payments', AC, { vendorId: vendor, billIds: [bill.id], mode: 'bank' })).json()
  if (p.approvalId) await R.post(`/api/approvals/${p.approvalId}/decide`, GM, { decision: 'approve' })
  await R.post(`/api/payments/${p.id}/paid`, AC, { reference: `UTR-${no}` })
  return p
}

beforeAll(async () => {
  R = await testResort('2026-11-04')
  AC = await R.staff('Meena', '9840001301', ['accounts'])
  GM = await R.staff('Karthik', '9840001302', ['general_manager'])
  ids.RAVI = (await R.post('/api/vendors', AC, { name: 'Ravi Garden Contractors', pan: 'ABCPR1234K', tdsCode: 'contractor' })).json().id
  ids.ARJUN = (await R.post('/api/vendors', AC, { name: 'Arjun & Co, Chartered Accountants', pan: 'ABCFA1234K', tdsCode: 'professional_fees' })).json().id
  ids.MANI = (await R.post('/api/vendors', AC, { name: 'Mani Painters', tdsCode: 'contractor' })).json().id
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM, AC]) await R.get('/api/business-date', t) })

describe('deducting', () => {
  it('applies a lower-deduction certificate up to its limit, and the higher rate without a PAN', async () => {
    expect((await R.post('/api/ldc', AC, { vendorId: ids.MANI, certNo: 'X', section: '194C', rate: 0.5, limit: 1000, validFrom: '2026-04-01', validTo: '2027-03-31' })).json().error).toMatch(/no PAN/)
    expect((await R.post('/api/ldc', AC, { vendorId: ids.ARJUN, certNo: 'LDC2627ABC0001', section: '194J', rate: 2, limit: 60000, validFrom: '2026-04-01', validTo: '2027-03-31' })).statusCode).toBe(201)
    expect((await payBill(ids.RAVI, 'RGC-11', 'Garden maintenance', 35000))).toMatchObject({ tds: 35000, section: '194C' })          // 1%, an individual
    const pv = (await R.post('/api/payments/preview', AC, { vendorId: ids.ARJUN, billIds: [] })).statusCode
    expect(pv).toBe(400)
    expect((await payBill(ids.ARJUN, 'ACA/77', 'Audit fees', 80000))).toMatchObject({ tds: 120000 + 200000 })                     // ₹60,000 at 2%, ₹20,000 at 10%
    expect((await payBill(ids.MANI, 'MP-3', 'Painting', 40000))).toMatchObject({ tds: 800000 })                                   // 20% without a PAN
  })
})

describe('depositing', () => {
  it('shows November\'s tax due by 7 December, and takes the challan only for the right amount', async () => {
    const d = (await R.get('/api/tds/deposits?fy=2026-27', AC)).json()
    expect(d.months).toEqual([expect.objectContaining({ month: '2026-11', deductedPaise: 1155000, openPaise: 1155000, due: '2026-12-07', status: 'due' })])
    await R.db.query(`update property set business_date = '2026-12-10'`)
    expect((await R.get('/api/tds/deposits?fy=2026-27', AC)).json().months[0]).toMatchObject({ status: 'overdue', interestNowPaise: 34650 })   // 1.5% a month or part: 2 months
    expect((await R.post('/api/tds/challans', AC, { month: '2026-11', bsrCode: '0510308', challanNo: '00123', paidOn: '2026-12-10', tax: 10000 })).json().error).toMatch(/come to ₹11,550.00/)
  })

  it('deposits it late with the interest, and books both', async () => {
    const r = (await R.post('/api/tds/challans', AC, { month: '2026-11', bsrCode: '0510308', challanNo: '00123', paidOn: '2026-12-10' })).json()
    expect(r).toMatchObject({ taxPaise: 1155000, interestPaise: 34650, totalPaise: 1189650, late: true })
    expect(await bal('2300')).toBe(0)
    expect(await bal('6095')).toBe(34650)
    expect((await R.get('/api/tds/deposits?fy=2026-27', AC)).json().months[0]).toMatchObject({ status: 'paid_late', openPaise: 0 })
    expect((await R.post('/api/tds/challans', AC, { month: '2026-11', bsrCode: '0510308', challanNo: '00124', paidOn: '2026-12-10' })).statusCode).toBe(409)
  })
})

describe('the quarterly statement', () => {
  it('lists every deductee with the section code, challan and reason, and what is missing', async () => {
    let s = (await R.get('/api/tds/26q?fy=2026-27&quarter=3', AC)).json()
    expect(s.problems).toEqual(expect.arrayContaining(['The resort\'s TAN is not set.']))
    expect((await patch('/api/tds/deductor', AC, { tan: 'CHES1234X' })).statusCode).toBe(400)
    await patch('/api/tds/deductor', AC, { tan: 'CHES12345A', responsible: 'Meena R', designation: 'Accounts manager' })
    s = (await R.get('/api/tds/26q?fy=2026-27&quarter=3', AC)).json()
    expect(s.problems).toEqual(['1 deductee has no PAN (deducted at the higher rate).'])
    expect(s.deductees.map((d: { sectionCode: string; reason: string | null; pan: string }) => [d.sectionCode, d.reason, d.pan])).toEqual([
      ['94J-B', 'A', 'ABCFA1234K'], ['94C', 'C', 'PANNOTAVBL'], ['94C', null, 'ABCPR1234K']])
    expect(s.deductees.every((d: { challan: string }) => d.challan === '0510308/2026-12-10/00123')).toBe(true)
    expect(s).toMatchObject({ due: '2027-01-31', totals: { tdsPaise: 1155000, amountPaise: 15500000, deductees: 3 } })
    const csv = (await R.get('/api/tds/26q.csv?fy=2026-27&quarter=3', AC)).body
    expect(csv.split('\r\n')).toHaveLength(4)
    expect(csv).toContain('"LDC2627ABC0001"')
    expect((await R.get(`/api/tds/statement/${ids.RAVI}?fy=2026-27&quarter=3`, AC)).body).toContain('0510308/2026-12-10/00123')
  })

  it('records the statement as filed, with the late fee of ₹200 a day', async () => {
    await R.db.query(`update property set business_date = '2027-02-05'`)
    expect((await R.post('/api/tds/returns', AC, { fy: '2026-27', quarter: 3, tokenNo: '123' })).statusCode).toBe(400)
    expect((await R.post('/api/tds/returns', AC, { fy: '2026-27', quarter: 3, tokenNo: '020260000123456' })).json()).toMatchObject({ lateFeePaise: 100000 })   // 5 days late
    expect((await R.get('/api/tds/26q?fy=2026-27&quarter=3', AC)).json().filed).toMatchObject({ token_no: '020260000123456' })
  })
})

describe('advance tax and the calendar', () => {
  it('sets the instalments against the estimate, and books what is paid', async () => {
    await put('/api/tax/estimate', AC, { fy: '2026-27', estimatedTax: 1000000 })
    await R.post('/api/tax/advance', AC, { amount: 150000, bsrCode: '0510308', challanNo: '00077', paidOn: '2026-06-12' })
    const a = (await R.get('/api/tax/advance?fy=2026-27', AC)).json()
    expect(a.instalments.map((i: { due: string; shortfallPaise: number }) => [i.due, i.shortfallPaise])).toEqual([
      ['2026-06-15', 0], ['2026-09-15', 30000000], ['2026-12-15', 60000000], ['2027-03-15', 85000000]])
    expect(await bal('1540')).toBe(15000000)
    const cal = (await R.get('/api/tax/calendar', AC)).json()
    expect(cal.find((i: { what: string }) => i.what.startsWith('Advance tax: 100%'))).toMatchObject({ due: '2027-03-15', status: 'due', amountPaise: 85000000 })
    expect(cal.find((i: { what: string }) => i.what.startsWith('TDS statement 26Q, 2026-27 quarter 3'))).toMatchObject({ due: '2027-01-31', status: 'done' })
    expect(cal.some((i: { what: string }) => i.what.startsWith('GSTR'))).toBe(false)               // no GST documents in these months yet
  })
})
