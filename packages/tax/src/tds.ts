import { TaxConfigError, type TaxConfig } from './config'
import { pct, rupees, type Paise } from './money'

export type PayeeType = 'individual' | 'huf' | 'company' | 'firm' | 'other'

export interface TdsInput {
  code: string                 // nature of payment, e.g. "contractor"
  payeeType: PayeeType
  hasPan: boolean
  amount: Paise                // this bill / payment
  paidEarlierThisYear?: Paise  // to the same payee, same nature, this tax year
  alreadyTaxedEarlier?: Paise  // part of the earlier amount that already suffered TDS
}

export interface TdsResult { deduct: boolean; rate: number; base: Paise; tds: Paise; section: string; reason: string }

/**
 * TDS on a payment, following the threshold rules: once the yearly aggregate is crossed,
 * TDS applies to the whole aggregate, including earlier bills that were below the limit.
 */
export function tdsOnPayment(cfg: TaxConfig, i: TdsInput): TdsResult {
  const rule = cfg.income_tax.tds.find((r) => r.code === i.code)
  if (!rule) throw new TaxConfigError(`Unknown TDS code "${i.code}"`)
  if (rule.applies_to_resort === false) return none(rule.old_section, 'Not applicable to this entity')
  if (rule.rate === 'slab') throw new TaxConfigError('Salary TDS is computed by payroll, not per payment')

  let rate = typeof rule.rate === 'number' ? rule.rate
    : i.payeeType === 'individual' || i.payeeType === 'huf' ? rule.rate.individual_huf : rule.rate.others
  if (!i.hasPan) rate = Math.max(rate, cfg.income_tax.no_pan_rate)

  const t = rule.threshold ?? {}
  const prior = i.paidEarlierThisYear ?? 0
  const untaxedPrior = prior - (i.alreadyTaxedEarlier ?? 0)
  const aggregate = prior + i.amount
  let base = 0
  let reason = ''

  if (t.annual_per_vendor != null) {
    const limit = rupees(t.annual_per_vendor)
    base = Math.max(0, Math.min(i.amount, aggregate - limit))
    reason = base ? `Purchases above ${limit / 100} this year` : 'Below yearly purchase limit'
  } else if (t.monthly != null) {
    base = i.amount > rupees(t.monthly) ? i.amount : 0
    reason = base ? 'Monthly amount above threshold' : 'Monthly amount within threshold'
  } else {
    if (t.annual != null && aggregate > rupees(t.annual)) {
      base = i.amount + untaxedPrior
      reason = 'Yearly aggregate above threshold'
    } else if (t.single != null && i.amount > rupees(t.single)) {
      base = i.amount
      reason = 'Single bill above threshold'
    } else reason = 'Within thresholds'
  }
  if (!base) return none(rule.old_section, reason)
  return { deduct: true, rate, base, tds: pct(base, rate), section: rule.old_section, reason }
}

const none = (section: string, reason: string): TdsResult => ({ deduct: false, rate: 0, base: 0, tds: 0, section, reason })

/** Tax a client or OTA is expected to deduct from what it pays the resort (a credit to chase in 26AS). */
export function expectedDeductionFromResort(cfg: TaxConfig, by: string, amount: Paise) {
  const r = cfg.income_tax.deducted_from_resort.find((x) => x.by === by)
  if (!r) throw new TaxConfigError(`No deduction rule for "${by}"`)
  return { section: r.old_section, rate: r.rate, amount: pct(amount, r.rate) }
}

/** TCS the resort pays on purchases (e.g. liquor bought for resale) and can claim as credit. */
export function tcsPaidOnPurchase(cfg: TaxConfig, on: string, amount: Paise) {
  const r = cfg.income_tax.tcs_paid_by_resort.find((x) => x.on === on)
  if (!r) throw new TaxConfigError(`No TCS rule for "${on}"`)
  return { section: r.old_section, rate: r.rate, amount: pct(amount, r.rate) }
}
