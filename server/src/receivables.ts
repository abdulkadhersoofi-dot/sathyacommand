import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import { addDays, daysBetween } from './eng-core'

// The city ledger: companies and agents who are billed on credit. Each has an account (made the first time
// they are billed, for accounts to complete), a credit limit and payment terms; what they owe is read from
// the ledger, plus what has been charged to them today and not yet posted.

const money = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/** The company's account: by GSTIN when there is one, else by name; opened on first use. */
export async function debtorFor(t: Db, name: string, gstin: string | null | undefined, now: Date) {
  const n = name.trim()
  const [byGstin] = gstin ? await t.query<{ id: string }>('select id from debtor where gstin = $1', [gstin]) : []
  if (byGstin) return byGstin.id
  const [byName] = await t.query<{ id: string; gstin: string | null }>('select id, gstin from debtor where lower(name) = lower($1)', [n])
  if (byName) {
    if (gstin && !byName.gstin) await t.query('update debtor set gstin = $2 where id = $1', [byName.id, gstin])
    return byName.id
  }
  const id = `DR-${randomUUID().slice(0, 8).toUpperCase()}`
  await t.query('insert into debtor (id, name, gstin, created_at) values ($1,$2,$3,$4)', [id, n, gstin || null, now])
  return id
}

/** What the company owes now: the city ledger, and today's credit not yet in it. */
export async function debtorOutstanding(t: Db, debtorId: string) {
  const [r] = await t.query<{ posted: string | null; fo: string | null; fnb: string | null }>(
    `select (select sum(l.debit_paise - l.credit_paise) from voucher_line l where l.account_code = '1310' and l.party_type = 'company' and l.party_id = $1) as posted,
            (select sum(p.amount_paise) from payment p join folio_line fl on fl.id = p.line_id where p.debtor_id = $1 and p.method = 'company'
                and not exists (select 1 from posted_source s where s.source_type = 'fo_pay_day' and s.source_id = fl.business_date::text)) as fo,
            (select sum(p.amount_paise) from fnb_payment p where p.debtor_id = $1 and p.method = 'company'
                and not exists (select 1 from posted_source s where s.source_type = 'fnb_day' and s.source_id = p.business_date::text)) as fnb`, [debtorId])
  return Number(r.posted ?? 0) + Number(r.fo ?? 0) + Number(r.fnb ?? 0)
}

export class CreditError extends Error { statusCode = 409 }

/** Refuses credit beyond the company's limit, or to a company whose account is closed. */
export async function checkCredit(t: Db, debtorId: string, amount: number) {
  const [d] = await t.query<{ name: string; credit_limit_paise: string | null; active: boolean }>('select name, credit_limit_paise, active from debtor where id = $1', [debtorId])
  if (!d.active) throw new CreditError(`${d.name}'s credit account is closed. Take payment, or ask accounts to reopen it.`)
  if (d.credit_limit_paise == null || amount <= 0) return
  const owed = await debtorOutstanding(t, debtorId), limit = Number(d.credit_limit_paise)
  if (owed + amount > limit) throw new CreditError(`${d.name} would owe ${money(owed + amount)}, over their credit limit of ${money(limit)} (owing ${money(owed)} now). Take payment, or ask the GM to raise the limit.`)
}

export interface OpenItem { date: string; voucher: string; narration: string; amountPaise: number; openPaise: number; dueDate: string; daysOld: number; overdue: boolean }
export const BUCKETS = ['0–30', '31–60', '61–90', 'over 90'] as const

/**
 * What is still unpaid, item by item: payments and credits settle the oldest charges first. Ageing is by the
 * charge's date, overdue from its due date (the date plus the company's terms).
 */
export async function openItems(t: Db, debtorId: string, asOf: string, termsDays: number) {
  // Line by line: each bill a company is charged for is its own item, named by its invoice.
  const rows = await t.query<{ date: string; number: string; narration: string; ref: string | null; amt: string }>(
    `select v.date::text, v.number, v.narration, l.ref, l.debit_paise - l.credit_paise as amt from voucher_line l join voucher v on v.id = l.voucher_id
      where l.account_code = '1310' and l.party_type = 'company' and l.party_id = $1 and v.date <= $2 order by v.date, v.created_at, l.line`, [debtorId, asOf])
  const charges: OpenItem[] = []
  let credit = 0
  for (const r of rows) {
    const a = Number(r.amt)
    if (a > 0) charges.push({ date: r.date, voucher: r.number, narration: r.ref ? `Bill ${r.ref}` : r.narration, amountPaise: a, openPaise: a, dueDate: addDays(r.date, termsDays), daysOld: daysBetween(r.date, asOf), overdue: false })
    else credit += -a
  }
  for (const c of charges) { const take = Math.min(credit, c.openPaise); c.openPaise -= take; credit -= take }
  const open = charges.filter((c) => c.openPaise > 0).map((c) => ({ ...c, overdue: c.dueDate < asOf }))
  const ageing = [0, 0, 0, 0]
  for (const c of open) ageing[c.daysOld <= 30 ? 0 : c.daysOld <= 60 ? 1 : c.daysOld <= 90 ? 2 : 3] += c.openPaise
  return { open, unappliedPaise: credit, ageing, overduePaise: open.filter((c) => c.overdue).reduce((a, c) => a + c.openPaise, 0) }
}
