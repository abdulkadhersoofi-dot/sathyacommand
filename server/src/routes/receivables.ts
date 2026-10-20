import type { FastifyInstance, FastifyRequest } from 'fastify'
import { cashReceiptCheck, financialYear, PAN_RE, rupees, validateGstin } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { nextSeriesNumber } from '../invoicing'
import { LedgerError, postPending, postVoucher } from '../ledger'
import { BUCKETS, debtorOutstanding, openItems } from '../receivables'
import { requireCaller } from './auth'

// The city ledger: company and agent accounts with their credit limits and terms, statements and ageing,
// and money received from them (with the TDS they deduct, which is a credit for the resort's tax return).

const DATE = /^\d{4}-\d{2}-\d{2}$/
const KINDS = ['company', 'travel_agent', 'ota', 'government', 'other']
const VIEW = ['receivables.view', 'receivables.manage', 'accounts.view']
const MODES = ['bank', 'upi', 'cheque', 'cash'] as const

interface DebtorRow { id: string; name: string; kind: string; gstin: string | null; pan: string | null; address: string | null; city: string | null; contact_name: string | null; phone: string | null; email: string | null; credit_limit_paise: string | null; terms_days: number; active: boolean }


export interface ReceiptIn { debtorId?: string; amount?: number; tds?: number; tdsSection?: string; mode?: string; reference?: string; bankAccountId?: string; date?: string; note?: string }

async function debtorRow(t: Db, id: string) {
  const [d] = await t.query<DebtorRow>('select * from debtor where id = $1', [id])
  if (!d) throw new HttpError(404, 'No such account.')
  return d
}

/** Records money from a company: their account is credited with what it settles, TDS included. Shared with the bank screen. */
export async function receiveFromDebtor(ctx: Ctx, t: Db, who: Caller, b: ReceiptIn) {
const now = () => ctx.now()
  const d = await debtorRow(t, b.debtorId ?? '')
  const amount = rupees(Number(b.amount)), tds = rupees(Number(b.tds ?? 0))
  if (!(amount > 0)) throw new HttpError(400, 'How much does it settle?')
  if (tds < 0 || tds >= amount) throw new HttpError(400, 'TDS deducted must be less than the amount settled.')
  if (tds && !b.tdsSection?.trim()) throw new HttpError(400, 'Under which section did they deduct TDS (194-I, 194C…)?')
  const today = await businessDate(t)
  const date = b.date ?? today
  if (!DATE.test(date) || date > today) throw new HttpError(400, 'The date: today or earlier.')
  let bankCode = '1100', bankId: string | null = null
  if (b.mode === 'cash') {
    const [{ cash }] = await t.query<{ cash: string }>(`select coalesce(sum(amount_paise - tds_paise), 0) as cash from ar_receipt where debtor_id = $1 and date = $2 and mode = 'cash'`, [d.id, date])
    const c = cashReceiptCheck(ctx.tax, amount - tds, Number(cash))
    if (!c.allowed) throw new HttpError(403, c.message!)
  } else {
    const [ba] = b.bankAccountId
      ? await t.query<{ id: string; account_code: string }>('select id, account_code from bank_account where id = $1 and active', [b.bankAccountId])
      : await t.query<{ id: string; account_code: string }>('select id, account_code from bank_account where is_default and active')
    if (!ba) throw new HttpError(400, 'Which bank account was it paid into?')
    bankCode = ba.account_code; bankId = ba.id
  }
  const id = newId('AR'), number = await nextSeriesNumber(t, 'ar_receipt', financialYear(date), 'RCP')
  await t.query(`insert into ar_receipt (id, number, debtor_id, date, mode, reference, amount_paise, tds_paise, tds_section, bank_account_id, note, received_by, received_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, number, d.id, date, b.mode, b.reference?.trim() || null, amount, tds, b.tdsSection?.trim() || null, bankId, b.note?.trim() || null, who.userId, now()])
  let v: { id: string; number: string } | null
  try {
    v = await postVoucher(t, { kind: 'receipt', date, narration: `${number} from ${d.name}${b.reference ? ` (${b.reference.trim()})` : ''}`, source: { type: 'ar_receipt', id }, userId: who.userId, now: now(), lines: [
      { code: bankCode, amount: amount - tds, ref: b.reference?.trim() || null },
      { code: '1520', amount: tds, ref: b.tdsSection?.trim() || null, party: { type: 'company', id: d.id, name: d.name } },
      { code: '1310', amount: -amount, party: { type: 'company', id: d.id, name: d.name }, ref: number }] })
  } catch (e) { if (e instanceof LedgerError) throw new HttpError(e.statusCode, e.message); throw e }
  await t.query('update ar_receipt set voucher_id = $2 where id = $1', [id, v!.id])
  await appendAudit(t, { actor: who, action: 'receivable.receipt', entity: { type: 'ar_receipt', id }, amount, after: { number, debtor: d.name, mode: b.mode, tds, reference: b.reference ?? null } }, now())
  return { id, number, voucherId: v!.id, bankCode, netPaise: amount - tds }
}

export function receivablesRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const debtor = debtorRow
  /** Checks and tidies what was sent for an account. */
  function fields(b: Record<string, unknown>) {
    const out: Record<string, unknown> = {}
    if (b.name !== undefined) { if (!String(b.name).trim()) throw new HttpError(400, 'The company\'s name.'); out.name = String(b.name).trim() }
    if (b.kind !== undefined) { if (!KINDS.includes(String(b.kind))) throw new HttpError(400, 'Company, travel agent, OTA, government or other.'); out.kind = b.kind }
    if (b.gstin !== undefined) {
      if (!b.gstin) out.gstin = null
      else { const g = validateGstin(String(b.gstin)); if (!g.ok) throw new HttpError(400, g.reason); out.gstin = g.gstin }
    }
    if (b.pan !== undefined) {
      const pan = String(b.pan ?? '').trim().toUpperCase()
      if (pan && !PAN_RE.test(pan)) throw new HttpError(400, 'PAN: 5 letters, 4 digits, a letter (ABCDE1234F).')
      out.pan = pan || null
    }
    for (const [k, col] of [['address', 'address'], ['city', 'city'], ['contactName', 'contact_name'], ['phone', 'phone'], ['email', 'email']] as const) if (b[k] !== undefined) out[col] = String(b[k] ?? '').trim() || null
    if (b.termsDays !== undefined) { const d = Number(b.termsDays); if (!(Number.isInteger(d) && d >= 0 && d <= 365)) throw new HttpError(400, 'Terms: 0 to 365 days.'); out.terms_days = d }
    if (b.active !== undefined) out.active = !!b.active
    return out
  }

  // ---------- accounts ----------
  app.get('/api/debtors', async (req) => {
    await need(req, ...VIEW)
    await postPending(db, now())
    const today = await businessDate(db)
    const all = (req.query as { all?: string }).all === '1'
    const rows = await db.query<DebtorRow>(`select * from debtor where ($1 or active) order by name`, [all])
    const out = []
    for (const d of rows) {
      const items = await openItems(db, d.id, today, d.terms_days)
      out.push({ ...d, credit_limit_paise: d.credit_limit_paise == null ? null : Number(d.credit_limit_paise), outstandingPaise: await debtorOutstanding(db, d.id),
        overduePaise: items.overduePaise, ageing: items.ageing, oldestDays: items.open[0]?.daysOld ?? 0 })
    }
    return { asOf: today, buckets: BUCKETS, debtors: out }
  })

  app.post('/api/debtors', async (req, reply) => {
    const who = await need(req, 'receivables.manage')
    const b = (req.body ?? {}) as Record<string, unknown>
    const f = fields(b)
    if (!f.name) throw new HttpError(400, 'The company\'s name.')
    let limit: number | null = null
    if (b.creditLimit != null && b.creditLimit !== '') {
      if (!can(who, 'credit.limit')) throw new HttpError(403, 'The GM sets credit limits: open the account, then ask the GM.')
      limit = rupees(Number(b.creditLimit))
    }
    return db.tx(async (t) => {
      const [dup] = await t.query<{ name: string }>('select name from debtor where lower(name) = lower($1) or (gstin is not null and gstin = $2)', [f.name, f.gstin ?? null])
      if (dup) throw new HttpError(409, `${dup.name} already has an account.`)
      const id = newId('DR')
      await t.query(`insert into debtor (id, name, kind, gstin, pan, address, city, contact_name, phone, email, credit_limit_paise, terms_days, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, f.name, f.kind ?? 'company', f.gstin ?? null, f.pan ?? null, f.address ?? null, f.city ?? null, f.contact_name ?? null, f.phone ?? null, f.email ?? null, limit, f.terms_days ?? 30, now()])
      await appendAudit(t, { actor: who, action: 'debtor.add', entity: { type: 'debtor', id }, after: { ...f, creditLimit: limit } }, now())
      return reply.status(201).send({ id })
    })
  })

  app.patch('/api/debtors/:id', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const limitChange = b.creditLimit !== undefined
    const who = await need(req, ...(limitChange && Object.keys(b).length === 1 ? ['credit.limit'] : ['receivables.manage']))
    if (limitChange && !can(who, 'credit.limit')) throw new HttpError(403, 'Only the GM sets credit limits.')
    const { id } = req.params as { id: string }
    const f = fields(b)
    if (limitChange) f.credit_limit_paise = b.creditLimit == null || b.creditLimit === '' ? null : rupees(Number(b.creditLimit))
    if (!Object.keys(f).length) throw new HttpError(400, 'Nothing to change.')
    return db.tx(async (t) => {
      const before = await debtor(t, id)
      const cols = Object.keys(f)
      await t.query(`update debtor set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [id, ...cols.map((c) => f[c])])
      await appendAudit(t, { actor: who, action: limitChange ? 'debtor.credit_limit' : 'debtor.update', entity: { type: 'debtor', id }, before, after: f }, now())
      return { id }
    })
  })

  /** The account's statement: opening balance, every charge and receipt, closing balance, and what is unpaid by age. */
  async function statement(id: string, from: string, to: string) {
    await postPending(db, now())
    const d = await debtor(db, id)
    const [o] = await db.query<{ b: string | null }>(
      `select sum(l.debit_paise - l.credit_paise) as b from voucher_line l join voucher v on v.id = l.voucher_id where l.account_code = '1310' and l.party_type = 'company' and l.party_id = $1 and v.date < $2`, [id, from])
    const rows = await db.query<{ date: string; number: string; narration: string; ref: string | null; debit: string; credit: string }>(
      `select v.date::text, v.number, v.narration, l.ref, l.debit_paise as debit, l.credit_paise as credit from voucher_line l join voucher v on v.id = l.voucher_id
        where l.account_code = '1310' and l.party_type = 'company' and l.party_id = $1 and v.date between $2 and $3 order by v.date, v.created_at, l.line`, [id, from, to])
    let bal = Number(o.b ?? 0)
    const lines = rows.map((r) => ({ date: r.date, voucher: r.number, narration: r.ref && Number(r.debit) > 0 ? `Bill ${r.ref}` : r.narration, debitPaise: Number(r.debit), creditPaise: Number(r.credit), balancePaise: (bal += Number(r.debit) - Number(r.credit)) }))
    const items = await openItems(db, id, to, d.terms_days)
    return { debtor: d, from, to, openingPaise: Number(o.b ?? 0), lines, closingPaise: bal, ...items }
  }
  async function period(req: FastifyRequest) {
    const q = req.query as { from?: string; to?: string }
    const to = q.to ?? await businessDate(db), from = q.from ?? addDays(to, -90)
    if (!DATE.test(from) || !DATE.test(to) || to < from) throw new HttpError(400, 'from and to as YYYY-MM-DD.')
    return { from, to }
  }

  app.get('/api/debtors/:id/statement', async (req) => {
    await need(req, ...VIEW)
    const { from, to } = await period(req)
    return statement((req.params as { id: string }).id, from, to)
  })

  app.get('/api/debtors/:id/statement/print', async (req, reply) => {
    await need(req, ...VIEW)
    const { from, to } = await period(req)
    const s = await statement((req.params as { id: string }).id, from, to)
    const [p] = await db.query<{ legal_name: string | null; name: string; gstin: string | null; address: string | null; city: string | null }>('select legal_name, name, gstin, address, city from property limit 1')
    const [bank] = await db.query<{ name: string; bank: string | null; account_no: string | null; ifsc: string | null }>('select name, bank, account_no, ifsc from bank_account where is_default limit 1')
    const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
    const r = (paise: number) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Statement · ${esc(s.debtor.name)}</title><style>
      body{font:12px system-ui;margin:24px;color:#111}h1{font-size:18px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left}.n{text-align:right}.muted{color:#555}
      .top{display:flex;justify-content:space-between;gap:20px}</style></head><body>
      <div class="top"><div><h1>Statement of account</h1><div>${esc(p?.legal_name ?? p?.name)}${p?.gstin ? ` · GSTIN ${esc(p.gstin)}` : ''}</div><div class="muted">${esc([p?.address, p?.city].filter(Boolean).join(', '))}</div></div>
        <div><b>${esc(s.debtor.name)}</b>${s.debtor.gstin ? `<div>GSTIN ${esc(s.debtor.gstin)}</div>` : ''}<div class="muted">${esc([s.debtor.address, s.debtor.city].filter(Boolean).join(', '))}</div><div>${esc(from)} to ${esc(to)} · terms ${s.debtor.terms_days} days</div></div></div>
      <table><tr><th>Date</th><th>Reference</th><th>Particulars</th><th class="n">Charged</th><th class="n">Received</th><th class="n">Balance</th></tr>
        <tr><td colspan="5">Opening balance</td><td class="n">${r(s.openingPaise)}</td></tr>
        ${s.lines.map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(l.voucher)}</td><td>${esc(l.narration)}</td><td class="n">${l.debitPaise ? r(l.debitPaise) : ''}</td><td class="n">${l.creditPaise ? r(l.creditPaise) : ''}</td><td class="n">${r(l.balancePaise)}</td></tr>`).join('')}
        <tr><td colspan="5"><b>Balance due</b></td><td class="n"><b>${r(s.closingPaise)}</b></td></tr></table>
      <table><tr>${BUCKETS.map((b) => `<th class="n">${b} days</th>`).join('')}<th class="n">Overdue</th></tr><tr>${s.ageing.map((a) => `<td class="n">${r(a)}</td>`).join('')}<td class="n">${r(s.overduePaise)}</td></tr></table>
      ${bank?.account_no ? `<p>Please pay to ${esc(bank.bank ?? bank.name)}, account ${esc(bank.account_no)}${bank.ifsc ? `, IFSC ${esc(bank.ifsc)}` : ''}, quoting this statement. If you deduct TDS, please send the certificate.</p>` : ''}
      <script>window.onload=()=>window.print()</script></body></html>`
    return reply.type('text/html; charset=utf-8').send(html)
  })

  // ---------- money received ----------
  app.post('/api/ar-receipts', async (req, reply) => {
    const who = await need(req, 'receivables.manage')
    const b = (req.body ?? {}) as { debtorId?: string; amount?: number; tds?: number; tdsSection?: string; mode?: string; reference?: string; bankAccountId?: string; date?: string; note?: string; bankLineId?: string }
    if (!MODES.includes(b.mode as never)) throw new HttpError(400, 'How was it paid: bank, UPI, cheque or cash?')
    if (b.mode !== 'cash' && !b.reference?.trim()) throw new HttpError(400, 'The UTR, UPI reference or cheque number.')
    return db.tx(async (t) => reply.status(201).send(await receiveFromDebtor(ctx, t, who, b)))
  })


  app.get('/api/ar-receipts', async (req) => {
    await need(req, ...VIEW)
    return db.query(`select r.*, r.date::text, d.name as debtor, u.name as received_by_name from ar_receipt r join debtor d on d.id = r.debtor_id join app_user u on u.id = r.received_by order by r.received_at desc limit 200`)
  })

  // Reminders: accounts with charges past their terms, oldest first (for the daily list and God Mode).
  app.get('/api/debtors/overdue', async (req) => {
    await need(req, ...VIEW)
    await postPending(db, now())
    const today = await businessDate(db)
    const out = []
    for (const d of await db.query<DebtorRow>('select * from debtor where active order by name')) {
      const items = await openItems(db, d.id, today, d.terms_days)
      if (items.overduePaise > 0) out.push({ id: d.id, name: d.name, phone: d.phone, email: d.email, overduePaise: items.overduePaise, oldest: items.open.find((i) => i.overdue) })
    }
    return out.sort((a, b) => (a.oldest?.date ?? '').localeCompare(b.oldest?.date ?? ''))
  })
}
