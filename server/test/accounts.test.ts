import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// The general ledger: a stay with an advance, restaurant and bar sales (one charged to the room), goods
// received and billed, a contractor paid with TDS, a TASMAC purchase, opening and closing stock, journals,
// reversals and locked months. Everything posts itself and the books balance.

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', NA = '', CAP = '', BM = '', ST = '', AC = '', AC2 = '', GM = ''
let RES = '', FOLIO = '', RICE = '', KUMAR = '', RAVI = ''
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const tb = async (from = '2026-04-01', to?: string) => (await R.get(`/api/accounts/trial-balance?from=${from}${to ? `&to=${to}` : ''}`, AC)).json()
const bal = async (code: string, party?: string) => {
  const r = (await R.get(`/api/accounts/ledger?code=${code}&from=2026-04-01${party ? `&party=${encodeURIComponent(party)}` : ''}`, AC)).json()
  return r.closingPaise as number
}
async function order(outletId: string, tableId: string, items: { itemId: string; qty?: number }[], token = CAP) {
  const o = (await R.post('/api/fnb/orders', token, { outletId, tableId, covers: 2 })).json()
  await R.post(`/api/fnb/orders/${o.id}/items`, token, { items })
  await R.post(`/api/fnb/orders/${o.id}/send`, token)
  return (await R.post(`/api/fnb/orders/${o.id}/bill`, token, {})).json().bills[0]
}

beforeAll(async () => {
  R = await testResort('2026-10-30')
  FD = await R.staff('Priya', '9840000901', ['reception'])
  NA = await R.staff('Senthil', '9840000902', ['night_auditor'])
  CAP = await R.staff('Murugan', '9840000903', ['captain'])
  BM = await R.staff('Joseph', '9840000904', ['bar_manager'])
  ST = await R.staff('Mani', '9840000905', ['stores'])
  AC = await R.staff('Meena', '9840000906', ['accounts'])
  AC2 = await R.staff('Ganesh', '9840000907', ['accounts'])
  GM = await R.staff('Karthik', '9840000908', ['general_manager'])
  await put('/api/fnb/bar-settings', GM, { open: '00:00', close: '23:59' })
  await put('/api/vat-rates/beer', AC, { rate: 14.5 })
  await R.post('/api/licences', AC, { kind: 'tn_vat', name: 'TN VAT registration', number: '33123456789' })
  await R.post('/api/licences', AC, { kind: 'fssai', name: 'FSSAI', number: '12423008000123' })
  await R.post('/api/cashier/open', FD, { openingFloat: 0 })
  await R.post('/api/cashier/open', CAP, { openingFloat: 0 })
  RICE = (await R.post('/api/items', ST, { name: 'Ponni rice', category: 'food', unit: 'g', purchaseUnit: 'bag of 25 kg', purchaseFactor: 25000, hsn: '1006', gstRate: 5, defaultStoreId: 'ST-MAIN' })).json().id
  KUMAR = (await R.post('/api/vendors', ST, { name: 'Kumar Provisions', pan: 'ABCPK1234L' })).json().id
  RAVI = (await R.post('/api/vendors', ST, { name: 'Ravi Garden Contractors', pan: 'ABCPR1234K', tdsCode: 'contractor' })).json().id
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM, AC, AC2]) await R.get('/api/business-date', t) })

describe('a day of trade', () => {
  it('records the day: an advance, a stay, restaurant and bar bills, one charged to the room', async () => {
    RES = (await R.post('/api/reservations', FD, { guest: { name: 'Ravi Shankar' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-10-30', departure: '2026-10-31' })).json().id
    FOLIO = (await R.get(`/api/reservations/${RES}`, FD)).json().folios[0].id
    expect((await R.post(`/api/folios/${FOLIO}/payments`, FD, { method: 'upi', amount: 2100, reference: 'UPI-4471' })).json().voucher).toBe('RV/26-27/000001')
    await R.post(`/api/reservations/${RES}/check-in`, FD, { spaceId: 'RM-110', idType: 'passport', idNumber: 'Z1234567' })
    await R.post(`/api/folios/${FOLIO}/charges`, FD, { kind: 'laundry', description: 'Laundry', amount: 300 })
    // Walk-in breakfast: ₹400 + 5% GST, cash and UPI.
    const b1 = await order('DINE', 'DINE-T1', [{ itemId: 'DINE-BF02', qty: 2 }, { itemId: 'DINE-BV01', qty: 2 }])
    await R.post(`/api/fnb/bills/${b1.id}/settle`, CAP, { payments: [{ method: 'cash', amount: 200 }, { method: 'upi', amount: 220, reference: 'UTR1' }] })
    // Two beers at the bar: ₹640 + ₹92.80 VAT, paid ₹733 by card (20 paise rounded).
    const b2 = await order('BAR', 'BAR-B1', [{ itemId: 'BAR-BR01', qty: 2 }], BM)
    expect(b2.amounts).toMatchObject({ total: 73280, payable: 73300, roundOff: 20 })
    await R.post(`/api/fnb/bills/${b2.id}/settle`, BM, { payments: [{ method: 'card', amount: 733, reference: 'SLIP 7' }] })
    // Dinner charged to the room: food on the stay invoice, the beer on its own VAT invoice.
    const b3 = await order('DINE', 'DINE-T2', [{ itemId: 'DINE-SI01' }, { itemId: 'DINE-BR01' }])
    await R.post(`/api/fnb/bills/${b3.id}/settle`, CAP, { payments: [{ method: 'room', amount: 1 }], reservationId: RES })
  })

  it('posts nothing for a day until it is closed, then one voucher per kind of trade', async () => {
    expect((await tb()).rows.filter((r: { code: string }) => ['4000', '4100', '4200'].includes(r.code))).toHaveLength(0)
    // The advance's receipt voucher posts at once: GST on it is owed now.
    expect(await bal('1510')).toBe(10000)
    await R.post('/api/night-audit', NA)
    const day = (await R.get('/api/accounts/daybook?from=2026-10-30&to=2026-10-30', AC)).json()
    expect(day.map((v: { narration: string }) => v.narration).sort()).toEqual([
      'Front office receipts for 2026-10-30', 'GST on advance, RV/26-27/000001', 'Guest charges for 2026-10-30', 'Restaurant and bar sales for 2026-10-30'])
    expect(await bal('4200')).toBe(-(64000 + 32000))                  // both beers, walk-in and room
    expect(await bal('4100')).toBe(-(40000 + 38000))                  // breakfast, and the room's dinner
    expect(await bal('1330')).toBe(0)                                  // restaurant clearing: every bill paid or on a room
    expect(await bal('6080')).toBe(-20)                                // 20 paise rounded up, in the resort's favour
    expect(await bal('1210')).toBe(73300)
  })

  it('clears the guest ledger at check-out, and the GST on the advance against the invoice', async () => {
    const due = (await R.post(`/api/reservations/${RES}/check-out`, FD)).json().balance
    await R.post(`/api/folios/${FOLIO}/payments`, FD, { method: 'card', amount: due / 100, reference: 'SLIP 9' })
    expect((await R.post(`/api/reservations/${RES}/check-out`, FD)).json().invoice).toBeTruthy()
    await R.post('/api/night-audit', NA)                               // business date 11-01: 10-31 closes
    expect(await bal('1300', RES)).toBe(0)
    expect(await bal('1510')).toBe(0)
  })
})

describe('purchases and payments', () => {
  it('expenses goods as the store receives them; the bill clears them; payment takes TDS', async () => {
    await R.post('/api/stock/opening', ST, { storeId: 'ST-MAIN', lines: [{ itemId: RICE, qty: 2, rate: 1400 }] })
    await R.post('/api/grns', ST, { vendorId: KUMAR, storeId: 'ST-MAIN', note: 'Rice ran short', lines: [{ itemId: RICE, qtyReceived: 2, rate: 1500 }] })
    expect(await bal('5000')).toBe(300000)
    expect(await bal('2110')).toBe(-300000)
    const bill = (await R.post('/api/bills', AC, { vendorId: KUMAR, billNo: 'K-77', billDate: '2026-10-30', lines: [{ itemId: RICE, qty: 2, rate: 1500 }] })).json()
    await R.post(`/api/bills/${bill.id}/approve`, GM, { reason: 'Bought in the market without a PO' })
    expect(await bal('2110')).toBe(0)
    expect(await bal('1500') + await bal('1501')).toBe(15000)          // 5% GST claimable
    expect(await bal('2100', KUMAR)).toBe(-315000)

    const svc = (await R.post('/api/bills', AC, { vendorId: RAVI, billNo: 'RGC-10', billDate: '2026-10-30', lines: [{ description: 'Garden maintenance, October', sac: '998131', qty: 1, rate: 35000, gstRate: 0 }] })).json()
    await R.post(`/api/bills/${svc.id}/approve`, GM)
    const p = (await R.post('/api/payments', AC, { vendorId: RAVI, billIds: [svc.id], mode: 'bank' })).json()
    await R.post(`/api/approvals/${p.approvalId}/decide`, GM, { decision: 'approve' })
    await R.post(`/api/payments/${p.id}/paid`, AC, { reference: 'HDFC0012345' })
    expect(await bal('6010')).toBe(3500000)                            // contract services, from the vendor's TDS category
    expect(await bal('2100', RAVI)).toBe(0)
    expect(await bal('2300')).toBe(-35000)
    expect(await bal('1200')).toBe(-3465000)
  })

  it('books a TASMAC purchase with the TCS as a tax credit', async () => {
    await R.post('/api/bar/purchases', BM, { supplier: 'TASMAC', invoiceNo: 'TSM/CBE/1', invoiceDate: '2026-11-01', vat: 0, permitNo: 'TP/1', lines: [{ brandId: 'BR-BEER650', bottles: 24, cost: 150 }] })
    expect(await bal('5020')).toBe(360000)
    expect(await bal('1521')).toBe(3600)
    expect(await bal('2120')).toBe(-363600)
  })
})

describe('journals and locked months', () => {
  it('takes a balanced journal from accounts only, and puts it right only by reversal', async () => {
    expect((await R.post('/api/accounts/journal', ST, { narration: 'x', lines: [] })).statusCode).toBe(403)
    expect((await R.post('/api/accounts/journal', AC, { narration: 'Capital', lines: [{ code: '1200', debit: 1000000 }, { code: '3000', credit: 900000 }] })).json().error).toMatch(/differ by ₹1,00,000|differ by ₹100000/)
    const j = (await R.post('/api/accounts/journal', AC, { narration: 'Share capital brought in', lines: [{ code: '1200', debit: 1000000 }, { code: '3000', credit: 1000000 }] })).json()
    expect(j.number).toMatch(/^JV\/26-27\/\d{6}$/)
    await expect(R.db.query(`update voucher_line set debit_paise = 1 where voucher_id = $1`, [j.id])).rejects.toThrow(/cannot be changed/)
    const wrong = (await R.post('/api/accounts/journal', AC, { narration: 'Bank charges', lines: [{ code: '6060', debit: 500 }, { code: '1200', credit: 500 }] })).json()
    const auto = (await R.get('/api/accounts/daybook?kind=sales&from=2026-10-30&to=2026-10-30', AC)).json()[0]
    expect((await R.post(`/api/accounts/vouchers/${auto.id}/reverse`, AC, { reason: 'x' })).json().error).toMatch(/correct the bill/)
    const r = (await R.post(`/api/accounts/vouchers/${wrong.id}/reverse`, AC, { reason: 'Charged twice' })).json()
    expect(r.number).toBe('RJ/26-27/000001')
    expect((await R.post(`/api/accounts/vouchers/${wrong.id}/reverse`, AC, { reason: 'again' })).statusCode).toBe(409)
    expect(await bal('6060')).toBe(0)
  })

  it('balances: the trial balance, and the balance sheet against the profit', async () => {
    const t = await tb()
    expect(t.totals.debitPaise).toBe(t.totals.creditPaise)
    expect(t.totals.closingDebitPaise).toBe(t.totals.closingCreditPaise)
    expect(t.rows.find((r: { code: string }) => r.code === '2900')).toBeUndefined()   // nothing in suspense
    const bs = (await R.get('/api/accounts/balance-sheet', AC)).json()
    expect(bs.totals.assetsPaise).toBe(bs.totals.liabilitiesPaise + bs.totals.equityPaise)
    const pl = (await R.get('/api/accounts/pnl?from=2026-10-01&to=2026-11-01', GM)).json()
    expect(pl.departments.find((d: { dept: string }) => d.dept === 'bar')).toMatchObject({ revenuePaise: 96000, costPaise: 360000 })
    expect(pl.totals.profitPaise).toBe(bs.equity.find((e: { name: string }) => e.name.startsWith('Profit for the year')).amountPaise)
  })

  it('brings each store to its counted closing stock when the month closes', async () => {
    // Opening stock went in on 11-01, so October closes with nothing held; November is counted at its end.
    await R.db.query(`update property set business_date = '2026-12-01'`)
    await R.post('/api/month-close', GM, { storeId: 'ST-MAIN', month: '2026-10' })
    await R.db.query(`update property set business_date = '2026-11-30'`)
    await R.post('/api/stock/counts', GM, { storeId: 'ST-MAIN', lines: [{ itemId: RICE, counted: 75000 }] })   // a bag used
    await R.db.query(`update property set business_date = '2026-12-01'`)
    expect((await R.post('/api/month-close', GM, { storeId: 'ST-MAIN', month: '2026-11', note: 'A bag issued to the kitchen without a slip' })).json().status).toBe('closed')
    expect(await bal('1400')).toBe(435000)                             // 3 bags at the average ₹1,450
    expect(await bal('3200')).toBe(-280000)                            // the opening stock taken
    expect(await bal('5100')).toBe(-(435000 - 280000))                 // purchases that are still on the shelf
  })

  it('locks a month: no journal goes in, late documents land in the next open month, and only the MD reopens it', async () => {
    expect((await R.post('/api/accounts/periods', AC, { month: '2026-10' })).statusCode).toBe(403)
    expect((await R.post('/api/accounts/periods', GM, { month: '2026-12' })).json().error).toMatch(/not over/)
    await R.post('/api/accounts/periods', GM, { month: '2026-10', note: 'GST for October filed' })
    expect((await R.post('/api/accounts/journal', AC, { date: '2026-10-31', narration: 'Late', lines: [{ code: '6060', debit: 1 }, { code: '1200', credit: 1 }] })).json().error).toMatch(/locked/)
    const late = (await R.post('/api/bills', AC, { vendorId: RAVI, billNo: 'RGC-9', billDate: '2026-10-20', lines: [{ description: 'Hedge trimming', qty: 1, rate: 1000, gstRate: 0 }] })).json()
    await R.post(`/api/bills/${late.id}/approve`, GM)
    const v = (await R.get('/api/accounts/daybook?kind=purchase&from=2026-11-01&to=2026-11-01', AC)).json().find((x: { narration: string }) => x.narration.startsWith('Bill RGC-9'))
    expect(v).toMatchObject({ date: '2026-11-01', doc_date: '2026-10-20' })
    expect((await R.post('/api/accounts/periods/2026-10/unlock', GM, { reason: 'x' })).statusCode).toBe(403)
    expect((await R.post('/api/accounts/periods/2026-10/unlock', R.md, { reason: 'Credit note missed' })).json()).toEqual({ month: '2026-10', unlocked: true })
  })
})
