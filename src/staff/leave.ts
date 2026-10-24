import { esc, tonePill } from '../ui/dom'
import { checked, confirmDanger, val } from '../ui/form-modal'
import { toolbar } from '../ui/toolbar'
import type { WorkspaceHost } from '../ui/workspace'
import { t } from './i18n'

// The employee's own leave in the staff app: balances, asking for leave, what was decided, the next holidays.

interface Mine { employee: { code: string; name: string; department: string; designation: string } | null; leaveTypes: Record<string, string>; balances: { type: string; name: string; balance: number }[]
  applications: { id: string; leave_type: string; from_date: string; to_date: string; days: string; status: string; reason: string | null; decision_note: string | null }[]; holidays: { day: string; name: string }[] }
export const LEAVE_TONE: Record<string, string> = { pending: '--marigold', approved: '--st-vacant', rejected: '--st-departing', cancelled: '--muted' }
const thisYear = String(new Date().getFullYear())
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(d.startsWith(thisYear) ? {} : { year: 'numeric' }), timeZone: 'UTC' })

export class MyLeaveView {
  private d: Mine | null = null
  constructor(private h: WorkspaceHost) {}
  async load() { this.d = await this.h.cached('/api/hr/me') }
  html() {
    const d = this.d!
    if (!d.employee) return `<p class="empty">${esc(t('Your login is not linked to an employee record yet: ask HR.'))}</p>`
    return `${toolbar({ primary: [{ attrs: 'data-ml="apply"', label: t('Ask for leave') }] })}
      <div class="row-card mc-card"><div class="mc-figs">${d.balances.filter((b) => b.balance || ['CL', 'SL', 'EL'].includes(b.type)).map((b) => `<span><small>${esc(b.name)}</small><b class="mono">${b.balance}</b></span>`).join('')}</div></div>
      <div class="sec-title">${esc(t('My leave'))}</div>
      ${d.applications.map((a) => `<div class="row-card"><div class="rc-title">${esc(d.leaveTypes[a.leave_type] ?? a.leave_type)} · ${day(a.from_date)}${a.to_date !== a.from_date ? ` – ${day(a.to_date)}` : ''}</div>
        <div class="rc-sub">${Number(a.days)} ${esc(t('days'))}${a.reason ? ` · ${esc(a.reason)}` : ''}${a.decision_note ? ` · <i>${esc(a.decision_note)}</i>` : ''}</div>
        <div class="rc-right">${tonePill(t(a.status[0].toUpperCase() + a.status.slice(1)), LEAVE_TONE[a.status])}${['pending', 'approved'].includes(a.status) ? `<button type="button" class="btn small ghost" data-mlc="${esc(a.id)}">${esc(t('Cancel'))}</button>` : ''}</div></div>`).join('') || `<p class="empty">${esc(t('No leave asked for yet.'))}</p>`}
      ${d.holidays.length ? `<div class="sec-title">${esc(t('Holidays'))}</div><div class="m-table">${d.holidays.map((h) => `<div class="m-row ml-hol"><span>${day(h.day)}</span><span>${esc(h.name)}</span></div>`).join('')}</div>` : ''}`
  }
  async click(el: HTMLElement) {
    const d = this.d!
    const c = el.closest<HTMLElement>('[data-mlc]')?.dataset.mlc
    if (c) { confirmDanger(this.h.modal, t('Withdraw this leave?'), t('The days go back to your balance.'), t('Withdraw it'), async () => { await this.h.api.post(`/api/hr/leave/applications/${c}/cancel`); await this.load(); this.h.render(); return t('Withdrawn') }, t('Keep it')); return false }
    if (el.closest('[data-ml=apply]')) {
      this.h.modal.open(t('Ask for leave'), `<div class="form-grid"><label class="span2">${esc(t('Leave type'))}<select name="type">${d.balances.map((b) => `<option value="${esc(b.type)}">${esc(b.name)} (${b.balance})</option>`).join('')}<option value="LOP">${esc(d.leaveTypes.LOP ?? 'Leave without pay')}</option></select></label>
          <label>${esc(t('From'))}<input name="from" type="date"></label><label>${esc(t('To'))}<input name="to" type="date"></label>
          <label class="span2 check"><input type="checkbox" name="half"> ${esc(t('Half day'))}</label><label class="span2">${esc(t('Reason'))}<input name="reason" maxlength="300"></label></div>`, t('Send'), async (f) => {
        const from = val(f, 'from')
        await this.h.api.post('/api/hr/leave/applications', { leaveType: val(f, 'type'), from, to: val(f, 'to') || from, halfDay: checked(f, 'half'), reason: val(f, 'reason') })
        await this.load(); this.h.render(); return t('Sent for approval')
      })
    }
    return false
  }
}
