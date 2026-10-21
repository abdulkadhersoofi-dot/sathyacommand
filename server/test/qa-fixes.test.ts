import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Problems found walking through a fresh install the way staff use it: the approval inbox, goods into the
// kitchen store, a cancellation waiting for approval, assets held before the books began, depreciation from
// the start of the books, bank details, payroll for the month in progress and e-invoices without a provider.

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', ST = '', CAP = '', FNB = '', ACC = '', HR = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })

beforeAll(async () => {
  R = await testResort('2026-11-01')
  GM = await R.staff('Karthik', '9840009201', ['general_manager'])
  ST = await R.staff('Mani', '9840009202', ['stores'])
  CAP = await R.staff('Murugan', '9840009203', ['captain'])
  FNB = await R.staff('Lakshmi', '9840009204', ['fnb_manager'])
  ACC = await R.staff('Meena', '9840009205', ['accounts'])
  HR = await R.staff('Divya', '9840009206', ['hr_payroll'])
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM]) await R.get('/api/business-date', t) })

describe('the approval inbox', () => {
  it('describes each request in plain words and says who may decide it', async () => {
    const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'DINE', tableId: 'DINE-T1', covers: 2 })).json()
    const menu = (await R.get('/api/fnb/menu?outletId=DINE', CAP)).json()
    const dish = (menu.items ?? menu).find((i: { liquor_class: string | null; active: boolean }) => !i.liquor_class)
    await R.post(`/api/fnb/orders/${o.id}/items`, CAP, { items: [{ itemId: dish.id, qty: 1 }] })
    await R.post(`/api/fnb/orders/${o.id}/send`, CAP)
    const item = (await R.get(`/api/fnb/orders/${o.id}`, CAP)).json().items[0]
    expect((await R.post(`/api/fnb/order-items/${item.id}/void`, CAP, { reason: 'Guest changed mind' })).statusCode).toBe(202)
    const inbox = (await R.get('/api/approvals', FNB)).json()
    const a = inbox.find((x: { kind: string }) => x.kind === 'fnb.void_after_kot')
    expect(a).toMatchObject({ title: expect.stringMatching(/^Cancel 1 × /), canDecide: true, requested_by_name: 'Murugan' })
    expect((await R.get('/api/approvals', CAP)).json().find((x: { id: string }) => x.id === a.id)).toMatchObject({ canDecide: false })
    // While it waits, the order cannot be billed.
    expect((await R.post(`/api/fnb/orders/${o.id}/bill`, CAP, {})).json().error).toMatch(/waits for the F&B manager/)
    expect((await R.post(`/api/approvals/${a.id}/decide`, FNB, { decision: 'approve' })).json()).toMatchObject({ status: 'approved' })
  })
})

describe('stores', () => {
  it('takes goods into the kitchen store without setting up a kitchen ingredient first', async () => {
    const v = (await R.post('/api/vendors', ST, { name: 'Kumar Provisions', pan: 'ABCPK1234L' })).json().id
    const rice = (await R.post('/api/items', ST, { name: 'Ponni rice', category: 'food', unit: 'g', purchaseUnit: 'kg', purchaseFactor: 1000, hsn: '1006', gstRate: 5, defaultStoreId: 'ST-KITCHEN' })).json().id
    const g = await R.post('/api/grns', ST, { vendorId: v, storeId: 'ST-KITCHEN', note: 'Market', lines: [{ itemId: rice, qtyReceived: 50, rate: 60 }] })
    expect(g.statusCode).toBe(201)
    expect((await R.get('/api/items', ST)).json().find((i: { id: string }) => i.id === rice)).toMatchObject({ ingredient: 'Ponni rice' })
  })
})

describe('fixed assets', () => {
  it('does not post an asset again when the opening balances already hold it, and depreciates from the start of the books', async () => {
    await R.post('/api/accounts/opening', ACC, { date: '2026-04-01', lines: [{ code: '1600', debit: 5000000 }, { code: '1690', credit: 500000 }] })
    const r = (await R.post('/api/assets/register', R.md, { name: 'Main building', category: 'building', cost: 5000000, putToUse: '2016-04-01', openingDep: 500000, postOpening: true })).json()
    expect(r.note).toMatch(/Already in the opening balances/)
    const tb = (await R.get('/api/accounts/trial-balance?from=2026-04-01&to=2026-11-30', ACC)).json()
    expect(tb.rows.find((x: { code: string }) => x.code === '1600').closingPaise).toBe(500000000)
    const reg = (await R.get('/api/assets/register', ACC)).json()
    expect(reg.nextMonth).toBe('2026-04')
    expect((await R.post('/api/assets/depreciation', R.md, { month: '2026-10' })).json().error).toMatch(/Post 2026-04 first/)
    expect((await R.post('/api/assets/depreciation', R.md, { month: '2026-04' })).statusCode).toBe(201)
  })
})

describe('banks', () => {
  it('lets the details of an existing bank account be filled in, and renamed', async () => {
    const b = (await R.get('/api/bank-accounts', ACC)).json()[0]
    const res = await patch(`/api/bank-accounts/${b.id}`, R.md, { name: 'SBI current account', bank: 'State Bank of India', accountNo: '30012345678', ifsc: 'SBIN0000875' })
    expect(res.statusCode).toBe(200)
    expect((await R.get('/api/bank-accounts', ACC)).json()[0]).toMatchObject({ name: 'SBI current account', bank: 'State Bank of India', ifsc: 'SBIN0000875' })
  })
})

describe('payroll and e-invoices', () => {
  it('does not work out the month in progress before the 25th', async () => {
    expect((await R.post('/api/payroll/runs', HR, { month: '2026-11' })).json().error).toMatch(/still going on/)
  })

  it('checks a hand-recorded IRN', async () => {
    expect((await R.post('/api/tax-documents/nope/irn-manual', ACC, { irn: 'abc', ackNo: '1', ackDate: '2026-11-01' })).json().error).toMatch(/64/)
  })
})
