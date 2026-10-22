import { esc, toast, tonePill, showDate } from '../ui/dom'
import { toolbar } from '../ui/toolbar'
import { val } from '../ui/form-modal'
import { money, type Host } from './books'

// GST returns month by month: GSTR-1 tables and the upload file, GSTR-2B imported and matched (with IMS
// actions on bills), GSTR-3B with the credit, reversal and cash to pay, and each return recorded as filed.

interface Rate { rate: number; taxable: number; cgst: number; sgst: number; igst: number }
interface Heads { igst: number; cgst: number; sgst: number }
interface G1 {
  b2b: { gstin: string; name: string; number: string; date: string; value: number; einvoiced: boolean; items: Rate[] }[]
  b2cs: Rate[]; cdnr: { gstin: string; name: string; number: string; date: string; value: number; original: string | null; items: Rate[] }[]
  at: Rate[]; atadj: Rate[]; hsnB2b: { sac: string; desc: string; rate: number; taxable: number; cgst: number; sgst: number }[]; hsnB2c: { sac: string; desc: string; rate: number; taxable: number; cgst: number; sgst: number }[]
  documents: { type: string; nature: string; from: string; to: string; total: number; cancelled: number }[]; nonGst: number
  totals: { taxable: number; cgst: number; sgst: number; igst: number; advances: { taxable: number; cgst: number; sgst: number } }
}
interface G3 {
  due: string; from2b: boolean; outward: { taxable: number } & Heads; nonGst: number; rcm: { taxable: number } & Heads
  itc: { otherBills: Heads; otherOtaAndFees: Heads; rcm: Heads; total: Heads; reversal: Heads; reversalShare: number; net: Heads; ineligible: Heads }
  inward: { nilRated: number; nonGst: number }; payment: { liability: Heads; creditUsed: Heads; cash: Heads; cashTotal: number; carriedForward: Heads }
  late: { daysLate: number; lateFeePaise: number; interestPaise: number }; rejectedBills: { vendor: string; bill_no: string; fwd: number }[]
}
interface TwoBLine { id: string; supplier_gstin: string; supplier_name: string | null; doc_no: string; doc_date: string | null; taxable_paise: string; igst_paise: string; cgst_paise: string; sgst_paise: string; status: string; bill_id: string | null; bill_no: string | null; ims_action: string | null; vendor: string | null; ota_payout: string | null; itc_available: boolean }
interface Waiting { id: string; bill_no: string; bill_date: string; vendor: string; gstin: string | null; itc_paise: string; ims_action: string }
interface Month { period: string; gstr1: G1; gstr3b: G3; filed: { form: string; arn: string; filed_on: string; filed_by_name: string }[]; twoB: { imported: boolean; lines: TwoBLine[]; waiting: Waiting[] } }

const sum = (rs: Rate[]) => rs.reduce((a, r) => ({ taxable: a.taxable + r.taxable, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst }), { taxable: 0, cgst: 0, sgst: 0 })
const IMS: Record<string, [string, string]> = { accepted: ['Accepted', '--st-vacant'], rejected: ['Rejected', '--st-departing'], pending: ['No action', '--muted'] }
const M2B: Record<string, [string, string]> = { matched: ['Matched', '--st-vacant'], mismatch: ['Amount differs', '--st-departing'], unmatched: ['Not in our books', '--marigold'] }

interface PendingIrn { id: string; doc_type: string; number: string; issue_date: string; recipient: string; gstin: string | null; total_paise: number; irn_status: string; irn_deadline: string | null }

export class GstView {
  private period = ''
  private d: Month | null = null
  private irn: PendingIrn[] = []
  constructor(private h: Host) {}

  async load() {
    if (!this.period) { const d = new Date(`${this.h.to}T00:00:00Z`); d.setUTCDate(0); this.period = d.toISOString().slice(0, 7) }
    this.d = await this.h.cached(`/api/gst/${this.period}`)
    // Company bills waiting for their e-invoice number (IRN).
    this.irn = this.h.can('einvoice.generate') ? [...await this.h.cached<PendingIrn[]>('/api/tax-documents?irnStatus=pending'), ...await this.h.cached<PendingIrn[]>('/api/tax-documents?irnStatus=failed')] : []
  }

  html() {
    const d = this.d!, g1 = d.gstr1, g3 = d.gstr3b, file = this.h.can('gst.file')
    const filed = (form: string) => d.filed.find((f) => f.form === form)
    const status = (form: string, label: string) => { const f = filed(form); return f ? tonePill(`${label} filed ${f.filed_on} · ${f.arn}`, '--st-vacant') : tonePill(`${label} not filed`, '--marigold') }
    const row = (label: string, x: { taxable?: number; cgst: number; sgst: number; igst?: number } | null, note = '') => `<tr><td>${label}${note ? ` <small class="muted">${note}</small>` : ''}</td>
      <td class="n">${x?.taxable != null ? money(x.taxable) : ''}</td><td class="n">${x ? money(x.igst ?? 0) : ''}</td><td class="n">${x ? money(x.cgst) : ''}</td><td class="n">${x ? money(x.sgst) : ''}</td></tr>`
    const head = '<thead><tr><th></th><th class="n">Taxable value</th><th class="n">IGST</th><th class="n">CGST</th><th class="n">SGST</th></tr></thead>'
    const b2b = sum(g1.b2b.flatMap((x) => x.items)), cn = sum(g1.cdnr.flatMap((x) => x.items))
    const toFile = file ? [...(filed('GSTR1') ? [] : [{ attrs: 'data-gs="file1"', label: 'GSTR-1 filed…' }]), ...(filed('GSTR3B') ? [] : [{ attrs: 'data-gs="file3b"', label: 'GSTR-3B filed…' }])] : []
    return `${toolbar({
      primary: toFile.map((a, i) => (i ? { ...a, primary: false } : a)),
      filters: `<label class="inline">Month <input type="month" data-period value="${esc(this.period)}"></label>${file ? '<label class="btn file-btn">Import GSTR-2B…<input type="file" accept=".json,.csv,application/json,text/csv" data-2b hidden></label>' : ''}`,
      more: [{ attrs: 'data-gs="json"', label: 'GSTR-1 file (JSON)' }],
      end: `${status('GSTR1', 'GSTR-1')} ${status('GSTR3B', 'GSTR-3B')} <span class="small muted">GSTR-3B due ${esc(showDate(g3.due))}</span>`,
    })}
      ${this.irn.length ? `<div class="sec-title">E-invoices to generate <span>${this.irn.length}</span></div>
        <p class="muted small">Bills to companies with a GSTIN need an e-invoice number (IRN) from the GST portal within 30 days. Generate it here if a GST provider is connected; otherwise download the JSON, upload it on einvoice1.gst.gov.in, and record the IRN it gives.</p>
        ${this.irn.map((x) => `<div class="row-card"><div class="rc-title"><span class="mono">${esc(x.number)}</span> ${esc(x.recipient)} <small class="muted">${esc(x.gstin ?? '')}</small></div>
          <div class="rc-sub">${esc(showDate(x.issue_date))} · ${money(Number(x.total_paise))}${x.irn_deadline ? ` · due by ${esc(showDate(x.irn_deadline))}` : ''}${x.irn_status === 'failed' ? ' · <b class="fd-warn">refused last time</b>' : ''}</div>
          <div class="rc-right"><button type="button" class="btn small" data-irn-gen="${esc(x.id)}">Generate</button><button type="button" class="btn small" data-irn-json="${esc(x.id)}" data-irn-no="${esc(x.number)}">JSON</button><button type="button" class="btn small primary" data-irn-rec="${esc(x.id)}" data-irn-no="${esc(x.number)}">Record IRN…</button></div></div>`).join('')}` : ''}

      <div class="sec-title">GSTR-1: what the resort supplied</div>
      <div class="acc-scroll"><table class="acc-table">${head}<tbody>
        ${row(`B2B invoices (${g1.b2b.length})`, b2b, g1.b2b.some((x) => x.einvoiced) ? 'e-invoiced ones are already in GSTR-1 from the IRP' : '')}
        ${g1.b2cs.map((r) => row(`B2C at ${r.rate}%`, r, 'place of supply Tamil Nadu')).join('')}
        ${g1.cdnr.length ? row(`Credit notes to businesses (${g1.cdnr.length})`, cn) : ''}
        ${g1.at.length ? row('Advances received, not invoiced this month (11A)', sum(g1.at)) : ''}
        ${g1.atadj.length ? row('Advances of earlier months adjusted (11B)', sum(g1.atadj)) : ''}
        ${g1.nonGst ? `<tr><td>Non-GST supplies <small class="muted">liquor, under TN VAT</small></td><td class="n">${money(g1.nonGst)}</td><td colspan="3"></td></tr>` : ''}
      </tbody></table></div>
      ${g1.b2b.length ? `<details><summary class="small">B2B invoices</summary><div class="acc-scroll"><table class="acc-table"><tbody>${g1.b2b.map((x) => `<tr><td class="mono">${esc(x.number)}</td><td>${esc(showDate(x.date))}</td><td>${esc(x.name)} <small class="muted">${esc(x.gstin)}</small></td><td class="n">${money(x.value)}</td><td>${x.einvoiced ? tonePill('IRN', '--st-vacant') : ''}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
      <details><summary class="small">HSN / SAC summary and documents issued</summary><div class="acc-scroll"><table class="acc-table"><thead><tr><th>SAC</th><th>Description</th><th class="n">Rate</th><th class="n">Taxable</th><th class="n">CGST</th><th class="n">SGST</th></tr></thead><tbody>
        ${[...g1.hsnB2b.map((x) => ({ ...x, k: 'B2B' })), ...g1.hsnB2c.map((x) => ({ ...x, k: 'B2C' }))].map((x) => `<tr><td class="mono">${esc(x.sac)} <small class="muted">${x.k}</small></td><td>${esc(x.desc)}</td><td class="n">${x.rate}%</td><td class="n">${money(x.taxable)}</td><td class="n">${money(x.cgst)}</td><td class="n">${money(x.sgst)}</td></tr>`).join('')}
        </tbody></table><table class="acc-table"><thead><tr><th>Documents</th><th>From</th><th>To</th><th class="n">Issued</th><th class="n">Cancelled</th></tr></thead><tbody>
        ${g1.documents.map((x) => `<tr><td>${esc(x.nature)}</td><td class="mono">${esc(x.from)}</td><td class="mono">${esc(x.to)}</td><td class="n">${x.total}</td><td class="n">${x.cancelled}</td></tr>`).join('')}</tbody></table></div></details>

      <div class="sec-title">GSTR-3B</div>
      ${g3.from2b ? '' : '<div class="banner-note">GSTR-2B for this month is not imported: credit is shown from the bills by their date. Import GSTR-2B to claim only what the portal shows.</div>'}
      <div class="acc-scroll"><table class="acc-table">${head}<tbody>
        ${row('3.1(a) Outward taxable supplies', g3.outward, 'with advances')}
        ${row('3.1(d) Inward supplies under reverse charge', g3.rcm)}
        <tr><td>3.1(e) Non-GST outward supplies</td><td class="n">${money(g3.nonGst)}</td><td colspan="3"></td></tr>
        ${row('4(A)(3) Credit on reverse charge', g3.itc.rcm)}
        ${row('4(A)(5) Credit on bills in GSTR-2B', g3.itc.otherBills)}
        ${row('4(A)(5) Credit on OTA commission and card / UPI fees', g3.itc.otherOtaAndFees)}
        ${row(`4(B)(1) Reversed: ${g3.itc.reversalShare}% of turnover carries no credit`, g3.itc.reversal, 'rule 42: rooms up to ₹7,500 and restaurant at 5%, liquor')}
        ${row('4(C) Net credit', g3.itc.net)}
        ${g3.itc.ineligible.cgst + g3.itc.ineligible.sgst + g3.itc.ineligible.igst ? row('4(D) Not eligible (blocked)', g3.itc.ineligible) : ''}
        <tr><td>5 Inward at nil rate / outside GST (TASMAC)</td><td class="n">${money(g3.inward.nilRated)} / ${money(g3.inward.nonGst)}</td><td colspan="3"></td></tr>
        ${row('6.1 Tax payable', { ...g3.payment.liability })}
        ${row('6.1 Paid from credit', { ...g3.payment.creditUsed })}
        ${row('6.1 Paid in cash (reverse charge always in cash)', { ...g3.payment.cash })}
        ${row('Credit carried forward', { ...g3.payment.carriedForward })}
      </tbody><tfoot><tr><td colspan="4">Cash to pay</td><td class="n">${money(g3.payment.cashTotal)}</td></tr>
        ${g3.late.daysLate ? `<tr><td colspan="4">Late by ${g3.late.daysLate} days: late fee / interest</td><td class="n">${money(g3.late.lateFeePaise)} / ${money(g3.late.interestPaise)}</td></tr>` : ''}</tfoot></table></div>
      ${g3.rejectedBills.length ? `<p class="small fd-warn">Rejected in IMS, not claimed: ${g3.rejectedBills.map((b) => `${esc(b.vendor)} ${esc(b.bill_no)}`).join(', ')}</p>` : ''}

      <div class="sec-title">GSTR-2B and IMS</div>
      ${d.twoB.lines.length ? `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Supplier</th><th>Document</th><th class="n">Taxable</th><th class="n">Tax</th><th>Match</th><th>IMS</th></tr></thead><tbody>
        ${d.twoB.lines.map((l) => { const tax = Number(l.igst_paise) + Number(l.cgst_paise) + Number(l.sgst_paise); return `<tr><td>${esc(l.supplier_name ?? '')} <small class="muted">${esc(l.supplier_gstin)}</small></td><td class="mono">${esc(l.doc_no)} <small>${esc(l.doc_date ?? '')}</small></td>
          <td class="n">${money(Number(l.taxable_paise))}</td><td class="n">${money(tax)}</td><td>${tonePill(...(M2B[l.status] ?? [l.status, '--muted']))}${l.ota_payout ? ` <small>${esc(l.ota_payout)}</small>` : ''}${l.itc_available ? '' : ' <small class="fd-warn">credit not available</small>'}</td>
          <td>${l.bill_id ? `${tonePill(...(IMS[l.ims_action ?? 'pending']))}${file && !filed('GSTR3B') ? ` <button type="button" class="btn small" data-ims="${esc(l.bill_id)}">IMS…</button>` : ''}` : '<small class="muted">Not entered: get the bill, or reject it on the portal</small>'}</td></tr>` }).join('')}
      </tbody></table></div>` : '<div class="empty">No GSTR-2B imported for this month.</div>'}
      ${d.twoB.waiting.length ? `<p class="small muted">Bills not in any GSTR-2B yet (credit waits until the supplier files): ${d.twoB.waiting.map((w) => `${esc(w.vendor)} ${esc(w.bill_no)} (${money(Number(w.itc_paise))})`).join(' · ')}</p>` : ''}`
  }

  async change(el: HTMLElement) {
    if (el.matches('[data-period]')) { const v = (el as HTMLInputElement).value; if (!/^\d{4}-\d{2}$/.test(v)) return false; this.period = v; await this.load(); return true }
    if (el.matches('[data-2b]')) {
      const file = (el as HTMLInputElement).files?.[0]
      if (!file) return false
      const r = await this.h.api.post<{ lines: number; matched: number }>('/api/gst/2b/import', { period: this.period, text: await file.text(), fileName: file.name })
      toast(`${r.lines} supplier documents read; ${r.matched} matched to bills`)
      await this.load(); return true
    }
    return false
  }

  async click(el: HTMLElement) {
    const gen = el.closest<HTMLElement>('[data-irn-gen]')?.dataset.irnGen
    if (gen) {
      try { const r = await this.h.api.post<{ irn: string }>(`/api/tax-documents/${gen}/irn`); toast(`IRN ${r.irn.slice(0, 12)}… recorded`) } catch (e) { toast((e as Error).message) }
      await this.load(); return true
    }
    const js = el.closest<HTMLElement>('[data-irn-json]')
    if (js) {
      const j = await this.h.api.get(`/api/tax-documents/${js.dataset.irnJson}/irn-json`)
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 1)], { type: 'application/json' }))
      link.download = `${(js.dataset.irnNo ?? 'invoice').replace(/\//g, '-')}.json`
      link.click()
      return false
    }
    const rec = el.closest<HTMLElement>('[data-irn-rec]')
    if (rec) {
      this.h.modal.open(`Record the IRN · ${rec.dataset.irnNo}`, `<div class="form-grid">
          <label class="span2">IRN (64 characters)<input name="irn" maxlength="64" autocomplete="off" class="mono"></label>
          <label>Acknowledgement number<input name="ack" inputmode="numeric" autocomplete="off"></label><label>Acknowledgement date<input name="date" type="date" value="${esc(this.h.to)}"></label></div>
        <p class="muted small">Copy them from the e-invoice portal after uploading the JSON. The printed invoice then shows the IRN.</p>`, 'Save', async (f) => {
        await this.h.api.post(`/api/tax-documents/${rec.dataset.irnRec}/irn-manual`, { irn: val(f, 'irn'), ackNo: val(f, 'ack'), ackDate: val(f, 'date') })
        await this.load(); this.h.render()
        return 'IRN recorded'
      })
      return false
    }
    const a = el.closest<HTMLElement>('[data-gs]')?.dataset.gs
    if (a === 'json') {
      const j = await this.h.api.get(`/api/gst/${this.period}/gstr1.json`)
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 1)], { type: 'application/json' }))
      link.download = `GSTR1_${this.period}.json`
      link.click()
      return false
    }
    if (a === 'file1' || a === 'file3b') {
      const form = a === 'file1' ? 'GSTR1' : 'GSTR3B'
      this.h.modal.open(`${form === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} for ${this.period} filed`, `<p class="muted small">${form === 'GSTR3B' ? `Cash paid ${money(this.d!.gstr3b.payment.cashTotal)}. The set-off is posted to the books and this month's credit is closed: later changes go in the next return.` : 'The figures are kept as filed.'}</p>
        <div class="form-grid"><label>ARN<input name="arn" maxlength="20" autocapitalize="characters"></label><label>Filed on<input name="on" type="date" value="${esc(this.h.to)}"></label></div>`, 'Record as filed', async (f) => {
        await this.h.api.post('/api/gst/returns', { period: this.period, form, arn: val(f, 'arn'), filedOn: val(f, 'on') })
        await this.load(); this.h.render()
        return 'Recorded as filed'
      })
    }
    const ims = el.closest<HTMLElement>('[data-ims]')?.dataset.ims
    if (ims) {
      this.h.modal.open('Invoice Management System', `<p class="muted small">Do the same on the GST portal (IMS). A rejected invoice is not claimed; the supplier must correct it.</p>
        <div class="form-grid"><label>Action<select name="act"><option value="accepted">Accept</option><option value="rejected">Reject</option><option value="pending">Keep pending</option></select></label>
        <label class="span2">Reason (for a rejection)<input name="note" maxlength="200"></label></div>`, 'Save', async (f) => {
        await this.h.api.post(`/api/bills/${ims}/ims`, { action: val(f, 'act'), note: val(f, 'note') || undefined })
        await this.load(); this.h.render()
        return 'Saved'
      })
    }
    return false
  }
}
