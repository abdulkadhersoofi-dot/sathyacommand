import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import type { Db } from './db'
import { addDays } from './eng-core'

// HR rules shared by the HR screens and payroll: the departments, leave types and how they are credited,
// the holiday calendar, and each person's salary structure for a month. The rules come from
// seed/payroll.yaml, which HR and the CA review.

export interface Slab { up_to: number | null; rate?: number; tax?: number }
export interface LeaveRule { name: string; days: number; credit: 'yearly' | 'monthly' | 'by_grant' | 'none'; after_months?: number; carry_forward: number; paid: boolean; encashable?: boolean; certificate_after_days?: number; expires_days?: number }
export interface PayrollConfig {
  departments: Record<string, { name: string; ledger: string }>
  leave_types: Record<string, LeaveRule>
  national_holidays: string[]
  festival_holidays_required: number
  onboarding_checklist: string[]
  wages: { exclusions_cap_percent: number; overtime_multiplier: number; working_days_for_hourly_rate: number; hours_per_day: number }
  pf: { wage_ceiling: number; employee_percent: number; employer_percent: number; eps_percent: number; edli_percent: number; admin_percent: number; admin_minimum_per_month: number; eps_age_limit: number; due_day: number }
  esi: { wage_ceiling: number; employee_percent: number; employer_percent: number; exempt_daily_wage_up_to: number; periods: string[]; due_day: number }
  professional_tax: { deduct_in_months: number[]; half_year_slabs: Slab[] }
  labour_welfare_fund: { employee: number; employer: number; deduct_in_month: number }
  bonus: { wage_ceiling: number; calculation_wage_cap: number; provision_percent: number }
  gratuity: { provision_percent: number; min_years: number; min_years_fixed_term: number; ceiling: number }
  salary_tds: { cess_percent: number; new: TaxRegime; old: TaxRegime & { rebate_max: number; deduction_caps: Record<string, number> } }
  minimum_wage_per_month: number | null
}
export interface TaxRegime { standard_deduction: number; slabs: Slab[]; rebate_income_up_to: number }

export const loadPayrollConfig = (): PayrollConfig =>
  parse(readFileSync(fileURLToPath(new URL('../seed/payroll.yaml', import.meta.url)), 'utf8'))

export const PAN_RE = /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
export const monthsBetween = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7))
export const monthEndOf = (m: string) => addDays(`${addDays(`${m}-28`, 4).slice(0, 7)}-01`, -1)

export interface Structure { basic: number; da: number; hra: number; conveyance: number; special: number; other: number; pfOnFull: boolean; from: string }

/** The salary structure in force on a day (the latest one from on or before it). */
export async function structureOn(t: Db, employeeId: string, day: string): Promise<Structure | null> {
  const [s] = await t.query<{ basic_paise: string; da_paise: string; hra_paise: string; conveyance_paise: string; special_paise: string; other_paise: string; pf_on_full_wages: boolean; effective_from: string }>(
    'select s.*, s.effective_from::text as effective_from from salary_structure s where s.employee_id = $1 and s.effective_from <= $2 order by s.effective_from desc limit 1', [employeeId, day])
  if (!s) return null
  const n = (v: string) => Number(v)
  return { basic: n(s.basic_paise), da: n(s.da_paise), hra: n(s.hra_paise), conveyance: n(s.conveyance_paise), special: n(s.special_paise), other: n(s.other_paise), pfOnFull: s.pf_on_full_wages, from: s.effective_from }
}
export const grossOf = (s: Structure) => s.basic + s.da + s.hra + s.conveyance + s.special + s.other

/** Wages under the Code on Wages: basic and DA, plus whatever the exclusions exceed of half the total. CA check */
export function codeWages(cfg: PayrollConfig, s: Structure) {
  const gross = grossOf(s), wages = s.basic + s.da
  const cap = Math.round((gross * cfg.wages.exclusions_cap_percent) / 100)
  return Math.min(gross, wages + Math.max(0, gross - wages - cap))
}

export async function holidaysBetween(t: Db, from: string, to: string) {
  return new Set((await t.query<{ day: string }>('select day::text from holiday where day between $1 and $2', [from, to])).map((h) => h.day))
}

/** Leave days in a range: holidays are not counted; a half day is half. */
export async function leaveDays(t: Db, from: string, to: string, halfDay: boolean) {
  const hol = await holidaysBetween(t, from, to)
  let days = 0
  for (let d = from; d <= to; d = addDays(d, 1)) if (!hol.has(d)) days++
  return halfDay ? Math.min(days, 1) / 2 : days
}

const round1 = (x: number) => Math.round(x * 2) / 2

/**
 * Puts in the credits a person is due for a leave year up to a day, once each: yearly types at the start
 * of the year (or pro rata from joining), earned leave month by month after the qualifying service, and
 * what may be carried forward from last year.
 */
export async function ensureCredits(t: Db, cfg: PayrollConfig, e: { id: string; joined_on: string; exit_on: string | null }, year: number, today: string, now: Date) {
  const add = (type: string, days: number, reason: string, ref: string) => days > 0
    ? t.query(`insert into leave_entry (id, employee_id, leave_type, year, days, reason, ref, at) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (employee_id, leave_type, ref) where ref is not null do nothing`,
      [`LE-${e.id}-${type}-${ref}`, e.id, type, year, days, reason, ref, now])
    : Promise.resolve()
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`
  if (e.joined_on > yEnd || (e.exit_on && e.exit_on < yStart) || today < yStart) return
  for (const [type, r] of Object.entries(cfg.leave_types)) {
    if (r.credit === 'yearly') {
      const months = e.joined_on > yStart ? 12 - Number(e.joined_on.slice(5, 7)) + 1 : 12
      await add(type, round1((r.days * months) / 12), months < 12 ? `${r.name} for ${year}, from joining` : `${r.name} for ${year}`, `credit:${year}`)
    }
    if (r.credit === 'monthly') {
      const qualifies = addDays(e.joined_on, 0).slice(0, 7)
      for (let m = 1; m <= 12; m++) {
        const month = `${year}-${String(m).padStart(2, '0')}`
        if (monthEndOf(month) >= today) break                                // credited once the month is over
        if (monthsBetween(qualifies, month) < (r.after_months ?? 0)) continue
        await add(type, Math.round((r.days / 12) * 100) / 100, `${r.name} for ${month}`, `accrual:${month}`)
      }
    }
    if (r.carry_forward > 0) {
      const [{ b }] = await t.query<{ b: string | null }>('select sum(days) as b from leave_entry where employee_id = $1 and leave_type = $2 and year = $3', [e.id, type, year - 1])
      await add(type, Math.min(r.carry_forward, Math.max(0, Number(b ?? 0))), `Carried forward from ${year - 1}`, `carry:${year}`)
    }
  }
}

export async function balances(t: Db, cfg: PayrollConfig, employeeId: string, year: number) {
  const rows = await t.query<{ leave_type: string; b: string }>('select leave_type, sum(days) as b from leave_entry where employee_id = $1 and year = $2 group by leave_type', [employeeId, year])
  return Object.entries(cfg.leave_types).filter(([, r]) => r.credit !== 'none').map(([type, r]) => ({ type, name: r.name, balance: Number(rows.find((x) => x.leave_type === type)?.b ?? 0) }))
}

/** The four national holidays every year, as the law requires; HR adds the festival holidays. */
export async function ensureHolidays(db: Db, cfg: PayrollConfig, years: number[]) {
  const names: Record<string, string> = { '01-26': 'Republic Day', '05-01': 'May Day', '08-15': 'Independence Day', '10-02': 'Gandhi Jayanti' }
  for (const y of years) for (const md of cfg.national_holidays) await db.query(`insert into holiday (day, name, kind) values ($1, $2, 'national') on conflict do nothing`, [`${y}-${md}`, names[md] ?? 'National holiday'])
}
