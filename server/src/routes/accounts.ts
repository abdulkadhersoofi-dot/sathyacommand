import type { FastifyInstance, FastifyRequest } from 'fastify'
import { financialYear, rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays } from '../eng-core'
import { businessDate } from '../fo-core'
import { DEPTS, LedgerError, OPERATED, postPending, postVoucher, type Party, type PostLine } from '../ledger'
import { requireCaller } from './auth'

// The books: chart of accounts, day book, ledgers, trial balance, profit and loss by department, balance
// sheet, journal vouchers entered by accounts (put right only by reversal), and month locks.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const
const VIEW = ['accounts.view', 'accounts.post', 'accounts.lock']
/** The first day of the financial year a day falls in (1 April). */
export const monthEnd = (month: string) => addDays(addDays(`${month}-01`, 32).slice(0, 7) + '-01', -1)
export const fyStart = (day: string) => `20${financialYear(day).slice(0, 2)}-04-01`

interface Row { code: string; name: string; type: string; grp: string; dept: string | null; system: boolean; active: boolean; opening: string; debit: string; credit: string }

export function accountsRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  /** Reports read the books after everything waiting has been posted. */
  async function fresh() { await postPending(db, now()) }
  async function range(req: FastifyRequest) {
    const q = req.query as { from?: string; to?: string }
    const today = await businessDate(db)
    const to = q.to ?? today, from = q.from ?? fyStart(to)
    if (!DATE.test(from) || !DATE.test(to) || to < from) throw new HttpError(400, 'from and to as YYYY-MM-DD.')
    return { from, to }
  }
  const wrap = async <T>(f: () => Promise<T>) => {
    try { return await f() } catch (e) { if (e instanceof LedgerError) throw new HttpError(e.statusCode, e.message); throw e }
  }

  /** Every account's movement in a period, with the opening balance (income and expense from the start of the financial year). */
  async function balances(t: Db, from: string, to: string) {
    const rows = await t.query<Row>(
      `select a.code, a.name, a.type, a.grp, a.dept, a.system, a.active,
              coalesce(sum(l.debit_paise - l.credit_paise) filter (where v.date < $1 and (a.type in ('asset', 'liability', 'equity') or v.date >= $3)), 0) as opening,
              coalesce(sum(l.debit_paise) filter (where v.date between $1 and $2), 0) as debit,
              coalesce(sum(l.credit_paise) filter (where v.date between $1 and $2), 0) as credit
         from account a left join voucher_line l on l.account_code = a.code left join voucher v on v.id = l.voucher_id
        group by a.code order by a.code`, [from, to, fyStart(from)])
    return rows.map((r) => ({ code: r.code, name: r.name, type: r.type, grp: r.grp, dept: r.dept, system: r.system, active: r.active,
      openingPaise: Number(r.opening), debitPaise: Number(r.debit), creditPaise: Number(r.credit), closingPaise: Number(r.opening) + Number(r.debit) - Number(r.credit) }))
  }

  // ---------- chart of accounts ----------
  app.get('/api/accounts/chart', async (req) => {
    await need(req, ...VIEW)
    await fresh()
    const today = await businessDate(db)
    return { accounts: await balances(db, fyStart(today), today), departments: DEPTS }
  })

  app.post('/api/accounts/chart', async (req, reply) => {
    const who = await need(req, 'accounts.post')
    const b = (req.body ?? {}) as { code?: string; name?: string; type?: string; grp?: string; dept?: string | null }
    if (!/^\d{4}$/.test(b.code ?? '')) throw new HttpError(400, 'The account code: four digits.')
    if (!b.name?.trim()) throw new HttpError(400, 'Name the account.')
    if (!TYPES.includes(b.type as never)) throw new HttpError(400, 'Asset, liability, equity, income or expense.')
    if (b.dept && !DEPTS[b.dept]) throw new HttpError(400, 'No such department.')
    const lead = { asset: '1', liability: '2', equity: '3', income: '4', expense: '56789' }[b.type as (typeof TYPES)[number]]
    if (!lead.includes(b.code![0])) throw new HttpError(400, `${b.type} accounts are numbered from ${lead[0]}000.`)
    return db.tx(async (t) => {
      const [dup] = await t.query('select 1 from account where code = $1 or lower(name) = lower($2)', [b.code, b.name!.trim()])
      if (dup) throw new HttpError(409, 'An account with that code or name exists.')
      await t.query('insert into account (code, name, type, grp, dept, created_at) values ($1,$2,$3,$4,$5,$6)', [b.code, b.name!.trim(), b.type, b.grp?.trim() || 'Other', b.dept || null, now()])
      await appendAudit(t, { actor: who, action: 'account.add', entity: { type: 'account', id: b.code! }, after: b }, now())
      return reply.status(201).send({ code: b.code })
    })
  })

  app.patch('/api/accounts/chart/:code', async (req) => {
    const who = await need(req, 'accounts.post')
    const { code } = req.params as { code: string }
    const b = (req.body ?? {}) as { name?: string; dept?: string | null; active?: boolean }
    return db.tx(async (t) => {
      const [a] = await t.query<{ system: boolean }>('select system from account where code = $1 for update', [code])
      if (!a) throw new HttpError(404, 'No such account.')
      if (b.dept && !DEPTS[b.dept]) throw new HttpError(400, 'No such department.')
      if (b.active === false) {
        if (a.system) throw new HttpError(409, 'The system posts to this account: it cannot be archived.')
        const [bal] = await t.query<{ b: string | null }>('select sum(debit_paise - credit_paise) as b from voucher_line where account_code = $1', [code])
        if (Number(bal.b ?? 0)) throw new HttpError(409, 'Bring the balance to nil before archiving the account.')
      }
      await t.query('update account set name = coalesce($2, name), dept = case when $3::boolean then $4 else dept end, active = coalesce($5, active) where code = $1',
        [code, b.name?.trim() || null, b.dept !== undefined, b.dept || null, b.active ?? null])
      await appendAudit(t, { actor: who, action: 'account.update', entity: { type: 'account', id: code }, after: b }, now())
      return { code }
    })
  })

  // ---------- reports ----------
  app.get('/api/accounts/trial-balance', async (req) => {
    await need(req, ...VIEW)
    await fresh()
    const { from, to } = await range(req)
    const rows = (await balances(db, from, to)).filter((r) => r.openingPaise || r.debitPaise || r.creditPaise)
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0)
    return { from, to, rows, totals: { debitPaise: sum((r) => r.debitPaise), creditPaise: sum((r) => r.creditPaise),
      closingDebitPaise: sum((r) => Math.max(0, r.closingPaise)), closingCreditPaise: sum((r) => Math.max(0, -r.closingPaise)) } }
  })

  app.get('/api/accounts/ledger', async (req) => {
    await need(req, ...VIEW)
    await fresh()
    const { from, to } = await range(req)
    const q = req.query as { code?: string; party?: string }
    const [a] = await db.query<{ code: string; name: string; type: string }>('select code, name, type from account where code = $1', [q.code ?? ''])
    if (!a) throw new HttpError(404, 'No such account.')
    const pl = a.type === 'income' || a.type === 'expense'
    const [o] = await db.query<{ b: string | null }>(
      `select sum(l.debit_paise - l.credit_paise) as b from voucher_line l join voucher v on v.id = l.voucher_id
        where l.account_code = $1 and v.date < $2 and ($3::date is null or v.date >= $3) and ($4::text is null or l.party_id = $4)`, [a.code, from, pl ? fyStart(from) : null, q.party ?? null])
    const lines = await db.query<{ debit_paise: string; credit_paise: string }>(
      `select v.id as voucher_id, v.number, v.date::text, v.kind, v.narration, l.debit_paise, l.credit_paise, l.dept, l.party_type, l.party_id, l.party_name, l.ref
         from voucher_line l join voucher v on v.id = l.voucher_id
        where l.account_code = $1 and v.date between $2 and $3 and ($4::text is null or l.party_id = $4) order by v.date, v.created_at, v.number`, [a.code, from, to, q.party ?? null])
    let bal = Number(o.b ?? 0)
    const rows = lines.map((l) => ({ ...l, debit_paise: Number(l.debit_paise), credit_paise: Number(l.credit_paise), balancePaise: (bal += Number(l.debit_paise) - Number(l.credit_paise)) }))
    const parties = await db.query<{ party_type: string; party_id: string; party_name: string | null; b: string }>(
      `select l.party_type, l.party_id, max(l.party_name) as party_name, sum(l.debit_paise - l.credit_paise) as b from voucher_line l join voucher v on v.id = l.voucher_id
        where l.account_code = $1 and l.party_id is not null and v.date <= $2 group by 1, 2 having sum(l.debit_paise - l.credit_paise) <> 0 order by 3`, [a.code, to])
    return { account: a, from, to, openingPaise: Number(o.b ?? 0), closingPaise: bal, rows,
      parties: parties.map((p) => ({ type: p.party_type, id: p.party_id, name: p.party_name ?? p.party_id, balancePaise: Number(p.b) })) }
  })

  app.get('/api/accounts/daybook', async (req) => {
    await need(req, ...VIEW)
    await fresh()
    const q = req.query as { from?: string; to?: string; kind?: string }
    const today = await businessDate(db)
    const from = q.from ?? addDays(today, -1), to = q.to ?? today
    if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, 'from and to as YYYY-MM-DD.')
    const vs = await db.query<{ id: string }>(
      `select v.id, v.number, v.kind, v.date::text, v.doc_date::text, v.narration, v.source_type, v.source_id, v.reverses, v.total_paise, u.name as created_by,
              (select r.number from voucher r where r.reverses = v.id) as reversed_by
         from voucher v left join app_user u on u.id = v.created_by where v.date between $1 and $2 and ($3::text is null or v.kind = $3) order by v.date desc, v.created_at desc limit 500`, [from, to, q.kind ?? null])
    const lines = vs.length ? await db.query<{ voucher_id: string }>(
      'select l.*, a.name as account from voucher_line l join account a on a.code = l.account_code where l.voucher_id = any($1) order by l.line', [vs.map((v) => v.id)]) : []
    return vs.map((v) => ({ ...v, lines: lines.filter((l) => l.voucher_id === v.id) }))
  })

  app.get('/api/accounts/vouchers/:id', async (req) => {
    await need(req, ...VIEW)
    const [v] = await db.query<{ id: string }>(
      `select v.*, v.date::text, v.doc_date::text, u.name as created_by_name, (select r.number from voucher r where r.reverses = v.id) as reversed_by,
              (select o.number from voucher o where o.id = v.reverses) as reverses_number
         from voucher v left join app_user u on u.id = v.created_by where v.id = $1 or v.number = $1`, [(req.params as { id: string }).id])
    if (!v) throw new HttpError(404, 'No such voucher.')
    const lines = await db.query('select l.*, a.name as account from voucher_line l join account a on a.code = l.account_code where l.voucher_id = $1 order by l.line', [v.id])
    return { ...v, lines }
  })

  /** Profit and loss by department: each operated department's revenue less its own costs, then the undistributed costs. */
  async function profitAndLoss(t: Db, from: string, to: string) {
    const rows = await t.query<{ code: string; name: string; type: string; grp: string; dept: string | null; amt: string }>(
      `select a.code, a.name, a.type, a.grp, coalesce(l.dept, a.dept, 'admin') as dept, sum(l.credit_paise - l.debit_paise) as amt
         from voucher_line l join voucher v on v.id = l.voucher_id join account a on a.code = l.account_code
        where a.type in ('income', 'expense') and v.date between $1 and $2 group by 1, 2, 3, 4, 5 order by a.code`, [from, to])
    const lines = rows.map((r) => ({ code: r.code, name: r.name, type: r.type, grp: r.grp, dept: r.dept, amountPaise: r.type === 'income' ? Number(r.amt) : -Number(r.amt) }))
    const sum = (f: (l: (typeof lines)[number]) => boolean) => lines.filter(f).reduce((a, l) => a + l.amountPaise, 0)
    const departments = Object.keys(DEPTS).map((d) => {
      const revenue = sum((l) => l.dept === d && l.type === 'income'), cost = sum((l) => l.dept === d && l.type === 'expense')
      return { dept: d, name: DEPTS[d], operated: OPERATED.includes(d), revenuePaise: revenue, costPaise: cost, profitPaise: revenue - cost }
    }).filter((d) => d.revenuePaise || d.costPaise)
    const revenue = sum((l) => l.type === 'income'), expenses = sum((l) => l.type === 'expense')
    const departmental = departments.filter((d) => d.operated).reduce((a, d) => a + d.profitPaise, 0)
    const undistributed = departments.filter((d) => !d.operated).reduce((a, d) => a + d.costPaise - d.revenuePaise, 0)
    return { from, to, lines, departments, totals: { revenuePaise: revenue, expensesPaise: expenses, departmentalProfitPaise: departmental, undistributedPaise: undistributed, profitPaise: revenue - expenses } }
  }

  app.get('/api/accounts/pnl', async (req) => {
    await need(req, ...VIEW)
    await fresh()
    const { from, to } = await range(req)
    return profitAndLoss(db, from, to)
  })

  app.get('/api/accounts/balance-sheet', async (req) => {
    await need(req, ...VIEW)
    await fresh()
    const asOf = (req.query as { asOf?: string }).asOf ?? await businessDate(db)
    if (!DATE.test(asOf)) throw new HttpError(400, 'asOf as YYYY-MM-DD.')
    const start = fyStart(asOf)
    const rows = await db.query<{ code: string; name: string; type: string; grp: string; b: string }>(
      `select a.code, a.name, a.type, a.grp, sum(l.debit_paise - l.credit_paise) as b from voucher_line l join voucher v on v.id = l.voucher_id join account a on a.code = l.account_code
        where a.type in ('asset', 'liability', 'equity') and v.date <= $1 group by 1, 2, 3, 4 having sum(l.debit_paise - l.credit_paise) <> 0 order by a.code`, [asOf])
    const [pl] = await db.query<{ year: string | null; before: string | null }>(
      `select sum(l.credit_paise - l.debit_paise) filter (where v.date >= $2) as year, sum(l.credit_paise - l.debit_paise) filter (where v.date < $2) as before
         from voucher_line l join voucher v on v.id = l.voucher_id join account a on a.code = l.account_code where a.type in ('income', 'expense') and v.date <= $1`, [asOf, start])
    const side = (type: string, sign: number) => rows.filter((r) => r.type === type).map((r) => ({ code: r.code, name: r.name, grp: r.grp, amountPaise: sign * Number(r.b) }))
    const assets = side('asset', 1), liabilities = side('liability', -1), equity = side('equity', -1)
    if (Number(pl.before ?? 0)) equity.push({ code: '', name: 'Profit of earlier years (not yet transferred)', grp: 'Equity', amountPaise: Number(pl.before) })
    equity.push({ code: '', name: `Profit for the year to ${asOf}`, grp: 'Equity', amountPaise: Number(pl.year ?? 0) })
    const total = (xs: { amountPaise: number }[]) => xs.reduce((a, x) => a + x.amountPaise, 0)
    return { asOf, assets, liabilities, equity, totals: { assetsPaise: total(assets), liabilitiesPaise: total(liabilities), equityPaise: total(equity) } }
  })

  // ---------- journal vouchers ----------
  app.post('/api/accounts/journal', async (req, reply) => {
    const who = await need(req, 'accounts.post')
    const b = (req.body ?? {}) as { date?: string; narration?: string; lines?: { code: string; debit?: number; credit?: number; dept?: string; party?: Party }[] }
    if (!b.narration?.trim()) throw new HttpError(400, 'Say what the entry is for.')
    if (!Array.isArray(b.lines) || b.lines.length < 2) throw new HttpError(400, 'A journal needs at least two lines.')
    const lines: PostLine[] = b.lines.map((l) => {
      const dr = Number(l.debit ?? 0), cr = Number(l.credit ?? 0)
      if (!(dr >= 0 && cr >= 0) || (dr > 0) === (cr > 0)) throw new HttpError(400, `Account ${l.code}: a debit or a credit, not both.`)
      if (l.dept && !DEPTS[l.dept]) throw new HttpError(400, 'No such department.')
      return { code: l.code, amount: rupees(dr) - rupees(cr), dept: l.dept || null, party: l.party?.id ? l.party : null }
    })
    await fresh()
    return db.tx(async (t) => {
      const today = await businessDate(t)
      const date = b.date ?? today
      if (!DATE.test(date) || date > today) throw new HttpError(400, 'The date: today or earlier.')
      const v = await wrap(() => postVoucher(t, { kind: 'journal', date, narration: b.narration!.trim(), lines, userId: who.userId, now: now(), manual: true }))
      if (!v) throw new HttpError(400, 'Nothing to post.')
      await appendAudit(t, { actor: who, action: 'voucher.journal', entity: { type: 'voucher', id: v.id }, amount: lines.reduce((a, l) => a + Math.max(0, l.amount), 0), after: { number: v.number, date, narration: b.narration } }, now())
      return reply.status(201).send(v)
    })
  })

  app.post('/api/accounts/vouchers/:id/reverse', async (req, reply) => {
    const who = await need(req, 'accounts.post')
    const reason = (req.body as { reason?: string } | null)?.reason?.trim()
    if (!reason) throw new HttpError(400, 'Why is it being reversed?')
    return db.tx(async (t) => {
      const [v] = await t.query<{ id: string; number: string; kind: string; source_type: string | null }>('select id, number, kind, source_type from voucher where id = $1', [(req.params as { id: string }).id])
      if (!v) throw new HttpError(404, 'No such voucher.')
      if (v.kind !== 'journal' || v.source_type) throw new HttpError(409, 'Only journal entries made by hand are reversed here: correct the bill, payment or document it came from.')
      const [done] = await t.query('select number from voucher where reverses = $1', [v.id])
      if (done) throw new HttpError(409, `Already reversed by ${(done as { number: string }).number}.`)
      const ls = await t.query<{ account_code: string; dept: string | null; debit_paise: string; credit_paise: string; party_type: Party['type'] | null; party_id: string | null; party_name: string | null; ref: string | null }>('select * from voucher_line where voucher_id = $1', [v.id])
      const today = await businessDate(t)
      const lines = ls.map((l) => ({ code: l.account_code, dept: l.dept, amount: Number(l.credit_paise) - Number(l.debit_paise), party: l.party_id ? { type: l.party_type!, id: l.party_id, name: l.party_name } : null, ref: l.ref }))
      const r = await wrap(() => postVoucher(t, { kind: 'reversal', date: today, narration: `Reversal of ${v.number}: ${reason}`, lines, reverses: v.id, userId: who.userId, now: now(), manual: true }))
      await appendAudit(t, { actor: who, action: 'voucher.reverse', entity: { type: 'voucher', id: v.id }, after: { reversal: r?.number, reason } }, now())
      return reply.status(201).send(r)
    })
  })

  // ---------- month locks ----------
  app.get('/api/accounts/periods', async (req) => {
    await need(req, ...VIEW)
    return db.query(`select p.month, p.note, p.locked_at, u.name as locked_by from period_lock p join app_user u on u.id = p.locked_by order by p.month desc`)
  })

  app.post('/api/accounts/periods', async (req, reply) => {
    const who = await need(req, 'accounts.lock')
    const b = (req.body ?? {}) as { month?: string; note?: string }
    if (!MONTH.test(b.month ?? '')) throw new HttpError(400, 'The month as YYYY-MM.')
    await fresh()
    return db.tx(async (t) => {
      const today = await businessDate(t)
      if (monthEnd(b.month!) >= today) throw new HttpError(409, `${b.month} is not over yet.`)
      const [dup] = await t.query('select 1 from period_lock where month = $1', [b.month])
      if (dup) throw new HttpError(409, `${b.month} is already locked.`)
      await t.query('insert into period_lock (month, note, locked_by, locked_at) values ($1,$2,$3,$4)', [b.month, b.note?.trim() || null, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'period.lock', entity: { type: 'period', id: b.month! }, after: { note: b.note ?? null } }, now())
      return reply.status(201).send({ month: b.month })
    })
  })

  // Reopening a closed month is the MD's call alone, and God Mode hears of it.
  app.post('/api/accounts/periods/:month/unlock', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!who.permissions.has('*')) throw new HttpError(403, 'Only the MD can reopen a locked month.')
    const { month } = req.params as { month: string }
    const reason = (req.body as { reason?: string } | null)?.reason?.trim()
    if (!reason) throw new HttpError(400, 'Why is the month being reopened?')
    return db.tx(async (t) => {
      const [l] = await t.query('delete from period_lock where month = $1 returning month', [month])
      if (!l) throw new HttpError(404, `${month} is not locked.`)
      await appendAudit(t, { actor: who, action: 'accounting_edit_after_day_close', entity: { type: 'period', id: month }, after: { unlocked: true, reason } }, now())
      return { month, unlocked: true }
    })
  })
}
