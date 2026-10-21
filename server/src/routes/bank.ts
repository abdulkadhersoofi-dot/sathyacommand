import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { cashExpenseCheck, financialYear, IFSC_RE, rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { parseStatement } from '../bank-csv'
import { addDays, newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { nextSeriesNumber } from '../invoicing'
import { LedgerError, postPending, postVoucher, type PostLine, type VoucherInput } from '../ledger'
import { receiveFromDebtor } from './receivables'
import { requireCaller } from './auth'

// Banks and cash. Each bank account has its own ledger account; its statement is imported from the bank's
// CSV and matched line by line to the books (by amount, date and reference). What the books do not have yet
// (card and UPI settlements with the fees taken, money from companies, charges, interest) is posted from
// the statement line itself. The reconciliation shows what is still on one side only. Cash: banking the
// takings, and the petty cash float with the small expenses paid from it.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const VIEW = ['bank.reconcile', 'cash.manage', 'accounts.view']
const money = (p: number) => `₹${(Math.abs(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

interface BankRow { id: string; name: string; bank: string | null; branch: string | null; account_no: string | null; ifsc: string | null; account_code: string; is_default: boolean; active: boolean }
interface LineRow { id: string; bank_account_id: string; date: string; description: string; reference: string | null; amount_paise: string; balance_paise: string | null; status: string; voucher_id: string | null; voucher_line: number | null }

const mask = (no: string | null) => (no ? `••••${no.slice(-4)}` : null)

/** Book lines on a bank account not yet matched to a statement line. */
async function unmatchedBook(t: Db, code: string, from: string, to: string, amount?: number) {
  return t.query<{ voucher_id: string; line: number; number: string; date: string; narration: string; ref: string | null; amt: string }>(
    `select l.voucher_id, l.line, v.number, v.date::text, v.narration, l.ref, (l.debit_paise - l.credit_paise) as amt
       from voucher_line l join voucher v on v.id = l.voucher_id
      where l.account_code = $1 and v.date between $2 and $3 and ($4::bigint is null or l.debit_paise - l.credit_paise = $4)
        and not exists (select 1 from bank_line b where b.voucher_id = l.voucher_id and b.voucher_line = l.line) order by v.date, v.created_at`, [code, from, to, amount ?? null])
}

/** Long words and numbers in a statement line, to find its UTR or cheque number among the books. */
const tokens = (s: string) => [...new Set((s.toUpperCase().match(/[A-Z0-9]{6,}/g) ?? []))]

/** Matches open statement lines that have exactly one book entry of the same amount near the date (or one bearing its reference). */
export async function autoMatch(t: Db, bankAccountId: string, userId: string | null, now: Date) {
  const [ba] = await t.query<BankRow>('select * from bank_account where id = $1', [bankAccountId])
  const lines = await t.query<LineRow>(`select *, date::text from bank_line where bank_account_id = $1 and status = 'open' order by seq`, [bankAccountId])
  let matched = 0
  for (const l of lines) {
    const cands = await unmatchedBook(t, ba.account_code, addDays(l.date, -7), addDays(l.date, 3), Number(l.amount_paise))
    if (!cands.length) continue
    const keys = tokens(`${l.reference ?? ''} ${l.description}`)
    const byRef = cands.filter((c) => keys.some((k) => `${c.number} ${c.narration} ${c.ref ?? ''}`.toUpperCase().includes(k)))
    const pick = byRef.length === 1 ? byRef[0] : cands.length === 1 && !byRef.length ? cands[0] : null
    if (!pick) continue
    await t.query(`update bank_line set status = 'matched', voucher_id = $2, voucher_line = $3, decided_by = $4, decided_at = $5, note = 'matched automatically' where id = $1`, [l.id, pick.voucher_id, pick.line, userId, now])
    matched++
  }
  return matched
}

export function bankRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const post = async (t: Db, v: Omit<VoucherInput, 'now'>) => {
    try {
      const r = await postVoucher(t, { ...v, now: now() })
      if (!r) throw new HttpError(400, 'Nothing to post.')
      return r
    } catch (e) { if (e instanceof LedgerError) throw new HttpError(e.statusCode, e.message); throw e }
  }
  async function bankAccount(t: Db, id: string | undefined) {
    const [b] = id ? await t.query<BankRow>('select * from bank_account where id = $1', [id]) : await t.query<BankRow>('select * from bank_account where is_default')
    if (!b) throw new HttpError(404, 'No such bank account.')
    if (!b.active) throw new HttpError(409, `${b.name} is closed.`)
    return b
  }
  const balance = async (t: Db, code: string, upto: string) =>
    Number((await t.query<{ b: string | null }>('select sum(l.debit_paise - l.credit_paise) as b from voucher_line l join voucher v on v.id = l.voucher_id where l.account_code = $1 and v.date <= $2', [code, upto]))[0].b ?? 0)

  // ---------- bank accounts ----------
  app.get('/api/bank-accounts', async (req) => {
    const who = await need(req, ...VIEW, 'receivables.manage')
    await postPending(db, now())
    const today = await businessDate(db)
    const rows = await db.query<BankRow & { open: number; last_date: string | null; last_balance: string | null }>(
      `select a.*, (select count(*)::int from bank_line b where b.bank_account_id = a.id and b.status = 'open') as open,
              (select b.date::text from bank_line b where b.bank_account_id = a.id order by b.date desc, b.seq desc limit 1) as last_date,
              (select b.balance_paise from bank_line b where b.bank_account_id = a.id and b.balance_paise is not null order by b.date desc, b.seq desc limit 1) as last_balance
         from bank_account a order by a.is_default desc, a.name`)
    const out = []
    for (const r of rows) out.push({ ...r, account_no: can(who, 'vendors.bank') || can(who, 'bank.reconcile') ? r.account_no : mask(r.account_no), bookPaise: await balance(db, r.account_code, today), statementPaise: r.last_balance == null ? null : Number(r.last_balance) })
    return out
  })

  app.post('/api/bank-accounts', async (req, reply) => {
    const who = await need(req, 'bank.reconcile')
    const b = (req.body ?? {}) as { name?: string; bank?: string; branch?: string; accountNo?: string; ifsc?: string; isDefault?: boolean }
    if (!b.name?.trim()) throw new HttpError(400, 'Name the account (e.g. "SBI current account").')
    const ifsc = b.ifsc?.trim().toUpperCase() || null
    if (ifsc && !IFSC_RE.test(ifsc)) throw new HttpError(400, 'IFSC: 4 letters, 0, then 6 letters or digits.')
    return db.tx(async (t) => {
      const [dup] = await t.query('select 1 from bank_account where lower(name) = lower($1)', [b.name!.trim()])
      if (dup) throw new HttpError(409, 'A bank account with that name exists.')
      // Its own ledger account, numbered after the card and UPI accounts.
      const [{ next }] = await t.query<{ next: number }>(`select coalesce(max(code::int), 1229) + 1 as next from account where code ~ '^12[3-9][0-9]$'`)
      if (next > 1299) throw new HttpError(409, 'No more bank account codes free.')
      const code = String(next), id = newId('BANK')
      await t.query(`insert into account (code, name, type, grp, system, created_at) values ($1,$2,'asset','Cash and bank',true,$3)`, [code, `Bank: ${b.name!.trim()}`, now()])
      if (b.isDefault) await t.query('update bank_account set is_default = false where is_default')
      await t.query('insert into bank_account (id, name, bank, branch, account_no, ifsc, account_code, is_default, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, b.name!.trim(), b.bank?.trim() || null, b.branch?.trim() || null, b.accountNo?.replace(/\s/g, '') || null, ifsc, code, !!b.isDefault, now()])
      await appendAudit(t, { actor: who, action: 'bank_account.add', entity: { type: 'bank_account', id }, after: { name: b.name, bank: b.bank, accountNo: mask(b.accountNo ?? null), code } }, now())
      return reply.status(201).send({ id, accountCode: code })
    })
  })

  app.patch('/api/bank-accounts/:id', async (req) => {
    const who = await need(req, 'bank.reconcile')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; bank?: string; branch?: string; accountNo?: string; ifsc?: string; isDefault?: boolean; active?: boolean }
    const ifsc = b.ifsc === undefined ? undefined : b.ifsc.trim().toUpperCase() || null
    if (ifsc && !IFSC_RE.test(ifsc)) throw new HttpError(400, 'IFSC: 4 letters, 0, then 6 letters or digits.')
    return db.tx(async (t) => {
      const [before] = await t.query<BankRow>('select * from bank_account where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such bank account.')
      if (b.active === false && before.is_default) throw new HttpError(409, 'Make another account the default first.')
      if (b.isDefault) await t.query('update bank_account set is_default = false where is_default and id <> $1', [id])
      if (b.name?.trim() && b.name.trim() !== before.name) {
        const [dup] = await t.query('select 1 from bank_account where lower(name) = lower($1) and id <> $2', [b.name.trim(), id])
        if (dup) throw new HttpError(409, 'Another bank account already has that name.')
        await t.query('update bank_account set name = $2 where id = $1', [id, b.name.trim()])
        await t.query('update account set name = $2 where code = $1', [before.account_code, b.name.trim()])
      }
      await t.query(`update bank_account set bank = coalesce($2, bank), branch = coalesce($3, branch), account_no = coalesce($4, account_no), ifsc = case when $5::boolean then $6 else ifsc end,
          is_default = coalesce($7, is_default), active = coalesce($8, active) where id = $1`,
        [id, b.bank?.trim() || null, b.branch?.trim() || null, b.accountNo?.replace(/\s/g, '') || null, ifsc !== undefined, ifsc ?? null, b.isDefault ?? null, b.active ?? null])
      await appendAudit(t, { actor: who, action: 'bank_account.update', entity: { type: 'bank_account', id }, before: { ...before, account_no: mask(before.account_no) }, after: { ...b, accountNo: b.accountNo ? mask(b.accountNo) : undefined } }, now())
      return { id }
    })
  })

  // ---------- statements ----------
  app.post('/api/bank/import', async (req, reply) => {
    const who = await need(req, 'bank.reconcile')
    const b = (req.body ?? {}) as { bankAccountId?: string; csv?: string; fileName?: string }
    if (!b.csv?.trim()) throw new HttpError(400, 'Choose the statement file (CSV from the bank\'s website).')
    let parsed: ReturnType<typeof parseStatement>
    try { parsed = parseStatement(b.csv) } catch (e) { throw new HttpError(400, (e as Error).message) }
    if (!parsed.lines.length) throw new HttpError(400, 'No transactions found in the file.')
    await postPending(db, now())
    return db.tx(async (t) => {
      const ba = await bankAccount(t, b.bankAccountId)
      const importId = newId('BI')
      await t.query('insert into bank_import (id, bank_account_id, file_name, lines, skipped, imported_by, imported_at) values ($1,$2,$3,0,$4,$5,$6)', [importId, ba.id, b.fileName ?? null, parsed.skipped, who.userId, now()])
      const seen = new Map<string, number>()
      let added = 0, duplicates = 0
      for (const l of parsed.lines) {
        // Two identical lines in one statement are both real: the count among identical lines is part of the fingerprint.
        const key = [l.date, l.amountPaise, l.balancePaise ?? '', l.description, l.reference ?? ''].join('|')
        const k = (seen.get(key) ?? 0) + 1; seen.set(key, k)
        const fp = createHash('sha1').update(`${key}#${k}`).digest('hex')
        const r = await t.query(`insert into bank_line (id, bank_account_id, import_id, date, description, reference, amount_paise, balance_paise, fingerprint) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            on conflict (bank_account_id, fingerprint) do nothing returning id`, [newId('BL'), ba.id, importId, l.date, l.description, l.reference, l.amountPaise, l.balancePaise, fp])
        if (r.length) added++; else duplicates++
      }
      await t.query('update bank_import set lines = $2 where id = $1', [importId, added])
      const matched = await autoMatch(t, ba.id, who.userId, now())
      await appendAudit(t, { actor: who, action: 'bank.import', entity: { type: 'bank_import', id: importId }, after: { bank: ba.name, file: b.fileName ?? null, added, duplicates, matched } }, now())
      return reply.status(201).send({ importId, added, duplicates, skipped: parsed.skipped, matched, columns: parsed.columns })
    })
  })

  app.post('/api/bank/:id/auto-match', async (req) => {
    const who = await need(req, 'bank.reconcile')
    await postPending(db, now())
    return db.tx(async (t) => ({ matched: await autoMatch(t, (await bankAccount(t, (req.params as { id: string }).id)).id, who.userId, now()) }))
  })

  app.get('/api/bank/:id/lines', async (req) => {
    await need(req, ...VIEW)
    const q = req.query as { status?: string; from?: string; to?: string }
    const rows = await db.query(
      `select b.*, b.date::text, v.number as voucher_number, v.narration as voucher_narration, u.name as decided_by_name from bank_line b
         left join voucher v on v.id = b.voucher_id left join app_user u on u.id = b.decided_by
        where b.bank_account_id = $1 and ($2::text is null or b.status = $2) and ($3::date is null or b.date >= $3) and ($4::date is null or b.date <= $4)
        order by b.date desc, b.seq desc limit 500`, [(req.params as { id: string }).id, q.status && q.status !== 'all' ? q.status : null, q.from ?? null, q.to ?? null])
    return rows
  })

  async function line(t: Db, id: string, lock = false) {
    const [l] = await t.query<LineRow>(`select *, date::text from bank_line where id = $1${lock ? ' for update' : ''}`, [id])
    if (!l) throw new HttpError(404, 'No such statement line.')
    return l
  }

  app.get('/api/bank/lines/:id/candidates', async (req) => {
    await need(req, 'bank.reconcile')
    await postPending(db, now())
    const l = await line(db, (req.params as { id: string }).id)
    const [ba] = await db.query<BankRow>('select * from bank_account where id = $1', [l.bank_account_id])
    return unmatchedBook(db, ba.account_code, addDays(l.date, -45), addDays(l.date, 15), Number(l.amount_paise))
  })

  app.post('/api/bank/lines/:id/match', async (req) => {
    const who = await need(req, 'bank.reconcile')
    const b = (req.body ?? {}) as { voucherId?: string; line?: number }
    return db.tx(async (t) => {
      const l = await line(t, (req.params as { id: string }).id, true)
      if (l.status !== 'open') throw new HttpError(409, 'This statement line is already settled.')
      const [ba] = await t.query<BankRow>('select * from bank_account where id = $1', [l.bank_account_id])
      const [vl] = await t.query<{ amt: string; account_code: string }>('select account_code, debit_paise - credit_paise as amt from voucher_line where voucher_id = $1 and line = $2', [b.voucherId, b.line])
      if (!vl || vl.account_code !== ba.account_code) throw new HttpError(400, `That entry is not on ${ba.name}.`)
      if (Number(vl.amt) !== Number(l.amount_paise)) throw new HttpError(400, `The amounts differ: ${money(Number(vl.amt))} in the books, ${money(Number(l.amount_paise))} on the statement.`)
      const [taken] = await t.query('select 1 from bank_line where voucher_id = $1 and voucher_line = $2', [b.voucherId, b.line])
      if (taken) throw new HttpError(409, 'That book entry is already matched to another statement line.')
      await t.query(`update bank_line set status = 'matched', voucher_id = $2, voucher_line = $3, decided_by = $4, decided_at = $5, note = null where id = $1`, [l.id, b.voucherId, b.line, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'bank.match', entity: { type: 'bank_line', id: l.id }, amount: Number(l.amount_paise), after: { voucher: b.voucherId } }, now())
      return { ok: true }
    })
  })

  app.post('/api/bank/lines/:id/unmatch', async (req) => {
    const who = await need(req, 'bank.reconcile')
    return db.tx(async (t) => {
      const l = await line(t, (req.params as { id: string }).id, true)
      if (l.status === 'open') throw new HttpError(409, 'This line is not matched.')
      if (l.voucher_id) {
        const [v] = await t.query<{ source_type: string | null; source_id: string | null }>('select source_type, source_id from voucher where id = $1', [l.voucher_id])
        if (v?.source_type === 'bank_line') throw new HttpError(409, 'This entry was posted from the statement line: reverse it with a journal instead.')
      }
      await t.query(`update bank_line set status = 'open', voucher_id = null, voucher_line = null, decided_by = $2, decided_at = $3, note = null where id = $1`, [l.id, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'bank.unmatch', entity: { type: 'bank_line', id: l.id }, amount: Number(l.amount_paise) }, now())
      return { ok: true }
    })
  })

  app.post('/api/bank/lines/:id/ignore', async (req) => {
    const who = await need(req, 'bank.reconcile')
    const reason = (req.body as { reason?: string } | null)?.reason?.trim()
    if (!reason) throw new HttpError(400, 'Why is it left out (e.g. the opening balance line)?')
    return db.tx(async (t) => {
      const l = await line(t, (req.params as { id: string }).id, true)
      if (l.status !== 'open') throw new HttpError(409, 'This statement line is already settled.')
      await t.query(`update bank_line set status = 'ignored', note = $2, decided_by = $3, decided_at = $4 where id = $1`, [l.id, reason, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'bank.ignore', entity: { type: 'bank_line', id: l.id }, amount: Number(l.amount_paise), note: reason }, now())
      return { ok: true }
    })
  })

  /**
   * Puts into the books what only the statement has: a card or UPI settlement (the acquirer's fee and the GST on
   * it taken out), money from a company on credit, or anything else against an account (charges, interest,
   * TASMAC, a transfer).
   */
  app.post('/api/bank/lines/:id/post', async (req, reply) => {
    const who = await need(req, 'bank.reconcile')
    const b = (req.body ?? {}) as { kind?: string; gross?: number; gst?: number; debtorId?: string; tds?: number; tdsSection?: string; accountCode?: string; narration?: string; dept?: string }
    await postPending(db, now())
    return db.tx(async (t) => {
      const l = await line(t, (req.params as { id: string }).id, true)
      if (l.status !== 'open') throw new HttpError(409, 'This statement line is already settled.')
      const [ba] = await t.query<BankRow>('select * from bank_account where id = $1', [l.bank_account_id])
      const amt = Number(l.amount_paise), src = { type: 'bank_line', id: l.id }
      const label = `${l.description}${l.reference ? ` (${l.reference})` : ''}`
      let v: { id: string; number: string }
      if (b.kind === 'card_settlement' || b.kind === 'upi_settlement') {
        if (amt <= 0) throw new HttpError(400, 'A settlement is money coming in.')
        const gross = rupees(Number(b.gross)), gst = rupees(Number(b.gst ?? 0))
        if (!(gross >= amt)) throw new HttpError(400, `The takings settled: at least the ${money(amt)} received.`)
        const fee = gross - amt - gst
        if (fee < 0) throw new HttpError(400, 'The GST on the fee is more than the fee taken.')
        const cg = Math.round(gst / 2)
        v = await post(t, { kind: 'receipt', date: l.date, narration: `${b.kind === 'card_settlement' ? 'Card' : 'UPI'} settlement: ${label}`, source: src, userId: who.userId, lines: [
          { code: ba.account_code, amount: amt, ref: l.reference }, { code: '6050', amount: fee }, { code: '1500', amount: cg }, { code: '1501', amount: gst - cg },
          { code: b.kind === 'card_settlement' ? '1210' : '1220', amount: -gross }] })
      } else if (b.kind === 'debtor_receipt') {
        if (amt <= 0) throw new HttpError(400, 'Money from a company is money coming in.')
        const tds = Number(b.tds ?? 0)
        const r = await receiveFromDebtor(ctx, t, who, { debtorId: b.debtorId, amount: amt / 100 + tds, tds, tdsSection: b.tdsSection, mode: 'bank', reference: l.reference ?? l.description.slice(0, 60), bankAccountId: ba.id, date: l.date })
        v = { id: r.voucherId, number: '' }
      } else if (b.kind === 'account') {
        const [a] = await t.query<{ code: string; name: string }>('select code, name from account where code = $1 and active', [b.accountCode ?? ''])
        if (!a) throw new HttpError(400, 'Choose the account it belongs to.')
        if (a.code === ba.account_code) throw new HttpError(400, 'Choose the other side of the entry, not this bank.')
        const lines: PostLine[] = [{ code: ba.account_code, amount: amt, ref: l.reference }, { code: a.code, amount: -amt, dept: b.dept || null }]
        v = await post(t, { kind: ['1100', '1110'].includes(a.code) || /^12/.test(a.code) ? 'contra' : amt > 0 ? 'receipt' : 'payment', date: l.date, narration: b.narration?.trim() || label, source: src, userId: who.userId, lines })
      } else throw new HttpError(400, 'Card settlement, UPI settlement, money from a company, or another account.')
      const [bl] = await t.query<{ line: number }>('select line from voucher_line where voucher_id = $1 and account_code = $2 and debit_paise - credit_paise = $3 order by line limit 1', [v.id, ba.account_code, amt])
      await t.query(`update bank_line set status = 'matched', voucher_id = $2, voucher_line = $3, decided_by = $4, decided_at = $5, note = $6 where id = $1`, [l.id, v.id, bl.line, who.userId, now(), b.kind])
      await appendAudit(t, { actor: who, action: 'bank.post', entity: { type: 'bank_line', id: l.id }, amount: amt, after: { kind: b.kind, voucher: v.id } }, now())
      return reply.status(201).send({ voucherId: v.id })
    })
  })

  /** The reconciliation: the books and the statement, and what is on one side only. */
  app.get('/api/bank/:id/reconcile', async (req) => {
    await need(req, ...VIEW)
    await postPending(db, now())
    const asOf = (req.query as { asOf?: string }).asOf ?? await businessDate(db)
    if (!DATE.test(asOf)) throw new HttpError(400, 'asOf as YYYY-MM-DD.')
    const [ba] = await db.query<BankRow>('select * from bank_account where id = $1', [(req.params as { id: string }).id])
    if (!ba) throw new HttpError(404, 'No such bank account.')
    const [first] = await db.query<{ d: string | null }>('select min(date)::text as d from bank_line where bank_account_id = $1', [ba.id])
    const [last] = await db.query<{ date: string; balance_paise: string | null }>(
      'select date::text, balance_paise from bank_line where bank_account_id = $1 and date <= $2 and balance_paise is not null order by date desc, seq desc limit 1', [ba.id, asOf])
    const book = await balance(db, ba.account_code, asOf)
    // Book entries from before the first statement line are taken as reconciled already.
    const bookOnly = first.d ? (await unmatchedBook(db, ba.account_code, first.d, asOf)).map((x) => ({ ...x, amt: Number(x.amt) })) : []
    const bankOnly = (await db.query<{ id: string; date: string; description: string; reference: string | null; amount_paise: string }>(
      `select id, date::text, description, reference, amount_paise from bank_line where bank_account_id = $1 and status = 'open' and date <= $2 order by date, seq`, [ba.id, asOf])).map((x) => ({ ...x, amount_paise: Number(x.amount_paise) }))
    const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0)
    const expected = book - sum(bookOnly.map((x) => x.amt)) + sum(bankOnly.map((x) => x.amount_paise))
    const statement = last?.balance_paise == null ? null : Number(last.balance_paise)
    return {
      bank: { ...ba, account_no: mask(ba.account_no) }, asOf, bookPaise: book, statementPaise: statement, statementDate: last?.date ?? null,
      inBooksNotBank: bookOnly, inBankNotBooks: bankOnly, expectedStatementPaise: expected, differencePaise: statement == null ? null : statement - expected,
    }
  })

  // ---------- cash ----------
  app.get('/api/cash', async (req) => {
    await need(req, 'cash.manage', 'accounts.view')
    await postPending(db, now())
    const today = await businessDate(db)
    const rows = await db.query(`select c.*, c.date::text, a.name as account, u.name as by_name, v.number as voucher from cash_txn c left join account a on a.code = c.account_code
        join app_user u on u.id = c.by_user left join voucher v on v.id = c.voucher_id order by c.at desc, c.number desc limit 200`)
    return { asOf: today, cashPaise: await balance(db, '1100', today), pettyPaise: await balance(db, '1110', today), txns: rows,
      note: 'Cash in hand is the books up to the last closed business day: today\'s takings are added when the night audit closes the day.' }
  })

  async function cashTxn(t: Db, who: Caller, kind: 'deposit' | 'petty_topup' | 'petty_expense', f: { amount: number; bankAccountId?: string | null; accountCode?: string | null; description?: string | null; payee?: string | null; reference?: string | null; photoId?: string | null }, lines: PostLine[], narration: string) {
    const date = await businessDate(t)
    const id = newId('CX'), number = await nextSeriesNumber(t, 'cash_txn', financialYear(date), 'CSH')
    await t.query(`insert into cash_txn (id, number, kind, date, amount_paise, bank_account_id, account_code, description, payee, reference, photo_id, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, number, kind, date, f.amount, f.bankAccountId ?? null, f.accountCode ?? null, f.description ?? null, f.payee ?? null, f.reference ?? null, f.photoId ?? null, who.userId, now()])
    const v = await post(t, { kind: kind === 'petty_expense' ? 'payment' : 'contra', date, narration: `${number}: ${narration}`, source: { type: 'cash_txn', id }, userId: who.userId, lines })
    await t.query('update cash_txn set voucher_id = $2 where id = $1', [id, v.id])
    await appendAudit(t, { actor: who, action: `cash.${kind}`, entity: { type: 'cash_txn', id }, amount: f.amount, after: { number, ...f } }, now())
    return { id, number, voucherId: v.id }
  }

  app.post('/api/cash/deposit', async (req, reply) => {
    const who = await need(req, 'cash.manage')
    const b = (req.body ?? {}) as { amount?: number; bankAccountId?: string; reference?: string }
    const amount = rupees(Number(b.amount))
    if (!(amount > 0)) throw new HttpError(400, 'How much was banked?')
    return db.tx(async (t) => {
      const ba = await bankAccount(t, b.bankAccountId)
      return reply.status(201).send(await cashTxn(t, who, 'deposit', { amount, bankAccountId: ba.id, reference: b.reference?.trim() || null },
        [{ code: ba.account_code, amount, ref: b.reference?.trim() || null }, { code: '1100', amount: -amount }], `cash banked in ${ba.name}`))
    })
  })

  app.post('/api/cash/petty-topup', async (req, reply) => {
    const who = await need(req, 'cash.manage')
    const b = (req.body ?? {}) as { amount?: number; from?: string; bankAccountId?: string; reference?: string }
    const amount = rupees(Number(b.amount))
    if (!(amount > 0)) throw new HttpError(400, 'How much goes into the petty cash?')
    return db.tx(async (t) => {
      let from = '1100', bankId: string | null = null, label = 'cash in hand'
      if (b.from === 'bank') { const ba = await bankAccount(t, b.bankAccountId); from = ba.account_code; bankId = ba.id; label = ba.name }
      return reply.status(201).send(await cashTxn(t, who, 'petty_topup', { amount, bankAccountId: bankId, reference: b.reference?.trim() || null },
        [{ code: '1110', amount }, { code: from, amount: -amount, ref: b.reference?.trim() || null }], `petty cash topped up from ${label}`))
    })
  })

  app.post('/api/cash/petty-expense', async (req, reply) => {
    const who = await need(req, 'cash.manage')
    const b = (req.body ?? {}) as { amount?: number; accountCode?: string; description?: string; payee?: string; photoId?: string; dept?: string; confirm?: boolean }
    const amount = rupees(Number(b.amount))
    if (!(amount > 0)) throw new HttpError(400, 'How much was paid?')
    if (!b.description?.trim() || !b.payee?.trim()) throw new HttpError(400, 'What it was for, and who was paid.')
    return db.tx(async (t) => {
      const [a] = await t.query<{ code: string; type: string }>('select code, type from account where code = $1 and active', [b.accountCode ?? ''])
      if (!a || !['expense', 'asset'].includes(a.type)) throw new HttpError(400, 'Choose the expense it is.')
      const today = await businessDate(t)
      const petty = await balance(t, '1110', today)
      if (petty < amount) throw new HttpError(409, `The petty cash has ${money(petty)}: top it up first.`)
      const [{ same }] = await t.query<{ same: string }>(`select coalesce(sum(amount_paise), 0) as same from cash_txn where kind = 'petty_expense' and date = $1 and lower(payee) = lower($2)`, [today, b.payee!.trim()])
      const c = cashExpenseCheck(ctx.tax, amount, Number(same))
      if (c.warn && !b.confirm) throw new HttpError(409, c.message!, { needsConfirm: true })
      return reply.status(201).send({ ...(await cashTxn(t, who, 'petty_expense', { amount, accountCode: a.code, description: b.description!.trim(), payee: b.payee!.trim(), photoId: b.photoId ?? null },
        [{ code: a.code, amount, dept: b.dept || null }, { code: '1110', amount: -amount }], `${b.description!.trim()} (${b.payee!.trim()})`)), warning: c.warn ? c.message : null })
    })
  })
}
