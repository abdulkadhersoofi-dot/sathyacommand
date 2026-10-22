import { esc, tonePill, showDate } from '../ui/dom'
import { toolbar } from '../ui/toolbar'
import { val } from '../ui/form-modal'
import { money, type Host } from './books'

// TDS and income tax: deposits due and made, the quarterly statement, lower-deduction certificates, advance
// tax, and the calendar of tax dates ahead.

interface Month { month: string; entries: number; deductedPaise: number; depositedPaise: number; openPaise: number; due: string; status: string; interestNowPaise: number; challans: { bsr_code: string; challan_no: string; paid_on: string; total_paise: string }[] }
interface Deductee { sr: number; name: string; pan: string; sectionCode: string; section: string; paidOn: string; amountPaise: number; tdsPaise: number; rate: number; reason: string | null; certificate: string | null; challan: string | null }
interface Q26 { fy: string; quarter: number; due: string; filed: { token_no: string; filed_on: string } | null; deductor: { tan: string | null; name: string; responsible: string | null; designation?: string | null }; deductees: Deductee[]; totals: { amountPaise: number; tdsPaise: number; deductees: number }; late: { daysLate: number; feePaise: number }; problems: string[] }
interface Ldc { id: string; vendor: string; cert_no: string; section: string; rate: string; limit_paise: string; used_paise: string; valid_from: string; valid_to: string }
interface Adv { estimatePaise: number; instalments: { due: string; percent: number; requiredPaise: number; paidByThenPaise: number; shortfallPaise: number }[]; paidPaise: number }
interface Due { due: string; what: string; amountPaise: number | null; status: string }

const STATUS: Record<string, [string, string]> = { paid: ['Deposited', '--st-vacant'], paid_late: ['Deposited late', '--marigold'], due: ['Due', '--marigold'], overdue: ['Overdue', '--st-departing'], done: ['Done', '--st-vacant'] }
const fyOf = (d: string) => { const y = Number(d.slice(0, 4)), s = Number(d.slice(5, 7)) >= 4 ? y : y - 1; return `${s}-${String(s + 1).slice(2)}` }
const quarterOf = (d: string) => { const m = Number(d.slice(5, 7)); return m >= 4 && m <= 6 ? 1 : m <= 9 && m >= 7 ? 2 : m >= 10 ? 3 : 4 }

export class TdsView {
  private fy = ''
  private q = 1
  private months: Month[] = []
  private s: Q26 | null = null
  private ldc: Ldc[] = []
  private adv: Adv | null = null
  private cal: Due[] = []
  constructor(private h: Host) {}

  async load() {
    if (!this.fy) { this.fy = fyOf(this.h.to); const pq = quarterOf(this.h.to); this.q = pq === 1 ? 4 : pq - 1; if (pq === 1) this.fy = `${Number(this.fy.slice(0, 4)) - 1}-${this.fy.slice(2, 4)}` }
    this.months = (await this.h.cached<{ months: Month[] }>(`/api/tds/deposits?fy=${this.fy}`)).months
    this.s = await this.h.cached(`/api/tds/26q?fy=${this.fy}&quarter=${this.q}`)
    this.ldc = await this.h.cached('/api/ldc')
    this.adv = await this.h.cached(`/api/tax/advance?fy=${this.fy}`)
    this.cal = await this.h.cached('/api/tax/calendar')
  }

  html() {
    const s = this.s!, manage = this.h.can('tds.manage'), a = this.adv!
    return `${toolbar({
      filters: `<label class="inline">Year <input data-fy value="${esc(this.fy)}" size="7"></label>
        <label class="inline">Quarter <select data-q>${[1, 2, 3, 4].map((q) => `<option value="${q}"${q === this.q ? ' selected' : ''}>Q${q}</option>`).join('')}</select></label>`,
      more: manage ? [{ attrs: 'data-td="deductor"', label: 'TAN and responsible person…' }] : [],
    })}

      <div class="sec-title">Coming up</div>
      ${this.cal.length ? `<div class="acc-scroll"><table class="acc-table"><tbody>${this.cal.map((c) => `<tr><td class="mono">${esc(showDate(c.due))}</td><td>${esc(c.what)}</td><td class="n">${c.amountPaise ? money(c.amountPaise) : ''}</td><td>${tonePill(...(STATUS[c.status] ?? [c.status, '--muted']))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nothing due in the next weeks.</div>'}

      <div class="sec-title">TDS to deposit, month by month</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Deducted in</th><th class="n">Deducted</th><th class="n">Deposited</th><th>Due</th><th>Status</th><th>Challans</th><th></th></tr></thead><tbody>
        ${this.months.map((m) => `<tr><td>${esc(m.month)} <small class="muted">${m.entries} payment${m.entries > 1 ? 's' : ''}</small></td><td class="n">${money(m.deductedPaise)}</td><td class="n">${money(m.depositedPaise)}</td><td>${esc(showDate(m.due))}</td>
          <td>${tonePill(...(STATUS[m.status] ?? [m.status, '--muted']))}${m.interestNowPaise ? ` <small class="fd-warn">interest ${money(m.interestNowPaise)} so far</small>` : ''}</td>
          <td><small>${m.challans.map((c) => `${esc(c.bsr_code)}/${esc(showDate(c.paid_on))}/${esc(c.challan_no)}`).join(', ')}</small></td>
          <td>${m.openPaise && manage ? `<button type="button" class="btn small primary" data-pay="${esc(m.month)}">Deposited…</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No tax deducted this year.</td></tr>'}
      </tbody></table></div>

      <div class="sec-title">Quarterly statement 26Q: ${esc(s.fy)} Q${s.quarter} <span>due ${esc(showDate(s.due))}</span></div>
      ${toolbar({
        primary: manage && !s.filed ? [{ attrs: 'data-td="file"', label: 'Filed…' }] : [],
        more: [{ attrs: 'data-td="csv"', label: 'Statement data (CSV)' }],
        end: `${s.filed ? tonePill(`Filed ${s.filed.filed_on} · token ${s.filed.token_no}`, '--st-vacant') : tonePill('Not filed', '--marigold')}${s.late.daysLate ? ` <span class="small fd-warn">${s.late.daysLate} days late: fee ${money(s.late.feePaise)}</span>` : ''}`,
      })}
      ${s.problems.length ? `<div class="banner-note">${s.problems.map(esc).join('<br>')}</div>` : ''}
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Deductee</th><th>PAN</th><th>Section</th><th>Date</th><th class="n">Paid</th><th class="n">Rate</th><th class="n">TDS</th><th>Challan</th><th></th></tr></thead><tbody>
        ${s.deductees.map((d) => `<tr><td>${esc(d.name)}</td><td class="mono">${esc(d.pan)}</td><td>${esc(d.sectionCode)}${d.reason ? ` <small class="muted">${d.reason === 'A' ? `lower (${esc(d.certificate ?? '')})` : 'no PAN'}</small>` : ''}</td><td>${esc(showDate(d.paidOn))}</td>
          <td class="n">${money(d.amountPaise)}</td><td class="n">${d.rate}%</td><td class="n">${money(d.tdsPaise)}</td><td><small>${esc(d.challan ?? 'not deposited')}</small></td>
          <td><button type="button" class="btn small" data-stmt="${esc(d.name)}">Statement</button></td></tr>`).join('') || '<tr><td colspan="9" class="empty">Nothing deducted this quarter.</td></tr>'}
      </tbody><tfoot><tr><td colspan="4">${s.totals.deductees} deductees</td><td class="n">${money(s.totals.amountPaise)}</td><td></td><td class="n">${money(s.totals.tdsPaise)}</td><td colspan="2"></td></tr></tfoot></table></div>

      <div class="sec-title">Lower-deduction certificates (section 197)</div>
      ${toolbar({ primary: manage ? [{ attrs: 'data-td="ldc"', label: 'Add a certificate…' }] : [] })}
      ${this.ldc.length ? `<div class="acc-scroll"><table class="acc-table"><tbody>${this.ldc.map((l) => `<tr><td class="mono">${esc(l.cert_no)}</td><td>${esc(l.vendor)}</td><td>${esc(l.section)} at ${Number(l.rate)}%</td><td class="n">${money(Number(l.used_paise))} of ${money(Number(l.limit_paise))}</td><td>${esc(showDate(l.valid_from))} to ${esc(showDate(l.valid_to))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">None.</div>'}

      <div class="sec-title">Advance income tax ${esc(this.fy)}</div>
      ${toolbar({ primary: manage ? [{ attrs: 'data-td="advance"', label: 'Advance tax paid…' }] : [], more: manage ? [{ attrs: 'data-td="estimate"', label: 'Estimate for the year…' }] : [] })}
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>By</th><th class="n">Share</th><th class="n">Required</th><th class="n">Paid by then</th><th class="n">Short</th></tr></thead><tbody>
        ${a.instalments.map((i) => `<tr><td>${esc(showDate(i.due))}</td><td class="n">${i.percent}%</td><td class="n">${money(i.requiredPaise)}</td><td class="n">${money(i.paidByThenPaise)}</td><td class="n ${i.shortfallPaise ? 'fd-warn' : ''}">${money(i.shortfallPaise)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="2">Estimated tax ${money(a.estimatePaise)}</td><td colspan="3" class="n">Paid ${money(a.paidPaise)}</td></tr></tfoot></table></div>`
  }

  async change(el: HTMLElement) {
    if (el.matches('[data-fy]')) { const v = (el as HTMLInputElement).value.trim(); if (!/^\d{4}-\d{2}$/.test(v)) return false; this.fy = v; await this.load(); return true }
    if (el.matches('[data-q]')) { this.q = Number((el as HTMLSelectElement).value); await this.load(); return true }
    return false
  }

  async click(el: HTMLElement) {
    const done = async (msg: string) => { await this.load(); this.h.render(); return msg }
    const month = el.closest<HTMLElement>('[data-pay]')?.dataset.pay
    if (month) {
      const m = this.months.find((x) => x.month === month)!
      this.h.modal.open(`TDS for ${month} deposited`, `<p class="muted small">${money(m.openPaise)} deducted, due ${esc(showDate(m.due))}. Interest for paying late (1.5% a month or part, from each deduction) is worked out from the date paid.</p>
        <div class="form-grid"><label>BSR code<input name="bsr" maxlength="7" inputmode="numeric"></label><label>Challan serial<input name="no" maxlength="5" inputmode="numeric"></label>
        <label>Paid on<input name="on" type="date" value="${esc(this.h.to)}"></label></div>`, 'Record', async (f) => {
        const r = await this.h.api.post<{ totalPaise: number; interestPaise: number }>('/api/tds/challans', { month, bsrCode: val(f, 'bsr'), challanNo: val(f, 'no'), paidOn: val(f, 'on') })
        return done(`Recorded ${money(r.totalPaise)}${r.interestPaise ? ` (interest ${money(r.interestPaise)})` : ''}`)
      })
    }
    const stmt = el.closest<HTMLElement>('[data-stmt]')?.dataset.stmt
    if (stmt) {
      const vendors = await this.h.api.get<{ id: string; name: string }[]>('/api/vendors?all=1')
      const v = vendors.find((x) => x.name === stmt)
      if (v) await this.h.api.openDocument(`/api/tds/statement/${v.id}?fy=${this.fy}&quarter=${this.q}`)
    }
    const a = el.closest<HTMLElement>('[data-td]')?.dataset.td
    if (a === 'csv') {
      const csv = await this.h.api.req<string>('GET', `/api/tds/26q.csv?fy=${this.fy}&quarter=${this.q}`)
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
      link.download = `26Q_${this.fy}_Q${this.q}.csv`
      link.click()
    }
    if (a === 'file') this.h.modal.open(`26Q ${this.fy} Q${this.q} filed`, `<div class="form-grid"><label>Token number (15 digits)<input name="token" maxlength="15" inputmode="numeric"></label><label>Filed on<input name="on" type="date" value="${esc(this.h.to)}"></label></div>`, 'Record', async (f) => {
      const r = await this.h.api.post<{ lateFeePaise: number }>('/api/tds/returns', { fy: this.fy, quarter: this.q, tokenNo: val(f, 'token'), filedOn: val(f, 'on') })
      return done(r.lateFeePaise ? `Recorded; late fee ${money(r.lateFeePaise)} to pay` : 'Recorded')
    })
    if (a === 'deductor') this.h.modal.open('The resort as deductor', `<div class="form-grid"><label>TAN<input name="tan" maxlength="10" value="${esc(this.s?.deductor.tan ?? '')}"></label>
        <label>Person responsible<input name="who" maxlength="120" value="${esc(this.s?.deductor.responsible ?? '')}"></label><label>Designation<input name="des" maxlength="80" value="${esc(this.s?.deductor.designation ?? '')}"></label></div>`, 'Save', async (f) => {
      await this.h.api.req('PATCH', '/api/tds/deductor', { tan: val(f, 'tan'), responsible: val(f, 'who'), designation: val(f, 'des') || undefined })
      return done('Saved')
    })
    if (a === 'ldc') {
      const vendors = (await this.h.api.get<{ id: string; name: string; pan: string | null; tds_code: string | null }[]>('/api/vendors?all=1')).filter((v) => v.pan && v.tds_code)
      this.h.modal.open('Lower-deduction certificate', `<div class="form-grid"><label class="span2">Vendor<select name="v">${vendors.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label>
          <label>Certificate no.<input name="no" maxlength="20"></label><label>Section<input name="sec" maxlength="8" placeholder="194J"></label><label>Rate (%)<input name="rate" type="number" min="0" max="30" step="0.01"></label>
          <label>Amount covered (₹)<input name="limit" type="number" min="1"></label><label>Valid from<input name="from" type="date"></label><label>Valid to<input name="to" type="date"></label></div>`, 'Add', async (f) => {
        await this.h.api.post('/api/ldc', { vendorId: val(f, 'v'), certNo: val(f, 'no'), section: val(f, 'sec'), rate: Number(val(f, 'rate')), limit: Number(val(f, 'limit')), validFrom: val(f, 'from'), validTo: val(f, 'to') })
        return done('Certificate added')
      })
    }
    if (a === 'estimate') this.h.modal.open(`Estimated income tax ${this.fy}`, `<div class="form-grid"><label>Tax for the year (₹)<input name="tax" type="number" min="0" value="${(this.adv?.estimatePaise ?? 0) / 100 || ''}"></label><label class="span2">Basis<input name="note" maxlength="200" placeholder="e.g. CA's estimate, September"></label></div>`, 'Save', async (f) => {
      await this.h.api.req('PUT', '/api/tax/estimate', { fy: this.fy, estimatedTax: Number(val(f, 'tax')), note: val(f, 'note') || undefined })
      return done('Saved')
    })
    if (a === 'advance') this.h.modal.open('Advance tax paid', `<div class="form-grid"><label>Amount (₹)<input name="amt" type="number" min="1"></label><label>BSR code<input name="bsr" maxlength="7"></label><label>Challan serial<input name="no" maxlength="5"></label><label>Paid on<input name="on" type="date" value="${esc(this.h.to)}"></label></div>`, 'Record', async (f) => {
      await this.h.api.post('/api/tax/advance', { amount: Number(val(f, 'amt')), bsrCode: val(f, 'bsr'), challanNo: val(f, 'no'), paidOn: val(f, 'on') })
      return done('Recorded')
    })
    return false
  }
}
