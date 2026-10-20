import type { Db } from './db'
import { addDays } from './eng-core'

// GST return data, from the documents the resort issued and received. GSTR-1: outward supplies by table (B2B,
// B2C summary, credit notes, advances and their adjustment, HSN summary, documents issued, non-GST supplies).
// GSTR-3B: the month's tax, the input tax credit the portal allows (bills in GSTR-2B not rejected in IMS),
// reverse charge, the common-credit reversal for supplies that carry no credit, and the cash to pay.

export const monthEnd = (p: string) => addDays(addDays(`${p}-01`, 32).slice(0, 7) + '-01', -1)
const HOME = '33'
/** Supplies taxed without input tax credit: rooms up to ₹7,500 and restaurant service at 5%. CA check */
const NO_ITC_SAC = ['996311', '996331']
const SAC_DESC: Record<string, string> = { '996311': 'Room or unit accommodation services', '996331': 'Services provided by restaurants', '996334': 'Event catering services', '999794': 'Agreeing to do an act (damage recovery)' }

interface Line { description: string; sac: string | null; gstRate: number; taxable: number; cgst: number; sgst: number; total: number }
interface Doc { id: string; doc_type: string; number: string; issue_date: string; b2b: boolean; recipient: { name: string; gstin: string | null }; lines: Line[]; tax_summary: { rate: number; taxable: number; cgst: number; sgst: number }[]; taxable_paise: string; cgst_paise: string; sgst_paise: string; total_paise: string; irn_status: string; reservation_id: string | null; original_id: string | null; advance_adjusted_paise: string }
export interface RateRow { rate: number; taxable: number; cgst: number; sgst: number; igst: number }

const n = (v: unknown) => Number(v ?? 0)
function byRate(rows: { gstRate?: number; rate?: number; taxable: number; cgst: number; sgst: number }[], sign = 1, into = new Map<number, RateRow>()) {
  for (const r of rows) {
    const rate = Number(r.gstRate ?? r.rate ?? 0)
    const x = into.get(rate) ?? { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 }
    x.taxable += sign * r.taxable; x.cgst += sign * r.cgst; x.sgst += sign * r.sgst
    into.set(rate, x)
  }
  return into
}
const sumRows = (rs: RateRow[]) => rs.reduce((a, r) => ({ taxable: a.taxable + r.taxable, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst, igst: a.igst + r.igst }), { taxable: 0, cgst: 0, sgst: 0, igst: 0 })

export async function gstr1(t: Db, period: string) {
  const from = `${period}-01`, to = monthEnd(period)
  const docs = await t.query<Doc>(
    `select id, doc_type, number, issue_date::text, b2b, recipient, lines, tax_summary, taxable_paise, cgst_paise, sgst_paise, total_paise, irn_status, reservation_id, original_id, advance_adjusted_paise
       from tax_document where issue_date between $1 and $2 order by issue_date, number`, [from, to])
  const sales = docs.filter((d) => d.doc_type === 'invoice' || d.doc_type === 'fnb_invoice')
  const notes = docs.filter((d) => d.doc_type === 'credit_note')
  const isB2b = (d: Doc) => d.b2b && !!d.recipient?.gstin

  const b2b = sales.filter(isB2b).map((d) => ({ gstin: d.recipient.gstin!, name: d.recipient.name, number: d.number, date: d.issue_date, value: n(d.total_paise), pos: HOME,
    einvoiced: d.irn_status === 'generated', items: [...byRate(d.lines).values()] }))
  const originals = new Map((await t.query<{ id: string; number: string; issue_date: string }>('select id, number, issue_date::text from tax_document where id = any($1)', [notes.map((d) => d.original_id).filter(Boolean)])).map((o) => [o.id, o]))
  const cdnr = notes.filter(isB2b).map((d) => ({ gstin: d.recipient.gstin!, name: d.recipient.name, number: d.number, date: d.issue_date, value: n(d.total_paise), pos: HOME,
    original: originals.get(d.original_id ?? '')?.number ?? null, einvoiced: d.irn_status === 'generated', items: [...byRate(d.lines).values()] }))
  // Sales to consumers, one line per rate (always within Tamil Nadu: the place of supply is the resort); their credit notes come off.
  const b2csMap = byRate(sales.filter((d) => !isB2b(d)).flatMap((d) => d.lines))
  byRate(notes.filter((d) => !isB2b(d)).flatMap((d) => d.lines), -1, b2csMap)
  const b2cs = [...b2csMap.values()].filter((r) => r.taxable).sort((a, b) => a.rate - b.rate)

  // Advances: received this month for stays not invoiced this month (11A); received earlier and adjusted in this month's invoices (11B).
  const advDocs = docs.filter((d) => d.doc_type === 'receipt_voucher' || d.doc_type === 'refund_voucher')
  const invoicedNow = new Set(sales.filter((d) => d.doc_type === 'invoice').map((d) => d.reservation_id))
  const at = [...byRate(advDocs.filter((d) => !invoicedNow.has(d.reservation_id)).flatMap((d) => d.tax_summary.map((s) => ({ ...s, sign: d.doc_type === 'receipt_voucher' ? 1 : -1 })))
    .map((s) => ({ ...s, taxable: s.taxable * s.sign, cgst: s.cgst * s.sign, sgst: s.sgst * s.sign }))).values()].filter((r) => r.taxable)
  const adjustedRes = sales.filter((d) => d.doc_type === 'invoice' && n(d.advance_adjusted_paise) > 0).map((d) => d.reservation_id!)
  const earlier = adjustedRes.length ? await t.query<{ doc_type: string; tax_summary: { rate: number; taxable: number; cgst: number; sgst: number }[] }>(
    `select doc_type, tax_summary from tax_document where reservation_id = any($1) and doc_type in ('receipt_voucher', 'refund_voucher') and issue_date < $2`, [adjustedRes, from]) : []
  const atadj = [...byRate(earlier.flatMap((d) => d.tax_summary.map((s) => { const k = d.doc_type === 'receipt_voucher' ? 1 : -1; return { ...s, taxable: s.taxable * k, cgst: s.cgst * k, sgst: s.sgst * k } }))).values()].filter((r) => r.taxable)

  // HSN / SAC summary, business and consumer apart.
  const hsn = (docs2: Doc[], sign: number, into: Map<string, { sac: string; desc: string; rate: number; value: number; taxable: number; cgst: number; sgst: number; igst: number }>) => {
    for (const d of docs2) for (const l of d.lines) {
      const sac = l.sac ?? '999799', k = `${sac}|${l.gstRate}`
      const x = into.get(k) ?? { sac, desc: SAC_DESC[sac] ?? l.description.slice(0, 30), rate: Number(l.gstRate), value: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 }
      x.taxable += sign * l.taxable; x.cgst += sign * l.cgst; x.sgst += sign * l.sgst; x.value += sign * (l.taxable + l.cgst + l.sgst)
      into.set(k, x)
    }
    return into
  }
  const hsnB2b = [...hsn(notes.filter(isB2b), -1, hsn(sales.filter(isB2b), 1, new Map())).values()]
  const hsnB2c = [...hsn(notes.filter((d) => !isB2b(d)), -1, hsn(sales.filter((d) => !isB2b(d)), 1, new Map())).values()]

  // Documents issued, series by series.
  const series = new Map<string, string[]>()
  for (const d of docs) { const k = d.doc_type; series.set(k, [...(series.get(k) ?? []), d.number]) }
  const vat = await t.query<{ number: string; taxable_paise: string }>('select number, taxable_paise from vat_invoice where issue_date between $1 and $2 order by number', [from, to])
  const DOC_NAMES: Record<string, [number, string]> = { invoice: [1, 'Invoices for outward supply'], fnb_invoice: [1, 'Invoices for outward supply'], credit_note: [5, 'Credit note'], receipt_voucher: [6, 'Receipt voucher'], refund_voucher: [8, 'Refund voucher'] }
  const documents = [...series.entries()].map(([type, nums]) => {
    const sorted = [...nums].sort()
    return { type, docNum: DOC_NAMES[type]?.[0] ?? 1, nature: DOC_NAMES[type]?.[1] ?? type, from: sorted[0], to: sorted[sorted.length - 1], total: nums.length, cancelled: 0 }
  })
  // Liquor sold under TN VAT is outside GST: reported as a non-GST supply.
  const nonGst = vat.reduce((a, v) => a + n(v.taxable_paise), 0)

  const outward = sumRows([...b2b.flatMap((x) => x.items), ...b2cs, ...cdnr.flatMap((x) => x.items).map((r) => ({ ...r, taxable: -r.taxable, cgst: -r.cgst, sgst: -r.sgst, igst: -r.igst }))])
  const advNet = sumRows([...at, ...atadj.map((r) => ({ ...r, taxable: -r.taxable, cgst: -r.cgst, sgst: -r.sgst, igst: -r.igst }))])
  return { period, b2b, b2cs, cdnr, at, atadj, hsnB2b, hsnB2c, documents, nonGst, totals: { ...outward, advances: advNet }, sales, notes }
}

const rs = (p: number) => Math.round(p) / 100
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`

/** The GSTR-1 file for the portal's offline tool (or a GST Suvidha Provider). E-invoiced documents are already in GSTR-1 from the IRP. */
export function gstr1Json(gstin: string, data: Awaited<ReturnType<typeof gstr1>>, includeEinvoiced = false) {
  const keep = <T extends { einvoiced: boolean }>(xs: T[]) => xs.filter((x) => includeEinvoiced || !x.einvoiced)
  const itms = (items: RateRow[]) => items.map((r, i) => ({ num: i + 1, itm_det: { txval: rs(r.taxable), rt: r.rate, camt: rs(r.cgst), samt: rs(r.sgst), csamt: 0 } }))
  const group = <T extends { gstin: string }>(xs: T[]) => [...new Set(xs.map((x) => x.gstin))].map((g) => [g, xs.filter((x) => x.gstin === g)] as const)
  const fp = `${data.period.slice(5, 7)}${data.period.slice(0, 4)}`
  const json: Record<string, unknown> = { gstin, fp, version: 'GST3.2.1', hash: 'hash' }
  const b2b = keep(data.b2b)
  if (b2b.length) json.b2b = group(b2b).map(([ctin, inv]) => ({ ctin, inv: inv.map((x) => ({ inum: x.number, idt: ddmmyyyy(x.date), val: rs(x.value), pos: x.pos, rchrg: 'N', inv_typ: 'R', itms: itms(x.items) })) }))
  if (data.b2cs.length) json.b2cs = data.b2cs.map((r) => ({ sply_ty: 'INTRA', pos: HOME, typ: 'OE', txval: rs(r.taxable), rt: r.rate, camt: rs(r.cgst), samt: rs(r.sgst), csamt: 0 }))
  const cdnr = keep(data.cdnr)
  if (cdnr.length) json.cdnr = group(cdnr).map(([ctin, nt]) => ({ ctin, nt: nt.map((x) => ({ ntty: 'C', nt_num: x.number, nt_dt: ddmmyyyy(x.date), val: rs(x.value), pos: x.pos, rchrg: 'N', inv_typ: 'R', itms: itms(x.items) })) }))
  if (data.at.length) json.at = [{ pos: HOME, sply_ty: 'INTRA', itms: data.at.map((r) => ({ rt: r.rate, ad_amt: rs(r.taxable), camt: rs(r.cgst), samt: rs(r.sgst), csamt: 0 })) }]
  if (data.atadj.length) json.txpd = [{ pos: HOME, sply_ty: 'INTRA', itms: data.atadj.map((r) => ({ rt: r.rate, ad_amt: rs(r.taxable), camt: rs(r.cgst), samt: rs(r.sgst), csamt: 0 })) }]
  const hsn = (xs: typeof data.hsnB2b) => xs.map((h, i) => ({ num: i + 1, hsn_sc: h.sac, desc: h.desc, uqc: 'NA', qty: 0, rt: h.rate, txval: rs(h.taxable), iamt: 0, camt: rs(h.cgst), samt: rs(h.sgst), csamt: 0 }))
  json.hsn = { hsn_b2b: hsn(data.hsnB2b), hsn_b2c: hsn(data.hsnB2c) }
  if (data.nonGst) json.nil = { inv: [{ sply_ty: 'INTRAB2C', nil_amt: 0, expt_amt: 0, ngsup_amt: rs(data.nonGst) }] }
  if (data.documents.length) {
    json.doc_issue = { doc_det: [...new Set(data.documents.map((d) => d.docNum))].map((num) => ({ doc_num: num, docs: data.documents.filter((d) => d.docNum === num).map((d, i) => ({ num: i + 1, from: d.from, to: d.to, totnum: d.total, cancel: d.cancelled, net_issue: d.total - d.cancelled })) })) }
  }
  return json
}

export interface Heads { igst: number; cgst: number; sgst: number }
const heads = (inter: boolean, tax: number): Heads => (inter ? { igst: tax, cgst: 0, sgst: 0 } : { igst: 0, cgst: Math.round(tax / 2), sgst: tax - Math.round(tax / 2) })
const add = (a: Heads, b: Heads): Heads => ({ igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst })
const zero: Heads = { igst: 0, cgst: 0, sgst: 0 }

/** Bills whose credit this period's GSTR-3B may claim: those in this period's GSTR-2B (not rejected), or by bill date when no GSTR-2B is imported yet. */
export async function claimableBills(t: Db, period: string) {
  const [imp] = await t.query('select 1 from gstr2b_import where period = $1 limit 1', [period])
  const rows = await t.query<{ id: string; bill_no: string; bill_date: string; vendor: string; state_code: string; ims_action: string; fwd: string; rcm_itc: string; blocked: string; rcm: string; rcm_taxable: string; zero_rated: string }>(
    `select b.id, b.bill_no, b.bill_date::text, v.name as vendor, v.state_code, b.ims_action,
            coalesce(sum(l.gst_paise) filter (where l.itc = 'full' and not l.rcm), 0) as fwd,
            coalesce(sum(l.gst_paise) filter (where l.itc = 'full' and l.rcm), 0) as rcm_itc,
            coalesce(sum(l.gst_paise) filter (where l.itc <> 'full' and not l.rcm), 0) as blocked,
            coalesce(sum(l.gst_paise) filter (where l.rcm), 0) as rcm,
            coalesce(sum(l.amount_paise) filter (where l.rcm), 0) as rcm_taxable,
            coalesce(sum(l.amount_paise) filter (where l.gst_rate = 0), 0) as zero_rated
       from purchase_bill b join vendor v on v.id = b.vendor_id join bill_line l on l.bill_id = b.id
      where b.status <> 'cancelled' and ${imp ? `b.id in (select bill_id from gstr2b_line where period = $1 and status = 'matched' and bill_id is not null)` : `to_char(b.bill_date, 'YYYY-MM') = $1`}
      group by b.id, v.name, v.state_code`, [period])
  return { from2b: !!imp, bills: rows.map((r) => ({ ...r, fwd: n(r.fwd), rcm_itc: n(r.rcm_itc), blocked: n(r.blocked), rcm: n(r.rcm), rcm_taxable: n(r.rcm_taxable), zero_rated: n(r.zero_rated), inter: r.state_code !== HOME })) }
}

export async function gstr3b(t: Db, period: string, filedOn?: string) {
  const from = `${period}-01`, to = monthEnd(period)
  const g1 = await gstr1(t, period)
  // 3.1(a): outward taxable supplies, with advances received less advances adjusted.
  const out = { taxable: g1.totals.taxable + g1.totals.advances.taxable, igst: 0, cgst: g1.totals.cgst + g1.totals.advances.cgst, sgst: g1.totals.sgst + g1.totals.advances.sgst }
  // Reverse charge is owed in the month of the bill (CA check: the date of payment where earlier).
  const rcmRows = await t.query<{ state_code: string; taxable: string; tax: string }>(
    `select v.state_code, sum(l.amount_paise) as taxable, sum(l.gst_paise) as tax from bill_line l join purchase_bill b on b.id = l.bill_id join vendor v on v.id = b.vendor_id
      where l.rcm and b.status <> 'cancelled' and b.bill_date between $1 and $2 group by v.state_code`, [from, to])
  let rcm = { taxable: 0, ...zero }
  for (const r of rcmRows) rcm = { taxable: rcm.taxable + n(r.taxable), ...add(rcm, heads(r.state_code !== HOME, n(r.tax))) }

  // 4(A): input tax credit. Bills by GSTR-2B; OTA commission invoices and card / UPI fees by their date.
  const claim = await claimableBills(t, period)
  let billItc = zero, rcmItc = zero, blocked = zero
  const rejected = claim.bills.filter((b) => b.ims_action === 'rejected')
  for (const b of claim.bills.filter((x) => x.ims_action !== 'rejected')) {
    billItc = add(billItc, heads(b.inter, b.fwd)); blocked = add(blocked, heads(b.inter, b.blocked))
  }
  // Reverse charge credit: on this month's reverse-charge bills, claimed with the tax paid on them.
  for (const r of await t.query<{ state_code: string; tax: string }>(
    `select v.state_code, sum(l.gst_paise) as tax from bill_line l join purchase_bill b on b.id = l.bill_id join vendor v on v.id = b.vendor_id
      where l.rcm and l.itc = 'full' and b.status <> 'cancelled' and b.bill_date between $1 and $2 group by v.state_code`, [from, to])) rcmItc = add(rcmItc, heads(r.state_code !== HOME, n(r.tax)))
  const ota = await t.query<{ commission_gst_paise: string; gstin: string | null }>('select p.commission_gst_paise, d.gstin from ota_payout p join debtor d on d.id = p.debtor_id where p.date between $1 and $2', [from, to])
  let otherItc = zero
  for (const o of ota) otherItc = add(otherItc, heads(!!o.gstin && o.gstin.slice(0, 2) !== HOME, n(o.commission_gst_paise)))
  const [fees] = await t.query<{ c: string | null; s: string | null; i: string | null }>(
    `select sum(l.debit_paise) filter (where l.account_code = '1500') as c, sum(l.debit_paise) filter (where l.account_code = '1501') as s, sum(l.debit_paise) filter (where l.account_code = '1502') as i
       from voucher_line l join voucher v on v.id = l.voucher_id where v.source_type = 'bank_line' and v.date between $1 and $2`, [from, to])
  otherItc = add(otherItc, { igst: n(fees.i), cgst: n(fees.c), sgst: n(fees.s) })
  const allOther = add(billItc, otherItc)
  const itcTotal = add(allOther, rcmItc)

  // 4(B)(1): rooms up to ₹7,500 and restaurant service at 5% carry no credit, and liquor is outside GST: the
  // credit on common inputs is reversed in the share those supplies have of the month's turnover (rule 42). CA check
  const noItc = [...g1.sales.flatMap((d) => d.lines), ...g1.notes.flatMap((d) => d.lines.map((l) => ({ ...l, taxable: -l.taxable })))]
    .filter((l) => NO_ITC_SAC.includes(l.sac ?? '') && Number(l.gstRate) === 5).reduce((a, l) => a + l.taxable, 0) + g1.nonGst
  const turnover = g1.totals.taxable + g1.nonGst
  const share = turnover > 0 ? Math.min(1, Math.max(0, noItc / turnover)) : 0
  const reversal: Heads = { igst: Math.round(itcTotal.igst * share), cgst: Math.round(itcTotal.cgst * share), sgst: Math.round(itcTotal.sgst * share) }
  const netItc: Heads = { igst: itcTotal.igst - reversal.igst, cgst: itcTotal.cgst - reversal.cgst, sgst: itcTotal.sgst - reversal.sgst }

  // 5: inward supplies at nil rate (fresh produce, milk) and outside GST (liquor from TASMAC).
  const [nil] = await t.query<{ v: string | null }>(`select sum(l.amount_paise) as v from bill_line l join purchase_bill b on b.id = l.bill_id where l.gst_rate = 0 and b.status <> 'cancelled' and b.bill_date between $1 and $2`, [from, to])
  const [tas] = await t.query<{ v: string | null }>('select sum(value_paise + vat_paise) as v from tasmac_purchase where business_date between $1 and $2', [from, to])

  // 6.1: tax paid. Credit is used IGST first (IGST, then CGST, then SGST), then CGST (CGST, then IGST), then SGST (SGST, then IGST).
  // Reverse charge is paid in cash only.
  const liab = { igst: out.igst, cgst: out.cgst, sgst: out.sgst }
  const credit = { ...netItc }
  const used = { ...zero }
  const take = (from: keyof Heads, to: keyof Heads) => { const x = Math.max(0, Math.min(credit[from], liab[to])); credit[from] -= x; liab[to] -= x; used[from] += x }
  take('igst', 'igst'); take('igst', 'cgst'); take('igst', 'sgst'); take('cgst', 'cgst'); take('cgst', 'igst'); take('sgst', 'sgst'); take('sgst', 'igst')
  const cash: Heads = { igst: Math.max(0, liab.igst) + rcm.igst, cgst: Math.max(0, liab.cgst) + rcm.cgst, sgst: Math.max(0, liab.sgst) + rcm.sgst }
  // Filed after the 20th of the next month: a late fee of ₹50 a day (₹20 for a nil return), and 18% a year interest on the cash.
  const due = addDays(`${addDays(to, 1).slice(0, 7)}-01`, 19)
  const daysLate = filedOn && filedOn > due ? Math.round((Date.parse(filedOn) - Date.parse(due)) / 86_400_000) : 0
  const nilReturn = !out.taxable && !rcm.taxable
  const cashTotal = cash.igst + cash.cgst + cash.sgst
  return {
    period, due, from2b: claim.from2b,
    outward: out, nonGst: g1.nonGst, rcm,
    itc: { otherBills: billItc, otherOtaAndFees: otherItc, rcm: rcmItc, total: itcTotal, reversal, reversalShare: Math.round(share * 10000) / 100, net: netItc, ineligible: blocked },
    inward: { nilRated: n(nil.v), nonGst: n(tas.v) },
    payment: { liability: { igst: out.igst, cgst: out.cgst, sgst: out.sgst }, creditUsed: used, cash, cashTotal, carriedForward: credit },
    late: { daysLate, lateFeePaise: daysLate ? Math.min(daysLate * (nilReturn ? 2000 : 5000), 1000000) : 0, interestPaise: daysLate ? Math.round((cashTotal * 0.18 * daysLate) / 365) : 0 },
    rejectedBills: rejected.map((b) => ({ id: b.id, vendor: b.vendor, bill_no: b.bill_no, fwd: b.fwd })),
  }
}

const normDoc = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '')

export interface TwoBLine { docType: 'invoice' | 'credit_note' | 'debit_note'; gstin: string; name: string | null; docNo: string; date: string | null; value: number; taxable: number; igst: number; cgst: number; sgst: number; itcAvailable: boolean; reason: string | null }

/** GSTR-2B as downloaded from the portal: JSON (b2b invoices, credit / debit notes), or the Excel sheet saved as CSV. */
export function parse2b(text: string, parseCsv: (s: string) => string[][], toDate: (s: string) => string | null, toPaise: (s: string) => number): TwoBLine[] {
  const t = text.replace(/^﻿/, '').trim()
  const r = (x: unknown) => Math.round(Number(x ?? 0) * 100)
  if (t.startsWith('{')) {
    const j = JSON.parse(t)
    const dd = j?.data?.docdata ?? j?.docdata ?? j
    const out: TwoBLine[] = []
    for (const s of dd.b2b ?? []) for (const i of s.inv ?? []) {
      const it = i.items ?? [i]
      out.push({ docType: 'invoice', gstin: s.ctin, name: s.trdnm ?? null, docNo: String(i.inum), date: toDate(i.dt ?? ''), value: r(i.val),
        taxable: it.reduce((a: number, x: { txval?: number }) => a + r(x.txval), 0), igst: it.reduce((a: number, x: { igst?: number }) => a + r(x.igst), 0),
        cgst: it.reduce((a: number, x: { cgst?: number }) => a + r(x.cgst), 0), sgst: it.reduce((a: number, x: { sgst?: number }) => a + r(x.sgst), 0), itcAvailable: (i.itcavl ?? 'Y') !== 'N', reason: i.rsn ?? null })
    }
    for (const s of dd.cdnr ?? []) for (const nt of s.nt ?? []) {
      const it = nt.items ?? [nt]
      out.push({ docType: nt.typ === 'D' ? 'debit_note' : 'credit_note', gstin: s.ctin, name: s.trdnm ?? null, docNo: String(nt.ntnum), date: toDate(nt.dt ?? ''), value: r(nt.val),
        taxable: it.reduce((a: number, x: { txval?: number }) => a + r(x.txval), 0), igst: it.reduce((a: number, x: { igst?: number }) => a + r(x.igst), 0),
        cgst: it.reduce((a: number, x: { cgst?: number }) => a + r(x.cgst), 0), sgst: it.reduce((a: number, x: { sgst?: number }) => a + r(x.sgst), 0), itcAvailable: (nt.itcavl ?? 'Y') !== 'N', reason: nt.rsn ?? null })
    }
    return out
  }
  const rows = parseCsv(t)
  const hi = rows.findIndex((x) => x.some((c) => /gstin/i.test(c)) && x.some((c) => /invoice|note/i.test(c)))
  if (hi < 0) throw new Error('Could not find the header row (GSTIN of supplier, invoice number, date, value, taxes).')
  const head = rows[hi].map((x) => x.trim().toLowerCase())
  const col = (re: RegExp, not?: RegExp) => head.findIndex((h) => re.test(h) && !(not?.test(h)))
  const g = col(/gstin/), nm = col(/trade|legal|name/), no = col(/(invoice|note) (number|no)/), dt = col(/(invoice|note) date|^date/), val = col(/(invoice|note) value/)
  const tx = col(/taxable/), ig = col(/integrated/), cg = col(/central/), sg = col(/state/), av = col(/itc avail/), rs2 = col(/reason/), ty = col(/note type|type/)
  if (g < 0 || no < 0) throw new Error('GSTR-2B needs the supplier\'s GSTIN and the invoice number.')
  return rows.slice(hi + 1).filter((x) => /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test((x[g] ?? '').trim())).map((x) => ({
    docType: ty >= 0 && /credit/i.test(x[ty] ?? '') ? 'credit_note' as const : ty >= 0 && /debit/i.test(x[ty] ?? '') ? 'debit_note' as const : 'invoice' as const,
    gstin: x[g].trim(), name: nm >= 0 ? x[nm]?.trim() || null : null, docNo: x[no].trim(), date: dt >= 0 ? toDate(x[dt] ?? '') : null,
    value: val >= 0 ? toPaise(x[val]) : 0, taxable: tx >= 0 ? toPaise(x[tx]) : 0, igst: ig >= 0 ? toPaise(x[ig]) : 0, cgst: cg >= 0 ? toPaise(x[cg]) : 0, sgst: sg >= 0 ? toPaise(x[sg]) : 0,
    itcAvailable: av < 0 || !/^n/i.test((x[av] ?? '').trim()), reason: rs2 >= 0 ? x[rs2]?.trim() || null : null,
  }))
}

/** Matches GSTR-2B lines to the bills entered (vendor GSTIN and bill number) and to OTAs' commission invoices. */
export async function match2b(t: Db, period: string) {
  const lines = await t.query<{ id: string; supplier_gstin: string; doc_no: string; taxable_paise: string; igst_paise: string; cgst_paise: string; sgst_paise: string }>(
    `select * from gstr2b_line where period = $1`, [period])
  let matched = 0
  for (const l of lines) {
    const tax = n(l.igst_paise) + n(l.cgst_paise) + n(l.sgst_paise)
    const bills = await t.query<{ id: string; bill_no: string; taxable_paise: string; cgst_paise: string; sgst_paise: string; igst_paise: string }>(
      `select b.id, b.bill_no, b.taxable_paise, b.cgst_paise, b.sgst_paise, b.igst_paise from purchase_bill b join vendor v on v.id = b.vendor_id where v.gstin = $1 and b.status <> 'cancelled'`, [l.supplier_gstin])
    const b = bills.find((x) => normDoc(x.bill_no) === normDoc(l.doc_no))
    if (b) {
      const ok = Math.abs(n(b.cgst_paise) + n(b.sgst_paise) + n(b.igst_paise) - tax) <= 100
      await t.query(`update gstr2b_line set bill_id = $2, ota_payout_id = null, status = $3 where id = $1`, [l.id, b.id, ok ? 'matched' : 'mismatch'])
      if (ok) matched++
      continue
    }
    const ota = await t.query<{ id: string; commission_invoice: string | null; commission_gst_paise: string }>(
      `select p.id, p.commission_invoice, p.commission_gst_paise from ota_payout p join debtor d on d.id = p.debtor_id where d.gstin = $1 and p.commission_invoice is not null`, [l.supplier_gstin])
    const o = ota.find((x) => normDoc(x.commission_invoice!) === normDoc(l.doc_no))
    if (o) {
      const ok = Math.abs(n(o.commission_gst_paise) - tax) <= 100
      await t.query(`update gstr2b_line set ota_payout_id = $2, bill_id = null, status = $3 where id = $1`, [l.id, o.id, ok ? 'matched' : 'mismatch'])
      if (ok) matched++
      continue
    }
    await t.query(`update gstr2b_line set bill_id = null, ota_payout_id = null, status = 'unmatched' where id = $1`, [l.id])
  }
  return matched
}
