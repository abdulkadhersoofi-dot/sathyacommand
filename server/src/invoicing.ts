import { randomUUID } from 'node:crypto'
import {
  accommodationNight, amountInWords, documentNumber, eInvoice, financialYear, STATES, taxInside,
} from '@sathya/tax'
import { appendAudit } from './audit-store'
import { HttpError, type Caller, type Ctx } from './context'
import type { Db } from './db'
import { businessDate, PROPERTY } from './fo-core'
import type { Party } from './einvoice'

// Issues GST documents. Every document is a frozen snapshot: numbers come from a gap-free series,
// and the database refuses later edits (see migration 004).

export type DocType = 'invoice' | 'fnb_invoice' | 'credit_note' | 'receipt_voucher' | 'refund_voucher'

export interface DocLine { slNo: number; description: string; sac: string | null; qty: number; gstRate: number; taxable: number; cgst: number; sgst: number; total: number }

const PREFIX: Record<Exclude<DocType, 'invoice'>, string> = { fnb_invoice: 'RST', credit_note: 'CN', receipt_voucher: 'RV', refund_voucher: 'RF' }

/** Next number in a gap-free series (one per document type and financial year). */
export async function nextSeriesNumber(t: Db, series: string, fy: string, prefix: string) {
  const [r] = await t.query<{ serial: number }>(
    `insert into doc_series (doc_type, fy, next_serial) values ($1, $2, 2)
     on conflict (doc_type, fy) do update set next_serial = doc_series.next_serial + 1
     returning next_serial - 1 as serial`, [series, fy])
  return documentNumber(prefix, fy, r.serial)
}

const nextNumber = (t: Db, docType: DocType, fy: string, invoicePrefix: string) =>
  nextSeriesNumber(t, docType, fy, docType === 'invoice' ? invoicePrefix : PREFIX[docType])

export async function supplier(t: Db): Promise<Party & { prefix: string }> {
  const [p] = await t.query<{ legal_name: string | null; name: string; gstin: string | null; address: string | null; city: string | null; pin: string | null; state_code: string; invoice_prefix: string }>(
    'select legal_name, name, gstin, address, city, pin, state_code, invoice_prefix from property where id = $1', [PROPERTY])
  if (!p.gstin || !p.legal_name) {
    throw new HttpError(409, 'Set the company\'s legal name and GSTIN (Property settings) before issuing tax invoices.')
  }
  return { name: p.legal_name, gstin: p.gstin, address: p.address, city: p.city, pin: p.pin, stateCode: p.state_code, prefix: p.invoice_prefix }
}

async function recipientFor(t: Db, reservationId: string): Promise<Party> {
  const [r] = await t.query<{ guest: string; company: string | null; gstin: string | null; address: string | null; city: string | null; pin: string | null }>(
    `select g.name as guest, r.bill_to_company as company, r.bill_to_gstin as gstin, r.bill_to_address as address, r.bill_to_city as city, r.bill_to_pin as pin
       from reservation r join guest g on g.id = r.guest_id where r.id = $1`, [reservationId])
  return { name: r.company ?? r.guest, gstin: r.gstin, address: r.address, city: r.city, pin: r.pin, stateCode: r.gstin ? r.gstin.slice(0, 2) : null }
}

function summarise(lines: DocLine[]) {
  const byRate = new Map<number, { rate: number; taxable: number; cgst: number; sgst: number }>()
  for (const l of lines) {
    const s = byRate.get(l.gstRate) ?? { rate: l.gstRate, taxable: 0, cgst: 0, sgst: 0 }
    s.taxable += l.taxable; s.cgst += l.cgst; s.sgst += l.sgst
    byRate.set(l.gstRate, s)
  }
  const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'total') => lines.reduce((a, l) => a + l[k], 0)
  return { summary: [...byRate.values()].sort((a, b) => a.rate - b.rate), taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), total: sum('total') }
}

export interface IssueInput {
  docType: DocType
  reservationId: string | null
  folioId?: string | null
  originalId?: string | null
  recipient: Party
  lines: DocLine[]
  advanceAdjusted?: number
  reason?: string
}

export async function issue(ctx: Ctx, t: Db, who: Caller, input: IssueInput) {
  const sup = await supplier(t)
  const date = await businessDate(t)
  const fy = financialYear(date)
  const number = await nextNumber(t, input.docType, fy, sup.prefix)
  const totals = summarise(input.lines)
  const b2b = !!input.recipient.gstin
  const needsIrn = b2b && (input.docType === 'invoice' || input.docType === 'fnb_invoice' || input.docType === 'credit_note')
  const ei = needsIrn ? eInvoice(ctx.tax, { b2b: true, invoiceDate: date }) : { required: false, irnDeadline: null }
  const id = randomUUID()
  const { prefix: _p, ...supplierSnap } = sup
  await t.query(
    `insert into tax_document (id, doc_type, number, fy, issue_date, reservation_id, folio_id, original_id, supplier, recipient, b2b,
       place_of_supply, lines, tax_summary, taxable_paise, cgst_paise, sgst_paise, total_paise, advance_adjusted_paise, amount_in_words,
       reason, irn_status, irn_deadline, issued_by, issued_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
    [id, input.docType, number, fy, date, input.reservationId, input.folioId ?? null, input.originalId ?? null,
      JSON.stringify(supplierSnap), JSON.stringify(input.recipient), b2b, sup.stateCode, JSON.stringify(input.lines), JSON.stringify(totals.summary),
      totals.taxable, totals.cgst, totals.sgst, totals.total, input.advanceAdjusted ?? 0, amountInWords(totals.total),
      input.reason ?? null, ei.required ? 'pending' : 'not_required', ei.irnDeadline, who.userId, ctx.now()])
  await appendAudit(t, { actor: who, action: `${input.docType}.issue`, entity: { type: 'tax_document', id }, amount: totals.total,
    after: { number, b2b, recipient: input.recipient.name, irnDeadline: ei.irnDeadline }, note: input.reason }, ctx.now())
  return { id, number, total: totals.total, irnStatus: ei.required ? 'pending' : 'not_required', irnDeadline: ei.irnDeadline }
}

/** Tax invoice for a stay, issued at check-out from the bill's charge lines. Reversed charges and their reversals drop out. */
export async function issueStayInvoice(ctx: Ctx, t: Db, who: Caller, reservationId: string) {
  const [folio] = await t.query<{ id: string }>('select id from folio where reservation_id = $1 order by created_at limit 1', [reservationId])
  const rows = await t.query<{ id: string; kind: string; description: string; sac: string | null; gst_rate: string | null; taxable_paise: number; cgst_paise: number; sgst_paise: number; amount_paise: number; reverses: string | null }>(
    `select l.* from folio_line l join folio f on f.id = l.folio_id
      where f.reservation_id = $1 and l.kind not in ('payment', 'refund', 'liquor') order by l.business_date, l.posted_at, l.id`, [reservationId])
  const reversed = new Set(rows.filter((r) => r.reverses).map((r) => r.reverses))
  const charges = rows.filter((r) => !r.reverses && !reversed.has(r.id))
  if (!charges.length) return null
  const lines: DocLine[] = charges.map((r, i) => ({
    slNo: i + 1, description: r.description, sac: r.sac ?? (r.kind === 'room' ? ctx.tax.gst.accommodation.sac : null), qty: 1,
    gstRate: Number(r.gst_rate ?? 0), taxable: r.taxable_paise, cgst: r.cgst_paise, sgst: r.sgst_paise, total: r.amount_paise,
  }))
  const [{ adv }] = await t.query<{ adv: number }>(
    `select coalesce(sum(case when doc_type = 'receipt_voucher' then total_paise else -total_paise end), 0)::bigint as adv
       from tax_document where reservation_id = $1 and doc_type in ('receipt_voucher', 'refund_voucher')`, [reservationId])
  return issue(ctx, t, who, { docType: 'invoice', reservationId, folioId: folio.id, recipient: await recipientFor(t, reservationId), lines, advanceAdjusted: Number(adv) })
}

/** GST rate that applies to a booking's advance: the highest slab among its nights (adjusted on the final invoice). */
async function advanceRate(ctx: Ctx, t: Db, reservationId: string) {
  const nights = await t.query<{ night: string; amount_paise: number; extras_paise: number }>(
    'select night::text, amount_paise, extras_paise from room_night where reservation_id = $1 order by night', [reservationId])
  if (!nights.length) return 5
  return Math.max(...nights.map((n) => accommodationNight(ctx.tax, { date: n.night, charged: n.amount_paise, extras: n.extras_paise }).rate))
}

/** Receipt voucher for money received before the stay; GST is due on advances for services. */
export async function issueReceiptVoucher(ctx: Ctx, t: Db, who: Caller, reservationId: string, amount: number) {
  const rate = await advanceRate(ctx, t, reservationId)
  const gst = taxInside(amount, rate)
  const cgst = Math.round(gst / 2)
  const line: DocLine = { slNo: 1, description: `Advance for accommodation (reservation ${reservationId})`, sac: ctx.tax.gst.accommodation.sac,
    qty: 1, gstRate: rate, taxable: amount - gst, cgst, sgst: gst - cgst, total: amount }
  return issue(ctx, t, who, { docType: 'receipt_voucher', reservationId, recipient: await recipientFor(t, reservationId), lines: [line] })
}

/** Refund voucher when an advance is returned; reverses the GST charged on it. */
export async function issueRefundVoucher(ctx: Ctx, t: Db, who: Caller, reservationId: string, amount: number) {
  const [rv] = await t.query<{ id: string; tax_summary: { rate: number }[] }>(
    `select id, tax_summary from tax_document where reservation_id = $1 and doc_type = 'receipt_voucher' order by issued_at desc limit 1`, [reservationId])
  if (!rv) return null
  const rate = rv.tax_summary[0]?.rate ?? 5
  const gst = taxInside(amount, rate)
  const cgst = Math.round(gst / 2)
  const line: DocLine = { slNo: 1, description: `Refund of advance (reservation ${reservationId})`, sac: ctx.tax.gst.accommodation.sac,
    qty: 1, gstRate: rate, taxable: amount - gst, cgst, sgst: gst - cgst, total: amount }
  return issue(ctx, t, who, { docType: 'refund_voucher', reservationId, originalId: rv.id, recipient: await recipientFor(t, reservationId), lines: [line] })
}

/** Credit note against an invoice, e.g. a discount agreed after billing. Cannot exceed what was invoiced at that rate. */
export async function issueCreditNote(ctx: Ctx, t: Db, who: Caller, invoiceId: string, taxableAmount: number, gstRate: number, reason: string) {
  const [inv] = await t.query<{ id: string; doc_type: string; reservation_id: string; folio_id: string; recipient: Party; tax_summary: { rate: number; taxable: number }[]; number: string }>(
    'select * from tax_document where id = $1 for update', [invoiceId])
  if (!inv || inv.doc_type !== 'invoice') throw new HttpError(404, 'No such invoice.')
  const atRate = inv.tax_summary.find((s) => s.rate === gstRate)
  if (!atRate) throw new HttpError(400, `Invoice ${inv.number} has nothing at ${gstRate}%.`)
  const [{ credited }] = await t.query<{ credited: number }>(
    `select coalesce(sum((s->>'taxable')::bigint), 0)::bigint as credited from tax_document d, jsonb_array_elements(d.tax_summary) s
      where d.original_id = $1 and d.doc_type = 'credit_note' and (s->>'rate')::numeric = $2`, [invoiceId, gstRate])
  if (Number(credited) + taxableAmount > atRate.taxable) {
    throw new HttpError(400, `Credit at ${gstRate}% can't exceed ₹${((atRate.taxable - Number(credited)) / 100).toFixed(2)} still invoiced at that rate.`)
  }
  const cgst = Math.round((taxableAmount * gstRate) / 200), sgst = cgst
  const line: DocLine = { slNo: 1, description: `Credit against ${inv.number}: ${reason}`, sac: ctx.tax.gst.accommodation.sac, qty: 1,
    gstRate, taxable: taxableAmount, cgst, sgst, total: taxableAmount + cgst + sgst }
  return issue(ctx, t, who, { docType: 'credit_note', reservationId: inv.reservation_id, folioId: inv.folio_id, originalId: inv.id, recipient: inv.recipient, lines: [line], reason })
}

export const stateName = (code: string | null) => (code ? `${code} - ${STATES[code] ?? ''}` : '')
