import { esc, showDate } from '../ui/dom'
import type { WorkspaceHost } from '../ui/workspace'
import { money } from '../acc/books'
import { printForm16, printPayslips, type Employer, type Form16, type Slip } from '../hr/payslip'
import { declarationBody, declarationForm, taxSummary, type TaxView } from '../hr/tax'
import { t } from './i18n'

// The employee's own pay in the staff app: payslips for each approved month, the year's income tax with
// their declaration, and Form 16 Part B.

interface Mine { employee: { id: string; code: string; name: string; department: string } | null; employer: Employer; payslips: (Slip & { month: string; paid_on: string | null })[]; years: string[]; tax: TaxView }

export class MyPayView {
  private d: Mine | null = null
  constructor(private h: WorkspaceHost) {}
  async load() { this.d = await this.h.cached('/api/payroll/me') }
  html() {
    const d = this.d!
    if (!d.employee) return `<p class="empty">${esc(t('Your login is not linked to an employee record yet: ask HR.'))}</p>`
    return `<div class="sec-title">${esc(t('Payslips'))}</div>
      ${d.payslips.map((p) => `<div class="row-card"><div class="rc-title">${esc(p.monthName)}</div><div class="rc-sub">${esc(t('Net pay'))} <b class="mono">${money(p.net_paise)}</b> · ${p.paid_days} ${esc(t('days'))}${p.paid_on ? ` · ${esc(t('paid'))} ${esc(showDate(p.paid_on))}` : ''}</div>
        <div class="rc-right"><button type="button" class="btn small" data-slip="${esc(p.month)}">${esc(t('Open'))}</button></div></div>`).join('') || `<p class="empty">${esc(t('No payslip yet.'))}</p>`}
      <div class="sec-title">${esc(t('Income tax'))} ${esc(d.tax.fy)}</div>
      ${taxSummary(d.tax, t)}
      <div class="ws-toolbar"><button type="button" class="btn" data-mp="decl">${esc(t('My declaration'))}</button>${d.years.map((y) => `<button type="button" class="btn ghost" data-f16="${esc(y)}">Form 16 ${esc(y)}</button>`).join('')}</div>`
  }
  async click(el: HTMLElement) {
    const d = this.d!
    const m = el.closest<HTMLElement>('[data-slip]')?.dataset.slip
    if (m) { const p = d.payslips.find((x) => x.month === m)!; printPayslips([{ ...p, department: d.employee!.department }], d.employer, `Payslip ${m}`); return false }
    const fy = el.closest<HTMLElement>('[data-f16]')?.dataset.f16
    if (fy) { printForm16(await this.h.api.get<Form16>(`/api/payroll/form16/${d.employee!.id}?fy=${fy}`)); return false }
    if (el.closest('[data-mp=decl]')) {
      this.h.modal.open(t('My declaration'), declarationBody(d.tax, false, t), t('Save'), async (f) => {
        await this.h.api.req('PUT', `/api/payroll/declarations/${d.employee!.id}`, declarationForm(f, d.tax.fy, false))
        await this.load(); this.h.render(); return t('Saved')
      })
    }
    return false
  }
}
