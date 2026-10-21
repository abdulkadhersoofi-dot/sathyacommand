import type { FastifyInstance, FastifyRequest } from 'fastify'
import { financialYear, rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { monthEnd } from '../gst-returns'
import { LedgerError, postPending, postVoucher } from '../ledger'
import { requireCaller } from './auth'

// TDS the resort deducts, from deduction to certificate: lower-deduction certificates, deposit by challan by
// the 7th of the next month (30 April for March) with interest when late (1.5% a month or part, from the date
// of deduction), the quarterly statement (26Q) data with its late fee (₹200 a day), statements for vendors;
// advance tax against the year's estimate; and a calendar of the tax dates ahead.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const FY = /^\d{4}-\d{2}$/
const r = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** 26Q section codes (the statement utility's), by the nature of payment. CA check: the codes under the Income-tax Act, 2025. */
const SECTION_CODE: Record<string, string> = {
  contractor: '94C', professional_fees: '94J-B', technical_services: '94J-A', rent_land_building_furniture: '4IB', rent_plant_machinery: '4IA',
  commission_brokerage: '94H', purchase_of_goods: '94Q', partner_payments: '94T',
}
const fyRange = (fy: string) => ({ from: `${fy.slice(0, 4)}-04-01`, to: `${Number(fy.slice(0, 4)) + 1}-03-31` })
/** Deposit due: the 7th of the next month; for tax deducted in March, 30 April. */
export const depositDue = (month: string) => (month.endsWith('-03') ? `${month.slice(0, 4)}-04-30` : `${addDays(monthEnd(month), 1).slice(0, 7)}-07`)
/** 26Q due: 31 July, 31 October, 31 January, 31 May. */
export const statementDue = (fy: string, q: number) => {
  const y = Number(fy.slice(0, 4))
  return q === 1 ? `${y}-07-31` : q === 2 ? `${y}-10-31` : q === 3 ? `${y + 1}-01-31` : `${y + 1}-05-31`
}
/** Months, or parts of months, from the deduction to the deposit (counted by calendar month, as TRACES does). */
const monthsOrPart = (from: string, to: string) => (Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7))) - (Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7))) + 1
const quarterMonths = (fy: string, q: number) => {
  const y = Number(fy.slice(0, 4))
  const ms = q === 1 ? [4, 5, 6] : q === 2 ? [7, 8, 9] : q === 3 ? [10, 11, 12] : [1, 2, 3]
  return ms.map((m) => `${q === 4 ? y + 1 : y}-${String(m).padStart(2, '0')}`)
}

export function tdsRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const VIEW = ['tds.manage', 'payables.view', 'accounts.view']

  /** Interest for depositing late: 1.5% a month or part, on each deduction, from its date to the deposit (or today). */
  async function interestFor(t: Db, month: string, paidOn: string) {
    if (paidOn <= depositDue(month)) return 0
    const es = await t.query<{ deducted_on: string; tds_paise: string }>(`select deducted_on::text, tds_paise from tds_entry where to_char(deducted_on, 'YYYY-MM') = $1 and challan_id is null`, [month])
    return es.reduce((a, e) => a + Math.round(Number(e.tds_paise) * 0.015 * monthsOrPart(e.deducted_on, paidOn)), 0)
  }

  // ---------- lower-deduction certificates ----------
  app.get('/api/ldc', async (req) => {
    await need(req, ...VIEW, 'vendors.manage')
    return db.query(`select l.*, l.valid_from::text, l.valid_to::text, v.name as vendor, coalesce((select sum(e.base_paise) from tds_entry e where e.ldc_id = l.id), 0) as used_paise
        from ldc l join vendor v on v.id = l.vendor_id order by l.valid_to desc, v.name`)
  })

  app.post('/api/ldc', async (req, reply) => {
    const who = await need(req, 'tds.manage', 'vendors.manage')
    const b = (req.body ?? {}) as { vendorId?: string; certNo?: string; section?: string; rate?: number; limit?: number; validFrom?: string; validTo?: string }
    if (!b.certNo?.trim()) throw new HttpError(400, 'Enter the certificate number (from TRACES).')
    if (!/^19[0-9][A-Z-]*/.test((b.section ?? '').trim().toUpperCase())) throw new HttpError(400, 'The section it is for (194C, 194J…).')
    if (!(Number(b.rate) >= 0 && Number(b.rate) <= 30)) throw new HttpError(400, 'Enter the lower rate on the certificate (%).')
    if (!(Number(b.limit) > 0)) throw new HttpError(400, 'Enter the amount the certificate covers (₹).')
    if (!DATE.test(b.validFrom ?? '') || !DATE.test(b.validTo ?? '') || b.validTo! < b.validFrom!) throw new HttpError(400, 'Valid from and to (YYYY-MM-DD).')
    return db.tx(async (t) => {
      const [v] = await t.query<{ name: string; pan: string | null }>('select name, pan from vendor where id = $1', [b.vendorId])
      if (!v) throw new HttpError(404, 'No such vendor.')
      if (!v.pan) throw new HttpError(409, `${v.name} has no PAN: a certificate needs it.`)
      const id = newId('LDC')
      await t.query('insert into ldc (id, vendor_id, cert_no, section, rate, limit_paise, valid_from, valid_to, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, b.vendorId, b.certNo!.trim().toUpperCase(), b.section!.trim().toUpperCase(), Number(b.rate), rupees(Number(b.limit)), b.validFrom, b.validTo, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'tds.ldc', entity: { type: 'ldc', id }, after: { vendor: v.name, certNo: b.certNo, section: b.section, rate: b.rate, limit: b.limit } }, now())
      return reply.status(201).send({ id })
    })
  })

  // ---------- deposits ----------
  app.get('/api/tds/deposits', async (req) => {
    await need(req, ...VIEW)
    const today = await businessDate(db)
    const fy = (req.query as { fy?: string }).fy ?? financialYear(today)
    if (!FY.test(fy)) throw new HttpError(400, 'Enter the year as 2026-27.')
    const { from, to } = fyRange(fy)
    const rows = await db.query<{ month: string; deducted: string; deposited: string; open: string; entries: number }>(
      `select to_char(deducted_on, 'YYYY-MM') as month, sum(tds_paise) as deducted, coalesce(sum(tds_paise) filter (where challan_id is not null), 0) as deposited,
              coalesce(sum(tds_paise) filter (where challan_id is null), 0) as open, count(*)::int as entries
         from tds_entry where deducted_on between $1 and $2 group by 1 order by 1`, [from, to])
    const challans = await db.query<{ month: string }>(`select c.*, c.paid_on::text, v.number as voucher from tax_challan c left join voucher v on v.id = c.voucher_id where c.kind = 'tds' and c.fy = $1 order by c.paid_on`, [fy])
    const out = []
    for (const m of rows) {
      const due = depositDue(m.month), open = Number(m.open)
      const mine = challans.filter((c) => c.month === m.month)
      const late = mine.some((c) => (c as unknown as { paid_on: string }).paid_on > due)
      out.push({ month: m.month, entries: m.entries, deductedPaise: Number(m.deducted), depositedPaise: Number(m.deposited), openPaise: open, due,
        status: open === 0 ? (late ? 'paid_late' : 'paid') : today > due ? 'overdue' : 'due', interestNowPaise: open && today > due ? await interestFor(db, m.month, today) : 0, challans: mine })
    }
    return { fy, months: out }
  })

  app.post('/api/tds/challans', async (req, reply) => {
    const who = await need(req, 'tds.manage')
    const b = (req.body ?? {}) as { month?: string; bsrCode?: string; challanNo?: string; paidOn?: string; tax?: number; interest?: number; lateFee?: number; bankAccountId?: string }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.month ?? '')) throw new HttpError(400, 'Which month\'s deductions it deposits (YYYY-MM).')
    if (!/^\d{7}$/.test(b.bsrCode ?? '')) throw new HttpError(400, 'Enter the bank\'s BSR code: 7 digits, on the challan.')
    if (!/^\d{5}$/.test(b.challanNo ?? '')) throw new HttpError(400, 'Enter the challan serial number: 5 digits.')
    if (!DATE.test(b.paidOn ?? '')) throw new HttpError(400, 'The date it was paid.')
    await postPending(db, now())
    return db.tx(async (t) => {
      if (b.paidOn! > await businessDate(t)) throw new HttpError(400, 'The date it was paid: today or earlier.')
      const entries = await t.query<{ id: string; tds_paise: string }>(`select id, tds_paise from tds_entry where to_char(deducted_on, 'YYYY-MM') = $1 and challan_id is null for update`, [b.month])
      if (!entries.length) throw new HttpError(409, `Nothing deducted in ${b.month} is waiting to be deposited.`)
      const tax = entries.reduce((a, e) => a + Number(e.tds_paise), 0)
      if (b.tax != null && rupees(b.tax) !== tax) throw new HttpError(400, `${b.month}'s deductions come to ${r(tax)}, not ${r(rupees(b.tax))}.`)
      const interest = b.interest != null ? rupees(b.interest) : await interestFor(t, b.month!, b.paidOn!)
      const fee = rupees(Number(b.lateFee ?? 0))
      const [ba] = b.bankAccountId ? await t.query<{ id: string; account_code: string }>('select id, account_code from bank_account where id = $1', [b.bankAccountId])
        : await t.query<{ id: string; account_code: string }>('select id, account_code from bank_account where is_default and active')
      const id = newId('CH'), fy = financialYear(`${b.month}-01`)
      await t.query(`insert into tax_challan (id, kind, fy, month, bsr_code, challan_no, paid_on, tax_paise, interest_paise, late_fee_paise, total_paise, bank_account_id, by_user, at) values ($1,'tds',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, fy, b.month, b.bsrCode, b.challanNo, b.paidOn, tax, interest, fee, tax + interest + fee, ba?.id ?? null, who.userId, now()])
      await t.query('update tds_entry set challan_id = $2 where id = any($1)', [entries.map((e) => e.id), id])
      let v: { id: string } | null
      try {
        v = await postVoucher(t, { kind: 'payment', date: b.paidOn!, narration: `TDS for ${b.month} deposited (challan ${b.bsrCode}/${b.challanNo})`, source: { type: 'tax_challan', id }, userId: who.userId, now: now(), lines: [
          { code: '2300', amount: tax, ref: b.month }, { code: '6095', amount: interest + fee }, { code: ba?.account_code ?? '1200', amount: -(tax + interest + fee), ref: `${b.bsrCode}/${b.challanNo}` }] })
      } catch (e) { if (e instanceof LedgerError) throw new HttpError(e.statusCode, e.message); throw e }
      if (v) await t.query('update tax_challan set voucher_id = $2 where id = $1', [id, v.id])
      await appendAudit(t, { actor: who, action: 'tds.deposit', entity: { type: 'tax_challan', id }, amount: tax + interest + fee, after: { month: b.month, challan: `${b.bsrCode}/${b.paidOn}/${b.challanNo}`, tax, interest, entries: entries.length } }, now())
      return reply.status(201).send({ id, taxPaise: tax, interestPaise: interest, totalPaise: tax + interest + fee, late: b.paidOn! > depositDue(b.month!) })
    })
  })

  // ---------- quarterly statement (26Q) ----------
  async function statement26q(t: Db, fy: string, q: number) {
    const months = quarterMonths(fy, q)
    const [p] = await t.query<{ legal_name: string | null; name: string; gstin: string | null; address: string | null; city: string | null; pin: string | null; tan: string | null; tds_responsible: string | null; tds_responsible_designation: string | null }>('select * from property limit 1')
    const rows = await t.query<{ id: string; vendor: string; payee_type: string; pan: string | null; code: string; section: string; deducted_on: string; base_paise: string; rate: string; tds_paise: string; reason_code: string | null; challan_id: string | null; bsr_code: string | null; paid_on: string | null; challan_no: string | null; cert_no: string | null }>(
      `select e.id, v.name as vendor, v.payee_type, e.pan, e.code, e.section, e.deducted_on::text, e.base_paise, e.rate, e.tds_paise, e.reason_code, e.challan_id, c.bsr_code, c.paid_on::text, c.challan_no, l.cert_no
         from tds_entry e join vendor v on v.id = e.vendor_id left join tax_challan c on c.id = e.challan_id left join ldc l on l.id = e.ldc_id
        where to_char(e.deducted_on, 'YYYY-MM') = any($1) order by e.deducted_on, v.name`, [months])
    const challans = await t.query<{ id: string; month: string; bsr_code: string; paid_on: string; challan_no: string; tax_paise: string; interest_paise: string; late_fee_paise: string; total_paise: string }>(
      `select id, month, bsr_code, paid_on::text, challan_no, tax_paise, interest_paise, late_fee_paise, total_paise from tax_challan where kind = 'tds' and month = any($1) order by paid_on`, [months])
    const deductees = rows.map((e, i) => ({
      sr: i + 1, name: e.vendor, pan: e.pan ?? 'PANNOTAVBL', deducteeCode: e.payee_type === 'company' ? '1' : '2', sectionCode: SECTION_CODE[e.code] ?? e.section, section: e.section,
      paidOn: e.deducted_on, amountPaise: Number(e.base_paise), tdsPaise: Number(e.tds_paise), deductedOn: e.deducted_on, rate: Number(e.rate),
      reason: e.reason_code, certificate: e.cert_no, challan: e.challan_id ? `${e.bsr_code}/${e.paid_on}/${e.challan_no}` : null,
    }))
    const problems: string[] = []
    if (!p.tan) problems.push('The resort\'s TAN is not set.')
    if (!p.tds_responsible) problems.push('The person responsible for deducting tax is not named.')
    const undeposited = deductees.filter((d) => !d.challan)
    if (undeposited.length) problems.push(`${undeposited.length} deduction${undeposited.length > 1 ? 's are' : ' is'} not yet deposited by challan.`)
    const noPan = deductees.filter((d) => d.pan === 'PANNOTAVBL')
    if (noPan.length) problems.push(`${noPan.length} deductee${noPan.length > 1 ? 's have' : ' has'} no PAN (deducted at the higher rate).`)
    const [filedRow] = await t.query<{ token_no: string; filed_on: string }>(`select token_no, filed_on::text from tds_return where fy = $1 and quarter = $2 and form = '26Q'`, [fy, q])
    const due = statementDue(fy, q), today = await businessDate(t)
    const totalTds = deductees.reduce((a, d) => a + d.tdsPaise, 0)
    const until = filedRow?.filed_on ?? today
    const daysLate = until > due ? Math.round((Date.parse(until) - Date.parse(due)) / 86_400_000) : 0
    return {
      fy, quarter: q, months, due, filed: filedRow ?? null,
      deductor: { tan: p.tan, pan: p.gstin ? p.gstin.slice(2, 12) : null, name: p.legal_name ?? p.name, address: [p.address, p.city, p.pin].filter(Boolean).join(', '), responsible: p.tds_responsible, designation: p.tds_responsible_designation },
      challans: challans.map((c) => ({ ...c, tax_paise: Number(c.tax_paise), interest_paise: Number(c.interest_paise), late_fee_paise: Number(c.late_fee_paise), total_paise: Number(c.total_paise) })),
      deductees, totals: { amountPaise: deductees.reduce((a, d) => a + d.amountPaise, 0), tdsPaise: totalTds, deductees: new Set(deductees.map((d) => d.pan + d.name)).size },
      // Late filing fee (234E): ₹200 a day until it is filed, no more than the tax in the statement.
      late: { daysLate, feePaise: Math.min(daysLate * 20000, totalTds) }, problems,
    }
  }
  const fyQ = (req: FastifyRequest) => {
    const q = req.query as { fy?: string; quarter?: string }
    const fy = q.fy ?? '', quarter = Number(q.quarter)
    if (!FY.test(fy) || !(quarter >= 1 && quarter <= 4)) throw new HttpError(400, 'fy (2026-27) and quarter (1–4).')
    return { fy, quarter }
  }

  app.get('/api/tds/26q', async (req) => {
    await need(req, ...VIEW)
    const { fy, quarter } = fyQ(req)
    return statement26q(db, fy, quarter)
  })

  // The deductee details as the statement utility (RPU) lists them, for the CA to bring in.
  app.get('/api/tds/26q.csv', async (req, reply) => {
    await need(req, ...VIEW)
    const { fy, quarter } = fyQ(req)
    const s = await statement26q(db, fy, quarter)
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
    const lines = [
      ['Sr', 'Challan (BSR / date / serial)', 'Section code', 'Deductee code', 'PAN', 'Name', 'Date of payment / credit', 'Amount paid / credited', 'TDS', 'Surcharge', 'Cess', 'Total tax deducted', 'Total tax deposited', 'Date of deduction', 'Rate', 'Reason for lower / higher deduction', 'Certificate (197)'].map(q).join(','),
      ...s.deductees.map((d) => [d.sr, d.challan ?? '', d.sectionCode, d.deducteeCode, d.pan, d.name, dmy(d.paidOn), (d.amountPaise / 100).toFixed(2), (d.tdsPaise / 100).toFixed(2), '0.00', '0.00', (d.tdsPaise / 100).toFixed(2), (d.challan ? d.tdsPaise / 100 : 0).toFixed(2), dmy(d.deductedOn), d.rate.toFixed(2), d.reason ?? '', d.certificate ?? ''].map(q).join(',')),
    ]
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="26Q_${fy}_Q${quarter}.csv"`).send(lines.join('\r\n'))
  })

  app.post('/api/tds/returns', async (req, reply) => {
    const who = await need(req, 'tds.manage')
    const b = (req.body ?? {}) as { fy?: string; quarter?: number; tokenNo?: string; filedOn?: string }
    if (!FY.test(b.fy ?? '') || !(Number(b.quarter) >= 1 && Number(b.quarter) <= 4)) throw new HttpError(400, 'fy (2026-27) and quarter (1–4).')
    if (!/^\d{15}$/.test(b.tokenNo?.trim() ?? '')) throw new HttpError(400, 'Enter the 15-digit token number of the provisional receipt.')
    return db.tx(async (t) => {
      const today = await businessDate(t)
      const filedOn = b.filedOn ?? today
      if (!DATE.test(filedOn) || filedOn > today) throw new HttpError(400, 'Enter the filing date: today or earlier.')
      const s = await statement26q(t, b.fy!, Number(b.quarter))
      if (s.filed) throw new HttpError(409, `26Q for ${b.fy} Q${b.quarter} is already filed.`)
      if (s.deductees.some((d) => !d.challan)) throw new HttpError(409, 'Deposit every deduction of the quarter by challan before the statement is filed.')
      const daysLate = filedOn > s.due ? Math.round((Date.parse(filedOn) - Date.parse(s.due)) / 86_400_000) : 0
      const fee = Math.min(daysLate * 20000, s.totals.tdsPaise)
      const id = newId('TR')
      await t.query('insert into tds_return (id, fy, quarter, form, token_no, filed_on, late_fee_paise, figures, filed_by, filed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, b.fy, b.quarter, '26Q', b.tokenNo!.trim(), filedOn, fee, JSON.stringify({ ...s, filed: undefined }), who.userId, now()])
      await appendAudit(t, { actor: who, action: 'tds.return_filed', entity: { type: 'tds_return', id }, amount: s.totals.tdsPaise, after: { fy: b.fy, quarter: b.quarter, token: b.tokenNo, lateFee: fee } }, now())
      return reply.status(201).send({ id, lateFeePaise: fee })
    })
  })

  // A statement for the vendor of the tax deducted from them in a quarter (Form 16A itself comes from TRACES).
  app.get('/api/tds/statement/:vendorId', async (req, reply) => {
    await need(req, ...VIEW)
    const { fy, quarter } = fyQ(req)
    const s = await statement26q(db, fy, quarter)
    const [v] = await db.query<{ name: string; pan: string | null; address: string | null }>('select name, pan, address from vendor where id = $1', [(req.params as { vendorId: string }).vendorId])
    if (!v) throw new HttpError(404, 'No such vendor.')
    const mine = s.deductees.filter((d) => d.name === v.name)
    const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>TDS statement · ${esc(v.name)}</title><style>body{font:12px system-ui;margin:24px;color:#111}h1{font-size:18px;margin:0 0 6px}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left}.n{text-align:right}.muted{color:#555}</style></head><body>
      <h1>Statement of tax deducted at source</h1><div>${esc(s.deductor.name)} · TAN ${esc(s.deductor.tan ?? '—')}</div><div class="muted">${esc(s.deductor.address)}</div>
      <p><b>${esc(v.name)}</b> · PAN ${esc(v.pan ?? 'not given')} · ${esc(fy)} quarter ${quarter} (${esc(s.months[0])} to ${esc(s.months[2])})</p>
      <table><tr><th>Date</th><th>Section</th><th class="n">Amount paid</th><th class="n">Rate</th><th class="n">TDS</th><th>Challan (BSR / date / serial)</th></tr>
      ${mine.map((d) => `<tr><td>${esc(d.deductedOn)}</td><td>${esc(d.section)}</td><td class="n">${r(d.amountPaise)}</td><td class="n">${d.rate}%</td><td class="n">${r(d.tdsPaise)}</td><td>${esc(d.challan ?? 'to be deposited')}</td></tr>`).join('')}
      <tr><td colspan="4"><b>Total</b></td><td class="n"><b>${r(mine.reduce((a, d) => a + d.tdsPaise, 0))}</b></td><td></td></tr></table>
      <p class="muted">Form 16A for the quarter will be issued from TRACES after the quarterly statement is filed. The tax appears in your Form 26AS against your PAN.</p>
      <script>window.onload=()=>window.print()</script></body></html>`
    return reply.type('text/html; charset=utf-8').send(html)
  })

  app.patch('/api/tds/deductor', async (req) => {
    const who = await need(req, 'tds.manage')
    const b = (req.body ?? {}) as { tan?: string; responsible?: string; designation?: string }
    const tan = b.tan?.trim().toUpperCase()
    if (tan !== undefined && tan && !/^[A-Z]{4}\d{5}[A-Z]$/.test(tan)) throw new HttpError(400, 'TAN: 4 letters, 5 digits, a letter (e.g. CHES12345A).')
    await db.query('update property set tan = coalesce($1, tan), tds_responsible = coalesce($2, tds_responsible), tds_responsible_designation = coalesce($3, tds_responsible_designation)',
      [tan || null, b.responsible?.trim() || null, b.designation?.trim() || null])
    await appendAudit(db, { actor: who, action: 'tds.deductor', entity: { type: 'property', id: 'sathya' }, after: b }, now())
    return { ok: true }
  })

  // ---------- advance tax ----------
  const INSTALMENTS: [string, number][] = [['06-15', 15], ['09-15', 45], ['12-15', 75], ['03-15', 100]]
  async function advance(t: Db, fy: string) {
    const [e] = await t.query<{ estimated_tax_paise: string; note: string | null }>('select estimated_tax_paise, note from tax_estimate where fy = $1', [fy])
    const paid = await t.query<{ paid_on: string; total_paise: string; bsr_code: string; challan_no: string }>(`select paid_on::text, total_paise, bsr_code, challan_no from tax_challan where kind = 'advance_tax' and fy = $1 order by paid_on`, [fy])
    const est = Number(e?.estimated_tax_paise ?? 0), y = Number(fy.slice(0, 4))
    const instalments = INSTALMENTS.map(([md, pct]) => {
      const due = `${md.startsWith('03') ? y + 1 : y}-${md}`
      const required = Math.round((est * pct) / 100), paidBy = paid.filter((p) => p.paid_on <= due).reduce((a, p) => a + Number(p.total_paise), 0)
      return { due, percent: pct, requiredPaise: required, paidByThenPaise: paidBy, shortfallPaise: Math.max(0, required - paidBy) }
    })
    return { fy, estimatePaise: est, note: e?.note ?? null, instalments, payments: paid, paidPaise: paid.reduce((a, p) => a + Number(p.total_paise), 0) }
  }

  app.get('/api/tax/advance', async (req) => {
    await need(req, ...VIEW)
    const fy = (req.query as { fy?: string }).fy ?? financialYear(await businessDate(db))
    return advance(db, fy)
  })

  app.put('/api/tax/estimate', async (req) => {
    const who = await need(req, 'tds.manage')
    const b = (req.body ?? {}) as { fy?: string; estimatedTax?: number; note?: string }
    if (!FY.test(b.fy ?? '') || !(Number(b.estimatedTax) >= 0)) throw new HttpError(400, 'fy and the estimated tax for the year (₹).')
    await db.query(`insert into tax_estimate (fy, estimated_tax_paise, note, by_user, at) values ($1,$2,$3,$4,$5) on conflict (fy) do update set estimated_tax_paise = excluded.estimated_tax_paise, note = excluded.note, by_user = excluded.by_user, at = excluded.at`,
      [b.fy, rupees(Number(b.estimatedTax)), b.note?.trim() || null, who.userId, now()])
    await appendAudit(db, { actor: who, action: 'tax.estimate', entity: { type: 'tax_estimate', id: b.fy! }, amount: rupees(Number(b.estimatedTax)), note: b.note }, now())
    return advance(db, b.fy!)
  })

  app.post('/api/tax/advance', async (req, reply) => {
    const who = await need(req, 'tds.manage')
    const b = (req.body ?? {}) as { amount?: number; bsrCode?: string; challanNo?: string; paidOn?: string; bankAccountId?: string }
    if (!(Number(b.amount) > 0)) throw new HttpError(400, 'How much was paid?')
    if (!/^\d{7}$/.test(b.bsrCode ?? '') || !/^\d{5}$/.test(b.challanNo ?? '') || !DATE.test(b.paidOn ?? '')) throw new HttpError(400, 'Enter the BSR code (7 digits), challan serial (5 digits) and date paid.')
    const amount = rupees(Number(b.amount))
    return db.tx(async (t) => {
      if (b.paidOn! > await businessDate(t)) throw new HttpError(400, 'The date it was paid: today or earlier.')
      const [ba] = b.bankAccountId ? await t.query<{ id: string; account_code: string }>('select id, account_code from bank_account where id = $1', [b.bankAccountId])
        : await t.query<{ id: string; account_code: string }>('select id, account_code from bank_account where is_default and active')
      const id = newId('CH'), fy = financialYear(b.paidOn!)
      await t.query(`insert into tax_challan (id, kind, fy, bsr_code, challan_no, paid_on, tax_paise, total_paise, bank_account_id, by_user, at) values ($1,'advance_tax',$2,$3,$4,$5,$6,$6,$7,$8,$9)`,
        [id, fy, b.bsrCode, b.challanNo, b.paidOn, amount, ba?.id ?? null, who.userId, now()])
      let v: { id: string } | null
      try {
        v = await postVoucher(t, { kind: 'payment', date: b.paidOn!, narration: `Advance income tax ${fy} (challan ${b.bsrCode}/${b.challanNo})`, source: { type: 'tax_challan', id }, userId: who.userId, now: now(),
          lines: [{ code: '1540', amount, ref: fy }, { code: ba?.account_code ?? '1200', amount: -amount, ref: `${b.bsrCode}/${b.challanNo}` }] })
      } catch (e) { if (e instanceof LedgerError) throw new HttpError(e.statusCode, e.message); throw e }
      if (v) await t.query('update tax_challan set voucher_id = $2 where id = $1', [id, v.id])
      await appendAudit(t, { actor: who, action: 'tax.advance_paid', entity: { type: 'tax_challan', id }, amount, after: { fy, challan: `${b.bsrCode}/${b.challanNo}` } }, now())
      return reply.status(201).send({ id })
    })
  })

  // ---------- the tax calendar ----------
  /** What falls due in the coming weeks (and anything overdue): TDS deposits and statements, GST returns, advance tax. */
  app.get('/api/tax/calendar', async (req) => {
    await need(req, ...VIEW, 'gst.view')
    const today = await businessDate(db)
    const horizon = addDays(today, Number((req.query as { days?: string }).days ?? 60))
    const items: { due: string; what: string; amountPaise: number | null; status: 'done' | 'due' | 'overdue' }[] = []
    const st = (done: boolean, due: string) => (done ? 'done' as const : due < today ? 'overdue' as const : 'due' as const)
    // TDS deposits of the last few months and this one.
    for (let k = -3; k <= 1; k++) {
      const m = addDays(`${today.slice(0, 7)}-15`, k * 30).slice(0, 7)
      const [x] = await db.query<{ open: string | null; total: string | null }>(`select sum(tds_paise) filter (where challan_id is null) as open, sum(tds_paise) as total from tds_entry where to_char(deducted_on, 'YYYY-MM') = $1`, [m])
      if (Number(x.total ?? 0)) items.push({ due: depositDue(m), what: `TDS deducted in ${m}: deposit (challan 281)`, amountPaise: Number(x.open ?? 0) || Number(x.total), status: st(!Number(x.open ?? 0), depositDue(m)) })
    }
    // 26Q for the last and the current quarter.
    const fy = financialYear(today)
    for (const [f, q] of [[fy, 1], [fy, 2], [fy, 3], [fy, 4], [`${Number(fy.slice(0, 4)) - 1}-${fy.slice(2, 4)}`, 4]] as [string, number][]) {
      const due = statementDue(f, q)
      if (due < addDays(today, -120) || due > horizon) continue
      // Only quarters the books have deductions for (not the months before the system was in use).
      const [any] = await db.query(`select 1 from tds_entry where fy = $1 and quarter = $2 limit 1`, [f, q])
      if (!any) continue
      const [filedRow] = await db.query(`select 1 from tds_return where fy = $1 and quarter = $2`, [f, q])
      items.push({ due, what: `TDS statement 26Q, ${f} quarter ${q}`, amountPaise: null, status: st(!!filedRow, due) })
    }
    // GST: GSTR-1 by the 11th and GSTR-3B by the 20th of the next month.
    for (let k = -2; k <= 0; k++) {
      const p = addDays(`${today.slice(0, 7)}-15`, k * 30 - 30).slice(0, 7)
      const nxt = addDays(monthEnd(p), 1).slice(0, 7)
      const [any] = await db.query(`select 1 from tax_document where to_char(issue_date, 'YYYY-MM') = $1 union all select 1 from vat_invoice where to_char(issue_date, 'YYYY-MM') = $1 limit 1`, [p])
      if (!any) continue
      const filedForms = (await db.query<{ form: string }>('select form from gst_return where period = $1', [p])).map((x) => x.form)
      items.push({ due: `${nxt}-11`, what: `GSTR-1 for ${p}`, amountPaise: null, status: st(filedForms.includes('GSTR1'), `${nxt}-11`) })
      items.push({ due: `${nxt}-20`, what: `GSTR-3B for ${p} (and the GST to pay)`, amountPaise: null, status: st(filedForms.includes('GSTR3B'), `${nxt}-20`) })
    }
    // Advance tax.
    const a = await advance(db, fy)
    for (const i of a.instalments) items.push({ due: i.due, what: `Advance tax: ${i.percent}% of the year's estimate`, amountPaise: i.shortfallPaise, status: st(a.estimatePaise > 0 && i.shortfallPaise === 0, i.due) })
    return items.filter((i) => i.due <= horizon && (i.status !== 'done' || i.due >= addDays(today, -31))).sort((x, y) => x.due.localeCompare(y.due))
  })
}
