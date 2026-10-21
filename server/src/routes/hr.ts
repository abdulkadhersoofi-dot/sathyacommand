import type { FastifyInstance, FastifyRequest } from 'fastify'
import { rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { balances, codeWages, ensureCredits, grossOf, IFSC_RE, leaveDays, loadPayrollConfig, PAN_RE, structureOn, type PayrollConfig } from '../hr'
import { FROZEN, lastFrozenMonth } from '../payroll'
import { requireCaller } from './auth'

// HR records: employees (with or without a login), their pay structure over time, documents and onboarding,
// leave (credits, applications, approval), the holiday calendar and training certificates. Pay figures are
// seen only by HR, accounts, the GM and the MD; bank accounts only by HR and accounts.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const str = (v: unknown, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null }
const n = (v: unknown) => Number(v ?? 0)
const TRAINING = ['fssai_food_handler', 'fire_drill', 'first_aid', 'hygiene', 'responsible_service', 'safety', 'other']
const DOCS = ['appointment', 'id_proof', 'address_proof', 'pan', 'bank_proof', 'photo', 'medical', 'certificate', 'exit', 'other']

interface EmployeeRow { id: string; code: string; name: string; user_id: string | null; department: string; designation: string; employment_type: string; joined_on: string; exit_on: string | null; status: string; bank_account: string | null; [k: string]: unknown }
const COLS = `employee.*, joined_on::text as joined_on, confirmed_on::text as confirmed_on, fixed_term_until::text as fixed_term_until, exit_on::text as exit_on, dob::text as dob`

export function hrRoutes(app: FastifyInstance, ctx: Ctx, cfg: PayrollConfig = loadPayrollConfig()) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id
  const VIEW = ['hr.manage', 'hr.view', 'payroll.view', 'payroll.run']
  const seesPay = (who: Caller) => can(who, 'hr.manage') || can(who, 'payroll.view') || can(who, 'payroll.run')
  const seesBank = (who: Caller) => can(who, 'hr.manage') || can(who, 'payroll.pay') || can(who, 'payroll.run')
  const mask = (s: string | null) => (s ? `••••${s.slice(-4)}` : null)

  async function load(t: Db, id: string) {
    const [e] = await t.query<EmployeeRow>(`select ${COLS} from employee where id = $1`, [id])
    if (!e) throw new HttpError(404, 'No such employee.')
    return e
  }
  /** Leave in a month whose payroll is submitted or later would no longer reach the pay: refused. */
  async function payrollOpen(t: Db, from: string, to: string) {
    const [r] = await t.query<{ month: string; status: string }>(`select month, status from payroll_run where status = any($1) and month between $2 and $3 order by month limit 1`, [FROZEN, from.slice(0, 7), to.slice(0, 7)])
    if (r) throw new HttpError(409, ['submitted', 'checked'].includes(r.status) ? `The payroll for ${r.month} is waiting for approval: it must be sent back before leave in that month changes.` : `The payroll for ${r.month} is ${r.status}: HR puts this right in a later month's payroll.`)
  }
  /** The employee record of the person signed in, if they have one. */
  async function mine(who: Caller) {
    const [e] = await db.query<EmployeeRow>(`select ${COLS} from employee where user_id = $1`, [who.userId])
    return e ?? null
  }

  /**
   * Whose leave someone may decide: everyone's for HR, the GM and the operations manager; a department head
   * only their own department's (from their employee record); null when they decide no one's.
   */
  async function approvesFor(who: Caller): Promise<'all' | string | null> {
    if (can(who, 'hr.manage') || can(who, 'hr.view')) return 'all'
    if (!can(who, 'leave.approve')) return null
    return (await mine(who))?.department ?? null
  }

  function fields(b: Record<string, unknown>, partial: boolean) {
    const out: Record<string, unknown> = {}
    const req = (k: string) => !partial || b[k] !== undefined
    if (req('name')) { const v = str(b.name, 120); if (!v) throw new HttpError(400, 'Enter the employee\'s name.'); out.name = v }
    if (req('department')) { if (!cfg.departments[String(b.department)]) throw new HttpError(400, `Department: ${Object.keys(cfg.departments).join(', ')}.`); out.department = b.department }
    if (req('designation')) { const v = str(b.designation, 80); if (!v) throw new HttpError(400, 'Enter the designation (e.g. Room attendant).'); out.designation = v }
    if (req('joinedOn')) { if (!DATE.test(String(b.joinedOn ?? ''))) throw new HttpError(400, 'Enter the date of joining.'); out.joined_on = b.joinedOn }
    if (b.employmentType !== undefined) { if (!['permanent', 'probation', 'fixed_term', 'contract', 'trainee'].includes(String(b.employmentType))) throw new HttpError(400, 'Permanent, probation, fixed term, contract or trainee.'); out.employment_type = b.employmentType }
    for (const [k, col] of [['confirmedOn', 'confirmed_on'], ['fixedTermUntil', 'fixed_term_until'], ['dob', 'dob']] as const) {
      if (b[k] !== undefined) { if (b[k] && !DATE.test(String(b[k]))) throw new HttpError(400, `${k}: a date.`); out[col] = b[k] || null }
    }
    if (b.gender !== undefined) { if (b.gender && !['female', 'male', 'other'].includes(String(b.gender))) throw new HttpError(400, 'Gender: female, male or other.'); out.gender = b.gender || null }
    for (const [k, col, max] of [['guardian', 'guardian', 120], ['email', 'email', 254], ['address', 'address', 300], ['emergency', 'emergency', 200], ['bankName', 'bank_name', 80]] as const) if (b[k] !== undefined) out[col] = str(b[k], max)
    if (b.mobile !== undefined) { const m = String(b.mobile ?? '').replace(/\D/g, '').slice(-10); if (m && !/^[6-9]\d{9}$/.test(m)) throw new HttpError(400, 'Mobile: 10 digits.'); out.mobile = m ? `+91${m}` : null }
    if (b.pan !== undefined) { const p = String(b.pan ?? '').trim().toUpperCase(); if (p && !PAN_RE.test(p)) throw new HttpError(400, 'PAN: 5 letters, 4 digits, a letter.'); out.pan = p || null }
    if (b.aadhaar !== undefined) {
      // Only the last four digits are kept, as for guests.
      const a = String(b.aadhaar ?? '').replace(/\D/g, '')
      if (a && a.length !== 12 && a.length !== 4) throw new HttpError(400, 'Aadhaar: 12 digits (only the last four are kept).')
      out.aadhaar_last4 = a ? a.slice(-4) : null
    }
    if (b.uan !== undefined) { const u = String(b.uan ?? '').replace(/\D/g, ''); if (u && u.length !== 12) throw new HttpError(400, 'UAN: 12 digits.'); out.uan = u || null }
    if (b.esicIp !== undefined) { const u = String(b.esicIp ?? '').replace(/\D/g, ''); if (u && u.length !== 10) throw new HttpError(400, 'ESIC IP number: 10 digits.'); out.esic_ip = u || null }
    if (b.bankAccount !== undefined) { const a = String(b.bankAccount ?? '').replace(/\s/g, ''); if (a && !/^\d{9,18}$/.test(a)) throw new HttpError(400, 'Bank account: 9 to 18 digits.'); out.bank_account = a || null }
    if (b.ifsc !== undefined) { const i = String(b.ifsc ?? '').trim().toUpperCase(); if (i && !IFSC_RE.test(i)) throw new HttpError(400, 'IFSC: 4 letters, 0, then 6 letters or digits.'); out.ifsc = i || null }
    for (const [k, col] of [['pfMember', 'pf_member'], ['ptApplicable', 'pt_applicable'], ['lwfApplicable', 'lwf_applicable']] as const) if (b[k] !== undefined) out[col] = !!b[k]
    if (b.taxRegime !== undefined) { if (!['new', 'old'].includes(String(b.taxRegime))) throw new HttpError(400, 'Tax regime: new or old.'); out.tax_regime = b.taxRegime }
    if (b.photoId !== undefined) out.photo_id = b.photoId || null
    return out
  }

  app.get('/api/hr/config', async (req) => {
    await requireCaller(ctx, req)
    return { departments: cfg.departments, leaveTypes: cfg.leave_types, checklist: cfg.onboarding_checklist, festivalHolidaysRequired: cfg.festival_holidays_required }
  })

  // ---------- employees ----------
  app.get('/api/hr/employees', async (req) => {
    const who = await need(req, ...VIEW, 'leave.approve')
    const rows = await db.query<EmployeeRow & { login: string | null }>(`select ${COLS}, u.email as login from employee left join app_user u on u.id = employee.user_id order by employee.status = 'exited', employee.department, employee.name`)
    const out = []
    for (const e of rows) {
      const s = seesPay(who) ? await structureOn(db, e.id, await businessDate(db)) : null
      out.push({ id: e.id, code: e.code, name: e.name, department: e.department, designation: e.designation, employmentType: e.employment_type, joinedOn: e.joined_on, exitOn: e.exit_on, status: e.status,
        login: e.login, mobile: e.mobile, uan: e.uan, esicIp: e.esic_ip, grossPaise: s ? grossOf(s) : null })
    }
    return out
  })

  app.post('/api/hr/employees', async (req, reply) => {
    const who = await need(req, 'hr.manage')
    const f = fields((req.body ?? {}) as Record<string, unknown>, false)
    return db.tx(async (t) => {
      const [{ c }] = await t.query<{ c: number }>('select count(*)::int as c from employee')
      const code = `E${String(c + 1).padStart(4, '0')}`
      const id = newId('EMP')
      const cols = ['id', 'code', 'created_at', 'updated_at', ...Object.keys(f)]
      await t.query(`insert into employee (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, [id, code, now(), now(), ...Object.values(f)])
      for (const item of cfg.onboarding_checklist) await t.query('insert into onboarding_item (employee_id, item) values ($1, $2)', [id, item])
      await appendAudit(t, { actor: who, action: 'hr.employee_add', entity: { type: 'employee', id }, after: { code, name: f.name, department: f.department, designation: f.designation } }, now())
      return reply.status(201).send({ id, code })
    })
  })

  app.get('/api/hr/employees/:id', async (req) => {
    const who = await requireCaller(ctx, req)
    const e = await load(db, idOf(req))
    const self = e.user_id === who.userId
    if (!self && !VIEW.concat('leave.approve').some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot see this.')
    const today = await businessDate(db), year = Number(today.slice(0, 4))
    await db.tx((t) => ensureCredits(t, cfg, e, year, today, now()))
    const pay = seesPay(who) || self
    const structures = pay ? (await db.query<Record<string, string | boolean>>('select s.*, s.effective_from::text as effective_from from salary_structure s where s.employee_id = $1 order by s.effective_from desc', [e.id]))
      .map((s) => ({ from: s.effective_from, basic: Number(s.basic_paise), da: Number(s.da_paise), hra: Number(s.hra_paise), conveyance: Number(s.conveyance_paise), special: Number(s.special_paise), other: Number(s.other_paise), pfOnFull: s.pf_on_full_wages })) : null
    const cur = pay ? await structureOn(db, e.id, today) : null
    const { bank_account, ...rest } = e
    return {
      ...rest, bank_account: seesBank(who) ? bank_account : mask(bank_account), login: e.user_id ? (await db.query<{ email: string }>('select email from app_user where id = $1', [e.user_id]))[0]?.email ?? null : null, departmentName: cfg.departments[e.department]?.name ?? e.department,
      structures, current: cur ? { ...cur, grossPaise: grossOf(cur), wagesPaise: codeWages(cfg, cur) } : null,
      onboarding: await db.query('select o.item, o.done_at, u.name as by from onboarding_item o left join app_user u on u.id = o.done_by where o.employee_id = $1 order by o.item', [e.id]),
      documents: await db.query('select d.id, d.kind, d.upload_id, d.note, d.added_at, u.name as by from employee_document d join app_user u on u.id = d.added_by where d.employee_id = $1 order by d.added_at desc', [e.id]),
      leave: { year, balances: await balances(db, cfg, e.id, year), applications: await db.query(`select id, leave_type, from_date::text, to_date::text, days, status, reason, decision_note from leave_application where employee_id = $1 order by from_date desc limit 30`, [e.id]) },
      training: await db.query(`select id, kind, title, done_on::text, valid_until::text from training_record where employee_id = $1 order by done_on desc`, [e.id]),
      today,
    }
  })

  app.patch('/api/hr/employees/:id', async (req) => {
    const who = await need(req, 'hr.manage')
    const b = (req.body ?? {}) as Record<string, unknown>
    const f = fields(b, true)
    if (b.userId !== undefined) {
      if (b.userId) { const [u] = await db.query('select 1 from app_user where id = $1', [b.userId]); if (!u) throw new HttpError(400, 'No such login.') }
      f.user_id = b.userId || null
    }
    if (b.loginEmail !== undefined) {
      // HR links the person's app login by its email, so they see their own leave and payslips.
      const mail = String(b.loginEmail ?? '').trim().toLowerCase()
      const [u] = mail ? await db.query<{ id: string }>(`select id from app_user where email = $1 and id <> 'system'`, [mail]) : []
      if (mail && !u) throw new HttpError(400, 'No app login with that email: add it under Staff → Logins first.')
      f.user_id = u?.id ?? null
    }
    const keys = Object.keys(f)
    if (!keys.length) return { ok: true }
    return db.tx(async (t) => {
      const before = await load(t, idOf(req))
      try { await t.query(`update employee set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = $${keys.length + 2} where id = $1`, [before.id, ...keys.map((k) => f[k]), now()]) }
      catch (e) { if (/unique|duplicate/i.test(String((e as Error).message))) throw new HttpError(409, 'That login belongs to another employee.'); throw e }
      // A changed bank account is flagged to God Mode, as for vendors.
      await appendAudit(t, { actor: who, action: f.bank_account !== undefined && f.bank_account !== before.bank_account ? 'hr.bank_account_changed' : 'hr.employee_update', entity: { type: 'employee', id: before.id },
        after: { ...f, bank_account: f.bank_account !== undefined ? mask(f.bank_account as string | null) : undefined } }, now())
      return { ok: true }
    })
  })

  app.put('/api/hr/employees/:id/salary', async (req) => {
    const who = await need(req, 'hr.manage')
    const b = (req.body ?? {}) as { effectiveFrom?: string; basic?: number; da?: number; hra?: number; conveyance?: number; special?: number; other?: number; pfOnFullWages?: boolean }
    if (!DATE.test(b.effectiveFrom ?? '')) throw new HttpError(400, 'From which date?')
    const amounts = ['basic', 'da', 'hra', 'conveyance', 'special', 'other'].map((k) => n((b as Record<string, unknown>)[k]))
    if (amounts.some((a) => !(a >= 0)) || !(amounts[0] > 0)) throw new HttpError(400, 'Monthly amounts in ₹; basic above 0.')
    const s = { basic: rupees(amounts[0]), da: rupees(amounts[1]), hra: rupees(amounts[2]), conveyance: rupees(amounts[3]), special: rupees(amounts[4]), other: rupees(amounts[5]), pfOnFull: !!b.pfOnFullWages, from: b.effectiveFrom! }
    const gross = grossOf(s)
    if (cfg.minimum_wage_per_month && gross < rupees(cfg.minimum_wage_per_month)) throw new HttpError(400, `Below the minimum wage of ₹${cfg.minimum_wage_per_month} a month.`)
    return db.tx(async (t) => {
      const e = await load(t, idOf(req))
      if (b.effectiveFrom! < e.joined_on) throw new HttpError(400, 'Not before the date of joining.')
      const frozen = await lastFrozenMonth(t)
      if (frozen && b.effectiveFrom!.slice(0, 7) <= frozen) throw new HttpError(409, `The payroll for ${frozen} is already submitted: a new structure can start from ${frozen === b.effectiveFrom!.slice(0, 7) ? 'next month' : 'the month after it'}; arrears go in as other earnings.`)
      await t.query(`insert into salary_structure (employee_id, effective_from, basic_paise, da_paise, hra_paise, conveyance_paise, special_paise, other_paise, pf_on_full_wages, set_by, set_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        on conflict (employee_id, effective_from) do update set basic_paise = excluded.basic_paise, da_paise = excluded.da_paise, hra_paise = excluded.hra_paise, conveyance_paise = excluded.conveyance_paise,
          special_paise = excluded.special_paise, other_paise = excluded.other_paise, pf_on_full_wages = excluded.pf_on_full_wages, set_by = excluded.set_by, set_at = excluded.set_at`,
        [e.id, s.from, s.basic, s.da, s.hra, s.conveyance, s.special, s.other, s.pfOnFull, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'hr.salary_set', entity: { type: 'employee', id: e.id }, amount: gross, after: { from: s.from, gross } }, now())
      const wages = codeWages(cfg, s)
      return { ok: true, grossPaise: gross, wagesPaise: wages, note: wages > s.basic + s.da ? 'Allowances are more than half the pay: the excess counts as wages for PF, gratuity and bonus (Code on Wages).' : null }
    })
  })

  app.post('/api/hr/employees/:id/onboarding', async (req) => {
    const who = await need(req, 'hr.manage')
    const b = (req.body ?? {}) as { item?: string; done?: boolean }
    const r = await db.query('update onboarding_item set done_at = $3, done_by = $4 where employee_id = $1 and item = $2 returning item', [idOf(req), b.item, b.done ? now() : null, b.done ? who.userId : null])
    if (!r.length) throw new HttpError(404, 'No such checklist item.')
    return { ok: true }
  })

  app.post('/api/hr/employees/:id/documents', async (req, reply) => {
    const who = await need(req, 'hr.manage')
    const b = (req.body ?? {}) as { kind?: string; uploadId?: string; note?: string }
    if (!DOCS.includes(b.kind ?? '')) throw new HttpError(400, `Kind: ${DOCS.join(', ')}.`)
    if (!b.uploadId && !str(b.note)) throw new HttpError(400, 'Attach a photo of the document, or note where the paper copy is filed.')
    const e = await load(db, idOf(req))
    const id = newId('DOC')
    await db.query('insert into employee_document (id, employee_id, kind, upload_id, note, added_by, added_at) values ($1,$2,$3,$4,$5,$6,$7)', [id, e.id, b.kind, b.uploadId ?? null, str(b.note, 300), who.userId, now()])
    if (b.kind === 'photo' && b.uploadId) await db.query('update employee set photo_id = $2 where id = $1', [e.id, b.uploadId])
    return reply.status(201).send({ id })
  })

  /** Leaving: notice from a date, or the last day. The full and final settlement is worked out in payroll. */
  app.post('/api/hr/employees/:id/exit', async (req) => {
    const who = await need(req, 'hr.manage')
    const b = (req.body ?? {}) as { lastDay?: string; reason?: string }
    if (!DATE.test(b.lastDay ?? '')) throw new HttpError(400, 'Enter the last working day.')
    const reason = str(b.reason, 200)
    if (!reason) throw new HttpError(400, 'Why are they leaving? (resigned, retired, contract ended…)')
    return db.tx(async (t) => {
      const e = await load(t, idOf(req))
      if (e.status === 'exited') throw new HttpError(409, 'Already left.')
      const today = await businessDate(t)
      await t.query('update employee set exit_on = $2, exit_reason = $3, status = $4, updated_at = $5 where id = $1', [e.id, b.lastDay, reason, b.lastDay! < today ? 'exited' : 'notice', now()])
      await appendAudit(t, { actor: who, action: 'hr.exit', entity: { type: 'employee', id: e.id }, after: { lastDay: b.lastDay, reason } }, now())
      return { ok: true }
    })
  })

  app.post('/api/hr/employees/:id/training', async (req, reply) => {
    const who = await need(req, 'hr.manage')
    const b = (req.body ?? {}) as { kind?: string; title?: string; doneOn?: string; validUntil?: string; uploadId?: string }
    if (!TRAINING.includes(b.kind ?? '')) throw new HttpError(400, `Kind: ${TRAINING.join(', ')}.`)
    if (!DATE.test(b.doneOn ?? '') || (b.validUntil && !DATE.test(b.validUntil))) throw new HttpError(400, 'When it was done (and until when it is valid).')
    const e = await load(db, idOf(req))
    const id = newId('TR')
    await db.query('insert into training_record (id, employee_id, kind, title, done_on, valid_until, upload_id, added_by, added_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, e.id, b.kind, str(b.title, 120) ?? b.kind!.replace(/_/g, ' '), b.doneOn, b.validUntil || null, b.uploadId ?? null, who.userId, now()])
    return reply.status(201).send({ id })
  })

  /** Certificates running out in the next 60 days or already lapsed (food handlers, first aid…). */
  app.get('/api/hr/training/due', async (req) => {
    await need(req, ...VIEW, 'leave.approve', 'compliance.view')
    const today = await businessDate(db)
    return db.query(`select t.id, t.kind, t.title, t.valid_until::text, e.name, e.code, e.department from training_record t join employee e on e.id = t.employee_id
      where e.status <> 'exited' and t.valid_until is not null and t.valid_until <= $1
        and not exists (select 1 from training_record x where x.employee_id = t.employee_id and x.kind = t.kind and x.valid_until > t.valid_until) order by t.valid_until`, [addDays(today, 60)])
  })

  // ---------- leave ----------
  async function apply(who: Caller, e: EmployeeRow, b: { leaveType?: string; from?: string; to?: string; halfDay?: boolean; reason?: string }, byHr: boolean) {
    const rule = cfg.leave_types[b.leaveType ?? '']
    if (!rule) throw new HttpError(400, `Leave type: ${Object.keys(cfg.leave_types).join(', ')}.`)
    if (!DATE.test(b.from ?? '') || !DATE.test(b.to ?? '') || b.to! < b.from!) throw new HttpError(400, 'Choose the from and to dates.')
    if (b.halfDay && b.from !== b.to) throw new HttpError(400, 'A half day is one day.')
    if (e.status === 'exited') throw new HttpError(409, 'This employee has left.')
    return db.tx(async (t) => {
      await payrollOpen(t, b.from!, b.to!)
      const days = await leaveDays(t, b.from!, b.to!, !!b.halfDay)
      if (!days) throw new HttpError(400, 'Those days are all holidays.')
      const [clash] = await t.query(`select 1 from leave_application where employee_id = $1 and status in ('pending','approved') and from_date <= $3 and to_date >= $2`, [e.id, b.from, b.to])
      if (clash) throw new HttpError(409, 'Leave is already asked for on some of these days.')
      if (rule.credit !== 'none') {
        const year = Number(b.from!.slice(0, 4))
        await ensureCredits(t, cfg, e, year, await businessDate(t), now())
        const bal = (await balances(t, cfg, e.id, year)).find((x) => x.type === b.leaveType)?.balance ?? 0
        const [{ pend }] = await t.query<{ pend: string | null }>(`select sum(days) as pend from leave_application where employee_id = $1 and leave_type = $2 and status = 'pending' and extract(year from from_date) = $3`, [e.id, b.leaveType, year])
        if (days > bal - Number(pend ?? 0)) throw new HttpError(409, `Only ${bal - Number(pend ?? 0)} days of ${rule.name.toLowerCase()} left${Number(pend ?? 0) ? ' after those waiting for approval' : ''}.`)
      }
      if (rule.certificate_after_days && days > rule.certificate_after_days && !str(b.reason)) throw new HttpError(400, `${rule.name} of more than ${rule.certificate_after_days} days needs a reason (and a medical certificate to HR).`)
      const id = newId('LV')
      await t.query('insert into leave_application (id, employee_id, leave_type, from_date, to_date, half_day, days, reason, applied_by, applied_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, e.id, b.leaveType, b.from, b.to, !!b.halfDay, days, str(b.reason, 300), who.userId, now()])
      await appendAudit(t, { actor: who, action: byHr ? 'leave.entered' : 'leave.applied', entity: { type: 'leave_application', id }, after: { employee: e.code, type: b.leaveType, from: b.from, to: b.to, days } }, now())
      return { id, days }
    })
  }

  app.post('/api/hr/leave/applications', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    const b = (req.body ?? {}) as { employeeId?: string; leaveType?: string; from?: string; to?: string; halfDay?: boolean; reason?: string }
    let e: EmployeeRow | null
    if (b.employeeId) {
      e = await load(db, b.employeeId)
      if (e.user_id !== who.userId && !can(who, 'hr.manage')) throw new HttpError(403, 'Only HR enters leave for someone else.')
    } else {
      e = await mine(who)
      if (!e) throw new HttpError(404, 'Your login is not linked to an employee record: ask HR.')
    }
    return reply.status(201).send(await apply(who, e, b, e.user_id !== who.userId))
  })

  app.get('/api/hr/leave/applications', async (req) => {
    const who = await requireCaller(ctx, req)
    const q = req.query as { status?: string; mine?: string }
    const scope = q.mine === '1' ? null : await approvesFor(who)
    return db.query(`select a.id, a.employee_id, e.name, e.code, e.department, a.leave_type, a.from_date::text, a.to_date::text, a.half_day, a.days, a.reason, a.status, a.applied_at, a.decision_note, u.name as decided_by
        from leave_application a join employee e on e.id = a.employee_id left join app_user u on u.id = a.decided_by
       where ($1::text is null or a.status = $1) and ($2 = 'all' or e.department = $2 or e.user_id = $3) order by a.status = 'pending' desc, a.from_date desc limit 300`,
      [q.status ?? null, scope, who.userId])
  })

  app.post('/api/hr/leave/applications/:id/decide', async (req) => {
    const who = await need(req, 'leave.approve', 'hr.manage')
    const b = (req.body ?? {}) as { decision?: string; note?: string }
    if (!['approve', 'reject'].includes(b.decision ?? '')) throw new HttpError(400, 'approve or reject.')
    const scope = await approvesFor(who)
    return db.tx(async (t) => {
      const [a] = await t.query<{ id: string; employee_id: string; leave_type: string; from_date: string; to_date: string; days: string; status: string }>('select id, employee_id, leave_type, from_date::text, to_date::text, days, status from leave_application where id = $1 for update', [idOf(req)])
      if (!a) throw new HttpError(404, 'No such application.')
      if (a.status !== 'pending') throw new HttpError(409, `Already ${a.status}.`)
      const e = await load(t, a.employee_id)
      if (e.user_id === who.userId) throw new HttpError(403, 'Someone else approves your own leave.')
      if (scope !== 'all' && scope !== e.department) throw new HttpError(403, scope ? 'Only their own department head, HR or the GM decides this leave.' : 'Your login is not linked to your employee record: ask HR.')
      if (b.decision === 'reject' && !str(b.note)) throw new HttpError(400, 'Say why it is turned down.')
      if (b.decision === 'approve') await payrollOpen(t, a.from_date, a.to_date)
      await t.query('update leave_application set status = $2, decided_by = $3, decided_at = $4, decision_note = $5 where id = $1', [a.id, b.decision === 'approve' ? 'approved' : 'rejected', who.userId, now(), str(b.note, 300)])
      if (b.decision === 'approve' && cfg.leave_types[a.leave_type]?.credit !== 'none') {
        await t.query('insert into leave_entry (id, employee_id, leave_type, year, days, reason, ref, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [newId('LE'), a.employee_id, a.leave_type, Number(a.from_date.slice(0, 4)), -Number(a.days), 'Leave taken', `leave:${a.id}`, who.userId, now()])
      }
      await appendAudit(t, { actor: who, action: `leave.${b.decision === 'approve' ? 'approved' : 'rejected'}`, entity: { type: 'leave_application', id: a.id }, after: { employee: e.code, days: Number(a.days) }, note: str(b.note, 120) ?? undefined }, now())
      return { ok: true }
    })
  })

  app.post('/api/hr/leave/applications/:id/cancel', async (req) => {
    const who = await requireCaller(ctx, req)
    return db.tx(async (t) => {
      const [a] = await t.query<{ id: string; employee_id: string; leave_type: string; from_date: string; to_date: string; days: string; status: string }>('select id, employee_id, leave_type, from_date::text, to_date::text, days, status from leave_application where id = $1 for update', [idOf(req)])
      if (!a) throw new HttpError(404, 'No such application.')
      const e = await load(t, a.employee_id)
      if (e.user_id !== who.userId && !can(who, 'hr.manage')) throw new HttpError(403, 'Only the employee or HR cancels leave.')
      if (!['pending', 'approved'].includes(a.status)) throw new HttpError(409, `Already ${a.status}.`)
      if (a.status === 'approved' && a.from_date < await businessDate(t) && !can(who, 'hr.manage')) throw new HttpError(409, 'Leave already begun is changed by HR.')
      if (a.status === 'approved') await payrollOpen(t, a.from_date, a.to_date)
      await t.query(`update leave_application set status = 'cancelled' where id = $1`, [a.id])
      if (a.status === 'approved') await t.query('insert into leave_entry (id, employee_id, leave_type, year, days, reason, ref, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing',
        [newId('LE'), a.employee_id, a.leave_type, Number(a.from_date.slice(0, 4)), Number(a.days), 'Leave cancelled', `cancel:${a.id}`, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'leave.cancelled', entity: { type: 'leave_application', id: a.id } }, now())
      return { ok: true }
    })
  })

  /** HR grants leave that is not credited by itself (compensatory off, maternity) or corrects a balance. */
  app.post('/api/hr/leave/grant', async (req, reply) => {
    const who = await need(req, 'hr.manage')
    const b = (req.body ?? {}) as { employeeId?: string; leaveType?: string; days?: number; reason?: string }
    if (!cfg.leave_types[b.leaveType ?? ''] || cfg.leave_types[b.leaveType!].credit === 'none') throw new HttpError(400, 'Which leave type?')
    if (!n(b.days) || Math.abs(n(b.days)) > 200) throw new HttpError(400, 'Days: a number (negative to take back).')
    const reason = str(b.reason, 200)
    if (!reason) throw new HttpError(400, 'Why? (worked on the 15th, maternity from…, correction…)')
    const e = await load(db, b.employeeId ?? '')
    const year = Number((await businessDate(db)).slice(0, 4))
    await db.tx(async (t) => {
      await t.query('insert into leave_entry (id, employee_id, leave_type, year, days, reason, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8)', [newId('LE'), e.id, b.leaveType, year, n(b.days), reason, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'leave.granted', entity: { type: 'employee', id: e.id }, after: { type: b.leaveType, days: n(b.days) }, note: reason }, now())
    })
    return reply.status(201).send({ ok: true })
  })

  // ---------- holidays ----------
  app.get('/api/hr/holidays', async (req) => {
    await requireCaller(ctx, req)
    const year = Number((req.query as { year?: string }).year ?? (await businessDate(db)).slice(0, 4))
    const rows = await db.query<{ kind: string }>(`select day::text, name, kind from holiday where extract(year from day) = $1 order by day`, [year])
    return { year, holidays: rows, festivalChosen: rows.filter((r) => r.kind === 'festival').length, festivalRequired: cfg.festival_holidays_required }
  })

  app.put('/api/hr/holidays', async (req) => {
    const who = await need(req, 'hr.manage')
    const b = (req.body ?? {}) as { day?: string; name?: string; kind?: string; remove?: boolean; replace?: boolean }
    if (!DATE.test(b.day ?? '')) throw new HttpError(400, 'Choose the date of the holiday.')
    if (b.remove) {
      const [h] = await db.query<{ kind: string }>('select kind from holiday where day = $1', [b.day])
      if (h?.kind === 'national') throw new HttpError(409, 'National holidays are required by law.')
      await db.query('delete from holiday where day = $1', [b.day])
    } else {
      if (!str(b.name) || !['festival', 'optional'].includes(b.kind ?? '')) throw new HttpError(400, 'Give the holiday a name, and say whether it is a festival or an optional holiday.')
      const [have] = await db.query<{ name: string }>('select name from holiday where day = $1', [b.day])
      if (have && !b.replace) throw new HttpError(409, `${b.day!.split('-').reverse().join('/')} is already a holiday (${have.name}). Remove it first to put another in its place.`)
      await db.query('insert into holiday (day, name, kind) values ($1,$2,$3) on conflict (day) do update set name = excluded.name, kind = excluded.kind', [b.day, str(b.name, 80), b.kind])
    }
    await appendAudit(db, { actor: who, action: b.remove ? 'hr.holiday_removed' : 'hr.holiday_set', entity: { type: 'holiday', id: b.day! }, note: b.name }, now())
    return { ok: true }
  })

  // ---------- the employee's own ----------
  app.get('/api/hr/me', async (req) => {
    const who = await requireCaller(ctx, req)
    const e = await mine(who)
    if (!e) return { employee: null }
    const today = await businessDate(db), year = Number(today.slice(0, 4))
    await db.tx((t) => ensureCredits(t, cfg, e, year, today, now()))
    return {
      employee: { id: e.id, code: e.code, name: e.name, department: cfg.departments[e.department]?.name ?? e.department, designation: e.designation, joinedOn: e.joined_on },
      leaveTypes: Object.fromEntries(Object.entries(cfg.leave_types).map(([k, r]) => [k, r.name])),
      balances: await balances(db, cfg, e.id, year),
      applications: await db.query(`select id, leave_type, from_date::text, to_date::text, days, status, reason, decision_note from leave_application where employee_id = $1 order by from_date desc limit 20`, [e.id]),
      holidays: await db.query(`select day::text, name from holiday where day >= $1 order by day limit 10`, [today]),
    }
  })
}
