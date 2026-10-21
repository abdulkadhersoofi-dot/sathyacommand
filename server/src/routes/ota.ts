import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { financialYear, rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { csvRows, statementAmount, statementDate } from '../bank-csv'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { nextSeriesNumber } from '../invoicing'
import { LedgerError, postPending, postVoucher, type PostLine } from '../ledger'
import { OTAS } from '../receivables'
import { requireCaller } from './auth'

// OTAs and tax credits. A booking the guest paid the OTA for is owed by the OTA; its payout settles the
// bookings net of commission, GST on the commission (claimable), GST TCS (section 52) and income-tax TDS
// (194-O). Each payout is checked against the bookings and the agreed rates. Every tax deducted or collected
// from the resort (by OTAs, companies and TASMAC) is a credit to claim, matched with Form 26AS by deductor
// and quarter, and followed up when it does not appear.

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** Rates the law sets, to check what the OTA took. CA check: the bases (value with or without GST). */
const GST_TCS_RATE = 0.5, TDS_194O_RATE = 0.1, COMMISSION_GST = 18
const quarterOf = (d: string) => { const m = Number(d.slice(5, 7)); return m >= 4 && m <= 6 ? 1 : m <= 9 && m >= 7 ? 2 : m >= 10 ? 3 : 4 }
const r1 = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

interface LineIn { otaRef?: string; reservationId?: string; guest?: string; checkIn?: string; gross: number; commission?: number; commissionGst?: number; gstTcs?: number; tds?: number }

/** Reads an OTA's payout report (CSV): one row per booking settled. */
export function parsePayout(text: string): LineIn[] {
  const rows = csvRows(text.replace(/^﻿/, ''))
  const hi = rows.findIndex((r) => r.some((x) => /booking|reservation|confirmation/i.test(x)) && r.some((x) => /amount|gross|total|value/i.test(x)))
  if (hi < 0) throw new Error('Could not find the header row (booking ID, amount, commission, TCS, TDS).')
  const head = rows[hi].map((x) => x.trim().toLowerCase())
  const col = (re: RegExp, not?: RegExp) => head.findIndex((h) => re.test(h) && !(not?.test(h)))
  const ref = col(/booking|reservation|confirmation/, /date|amount|value/), guest = col(/guest|name/), checkIn = col(/check.?in|arrival|stay date/)
  const gross = col(/gross|booking amount|booking value|total amount|^amount$|amount collected/, /commission|net|tax|gst|tds|tcs/)
  const commission = col(/commission/, /gst|tax/), cgst = col(/(gst|tax).*(commission)|commission.*(gst|tax)/)
  const tcs = col(/tcs/), tds = col(/tds|194/)
  if (ref < 0 || gross < 0) throw new Error('The payout report needs a booking ID and a booking amount column.')
  const amt = (r: string[], i: number) => (i >= 0 ? statementAmount(r[i]) / 100 : 0)
  return rows.slice(hi + 1).filter((r) => (r[ref] ?? '').trim() && !/total/i.test(r[ref]) && statementAmount(r[gross]) > 0).map((r) => ({
    otaRef: r[ref].trim(), guest: guest >= 0 ? r[guest]?.trim() : undefined, checkIn: checkIn >= 0 ? statementDate(r[checkIn] ?? '') ?? undefined : undefined,
    gross: amt(r, gross), commission: amt(r, commission), commissionGst: amt(r, cgst), gstTcs: amt(r, tcs), tds: amt(r, tds),
  }))
}

/** Reads Form 26AS or the AIS saved as CSV (or the TRACES text file, caret-separated): the TDS and TCS credited to the resort. */
export function parse26as(text: string) {
  const clean = text.replace(/^﻿/, '')
  const caret = (clean.split(/\r?\n/).find((l) => l.includes('^')) ?? '').split('^').length > (clean.split(/\r?\n/)[0] ?? '').split(',').length
  const rows = caret ? clean.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('^')) : csvRows(clean)
  const hi = rows.findIndex((r) => r.some((x) => /deductor|collector/i.test(x)) && r.some((x) => /tax|tds|tcs/i.test(x)))
  if (hi < 0) throw new Error('Could not find the header row (name of deductor, TAN, section, date, amount, tax deducted).')
  const head = rows[hi].map((x) => x.trim().toLowerCase())
  const col = (re: RegExp, not?: RegExp) => head.findIndex((h) => re.test(h) && !(not?.test(h)))
  const name = col(/name/), tan = col(/\btan\b/), section = col(/section/), date = col(/transaction date|date of|^date/, /booking|deposit/)
  const paid = col(/amount paid|paid ?\/ ?credited|amount credited|^amount/, /tax|tds|tcs/), tax = col(/tax deducted|tds deposited|tax collected|tcs|tds|tax deducted\/collected/, /amount paid/)
  if (name < 0 || tax < 0 || date < 0) throw new Error('Form 26AS needs the deductor\'s name, the date and the tax columns.')
  const collected = head.some((h) => /collect/.test(h))
  return rows.slice(hi + 1).map((r) => {
    const d = statementDate(r[date] ?? '')
    const sec = section >= 0 ? (r[section] ?? '').trim().toUpperCase() : ''
    return d && statementAmount(r[tax]) ? {
      deductor: (r[name] ?? '').trim(), tan: tan >= 0 ? (r[tan] ?? '').trim().toUpperCase() || null : null, section: sec || null, date: d,
      paidPaise: paid >= 0 ? statementAmount(r[paid]) : 0, taxPaise: statementAmount(r[tax]), kind: (collected || /^206C/.test(sec) ? 'tcs' : 'tds') as 'tds' | 'tcs',
    } : null
  }).filter((x): x is NonNullable<typeof x> => !!x)
}

/** A deductor's name made comparable: case, punctuation and company suffixes dropped. */
export const nameKey = (s: string) => s.toLowerCase().replace(/\b(private|pvt|limited|ltd|llp|india|the|co|company|corporation|corp)\b/g, '').replace(/[^a-z0-9]/g, '')

export function otaRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }

  /** Each booking an OTA collected for: what it collected, what its payouts settled, what is still to come. */
  async function bookings(t: Db, debtorId: string) {
    return (await t.query<{ reservation_id: string; ota_ref: string | null; guest: string; arrival: string; departure: string; status: string; collected: string; paid_out: string; taxable: string }>(
      `select r.id as reservation_id, r.ota_ref, g.name as guest, r.arrival::text, r.departure::text, r.status,
              sum(p.amount_paise) as collected,
              coalesce((select sum(l.gross_paise) from ota_payout_line l where l.reservation_id = r.id), 0) as paid_out,
              coalesce((select sum(fl.taxable_paise) from folio_line fl join folio f on f.id = fl.folio_id where f.reservation_id = r.id and fl.kind in ('room', 'extra_bed', 'reversal')), 0) as taxable
         from payment p join folio f on f.id = p.folio_id join reservation r on r.id = f.reservation_id join guest g on g.id = r.guest_id
        where p.method = 'ota' and p.debtor_id = $1 group by r.id, g.name order by r.arrival`, [debtorId]))
      .map((b) => ({ ...b, collected: Number(b.collected), paid_out: Number(b.paid_out), taxable: Number(b.taxable), open: Number(b.collected) - Number(b.paid_out) }))
  }

  app.get('/api/ota', async (req) => {
    await need(req, 'receivables.view', 'receivables.manage', 'accounts.view')
    await postPending(db, now())
    const rows = await db.query<{ id: string; name: string; gstin: string | null; tan: string | null; commission_percent: string | null; owed: string | null }>(
      `select d.id, d.name, d.gstin, d.tan, d.commission_percent,
              (select sum(l.debit_paise - l.credit_paise) from voucher_line l where l.account_code = '1320' and l.party_id = d.id) as owed
         from debtor d where d.kind = 'ota' order by d.name`)
    const out = []
    for (const r of rows) {
      const bs = await bookings(db, r.id)
      out.push({ ...r, commission_percent: r.commission_percent == null ? null : Number(r.commission_percent), owedPaise: Number(r.owed ?? 0),
        unsettledPaise: bs.reduce((a, b) => a + Math.max(0, b.open), 0), unsettledBookings: bs.filter((b) => b.open > 0).length })
    }
    return { otas: out, known: OTAS }
  })

  app.get('/api/ota/:id/bookings', async (req) => {
    await need(req, 'receivables.view', 'receivables.manage', 'accounts.view')
    const all = (req.query as { all?: string }).all === '1'
    return (await bookings(db, (req.params as { id: string }).id)).filter((b) => all || b.open !== 0)
  })

  app.patch('/api/ota/:id', async (req) => {
    const who = await need(req, 'receivables.manage')
    const b = (req.body ?? {}) as { commissionPercent?: number | null; tan?: string | null; gstin?: string | null }
    const tan = b.tan === undefined ? undefined : (b.tan ?? '').trim().toUpperCase() || null
    if (tan && !/^[A-Z]{4}\d{5}[A-Z]$/.test(tan)) throw new HttpError(400, 'TAN: 4 letters, 5 digits, a letter (e.g. MUMM12345A).')
    if (b.commissionPercent != null && !(b.commissionPercent >= 0 && b.commissionPercent <= 50)) throw new HttpError(400, 'Commission: 0 to 50%.')
    const id = (req.params as { id: string }).id
    await db.query(`update debtor set commission_percent = case when $2::boolean then $3::numeric else commission_percent end, tan = case when $4::boolean then $5 else tan end where id = $1`,
      [id, b.commissionPercent !== undefined, b.commissionPercent ?? null, tan !== undefined, tan ?? null])
    await appendAudit(db, { actor: who, action: 'ota.terms', entity: { type: 'debtor', id }, after: b }, now())
    return { id }
  })

  /**
   * Records an OTA payout: the bookings it settles (typed or from the OTA's report), checked against what the
   * guests paid the OTA and against the commission and tax rates; then booked to the bank.
   */
  app.post('/api/ota/payouts', async (req, reply) => {
    const who = await need(req, 'receivables.manage')
    const b = (req.body ?? {}) as { debtorId?: string; date?: string; reference?: string; bankAccountId?: string; commissionInvoice?: string; other?: number; net?: number; lines?: LineIn[]; csv?: string }
    let lines: LineIn[] = b.lines ?? []
    if (b.csv) { try { lines = parsePayout(b.csv) } catch (e) { throw new HttpError(400, (e as Error).message) } }
    if (!lines.length) throw new HttpError(400, 'Which bookings does the payout settle?')
    const utr = b.reference?.trim()
    if (!utr) throw new HttpError(400, 'Enter the payout\'s UTR (as on the bank statement).')
    await postPending(db, now())
    return db.tx(async (t) => {
      const [d] = await t.query<{ id: string; name: string; gstin: string | null; tan: string | null; commission_percent: string | null }>(`select id, name, gstin, tan, commission_percent from debtor where id = $1 and kind = 'ota'`, [b.debtorId])
      if (!d) throw new HttpError(404, 'No such OTA.')
      const today = await businessDate(t)
      const date = b.date ?? today
      if (!DATE.test(date) || date > today) throw new HttpError(400, 'Enter the payout date: today or earlier.')
      const [ba] = b.bankAccountId ? await t.query<{ id: string; account_code: string }>('select id, account_code from bank_account where id = $1 and active', [b.bankAccountId])
        : await t.query<{ id: string; account_code: string }>('select id, account_code from bank_account where is_default and active')
      if (!ba) throw new HttpError(400, 'Which bank account did it come into?')
      const open = await bookings(t, d.id)
      const checks: string[] = []
      const rows = lines.map((l, i) => {
        const p = (x: number | undefined) => rupees(Number(x ?? 0))
        const row = { line: i + 1, otaRef: l.otaRef?.trim() || null, reservationId: l.reservationId ?? null as string | null, guest: l.guest ?? null, checkIn: l.checkIn ?? null,
          gross: p(l.gross), commission: p(l.commission), commissionGst: p(l.commissionGst), gstTcs: p(l.gstTcs), tds: p(l.tds) }
        if (!(row.gross > 0)) throw new HttpError(400, `Line ${i + 1}: the booking amount.`)
        const bk = open.find((x) => (row.reservationId && x.reservation_id === row.reservationId) || (row.otaRef && x.ota_ref?.toUpperCase() === row.otaRef.toUpperCase()))
        const label = row.otaRef ?? row.reservationId ?? `line ${i + 1}`
        if (!bk) checks.push(`${label}: no booking through ${d.name} with this ID was paid by the OTA.`)
        else {
          row.reservationId = bk.reservation_id; row.guest ??= bk.guest; row.checkIn ??= bk.arrival
          if (bk.open <= 0) checks.push(`${label}: already settled by an earlier payout.`)
          else if (Math.abs(bk.open - row.gross) > 100) checks.push(`${label}: the OTA reports ${r1(row.gross)}, the guest paid ${r1(bk.open)} for it.`)
          const base = bk.taxable || Math.round(row.gross / 1.05)
          if (row.gstTcs && Math.abs(row.gstTcs - Math.round((base * GST_TCS_RATE) / 100)) > 100) checks.push(`${label}: GST TCS ${r1(row.gstTcs)}, expected ${r1(Math.round((base * GST_TCS_RATE) / 100))} (0.5% of ${r1(base)}).`)
          if (row.tds && Math.abs(row.tds - Math.round((base * TDS_194O_RATE) / 100)) > 100) checks.push(`${label}: TDS ${r1(row.tds)}, expected ${r1(Math.round((base * TDS_194O_RATE) / 100))} (0.1% of ${r1(base)}).`)
        }
        if (d.commission_percent != null && row.commission && Math.abs(row.commission - Math.round((row.gross * Number(d.commission_percent)) / 100)) > 100) checks.push(`${label}: commission ${r1(row.commission)}, ${Number(d.commission_percent)}% agreed is ${r1(Math.round((row.gross * Number(d.commission_percent)) / 100))}.`)
        if (row.commission && Math.abs(row.commissionGst - Math.round((row.commission * COMMISSION_GST) / 100)) > 100) checks.push(`${label}: GST on commission ${r1(row.commissionGst)}, 18% is ${r1(Math.round((row.commission * COMMISSION_GST) / 100))}.`)
        return row
      })
      const sum = (k: 'gross' | 'commission' | 'commissionGst' | 'gstTcs' | 'tds') => rows.reduce((a, r) => a + r[k], 0)
      const other = rupees(Number(b.other ?? 0))
      const net = sum('gross') - sum('commission') - sum('commissionGst') - sum('gstTcs') - sum('tds') - other
      if (b.net != null && Math.abs(rupees(b.net) - net) > 100) throw new HttpError(400, `The lines come to ${r1(net)} net, the payout is ${r1(rupees(b.net))}: check the deductions.`)
      if (net <= 0) throw new HttpError(400, 'The deductions are more than the bookings.')
      const id = newId('OP'), number = await nextSeriesNumber(t, 'ota_payout', financialYear(date), 'OTP')
      await t.query(`insert into ota_payout (id, number, debtor_id, date, reference, bank_account_id, commission_invoice, gross_paise, commission_paise, commission_gst_paise, gst_tcs_paise, tds_paise, other_paise, net_paise, checks, by_user, at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, number, d.id, date, utr, ba.id, b.commissionInvoice?.trim() || null, sum('gross'), sum('commission'), sum('commissionGst'), sum('gstTcs'), sum('tds'), other, net, JSON.stringify(checks), who.userId, now()])
      for (const r of rows) {
        await t.query(`insert into ota_payout_line (payout_id, line, ota_ref, reservation_id, guest, check_in, gross_paise, commission_paise, commission_gst_paise, gst_tcs_paise, tds_paise) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, r.line, r.otaRef, r.reservationId, r.guest, r.checkIn, r.gross, r.commission, r.commissionGst, r.gstTcs, r.tds])
      }
      const party = { type: 'ota' as const, id: d.id, name: d.name }
      const cgst = sum('commissionGst'), interstate = !!d.gstin && d.gstin.slice(0, 2) !== '33', half = Math.round(cgst / 2)
      const vl: PostLine[] = [
        { code: ba.account_code, amount: net, ref: utr },
        { code: '6040', amount: sum('commission') + other, ref: b.commissionInvoice?.trim() || null },
        ...(interstate ? [{ code: '1502', amount: cgst }] : [{ code: '1500', amount: half }, { code: '1501', amount: cgst - half }]),
        { code: '1522', amount: sum('gstTcs'), party }, { code: '1520', amount: sum('tds'), party, ref: '194-O' },
        { code: '1320', amount: -sum('gross'), party, ref: number }]
      let v: { id: string; number: string } | null
      try { v = await postVoucher(t, { kind: 'receipt', date, narration: `${number}: ${d.name} payout (${utr})`, source: { type: 'ota_payout', id }, userId: who.userId, now: now(), lines: vl }) }
      catch (e) { if (e instanceof LedgerError) throw new HttpError(e.statusCode, e.message); throw e }
      await t.query('update ota_payout set voucher_id = $2 where id = $1', [id, v!.id])
      await appendAudit(t, { actor: who, action: 'ota.payout', entity: { type: 'ota_payout', id }, amount: net, after: { number, ota: d.name, bookings: rows.length, gross: sum('gross'), checks: checks.length } }, now())
      return reply.status(201).send({ id, number, netPaise: net, grossPaise: sum('gross'), checks })
    })
  })

  app.get('/api/ota/payouts', async (req) => {
    await need(req, 'receivables.view', 'receivables.manage', 'accounts.view')
    const q = req.query as { debtorId?: string }
    const rows = await db.query<{ id: string }>(`select p.*, p.date::text, d.name as ota, v.number as voucher from ota_payout p join debtor d on d.id = p.debtor_id left join voucher v on v.id = p.voucher_id
        where ($1::text is null or p.debtor_id = $1) order by p.at desc limit 100`, [q.debtorId ?? null])
    const lines = rows.length ? await db.query<{ payout_id: string }>('select *, check_in::text from ota_payout_line where payout_id = any($1) order by line', [rows.map((r) => r.id)]) : []
    return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.payout_id === r.id) }))
  })

  // ---------- tax credits ----------
  /** Every tax deducted or collected from the resort that it can claim: what the books expect, by deductor and quarter. */
  async function expected(t: Db, fy: string) {
    const [from, to] = [`20${fy.slice(2, 4)}-04-01`, `20${fy.slice(5, 7)}-03-31`]
    const rows = await t.query<{ kind: string; party: string; tan: string | null; section: string | null; date: string; base: string; tax: string; ref: string }>(
      `select 'tds' as kind, d.name as party, d.tan, r.tds_section as section, r.date::text, r.amount_paise as base, r.tds_paise as tax, r.number as ref
         from ar_receipt r join debtor d on d.id = r.debtor_id where r.tds_paise > 0 and r.date between $1 and $2
       union all
       select 'tds', d.name, d.tan, '194-O', p.date::text, p.gross_paise, p.tds_paise, p.number from ota_payout p join debtor d on d.id = p.debtor_id where p.tds_paise > 0 and p.date between $1 and $2
       union all
       select 'tcs', 'TASMAC', null, '206C(1)', p.business_date::text, p.value_paise, p.tcs_paise, p.invoice_no from tasmac_purchase p where coalesce(p.tcs_paise, 0) > 0 and p.business_date between $1 and $2
       union all
       select 'gst_tcs', d.name, d.gstin, '52', p.date::text, p.gross_paise, p.gst_tcs_paise, p.number from ota_payout p join debtor d on d.id = p.debtor_id where p.gst_tcs_paise > 0 and p.date between $1 and $2
       order by 5`, [from, to])
    return rows.map((r) => ({ ...r, base: Number(r.base), tax: Number(r.tax), quarter: quarterOf(r.date) }))
  }
  /** When a quarter's credits should be in Form 26AS: the deductors' returns are due by then (plus a fortnight). */
  const visibleBy = (fy: string, q: number) => addDays(q === 1 ? `20${fy.slice(2, 4)}-07-31` : q === 2 ? `20${fy.slice(2, 4)}-10-31` : q === 3 ? `20${fy.slice(5, 7)}-01-31` : `20${fy.slice(5, 7)}-05-31`, 15)

  app.get('/api/tax-credits', async (req) => {
    await need(req, 'accounts.view', 'receivables.view')
    const today = await businessDate(db)
    const fy = (req.query as { fy?: string }).fy ?? financialYear(today)
    if (!/^\d{4}-\d{2}$/.test(fy)) throw new HttpError(400, 'Enter the financial year as 2026-27.')
    const exp = await expected(db, fy)
    const lines = (await db.query<{ id: string; kind: string; deductor: string; tan: string | null; section: string | null; date: string; quarter: number; paid_paise: string; tax_paise: string }>(
      'select id, kind, deductor, tan, section, date::text as date, quarter, paid_paise, tax_paise from form26as_line where fy = $1 order by 6', [fy])).map((l) => ({ ...l, tax_paise: Number(l.tax_paise), paid_paise: Number(l.paid_paise) }))
    // One row per deductor, kind and quarter: the deductor known by TAN where accounts entered it, else by name.
    /** 194-O and 194O are one section. */
    const sec = (x: string) => x.replace(/[\s-]/g, '').toUpperCase()
    const key = (kind: string, party: string, tan: string | null) => `${kind}|${tan ? `T:${tan}` : `N:${nameKey(party)}`}`
    const groups = new Map<string, { kind: string; party: string; tan: string | null; quarter: number; sections: Set<string>; expectedPaise: number; in26asPaise: number; entries: string[] }>()
    const group = (k: string, kind: string, party: string, tan: string | null, q: number) => {
      const id = `${k}|${q}`
      if (!groups.has(id)) groups.set(id, { kind, party, tan, quarter: q, sections: new Set(), expectedPaise: 0, in26asPaise: 0, entries: [] })
      return groups.get(id)!
    }
    for (const e of exp.filter((x) => x.kind !== 'gst_tcs')) { const g = group(key(e.kind, e.party, e.tan), e.kind, e.party, e.tan, e.quarter); g.expectedPaise += e.tax; if (e.section) g.sections.add(sec(e.section)); g.entries.push(e.ref) }
    const unknown: typeof lines = []
    for (const l of lines) {
      // TASMAC is known by name: it collects TCS on every liquor purchase.
      const byTan = l.tan ? [...groups.values()].find((g) => g.tan === l.tan && g.kind === l.kind) : null
      const byName = [...groups.values()].find((g) => g.kind === l.kind && (nameKey(g.party) === nameKey(l.deductor) || (g.party === 'TASMAC' && /tasmac|tamil ?nadu state marketing/i.test(l.deductor))))
      const g0 = byTan ?? byName
      if (!g0) { unknown.push(l); continue }
      const g = group(key(g0.kind, g0.party, g0.tan), g0.kind, g0.party, g0.tan, l.quarter)
      g.in26asPaise += l.tax_paise
      if (l.section) g.sections.add(sec(l.section))
    }
    const rows = [...groups.values()].map((g) => {
      const diff = g.in26asPaise - g.expectedPaise
      const status = Math.abs(diff) <= 100 ? 'matched' : g.expectedPaise === 0 ? 'not_in_books' : g.in26asPaise === 0 ? 'missing' : diff < 0 ? 'short' : 'more'
      return { ...g, sections: [...g.sections], differencePaise: diff, status, followUp: (status === 'missing' || status === 'short') && today > visibleBy(fy, g.quarter) }
    }).sort((a, b) => a.quarter - b.quarter || a.party.localeCompare(b.party))
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0)
    return {
      fy, rows, notInBooks: unknown, gstTcs: exp.filter((x) => x.kind === 'gst_tcs'),
      totals: { expectedPaise: sum((r) => r.expectedPaise), in26asPaise: sum((r) => r.in26asPaise), followUp: rows.filter((r) => r.followUp).length },
      imports: await db.query('select i.*, u.name as imported_by_name from form26as_import i join app_user u on u.id = i.imported_by where i.fy = $1 order by i.imported_at desc', [fy]),
    }
  })

  app.post('/api/form26as/import', async (req, reply) => {
    const who = await need(req, 'accounts.post', 'receivables.manage')
    const b = (req.body ?? {}) as { csv?: string; fy?: string; fileName?: string }
    if (!b.csv?.trim()) throw new HttpError(400, 'Choose the Form 26AS file (CSV or the TRACES text file).')
    if (!/^\d{4}-\d{2}$/.test(b.fy ?? '')) throw new HttpError(400, 'Which financial year is it for (e.g. 2026-27)?')
    let rows: ReturnType<typeof parse26as>
    try { rows = parse26as(b.csv) } catch (e) { throw new HttpError(400, (e as Error).message) }
    if (!rows.length) throw new HttpError(400, 'No credits found in the file.')
    return db.tx(async (t) => {
      const id = newId('AS')
      await t.query('insert into form26as_import (id, fy, file_name, lines, imported_by, imported_at) values ($1,$2,$3,0,$4,$5)', [id, b.fy, b.fileName ?? null, who.userId, now()])
      const seen = new Map<string, number>()
      let added = 0
      for (const r of rows) {
        const k0 = [b.fy, r.kind, r.tan ?? '', r.deductor, r.section ?? '', r.date, r.paidPaise, r.taxPaise].join('|')
        const k = (seen.get(k0) ?? 0) + 1; seen.set(k0, k)
        const res = await t.query(`insert into form26as_line (id, import_id, fy, kind, deductor, tan, section, date, quarter, paid_paise, tax_paise, fingerprint) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            on conflict (fingerprint) do nothing returning id`, [newId('AL'), id, b.fy, r.kind, r.deductor, r.tan, r.section, r.date, quarterOf(r.date), r.paidPaise, r.taxPaise, createHash('sha1').update(`${k0}#${k}`).digest('hex')])
        if (res.length) added++
      }
      await t.query('update form26as_import set lines = $2 where id = $1', [id, added])
      await appendAudit(t, { actor: who, action: 'form26as.import', entity: { type: 'form26as_import', id }, after: { fy: b.fy, file: b.fileName ?? null, added, duplicates: rows.length - added } }, now())
      return reply.status(201).send({ id, added, duplicates: rows.length - added })
    })
  })
}
