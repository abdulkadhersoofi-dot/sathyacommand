import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// The city ledger, banks and cash: company accounts opened from their first bill, credit limits enforced at
// the desk and the restaurant, statements and ageing, money received with the customer's TDS, the bank
// statement imported and matched, a card settlement with its fee, reconciliation, banking and petty cash.

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', NA = '', CAP = '', AC = '', GM = ''
let TVS = '', KOVAI = '', DUE = 0
const COMPANY_GSTIN = '29AABCT1332L1ZA'
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const debtors = async () => (await R.get('/api/debtors', AC)).json().debtors as { id: string; name: string; outstandingPaise: number; overduePaise: number; ageing: number[]; credit_limit_paise: number | null }[]
const bal = async (code: string) => (await R.get(`/api/accounts/ledger?code=${code}&from=2026-04-01`, AC)).json().closingPaise as number
async function fnbBill(table: string, items: { itemId: string; qty?: number }[], billTo?: object) {
  const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'DINE', tableId: table, covers: 2 })).json()
  await R.post(`/api/fnb/orders/${o.id}/items`, CAP, { items })
  await R.post(`/api/fnb/orders/${o.id}/send`, CAP)
  return (await R.post(`/api/fnb/orders/${o.id}/bill`, CAP, billTo ? { billTo } : {})).json().bills[0]
}

beforeAll(async () => {
  R = await testResort('2026-11-02')
  FD = await R.staff('Priya', '9840001001', ['reception'])
  NA = await R.staff('Senthil', '9840001002', ['night_auditor'])
  CAP = await R.staff('Murugan', '9840001003', ['captain'])
  AC = await R.staff('Meena', '9840001004', ['accounts'])
  GM = await R.staff('Karthik', '9840001005', ['general_manager'])
  await R.post('/api/cashier/open', FD, { openingFloat: 0 })
  await R.post('/api/cashier/open', CAP, { openingFloat: 0 })
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM, AC]) await R.get('/api/business-date', t) })

describe('company accounts', () => {
  it('opens the company\'s account from its first credit bill', async () => {
    const res = (await R.post('/api/reservations', FD, { guest: { name: 'Ravi Shankar' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-02', departure: '2026-11-03',
      billToCompany: 'Tvs Logistics Private Limited', billToGstin: COMPANY_GSTIN, billToAddress: '12 Residency Road', billToCity: 'Bengaluru', billToPin: '560025' })).json()
    await R.post(`/api/reservations/${res.id}/check-in`, FD, { spaceId: 'RM-110', idType: 'passport', idNumber: 'Z1234567' })
    await R.post('/api/night-audit', NA)
    DUE = (await R.post(`/api/reservations/${res.id}/check-out`, FD)).json().balance
    const folio = (await R.get(`/api/reservations/${res.id}`, FD)).json().folios[0].id
    await R.post(`/api/folios/${folio}/payments`, FD, { method: 'company', amount: DUE / 100 })
    await R.post(`/api/reservations/${res.id}/check-out`, FD)
    const [d] = await debtors()
    expect(d).toMatchObject({ name: 'Tvs Logistics Private Limited', outstandingPaise: DUE, credit_limit_paise: null })
    TVS = d.id
    expect((await R.get('/api/debtors', CAP)).statusCode).toBe(403)
  })

  it('refuses credit beyond the limit the GM sets, at the restaurant and at the desk', async () => {
    const b1 = await fnbBill('DINE-T13', [{ itemId: 'DINE-SI02', qty: 10 }], { company: 'Kovai Textiles Pvt Ltd', gstin: '33AAACS1234A1Z9', address: 'Avinashi Road', city: 'Coimbatore', pin: '641018' })
    await R.post(`/api/fnb/bills/${b1.id}/settle`, CAP, { payments: [{ method: 'company', amount: b1.amounts.payable / 100 }] })
    KOVAI = (await debtors()).find((d) => d.name === 'Kovai Textiles Pvt Ltd')!.id
    expect((await patch(`/api/debtors/${KOVAI}`, AC, { creditLimit: 3000 })).statusCode).toBe(403)
    await patch(`/api/debtors/${KOVAI}`, GM, { creditLimit: 3000 })
    const b2 = await fnbBill('DINE-T12', [{ itemId: 'DINE-SI02', qty: 10 }], { company: 'Kovai Textiles Pvt Ltd', gstin: '33AAACS1234A1Z9' })
    const r = (await R.post(`/api/fnb/bills/${b2.id}/settle`, CAP, { payments: [{ method: 'company', amount: b2.amounts.payable / 100 }] })).json()
    expect(r.error).toMatch(/would owe ₹5,460, over their credit limit of ₹3,000 \(owing ₹2,730 now\)/)
    await R.post(`/api/fnb/bills/${b2.id}/settle`, CAP, { payments: [{ method: 'card', amount: b2.amounts.payable / 100, reference: 'SLIP 1' }] })

    await patch(`/api/debtors/${TVS}`, GM, { creditLimit: (DUE + 50000) / 100 })
    const res = (await R.post('/api/reservations', FD, { guest: { name: 'Anand' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-03', departure: '2026-11-04', billToCompany: 'Tvs Logistics Private Limited', billToGstin: COMPANY_GSTIN })).json()
    const folio = (await R.get(`/api/reservations/${res.id}`, FD)).json().folios[0].id
    expect((await R.post(`/api/folios/${folio}/payments`, FD, { method: 'company', amount: 1000 })).json().error).toMatch(/over their credit limit/)
    expect((await R.post(`/api/folios/${folio}/payments`, FD, { method: 'company', amount: 400 })).statusCode).toBe(201)
  })

  it('keeps account details checked and only the GM on the limit', async () => {
    expect((await patch(`/api/debtors/${TVS}`, AC, { gstin: '29AABCT1332L1ZB' })).statusCode).toBe(400)
    expect((await patch(`/api/debtors/${TVS}`, AC, { termsDays: 45, contactName: 'Suresh', email: 'accounts@tvs.example' })).statusCode).toBe(200)
    expect((await R.post('/api/debtors', AC, { name: 'MakeMyTrip', kind: 'ota', creditLimit: 100000 })).statusCode).toBe(403)
    expect((await R.post('/api/debtors', AC, { name: 'MakeMyTrip', kind: 'ota' })).statusCode).toBe(201)
  })
})

describe('statements and money received', () => {
  it('ages what is unpaid by the date it was billed, overdue after the terms', async () => {
    await R.post('/api/night-audit', NA)                                   // 11-03 closes: the day's credit posts
    let d = (await debtors()).find((x) => x.id === TVS)!
    expect(d.ageing[0]).toBe(DUE + 40000)
    expect(d.overduePaise).toBe(0)
    await R.db.query(`update property set business_date = '2026-12-20'`)
    d = (await debtors()).find((x) => x.id === TVS)!
    expect(d.ageing[1]).toBe(DUE + 40000)                                  // billed 11-03: 47 days old, past the 45-day terms
    expect(d.overduePaise).toBe(DUE + 40000)
    const st = (await R.get(`/api/debtors/${TVS}/statement?from=2026-11-01`, AC)).json()
    expect(st).toMatchObject({ openingPaise: 0, closingPaise: DUE + 40000 })
    expect(st.open.map((i: { narration: string; openPaise: number }) => [i.narration.split(' · ')[0], i.openPaise])).toEqual([['Bill SPR/26-27/000001', DUE], [expect.stringMatching(/^Bill Booking R-/), 40000]])
    expect((await R.get(`/api/debtors/${TVS}/statement/print?from=2026-11-01`, AC)).body).toContain('Statement of account')
    expect((await R.get('/api/debtors/overdue', AC)).json().map((x: { name: string }) => x.name)).toEqual(['Kovai Textiles Pvt Ltd', 'Tvs Logistics Private Limited'])   // oldest overdue first
  })

  it('records money received with the TDS the company deducted, as a tax credit', async () => {
    expect((await R.post('/api/ar-receipts', AC, { debtorId: TVS, amount: DUE / 100, tds: 100, mode: 'bank', reference: 'UTR998877' })).json().error).toMatch(/section/)
    const r = (await R.post('/api/ar-receipts', AC, { debtorId: TVS, amount: DUE / 100, tds: 100, tdsSection: '194-I', mode: 'bank', reference: 'UTR998877' })).json()
    expect(r).toMatchObject({ number: 'RCP/26-27/000001', bankCode: '1200', netPaise: DUE - 10000 })
    const d = (await debtors()).find((x) => x.id === TVS)!
    expect(d).toMatchObject({ outstandingPaise: 40000, overduePaise: 40000 })
    expect(await bal('1520')).toBe(10000)
  })

  it('refuses cash of ₹2 lakh or more from one party in a day', async () => {
    expect((await R.post('/api/ar-receipts', AC, { debtorId: KOVAI, amount: 150000, mode: 'cash' })).statusCode).toBe(201)
    expect((await R.post('/api/ar-receipts', AC, { debtorId: KOVAI, amount: 50000, mode: 'cash' })).json().error).toMatch(/2 lakh/)
  })
})

describe('the bank', () => {
  const statement = () => `Txn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance
20/12/2026,20/12/2026,BY TRANSFER CAPITAL INTRODUCED,,,"50,000.00","50,000.00"
20/12/2026,20/12/2026,NEFT-TVS LOGISTICS PVT LTD,UTR998877,,${((DUE - 10000) / 100).toFixed(2)},${((5000000 + DUE - 10000) / 100).toFixed(2)}
20/12/2026,20/12/2026,POS SETTLEMENT HDFC MID 4471,,,"2,725.00",${((5000000 + DUE - 10000 + 272500) / 100).toFixed(2)}
20/12/2026,20/12/2026,SMS CHARGES,,17.70,,${((5000000 + DUE - 10000 + 272500 - 1770) / 100).toFixed(2)}`
  let BANK = ''

  it('imports the statement once, and matches the receipt by its UTR', async () => {
    BANK = (await R.get('/api/bank-accounts', AC)).json()[0].id
    const r = (await R.post('/api/bank/import', AC, { bankAccountId: BANK, csv: statement(), fileName: 'sbi-dec.csv' })).json()
    expect(r).toMatchObject({ added: 4, duplicates: 0, matched: 1 })
    expect((await R.post('/api/bank/import', AC, { bankAccountId: BANK, csv: statement() })).json()).toMatchObject({ added: 0, duplicates: 4 })
    const open = (await R.get(`/api/bank/${BANK}/lines?status=open`, AC)).json()
    expect(open.map((l: { description: string }) => l.description).sort()).toEqual(['BY TRANSFER CAPITAL INTRODUCED', 'POS SETTLEMENT HDFC MID 4471', 'SMS CHARGES'])
  })

  it('posts what only the statement has: a card settlement with its fee, charges, capital', async () => {
    const open = (await R.get(`/api/bank/${BANK}/lines?status=open`, AC)).json() as { id: string; description: string }[]
    const by = (s: string) => open.find((l) => l.description.startsWith(s))!.id
    // ₹2,730 of card takings settled as ₹2,725: a ₹4.24 fee and 76 paise GST on it.
    expect((await R.post(`/api/bank/lines/${by('POS')}/post`, AC, { kind: 'card_settlement', gross: 2000, gst: 0.76 })).json().error).toMatch(/at least/)
    await R.post(`/api/bank/lines/${by('POS')}/post`, AC, { kind: 'card_settlement', gross: 2730, gst: 0.76 })
    expect(await bal('1210')).toBe(0)
    expect(await bal('6050')).toBe(424)
    await R.post(`/api/bank/lines/${by('SMS')}/post`, AC, { kind: 'account', accountCode: '6060' })
    await R.post(`/api/bank/lines/${by('BY TRANSFER')}/post`, AC, { kind: 'account', accountCode: '3000', narration: 'Capital brought in by the directors' })
    expect((await R.post(`/api/bank/lines/${by('SMS')}/unmatch`, AC)).json().error).toMatch(/reverse it/)
  })

  it('reconciles: nothing on one side only, and the statement balance agrees with the books', async () => {
    const r = (await R.get(`/api/bank/${BANK}/reconcile`, AC)).json()
    expect(r.inBankNotBooks).toHaveLength(0)
    expect(r.inBooksNotBank).toHaveLength(0)
    expect(r.differencePaise).toBe(0)
    expect(r.bookPaise).toBe(r.statementPaise)
  })
})

describe('cash', () => {
  it('banks cash, keeps a petty cash float, and warns on cash over ₹10,000 to one party', async () => {
    await R.post('/api/cash/deposit', AC, { amount: 1000, reference: 'Slip 41' })
    await R.post('/api/cash/petty-topup', AC, { amount: 15000, from: 'cash' })
    expect((await R.post('/api/cash/petty-expense', AC, { amount: 20000, accountCode: '6000', description: 'Pump repair', payee: 'Raja Motors' })).json().error).toMatch(/petty cash has ₹15,000/)
    await R.post('/api/cash/petty-expense', AC, { amount: 4000, accountCode: '6000', description: 'Pump repair', payee: 'Raja Motors' })
    const again = (await R.post('/api/cash/petty-expense', AC, { amount: 7000, accountCode: '6000', description: 'Motor rewinding', payee: 'Raja Motors' })).json()
    expect(again).toMatchObject({ needsConfirm: true })
    const ok = (await R.post('/api/cash/petty-expense', AC, { amount: 7000, accountCode: '6000', description: 'Motor rewinding', payee: 'Raja Motors', confirm: true })).json()
    expect(ok.warning).toMatch(/not deductible/)
    const c = (await R.get('/api/cash', AC)).json()
    expect(c.pettyPaise).toBe(400000)
    expect(c.txns.map((x: { kind: string }) => x.kind)).toEqual(['petty_expense', 'petty_expense', 'petty_topup', 'deposit'])
  })

  it('still balances the books', async () => {
    const t = (await R.get('/api/accounts/trial-balance?from=2026-04-01', AC)).json()
    expect(t.totals.closingDebitPaise).toBe(t.totals.closingCreditPaise)
    expect(t.rows.find((r: { code: string }) => r.code === '2900')).toBeUndefined()
  })
})
