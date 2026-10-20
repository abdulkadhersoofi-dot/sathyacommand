import { esc, toast, tonePill } from '../ui/dom'
import { val } from '../ui/form-modal'
import { money, type Host } from './books'

// OTAs (what each owes for bookings its guests paid it, and its payouts checked line by line) and the tax
// credits the resort can claim, matched with Form 26AS.

interface Ota { id: string; name: string; gstin: string | null; tan: string | null; commission_percent: number | null; owedPaise: number; unsettledPaise: number; unsettledBookings: number }
interface Booking { reservation_id: string; ota_ref: string | null; guest: string; arrival: string; departure: string; collected: number; paid_out: number; open: number }
interface Payout { id: string; number: string; ota: string; date: string; reference: string | null; gross_paise: string; commission_paise: string; commission_gst_paise: string; gst_tcs_paise: string; tds_paise: string; other_paise: string; net_paise: string; checks: string[]; voucher: string | null; lines: { line: number; ota_ref: string | null; guest: string | null; gross_paise: string }[] }

export class OtaView {
  private otas: Ota[] = []
  private sel = ''
  private open: Booking[] = []
  private payouts: Payout[] = []
  constructor(private h: Host) {}

  async load() {
    this.otas = (await this.h.cached<{ otas: Ota[] }>('/api/ota')).otas
    if (!this.otas.some((o) => o.id === this.sel)) this.sel = this.otas[0]?.id ?? ''
    this.open = this.sel ? await this.h.cached(`/api/ota/${this.sel}/bookings`) : []
    this.payouts = this.sel ? await this.h.cached(`/api/ota/payouts?debtorId=${this.sel}`) : []
  }

  html() {
    const o = this.otas.find((x) => x.id === this.sel), manage = this.h.can('receivables.manage')
    if (!o) return '<div class="empty">No OTA bookings paid to an OTA yet. Book with "Booked through" set to the OTA and its booking ID, and take the payment as "OTA prepaid".</div>'
    const n = (v: string) => Number(v)
    return `<div class="ws-toolbar"><select data-ota aria-label="OTA">${this.otas.map((x) => `<option value="${esc(x.id)}"${x.id === this.sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        ${manage ? `<label class="btn primary file-btn">Payout report (CSV)…<input type="file" accept=".csv,text/csv" data-payout hidden></label><button type="button" class="btn" data-ot="terms">Commission & TAN…</button>` : ''}</div>
      <div class="row-card mc-card"><div class="rc-title">${esc(o.name)} <small class="muted">${o.commission_percent == null ? 'commission not set' : `${o.commission_percent}% commission`}${o.tan ? ` · TAN ${esc(o.tan)}` : ''}</small></div>
        <div class="mc-figs"><span><small>Owed by ${esc(o.name)}</small><b class="mono">${money(o.owedPaise)}</b></span><span><small>Bookings not yet paid out</small><b class="mono">${o.unsettledBookings} · ${money(o.unsettledPaise)}</b></span></div></div>
      <div class="sec-title">Waiting for payout</div>
      ${this.open.length ? `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Booking ID</th><th>Guest</th><th>Stay</th><th class="n">Paid to the OTA</th><th class="n">Paid out</th><th class="n">To come</th></tr></thead><tbody>
        ${this.open.map((b) => `<tr><td class="mono">${esc(b.ota_ref ?? b.reservation_id)}</td><td>${esc(b.guest)}</td><td>${esc(b.arrival)} → ${esc(b.departure)}</td><td class="n">${money(b.collected)}</td><td class="n">${b.paid_out ? money(b.paid_out) : ''}</td><td class="n"><b>${money(b.open)}</b></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Every booking is paid out.</div>'}
      <div class="sec-title">Payouts</div>
      ${this.payouts.map((p) => `<div class="row-card acc-voucher"><div class="rc-title"><span class="mono">${esc(p.number)}</span> · ${esc(p.date)} · ${p.lines.length} booking${p.lines.length > 1 ? 's' : ''}${p.reference ? ` · ${esc(p.reference)}` : ''}</div>
        <div class="mc-figs"><span><small>Bookings</small><b class="mono">${money(n(p.gross_paise))}</b></span><span><small>Commission</small><b class="mono">${money(n(p.commission_paise) + n(p.other_paise))}</b></span>
          <span><small>GST on it</small><b class="mono">${money(n(p.commission_gst_paise))}</b></span><span><small>GST TCS</small><b class="mono">${money(n(p.gst_tcs_paise))}</b></span>
          <span><small>TDS 194-O</small><b class="mono">${money(n(p.tds_paise))}</b></span><span><small>Received</small><b class="mono">${money(n(p.net_paise))}</b></span></div>
        ${p.checks.length ? `<div class="rc-sub">${p.checks.map((c) => `<div class="fd-warn">${esc(c)}</div>`).join('')}</div>` : '<div class="rc-sub">Every booking agrees with what the guest paid and the agreed rates.</div>'}</div>`).join('') || '<div class="empty">No payouts recorded.</div>'}`
  }

  async change(el: HTMLElement) {
    if (el.matches('[data-ota]')) { this.sel = (el as HTMLSelectElement).value; await this.load(); return true }
    if (el.matches('[data-payout]')) {
      const file = (el as HTMLInputElement).files?.[0]
      if (!file) return false
      const csv = await file.text()
      const banks = await this.h.api.get<{ id: string; name: string; is_default: boolean; active: boolean }[]>('/api/bank-accounts')
      this.h.modal.open(`Payout: ${file.name}`, `<p class="muted small">The bookings, commission, GST on it, GST TCS and TDS are read from the report and checked against what each guest paid and the agreed rates.</p><div class="form-grid">
          <label>UTR (as on the bank statement)<input name="ref" maxlength="40"></label><label>Paid on<input name="date" type="date" value="${esc(this.h.to)}"></label>
          <label>Into<select name="bank">${banks.filter((b) => b.active).map((b) => `<option value="${esc(b.id)}"${b.is_default ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
          <label>Amount received (₹)<input name="net" type="number" step="0.01" min="0"></label>
          <label class="span2">Their commission invoice no.<input name="inv" maxlength="40"></label></div>`, 'Record payout', async (f) => {
        const r = await this.h.api.post<{ number: string; checks: string[] }>('/api/ota/payouts', { debtorId: this.sel, csv, reference: val(f, 'ref'), date: val(f, 'date'), bankAccountId: val(f, 'bank'),
          net: val(f, 'net') ? Number(val(f, 'net')) : undefined, commissionInvoice: val(f, 'inv') || undefined })
        await this.load(); this.h.render()
        return r.checks.length ? `${r.number} recorded: ${r.checks.length} thing${r.checks.length > 1 ? 's' : ''} to take up with the OTA` : `${r.number} recorded; everything agrees`
      })
      ;(el as HTMLInputElement).value = ''
    }
    return false
  }

  async click(el: HTMLElement) {
    if (el.closest('[data-ot=terms]')) {
      const o = this.otas.find((x) => x.id === this.sel)!
      this.h.modal.open(`${o.name}: terms`, `<div class="form-grid"><label>Commission (%)<input name="pct" type="number" min="0" max="50" step="0.01" value="${o.commission_percent ?? ''}"></label>
          <label>TAN (as in Form 26AS)<input name="tan" maxlength="10" value="${esc(o.tan ?? '')}"></label></div>`, 'Save', async (f) => {
        await this.h.api.req('PATCH', `/api/ota/${o.id}`, { commissionPercent: val(f, 'pct') === '' ? null : Number(val(f, 'pct')), tan: val(f, 'tan') || null })
        await this.load(); this.h.render()
        return 'Saved'
      })
    }
    return false
  }
}

interface CreditRow { kind: string; party: string; tan: string | null; quarter: number; sections: string[]; expectedPaise: number; in26asPaise: number; differencePaise: number; status: string; followUp: boolean }
interface Credits { fy: string; rows: CreditRow[]; notInBooks: { deductor: string; tan: string | null; section: string | null; date: string; tax_paise: number }[]; gstTcs: { party: string; date: string; tax: number; ref: string }[]; totals: { expectedPaise: number; in26asPaise: number; followUp: number }; imports: { file_name: string | null; lines: number; imported_at: string; imported_by_name: string }[] }
const STATUS: Record<string, [string, string]> = { matched: ['In 26AS', '--st-vacant'], short: ['Short in 26AS', '--st-departing'], missing: ['Not in 26AS yet', '--marigold'], more: ['More in 26AS', '--marigold'], not_in_books: ['Not in our books', '--muted'] }

export class CreditsView {
  private d: Credits | null = null
  private fy = ''
  constructor(private h: Host) {}
  async load() {
    this.fy ||= (() => { const y = Number(this.h.to.slice(0, 4)), m = Number(this.h.to.slice(5, 7)); const s = m >= 4 ? y : y - 1; return `${s}-${String(s + 1).slice(2)}` })()
    this.d = await this.h.cached(`/api/tax-credits?fy=${this.fy}`)
  }
  html() {
    const d = this.d!
    return `<div class="ws-toolbar"><label class="inline">Year <input data-fy value="${esc(this.fy)}" size="7" aria-label="Financial year"></label>
        ${this.h.can('accounts.post', 'receivables.manage') ? '<label class="btn primary file-btn">Import Form 26AS…<input type="file" accept=".csv,.txt,text/csv,text/plain" data-26as hidden></label>' : ''}
        <span class="small">Expected ${money(d.totals.expectedPaise)} · in 26AS ${money(d.totals.in26asPaise)}${d.totals.followUp ? ` · <span class="fd-warn">${d.totals.followUp} to follow up</span>` : ''}</span></div>
      <p class="muted small">Tax deducted or collected from the resort: TDS by companies and OTAs (194-O) when they pay, TCS by TASMAC on liquor. Each is claimed in the income-tax return once Form 26AS shows it; download 26AS from TRACES or the income-tax portal and import it here. A credit still missing after the deductor's return was due is to be followed up with them.</p>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Quarter</th><th>Deducted by</th><th>Section</th><th class="n">In our books</th><th class="n">In 26AS</th><th>Status</th></tr></thead><tbody>
        ${d.rows.map((r) => `<tr><td>Q${r.quarter}</td><td>${esc(r.party)}${r.tan ? ` <small class="muted">${esc(r.tan)}</small>` : ''} <small class="muted">${r.kind.toUpperCase()}</small></td><td>${esc(r.sections.join(', '))}</td>
          <td class="n">${money(r.expectedPaise)}</td><td class="n">${money(r.in26asPaise)}</td><td>${tonePill(...(STATUS[r.status] ?? [r.status, '--muted']))}${r.followUp ? ' <b class="fd-warn">follow up</b>' : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No credits this year.</td></tr>'}
      </tbody></table></div>
      ${d.notInBooks.length ? `<div class="sec-title">In 26AS, not in our books</div><div class="acc-scroll"><table class="acc-table"><tbody>${d.notInBooks.map((l) => `<tr><td class="mono">${esc(l.date)}</td><td>${esc(l.deductor)}</td><td>${esc(l.tan ?? '')}</td><td>${esc(l.section ?? '')}</td><td class="n">${money(l.tax_paise)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${d.gstTcs.length ? `<div class="sec-title">GST TCS by OTAs: accept in the GST portal</div><div class="acc-scroll"><table class="acc-table"><tbody>${d.gstTcs.map((g) => `<tr><td class="mono">${esc(g.date)}</td><td>${esc(g.party)}</td><td>${esc(g.ref)}</td><td class="n">${money(g.tax)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${d.imports.length ? `<p class="muted small">Imported: ${d.imports.map((i) => `${esc(i.file_name ?? 'file')} (${i.lines} lines, ${esc(i.imported_by_name)})`).join(' · ')}</p>` : ''}`
  }
  async change(el: HTMLElement) {
    if (el.matches('[data-fy]')) { const v = (el as HTMLInputElement).value.trim(); if (!/^\d{4}-\d{2}$/.test(v)) { toast('The year as 2026-27'); return false } this.fy = v; await this.load(); return true }
    if (el.matches('[data-26as]')) {
      const file = (el as HTMLInputElement).files?.[0]
      if (!file) return false
      const r = await this.h.api.post<{ added: number; duplicates: number }>('/api/form26as/import', { csv: await file.text(), fy: this.fy, fileName: file.name })
      toast(`${r.added} credits read${r.duplicates ? `, ${r.duplicates} already there` : ''}`)
      await this.load(); return true
    }
    return false
  }
  async click() { return false }
}
