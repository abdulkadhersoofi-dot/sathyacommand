import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sandboxProvider } from '../src/einvoice'
import { testResort } from './helpers'

// GST documents end to end: a consumer stay, a company stay with an advance, credit notes, refunds and e-invoicing.

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', NA = ''
const ids: Record<string, string> = {}
const COMPANY_GSTIN = '29AABCT1332L1ZA'          // Karnataka, valid check digit

const detail = async (id: string) => (await R.get(`/api/reservations/${id}`, FD)).json()
const doc = async (id: string) => (await R.get(`/api/tax-documents/${id}`, FD)).json()

beforeAll(async () => {
  R = await testResort('2026-11-01', { einvoice: sandboxProvider })
  FD = await R.staff('Priya', '9840000002', ['reception'])
  NA = await R.staff('Senthil', '9840000004', ['night_auditor'])
  await R.post('/api/cashier/open', FD, { openingFloat: 0 })
}, 30_000)
afterAll(() => R.close())

describe('company tax details', () => {
  it('rejects a GSTIN with a typing mistake, and one from another state', async () => {
    expect((await R.app.inject({ method: 'PATCH', url: '/api/property', headers: { authorization: `Bearer ${R.md}` }, payload: { gstin: '33AAACS1234A1Z8' } })).statusCode).toBe(400)
    const other = await R.app.inject({ method: 'PATCH', url: '/api/property', headers: { authorization: `Bearer ${R.md}` }, payload: { gstin: COMPANY_GSTIN } })
    expect(other.json().error).toMatch(/must start with 33/)
  })

  it('refuses a company GSTIN on a booking if its check character is wrong', async () => {
    const r = await R.post('/api/reservations', FD, { guest: { name: 'X' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-05', departure: '2026-11-06',
      billToCompany: 'Tvs Ltd', billToGstin: '29AABCT1332L1ZB' })
    expect(r.statusCode).toBe(400)
  })
})

describe('advance, stay and invoice for a company guest', () => {
  it('issues a receipt voucher with GST when an advance is paid before arrival', async () => {
    ids.B2B = (await R.post('/api/reservations', FD, {
      guest: { name: 'Ravi Shankar' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-03',
      billToCompany: 'Tvs Logistics Private Limited', billToGstin: COMPANY_GSTIN, billToAddress: '12 Residency Road', billToCity: 'Bengaluru', billToPin: '560025',
    })).json().id
    const folio = (await detail(ids.B2B)).folios[0].id
    ids.FB2B = folio
    const pay = await R.post(`/api/folios/${folio}/payments`, FD, { method: 'upi', amount: 2100, reference: 'UPI-4471' })
    expect(pay.json().voucher).toBe('RV/26-27/000001')
    const rv = (await R.get(`/api/tax-documents?reservationId=${ids.B2B}`, FD)).json()[0]
    const full = await doc(rv.id)
    expect(full.tax_summary).toEqual([{ rate: 5, taxable: 200000, cgst: 5000, sgst: 5000 }])
    expect(full.amount_in_words).toBe('Rupees Two Thousand One Hundred Only')
  })

  it('invoices the stay at check-out, numbers it, and queues it for e-invoicing', async () => {
    await R.post(`/api/reservations/${ids.B2B}/check-in`, FD, { spaceId: 'RM-110', idType: 'passport', idNumber: 'Z1234567' })
    await R.post(`/api/folios/${ids.FB2B}/charges`, FD, { kind: 'laundry', description: 'Laundry', amount: 300 })
    await R.post('/api/night-audit', NA)
    await R.post('/api/night-audit', NA)               // business date is now 11-03, the departure day
    const due = (await R.post(`/api/reservations/${ids.B2B}/check-out`, FD)).json().balance
    await R.post(`/api/folios/${ids.FB2B}/payments`, FD, { method: 'company', amount: due / 100 })
    const out = (await R.post(`/api/reservations/${ids.B2B}/check-out`, FD)).json()
    expect(out.invoice).toMatchObject({ number: 'SPR/26-27/000001', irnStatus: 'pending', irnDeadline: '2026-12-03' })
    ids.INV = out.invoice.id
    const inv = await doc(ids.INV)
    expect(inv.b2b).toBe(true)
    expect(inv.recipient).toMatchObject({ name: 'Tvs Logistics Private Limited', gstin: COMPANY_GSTIN, stateCode: '29' })
    expect(inv.place_of_supply).toBe('33')                    // accommodation is taxed where the hotel is
    expect(inv.lines.map((l: { sac: string; gstRate: number }) => `${l.sac}@${l.gstRate}`).sort()).toEqual(['996311@5', '996311@5', 'null@18'])
    expect(inv.tax_summary.map((s: { rate: number }) => s.rate)).toEqual([5, 18])
    expect(inv.advance_adjusted_paise).toBe(210000)
  })

  it('will not send it to the GST portal while a line has no SAC code', async () => {
    const r = await R.post(`/api/tax-documents/${ids.INV}/irn`, R.md)
    expect(r.statusCode).toBe(422)
    expect(r.json().problems).toContain('Every line needs a SAC code.')
  })
})

describe('e-invoicing and the register', () => {
  it('generates the IRN for an invoice that passes the checks', async () => {
    ids.C2 = (await R.post('/api/reservations', FD, {
      guest: { name: 'Meera' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-03', departure: '2026-11-04',
      billToCompany: 'Tvs Logistics Private Limited', billToGstin: COMPANY_GSTIN, billToAddress: '12 Residency Road', billToCity: 'Bengaluru', billToPin: '560025',
    })).json().id
    await R.post(`/api/reservations/${ids.C2}/check-in`, FD, { spaceId: 'RM-111', idType: 'aadhaar', idNumber: '1111 2222 3333' })
    await R.post('/api/night-audit', NA)
    const folio = (await detail(ids.C2)).folios[0].id
    const due = (await R.post(`/api/reservations/${ids.C2}/check-out`, FD)).json().balance
    await R.post(`/api/folios/${folio}/payments`, FD, { method: 'company', amount: due / 100 })
    const out = (await R.post(`/api/reservations/${ids.C2}/check-out`, FD)).json()
    expect(out.invoice.number).toBe('SPR/26-27/000002')
    const r = await R.post(`/api/tax-documents/${out.invoice.id}/irn`, R.md)
    expect(r.json()).toMatchObject({ ok: true })
    expect(r.json().irn).toMatch(/^[0-9a-f]{64}$/)
    const html = (await R.get(`/api/tax-documents/${out.invoice.id}/print`, FD)).body
    for (const s of ['Tax Invoice', 'SPR/26-27/000002', '33AAACS1234A1Z9', COMPANY_GSTIN, '996311', '33 - Tamil Nadu', 'IRN:', 'Authorised signatory']) {
      expect(html).toContain(s)
    }
    expect((await R.post(`/api/tax-documents/${out.invoice.id}/irn`, R.md)).statusCode).toBe(409)
  })

  it('issues a credit note within what was invoiced, never above it', async () => {
    const tooMuch = await R.post(`/api/tax-documents/${ids.INV}/credit-notes`, R.md, { amount: 99999, gstRate: 5, reason: 'Goodwill' })
    expect(tooMuch.statusCode).toBe(400)
    const cn = await R.post(`/api/tax-documents/${ids.INV}/credit-notes`, R.md, { amount: 1000, gstRate: 5, reason: 'Late check-in goodwill' })
    expect(cn.json()).toMatchObject({ number: 'CN/26-27/000001', total: 105000, irnStatus: 'pending' })
    expect((await R.post(`/api/tax-documents/${ids.INV}/credit-notes`, FD, { amount: 10, gstRate: 5, reason: 'x' })).statusCode).toBe(403)
  })

  it('refunds a cancelled booking\'s advance with a refund voucher', async () => {
    const id = (await R.post('/api/reservations', FD, { guest: { name: 'Gopal' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-10', departure: '2026-11-11' })).json().id
    const folio = (await detail(id)).folios[0].id
    expect((await R.post(`/api/folios/${folio}/payments`, FD, { method: 'upi', amount: 1050, reference: 'UPI-1' })).json().voucher).toBe('RV/26-27/000002')
    await R.post(`/api/reservations/${id}/cancel`, FD, { reason: 'Guest cancelled' })
    const refund = await R.post(`/api/folios/${folio}/payments`, FD, { method: 'upi', amount: 1050, reference: 'UPI-R1', refund: true })
    expect(refund.json()).toMatchObject({ voucher: 'RF/26-27/000001', balance: 0 })
  })

  it('keeps issued documents final at the database level', async () => {
    await expect(R.db.query(`update tax_document set total_paise = 1 where id = $1`, [ids.INV])).rejects.toThrow(/cannot be changed/)
    await expect(R.db.query(`delete from tax_document where id = $1`, [ids.INV])).rejects.toThrow(/cannot be deleted/)
  })

  it('lists e-invoices due soon in the night audit, and the God Mode chain still verifies', async () => {
    const s = (await R.post('/api/night-audit', NA)).json()
    expect(s.eInvoicesDueWithin5Days).toEqual([])
    const actions = (await R.get('/api/audit?limit=1000', R.md)).json().map((e: { action: string }) => e.action)
    for (const a of ['receipt_voucher.issue', 'invoice.issue', 'credit_note.issue', 'refund_voucher.issue', 'einvoice.generate']) expect(actions).toContain(a)
    expect((await R.get('/api/audit/verify', R.md)).json()).toMatchObject({ ok: true })
  })
})

describe('without the company GSTIN', () => {
  it('refuses to check out rather than issue an invalid invoice', async () => {
    const T = await testResort('2026-11-01', { taxDetails: false })
    const fd = await T.staff('Priya', '9840000002', ['reception'])
    const id = (await T.post('/api/reservations', fd, { guest: { name: 'A' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-02' })).json().id
    await T.post(`/api/reservations/${id}/check-in`, fd, { spaceId: 'RM-105', idType: 'aadhaar', idNumber: '1234' })
    await T.post('/api/night-audit', T.md)
    const folio = (await T.get(`/api/reservations/${id}`, fd)).json().folios[0].id
    await T.post(`/api/folios/${folio}/payments`, fd, { method: 'card', amount: 4410, reference: 'C1' })
    const out = await T.post(`/api/reservations/${id}/check-out`, fd)
    expect(out.statusCode).toBe(409)
    expect(out.json().error).toMatch(/GSTIN/)
    await T.close()
  })
})
