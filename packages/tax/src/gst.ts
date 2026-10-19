import { TaxConfigError, type Premises, type TaxConfig } from './config'
import { pct, rupees, taxInside, type Paise } from './money'
import { addDays } from './dates'

export interface GstSplit { taxable: Paise; rate: number; cgst: Paise; sgst: Paise; total: Paise }

/** Intra-state supply: half CGST, half SGST, each rounded to the paisa. */
export function splitGst(taxable: Paise, rate: number): GstSplit {
  const cgst = pct(taxable, rate / 2)
  const sgst = pct(taxable, rate / 2)
  return { taxable, rate, cgst, sgst, total: taxable + cgst + sgst }
}

// ---------------------------------------------------------------- rooms

export interface NightInput {
  date: string            // YYYY-MM-DD
  charged: Paise          // room charge for the night after discounts
  extras?: Paise          // extra bed / extra person for the same night
}

export interface NightTax extends GstSplit { date: string; itc: boolean; slabValue: Paise }

/** GST for one room-night. The slab is chosen from the value actually charged for that unit that day. */
export function accommodationNight(cfg: TaxConfig, n: NightInput): NightTax {
  const acc = cfg.gst.accommodation
  const extras = n.extras ?? 0
  const slabValue = n.charged + (acc.extra_charges_count_toward_value ? extras : 0)
  const live = acc.slabs.filter((s) => s.effective_from <= n.date)
  if (!live.length) throw new TaxConfigError(`No accommodation GST slab in force on ${n.date}`)
  const latest = live.reduce((a, s) => (s.effective_from > a ? s.effective_from : a), '')
  const slabs = live.filter((s) => s.effective_from === latest)
  const slab = slabs.find((s) => s.max_value != null && slabValue <= rupees(s.max_value))
    ?? slabs.find((s) => s.min_value != null && slabValue >= rupees(s.min_value))
  if (!slab) throw new TaxConfigError(`No slab matches ${slabValue} paise on ${n.date}`)
  return { ...splitGst(n.charged + extras, slab.rate), date: n.date, itc: slab.itc, slabValue }
}

export const accommodationStay = (cfg: TaxConfig, nights: NightInput[]) => nights.map((n) => accommodationNight(cfg, n))

/** Packages (MAP/AP, getaways) are composite supplies taxed at the principal supply's rate. */
export function packageNight(cfg: TaxConfig, n: NightInput): NightTax {
  return accommodationNight(cfg, n)
}

export interface PriceGuardResult { allowed: boolean; requires: string | null; message: string | null }

/** Selling any unit above the limit makes the premises "specified" next year, so it needs approval. */
export function priceGuard(cfg: TaxConfig, ratePerNight: Paise): PriceGuardResult {
  const g = cfg.gst.accommodation_price_guard
  if (ratePerNight <= rupees(g.limit_per_unit_per_night)) return { allowed: true, requires: null, message: null }
  return { allowed: false, requires: g.above_limit_requires, message: g.warn_text }
}

// ---------------------------------------------------------------- restaurant

export function restaurantPremises(cfg: TaxConfig, fy: string): Premises {
  const sp = cfg.gst.restaurant.specified_premises
  if (sp.opted_in_by_declaration) return 'specified'
  const status = sp.status_by_fy[fy]
  if (!status) throw new TaxConfigError(`Restaurant premises status not set for FY ${fy}`)
  return status
}

/** Next year's status follows the highest single-unit night value sold this year. */
export function premisesForNextFy(cfg: TaxConfig, highestUnitNightThisFy: Paise): Premises {
  return highestUnitNightThisFy > rupees(cfg.gst.accommodation_price_guard.limit_per_unit_per_night) ? 'specified' : 'other'
}

export function restaurantRate(cfg: TaxConfig, fy: string) {
  const premises = restaurantPremises(cfg, fy)
  const r = cfg.gst.restaurant.rates.find((x) => x.premises === premises)
  if (!r) throw new TaxConfigError(`No restaurant rate for ${premises} premises`)
  return { premises, rate: r.rate, itc: r.itc }
}

export interface BillItem { name: string; amount: Paise; liquorClass?: string }

export class VatRateMissing extends TaxConfigError {}

/**
 * Splits one table's order into a GST invoice (food, soft drinks) and a TN VAT invoice
 * (liquor is outside GST). The guest pays the two totals together.
 */
export function restaurantBill(cfg: TaxConfig, fy: string, items: BillItem[], vatOverride?: Record<string, number>) {
  const food = items.filter((i) => !i.liquorClass)
  const liquor = items.filter((i) => i.liquorClass)
  const { rate } = restaurantRate(cfg, fy)
  const gst = food.length ? splitGst(food.reduce((a, i) => a + i.amount, 0), rate) : null
  let vat: { taxable: Paise; vat: Paise; total: Paise } | null = null
  if (liquor.length) {
    let taxable = 0, tax = 0
    for (const i of liquor) {
      const r = vatOverride?.[i.liquorClass!] ?? cfg.tn_vat.rate_table.find((x) => x.class === i.liquorClass)?.rate
      if (r == null) throw new VatRateMissing(`TN VAT rate for "${i.liquorClass}" is not set in tax-config.yaml`)
      taxable += i.amount
      tax += pct(i.amount, r)
    }
    vat = { taxable, vat: tax, total: taxable + tax }
  }
  return { gstInvoice: gst, vatInvoice: vat, payable: (gst?.total ?? 0) + (vat?.total ?? 0) }
}

// ---------------------------------------------------------------- documents

/** GST inside an advance (receipt voucher), or inside a refund (refund voucher). */
export function advanceVoucher(inclusiveAmount: Paise, rate: number) {
  const tax = taxInside(inclusiveAmount, rate)
  return { taxable: inclusiveAmount - tax, gst: tax, cgst: Math.round(tax / 2), sgst: tax - Math.round(tax / 2) }
}

export const creditNote = (reduction: Paise, rate: number) => splitGst(reduction, rate)

export function eInvoice(cfg: TaxConfig, opts: { b2b: boolean; invoiceDate: string }) {
  if (!opts.b2b || !cfg.gst.e_invoice.required_for_resort) return { required: false, irnDeadline: null }
  const deadline = cfg.gst.aato_band === 'above_10_crore'
    ? addDays(opts.invoiceDate, cfg.gst.e_invoice.report_within_days_if_aato_at_least.days)
    : null
  return { required: true, irnDeadline: deadline }
}

// ---------------------------------------------------------------- reverse charge, credits, ITC

export function reverseCharge(cfg: TaxConfig, service: string, supplier: { registered: boolean; bodyCorporate: boolean }, amount: Paise) {
  const rule = cfg.gst.reverse_charge.find((r) => r.service === service)
  if (!rule) return { rcm: false, gst: 0 }
  const applies = rule.applies_when === 'always'
    || (rule.applies_when === 'supplier_not_body_corporate' && !supplier.bodyCorporate)
    || (rule.applies_when === 'supplier_unregistered' && !supplier.registered)
  return applies ? { rcm: true, rate: rule.rate, gst: pct(amount, rule.rate) } : { rcm: false, gst: 0 }
}

/** 2% GST TDS deducted by government departments on contracts above ₹2.5 lakh. */
export function gstTdsByGovernment(cfg: TaxConfig, contractValue: Paise) {
  const r = cfg.gst.credits_to_track.gst_tds_by_government
  return contractValue > rupees(r.contract_value_above) ? pct(contractValue, r.rate) : 0
}

export function otaSettlement(cfg: TaxConfig, o: { roomValue: Paise; date: string; commissionRate: number; ota194oRate: number }) {
  const room = accommodationNight(cfg, { date: o.date, charged: o.roomValue })
  const commission = pct(o.roomValue, o.commissionRate)
  return {
    outputGst: room.cgst + room.sgst,
    commission,
    gstOnCommission: pct(commission, 18),
    gstTcsCredit: pct(o.roomValue, cfg.gst.credits_to_track.gst_tcs_by_ota.rate),
    incomeTaxTdsCredit: pct(o.roomValue, o.ota194oRate),
  }
}

/** Common input credit reversed in the ratio of supplies that carry no ITC (Rule 42 style). */
export const commonCreditReversal = (commonItc: Paise, noItcTurnover: Paise, totalTurnover: Paise) =>
  totalTurnover ? Math.round((commonItc * noItcTurnover) / totalTurnover) : 0
