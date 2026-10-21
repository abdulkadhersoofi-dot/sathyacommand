import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { amountInWords } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { loadPayrollConfig, monthEndOf, type PayrollConfig } from '../hr'
import { defaultBankCode, postPending } from '../ledger'
import { calculate, closeRecovered, duesOf, EMPLOYEE_COLS, payLine, pfAdmin, runTotals, saveLine, type PayEmployee } from '../payroll'
import { requireCaller } from './auth'

// The monthly payroll. HR runs it for a month (worked out from pay structures, attendance and leave), may set
// leave without pay, overtime and other earnings for a person, and submits it; the GM checks it and the MD
// approves it, which posts it to the books; accounts pay it from the bank (with the bank's transfer file) and
// pay PF, ESI, professional tax and the welfare fund, each with its file or challan.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const str = (v: unknown, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null }
const NUMERIC = new Set(['lop_set', 'ot_set', 'lop_days', 'ot_hours', 'paid_days', 'absent_days', 'leave_lop_days'])
const toLine = (l: Record<string, unknown>) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, v != null && (k.endsWith('_paise') || NUMERIC.has(k)) ? Number(v) : v]))
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
const whole = (p: unknown) => Math.round(Number(p ?? 0) / 100)

interface Run { id: string; month: string; status: string; days_in_month: number; created_by: string; submitted_by: string | null; checked_by: string | null; approved_by: string | null; paid_on: string | null; bank_code: string | null; pay_reference: string | null; sent_back_note: string | null }

export function payrollRoutes(app: FastifyInstance, ctx: Ctx, cfg: PayrollConfig = loadPayrollConfig()) {
  const db = ctx.db
  const now = () => ctx.now()
  const SEE = ['payroll.run', 'payroll.view', 'payroll.approve', 'payroll.pay']

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id
  async function load(t: Db, id: string, lock = false) {
    const [r] = await t.query<Run>(`select r.*, r.paid_on::text as paid_on from payroll_run r where r.id = $1${lock ? ' for update' : ''}`, [id])
    if (!r) throw new HttpError(404, 'No such payroll run.')
    return r
  }
  const inStatus = (r: Run, ...s: string[]) => { if (!s.includes(r.status)) throw new HttpError(409, `The payroll for ${monthName(r.month)} is ${r.status}.`) }
  const audit = (t: Db, who: Caller, action: string, r: Run, after: Record<string, unknown> = {}, note?: string) =>
    appendAudit(t, { actor: who, action, entity: { type: 'payroll_run', id: r.id }, after: { month: r.month, ...after }, note }, now())

  app.get('/api/payroll/runs', async (req) => {
    await need(req, ...SEE)
    const runs = await db.query<{ id: string; month: string; status: string }>(`select id, month, status from payroll_run where status <> 'cancelled' order by month desc limit 36`)
    return Promise.all(runs.map(async (r) => { const tot = await runTotals(db, r.id); return { ...r, people: tot.people, grossPaise: tot.gross, netPaise: tot.net } }))
  })

  app.post('/api/payroll/runs', async (req, reply) => {
    const who = await need(req, 'payroll.run')
    const b = (req.body ?? {}) as { month?: string }
    if (!MONTH.test(b.month ?? '')) throw new HttpError(400, 'Month as YYYY-MM.')
    const today = await businessDate(db)
    if (b.month! > today.slice(0, 7)) throw new HttpError(400, 'That month has not started.')
    return db.tx(async (t) => {
      const [open] = await t.query<{ status: string }>(`select status from payroll_run where month = $1 and status <> 'cancelled'`, [b.month])
      if (open) throw new HttpError(409, `There is already a payroll for ${monthName(b.month!)} (${open.status}).`)
      const id = newId('PAY')
      const days = Number(monthEndOf(b.month!).slice(8, 10))
      await t.query('insert into payroll_run (id, month, days_in_month, created_by, created_at, calculated_at) values ($1,$2,$3,$4,$5,$5)', [id, b.month, days, who.userId, now()])
      const missing = await calculate(t, cfg, { id, month: b.month! }, today, now())
      const r = await load(t, id)
      await audit(t, who, 'payroll.run_created', r)
      return reply.status(201).send({ id, missing })
    })
  })

  app.get('/api/payroll/runs/:id', async (req) => {
    const who = await need(req, ...SEE)
    const r = await load(db, idOf(req))
    const lines = (await db.query<Record<string, unknown>>('select * from payroll_line where run_id = $1 order by department, code', [r.id])).map((l): Record<string, unknown> => ({ ...toLine(l), net_words: amountInWords(Number(l.net_paise)) }))
    const seesBank = can(who, 'payroll.pay') || can(who, 'payroll.run')
    if (!seesBank) for (const l of lines) l.bank_account = l.bank_account ? `••••${String(l.bank_account).slice(-4)}` : null
    const totals = await runTotals(db, r.id)
    const paidDues = await db.query<{ kind: string; amount: string }>('select kind, sum(amount_paise) as amount from statutory_payment where month = $1 group by kind', [r.month])
    const dues = ['approved', 'paid'].includes(r.status) ? duesOf(cfg, r.month, totals).map((d) => ({ ...d, paid: Number(paidDues.find((p) => p.kind === d.kind)?.amount ?? 0) })) : duesOf(cfg, r.month, totals).map((d) => ({ ...d, paid: 0 }))
    const mStart = `${r.month}-01`, mEnd = monthEndOf(r.month)
    const missing = await db.query(`select e.id, e.code, e.name from employee e where e.joined_on <= $2 and (e.exit_on is null or e.exit_on >= $1)
        and not exists (select 1 from salary_structure s where s.employee_id = e.id and s.effective_from <= least($2::date, coalesce(e.exit_on, $2::date))) order by e.code`, [mStart, mEnd])
    const [{ pending }] = await db.query<{ pending: number }>(`select count(*)::int as pending from leave_application where status = 'pending' and from_date <= $2 and to_date >= $1`, [mStart, mEnd])
    const names = await db.query<{ id: string; name: string }>('select id, name from app_user where id = any($1)', [[r.created_by, r.submitted_by, r.checked_by, r.approved_by].filter(Boolean)])
    const nameOf = (id: string | null) => names.find((u) => u.id === id)?.name ?? null
    const [prop] = await db.query<{ legal_name: string | null; name: string; address: string | null; city: string | null }>('select legal_name, name, address, city from property limit 1')
    return {
      ...r, monthName: monthName(r.month), lines, totals, dues, missing, pendingLeave: pending,
      people: { createdBy: nameOf(r.created_by), submittedBy: nameOf(r.submitted_by), checkedBy: nameOf(r.checked_by), approvedBy: nameOf(r.approved_by) },
      employer: { name: prop?.legal_name ?? prop?.name ?? '', address: [prop?.address, prop?.city].filter(Boolean).join(', ') },
      today: await businessDate(db),
      banks: can(who, 'payroll.pay') ? await db.query('select name, account_code from bank_account where active order by is_default desc, name') : [],
    }
  })

  app.post('/api/payroll/runs/:id/recalculate', async (req) => {
    const who = await need(req, 'payroll.run')
    const today = await businessDate(db)
    return db.tx(async (t) => {
      const r = await load(t, idOf(req), true)
      inStatus(r, 'draft')
      const missing = await calculate(t, cfg, r, today, now())
      await audit(t, who, 'payroll.recalculated', r)
      return { ok: true, missing }
    })
  })

  // HR sets one person's leave without pay, overtime or other earnings (null: back to what attendance says).
  app.patch('/api/payroll/runs/:id/lines/:employeeId', async (req) => {
    const who = await need(req, 'payroll.run')
    const { employeeId } = req.params as { employeeId: string }
    const b = (req.body ?? {}) as { lopDays?: number | null; otHours?: number | null; otherEarnings?: number; note?: string }
    const today = await businessDate(db)
    return db.tx(async (t) => {
      const r = await load(t, idOf(req), true)
      inStatus(r, 'draft')
      const [cur] = await t.query<{ lop_set: string | null; ot_set: string | null; other_earnings_paise: string; note: string | null }>('select lop_set, ot_set, other_earnings_paise, note from payroll_line where run_id = $1 and employee_id = $2', [r.id, employeeId])
      if (!cur) throw new HttpError(404, 'They are not in this payroll.')
      const num = (v: unknown, max: number, label: string) => {
        if (v === null || v === '') return null
        const x = Number(v)
        if (!Number.isFinite(x) || x < 0 || x > max || Math.round(x * 2) !== x * 2) throw new HttpError(400, `${label}: 0 to ${max}, in halves.`)
        return x
      }
      const lopSet = b.lopDays !== undefined ? num(b.lopDays, r.days_in_month, 'Leave without pay') : cur.lop_set != null ? Number(cur.lop_set) : null
      const otSet = b.otHours !== undefined ? num(b.otHours, 200, 'Overtime hours') : cur.ot_set != null ? Number(cur.ot_set) : null
      let other = Number(cur.other_earnings_paise)
      if (b.otherEarnings !== undefined) {
        const x = Number(b.otherEarnings)
        if (!Number.isFinite(x) || x < 0 || x > 1_000_000) throw new HttpError(400, 'Other earnings: ₹0 to ₹10,00,000.')
        other = Math.round(x * 100)
      }
      const note = b.note !== undefined ? str(b.note, 300) : cur.note
      if (other && !note) throw new HttpError(400, 'Say what the other earnings are for (arrears, incentive…).')
      const [e] = await t.query<PayEmployee>(`select ${EMPLOYEE_COLS} from employee e where e.id = $1`, [employeeId])
      const line = await payLine(t, cfg, e, r.month, { lopSet, otSet, otherEarnings: other, note }, today)
      if (!line || line === 'missing') throw new HttpError(409, 'They have no pay for this month.')
      await saveLine(t, r.id, line)
      await t.query('update payroll_run set pf_admin_paise = $2 where id = $1', [r.id, await pfAdmin(t, cfg, r.id)])
      await audit(t, who, 'payroll.line_changed', r, { employee: e.code, lopDays: lopSet, otHours: otSet, otherEarningsPaise: other }, note ?? undefined)
      return { ok: true, netPaise: line.net_paise }
    })
  })

  app.post('/api/payroll/runs/:id/submit', async (req) => {
    const who = await need(req, 'payroll.run')
    return db.tx(async (t) => {
      const r = await load(t, idOf(req), true)
      inStatus(r, 'draft')
      const [{ c }] = await t.query<{ c: number }>('select count(*)::int as c from payroll_line where run_id = $1', [r.id])
      if (!c) throw new HttpError(409, 'Nobody is in this payroll.')
      await t.query(`update payroll_run set status = 'submitted', submitted_by = $2, submitted_at = $3, sent_back_note = null where id = $1`, [r.id, who.userId, now()])
      await audit(t, who, 'payroll.submitted', r, { totals: await runTotals(t, r.id) })
      return { ok: true }
    })
  })

  // The GM checks it; the MD approves it (the MD may approve without the GM's check).
  app.post('/api/payroll/runs/:id/check', async (req) => {
    const who = await need(req, 'payroll.approve')
    return db.tx(async (t) => {
      const r = await load(t, idOf(req), true)
      inStatus(r, 'submitted')
      if (r.submitted_by === who.userId && !who.permissions.has('*')) throw new HttpError(403, 'Someone else checks the payroll you submitted.')
      await t.query(`update payroll_run set status = 'checked', checked_by = $2, checked_at = $3 where id = $1`, [r.id, who.userId, now()])
      await audit(t, who, 'payroll.checked', r)
      return { ok: true }
    })
  })

  app.post('/api/payroll/runs/:id/approve', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!who.permissions.has('*')) throw new HttpError(403, 'Only the MD approves the payroll.')
    const res = await db.tx(async (t) => {
      const r = await load(t, idOf(req), true)
      inStatus(r, 'submitted', 'checked')
      await t.query(`update payroll_run set status = 'approved', approved_by = $2, approved_at = $3 where id = $1`, [r.id, who.userId, now()])
      for (const { employee_id } of await t.query<{ employee_id: string }>('select employee_id from payroll_line where run_id = $1 and advance_recovery_paise > 0', [r.id])) await closeRecovered(t, employee_id)
      await audit(t, who, 'payroll.approved', r, { totals: await runTotals(t, r.id), gmChecked: r.status === 'checked' })
      return { ok: true }
    })
    await postPending(db, now())
    return res
  })

  app.post('/api/payroll/runs/:id/send-back', async (req) => {
    const who = await need(req, 'payroll.approve')
    const note = str((req.body as { note?: string } | null)?.note, 300)
    if (!note) throw new HttpError(400, 'Say what needs changing.')
    return db.tx(async (t) => {
      const r = await load(t, idOf(req), true)
      inStatus(r, 'submitted', 'checked')
      await t.query(`update payroll_run set status = 'draft', sent_back_note = $2, checked_by = null, checked_at = null where id = $1`, [r.id, note])
      await audit(t, who, 'payroll.sent_back', r, {}, note)
      return { ok: true }
    })
  })

  app.post('/api/payroll/runs/:id/cancel', async (req) => {
    const who = await need(req, 'payroll.run')
    return db.tx(async (t) => {
      const r = await load(t, idOf(req), true)
      inStatus(r, 'draft')
      await t.query(`update payroll_run set status = 'cancelled' where id = $1`, [r.id])
      await audit(t, who, 'payroll.cancelled', r)
      return { ok: true }
    })
  })

  app.post('/api/payroll/runs/:id/pay', async (req) => {
    const who = await need(req, 'payroll.pay')
    const b = (req.body ?? {}) as { paidOn?: string; bankCode?: string; reference?: string }
    if (!DATE.test(b.paidOn ?? '')) throw new HttpError(400, 'The date it was paid.')
    const res = await db.tx(async (t) => {
      const r = await load(t, idOf(req), true)
      inStatus(r, 'approved')
      if (b.paidOn! < `${r.month}-01`) throw new HttpError(400, 'Paid before the month began?')
      const bank = b.bankCode ? (await t.query<{ account_code: string }>('select account_code from bank_account where account_code = $1 and active', [b.bankCode]))[0]?.account_code : await defaultBankCode(t)
      if (!bank) throw new HttpError(400, 'No such bank account.')
      await t.query(`update payroll_run set status = 'paid', paid_on = $2, paid_by = $3, bank_code = $4, pay_reference = $5 where id = $1`, [r.id, b.paidOn, who.userId, bank, str(b.reference, 80)])
      await audit(t, who, 'payroll.paid', r, { paidOn: b.paidOn, reference: str(b.reference, 80) })
      return { ok: true }
    })
    await postPending(db, now())
    return res
  })

  app.post('/api/payroll/statutory', async (req, reply) => {
    const who = await need(req, 'payroll.pay')
    const b = (req.body ?? {}) as { month?: string; kind?: string; amount?: number; paidOn?: string; reference?: string; bankCode?: string }
    if (!MONTH.test(b.month ?? '')) throw new HttpError(400, 'Month as YYYY-MM.')
    if (!['pf', 'esi', 'pt', 'lwf', 'tds'].includes(b.kind ?? '')) throw new HttpError(400, 'pf, esi, pt, lwf or tds.')
    const amount = Math.round(Number(b.amount) * 100)
    if (!(amount > 0)) throw new HttpError(400, 'The amount paid.')
    if (!DATE.test(b.paidOn ?? '')) throw new HttpError(400, 'The date it was paid.')
    const reference = str(b.reference, 60)
    if (!reference) throw new HttpError(400, b.kind === 'pf' ? 'The TRRN from the EPFO challan.' : b.kind === 'tds' ? 'The challan: BSR code, date and serial number.' : 'The challan or receipt number.')
    const res = await db.tx(async (t) => {
      const [r] = await t.query<{ id: string }>(`select id from payroll_run where month = $1 and status in ('approved', 'paid')`, [b.month])
      if (!r) throw new HttpError(409, `The payroll for ${monthName(b.month!)} is not approved yet.`)
      const bank = b.bankCode ? (await t.query<{ account_code: string }>('select account_code from bank_account where account_code = $1 and active', [b.bankCode]))[0]?.account_code : await defaultBankCode(t)
      if (!bank) throw new HttpError(400, 'No such bank account.')
      const id = newId('STP')
      await t.query('insert into statutory_payment (id, month, kind, amount_paise, paid_on, reference, bank_code, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, b.month, b.kind, amount, b.paidOn, reference, bank, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'payroll.statutory_paid', entity: { type: 'statutory_payment', id }, after: { month: b.month, kind: b.kind, amount, reference } }, now())
      return { id }
    })
    await postPending(db, now())
    return reply.status(201).send(res)
  })

  // ---------- files ----------
  const send = (reply: FastifyReply, name: string, type: string, body: string) =>
    reply.header('content-type', `${type}; charset=utf-8`).header('content-disposition', `attachment; filename="${name}"`).send(body)
  async function lines(req: FastifyRequest, ...status: string[]) {
    const r = await load(db, idOf(req))
    if (status.length) inStatus(r, ...status)
    return { r, lines: await db.query<Record<string, string>>('select * from payroll_line where run_id = $1 order by code', [r.id]) }
  }

  // EPFO's ECR 2.0 text file: one line per member, fields joined by #~#, whole rupees.
  app.get('/api/payroll/runs/:id/ecr', async (req, reply) => {
    await need(req, 'payroll.run', 'payroll.pay')
    const { r, lines: ls } = await lines(req)
    // Members without a UAN cannot be filed: the run shows them as a warning until HR adds it.
    const body = ls.filter((l) => l.uan && Number(l.pf_wages_paise) > 0).map((l) => [
      l.uan ?? '', l.name.toUpperCase(), whole(l.gross_paise), whole(l.pf_wages_paise), whole(l.eps_wages_paise), whole(l.edli_wages_paise),
      whole(l.pf_employee_paise), whole(l.eps_paise), whole(l.pf_employer_paise), Math.round(Number(l.lop_days)), 0].join('#~#')).join('\r\n')
    return send(reply, `ECR-${r.month}.txt`, 'text/plain', body + '\r\n')
  })

  // ESIC's monthly contribution upload: IP number, name, days paid, wages, reason code when nil.
  app.get('/api/payroll/runs/:id/esi', async (req, reply) => {
    await need(req, 'payroll.run', 'payroll.pay')
    const { r, lines: ls } = await lines(req)
    const exits = new Map((await db.query<{ id: string; exit_on: string }>(`select id, exit_on::text from employee where id = any($1) and exit_on between $2 and $3`, [ls.map((l) => l.employee_id), `${r.month}-01`, monthEndOf(r.month)])).map((e) => [e.id, e.exit_on]))
    const rows = ls.filter((l) => l.esi_covered).map((l) => {
      const days = Math.floor(Number(l.paid_days)), left = exits.get(l.employee_id)
      // Reason codes: 1 on leave the whole month, 2 left service (with the last working day).
      return [l.esic_ip ?? '', l.name, days, whole(l.esi_wages_paise), left ? 2 : days === 0 ? 1 : '', left ? left.split('-').reverse().join('/') : '']
    })
    return send(reply, `ESI-${r.month}.csv`, 'text/csv', csv([['IP Number', 'IP Name', 'No of Days for which wages paid/payable during the month', 'Total Monthly Wages', 'Reason Code for Zero workings days', 'Last Working Day'], ...rows]))
  })

  // The bank's bulk transfer: who, their account and IFSC, and what they get.
  app.get('/api/payroll/runs/:id/bank', async (req, reply) => {
    const who = await need(req, 'payroll.pay', 'payroll.run')
    const { r, lines: ls } = await lines(req, 'approved', 'paid')
    await appendAudit(db, { actor: who, action: 'payroll.bank_file', entity: { type: 'payroll_run', id: r.id }, after: { month: r.month, people: ls.length } }, now())
    // Those without an account or IFSC are left out, to be paid by cheque (the run lists them).
    const rows = ls.filter((l) => Number(l.net_paise) > 0 && l.bank_account && l.ifsc).map((l) => [l.code, l.name, l.bank_account, l.ifsc, (Number(l.net_paise) / 100).toFixed(2), `SALARY ${r.month}`])
    return send(reply, `Salaries-${r.month}.csv`, 'text/csv', csv([['Employee code', 'Beneficiary name', 'Account number', 'IFSC', 'Amount', 'Narration'], ...rows]))
  })
}
