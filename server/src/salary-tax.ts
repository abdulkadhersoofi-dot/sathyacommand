import type { Db } from './db'
import { addDays } from './eng-core'
import { grossOf, type PayrollConfig, type Slab, type Structure, type TaxRegime } from './hr'

// Income tax on salaries: the year's taxable salary projected from what has been paid and the structure for
// the months left, the tax on it under the person's regime, and the month's share of what is still to be
// deducted. The same figures make Form 16 Part B and the year-end annexure of the 24Q. Rates and limits
// come from seed/payroll.yaml (salary_tds). CA check

const R = (rupees: number) => rupees * 100
const rupee = (p: number) => Math.round(p / 100) * 100

/** The financial year a month falls in, as 2026-27, with its first month. */
export function fyOf(month: string) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7))
  const start = m >= 4 ? y : y - 1
  return { fy: `${start}-${String((start + 1) % 100).padStart(2, '0')}`, first: `${start}-04`, last: `${start + 1}-03` }
}
export const fyMonths = (fy: string) => {
  const y = Number(fy.slice(0, 4))
  return Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; return `${m >= 4 ? y : y + 1}-${String(m).padStart(2, '0')}` })
}

/** Tax on a year's taxable income (paise) under a regime: slabs, the rebate (with marginal relief in the new regime) and cess. */
export function taxOn(cfg: PayrollConfig, regime: 'new' | 'old', taxable: number) {
  const r: TaxRegime & { rebate_max?: number } = cfg.salary_tds[regime]
  let tax = 0, prev = 0
  for (const s of r.slabs as Slab[]) {
    const upto = s.up_to == null ? Infinity : R(s.up_to)
    if (taxable > prev) tax += ((Math.min(taxable, upto) - prev) * (s.rate ?? 0)) / 100
    prev = upto
    if (taxable <= upto) break
  }
  tax = Math.round(tax)
  const limit = R(r.rebate_income_up_to)
  let rebate = 0
  if (regime === 'new') rebate = taxable <= limit ? tax : Math.max(0, tax - (taxable - limit))
  else if (taxable <= limit) rebate = Math.min(tax, R(r.rebate_max ?? 0))
  const cess = Math.round(((tax - rebate) * cfg.salary_tds.cess_percent) / 100)
  return { tax, rebate, cess, total: rupee(tax - rebate + cess) }
}

export interface Declaration { regime: 'new' | 'old'; rent: number; sec80c: number; sec80d: number; homeLoan: number; other: number; previousIncome: number; previousTds: number; proofsChecked: boolean }
export async function declarationOf(t: Db, employeeId: string, fy: string, fallbackRegime: string): Promise<Declaration> {
  const [d] = await t.query<Record<string, string | boolean>>('select * from tax_declaration where employee_id = $1 and fy = $2', [employeeId, fy])
  const n = (k: string) => Number(d?.[k] ?? 0)
  return { regime: ((d?.regime as string) ?? fallbackRegime) === 'old' ? 'old' : 'new', rent: n('rent_paid_paise'), sec80c: n('sec80c_paise'), sec80d: n('sec80d_paise'), homeLoan: n('home_loan_interest_paise'),
    other: n('other_deductions_paise'), previousIncome: n('previous_income_paise'), previousTds: n('previous_tds_paise'), proofsChecked: !!d?.proofs_checked }
}

export interface YearFigures {
  fy: string; regime: 'new' | 'old'; salaryPaid: number; salaryProjected: number; previousIncome: number; gross: number; standardDeduction: number; hraExempt: number; professionalTax: number
  deductions: { sec80c: number; sec80d: number; homeLoan: number; other: number }; taxable: number; tax: number; rebate: number; cess: number; annualTax: number; tdsSoFar: number; monthsLeft: number
}

/**
 * The year's figures as seen from a month: `paid` holds the months already paid this year (from approved
 * payrolls), `now` this month's line, and the structure carries the rest of the year to March (or the last day).
 */
export function yearFigures(cfg: PayrollConfig, fy: string, d: Declaration, paid: { gross: number; basic: number; da: number; hra: number; pt: number; tds: number }[],
  now: { gross: number; basic: number; da: number; hra: number; pt: number } | null, rest: { structure: Structure | null; months: number; ptMonths: number }): YearFigures {
  const sum = (k: 'gross' | 'basic' | 'da' | 'hra' | 'pt') => paid.reduce((s, p) => s + p[k], 0) + (now?.[k] ?? 0)
  const s = rest.structure
  const future = s ? grossOf(s) * rest.months : 0
  const salaryPaid = sum('gross'), gross = d.previousIncome + salaryPaid + future
  const r = cfg.salary_tds[d.regime]
  const standardDeduction = Math.min(R(r.standard_deduction), gross)
  let hraExempt = 0, professionalTax = 0
  const deductions = { sec80c: 0, sec80d: 0, homeLoan: 0, other: 0 }
  if (d.regime === 'old') {
    const months = paid.length + (now ? 1 : 0) + rest.months
    const basicDa = sum('basic') + sum('da') + (s ? (s.basic + s.da) * rest.months : 0)
    const hra = sum('hra') + (s ? s.hra * rest.months : 0)
    hraExempt = d.rent ? Math.max(0, Math.min(hra, d.rent * months - basicDa / 10, (basicDa * (cfg.salary_tds.hra_metro ? 50 : 40)) / 100)) : 0
    const ptAhead = s ? rest.ptMonths * R(cfg.professional_tax.half_year_slabs.find((x) => x.up_to == null || (grossOf(s) * 6) / 100 <= x.up_to)?.tax ?? 0) : 0
    professionalTax = sum('pt') + ptAhead
    const caps = cfg.salary_tds.old.deduction_caps
    deductions.sec80c = Math.min(d.sec80c, R(caps.section_80c)); deductions.sec80d = Math.min(d.sec80d, R(caps.section_80d)); deductions.homeLoan = Math.min(d.homeLoan, R(caps.home_loan_interest)); deductions.other = d.other
  }
  const taxable = Math.max(0, Math.floor((gross - standardDeduction - hraExempt - professionalTax - deductions.sec80c - deductions.sec80d - deductions.homeLoan - deductions.other) / 1000) * 1000)   // to the ₹10
  const t = taxOn(cfg, d.regime, taxable)
  return { fy, regime: d.regime, salaryPaid, salaryProjected: future, previousIncome: d.previousIncome, gross, standardDeduction, hraExempt, professionalTax, deductions, taxable, tax: t.tax, rebate: t.rebate, cess: t.cess, annualTax: t.total,
    tdsSoFar: d.previousTds + paid.reduce((x, p) => x + p.tds, 0), monthsLeft: (now ? 1 : 0) + rest.months }
}

/** The months of the year already paid to a person, from approved payrolls before a month. */
export async function paidThisYear(t: Db, employeeId: string, fy: string, before: string) {
  const { first } = fyOf(`${fy.slice(0, 4)}-04`)
  return (await t.query<Record<string, string>>(
    `select l.gross_paise, l.basic_paise, l.da_paise, l.hra_paise, l.pt_paise, l.tds_paise from payroll_line l join payroll_run r on r.id = l.run_id
      where l.employee_id = $1 and r.status in ('approved', 'paid') and r.month >= $2 and r.month < $3 order by r.month`, [employeeId, first, before]))
    .map((l) => ({ gross: Number(l.gross_paise), basic: Number(l.basic_paise), da: Number(l.da_paise), hra: Number(l.hra_paise), pt: Number(l.pt_paise), tds: Number(l.tds_paise) }))
}

/** Months after `month` up to March, or to the last day for someone leaving; and how many of them deduct professional tax. */
export function monthsAfter(cfg: PayrollConfig, month: string, exitOn: string | null) {
  const { last } = fyOf(month)
  let n = 0, pt = 0
  for (let m = addDays(`${month}-28`, 4).slice(0, 7); m <= last; m = addDays(`${m}-28`, 4).slice(0, 7)) {
    if (exitOn && `${m}-01` > exitOn) break
    n++
    if (cfg.professional_tax.deduct_in_months.includes(Number(m.slice(5, 7)))) pt++
  }
  return { months: n, ptMonths: pt }
}

/** This month's deduction: what is still due for the year spread over the months left; more without a PAN. */
export function monthTds(cfg: PayrollConfig, y: YearFigures, grossThisMonth: number, hasPan: boolean) {
  let tds = y.monthsLeft ? Math.max(0, rupee((y.annualTax - y.tdsSoFar) / y.monthsLeft)) : 0
  if (!hasPan && y.annualTax > 0) tds = Math.max(tds, rupee((grossThisMonth * cfg.salary_tds.no_pan_rate) / 100))
  return tds
}
