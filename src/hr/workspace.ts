import qrcode from 'qrcode-generator'
import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { esc, toast, tonePill } from '../ui/dom'
import { val } from '../ui/form-modal'
import { Workspace, type View, type WorkspaceHost } from '../ui/workspace'
import { money } from '../acc/books'
import { LEAVE_TONE } from '../staff/leave'
import { PayrollView } from './payroll'

// People: employee records (pay structure, statutory IDs, onboarding, documents, training, leaving), the
// monthly payroll, leave waiting for approval, the holiday calendar and certificates running out.

type Tab = 'people' | 'payroll' | 'leave' | 'holidays' | 'training'
interface Config { departments: Record<string, { name: string; ledger: string }>; leaveTypes: Record<string, { name: string }>; checklist: string[]; festivalHolidaysRequired: number }
interface Row { id: string; code: string; name: string; department: string; designation: string; employmentType: string; joinedOn: string; exitOn: string | null; status: string; login: string | null; uan: string | null; esicIp: string | null; grossPaise: number | null }
interface Detail { id: string; code: string; name: string; department: string; departmentName: string; designation: string; employment_type: string; joined_on: string; confirmed_on: string | null; exit_on: string | null; exit_reason: string | null; status: string
  gender: string | null; dob: string | null; mobile: string | null; email: string | null; address: string | null; emergency: string | null; pan: string | null; aadhaar_last4: string | null; uan: string | null; esic_ip: string | null
  pf_member: boolean; pt_applicable: boolean; lwf_applicable: boolean; bank_name: string | null; bank_account: string | null; ifsc: string | null; tax_regime: string; user_id: string | null; login: string | null; photo_id: string | null
  structures: { from: string; basic: number; da: number; hra: number; conveyance: number; special: number; other: number; pfOnFull: boolean }[] | null
  current: { grossPaise: number; wagesPaise: number } | null
  onboarding: { item: string; done_at: string | null; by: string | null }[]; documents: { id: string; kind: string; note: string | null; added_at: string; by: string }[]
  leave: { year: number; balances: { type: string; name: string; balance: number }[]; applications: { id: string; leave_type: string; from_date: string; to_date: string; days: string; status: string }[] }
  training: { kind: string; title: string; done_on: string; valid_until: string | null }[]; today: string }

const TRAINING: [string, string][] = [['fssai_food_handler', 'FSSAI food handler'], ['fire_drill', 'Fire drill'], ['first_aid', 'First aid'], ['hygiene', 'Hygiene'], ['responsible_service', 'Responsible service of alcohol'], ['safety', 'Safety'], ['other', 'Other']]
const opt = (pairs: [string, string][], sel?: string | null) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('')
type Host = WorkspaceHost & { cfg: Config }

class PeopleView implements View {
  selected: string | null = null
  private rows: Row[] = []
  private d: Detail | null = null
  private q = ''
  constructor(private h: Host) {}
  async load() { if (this.selected) this.d = await this.h.cached(`/api/hr/employees/${this.selected}`); else this.rows = await this.h.cached('/api/hr/employees') }
  private async reload() { await this.load(); this.h.render() }
  html() { return this.selected && this.d ? this.detail(this.d) : this.list() }
  onInput(el: HTMLElement) { if (el.matches('[data-hrq]')) { this.q = (el as HTMLInputElement).value; this.h.render() } }

  private list() {
    const q = this.q.toLowerCase(), dep = this.h.cfg.departments
    const rows = this.rows.filter((r) => !q || `${r.name} ${r.code} ${r.designation}`.toLowerCase().includes(q))
    return `<div class="ws-toolbar"><input class="ws-search" type="search" placeholder="Search people" value="${esc(this.q)}" data-hrq>${this.h.can('hr.manage') ? '<button type="button" class="btn primary" data-hr="new">Add an employee</button>' : ''}
        <span class="muted small">${this.rows.filter((r) => r.status !== 'exited').length} on the rolls</span></div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Designation</th><th>Joined</th><th>UAN / ESIC</th>${this.rows.some((r) => r.grossPaise != null) ? '<th class="n">Monthly pay</th>' : ''}<th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="${r.status === 'exited' ? 'retired' : ''}"><td class="mono">${esc(r.code)}</td><td><button type="button" class="linkish" data-emp="${esc(r.id)}">${esc(r.name)}</button>${r.login ? ' <small class="muted">app</small>' : ''}</td>
          <td>${esc(dep[r.department]?.name ?? r.department)}</td><td>${esc(r.designation)}</td><td>${esc(r.joinedOn)}</td><td class="mono small">${esc(r.uan ?? '—')} / ${esc(r.esicIp ?? '—')}</td>
          ${this.rows.some((x) => x.grossPaise != null) ? `<td class="n">${r.grossPaise != null ? money(r.grossPaise) : '<span class="fd-warn">not set</span>'}</td>` : ''}<td>${r.status !== 'active' ? tonePill(r.status === 'notice' ? `Leaving ${r.exitOn}` : 'Left', r.status === 'notice' ? '--marigold' : '--muted') : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No employees yet.</td></tr>'}
      </tbody></table></div>`
  }

  private detail(d: Detail) {
    const manage = this.h.can('hr.manage'), cur = d.structures?.[0]
    const done = d.onboarding.filter((o) => o.done_at).length
    const kv = (k: string, v: unknown) => `<dt>${esc(k)}</dt><dd>${v == null || v === '' ? '<span class="muted">—</span>' : esc(v)}</dd>`
    return `<div class="ws-toolbar"><button type="button" class="btn ghost" data-hr="back">← Everyone</button>
        ${manage ? '<button type="button" class="btn" data-hr="edit">Edit</button><button type="button" class="btn" data-hr="salary">Pay structure</button><button type="button" class="btn" data-hr="training">Add training</button><button type="button" class="btn" data-hr="grant">Grant leave</button>' : ''}
        <button type="button" class="btn" data-hr="idcard">ID card</button>${manage && d.status !== 'exited' ? '<button type="button" class="btn ghost" data-hr="exit">Leaving…</button>' : ''}</div>
      <div class="bq-head"><div><div class="muted mono small">${esc(d.code)} · ${esc(d.departmentName)}</div><h2>${esc(d.name)}</h2><div class="small">${esc(d.designation)} · ${esc(d.employment_type.replace('_', ' '))} · joined ${esc(d.joined_on)}${d.exit_on ? ` · last day ${esc(d.exit_on)} (${esc(d.exit_reason ?? '')})` : ''}</div></div>
        <div class="rc-right">${d.status !== 'active' ? tonePill(d.status === 'notice' ? 'Serving notice' : 'Left', '--marigold') : ''}${d.user_id ? tonePill('Uses the app', '--st-vacant') : ''}</div></div>
      <div class="bq-two"><div><div class="sec-title">Details</div><dl class="hr-dl">${kv('Mobile', d.mobile)}${kv('Email', d.email)}${kv('Date of birth', d.dob)}${kv('Address', d.address)}${kv('Emergency contact', d.emergency)}
          ${kv('PAN', d.pan)}${kv('Aadhaar', d.aadhaar_last4 ? `•••• •••• ${d.aadhaar_last4}` : null)}${kv('UAN', d.uan)}${kv('ESIC IP', d.esic_ip)}${kv('Bank', [d.bank_name, d.bank_account, d.ifsc].filter(Boolean).join(' · '))}
          ${kv('Deductions', [d.pf_member ? 'PF' : 'no PF', d.pt_applicable ? 'professional tax' : 'no PT', d.lwf_applicable ? 'welfare fund' : 'no LWF', `${d.tax_regime} tax regime`].join(', '))}</dl></div>
        <div>${d.structures ? `<div class="sec-title">Pay a month ${d.current ? `<span class="mono">${money(d.current.grossPaise)}</span>` : ''}</div>
          ${cur ? `<dl class="hr-dl">${kv('From', cur.from)}${kv('Basic', money(cur.basic))}${kv('DA', money(cur.da))}${kv('HRA', money(cur.hra))}${kv('Conveyance', money(cur.conveyance))}${kv('Special', money(cur.special))}${kv('Other', money(cur.other))}
            ${d.current ? kv('Wages (Code on Wages)', money(d.current.wagesPaise)) : ''}</dl>` : '<p class="fd-warn">No pay structure yet.</p>'}` : ''}
          <div class="sec-title">Leave ${d.leave.year}</div><div class="hr-bal">${d.leave.balances.map((b) => `<span><small>${esc(b.name)}</small><b class="mono">${b.balance}</b></span>`).join('')}</div></div></div>
      <div class="sec-title">Onboarding <span>${done} of ${d.onboarding.length}</span></div>
      <div class="hr-checks">${d.onboarding.map((o) => `<label class="check"><input type="checkbox" data-onb="${esc(o.item)}" ${o.done_at ? 'checked' : ''} ${manage ? '' : 'disabled'}> ${esc(o.item)}${o.by ? ` <small class="muted">${esc(o.by)}</small>` : ''}</label>`).join('')}</div>
      <div class="sec-title">Training</div>
      <div class="m-table">${d.training.map((t) => `<div class="m-row bq-ins"><span>${esc(t.done_on)}</span><span>${esc(t.title)}${t.valid_until ? ` · valid to ${esc(t.valid_until)}${t.valid_until < d.today ? ' <b class="fd-warn">lapsed</b>' : ''}` : ''}</span></div>`).join('') || '<p class="empty">None recorded.</p>'}</div>
      <div class="sec-title">Leave taken and asked for</div>
      <div class="m-table">${d.leave.applications.map((a) => `<div class="m-row bq-ins"><span>${esc(a.from_date)}</span><span>${esc(this.h.cfg.leaveTypes[a.leave_type]?.name ?? a.leave_type)}, ${Number(a.days)} days ${tonePill(a.status, LEAVE_TONE[a.status])}</span></div>`).join('') || '<p class="empty">None.</p>'}</div>`
  }

  private form(d?: Detail) {
    const dep = Object.entries(this.h.cfg.departments).map(([k, v]) => [k, v.name] as [string, string])
    return `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="120" value="${esc(d?.name ?? '')}"></label>
      <label>Department<select name="dept">${opt(dep, d?.department)}</select></label><label>Designation<input name="desig" maxlength="80" value="${esc(d?.designation ?? '')}"></label>
      <label>Type<select name="type">${opt([['permanent', 'Permanent'], ['probation', 'Probation'], ['fixed_term', 'Fixed term'], ['contract', 'Contract'], ['trainee', 'Trainee']], d?.employment_type)}</select></label>
      <label>Joined on<input name="joined" type="date" value="${esc(d?.joined_on ?? '')}"></label><label>Mobile<input name="mobile" inputmode="tel" value="${esc(d?.mobile?.replace('+91', '') ?? '')}"></label>
      <label>Gender<select name="gender">${opt([['', '—'], ['female', 'Female'], ['male', 'Male'], ['other', 'Other']], d?.gender ?? '')}</select></label><label>Date of birth<input name="dob" type="date" value="${esc(d?.dob ?? '')}"></label>
      <label>PAN<input name="pan" maxlength="10" value="${esc(d?.pan ?? '')}"></label><label>Aadhaar (only the last 4 are kept)<input name="aadhaar" inputmode="numeric" placeholder="${d?.aadhaar_last4 ? `•••• ${esc(d.aadhaar_last4)}` : ''}"></label>
      <label>UAN<input name="uan" inputmode="numeric" value="${esc(d?.uan ?? '')}"></label><label>ESIC IP no.<input name="esic" inputmode="numeric" value="${esc(d?.esic_ip ?? '')}"></label>
      <label>Bank<input name="bank" value="${esc(d?.bank_name ?? '')}"></label><label>Account no.<input name="acct" inputmode="numeric" value="${esc(d?.bank_account?.includes('•') ? '' : d?.bank_account ?? '')}" placeholder="${esc(d?.bank_account ?? '')}"></label>
      <label>IFSC<input name="ifsc" maxlength="11" value="${esc(d?.ifsc ?? '')}"></label><label>Tax regime<select name="regime">${opt([['new', 'New'], ['old', 'Old']], d?.tax_regime)}</select></label>
      ${d ? `<label class="span2">App login (email)<input name="login" type="email" value="${esc(d.login ?? '')}" placeholder="Their login, to see their own leave and payslips"></label>` : ''}
      <label class="span2">Address<input name="address" maxlength="300" value="${esc(d?.address ?? '')}"></label><label class="span2">Emergency contact<input name="emergency" maxlength="200" value="${esc(d?.emergency ?? '')}"></label></div>`
  }
  private body(f: HTMLFormElement) {
    const b: Record<string, unknown> = { name: val(f, 'name'), department: val(f, 'dept'), designation: val(f, 'desig'), employmentType: val(f, 'type'), joinedOn: val(f, 'joined'), mobile: val(f, 'mobile'), gender: val(f, 'gender') || null,
      dob: val(f, 'dob') || null, pan: val(f, 'pan').toUpperCase(), uan: val(f, 'uan'), esicIp: val(f, 'esic'), bankName: val(f, 'bank'), ifsc: val(f, 'ifsc').toUpperCase(), taxRegime: val(f, 'regime'), address: val(f, 'address'), emergency: val(f, 'emergency') }
    if (val(f, 'aadhaar')) b.aadhaar = val(f, 'aadhaar')
    if (val(f, 'acct')) b.bankAccount = val(f, 'acct')
    if (f.elements.namedItem('login')) b.loginEmail = val(f, 'login')
    return b
  }

  async change(el: HTMLElement) {
    const item = (el as HTMLInputElement).dataset.onb
    if (!item || !this.d) return false
    await this.h.api.post(`/api/hr/employees/${this.d.id}/onboarding`, { item, done: (el as HTMLInputElement).checked })
    await this.load(); return true
  }

  async click(el: HTMLElement) {
    const api = this.h.api
    const emp = el.closest<HTMLElement>('[data-emp]')?.dataset.emp
    if (emp) { this.selected = emp; await this.load(); return true }
    const a = el.closest<HTMLElement>('[data-hr]')?.dataset.hr
    if (a === 'back') { this.selected = null; this.d = null; await this.load(); return true }
    if (a === 'new') this.h.modal.open('Add an employee', this.form(), 'Add', async (f) => {
      const r = await api.post<{ id: string; code: string }>('/api/hr/employees', this.body(f))
      this.selected = r.id; await this.reload(); return `${r.code} added: set the pay structure next`
    })
    const d = this.d
    if (!d) return false
    const base = `/api/hr/employees/${d.id}`
    if (a === 'edit') this.h.modal.open(d.name, this.form(d), 'Save', async (f) => { await api.req('PATCH', base, this.body(f)); await this.reload(); return 'Saved' })
    if (a === 'salary') {
      const c = d.structures?.[0]
      const field = (k: string, l: string, v?: number) => `<label>${l} (₹ a month)<input name="${k}" type="number" min="0" value="${v != null ? v / 100 : ''}"></label>`
      this.h.modal.open('Pay structure', `<p class="muted small">A change applies from the date given; months before it keep the old structure. Allowances above half the total pay count as wages for PF, gratuity and bonus (Code on Wages).</p>
        <div class="form-grid"><label>From<input name="from" type="date" value="${esc(d.today.slice(0, 7))}-01"></label><span></span>${field('basic', 'Basic', c?.basic)}${field('da', 'DA', c?.da)}${field('hra', 'HRA', c?.hra)}${field('conveyance', 'Conveyance', c?.conveyance)}${field('special', 'Special allowance', c?.special)}${field('other', 'Other', c?.other)}
        <label class="span2 check"><input type="checkbox" name="pffull" ${c?.pfOnFull ? 'checked' : ''}> PF on full wages (above ₹15,000), as the employee chose</label></div>`, 'Save', async (f) => {
        const r = await api.req<{ grossPaise: number; note: string | null }>('PUT', `${base}/salary`, { effectiveFrom: val(f, 'from'), basic: Number(val(f, 'basic') || 0), da: Number(val(f, 'da') || 0), hra: Number(val(f, 'hra') || 0),
          conveyance: Number(val(f, 'conveyance') || 0), special: Number(val(f, 'special') || 0), other: Number(val(f, 'other') || 0), pfOnFullWages: (f.elements.namedItem('pffull') as HTMLInputElement).checked })
        await this.reload(); return r.note ?? `Pay ${money(r.grossPaise)} a month`
      })
    }
    if (a === 'training') this.h.modal.open('Training or certificate', `<div class="form-grid"><label>Kind<select name="kind">${opt(TRAINING)}</select></label><label>Title<input name="title" maxlength="120"></label>
        <label>Done on<input name="done" type="date"></label><label>Valid until<input name="until" type="date"></label></div>`, 'Save', async (f) => {
      await api.post(`${base}/training`, { kind: val(f, 'kind'), title: val(f, 'title') || undefined, doneOn: val(f, 'done'), validUntil: val(f, 'until') || undefined }); await this.reload(); return 'Saved'
    })
    if (a === 'grant') this.h.modal.open('Grant or correct leave', `<div class="form-grid"><label>Leave<select name="type">${opt(Object.entries(this.h.cfg.leaveTypes).filter(([k]) => k !== 'LOP').map(([k, v]) => [k, v.name]))}</select></label>
        <label>Days (negative to take back)<input name="days" type="number" step="0.5"></label><label class="span2">Why<input name="why" maxlength="200" placeholder="Worked on the holiday of 8 Nov"></label></div>`, 'Save', async (f) => {
      await api.post('/api/hr/leave/grant', { employeeId: d.id, leaveType: val(f, 'type'), days: Number(val(f, 'days')), reason: val(f, 'why') }); await this.reload(); return 'Saved'
    })
    if (a === 'exit') this.h.modal.open(`${d.name} is leaving`, `<div class="form-grid"><label>Last working day<input name="day" type="date"></label><label>Reason<select name="why">${opt([['Resigned', 'Resigned'], ['Retired', 'Retired'], ['Contract ended', 'Contract ended'], ['Dismissed', 'Dismissed'], ['Absconding', 'Absconding'], ['Deceased', 'Deceased']])}</select></label></div>
        <p class="muted small">The full and final settlement is worked out in payroll.</p>`, 'Save', async (f) => { await api.post(`${base}/exit`, { lastDay: val(f, 'day'), reason: val(f, 'why') }); await this.reload(); return 'Saved' })
    if (a === 'idcard') {
      const q = qrcode(0, 'M'); q.addData(`SATHYA-EMP:${d.code}`); q.make()
      const w = window.open('', '_blank')
      if (!w) { toast('Allow pop-ups to print the card.'); return false }
      w.document.write(`<!doctype html><title>ID card ${esc(d.code)}</title><style>body{font:14px system-ui;margin:20px}.c{width:54mm;height:86mm;border:1px solid #333;border-radius:3mm;padding:4mm;box-sizing:border-box;text-align:center}.c svg{width:28mm;height:28mm}h1{font-size:13px;margin:0 0 3mm}b{display:block;font-size:15px;margin-top:3mm}</style>
        <div class="c"><h1>Sathya Park &amp; Resorts</h1>${q.createSvgTag({ cellSize: 3, margin: 1, scalable: true })}<b>${esc(d.name)}</b><div>${esc(d.designation)}</div><div>${esc(d.departmentName)}</div><div style="margin-top:2mm;font-family:monospace">${esc(d.code)}</div></div><script>print()</script>`)
      w.document.close()
    }
    return false
  }
}

class LeaveView implements View {
  private rows: { id: string; name: string; code: string; department: string; leave_type: string; from_date: string; to_date: string; half_day: boolean; days: string; reason: string | null; status: string; decided_by: string | null; decision_note: string | null }[] = []
  private status = 'pending'
  constructor(private h: Host) {}
  async load() { this.rows = await this.h.cached(`/api/hr/leave/applications${this.status === 'all' ? '' : `?status=${this.status}`}`) }
  html() {
    return `<div class="ws-toolbar">${[['pending', 'Waiting'], ['approved', 'Approved'], ['all', 'All']].map(([k, l]) => `<button type="button" class="chip" data-lvs="${k}" aria-pressed="${k === this.status}">${l}</button>`).join('')}</div>
      ${this.rows.map((a) => `<div class="row-card"><div class="rc-title">${esc(a.name)} <small class="muted mono">${esc(a.code)}</small> · ${esc(this.h.cfg.leaveTypes[a.leave_type]?.name ?? a.leave_type)}</div>
        <div class="rc-sub">${esc(a.from_date)}${a.to_date !== a.from_date ? ` to ${esc(a.to_date)}` : ''}${a.half_day ? ' (half day)' : ''} · ${Number(a.days)} days · ${esc(this.h.cfg.departments[a.department]?.name ?? a.department)}${a.reason ? ` · ${esc(a.reason)}` : ''}${a.decided_by ? ` · ${esc(a.decided_by)}${a.decision_note ? `: ${esc(a.decision_note)}` : ''}` : ''}</div>
        <div class="rc-right">${a.status === 'pending' ? `<button type="button" class="btn small primary" data-lvd="${esc(a.id)}|approve">Approve</button><button type="button" class="btn small" data-lvd="${esc(a.id)}|reject">Turn down…</button>` : tonePill(a.status, LEAVE_TONE[a.status])}</div></div>`).join('') || '<p class="empty">Nothing here.</p>'}`
  }
  async click(el: HTMLElement) {
    const s = el.closest<HTMLElement>('[data-lvs]')?.dataset.lvs
    if (s) { this.status = s; await this.load(); return true }
    const d = el.closest<HTMLElement>('[data-lvd]')?.dataset.lvd
    if (!d) return false
    const [id, decision] = d.split('|')
    if (decision === 'approve') { await this.h.api.post(`/api/hr/leave/applications/${id}/decide`, { decision }); await this.load(); return true }
    this.h.modal.open('Turn down leave', '<div class="form-grid"><label class="span2">Why<input name="why" maxlength="300"></label></div>', 'Turn down', async (f) => {
      await this.h.api.post(`/api/hr/leave/applications/${id}/decide`, { decision, note: val(f, 'why') }); await this.load(); this.h.render(); return 'Turned down'
    })
    return false
  }
}

class HolidaysView implements View {
  private d: { year: number; holidays: { day: string; name: string; kind: string }[]; festivalChosen: number; festivalRequired: number } | null = null
  private year = 0
  constructor(private h: Host) {}
  async load() { this.d = await this.h.cached(`/api/hr/holidays${this.year ? `?year=${this.year}` : ''}`); this.year = this.d!.year }
  html() {
    const d = this.d!
    return `<div class="ws-toolbar"><button type="button" class="btn small" data-hy="-1">◀</button><b>${d.year}</b><button type="button" class="btn small" data-hy="1">▶</button>${this.h.can('hr.manage') ? '<button type="button" class="btn primary" data-hol="add">Add a holiday</button>' : ''}
        ${d.festivalChosen < d.festivalRequired ? tonePill(`${d.festivalRequired - d.festivalChosen} festival holiday${d.festivalRequired - d.festivalChosen > 1 ? 's' : ''} still to choose`, '--marigold') : tonePill('Festival holidays chosen', '--st-vacant')}</div>
      <p class="muted small">Tamil Nadu law: the four national holidays and five festival holidays a year. Leave does not count holidays.</p>
      <div class="m-table">${d.holidays.map((h) => `<div class="m-row hr-hol"><span class="mono">${esc(h.day)}</span><span>${esc(new Date(`${h.day}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' }))}</span><b>${esc(h.name)}</b><span>${esc(h.kind)}</span>
        <span class="rc-right">${this.h.can('hr.manage') && h.kind !== 'national' ? `<button type="button" class="btn small ghost" data-holdel="${esc(h.day)}">Remove</button>` : ''}</span></div>`).join('')}</div>`
  }
  async click(el: HTMLElement) {
    const y = el.closest<HTMLElement>('[data-hy]')?.dataset.hy
    if (y) { this.year += Number(y); await this.load(); return true }
    const del = el.closest<HTMLElement>('[data-holdel]')?.dataset.holdel
    if (del) { await this.h.api.req('PUT', '/api/hr/holidays', { day: del, remove: true }); await this.load(); return true }
    if (el.closest('[data-hol=add]')) this.h.modal.open('Add a holiday', `<div class="form-grid"><label>Date<input name="day" type="date"></label><label>Kind<select name="kind">${opt([['festival', 'Festival'], ['optional', 'Optional']])}</select></label>
        <label class="span2">Name<input name="name" maxlength="80" placeholder="Pongal, Tamil New Year, Deepavali…"></label></div>`, 'Add', async (f) => {
      await this.h.api.req('PUT', '/api/hr/holidays', { day: val(f, 'day'), name: val(f, 'name'), kind: val(f, 'kind') }); await this.load(); this.h.render(); return 'Added'
    })
    return false
  }
}

class TrainingView implements View {
  private rows: { kind: string; title: string; valid_until: string; name: string; code: string; department: string }[] = []
  constructor(private h: Host) {}
  async load() { this.rows = await this.h.cached('/api/hr/training/due') }
  html() {
    const today = new Date().toISOString().slice(0, 10)
    return `<p class="muted small">Certificates that have lapsed or run out in the next 60 days (FSSAI food handlers, first aid, fire drills…).</p>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Person</th><th>Department</th><th>Certificate</th><th>Valid until</th></tr></thead><tbody>
        ${this.rows.map((r) => `<tr><td>${esc(r.name)} <small class="muted mono">${esc(r.code)}</small></td><td>${esc(this.h.cfg.departments[r.department]?.name ?? r.department)}</td><td>${esc(r.title)}</td><td class="${r.valid_until < today ? 'fd-warn' : ''}">${esc(r.valid_until)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing running out.</td></tr>'}
      </tbody></table></div>`
  }
  async click() { return false }
}

export class PeopleWorkspace extends Workspace<Tab> implements Host {
  cfg: Config = { departments: {}, leaveTypes: {}, checklist: [], festivalHolidaysRequired: 5 }
  protected views: Record<Tab, View>
  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'People', onClose)
    this.views = { people: new PeopleView(this), payroll: new PayrollView(this), leave: new LeaveView(this), holidays: new HolidaysView(this), training: new TrainingView(this) }
    this.tab = this.tabs()[0][0]
  }
  protected async beforeLoad() { if (!Object.keys(this.cfg.departments).length) this.cfg = await this.cached('/api/hr/config') }
  static allowed(me: Me) { return ['*', 'hr.manage', 'hr.view', 'leave.approve', 'payroll.view', 'payroll.run', 'payroll.approve', 'payroll.pay'].some((p) => me.permissions.includes(p)) }
  tabs(): [Tab, string][] {
    const t: [Tab, string][] = []
    if (this.can('hr.manage', 'hr.view', 'payroll.view', 'payroll.run', 'leave.approve')) t.push(['people', 'Employees'])
    if (this.can('payroll.run', 'payroll.view', 'payroll.approve', 'payroll.pay')) t.push(['payroll', 'Payroll'])
    if (this.can('leave.approve', 'hr.manage')) t.push(['leave', 'Leave'])
    t.push(['holidays', 'Holidays'])
    if (this.can('hr.manage', 'hr.view')) t.push(['training', 'Training due'])
    return t
  }
}
