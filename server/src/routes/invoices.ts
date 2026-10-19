import type { FastifyInstance, FastifyRequest } from 'fastify'
import { formatInr, rupees, validateGstin } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import { buildIrnPayload, irnBlockers, type DocForIrn, type Party } from '../einvoice'
import { PROPERTY } from '../fo-core'
import { issueCreditNote, stateName, type DocLine } from '../invoicing'
import { requireCaller } from './auth'

// Property tax identity, the document register, credit notes, e-invoice (IRN) generation and printable invoices.

interface DocRow {
  id: string; doc_type: string; number: string; fy: string; issue_date: string; reservation_id: string | null; original_id: string | null
  supplier: Party; recipient: Party; b2b: boolean; place_of_supply: string; reverse_charge: boolean; lines: DocLine[]
  tax_summary: { rate: number; taxable: number; cgst: number; sgst: number }[]
  taxable_paise: number; cgst_paise: number; sgst_paise: number; total_paise: number; advance_adjusted_paise: number
  amount_in_words: string; reason: string | null; irn_status: string; irn_deadline: string | null; irn: string | null
  ack_no: string | null; ack_date: string | null; signed_qr: string | null; irn_error: string | null; issued_at: string
}

const DOC_COLS = `id, doc_type, number, fy, issue_date::text, reservation_id, original_id, supplier, recipient, b2b, place_of_supply,
  reverse_charge, lines, tax_summary, taxable_paise, cgst_paise, sgst_paise, total_paise, advance_adjusted_paise, amount_in_words, reason,
  irn_status, irn_deadline::text, irn, ack_no, ack_date, signed_qr, irn_error, issued_at`

const TITLES: Record<string, string> = { invoice: 'Tax Invoice', fnb_invoice: 'Tax Invoice', credit_note: 'Credit Note', receipt_voucher: 'Receipt Voucher', refund_voucher: 'Refund Voucher' }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const money = (p: number) => formatInr(p).replace('₹', '')

export function invoiceRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db

  async function viewer(req: FastifyRequest) {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'front_desk') && !can(who, 'invoice.view') && !can(who, 'fnb.bill')) throw new HttpError(403, 'You cannot see tax documents.')
    return who
  }

  async function loadDoc(id: string) {
    const [d] = await db.query<DocRow>(`select ${DOC_COLS} from tax_document where id = $1`, [id])
    if (!d) throw new HttpError(404, 'No such document.')
    return d
  }

  app.patch('/api/property', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!who.permissions.has('*')) throw new HttpError(403, 'Only the MD can change the company\'s tax details.')
    const b = req.body as { legalName?: string; gstin?: string; address?: string; city?: string; pin?: string; invoicePrefix?: string }
    const [before] = await db.query<Record<string, unknown>>('select legal_name, gstin, address, city, pin, invoice_prefix from property where id = $1', [PROPERTY])
    const next = { ...before }
    if (b.legalName !== undefined) next.legal_name = b.legalName.trim()
    if (b.gstin !== undefined) {
      const v = validateGstin(b.gstin)
      if (!v.ok) throw new HttpError(400, v.reason)
      if (v.stateCode !== '33') throw new HttpError(400, 'The resort is in Tamil Nadu, so its GSTIN must start with 33.')
      next.gstin = v.gstin
    }
    if (b.address !== undefined) next.address = b.address.trim()
    if (b.city !== undefined) next.city = b.city.trim()
    if (b.pin !== undefined) {
      if (!/^\d{6}$/.test(b.pin)) throw new HttpError(400, 'PIN code must be 6 digits.')
      next.pin = b.pin
    }
    if (b.invoicePrefix !== undefined) {
      if (!/^[A-Z0-9]{1,5}$/.test(b.invoicePrefix)) throw new HttpError(400, 'Invoice prefix: up to 5 capital letters or digits.')
      next.invoice_prefix = b.invoicePrefix
    }
    await db.query('update property set legal_name = $2, gstin = $3, address = $4, city = $5, pin = $6, invoice_prefix = $7 where id = $1',
      [PROPERTY, next.legal_name, next.gstin, next.address, next.city, next.pin, next.invoice_prefix])
    await appendAudit(db, { actor: who, action: 'property.tax_details', entity: { type: 'property', id: PROPERTY }, before, after: next }, ctx.now())
    return next
  })

  app.get('/api/tax-documents', async (req) => {
    await viewer(req)
    const q = req.query as { type?: string; irnStatus?: string; reservationId?: string }
    const params: unknown[] = []
    const where: string[] = []
    if (q.type) { params.push(q.type); where.push(`doc_type = $${params.length}`) }
    if (q.irnStatus) { params.push(q.irnStatus); where.push(`irn_status = $${params.length}`) }
    if (q.reservationId) { params.push(q.reservationId); where.push(`reservation_id = $${params.length}`) }
    return db.query(`select id, doc_type, number, issue_date::text, reservation_id, recipient->>'name' as recipient, recipient->>'gstin' as gstin,
                            total_paise, irn_status, irn_deadline::text from tax_document ${where.length ? 'where ' + where.join(' and ') : ''}
                      order by issued_at desc limit 500`, params)
  })

  app.get('/api/tax-documents/:id', async (req) => {
    await viewer(req)
    return loadDoc((req.params as { id: string }).id)
  })

  app.post('/api/tax-documents/:id/credit-notes', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'invoice.credit_note')) throw new HttpError(403, 'Only accounts or a manager can issue a credit note.')
    const b = req.body as { amount?: number; gstRate?: number; reason?: string }
    if (!(b?.amount! > 0) || typeof b.gstRate !== 'number' || !b.reason?.trim()) throw new HttpError(400, 'Send amount (taxable ₹), gstRate and reason.')
    const res = await db.tx((t) => issueCreditNote(ctx, t, who, (req.params as { id: string }).id, rupees(b.amount!), b.gstRate!, b.reason!.trim()))
    return reply.status(201).send(res)
  })

  // Register the document with the GST portal (IRP) through the configured provider.
  app.post('/api/tax-documents/:id/irn', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'einvoice.generate')) throw new HttpError(403, 'Only accounts can generate e-invoices.')
    if (!ctx.einvoice) throw new HttpError(503, 'No e-invoice provider is connected yet. Choose a GSP in Phase 0 settings.')
    const d = await loadDoc((req.params as { id: string }).id)
    if (!['pending', 'failed'].includes(d.irn_status)) throw new HttpError(409, d.irn_status === 'generated' ? 'IRN already generated.' : 'This document does not need an IRN.')
    let original: DocForIrn['original']
    if (d.original_id) {
      const o = await loadDoc(d.original_id)
      original = { number: o.number, issueDate: o.issue_date }
    }
    const doc: DocForIrn = {
      docType: d.doc_type === 'credit_note' ? 'credit_note' : 'invoice', number: d.number, issueDate: d.issue_date, supplier: d.supplier, recipient: d.recipient,
      placeOfSupply: d.place_of_supply, lines: d.lines, original,
      totals: { taxable: d.taxable_paise, cgst: d.cgst_paise, sgst: d.sgst_paise, total: d.total_paise },
    }
    const blockers = irnBlockers(doc)
    if (blockers.length) {
      await db.query(`update tax_document set irn_status = 'failed', irn_error = $2 where id = $1`, [d.id, blockers.join(' ')])
      throw new HttpError(422, 'The GST portal would reject this document.', { problems: blockers })
    }
    try {
      const r = await ctx.einvoice.generate(buildIrnPayload(doc))
      await db.query(`update tax_document set irn_status = 'generated', irn = $2, ack_no = $3, ack_date = $4, signed_qr = $5, irn_error = null where id = $1`,
        [d.id, r.irn, r.ackNo, r.ackDate, r.signedQr])
      await appendAudit(db, { actor: who, action: 'einvoice.generate', entity: { type: 'tax_document', id: d.id }, after: { number: d.number, irn: r.irn, ackNo: r.ackNo } }, ctx.now())
      return { ok: true, irn: r.irn, ackNo: r.ackNo, provider: ctx.einvoice.name }
    } catch (e) {
      await db.query(`update tax_document set irn_status = 'failed', irn_error = $2 where id = $1`, [d.id, (e as Error).message])
      throw new HttpError(502, `The e-invoice provider refused it: ${(e as Error).message}`)
    }
  })

  // Printable document with every field the GST invoice rules require.
  app.get('/api/tax-documents/:id/print', async (req, reply) => {
    await viewer(req)
    const d = await loadDoc((req.params as { id: string }).id)
    const original = d.original_id ? await loadDoc(d.original_id) : null
    const party = (p: Party) => `<b>${esc(p.name)}</b><br>${[p.address, p.city, p.pin].filter(Boolean).map(esc).join(', ')}${p.gstin ? `<br>GSTIN: ${esc(p.gstin)}` : ''}${p.stateCode ? `<br>State: ${esc(stateName(p.stateCode))}` : ''}`
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(TITLES[d.doc_type])} ${esc(d.number)}</title>
<style>
  body{font:13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#14211e;margin:24px auto;max-width:820px;padding:0 16px}
  h1{font-size:20px;margin:0 0 4px}.muted{color:#5a6b66}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0}
  .box{border:1px solid #c9d3cf;border-radius:6px;padding:10px 12px}table{width:100%;border-collapse:collapse;margin:12px 0}
  th,td{border-bottom:1px solid #dfe6e3;padding:6px 8px;text-align:left;vertical-align:top}th{background:#eef2ef;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.tot td{font-weight:700}.irn{word-break:break-all;font-family:ui-monospace,monospace;font-size:11px}
  @media print{body{margin:0}}
</style></head><body>
<h1>${esc(TITLES[d.doc_type])}</h1>
<div class="muted">No. <b>${esc(d.number)}</b> · Date ${esc(d.issue_date.split('-').reverse().join('/'))}${original ? ` · Against ${esc(original.number)} dated ${esc(original.issue_date.split('-').reverse().join('/'))}` : ''}</div>
<div class="grid"><div class="box"><div class="muted">Supplier</div>${party(d.supplier)}</div><div class="box"><div class="muted">${d.b2b ? 'Recipient' : 'Billed to'}</div>${party(d.recipient)}</div></div>
<div class="muted">Place of supply: ${esc(stateName(d.place_of_supply))} · Tax payable on reverse charge: ${d.reverse_charge ? 'Yes' : 'No'}</div>
<table><thead><tr><th>#</th><th>Description</th><th>SAC</th><th class="n">Qty</th><th class="n">Taxable ₹</th><th class="n">GST %</th><th class="n">CGST ₹</th><th class="n">SGST ₹</th><th class="n">Total ₹</th></tr></thead><tbody>
${d.lines.map((l) => `<tr><td>${l.slNo}</td><td>${esc(l.description)}</td><td>${esc(l.sac)}</td><td class="n">${l.qty}</td><td class="n">${money(l.taxable)}</td><td class="n">${l.gstRate}</td><td class="n">${money(l.cgst)}</td><td class="n">${money(l.sgst)}</td><td class="n">${money(l.total)}</td></tr>`).join('')}
<tr class="tot"><td colspan="4">Total</td><td class="n">${money(d.taxable_paise)}</td><td></td><td class="n">${money(d.cgst_paise)}</td><td class="n">${money(d.sgst_paise)}</td><td class="n">${money(d.total_paise)}</td></tr>
</tbody></table>
<table><thead><tr><th>GST rate</th><th class="n">Taxable ₹</th><th class="n">CGST ₹</th><th class="n">SGST ₹</th></tr></thead><tbody>
${d.tax_summary.map((s) => `<tr><td>${s.rate}% (CGST ${s.rate / 2}% + SGST ${s.rate / 2}%)</td><td class="n">${money(s.taxable)}</td><td class="n">${money(s.cgst)}</td><td class="n">${money(s.sgst)}</td></tr>`).join('')}
</tbody></table>
<p><b>Amount in words:</b> ${esc(d.amount_in_words)}</p>
${d.advance_adjusted_paise ? `<p>Advance received earlier (receipt vouchers): ₹${money(d.advance_adjusted_paise)}</p>` : ''}
${d.reason ? `<p>Reason: ${esc(d.reason)}</p>` : ''}
${d.irn ? `<div class="box"><div class="muted">E-invoice</div>IRN: <span class="irn">${esc(d.irn)}</span><br>Ack No: ${esc(d.ack_no)} · Ack Date: ${esc(d.ack_date ? new Date(d.ack_date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short', hour12: false }) : '')}</div>` : d.irn_status === 'pending' ? '<p class="muted">E-invoice (IRN) pending.</p>' : ''}
<p style="margin-top:40px;text-align:right">For ${esc(d.supplier.name)}<br><br>Authorised signatory</p>
</body></html>`
    return reply.type('text/html; charset=utf-8').send(html)
  })
}
