import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  accommodationNight, accommodationStay, advanceVoucher, cashExpenseCheck, cashReceiptCheck, commonCreditReversal,
  creditNote, eInvoice, expectedDeductionFromResort, formCDue, gstTdsByGovernment, liquorSaleAllowed, loadTaxConfig,
  msmePaymentDue, otaSettlement, packageNight, premisesForNextFy, priceGuard, restaurantBill, restaurantRate,
  reverseCharge, rupees, serviceCharge, tcsPaidOnPurchase, tdsOnPayment, VatRateMissing,
} from '../src'

// Every row of config/tax-test-book.csv is one test here. The CA edits the CSV;
// the suite fails if a row has no test, so the two can never drift apart.

const cfg = loadTaxConfig()
const D = '2026-11-14'          // a date in FY 2026-27
const FY = '2026-27'
const r = rupees

// Example rates used only where the real value is still blank in the config (TN VAT, bar hours).
const SAMPLE_VAT = { beer: 10, imfl_spirits: 10 }
const SAMPLE_HOURS = { open: '11:00', close: '23:00', dryDays: ['2026-10-02'] }

const cases: Record<string, () => void> = {
  T01: () => {
    const nights = accommodationStay(cfg, [{ date: D, charged: r(4500) }, { date: '2026-11-15', charged: r(4500) }])
    nights.forEach((n) => { expect(n.rate).toBe(5); expect(n.cgst).toBe(r(112.5)); expect(n.sgst).toBe(r(112.5)) })
    expect(nights.reduce((a, n) => a + n.cgst + n.sgst, 0)).toBe(r(450))
  },
  T02: () => { const n = accommodationNight(cfg, { date: D, charged: r(9500) }); expect(n.rate).toBe(18); expect(n.cgst).toBe(r(855)); expect(n.itc).toBe(true) },
  T03: () => expect(accommodationNight(cfg, { date: D, charged: r(7500) }).rate).toBe(5),
  T04: () => expect(accommodationNight(cfg, { date: D, charged: r(7501) }).rate).toBe(18),
  T05: () => { const n = accommodationNight(cfg, { date: D, charged: r(9500 * 0.75) }); expect(n.taxable).toBe(r(7125)); expect(n.rate).toBe(5) },
  T06: () => {
    // Config currently counts extras toward the slab value (pending CA decision).
    const n = accommodationNight(cfg, { date: D, charged: r(7400), extras: r(600) })
    expect(n.slabValue).toBe(r(8000)); expect(n.rate).toBe(18); expect(n.taxable).toBe(r(8000))
  },
  T07: () => {
    const rates = accommodationStay(cfg, [
      { date: '2026-11-13', charged: r(8000) }, { date: D, charged: r(8000) }, { date: '2026-11-15', charged: r(6500) },
    ]).map((n) => n.rate)
    expect(rates).toEqual([18, 18, 5])
  },
  T08: () => expect(packageNight(cfg, { date: D, charged: r(7000) }).rate).toBe(5),
  T09: () => {
    const opted = structuredClone(cfg)
    opted.gst.restaurant.specified_premises.status_by_fy[FY] = 'specified'
    const bill = restaurantBill(opted, FY, [{ name: 'Food', amount: r(2000) }])
    expect(bill.gstInvoice!.cgst + bill.gstInvoice!.sgst).toBe(r(360))
  },
  T10: () => {
    expect(restaurantRate(cfg, FY)).toEqual({ premises: 'other', rate: 5, itc: false })
    const bill = restaurantBill(cfg, FY, [{ name: 'Food', amount: r(2000) }])
    expect(bill.gstInvoice!.cgst + bill.gstInvoice!.sgst).toBe(r(100))
  },
  T11: () => {
    expect(premisesForNextFy(cfg, r(7500))).toBe('other')
    expect(premisesForNextFy(cfg, r(7600))).toBe('specified')
  },
  T12: () => {
    const items = [{ name: 'Biryani', amount: r(1500) }, { name: 'Beer', amount: r(600), liquorClass: 'beer' }]
    expect(() => restaurantBill(cfg, FY, items)).toThrow(VatRateMissing)
    const bill = restaurantBill(cfg, FY, items, SAMPLE_VAT)
    expect(bill.gstInvoice!.taxable).toBe(r(1500))
    expect(bill.vatInvoice!.taxable).toBe(r(600))
    expect(bill.payable).toBe(bill.gstInvoice!.total + bill.vatInvoice!.total)
  },
  T13: () => expect(eInvoice(cfg, { b2b: true, invoiceDate: D }).required).toBe(true),
  T14: () => expect(advanceVoucher(r(200000), 18).gst).toBe(r(30508.47)),
  T15: () => expect(advanceVoucher(r(150000), 18).gst).toBe(r(22881.36)),
  T16: () => { const c = creditNote(r(1000), 18); expect(c.cgst + c.sgst).toBe(r(180)) },
  T17: () => {
    const s = otaSettlement(cfg, { roomValue: r(5000), date: D, commissionRate: 18, ota194oRate: 0.1 })
    expect(s.outputGst).toBe(r(250)); expect(s.commission).toBe(r(900)); expect(s.gstOnCommission).toBe(r(162))
    expect(s.gstTcsCredit).toBe(r(25)); expect(s.incomeTaxTdsCredit).toBe(r(5))
  },
  T18: () => expect(expectedDeductionFromResort(cfg, 'corporate_rate_contract', r(50000)).amount).toBe(r(5000)),
  T19: () => expect(expectedDeductionFromResort(cfg, 'banquet_client', r(300000)).amount).toBe(r(6000)),
  T20: () => expect(gstTdsByGovernment(cfg, r(500000))).toBe(r(10000)),
  T21: () => expect(tdsOnPayment(cfg, { code: 'contractor', payeeType: 'individual', hasPan: true, amount: r(40000) }).tds).toBe(r(400)),
  T22: () => {
    const first = tdsOnPayment(cfg, { code: 'contractor', payeeType: 'company', hasPan: true, amount: r(25000), paidEarlierThisYear: r(50000) })
    expect(first.deduct).toBe(false)
    const fourth = tdsOnPayment(cfg, { code: 'contractor', payeeType: 'company', hasPan: true, amount: r(30000), paidEarlierThisYear: r(75000) })
    expect(fourth.base).toBe(r(105000)); expect(fourth.tds).toBe(r(2100))
  },
  T23: () => expect(tdsOnPayment(cfg, { code: 'professional_fees', payeeType: 'individual', hasPan: true, amount: r(60000) }).tds).toBe(r(6000)),
  T24: () => expect(tdsOnPayment(cfg, { code: 'rent_land_building_furniture', payeeType: 'individual', hasPan: true, amount: r(45000) }).deduct).toBe(false),
  T25: () => expect(tdsOnPayment(cfg, { code: 'rent_land_building_furniture', payeeType: 'individual', hasPan: true, amount: r(60000) }).tds).toBe(r(6000)),
  T26: () => expect(tdsOnPayment(cfg, { code: 'commission_brokerage', payeeType: 'company', hasPan: true, amount: r(25000) }).tds).toBe(r(500)),
  T27: () => {
    const t = tdsOnPayment(cfg, { code: 'contractor', payeeType: 'individual', hasPan: false, amount: r(50000) })
    expect(t.rate).toBe(20); expect(t.tds).toBe(r(10000))
  },
  T28: () => {
    expect(reverseCharge(cfg, 'security_services', { registered: true, bodyCorporate: false }, r(100000)).gst).toBe(r(18000))
    expect(reverseCharge(cfg, 'security_services', { registered: true, bodyCorporate: true }, r(100000)).rcm).toBe(false)
    expect(tdsOnPayment(cfg, { code: 'contractor', payeeType: 'firm', hasPan: true, amount: r(100000) }).tds).toBe(r(2000))
  },
  T29: () => {
    expect(reverseCharge(cfg, 'legal_services_by_advocate', { registered: false, bodyCorporate: false }, r(30000)).gst).toBe(r(5400))
    expect(tdsOnPayment(cfg, { code: 'professional_fees', payeeType: 'individual', hasPan: true, amount: r(30000) }).deduct).toBe(false)
  },
  T30: () => expect(reverseCharge(cfg, 'renting_commercial_property', { registered: false, bodyCorporate: false }, r(100000)).gst).toBe(r(18000)),
  T31: () => expect(tcsPaidOnPurchase(cfg, 'liquor_purchases_from_tasmac', r(500000)).amount).toBe(r(5000)),
  T32: () => expect(cashReceiptCheck(cfg, r(210000)).allowed).toBe(false),
  T33: () => expect(cashExpenseCheck(cfg, r(12000)).warn).toBe(true),
  T34: () => expect(msmePaymentDue(cfg, '2026-05-01', true)).toEqual({ dueDate: '2026-06-15', alertDate: '2026-06-05' }),
  T35: () => expect(commonCreditReversal(r(100000), r(60), r(100))).toBe(r(60000)),
  T36: () => {
    expect(() => restaurantBill(cfg, FY, [{ name: '2 x 60 ml whisky', amount: r(900), liquorClass: 'imfl_spirits' }])).toThrow(VatRateMissing)
    const bill = restaurantBill(cfg, FY, [{ name: '2 x 60 ml whisky', amount: r(900), liquorClass: 'imfl_spirits' }], SAMPLE_VAT)
    expect(bill.gstInvoice).toBeNull(); expect(bill.vatInvoice!.taxable).toBe(r(900))
  },
  T37: () => expect(liquorSaleAllowed(cfg, '2026-10-02T19:00', SAMPLE_HOURS).allowed).toBe(false),
  T38: () => {
    expect(liquorSaleAllowed(cfg, '2026-11-14T23:30', SAMPLE_HOURS).allowed).toBe(false)
    expect(liquorSaleAllowed(cfg, '2026-11-14T20:00', SAMPLE_HOURS).allowed).toBe(true)
  },
  T39: () => expect(formCDue('2026-11-14T22:00:00+05:30')).toBe('2026-11-15T16:30:00.000Z'),
  T40: () => { expect(serviceCharge(r(2000), 5, true)).toBe(0); expect(serviceCharge(r(2000), 5, false)).toBe(r(100)) },
  T41: () => {
    const g = priceGuard(cfg, r(8200))
    expect(g.allowed).toBe(false); expect(g.requires).toBe('managing_director_approval')
    expect(priceGuard(cfg, r(7500)).allowed).toBe(true)
  },
  T42: () => expect(eInvoice(cfg, { b2b: true, invoiceDate: '2026-11-01' }).irnDeadline).toBe('2026-12-01'),
  T43: () => {
    const t = tdsOnPayment(cfg, { code: 'purchase_of_goods', payeeType: 'company', hasPan: true, amount: r(500000), paidEarlierThisYear: r(4800000) })
    expect(t.base).toBe(r(300000)); expect(t.tds).toBe(r(300))
  },
  T44: () => expect(tdsOnPayment(cfg, { code: 'director_fees', payeeType: 'individual', hasPan: true, amount: r(20000) }).tds).toBe(r(2000)),
}

function readBook() {
  const text = readFileSync(fileURLToPath(new URL('../config/tax-test-book.csv', import.meta.url)), 'utf8')
  return text.trim().split('\n').slice(1).map((line) => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''))
    return { id: cells[0], area: cells[1], scenario: cells[2], verdict: cells[6] }
  })
}

const book = readBook()

describe('Tax test book', () => {
  for (const row of book) {
    it(`${row.id} · ${row.area} · ${row.scenario}`, () => {
      const run = cases[row.id]
      expect(run, `No test written for ${row.id}`).toBeTypeOf('function')
      run()
    })
  }

  it('has no tests for rows that were removed from the book', () => {
    const ids = new Set(book.map((r) => r.id))
    expect(Object.keys(cases).filter((id) => !ids.has(id))).toEqual([])
  })

  it('partner payments do not apply to a private limited company', () => {
    expect(tdsOnPayment(cfg, { code: 'partner_payments', payeeType: 'individual', hasPan: true, amount: r(50000) }).deduct).toBe(false)
  })
})
