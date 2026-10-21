import type { Db } from './db'
import { addDays } from './eng-core'
import { codeWages, grossOf, holidaysBetween, leaveDays, monthEndOf, type PayrollConfig, type Slab, type Structure } from './hr'

// The monthly payroll: each person's pay for a month from their structure, attendance and leave, and the
// statutory deductions on it (PF, ESI, Tamil Nadu professional tax and labour welfare fund). The rules and
// rates come from seed/payroll.yaml. Amounts are in paise, rounded to whole rupees as the returns need.

export const rupee = (p: number) => Math.round(p / 100) * 100
const ceilRupee = (p: number) => Math.ceil(p / 100 - 1e-9) * 100
const pct = (p: number, rate: number) => (p * rate) / 100
const R = (rupees: number) => rupees * 100
const daysIn = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
const COMPONENTS = ['basic', 'da', 'hra', 'conveyance', 'special', 'other'] as const

/** Statuses after which a month's pay is settled: salary and leave for it no longer change. */
export const FROZEN = ['submitted', 'checked', 'approved', 'paid']

export interface PayEmployee {
  id: string; code: string; name: string; user_id: string | null; department: string; designation: string; joined_on: string; exit_on: string | null
  dob: string | null; uan: string | null; esic_ip: string | null; pan: string | null; bank_account: string | null; ifsc: string | null
  pf_member: boolean; pt_applicable: boolean; lwf_applicable: boolean
}
export const EMPLOYEE_COLS = `e.id, e.code, e.name, e.user_id, e.department, e.designation, e.joined_on::text as joined_on, e.exit_on::text as exit_on, e.dob::text as dob,
  e.uan, e.esic_ip, e.pan, e.bank_account, e.ifsc, e.pf_member, e.pt_applicable, e.lwf_applicable`

export interface Inputs { lopSet: number | null; otSet: number | null; otherEarnings: number; note: string | null }
export type Line = Record<string, unknown> & { employee_id: string; gross_paise: number; net_paise: number; pf_wages_paise: number; warnings: string[] }

async function structures(t: Db, employeeId: string) {
  const rows = await t.query<Record<string, string | boolean>>('select s.*, s.effective_from::text as effective_from from salary_structure s where s.employee_id = $1 order by s.effective_from', [employeeId])
  return rows.map((s): Structure => ({ basic: Number(s.basic_paise), da: Number(s.da_paise), hra: Number(s.hra_paise), conveyance: Number(s.conveyance_paise), special: Number(s.special_paise), other: Number(s.other_paise), pfOnFull: !!s.pf_on_full_wages, from: String(s.effective_from) }))
}
const structureAt = (list: Structure[], day: string) => list.filter((s) => s.from <= day).at(-1) ?? null

export function slabTax(slabs: Slab[], amountRupees: number) {
  return (slabs.find((s) => s.up_to == null || amountRupees <= s.up_to)?.tax ?? 0)
}

/** The contribution period an ESI month falls in: April–September or October–March. */
export function esiPeriodStart(month: string) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7))
  return m >= 4 && m < 10 ? `${y}-04-01` : m >= 10 ? `${y}-10-01` : `${y - 1}-10-01`
}

/** Days rostered on a shift with no clock-in, no leave and no holiday, up to yesterday. */
async function absences(t: Db, e: PayEmployee, from: string, to: string) {
  if (!e.user_id || from > to) return 0
  const rostered = await t.query<{ day: string }>('select day::text from roster where user_id = $1 and shift_id is not null and day between $2 and $3', [e.user_id, from, to])
  if (!rostered.length) return 0
  const present = new Set((await t.query<{ day: string }>('select distinct day::text from attendance where user_id = $1 and day between $2 and $3', [e.user_id, from, to])).map((r) => r.day))
  const hol = await holidaysBetween(t, from, to)
  const onLeave = new Set<string>()
  for (const a of await t.query<{ from_date: string; to_date: string }>(`select from_date::text, to_date::text from leave_application where employee_id = $1 and status = 'approved' and from_date <= $3 and to_date >= $2`, [e.id, from, to])) {
    for (let d = a.from_date; d <= a.to_date; d = addDays(d, 1)) onLeave.add(d)
  }
  return rostered.filter((r) => !present.has(r.day) && !hol.has(r.day) && !onLeave.has(r.day)).length
}

/** Hours worked beyond the shift, in half hours, each day's first half hour over not counted. */
async function overtime(t: Db, e: PayEmployee, from: string, to: string) {
  if (!e.user_id) return 0
  const rows = await t.query<{ mins: string; starts: string; ends: string }>(
    `select extract(epoch from (a.clock_out_at - a.clock_in_at)) / 60 as mins, s.starts, s.ends from attendance a join shift s on s.id = a.shift_id
      where a.user_id = $1 and a.day between $2 and $3 and a.clock_out_at is not null`, [e.user_id, from, to])
  let half = 0
  for (const r of rows) {
    const m = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5))
    let len = m(r.ends) - m(r.starts)
    if (len <= 0) len += 24 * 60
    const over = Number(r.mins) - len
    if (over >= 30) half += Math.floor(over / 30)
  }
  return half / 2
}

/** Leave without pay approved for days in the range (holidays not counted, half days as half). */
async function leaveWithoutPay(t: Db, e: PayEmployee, from: string, to: string) {
  let days = 0
  for (const a of await t.query<{ from_date: string; to_date: string; half_day: boolean }>(
    `select from_date::text, to_date::text, half_day from leave_application where employee_id = $1 and status = 'approved' and leave_type = 'LOP' and from_date <= $3 and to_date >= $2`, [e.id, from, to])) {
    days += await leaveDays(t, a.from_date > from ? a.from_date : from, a.to_date < to ? a.to_date : to, a.half_day)
  }
  return days
}

/**
 * One person's pay for a month, or null when they were not on the rolls in it. `missing` when they have no
 * pay structure for the month. Earlier months of the half-year count towards professional tax: from their
 * approved runs, or estimated from the structure when the month was paid outside the system.
 */
export async function payLine(t: Db, cfg: PayrollConfig, e: PayEmployee, month: string, inputs: Inputs, today: string): Promise<Line | 'missing' | null> {
  const mStart = `${month}-01`, mEnd = monthEndOf(month), D = daysIn(mStart, mEnd)
  const from = e.joined_on > mStart ? e.joined_on : mStart
  const to = e.exit_on && e.exit_on < mEnd ? e.exit_on : mEnd
  if (from > to) return null
  const list = await structures(t, e.id)
  const last = structureAt(list, to)
  if (!last) return 'missing'
  const warnings: string[] = []
  const employedDays = daysIn(from, to)

  // Leave without pay: approved LOP leave, and days rostered but neither in nor on leave.
  const leaveLop = await leaveWithoutPay(t, e, from, to)
  const yesterday = addDays(today, -1)
  const absent = await absences(t, e, from, to < yesterday ? to : yesterday)
  const autoLop = Math.min(employedDays, leaveLop + absent)
  const lop = Math.max(0, Math.min(employedDays, inputs.lopSet ?? autoLop))
  if (absent) warnings.push(`${absent} day${absent > 1 ? 's' : ''} absent: rostered, not clocked in and not on leave`)
  if (inputs.lopSet != null && inputs.lopSet !== autoLop) warnings.push(`Leave without pay set by HR (worked out: ${autoLop})`)
  const autoOt = await overtime(t, e, from, to)
  const ot = Math.max(0, inputs.otSet ?? autoOt)
  if (inputs.otSet != null && inputs.otSet !== autoOt) warnings.push(`Overtime set by HR (from attendance: ${autoOt} h)`)

  // Each part of the pay for the days on the rolls (a mid-month change of structure counts day by day), less leave without pay.
  const earned = {} as Record<(typeof COMPONENTS)[number], number>
  for (const c of COMPONENTS) {
    let full = 0
    for (let d = from; d <= to; d = addDays(d, 1)) full += (structureAt(list, d)?.[c] ?? 0) / D
    earned[c] = Math.max(0, rupee(full - (lop * last[c]) / D))
  }
  const earnedStructure: Structure = { ...earned, pfOnFull: last.pfOnFull, from: last.from }
  const wages = codeWages(cfg, earnedStructure)
  const monthlyWages = codeWages(cfg, last)
  const hourly = monthlyWages / cfg.wages.working_days_for_hourly_rate / cfg.wages.hours_per_day
  const overtimePay = rupee(hourly * cfg.wages.overtime_multiplier * ot)
  const other = inputs.otherEarnings
  const gross = COMPONENTS.reduce((s, c) => s + earned[c], 0) + overtimePay + other
  const paidDays = employedDays - lop

  // PF on the wages earned, up to the ceiling unless the employee chose full wages; no pension after 58.
  const ceiling = R(cfg.pf.wage_ceiling)
  let pfWages = 0, epsWages = 0, edliWages = 0, pfEmployee = 0, eps = 0, pfEmployer = 0, edli = 0
  if (e.pf_member) {
    pfWages = last.pfOnFull ? wages : Math.min(wages, ceiling)
    const age58 = e.dob ? `${Number(e.dob.slice(0, 4)) + cfg.pf.eps_age_limit}${e.dob.slice(4)}` : null
    epsWages = age58 && age58 <= mStart ? 0 : Math.min(wages, ceiling)
    edliWages = Math.min(wages, ceiling)
    pfEmployee = rupee(pct(pfWages, cfg.pf.employee_percent))
    eps = rupee(pct(epsWages, cfg.pf.eps_percent))
    pfEmployer = rupee(pct(pfWages, cfg.pf.employer_percent)) - eps
    edli = rupee(pct(edliWages, cfg.pf.edli_percent))
    if (!e.uan) warnings.push('No UAN: their PF cannot go in the ECR file')
  }

  // ESI: covered for the whole contribution period when the pay at its start (or on joining) was within the ceiling.
  const periodStart = esiPeriodStart(month)
  const atStart = structureAt(list, e.joined_on > periodStart ? e.joined_on : periodStart) ?? last
  const esiCovered = grossOf(atStart) <= R(cfg.esi.wage_ceiling)
  let esiEmployee = 0, esiEmployer = 0
  if (esiCovered && gross > 0) {
    esiEmployer = ceilRupee(pct(gross, cfg.esi.employer_percent))
    esiEmployee = paidDays > 0 && gross / paidDays > R(cfg.esi.exempt_daily_wage_up_to) ? ceilRupee(pct(gross, cfg.esi.employee_percent)) : 0
    if (!e.esic_ip) warnings.push('No ESIC IP number')
  }

  // Professional tax: on the half-year's pay, in its last month, for those on the rolls long enough in it.
  let pt = 0
  const m = Number(month.slice(5, 7))
  if (e.pt_applicable && cfg.professional_tax.deduct_in_months.includes(m)) {
    const y = Number(month.slice(0, 4))
    const halfStart = m === 9 ? `${y}-04-01` : `${y - 1}-10-01`
    const inHalf = daysIn(e.joined_on > halfStart ? e.joined_on : halfStart, to)
    if (inHalf >= cfg.professional_tax.min_days_in_half) {
      let halfGross = gross, estimated = false
      for (let k = 0; k < 5; k++) {
        const mm = addDays(`${halfStart.slice(0, 7)}-01`, 31 * k + 1).slice(0, 7)
        if (monthEndOf(mm) < e.joined_on || (e.exit_on && e.exit_on < `${mm}-01`)) continue
        const [prev] = await t.query<{ gross_paise: string }>(`select l.gross_paise from payroll_line l join payroll_run r on r.id = l.run_id where r.month = $1 and r.status in ('approved', 'paid') and l.employee_id = $2`, [mm, e.id])
        if (prev) halfGross += Number(prev.gross_paise)
        else { const s = structureAt(list, monthEndOf(mm)); if (s) { halfGross += grossOf(s); estimated = true } }
      }
      pt = R(slabTax(cfg.professional_tax.half_year_slabs, halfGross / 100))
      if (estimated) warnings.push('Note: professional tax counts the months paid outside the system at their full structure')
    }
  }

  // Labour welfare fund: once a year, for those on the rolls on 31 December.
  let lwfEmployee = 0, lwfEmployer = 0
  if (e.lwf_applicable && m === cfg.labour_welfare_fund.deduct_in_month && (!e.exit_on || e.exit_on >= mEnd)) {
    lwfEmployee = R(cfg.labour_welfare_fund.employee); lwfEmployer = R(cfg.labour_welfare_fund.employer)
  }

  // Provisions: bonus for those within its ceiling, gratuity for everyone.
  const bonusBase = Math.min(wages, (R(Math.max(cfg.bonus.calculation_wage_cap, cfg.minimum_wage_per_month ?? 0)) * paidDays) / D)
  const bonus = monthlyWages <= R(cfg.bonus.wage_ceiling) ? rupee(pct(bonusBase, cfg.bonus.provision_percent)) : 0
  const gratuity = rupee(pct(wages, cfg.gratuity.provision_percent))

  if (!e.bank_account || !e.ifsc) warnings.push('No bank account or IFSC: pay by cheque or add them')
  if (cfg.minimum_wage_per_month && grossOf(last) < R(cfg.minimum_wage_per_month)) warnings.push('Monthly pay is below the minimum wage')
  const tds = 0, otherDeductions = 0
  const net = gross - pfEmployee - esiEmployee - pt - lwfEmployee - tds - otherDeductions

  return {
    employee_id: e.id, code: e.code, name: e.name, department: e.department, ledger_dept: cfg.departments[e.department]?.ledger ?? 'admin', designation: e.designation,
    uan: e.uan, esic_ip: e.esic_ip, pan: e.pan, bank_account: e.bank_account, ifsc: e.ifsc,
    lop_set: inputs.lopSet, ot_set: inputs.otSet, other_earnings_paise: other, note: inputs.note, lop_days: lop, ot_hours: ot,
    employed_days: employedDays, paid_days: paidDays, absent_days: absent, leave_lop_days: leaveLop,
    basic_paise: earned.basic, da_paise: earned.da, hra_paise: earned.hra, conveyance_paise: earned.conveyance, special_paise: earned.special, other_paise: earned.other,
    overtime_paise: overtimePay, gross_paise: gross, wages_paise: wages, pf_wages_paise: pfWages, eps_wages_paise: epsWages, edli_wages_paise: edliWages,
    pf_employee_paise: pfEmployee, eps_paise: eps, pf_employer_paise: pfEmployer, edli_paise: edli,
    esi_covered: esiCovered, esi_wages_paise: esiCovered ? gross : 0, esi_employee_paise: esiEmployee, esi_employer_paise: esiEmployer,
    pt_paise: pt, lwf_employee_paise: lwfEmployee, lwf_employer_paise: lwfEmployer, tds_paise: tds, other_deductions_paise: otherDeductions,
    net_paise: net, bonus_provision_paise: bonus, gratuity_provision_paise: gratuity, warnings,
  }
}

export async function saveLine(t: Db, runId: string, l: Line) {
  const cols = Object.keys(l)
  await t.query(`insert into payroll_line (run_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
    on conflict (run_id, employee_id) do update set ${cols.filter((c) => c !== 'employee_id').map((c) => `${c} = excluded.${c}`).join(', ')}`,
  [runId, ...cols.map((c) => (c === 'warnings' ? JSON.stringify(l[c]) : l[c]))])
}

/** The EPF admin charges for the month: a share of all members' PF wages, with a monthly minimum. */
export async function pfAdmin(t: Db, cfg: PayrollConfig, runId: string) {
  const [{ w, n }] = await t.query<{ w: string | null; n: number }>(`select sum(pf_wages_paise) as w, count(*) filter (where pf_wages_paise > 0)::int as n from payroll_line where run_id = $1`, [runId])
  return n ? Math.max(R(cfg.pf.admin_minimum_per_month), rupee(pct(Number(w ?? 0), cfg.pf.admin_percent))) : 0
}

/** Works out every line of a draft run again, keeping what HR set by hand. */
export async function calculate(t: Db, cfg: PayrollConfig, run: { id: string; month: string }, today: string, now: Date) {
  const mStart = `${run.month}-01`, mEnd = monthEndOf(run.month)
  const kept = new Map((await t.query<{ employee_id: string; lop_set: string | null; ot_set: string | null; other_earnings_paise: string; note: string | null }>(
    'select employee_id, lop_set, ot_set, other_earnings_paise, note from payroll_line where run_id = $1', [run.id])).map((l) => [l.employee_id, l]))
  const people = await t.query<PayEmployee>(`select ${EMPLOYEE_COLS} from employee e where e.joined_on <= $2 and (e.exit_on is null or e.exit_on >= $1) order by e.code`, [mStart, mEnd])
  const missing: { id: string; code: string; name: string }[] = []
  const seen = new Set<string>()
  for (const e of people) {
    const k = kept.get(e.id)
    const line = await payLine(t, cfg, e, run.month, { lopSet: k?.lop_set != null ? Number(k.lop_set) : null, otSet: k?.ot_set != null ? Number(k.ot_set) : null, otherEarnings: Number(k?.other_earnings_paise ?? 0), note: k?.note ?? null }, today)
    if (line === 'missing') { missing.push({ id: e.id, code: e.code, name: e.name }); continue }
    if (!line) continue
    await saveLine(t, run.id, line)
    seen.add(e.id)
  }
  for (const id of kept.keys()) if (!seen.has(id)) await t.query('delete from payroll_line where run_id = $1 and employee_id = $2', [run.id, id])
  await t.query('update payroll_run set pf_admin_paise = $2, calculated_at = $3 where id = $1', [run.id, await pfAdmin(t, cfg, run.id), now])
  return missing
}

/** What each authority is owed for a month's run, and when. */
export function duesOf(cfg: PayrollConfig, month: string, totals: Record<string, number>) {
  const next = addDays(`${month}-28`, 4).slice(0, 7)
  const day = (d: number) => `${next}-${String(d).padStart(2, '0')}`
  return [
    { kind: 'pf', name: 'Provident fund (ECR)', amount: totals.pf_employee + totals.eps + totals.pf_employer + totals.edli + totals.pf_admin, due: day(cfg.pf.due_day) },
    { kind: 'esi', name: 'ESI', amount: totals.esi_employee + totals.esi_employer, due: day(cfg.esi.due_day) },
    { kind: 'pt', name: 'Professional tax', amount: totals.pt, due: day(cfg.professional_tax.due_day) },
    { kind: 'lwf', name: 'Labour welfare fund', amount: totals.lwf_employee + totals.lwf_employer, due: `${Number(month.slice(0, 4)) + 1}-${cfg.labour_welfare_fund.due}` },
  ].filter((d) => d.amount > 0)
}

export const TOTAL_COLS = ['gross', 'basic', 'da', 'hra', 'conveyance', 'special', 'other', 'overtime', 'other_earnings', 'wages', 'pf_wages', 'pf_employee', 'eps', 'pf_employer', 'edli', 'esi_employee', 'esi_employer', 'pt', 'lwf_employee', 'lwf_employer', 'tds', 'other_deductions', 'net', 'bonus_provision', 'gratuity_provision']
export async function runTotals(t: Db, runId: string) {
  const [r] = await t.query<Record<string, string | null>>(`select count(*)::int as people, ${TOTAL_COLS.map((c) => `sum(${c}_paise) as ${c}`).join(', ')} from payroll_line where run_id = $1`, [runId])
  const [run] = await t.query<{ pf_admin_paise: string }>('select pf_admin_paise from payroll_run where id = $1', [runId])
  const out: Record<string, number> = { people: Number(r.people), pf_admin: Number(run?.pf_admin_paise ?? 0) }
  for (const c of TOTAL_COLS) out[c] = Number(r[c] ?? 0)
  return out
}

/** The month whose payroll is settled (submitted or later) and covers the day, if any. */
export async function frozenMonth(t: Db, day: string) {
  const [r] = await t.query<{ month: string; status: string }>(`select month, status from payroll_run where month = $1 and status = any($2)`, [day.slice(0, 7), FROZEN])
  return r ?? null
}
/** The latest month whose payroll is settled. */
export async function lastFrozenMonth(t: Db) {
  const [r] = await t.query<{ month: string | null }>(`select max(month) as month from payroll_run where status = any($1)`, [FROZEN])
  return r?.month ?? null
}
