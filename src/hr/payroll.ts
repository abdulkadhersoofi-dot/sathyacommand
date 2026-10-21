import { esc, toast, tonePill, showDate } from '../ui/dom'
import { val } from '../ui/form-modal'
import type { View, WorkspaceHost } from '../ui/workspace'
import { money } from '../acc/books'
import { printPayslips } from './payslip'

// Payroll: a month's run from pay structures, attendance and leave; HR's changes for a person; the GM's
// check and the MD's approval; payslips, the bank's transfer file, the EPFO and ESIC files, and the
// statutory dues with what has been paid.

interface RunRow { id: string; month: string; status: string; people: number; grossPaise: number; netPaise: number }
interface Line { employee_id: string; code: string; name: string; department: string; designation: string; uan: string | null; esic_ip: string | null; pan: string | null; bank_account: string | null; ifsc: string | null
  lop_set: number | null; ot_set: number | null; other_earnings_paise: number; note: string | null; lop_days: number; ot_hours: number; employed_days: number; paid_days: number; absent_days: number; leave_lop_days: number
  basic_paise: number; da_paise: number; hra_paise: number; conveyance_paise: number; special_paise: number; other_paise: number; overtime_paise: number; gross_paise: number; wages_paise: number
  pf_employee_paise: number; eps_paise: number; pf_employer_paise: number; edli_paise: number; esi_covered: boolean; esi_employee_paise: number; esi_employer_paise: number; pt_paise: number
  lwf_employee_paise: number; lwf_employer_paise: number; tds_paise: number; other_deductions_paise: number; advance_recovery_paise: number; net_paise: number; net_words: string; bonus_provision_paise: number; gratuity_provision_paise: number; warnings: string[] }
interface Run { id: string; month: string; monthName: string; status: string; days_in_month: number; sent_back_note: string | null; paid_on: string | null; pay_reference: string | null
  lines: Line[]; totals: Record<string, number>; dues: { kind: string; name: string; amount: number; due: string; paid: number }[]; missing: { id: string; code: string; name: string }[]; pendingLeave: number
  people: { createdBy: string | null; submittedBy: string | null; checkedBy: string | null; approvedBy: string | null }; employer: { name: string; address: string }; today: string; banks: { name: string; account_code: string }[] }

interface Compare { uploadedAt: string; by: string; fields: string[]; people: { code: string; name: string; missing: string | null; diffs: { field: string; system: number; theirs: number; diff: number }[]; matched: boolean }[]; matched: number; total: number; allMatch: boolean }
export interface Advance { id: string; employee_id: string; name: string; code: string; kind: string; amount_paise: number; instalment_paise: number; reason: string; status: string; issued_on: string | null; requested_by: string; decided_by: string | null; outstandingPaise: number }
export interface Settlement { id: string; employee_id: string; name: string; code: string; last_day: string; items: { key: string; label: string; amount_paise: number; detail: string }[]; net_paise: number; net_words: string; status: string; note: string | null; paid_on: string | null; created_by: string; approved_by: string | null }
export const PAY_TONE: Record<string, string> = { draft: '--muted', submitted: '--marigold', checked: '--marigold', approved: '--st-vacant', paid: '--st-vacant' }
const STATUS: Record<string, string> = { draft: 'Draft', submitted: 'With the GM', checked: 'With the MD', approved: 'Approved', paid: 'Paid' }
const download = (name: string, text: string, type: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
}
/** Notes explain a figure; warnings need someone to act. */
const needsLook = (l: Line) => l.warnings.filter((w) => !w.startsWith('Note:'))
const fyNow = () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return y }
const fys = () => [0, 1, 2].map((k) => { const y = fyNow() - k; const v = `${y}-${String((y + 1) % 100).padStart(2, '0')}`; return `<option value="${v}">${v}</option>` }).join('')
const quarterNow = () => { const m = new Date().getMonth(); return m >= 3 ? Math.floor((m - 3) / 3) + 1 : 4 }
const lastMonth = () => { const d = new Date(); d.setUTCDate(0); return d.toISOString().slice(0, 7) }

export class PayrollView implements View {
  private runs: RunRow[] = []
  private run: Run | null = null
  private compare: Compare | null = null
  private advances: Advance[] = []
  private settlements: Settlement[] = []
  private parallel: { months: { month: string; matched: number; total: number; allMatch: boolean }[]; monthsMatched: number; needed: number } | null = null
  private selected: string | null = null
  constructor(private h: WorkspaceHost & { cfg: { departments: Record<string, { name: string }> } }) {}
  async load() {
    if (this.selected) {
      this.run = await this.h.cached(`/api/payroll/runs/${this.selected}`)
      this.compare = await this.h.cached(`/api/payroll/runs/${this.selected}/compare`)
      return
    }
    ;[this.runs, this.advances, this.settlements, this.parallel] = await Promise.all([this.h.cached<RunRow[]>('/api/payroll/runs'), this.h.cached<Advance[]>('/api/payroll/advances'),
      this.h.cached<Settlement[]>('/api/payroll/settlements'), this.h.cached<PayrollView['parallel']>('/api/payroll/parallel')])
  }
  private async reload() { await this.load(); this.h.render() }
  html() { return this.selected && this.run ? this.detail(this.run) : this.list() }

  private list() {
    return `<div class="ws-toolbar">${this.h.can('payroll.run') ? `<label class="inline">Month <input type="month" data-pm value="${lastMonth()}"></label><button type="button" class="btn primary" data-pr="new">Run payroll</button>` : ''}</div>
      <p class="muted small">Each month's pay from the pay structures, attendance and leave, with PF, ESI, professional tax and the labour welfare fund. HR submits it, the GM checks it, the MD approves it, accounts pay it.</p>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Month</th><th>Status</th><th class="n">People</th><th class="n">Gross pay</th><th class="n">Net pay</th></tr></thead><tbody>
        ${this.runs.map((r) => `<tr><td><button type="button" class="linkish" data-run="${esc(r.id)}">${esc(new Date(`${r.month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }))}</button></td>
          <td>${tonePill(STATUS[r.status] ?? r.status, PAY_TONE[r.status] ?? '--muted')}</td><td class="n">${r.people}</td><td class="n">${money(r.grossPaise)}</td><td class="n">${money(r.netPaise)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No payroll run yet.</td></tr>'}
      </tbody></table></div>
      ${this.requests()}
      <div class="sec-title">Returns and the parallel run</div>
      <div class="ws-toolbar">${this.h.can('payroll.run', 'payroll.pay', 'payroll.view') ? `<label class="inline">24Q for <select data-q24fy>${fys()}</select><select data-q24q>${[1, 2, 3, 4].map((q) => `<option value="${q}" ${q === quarterNow() ? 'selected' : ''}>Q${q}</option>`).join('')}</select></label><button type="button" class="btn" data-pr="24q">Download 24Q figures</button>` : ''}</div>
      ${this.parallel ? `<p class="small">${this.parallel.monthsMatched >= this.parallel.needed ? tonePill('Parallel run done', '--st-vacant') : tonePill(`Parallel run: ${this.parallel.monthsMatched} of ${this.parallel.needed} months matched`, '--marigold')}
        ${this.parallel.months.map((m) => ` · ${esc(m.month)}: ${m.matched} of ${m.total} people match`).join('')}</p><p class="muted small">Open a month and use <b>Compare with current payroll</b> to put the figures from today's payroll beside the system's.</p>` : ''}`
  }

  private requests() {
    const h = this.h
    const adv = this.advances.filter((a) => ['pending', 'approved'].includes(a.status))
    const fnf = this.settlements.filter((s) => ['draft', 'approved'].includes(s.status))
    if (!adv.length && !fnf.length) return ''
    return `<div class="sec-title">Waiting</div>
      ${adv.map((a) => `<div class="row-card"><div class="rc-title">Salary ${esc(a.kind)} · ${esc(a.name)} <small class="muted mono">${esc(a.code)}</small> · ${money(a.amount_paise)}</div>
        <div class="rc-sub">${money(a.instalment_paise)} a month · ${esc(a.reason)} · asked by ${esc(a.requested_by)}</div>
        <div class="rc-right">${a.status === 'pending' ? (h.can('payroll.approve') ? `<button type="button" class="btn small primary" data-adv="${esc(a.id)}|approve">Approve</button><button type="button" class="btn small" data-adv="${esc(a.id)}|reject">Turn down</button>` : tonePill('With the GM', '--marigold'))
          : h.can('payroll.pay') ? `<button type="button" class="btn small primary" data-adv="${esc(a.id)}|issue">Paid…</button>` : tonePill('To be paid by accounts', '--marigold')}</div></div>`).join('')}
      ${fnf.map((x) => `<div class="row-card"><div class="rc-title">Full and final · ${esc(x.name)} <small class="muted mono">${esc(x.code)}</small> · ${money(x.net_paise)}</div>
        <div class="rc-sub">last day ${esc(showDate(x.last_day))} · ${x.items.map((i) => `${esc(i.label)} ${money(i.amount_paise)}`).join(' · ')}</div>
        <div class="rc-right">${x.status === 'draft' ? (h.can('payroll.approve') ? `<button type="button" class="btn small primary" data-fnf="${esc(x.id)}|approve">Approve</button>` : tonePill('With the GM', '--marigold')) + (h.can('payroll.run') ? `<button type="button" class="btn small ghost" data-fnf="${esc(x.id)}|cancel">Cancel</button>` : '')
          : x.net_paise > 0 && h.can('payroll.pay') ? `<button type="button" class="btn small primary" data-fnf="${esc(x.id)}|pay">Paid…</button>` : tonePill(x.net_paise > 0 ? 'To be paid' : 'They owe the resort', '--marigold')}</div></div>`).join('')}`
  }

  private compared(c: Compare) {
    return `<div class="sec-title">Compared with the current payroll ${c.allMatch ? tonePill('Every figure matches', '--st-vacant') : tonePill(`${c.matched} of ${c.total} people match`, '--marigold')}</div>
      <p class="muted small">Uploaded by ${esc(c.by)} · within ₹1 counts as a match.</p>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Code</th><th>Name</th>${c.fields.map((f) => `<th class="n">${esc(f.toUpperCase())}</th>`).join('')}<th></th></tr></thead><tbody>
        ${c.people.filter((p) => !p.matched).map((p) => `<tr><td class="mono">${esc(p.code)}</td><td>${esc(p.name)}</td>${p.missing ? `<td colspan="${c.fields.length}" class="fd-warn">${esc(p.missing)}</td>`
          : c.fields.map((f) => { const d = p.diffs.find((x) => x.field === f)!; return `<td class="n">${Math.abs(d.diff) > 100 ? `<span class="fd-warn" title="system ${money(d.system)}, current ${money(d.theirs)}">${d.diff > 0 ? '+' : ''}${money(d.diff)}</span>` : '✓'}</td>` }).join('')}<td></td></tr>`).join('') || `<tr><td colspan="${c.fields.length + 3}" class="empty">Everyone matches.</td></tr>`}
      </tbody></table></div>`
  }

  private detail(r: Run) {
    const t = r.totals, h = this.h
    const deductions = t.pf_employee + t.esi_employee + t.pt + t.lwf_employee + t.tds + t.other_deductions
    const employer = t.eps + t.pf_employer + t.edli + t.pf_admin + t.esi_employer + t.lwf_employer + t.bonus_provision + t.gratuity_provision
    const btn = (a: string, label: string, cls = '') => `<button type="button" class="btn ${cls}" data-pr="${a}">${label}</button>`
    const acts: string[] = []
    if (r.status === 'draft' && h.can('payroll.run')) acts.push(btn('recalc', 'Work out again'), btn('submit', 'Submit for approval', 'primary'), btn('cancel', 'Cancel run', 'ghost'))
    if (r.status === 'submitted' && h.can('payroll.approve') && !h.me.permissions.includes('*')) acts.push(btn('check', 'Checked: send to the MD', 'primary'))
    if (['submitted', 'checked'].includes(r.status) && h.me.permissions.includes('*')) acts.push(btn('approve', 'Approve', 'primary'))
    if (['submitted', 'checked'].includes(r.status) && h.can('payroll.approve')) acts.push(btn('back', 'Send back…', 'ghost'))
    if (r.status === 'approved' && h.can('payroll.pay')) acts.push(btn('bank', 'Bank transfer file'), btn('pay', 'Salaries paid…', 'primary'))
    if (r.status === 'paid' && h.can('payroll.pay')) acts.push(btn('bank', 'Bank transfer file'))
    if (h.can('payroll.run', 'payroll.pay')) acts.push(btn('ecr', 'EPFO ECR file'), btn('esi', 'ESIC file'))
    acts.push(btn('slips', 'Payslips'))
    if (h.can('payroll.run', 'payroll.view')) acts.push(btn('compare', 'Compare with current payroll'))
    const who = [r.people.createdBy && `prepared by ${r.people.createdBy}`, r.people.submittedBy && `submitted by ${r.people.submittedBy}`, r.people.checkedBy && `checked by ${r.people.checkedBy}`, r.people.approvedBy && `approved by ${r.people.approvedBy}`,
      r.paid_on && `paid on ${r.paid_on}${r.pay_reference ? ` (${r.pay_reference})` : ''}`].filter(Boolean).join(' · ')
    const warned = r.lines.filter((l) => needsLook(l).length).length
    const kpi = (l: string, v: string) => `<div class="kpi"><div class="kpi-l">${l}</div><div class="kpi-v">${v}</div></div>`
    const dep = (k: string) => this.h.cfg.departments[k]?.name ?? k
    return `<div class="ws-toolbar"><button type="button" class="btn ghost" data-pr="list">← All months</button>${acts.join('')}</div>
      <div class="bq-head"><div><h2>Payroll · ${esc(r.monthName)}</h2><div class="small muted">${r.days_in_month} days · ${esc(who)}</div></div><div class="rc-right">${tonePill(STATUS[r.status] ?? r.status, PAY_TONE[r.status] ?? '--muted')}</div></div>
      ${r.sent_back_note && r.status === 'draft' ? `<p class="fd-warn">Sent back: ${esc(r.sent_back_note)}</p>` : ''}
      ${r.missing.length ? `<p class="fd-warn">No pay structure, so not in this payroll: ${r.missing.map((m) => `${esc(m.name)} (${esc(m.code)})`).join(', ')}.</p>` : ''}
      ${r.pendingLeave && r.status === 'draft' ? `<p class="fd-warn">${r.pendingLeave} leave application${r.pendingLeave > 1 ? 's' : ''} in this month still waiting for approval: decide ${r.pendingLeave > 1 ? 'them' : 'it'} and work the payroll out again.</p>` : ''}
      <div class="kpis pay-kpis">${kpi('People', String(t.people))}${kpi('Gross pay', money(t.gross))}${kpi('Deductions', money(deductions))}${kpi('Net pay', money(t.net))}${kpi('Employer\'s cost on top', money(employer))}</div>
      ${r.dues.length ? `<div class="sec-title">Statutory dues</div><div class="pay-dues">${r.dues.map((d) => `<div class="row-card"><div class="rc-title">${esc(d.name)} · <span class="mono">${money(d.amount)}</span></div><div class="rc-sub">due ${esc(showDate(d.due))}${d.paid && d.paid < d.amount ? ` · ${money(d.paid)} paid` : ''}</div>
        <div class="rc-right">${['approved', 'paid'].includes(r.status) ? d.paid >= d.amount ? tonePill('Paid', '--st-vacant') : d.due < r.today ? tonePill('Overdue', '--st-departing') : tonePill('To pay', '--muted') : ''}${['approved', 'paid'].includes(r.status) && h.can('payroll.pay') && d.paid < d.amount ? `<button type="button" class="btn small" data-due="${d.kind}">Paid…</button>` : ''}</div></div>`).join('')}</div>` : ''}
      <div class="sec-title">People ${warned ? `<span class="fd-warn">${warned} to look at</span>` : ''}</div>
      <div class="acc-scroll"><table class="acc-table pay-table"><thead><tr><th>Code</th><th>Name</th><th>Department</th><th class="n">Paid days</th><th class="n">Overtime</th><th class="n">Gross</th><th class="n">PF</th><th class="n">ESI</th><th class="n">Prof. tax</th><th class="n">LWF</th><th class="n">Net pay</th></tr></thead><tbody>
        ${r.lines.map((l) => `<tr${needsLook(l).length ? ' class="pay-warn"' : ''}><td class="mono">${esc(l.code)}</td><td><button type="button" class="linkish" data-pl="${esc(l.employee_id)}">${esc(l.name)}</button>${needsLook(l).length ? ` <span class="fd-warn" title="${esc(needsLook(l).join('\n'))}">⚠</span>` : ''}</td><td>${esc(dep(l.department))}</td>
          <td class="n">${l.paid_days}${l.lop_days ? ` <small class="muted">(${l.lop_days} LOP)</small>` : ''}</td><td class="n">${l.ot_hours ? `${l.ot_hours} h` : ''}</td><td class="n">${money(l.gross_paise)}</td><td class="n">${money(l.pf_employee_paise)}</td>
          <td class="n">${l.esi_covered ? money(l.esi_employee_paise) : '—'}</td><td class="n">${l.pt_paise ? money(l.pt_paise) : ''}</td><td class="n">${l.lwf_employee_paise ? money(l.lwf_employee_paise) : ''}</td><td class="n"><b>${money(l.net_paise)}</b></td></tr>`).join('') || '<tr><td colspan="11" class="empty">Nobody.</td></tr>'}
      </tbody><tfoot><tr><td colspan="5">Total</td><td class="n">${money(t.gross)}</td><td class="n">${money(t.pf_employee)}</td><td class="n">${money(t.esi_employee)}</td><td class="n">${money(t.pt)}</td><td class="n">${money(t.lwf_employee)}</td><td class="n"><b>${money(t.net)}</b></td></tr></tfoot></table></div>
      ${this.compare ? this.compared(this.compare) : ''}`
  }

  private lineDetail(r: Run, l: Line) {
    const row = (k: string, v: number) => (v ? `<div class="m-row pay-kv"><span>${esc(k)}</span><span class="mono">${money(v)}</span></div>` : '')
    const edit = r.status === 'draft' && this.h.can('payroll.run')
    return `${l.warnings.length ? `<ul class="small pay-notes">${l.warnings.map((w) => `<li class="${w.startsWith('Note:') ? 'muted' : 'fd-warn'}">${esc(w.replace(/^Note: /, ''))}</li>`).join('')}</ul>` : ''}
      <p class="small muted">${esc(l.designation)} · on the rolls ${l.employed_days} of ${r.days_in_month} days · leave without pay ${l.leave_lop_days}${l.absent_days ? ` · absent ${l.absent_days}` : ''} · wages (Code on Wages) ${money(l.wages_paise)}</p>
      <div class="bq-two"><div><div class="sec-title">Earnings</div><div class="m-table">${row('Basic', l.basic_paise)}${row('DA', l.da_paise)}${row('HRA', l.hra_paise)}${row('Conveyance', l.conveyance_paise)}${row('Special allowance', l.special_paise)}${row('Other allowance', l.other_paise)}${row(`Overtime ${l.ot_hours} h`, l.overtime_paise)}${row(l.note ?? 'Other earnings', l.other_earnings_paise)}${row('Gross', l.gross_paise)}</div></div>
        <div><div class="sec-title">Deductions</div><div class="m-table">${row('Provident fund', l.pf_employee_paise)}${row('ESI', l.esi_employee_paise)}${row('Professional tax', l.pt_paise)}${row('Labour welfare fund', l.lwf_employee_paise)}${row('Income tax (TDS)', l.tds_paise)}</div>
        <div class="sec-title">Employer</div><div class="m-table">${row('PF: pension (EPS)', l.eps_paise)}${row('PF: provident fund', l.pf_employer_paise)}${row('EDLI', l.edli_paise)}${row('ESI', l.esi_employer_paise)}${row('Welfare fund', l.lwf_employer_paise)}${row('Bonus provision', l.bonus_provision_paise)}${row('Gratuity provision', l.gratuity_provision_paise)}</div></div></div>
      ${edit ? `<div class="sec-title">Change for this month</div><div class="form-grid"><label>Leave without pay (days)<input name="lop" type="number" min="0" step="0.5" value="${l.lop_set ?? ''}" placeholder="${l.lop_days} worked out"></label>
        <label>Overtime (hours)<input name="ot" type="number" min="0" step="0.5" value="${l.ot_set ?? ''}" placeholder="${l.ot_hours} from attendance"></label>
        <label>Other earnings (₹)<input name="other" type="number" min="0" value="${l.other_earnings_paise ? l.other_earnings_paise / 100 : ''}"></label><label>What for<input name="note" maxlength="300" value="${esc(l.note ?? '')}" placeholder="Arrears, incentive…"></label></div>
        <p class="muted small">Leave blank to use what attendance and leave say.</p>` : ''}`
  }

  async click(el: HTMLElement) {
    const api = this.h.api
    const runId = el.closest<HTMLElement>('[data-run]')?.dataset.run
    if (runId) { this.selected = runId; await this.load(); return true }
    const a = el.closest<HTMLElement>('[data-pr]')?.dataset.pr
    if (a === 'list') { this.selected = null; this.run = null; await this.load(); return true }
    if (a === 'new') {
      const month = (document.querySelector<HTMLInputElement>('.ws:not([hidden]) [data-pm]')?.value ?? '').trim()
      const r = await api.post<{ id: string; missing: { name: string }[] }>('/api/payroll/runs', { month })
      this.selected = r.id; await this.load()
      toast(r.missing.length ? `${r.missing.length} without a pay structure left out` : 'Worked out: check each person, then submit')
      return true
    }
    if (a === '24q') {
      const root = document.querySelector('.ws:not([hidden])')!
      const fy = root.querySelector<HTMLSelectElement>('[data-q24fy]')!.value, q = root.querySelector<HTMLSelectElement>('[data-q24q]')!.value
      download(`24Q_${fy}_Q${q}.csv`, await api.req<string>('GET', `/api/payroll/24q?fy=${fy}&quarter=${q}&format=csv`), 'text/csv'); return false
    }
    const adv = el.closest<HTMLElement>('[data-adv]')?.dataset.adv
    if (adv) {
      const [id, what] = adv.split('|')
      if (what !== 'issue') { await api.post(`/api/payroll/advances/${id}/decide`, { decision: what }); toast(what === 'approve' ? 'Approved: accounts pays it' : 'Turned down'); await this.load(); return true }
      const x = this.advances.find((y) => y.id === id)!
      this.h.modal.open(`Salary ${x.kind} to ${x.name} paid`, `<p class="muted small">${money(x.amount_paise)}, recovered at ${money(x.instalment_paise)} a month from the payroll.</p><div class="form-grid"><label>Paid on<input name="on" type="date" value="${new Date().toISOString().slice(0, 10)}"></label><label>Reference<input name="ref" maxlength="80"></label></div>`, 'Save', async (f) => {
        await api.post(`/api/payroll/advances/${id}/issue`, { issuedOn: val(f, 'on'), reference: val(f, 'ref') }); await this.reload(); return 'Recorded'
      })
      return false
    }
    const fnf = el.closest<HTMLElement>('[data-fnf]')?.dataset.fnf
    if (fnf) {
      const [id, what] = fnf.split('|')
      if (what !== 'pay') { await api.post(`/api/payroll/settlements/${id}/${what}`); toast(what === 'approve' ? 'Approved and posted' : 'Cancelled'); await this.load(); return true }
      const x = this.settlements.find((y) => y.id === id)!
      this.h.modal.open(`Settlement paid to ${x.name}`, `<p class="muted small">${money(x.net_paise)} · ${esc(x.net_words)}</p><div class="form-grid"><label>Paid on<input name="on" type="date" value="${new Date().toISOString().slice(0, 10)}"></label><label>Reference<input name="ref" maxlength="80"></label></div>`, 'Save', async (f) => {
        await api.post(`/api/payroll/settlements/${id}/pay`, { paidOn: val(f, 'on'), reference: val(f, 'ref') }); await this.reload(); return 'Recorded'
      })
      return false
    }
    const r = this.run
    if (!r) return false
    if (a === 'compare') {
      this.h.modal.open(`Compare ${r.monthName} with the current payroll`, `<p class="muted small">Paste the month from the payroll the resort runs today as CSV, or choose its file. A header row with <b>code</b> and <b>net</b>, and any of gross, pf, esi, pt, lwf, tds (in rupees):</p>
        <pre class="small muted">code,gross,pf,esi,pt,lwf,tds,net\nE0001,16000,1080,120,1250,0,0,13550</pre>
        <div class="form-grid"><label class="span2">File<input type="file" name="file" accept=".csv,text/csv"></label><label class="span2">Or paste<textarea name="csv" rows="6"></textarea></label></div>`, 'Compare', async (f) => {
        const file = (f.elements.namedItem('file') as HTMLInputElement).files?.[0]
        const csv = file ? await file.text() : val(f, 'csv')
        this.compare = await api.post<Compare>(`/api/payroll/runs/${r.id}/compare`, { csv }); this.h.render()
        return this.compare.allMatch ? 'Every figure matches' : `${this.compare.matched} of ${this.compare.total} people match`
      })
      return false
    }
    const base = `/api/payroll/runs/${r.id}`
    const step = async (path: string, msg: string) => { await api.post(`${base}/${path}`); toast(msg); await this.load(); return true }
    if (a === 'recalc') { const x = await api.post<{ missing: unknown[] }>(`${base}/recalculate`); toast(`Worked out again${x.missing.length ? `; ${x.missing.length} without a pay structure` : ''}`); await this.load(); return true }
    if (a === 'submit') return step('submit', 'Sent to the GM')
    if (a === 'check') return step('check', 'Sent to the MD')
    if (a === 'approve') return step('approve', 'Approved and posted to the books')
    if (a === 'cancel') { if (!confirm(`Cancel the ${r.monthName} payroll?`)) return false; await api.post(`${base}/cancel`); this.selected = null; this.run = null; await this.load(); return true }
    if (a === 'back') this.h.modal.open('Send back to HR', '<div class="form-grid"><label class="span2">What needs changing<input name="note" maxlength="300"></label></div>', 'Send back', async (f) => {
      await api.post(`${base}/send-back`, { note: val(f, 'note') }); await this.reload(); return 'Sent back'
    })
    if (a === 'ecr') { download(`ECR_${r.month}.txt`, await api.req<string>('GET', `${base}/ecr`), 'text/plain'); return false }
    if (a === 'esi') { download(`ESI_${r.month}.csv`, await api.req<string>('GET', `${base}/esi`), 'text/csv'); return false }
    if (a === 'bank') { download(`Salaries_${r.month}.csv`, await api.req<string>('GET', `${base}/bank`), 'text/csv'); return false }
    if (a === 'slips') { printPayslips(r.lines.map((l) => ({ ...l, monthName: r.monthName, days_in_month: r.days_in_month, department: this.h.cfg.departments[l.department]?.name ?? l.department })), r.employer, `Payslips ${r.month}`); return false }
    const bankSel = () => r.banks.length > 1 ? `<label>From<select name="bank">${r.banks.map((b) => `<option value="${esc(b.account_code)}">${esc(b.name)}</option>`).join('')}</select></label>` : ''
    const noBank = r.lines.filter((l) => !l.bank_account || !l.ifsc)
    if (a === 'pay') this.h.modal.open(`Salaries for ${r.monthName} paid`, `<p class="muted small">${money(r.totals.net)} to ${r.lines.length} people: by the bank transfer file${noBank.length ? `, and by cheque to ${noBank.map((l) => esc(l.name)).join(', ')} (no bank account)` : ''}.</p><div class="form-grid"><label>Paid on<input name="on" type="date" value="${esc(r.today)}"></label>${bankSel()}<label class="span2">Bank reference<input name="ref" maxlength="80"></label></div>`, 'Save', async (f) => {
      await api.post(`${base}/pay`, { paidOn: val(f, 'on'), reference: val(f, 'ref'), bankCode: val(f, 'bank') || undefined }); await this.reload(); return 'Recorded and posted to the books'
    })
    const due = el.closest<HTMLElement>('[data-due]')?.dataset.due
    if (due) {
      const d = r.dues.find((x) => x.kind === due)!
      this.h.modal.open(`${d.name} for ${r.monthName} paid`, `<div class="form-grid"><label>Amount (₹)<input name="amt" type="number" min="0" step="0.01" value="${(d.amount - d.paid) / 100}"></label><label>Paid on<input name="on" type="date" value="${esc(r.today)}"></label>${bankSel()}
          <label class="span2">${due === 'pf' ? 'TRRN (from the EPFO challan)' : 'Challan or receipt number'}<input name="ref" maxlength="60"></label></div>`, 'Save', async (f) => {
        await api.post('/api/payroll/statutory', { month: r.month, kind: due, amount: Number(val(f, 'amt')), paidOn: val(f, 'on'), reference: val(f, 'ref'), bankCode: val(f, 'bank') || undefined }); await this.reload(); return 'Recorded'
      })
    }
    const pl = el.closest<HTMLElement>('[data-pl]')?.dataset.pl
    if (pl) {
      const l = r.lines.find((x) => x.employee_id === pl)!
      const edit = r.status === 'draft' && this.h.can('payroll.run')
      this.h.modal.open(`${l.name} · ${money(l.net_paise)}`, this.lineDetail(r, l), edit ? 'Save' : 'Done', async (f) => {
        if (!edit) return ''
        const num = (n: string) => (val(f, n) === '' ? null : Number(val(f, n)))
        await api.req('PATCH', `${base}/lines/${l.employee_id}`, { lopDays: num('lop'), otHours: num('ot'), otherEarnings: Number(val(f, 'other') || 0), note: val(f, 'note') })
        await this.reload(); return 'Worked out again'
      })
    }
    return false
  }
}
