import type { FastifyInstance, FastifyRequest } from 'fastify'
import { amountInWords } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { balances, codeWages, ensureCredits, grossOf, loadPayrollConfig, monthEndOf, monthsBetween, structureOn, type PayrollConfig } from '../hr'
import { defaultBankCode, postPending } from '../ledger'
import { advancesOutstanding, closeRecovered, EMPLOYEE_COLS, type PayEmployee } from '../payroll'
import { declarationOf, fyMonths, fyOf, monthsAfter, paidThisYear, yearFigures } from '../salary-tax'
import { roleLimit } from './approvals'
import { requireCaller } from './auth'

// Each person's side of the payroll: their tax declaration and the year's tax, salary advances and loans,
// the full and final settlement when they leave, Form 16 Part B, the 24Q figures, their own payslips in the
// staff app, and the comparison with the payroll the resort runs today (the parallel run).

const FY = /^\d{4}-\d{2}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const str = (v: unknown, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null }
const paise = (v: unknown, label: string, max = 10_000_000) => {
  const x = Number(v ?? 0)
  if (!Number.isFinite(x) || x < 0 || x > max) throw new HttpError(400, `${label}: ₹0 to ₹${max.toLocaleString('en-IN')}.`)
  return Math.round(x * 100)
}
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const rupee = (p: number) => Math.round(p / 100) * 100
const COMPARE_FIELDS = [['gross', 'gross_paise'], ['pf', 'pf_employee_paise'], ['esi', 'esi_employee_paise'], ['pt', 'pt_paise'], ['lwf', 'lwf_employee_paise'], ['tds', 'tds_paise'], ['net', 'net_paise']] as const

/** A simple CSV reader: commas, quoted cells, a header row. */
export function parseCsv(text: string) {
  const rows: string[][] = []
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (!raw.trim()) continue
    const cells: string[] = []
    let cur = '', q = false
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      if (q) { if (c === '"' && raw[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false; else cur += c }
      else if (c === '"') q = true
      else if (c === ',') { cells.push(cur); cur = '' }
      else cur += c
    }
    cells.push(cur)
    rows.push(cells.map((c) => c.trim()))
  }
  return rows
}

export function payrollPeopleRoutes(app: FastifyInstance, ctx: Ctx, cfg: PayrollConfig = loadPayrollConfig()) {
  const db = ctx.db
  const now = () => ctx.now()
  const SEE = ['payroll.run', 'payroll.view', 'payroll.approve', 'payroll.pay']

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  async function employee(t: Db, id: string) {
    const [e] = await t.query<PayEmployee & { employment_type: string; status: string }>(`select ${EMPLOYEE_COLS}, e.employment_type, e.status from employee e where e.id = $1`, [id])
    if (!e) throw new HttpError(404, 'No such employee.')
    return e
  }
  /** Payroll people, or the employee themselves. */
  async function selfOr(req: FastifyRequest, employeeId: string) {
    const who = await requireCaller(ctx, req)
    const e = await employee(db, employeeId)
    if (e.user_id !== who.userId && !SEE.some((p) => can(who, p))) throw new HttpError(403, 'Only payroll or the employee sees this.')
    return { who, e, self: e.user_id === who.userId }
  }
  async function employer(t: Db) {
    const [p] = await t.query<{ legal_name: string | null; name: string; address: string | null; city: string | null; tan: string | null; tds_responsible: string | null; tds_responsible_designation: string | null }>(
      'select legal_name, name, address, city, tan, tds_responsible, tds_responsible_designation from property limit 1')
    return { name: p?.legal_name ?? p?.name ?? '', address: [p?.address, p?.city].filter(Boolean).join(', '), tan: p?.tan ?? null, responsible: p?.tds_responsible ?? null, designation: p?.tds_responsible_designation ?? null }
  }

  // ---------- the year's tax ----------
  /**
   * The year as projected now: the months paid through approved payrolls, then the structure from the month
   * after the last of them (or this month) to March. Pay before the system took over is in the declaration.
   */
  async function projection(t: Db, e: PayEmployee, fy: string, today: string, regime?: 'new' | 'old') {
    const { first, last } = fyOf(`${fy.slice(0, 4)}-04`)
    const [{ m }] = await t.query<{ m: string | null }>(`select max(r.month) as m from payroll_line l join payroll_run r on r.id = l.run_id where l.employee_id = $1 and r.status in ('approved', 'paid') and r.month between $2 and $3`, [e.id, first, last])
    const clamp = (x: string) => (x < first ? first : x > last ? last : x)
    // Nothing approved yet this year: from the first payroll they are in (still a draft), or this month.
    const [{ d }] = m ? [{ d: null }] : await t.query<{ d: string | null }>(`select min(r.month) as d from payroll_line l join payroll_run r on r.id = l.run_id where l.employee_id = $1 and r.status <> 'cancelled' and r.month between $2 and $3`, [e.id, first, last])
    const from = m ? addDays(`${m}-28`, 4).slice(0, 7) : clamp(d && d < today.slice(0, 7) ? d : today.slice(0, 7))
    const saved = await declarationOf(t, e.id, fy, e.tax_regime)
    const declaration = regime ? { ...saved, regime } : saved
    const paid = await paidThisYear(t, e.id, fy, from)
    const ahead = from > last ? { months: 0, ptMonths: 0 } : monthsAfter(cfg, from, e.exit_on)
    const s = from > last ? null : await structureOn(t, e.id, monthEndOf(from))
    const startsCount = from <= last && (!e.exit_on || e.exit_on >= `${from}-01`) ? 1 : 0
    const ptNow = startsCount && cfg.professional_tax.deduct_in_months.includes(Number(from.slice(5, 7))) ? 1 : 0
    return { declaration, year: yearFigures(cfg, fy, declaration, paid, null, { structure: s, months: ahead.months + startsCount, ptMonths: ahead.ptMonths + ptNow }) }
  }

  app.get('/api/payroll/declarations/:employeeId', async (req) => {
    const { e } = await selfOr(req, (req.params as { employeeId: string }).employeeId)
    const today = await businessDate(db)
    const fy = (req.query as { fy?: string }).fy ?? fyOf(today.slice(0, 7)).fy
    if (!FY.test(fy)) throw new HttpError(400, 'Enter the year as 2026-27.')
    return { fy, ...(await projection(db, e, fy, today)), compare: await regimeCompare(db, e, fy, today) }
  })

  /** The year's tax under both regimes, so the person can choose. */
  async function regimeCompare(t: Db, e: PayEmployee, fy: string, today: string) {
    return { new: (await projection(t, e, fy, today, 'new')).year.annualTax, old: (await projection(t, e, fy, today, 'old')).year.annualTax }
  }

  app.put('/api/payroll/declarations/:employeeId', async (req) => {
    const { who, e, self } = await selfOr(req, (req.params as { employeeId: string }).employeeId)
    const hr = can(who, 'payroll.run') || can(who, 'hr.manage')
    if (!self && !hr) throw new HttpError(403, 'Only HR or the employee changes the declaration.')
    const b = (req.body ?? {}) as { fy?: string; regime?: string; rent?: number; sec80c?: number; sec80d?: number; homeLoan?: number; other?: number; previousIncome?: number; previousTds?: number; proofsChecked?: boolean }
    if (!FY.test(b.fy ?? '')) throw new HttpError(400, 'Enter the year as 2026-27.')
    if (!['new', 'old'].includes(b.regime ?? '')) throw new HttpError(400, 'Regime: new or old.')
    return db.tx(async (t) => {
      const [cur] = await t.query<{ proofs_checked: boolean }>('select proofs_checked from tax_declaration where employee_id = $1 and fy = $2', [e.id, b.fy])
      if (cur?.proofs_checked && !hr) throw new HttpError(409, 'HR has checked the proofs: ask HR to change it.')
      const row = [e.id, b.fy, b.regime, paise(b.rent, 'Rent a month', 1_000_000), paise(b.sec80c, '80C'), paise(b.sec80d, '80D'), paise(b.homeLoan, 'Home loan interest'), paise(b.other, 'Other deductions'),
        paise(b.previousIncome, 'Salary from an earlier employer', 100_000_000), paise(b.previousTds, 'Tax deducted by them', 100_000_000), hr ? !!b.proofsChecked : false, who.userId, now()]
      await t.query(`insert into tax_declaration (employee_id, fy, regime, rent_paid_paise, sec80c_paise, sec80d_paise, home_loan_interest_paise, other_deductions_paise, previous_income_paise, previous_tds_paise, proofs_checked, updated_by, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (employee_id, fy) do update set regime = excluded.regime, rent_paid_paise = excluded.rent_paid_paise, sec80c_paise = excluded.sec80c_paise,
          sec80d_paise = excluded.sec80d_paise, home_loan_interest_paise = excluded.home_loan_interest_paise, other_deductions_paise = excluded.other_deductions_paise, previous_income_paise = excluded.previous_income_paise,
          previous_tds_paise = excluded.previous_tds_paise, proofs_checked = excluded.proofs_checked, updated_by = excluded.updated_by, updated_at = excluded.updated_at`, row)
      await appendAudit(t, { actor: who, action: 'payroll.declaration_set', entity: { type: 'employee', id: e.id }, after: { fy: b.fy, regime: b.regime, proofsChecked: row[10] } }, now())
      return { ok: true, ...(await projection(t, e, b.fy!, await businessDate(t))) }
    })
  })

  // ---------- salary advances and loans ----------
  app.get('/api/payroll/advances', async (req) => {
    const who = await requireCaller(ctx, req)
    const q = req.query as { employeeId?: string; status?: string }
    if (!q.employeeId && !SEE.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot see advances.')
    if (q.employeeId) await selfOr(req, q.employeeId)
    const rows = await db.query<{ id: string; employee_id: string; status: string }>(
      `select a.id, a.employee_id, e.name, e.code, a.kind, a.amount_paise, a.instalment_paise, a.reason, a.status, a.requested_at, a.issued_on::text, u.name as requested_by, d.name as decided_by
         from salary_advance a join employee e on e.id = a.employee_id join app_user u on u.id = a.requested_by left join app_user d on d.id = a.decided_by
        where ($1::text is null or a.employee_id = $1) and ($2::text is null or a.status = $2) order by a.requested_at desc limit 200`, [q.employeeId ?? null, q.status ?? null])
    const out = []
    for (const r of rows) {
      const o = (await advancesOutstanding(db, r.employee_id)).find((a) => a.id === r.id)
      out.push({ ...r, amount_paise: Number((r as Record<string, unknown>).amount_paise), instalment_paise: Number((r as Record<string, unknown>).instalment_paise), outstandingPaise: o ? o.outstanding : r.status === 'closed' ? 0 : Number((r as Record<string, unknown>).amount_paise) })
    }
    return out
  })

  app.post('/api/payroll/advances', async (req, reply) => {
    const who = await need(req, 'payroll.run', 'hr.manage')
    const b = (req.body ?? {}) as { employeeId?: string; kind?: string; amount?: number; instalment?: number; reason?: string }
    if (!['advance', 'loan'].includes(b.kind ?? '')) throw new HttpError(400, 'An advance or a loan?')
    const amount = paise(b.amount, 'Amount', 500_000), instalment = paise(b.instalment, 'Instalment', 500_000)
    if (!amount || !instalment) throw new HttpError(400, 'Enter the amount and the monthly instalment.')
    if (instalment > amount) throw new HttpError(400, 'The instalment is more than the amount.')
    const reason = str(b.reason, 200)
    if (!reason) throw new HttpError(400, 'What is it for?')
    return db.tx(async (t) => {
      const e = await employee(t, b.employeeId ?? '')
      if (e.status === 'exited') throw new HttpError(409, 'They have left.')
      const s = await structureOn(t, e.id, await businessDate(t))
      if (s && instalment > grossOf(s) / 2) throw new HttpError(400, 'An instalment of more than half the monthly pay leaves too little to live on.')
      const within = amount <= (await roleLimit(t, who, 'salary_advance')) * 100
      const id = newId('ADV')
      await t.query(`insert into salary_advance (id, employee_id, kind, amount_paise, instalment_paise, reason, status, requested_by, requested_at, decided_by, decided_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, e.id, b.kind, amount, instalment, reason, within ? 'approved' : 'pending', who.userId, now(), within ? who.userId : null, within ? now() : null])
      await appendAudit(t, { actor: who, action: 'payroll.advance_requested', entity: { type: 'salary_advance', id }, amount, after: { employee: e.code, kind: b.kind, instalment, status: within ? 'approved' : 'pending' } }, now())
      return reply.status(201).send({ id, status: within ? 'approved' : 'pending' })
    })
  })

  app.post('/api/payroll/advances/:id/decide', async (req) => {
    const who = await need(req, 'payroll.approve')
    const b = (req.body ?? {}) as { decision?: string; note?: string }
    if (!['approve', 'reject'].includes(b.decision ?? '')) throw new HttpError(400, 'approve or reject.')
    return db.tx(async (t) => {
      const [a] = await t.query<{ id: string; status: string; requested_by: string }>('select id, status, requested_by from salary_advance where id = $1 for update', [(req.params as { id: string }).id])
      if (!a) throw new HttpError(404, 'No such advance.')
      if (a.status !== 'pending') throw new HttpError(409, `Already ${a.status}.`)
      if (a.requested_by === who.userId && !who.permissions.has('*')) throw new HttpError(403, 'Someone else decides your own request.')
      await t.query('update salary_advance set status = $2, decided_by = $3, decided_at = $4 where id = $1', [a.id, b.decision === 'approve' ? 'approved' : 'rejected', who.userId, now()])
      await appendAudit(t, { actor: who, action: `payroll.advance_${b.decision === 'approve' ? 'approved' : 'rejected'}`, entity: { type: 'salary_advance', id: a.id }, note: str(b.note, 120) ?? undefined }, now())
      return { ok: true }
    })
  })

  app.post('/api/payroll/advances/:id/issue', async (req) => {
    const who = await need(req, 'payroll.pay')
    const b = (req.body ?? {}) as { issuedOn?: string; bankCode?: string; reference?: string }
    if (!DATE.test(b.issuedOn ?? '')) throw new HttpError(400, 'The date it was paid.')
    const res = await db.tx(async (t) => {
      const [a] = await t.query<{ id: string; status: string; amount_paise: string }>('select id, status, amount_paise from salary_advance where id = $1 for update', [(req.params as { id: string }).id])
      if (!a) throw new HttpError(404, 'No such advance.')
      if (a.status !== 'approved') throw new HttpError(409, a.status === 'pending' ? 'It is waiting for the GM.' : `It is ${a.status}.`)
      const bank = b.bankCode ? (await t.query<{ account_code: string }>('select account_code from bank_account where account_code = $1 and active', [b.bankCode]))[0]?.account_code : await defaultBankCode(t)
      if (!bank) throw new HttpError(400, 'No such bank account.')
      await t.query(`update salary_advance set status = 'active', issued_on = $2, bank_code = $3, reference = $4 where id = $1`, [a.id, b.issuedOn, bank, str(b.reference, 80)])
      await appendAudit(t, { actor: who, action: 'payroll.advance_paid', entity: { type: 'salary_advance', id: a.id }, amount: Number(a.amount_paise), after: { issuedOn: b.issuedOn } }, now())
      return { ok: true }
    })
    await postPending(db, now())
    return res
  })

  // ---------- full and final settlement ----------
  async function settlementItems(t: Db, e: PayEmployee & { employment_type: string }, lastDay: string, notice: number, other: { label: string; amount: number }[]) {
    const items: { key: string; label: string; amount_paise: number; detail: string }[] = []
    const s = await structureOn(t, e.id, lastDay)
    if (!s) throw new HttpError(409, 'They have no pay structure.')
    const wages = codeWages(cfg, s), basicDa = s.basic + s.da
    const year = Number(lastDay.slice(0, 4))
    await ensureCredits(t, cfg, e, year, addDays(lastDay, 1), now())
    const encashable = Object.entries(cfg.leave_types).filter(([, r]) => r.encashable).map(([k]) => k)
    for (const b of (await balances(t, cfg, e.id, year)).filter((x) => encashable.includes(x.type) && x.balance > 0)) {
      items.push({ key: 'leave', label: `${b.name} not taken (${b.balance} days)`, amount_paise: rupee((b.balance * basicDa) / cfg.settlement.leave_encashment_days_divisor), detail: `${b.balance} × (basic + DA) ÷ ${cfg.settlement.leave_encashment_days_divisor}` })
    }
    const months = monthsBetween(e.joined_on.slice(0, 7), lastDay.slice(0, 7)) + (Number(lastDay.slice(8, 10)) >= Number(e.joined_on.slice(8, 10)) ? 0 : -1)
    const years = Math.floor(months / 12) + (months % 12 >= 6 ? 1 : 0)
    const eligible = months >= cfg.gratuity.min_years * 12 || (e.employment_type === 'fixed_term' && months >= cfg.gratuity.min_years_fixed_term * 12)
    if (eligible) {
      const g = Math.min(rupee((wages * cfg.settlement.gratuity_days_per_year * years) / cfg.settlement.gratuity_days_divisor), cfg.gratuity.ceiling * 100)
      items.push({ key: 'gratuity', label: `Gratuity for ${years} years`, amount_paise: g, detail: `${cfg.settlement.gratuity_days_per_year} ÷ ${cfg.settlement.gratuity_days_divisor} × wages × ${years}` })
    }
    const { fy, first } = fyOf(lastDay.slice(0, 7))
    const [{ bonus }] = await t.query<{ bonus: string | null }>(`select sum(l.bonus_provision_paise) as bonus from payroll_line l join payroll_run r on r.id = l.run_id where l.employee_id = $1 and r.status in ('approved', 'paid') and r.month >= $2`, [e.id, first])
    if (Number(bonus ?? 0) > 0) items.push({ key: 'bonus', label: `Bonus for ${fy} so far`, amount_paise: Number(bonus), detail: 'as provided for each month' })
    const owed = (await advancesOutstanding(t, e.id)).reduce((x, a) => x + a.outstanding, 0)
    if (owed > 0) items.push({ key: 'advance', label: 'Salary advance or loan still owed', amount_paise: -owed, detail: '' })
    if (notice > 0) items.push({ key: 'notice', label: 'Notice period not served', amount_paise: -notice, detail: '' })
    for (const o of other) items.push({ key: 'other', label: o.label, amount_paise: o.amount, detail: '' })
    return items
  }
  const inputs = (b: { notice?: number; other?: { label?: string; amount?: number }[] }) => ({
    notice: paise(b.notice, 'Notice recovery', 1_000_000),
    other: (b.other ?? []).filter((o) => str(o.label)).map((o) => {
      const x = Math.round(Number(o.amount) * 100)
      if (!Number.isFinite(x) || Math.abs(x) > 100_000_000) throw new HttpError(400, 'Other amounts: up to ₹10 lakh either way.')
      return { label: str(o.label, 120)!, amount: x }
    }),
  })

  app.post('/api/payroll/settlements/preview', async (req) => {
    await need(req, 'payroll.run')
    const b = (req.body ?? {}) as { employeeId?: string; notice?: number; other?: { label?: string; amount?: number }[] }
    const e = await employee(db, b.employeeId ?? '')
    if (!e.exit_on) throw new HttpError(409, 'Record their last day first (Leaving…).')
    const { notice, other } = inputs(b)
    const items = await db.tx((t) => settlementItems(t, e, e.exit_on!, notice, other))
    return { lastDay: e.exit_on, items, netPaise: items.reduce((s, i) => s + i.amount_paise, 0) }
  })

  app.post('/api/payroll/settlements', async (req, reply) => {
    const who = await need(req, 'payroll.run')
    const b = (req.body ?? {}) as { employeeId?: string; notice?: number; other?: { label?: string; amount?: number }[]; note?: string }
    return db.tx(async (t) => {
      const e = await employee(t, b.employeeId ?? '')
      if (!e.exit_on) throw new HttpError(409, 'Record their last day first (Leaving…).')
      const [open] = await t.query(`select 1 from settlement where employee_id = $1 and status <> 'cancelled'`, [e.id])
      if (open) throw new HttpError(409, 'There is already a settlement for them.')
      const { notice, other } = inputs(b)
      const items = await settlementItems(t, e, e.exit_on, notice, other)
      const net = items.reduce((s, i) => s + i.amount_paise, 0)
      const id = newId('FNF')
      await t.query('insert into settlement (id, employee_id, last_day, ledger_dept, items, net_paise, note, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, e.id, e.exit_on, cfg.departments[e.department]?.ledger ?? 'admin', JSON.stringify(items), net, str(b.note, 300), who.userId, now()])
      await appendAudit(t, { actor: who, action: 'payroll.settlement_prepared', entity: { type: 'settlement', id }, amount: net, after: { employee: e.code, items } }, now())
      return reply.status(201).send({ id, netPaise: net })
    })
  })

  app.get('/api/payroll/settlements', async (req) => {
    const who = await requireCaller(ctx, req)
    const q = req.query as { employeeId?: string }
    if (q.employeeId) await selfOr(req, q.employeeId)
    else if (!SEE.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot see settlements.')
    const rows = await db.query<Record<string, unknown>>(
      `select s.id, s.employee_id, e.name, e.code, s.last_day::text, s.items, s.net_paise, s.status, s.note, s.paid_on::text, s.reference, c.name as created_by, a.name as approved_by
         from settlement s join employee e on e.id = s.employee_id join app_user c on c.id = s.created_by left join app_user a on a.id = s.approved_by
        where s.status <> 'cancelled' and ($1::text is null or s.employee_id = $1) order by s.created_at desc limit 100`, [q.employeeId ?? null])
    return rows.map((r) => ({ ...r, net_paise: Number(r.net_paise), net_words: amountInWords(Number(r.net_paise)) }))
  })

  async function settlement(t: Db, id: string) {
    const [s] = await t.query<{ id: string; employee_id: string; status: string; created_by: string; net_paise: string; last_day: string }>('select id, employee_id, status, created_by, net_paise, last_day::text from settlement where id = $1 for update', [id])
    if (!s) throw new HttpError(404, 'No such settlement.')
    return s
  }
  app.post('/api/payroll/settlements/:id/approve', async (req) => {
    const who = await need(req, 'payroll.approve')
    const res = await db.tx(async (t) => {
      const s = await settlement(t, (req.params as { id: string }).id)
      if (s.status !== 'draft') throw new HttpError(409, `Already ${s.status}.`)
      if (s.created_by === who.userId && !who.permissions.has('*')) throw new HttpError(403, 'Someone else approves the settlement you prepared.')
      await t.query(`update settlement set status = 'approved', approved_by = $2, approved_at = $3 where id = $1`, [s.id, who.userId, now()])
      await closeRecovered(t, s.employee_id)
      await appendAudit(t, { actor: who, action: 'payroll.settlement_approved', entity: { type: 'settlement', id: s.id }, amount: Number(s.net_paise) }, now())
      return { ok: true }
    })
    await postPending(db, now())
    return res
  })
  app.post('/api/payroll/settlements/:id/cancel', async (req) => {
    const who = await need(req, 'payroll.run')
    return db.tx(async (t) => {
      const s = await settlement(t, (req.params as { id: string }).id)
      if (s.status !== 'draft') throw new HttpError(409, `It is ${s.status}.`)
      await t.query(`update settlement set status = 'cancelled' where id = $1`, [s.id])
      await appendAudit(t, { actor: who, action: 'payroll.settlement_cancelled', entity: { type: 'settlement', id: s.id } }, now())
      return { ok: true }
    })
  })
  app.post('/api/payroll/settlements/:id/pay', async (req) => {
    const who = await need(req, 'payroll.pay')
    const b = (req.body ?? {}) as { paidOn?: string; bankCode?: string; reference?: string }
    if (!DATE.test(b.paidOn ?? '')) throw new HttpError(400, 'The date it was paid.')
    const res = await db.tx(async (t) => {
      const s = await settlement(t, (req.params as { id: string }).id)
      if (s.status !== 'approved') throw new HttpError(409, s.status === 'draft' ? 'It is waiting for approval.' : `It is ${s.status}.`)
      if (Number(s.net_paise) <= 0) throw new HttpError(409, 'Nothing is owed to them.')
      const bank = b.bankCode ? (await t.query<{ account_code: string }>('select account_code from bank_account where account_code = $1 and active', [b.bankCode]))[0]?.account_code : await defaultBankCode(t)
      if (!bank) throw new HttpError(400, 'No such bank account.')
      await t.query(`update settlement set status = 'paid', paid_on = $2, bank_code = $3, reference = $4 where id = $1`, [s.id, b.paidOn, bank, str(b.reference, 80)])
      await appendAudit(t, { actor: who, action: 'payroll.settlement_paid', entity: { type: 'settlement', id: s.id }, amount: Number(s.net_paise) }, now())
      return { ok: true }
    })
    await postPending(db, now())
    return res
  })

  // ---------- Form 16 Part B, the 24Q ----------
  /** The year as paid: every approved payroll month, no projection. */
  async function yearAsPaid(t: Db, e: PayEmployee, fy: string) {
    const decl = await declarationOf(t, e.id, fy, e.tax_regime)
    const months = await t.query<{ month: string; gross_paise: string; tds_paise: string; paid_on: string | null }>(
      `select r.month, l.gross_paise, l.tds_paise, r.paid_on::text from payroll_line l join payroll_run r on r.id = l.run_id
        where l.employee_id = $1 and r.status in ('approved', 'paid') and r.month = any($2) order by r.month`, [e.id, fyMonths(fy)])
    const paid = await paidThisYear(t, e.id, fy, `${Number(fy.slice(0, 4)) + 1}-04`)
    return { declaration: decl, months: months.map((m) => ({ month: m.month, grossPaise: Number(m.gross_paise), tdsPaise: Number(m.tds_paise), paidOn: m.paid_on })),
      year: yearFigures(cfg, fy, decl, paid, null, { structure: null, months: 0, ptMonths: 0 }) }
  }

  app.get('/api/payroll/form16/:employeeId', async (req) => {
    const { e } = await selfOr(req, (req.params as { employeeId: string }).employeeId)
    const fy = (req.query as { fy?: string }).fy ?? ''
    if (!FY.test(fy)) throw new HttpError(400, 'Enter the year as 2026-27.')
    const y = await yearAsPaid(db, e, fy)
    if (!y.months.length) throw new HttpError(404, `No salary paid to them in ${fy} through the system.`)
    const deposits = await db.query<{ month: string; reference: string; paid_on: string }>(`select month, reference, paid_on::text from statutory_payment where kind = 'tds' and month = any($1) order by paid_on`, [fyMonths(fy)])
    const complete = (await businessDate(db)) > `${Number(fy.slice(0, 4)) + 1}-03-31`
    return { fy, complete, employee: { code: e.code, name: e.name, pan: e.pan, designation: e.designation }, employer: await employer(db), ...y, deposits, taxWords: amountInWords(y.year.annualTax) }
  })

  app.get('/api/payroll/24q', async (req, reply) => {
    await need(req, ...SEE, 'tds.manage')
    const q = req.query as { fy?: string; quarter?: string; format?: string }
    if (!FY.test(q.fy ?? '') || !['1', '2', '3', '4'].includes(q.quarter ?? '')) throw new HttpError(400, 'fy as 2026-27 and quarter 1 to 4.')
    const months = fyMonths(q.fy!).slice((Number(q.quarter) - 1) * 3, Number(q.quarter) * 3)
    const rows = await db.query<{ month: string; code: string; name: string; pan: string | null; gross_paise: string; tds_paise: string; paid_on: string | null }>(
      `select r.month, l.code, l.name, l.pan, l.gross_paise, l.tds_paise, r.paid_on::text from payroll_line l join payroll_run r on r.id = l.run_id
        where r.status in ('approved', 'paid') and r.month = any($1) order by r.month, l.code`, [months])
    const challans = await db.query<{ month: string; reference: string; paid_on: string; amount_paise: string }>(`select month, reference, paid_on::text, amount_paise from statutory_payment where kind = 'tds' and month = any($1)`, [months])
    const deductees = rows.map((r, i) => ({ sr: i + 1, month: r.month, code: r.code, name: r.name, pan: r.pan ?? 'PANNOTAVBL', paidOn: r.paid_on ?? monthEndOf(r.month), amountPaise: Number(r.gross_paise), tdsPaise: Number(r.tds_paise),
      challan: challans.filter((c) => c.month === r.month).map((c) => `${c.reference} (${c.paid_on})`).join('; ') || null }))
    let annexure2: unknown[] = []
    if (q.quarter === '4') {
      const people = await db.query<PayEmployee>(`select distinct ${EMPLOYEE_COLS} from employee e join payroll_line l on l.employee_id = e.id join payroll_run r on r.id = l.run_id where r.status in ('approved', 'paid') and r.month = any($1)`, [fyMonths(q.fy!)])
      for (const e of people) { const y = (await yearAsPaid(db, e, q.fy!)).year; annexure2.push({ code: e.code, name: e.name, pan: e.pan, ...y }) }
      annexure2 = annexure2.sort((a, b) => String((a as { code: string }).code).localeCompare((b as { code: string }).code))
    }
    if (q.format === 'csv') {
      const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const dmy = (d: string) => d.split('-').reverse().join('/')
      const body = [['Sr', 'Employee code', 'PAN', 'Name', 'Section', 'Date of payment', 'Amount paid', 'Tax deducted', 'Tax deposited', 'Challan'].map(cell).join(','),
        ...deductees.map((d) => [d.sr, d.code, d.pan, d.name, '192', dmy(d.paidOn), (d.amountPaise / 100).toFixed(2), (d.tdsPaise / 100).toFixed(2), (d.challan ? d.tdsPaise / 100 : 0).toFixed(2), d.challan ?? ''].map(cell).join(','))].join('\r\n')
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="24Q_${q.fy}_Q${q.quarter}.csv"`).send(body + '\r\n')
    }
    return { fy: q.fy, quarter: Number(q.quarter), months, deductees, totals: { amountPaise: deductees.reduce((s, d) => s + d.amountPaise, 0), tdsPaise: deductees.reduce((s, d) => s + d.tdsPaise, 0) }, annexure2, employer: await employer(db) }
  })

  // ---------- the staff app: one's own payslips and Form 16 ----------
  app.get('/api/payroll/me', async (req) => {
    const who = await requireCaller(ctx, req)
    const [e] = await db.query<PayEmployee>(`select ${EMPLOYEE_COLS} from employee e where e.user_id = $1`, [who.userId])
    if (!e) return { employee: null, payslips: [], years: [] }
    const lines = await db.query<Record<string, unknown>>(
      `select l.*, r.month, r.days_in_month, r.status as run_status, r.paid_on::text as paid_on from payroll_line l join payroll_run r on r.id = l.run_id
        where l.employee_id = $1 and r.status in ('approved', 'paid') order by r.month desc limit 24`, [e.id])
    const payslips = lines.map((l) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(l)) out[k] = v != null && (k.endsWith('_paise') || ['lop_days', 'ot_hours', 'paid_days', 'lop_set', 'ot_set', 'absent_days', 'leave_lop_days'].includes(k)) ? Number(v) : v
      return { ...out, bank_account: l.bank_account ? `••••${String(l.bank_account).slice(-4)}` : null, monthName: monthName(String(l.month)), net_words: amountInWords(Number(l.net_paise)) }
    })
    const years = [...new Set(lines.map((l) => fyOf(String(l.month)).fy))]
    const today = await businessDate(db)
    const fy = fyOf(today.slice(0, 7)).fy
    return { employee: { id: e.id, code: e.code, name: e.name, designation: e.designation, department: cfg.departments[e.department]?.name ?? e.department, pan: e.pan, uan: e.uan, esic_ip: e.esic_ip },
      employer: await employer(db), payslips, years, tax: { fy, ...(await projection(db, e, fy, today)), compare: await regimeCompare(db, e, fy, today) } }
  })

  // ---------- the parallel run ----------
  app.post('/api/payroll/runs/:id/compare', async (req, reply) => {
    const who = await need(req, 'payroll.run', 'payroll.view')
    const text = String((req.body as { csv?: string } | null)?.csv ?? '')
    const rows = parseCsv(text)
    if (rows.length < 2) throw new HttpError(400, 'Paste the current payroll as CSV with a header row: code, gross, pf, esi, pt, lwf, tds, net.')
    const head = rows[0].map((h) => h.toLowerCase().replace(/[^a-z]/g, ''))
    const col = (k: string) => (k === 'code' ? head.findIndex((h) => h.endsWith('code')) : head.indexOf(k))
    if (col('code') < 0 || col('net') < 0) throw new HttpError(400, 'The header needs at least code and net (and gross, pf, esi, pt, lwf, tds where you have them).')
    const parsed = rows.slice(1).map((r, i) => {
      const o: Record<string, unknown> = { code: r[col('code')] }
      for (const [k] of COMPARE_FIELDS) {
        if (col(k) < 0) continue
        const v = Number(String(r[col(k)] ?? '').replace(/[₹,\s]/g, '') || 0)
        if (!Number.isFinite(v)) throw new HttpError(400, `Row ${i + 2}: ${k} is not a number.`)
        o[k] = Math.round(v * 100)
      }
      return o
    }).filter((o) => o.code)
    const [run] = await db.query<{ id: string; month: string }>('select id, month from payroll_run where id = $1', [(req.params as { id: string }).id])
    if (!run) throw new HttpError(404, 'No such payroll run.')
    const id = newId('CMP')
    await db.query('insert into payroll_compare (id, run_id, rows, uploaded_by, uploaded_at) values ($1,$2,$3,$4,$5)', [id, run.id, JSON.stringify(parsed), who.userId, now()])
    await appendAudit(db, { actor: who, action: 'payroll.compared', entity: { type: 'payroll_run', id: run.id }, after: { month: run.month, rows: parsed.length } }, now())
    return reply.status(201).send(await comparison(db, run.id))
  })
  app.get('/api/payroll/runs/:id/compare', async (req) => {
    await need(req, ...SEE)
    return comparison(db, (req.params as { id: string }).id)
  })

  /** The system's run beside the current payroll's figures: each person, each figure, within ₹1. */
  async function comparison(t: Db, runId: string) {
    const [c] = await t.query<{ rows: Record<string, number | string>[]; uploaded_at: string; by: string }>(
      'select c.rows, c.uploaded_at, u.name as by from payroll_compare c join app_user u on u.id = c.uploaded_by where c.run_id = $1 order by c.seq desc limit 1', [runId])
    if (!c) return null
    const lines = await t.query<Record<string, string>>('select * from payroll_line where run_id = $1 order by code', [runId])
    const theirs = new Map(c.rows.map((r) => [String(r.code).toUpperCase(), r]))
    const fields = COMPARE_FIELDS.filter(([k]) => c.rows.some((r) => r[k] !== undefined))
    const people = lines.map((l) => {
      const th = theirs.get(l.code.toUpperCase())
      theirs.delete(l.code.toUpperCase())
      const diffs = th ? fields.map(([k, col]) => ({ field: k, system: Number(l[col]), theirs: Number(th[k] ?? 0), diff: Number(l[col]) - Number(th[k] ?? 0) })) : []
      return { code: l.code, name: l.name, missing: th ? null : 'not in the current payroll', diffs, matched: !!th && diffs.every((d) => Math.abs(d.diff) <= 100) }
    })
    for (const [code] of theirs) people.push({ code, name: '', missing: 'not in the system\'s run', diffs: [], matched: false })
    return { uploadedAt: c.uploaded_at, by: c.by, fields: fields.map(([k]) => k), people, matched: people.filter((p) => p.matched).length, total: people.length, allMatch: people.every((p) => p.matched) }
  }

  app.get('/api/payroll/parallel', async (req) => {
    await need(req, ...SEE)
    const runs = await db.query<{ id: string; month: string }>(`select r.id, r.month from payroll_run r where r.status <> 'cancelled' and exists (select 1 from payroll_compare c where c.run_id = r.id) order by r.month`)
    const out = []
    for (const r of runs) { const c = await comparison(db, r.id); out.push({ month: r.month, runId: r.id, matched: c?.matched ?? 0, total: c?.total ?? 0, allMatch: !!c?.allMatch }) }
    return { months: out, monthsMatched: out.filter((m) => m.allMatch).length, needed: 2 }
  })
}

