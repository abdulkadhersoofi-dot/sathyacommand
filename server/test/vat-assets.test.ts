import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// TN VAT on liquor, fixed assets and depreciation (books and income tax), department budgets, the Tally
// file, and the CA's read-only login that ends by itself.

let R: Awaited<ReturnType<typeof testResort>>
let BM = '', AC = '', GM = '', CA = ''
let CHAIRS = ''
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const bal = async (code: string) => (await R.get(`/api/accounts/ledger?code=${code}&from=2020-04-01`, AC)).json().closingPaise as number

beforeAll(async () => {
  R = await testResort('2026-11-10')
  BM = await R.staff('Joseph', '9840001401', ['bar_manager'])
  AC = await R.staff('Meena', '9840001402', ['accounts'])
  GM = await R.staff('Karthik', '9840001403', ['general_manager'])
  CA = await R.staff('Iyer & Associates', '9840001404', ['external_auditor'])
  await put('/api/fnb/bar-settings', GM, { open: '00:00', close: '23:59' })
  await put('/api/vat-rates/beer', AC, { rate: 14.5 })
  await R.post('/api/licences', AC, { kind: 'tn_vat', name: 'TN VAT registration', number: '33123456789' })
  await R.post('/api/cashier/open', BM, { openingFloat: 0 })
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM, AC, CA]) await R.get('/api/business-date', t) })

describe('TN VAT', () => {
  it('gives the month\'s VAT by class and rate, the TASMAC purchases, and the registers; records the return', async () => {
    const o = (await R.post('/api/fnb/orders', BM, { outletId: 'BAR', tableId: 'BAR-B1', covers: 2 })).json()
    await R.post(`/api/fnb/orders/${o.id}/items`, BM, { items: [{ itemId: 'BAR-BR01', qty: 2 }] })
    await R.post(`/api/fnb/orders/${o.id}/send`, BM)
    const [b] = (await R.post(`/api/fnb/orders/${o.id}/bill`, BM, {})).json().bills
    await R.post(`/api/fnb/bills/${b.id}/settle`, BM, { payments: [{ method: 'cash', amount: b.amounts.payable / 100 }] })
    await R.post('/api/bar/purchases', BM, { supplier: 'TASMAC', invoiceNo: 'TSM/9', invoiceDate: '2026-11-10', vat: 500, permitNo: 'TP/9', lines: [{ brandId: 'BR-BEER650', bottles: 24, cost: 150 }] })
    const v = (await R.get('/api/vat/2026-11', AC)).json()
    expect(v.byRate).toEqual([{ liquorClass: 'beer', rate: 14.5, taxable: 64000, vat: 9280 }])
    expect(v.purchases).toEqual([expect.objectContaining({ invoice: 'TSM/9', value: 360000, vat: 50000, permit: 'TP/9' })])
    expect(v.totals).toMatchObject({ outputVatPaise: 9280, inputVatPaise: 50000, creditAllowed: false, payablePaise: 9280 })
    expect((await R.get('/api/vat/2026-11/sales.csv', AC)).body.split('\r\n')).toHaveLength(2)
    expect((await R.get('/api/vat/2026-11/purchases.csv', AC)).body).toContain('"TSM/9"')
    expect((await R.post('/api/vat/returns', AC, { period: '2026-11', ackNo: 'VAT112026001' })).json().error).toMatch(/not over/)
  })
})

describe('fixed assets', () => {
  it('capitalises a purchase from its bill, and brings in an asset held before the books began', async () => {
    const vendor = (await R.post('/api/vendors', AC, { name: 'Kovai Furniture', gstin: '33AAACS1234A1Z9' })).json().id
    const bill = (await R.post('/api/bills', AC, { vendorId: vendor, billNo: 'KF-501', billDate: '2026-11-10', lines: [{ description: 'Restaurant chairs (40)', qty: 1, rate: 800000, gstRate: 18, accountCode: '1602' }] })).json()
    await R.post(`/api/bills/${bill.id}/approve`, GM, { reason: 'Approved capex' })
    expect(await bal('1602')).toBe(80000000)
    CHAIRS = (await R.post('/api/assets/register', AC, { name: 'Restaurant chairs (40)', category: 'furniture', cost: 800000, putToUse: '2026-11-10', dept: 'fnb', billId: bill.id })).json().id
    await R.post('/api/assets/register', AC, { name: 'Park Wing building', category: 'building', cost: 50000000, putToUse: '2020-04-01', openingDep: 10000000, postOpening: true })
    expect(await bal('1600')).toBe(5000000000)
    expect(await bal('1690')).toBe(-1000000000)
    const reg = (await R.get('/api/assets/register', AC)).json()
    expect(reg.assets.map((a: { code: string; life_years: string }) => [a.code, Number(a.life_years)])).toEqual([['FA-0001', 8], ['FA-0002', 60]])
  })

  it('depreciates month by month on the Companies Act lives, in order', async () => {
    expect((await R.post('/api/assets/depreciation', AC, { month: '2026-11' })).json().error).toMatch(/not over/)
    await R.db.query(`update property set business_date = '2027-01-05'`)
    // The books begin on 1 April: those months come first, the building alone (the chairs came in November).
    expect((await R.post('/api/assets/depreciation', AC, { month: '2026-11' })).json().error).toMatch(/Post 2026-04 first/)
    for (const m of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
      expect((await R.post('/api/assets/depreciation', AC, { month: m })).json()).toMatchObject({ assets: 1 })
    }
    const r = (await R.post('/api/assets/depreciation', AC, { month: '2026-11' })).json()
    // Chairs: ₹7,60,000 over 8 years, 21 days; building: ₹4.75 crore over 60 years, 30 days.
    expect(r).toMatchObject({ assets: 2, amountPaise: Math.round(76000000 / 8 * 21 / 365) + Math.round(4750000000 / 60 * 30 / 365) })
    expect((await R.post('/api/assets/depreciation', AC, { month: '2026-11' })).statusCode).toBe(409)
    expect((await R.post('/api/assets/depreciation', AC, { month: '2027-01' })).json().error).toMatch(/not over/)
    const pl = (await R.get('/api/accounts/pnl?from=2026-11-01&to=2026-11-30', AC)).json()
    expect(pl.lines.find((l: { code: string; dept: string }) => l.code === '6200' && l.dept === 'fnb').amountPaise).toBe(Math.round(76000000 / 8 * 21 / 365))
  })

  it('takes a sold asset off the books with the profit or loss', async () => {
    const r = (await R.post(`/api/assets/register/${CHAIRS}/dispose`, AC, { date: '2027-01-02', sale: 700000 })).json()
    expect(r.profitPaise).toBe(70000000 - (80000000 - Math.round(76000000 / 8 * 21 / 365)))
    expect(await bal('1602')).toBe(0)
  })

  it('works out income-tax depreciation by block: half the rate for less than 180 days, sale proceeds off first', async () => {
    const it = (await R.get('/api/assets/it-depreciation?fy=2026-27', AC)).json()
    const furniture = it.blocks.find((b: { block: string }) => b.block === 'furniture')
    expect(furniture).toMatchObject({ rate: 10, additionsHalfPaise: 80000000, salesPaise: 70000000, depreciationPaise: 500000, closingPaise: 9500000 })
    expect(it.blocks.find((b: { block: string }) => b.block === 'building').rate).toBe(10)
  })
})

describe('budgets and Tally', () => {
  it('sets a department\'s budget for the year and shows it against the actual', async () => {
    expect((await put('/api/budgets', BM, { fy: '2026-27', dept: 'bar', kind: 'revenue', annual: 120000 })).statusCode).toBe(403)
    await put('/api/budgets', GM, { fy: '2026-27', dept: 'bar', kind: 'revenue', annual: 120000 })
    const r = (await R.get('/api/budgets/vs-actual?from=2026-11-01&to=2026-11-30', GM)).json()
    expect(r.rows.find((x: { dept: string }) => x.dept === 'bar').revenue).toEqual({ actualPaise: 64000, budgetPaise: 1000000, variancePaise: -936000 })
  })

  it('writes the books for Tally: ledgers under Tally\'s groups, vendors as their own ledgers, every voucher', async () => {
    const x = (await R.get('/api/accounts/tally.xml?from=2026-11-01&to=2027-01-05&masters=1', AC)).body
    expect(x).toContain('<LEDGER NAME="Liquor revenue" ACTION="Create"><NAME.LIST><NAME>Liquor revenue</NAME></NAME.LIST><PARENT>Sales Accounts</PARENT>')
    expect(x).toContain('<LEDGER NAME="Kovai Furniture" ACTION="Create"><NAME.LIST><NAME>Kovai Furniture</NAME></NAME.LIST><PARENT>Sundry Creditors</PARENT>')
    expect(x).toContain('<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>')
    expect(x).toMatch(/<LEDGERNAME>Kovai Furniture<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>944000.00<\/AMOUNT>/)
  })
})

describe('the CA\'s login', () => {
  it('reads the books and cannot change them, and stops working when its time is up', async () => {
    expect((await R.get('/api/accounts/trial-balance', CA)).statusCode).toBe(200)
    expect((await R.get('/api/gst/2026-11', CA)).statusCode).toBe(200)
    expect((await R.post('/api/accounts/journal', CA, { narration: 'x', lines: [] })).statusCode).toBe(403)
    const [u] = await R.db.query<{ id: string; access_until: Date }>(`select id, access_until from app_user where name = 'Iyer & Associates'`)
    expect(u.access_until).toBeTruthy()
    await put(`/api/users/${u.id}/access`, R.md, { days: 0 })
    expect((await R.get('/api/accounts/trial-balance', CA)).statusCode).toBe(401)
  })
})
