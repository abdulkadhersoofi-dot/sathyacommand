import { esc, toast, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { toolbar } from '../ui/toolbar'
import type { StaffHost } from './today'

// Staff logins: who can sign in, with which email and roles. A new login (or a reset) gets a temporary
// password, shown once to hand over, which the person changes at their first sign-in.

interface Login { id: string; name: string; email: string | null; mobile: string | null; active: boolean; locked_reason: string | null; roles: string[]
  has_password: boolean; must_change_password: boolean; locked_until: string | null; access_until: string | null }
interface Role { id: string; god_mode: boolean }

/** What each role sees and may do, by department, so the right login is picked without guessing. */
const ROLE_INFO: Record<string, { dept: string; does: string }> = {
  managing_director: { dept: 'Management', does: 'Everything, with God Mode' },
  general_manager: { dept: 'Management', does: 'Every module except God Mode; approves discounts, purchases, payroll' },
  operations_manager: { dept: 'Management', does: 'Front desk, restaurant, housekeeping, engineering, security and staff; approves discounts and leave' },
  front_office_manager: { dept: 'Front office', does: 'The desk, night audit, credit notes, rates and channels, rosters' },
  reception: { dept: 'Front office', does: 'Bookings, check-in and check-out, payments, room-service orders, charging restaurant bills to rooms' },
  night_auditor: { dept: 'Front office', does: 'The desk and closing the day' },
  captain: { dept: 'Restaurant', does: 'Taking orders at tables and rooms, sending to the kitchen, bills and payments' },
  chef: { dept: 'Restaurant', does: 'The kitchen screen, sold-out dishes, kitchen stock and indents' },
  bartender: { dept: 'Restaurant', does: 'Bar orders and bills, the bar screen, bar stock' },
  bar_manager: { dept: 'Restaurant', does: 'The bar: orders, bills, discounts, bar hours and dry days, stock and purchases' },
  fnb_manager: { dept: 'Restaurant', does: 'Everything in the restaurant: menu, prices (with approval), kitchen, stock, rosters' },
  executive_housekeeper: { dept: 'Housekeeping', does: 'Rooms, inspections, public areas, laundry and linen, rosters, breakages' },
  hk_supervisor: { dept: 'Housekeeping', does: 'Rooms, inspections, laundry and linen' },
  room_attendant: { dept: 'Housekeeping', does: 'Own rooms and tasks on the phone' },
  chief_engineer: { dept: 'Engineering', does: 'Faults, assets, meters, compliance, rosters and spares' },
  engineering: { dept: 'Engineering', does: 'Own tickets and meter readings on the phone' },
  security_head: { dept: 'Security', does: 'Gate, patrols, incidents, cameras, emergencies, rosters' },
  security: { dept: 'Security', does: 'Gate entries, patrols and incidents on the phone' },
  stores: { dept: 'Stores', does: 'Items, vendors, indents, purchase orders, receipts, issues and counts' },
  accounts: { dept: 'Accounts', does: 'Books, receivables and payables, banks, GST, TDS, VAT, assets, licences, payroll payment' },
  hr_payroll: { dept: 'People', does: 'Employees, leave, rosters, payroll and staff logins' },
  sales_banquets: { dept: 'Banquets', does: 'Enquiries, bookings, event orders, payments and bills' },
  employee_self_service: { dept: 'Everyone', does: 'Own attendance, leave and pay on the phone' },
  external_auditor: { dept: 'Everyone', does: 'Read-only books and invoices, for a set number of days' },
}
const DEPTS = ['Management', 'Front office', 'Restaurant', 'Housekeeping', 'Engineering', 'Security', 'Stores', 'Accounts', 'People', 'Banquets', 'Everyone']

const roleName = (r: string) => r.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).replace(/\b(fnb|Fnb)\b/, 'F&B').replace(/\b(hk|Hk)\b/, 'HK').replace(/\b(hr|Hr)\b/, 'HR').replace('Sales banquets', 'Sales & banquets')
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

export class LoginsView {
  private rows: Login[] = []
  private roles: Role[] = []
  constructor(private h: StaffHost) {}

  async load() {
    this.rows = await this.h.api.get<Login[]>('/api/users')
    this.roles = await this.h.api.get<Role[]>('/api/roles')
  }

  private status(u: Login) {
    if (!u.active) return tonePill('Locked out', '--st-departing')
    if (u.locked_until && new Date(u.locked_until) > new Date()) return tonePill('Too many wrong passwords', '--marigold')
    if (u.access_until && new Date(u.access_until) < new Date()) return tonePill('Access ended', '--st-departing')
    if (!u.email || !u.has_password) return tonePill('No email login yet', '--marigold')
    if (u.must_change_password) return tonePill('Temporary password', '--marigold')
    return ''
  }

  html() {
    return `${toolbar({ primary: [{ attrs: 'data-lg="add"', label: 'Add a login' }] })}
      <div class="sec-title">Logins <span>${this.rows.length}</span></div>
      <p class="muted small">Staff sign in with their email and a password. A new login gets a temporary password to hand over; they choose their own at the first sign-in.</p>
      <div class="m-table"><div class="m-row login-row head"><span>Name</span><span>Email</span><span>Roles</span><span></span><span></span></div>
      ${this.rows.map((u) => `<div class="m-row login-row"><b>${esc(u.name)}</b><span>${u.email ? esc(u.email) : '<span class="muted">—</span>'}</span>
        <span>${u.roles.map((r) => esc(roleName(r))).join(', ')}${u.access_until ? `<small class="muted"> until ${day(u.access_until)}</small>` : ''}</span><span>${this.status(u)}</span>
        <span class="rc-right"><button type="button" class="btn small" data-lg="edit:${esc(u.id)}">Edit</button>${u.id !== this.h.me.id ? `<button type="button" class="btn small" data-lg="reset:${esc(u.id)}">Reset password</button>` : ''}</span></div>`).join('')}</div>`
  }

  /** Roles by department, each with what it can do; a login usually needs one. */
  private roleChecks(selected: string[]) {
    const god = this.h.me.permissions.includes('*')
    const roles = this.roles.filter((r) => god || !r.god_mode)
    const groups = [...DEPTS, ...new Set(roles.map((r) => ROLE_INFO[r.id]?.dept ?? 'Other'))].filter((d, i, a) => a.indexOf(d) === i)
    return `<div class="span2 role-picker"><div class="sec-title">Role <span>what they see and may do</span></div>${groups.map((dept) => {
      const list = roles.filter((r) => (ROLE_INFO[r.id]?.dept ?? 'Other') === dept)
      return list.length ? `<div class="role-dept">${esc(dept)}</div>${list.map((r) => `<label class="role-opt"><input type="checkbox" name="role:${esc(r.id)}" ${selected.includes(r.id) ? 'checked' : ''}><span><b>${esc(roleName(r.id))}</b><small>${esc(ROLE_INFO[r.id]?.does ?? '')}</small></span></label>`).join('')}` : ''
    }).join('')}<p class="muted small">One role is usually enough; a person with two jobs gets both. Nothing outside the role is shown to them.</p></div>`
  }
  private picked(f: HTMLFormElement) { return this.roles.filter((r) => checked(f, `role:${r.id}`)).map((r) => r.id) }

  /** Shows a temporary password once, to hand over. */
  private handOver(name: string, email: string, pw: string) {
    this.h.modal.open('Temporary password', `<p>Give these to ${esc(name)}. The password works once: they choose their own at the first sign-in.</p>
      <div class="handover"><div><small class="muted">Email</small><b class="mono">${esc(email)}</b></div><div><small class="muted">Temporary password</small><b class="mono">${esc(pw)}</b></div></div>
      <p class="muted small">It is not shown again. If it is lost, reset the password.</p>`, 'Done', async () => '')
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-lg]')?.dataset.lg
    if (!a) return false
    const api = this.h.api
    if (a === 'add') {
      this.h.modal.open('Add login', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="80" required></label>
        <label class="span2">Email<input name="email" type="email" maxlength="254" required placeholder="name@example.com"></label>
        <label>Mobile (optional)<input name="mobile" inputmode="tel" placeholder="98400 00000"></label>
        ${this.roleChecks([])}
        <label data-ca-days hidden>Auditor's access, days<input name="days" type="number" min="1" max="90" placeholder="30"></label></div>`, 'Add', async (f) => {
        const r = await api.post<{ tempPassword: string }>('/api/users', { name: val(f, 'name'), email: val(f, 'email'), mobile: val(f, 'mobile') || undefined, roles: this.picked(f),
          accessDays: val(f, 'days') ? Number(val(f, 'days')) : undefined })
        await this.load(); this.h.render()
        this.handOver(val(f, 'name'), val(f, 'email').toLowerCase(), r.tempPassword)
      })
      // The access period applies only to the external auditor (the CA), so it shows when that role is ticked.
      const form = this.h.modal.el.querySelector('form')!
      const ca = form.querySelector<HTMLElement>('[data-ca-days]')!
      form.addEventListener('change', () => { ca.hidden = !checked(form, 'role:external_auditor') })
    }
    const [act, id] = a.split(':')
    const u = this.rows.find((x) => x.id === id)
    if (!u) return false
    if (act === 'edit') {
      const self = u.id === this.h.me.id
      this.h.modal.open(`Login: ${u.name}`, `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="80" value="${esc(u.name)}"></label>
        <label class="span2">Email<input name="email" type="email" maxlength="254" value="${esc(u.email ?? '')}"></label>
        <label class="span2">Mobile (optional)<input name="mobile" inputmode="tel" value="${esc(u.mobile?.includes('•') ? '' : u.mobile ?? '')}" placeholder="${esc(u.mobile ?? '')}"></label>
        ${self ? '' : this.roleChecks(u.roles)}</div>`, 'Save', async (f) => {
        const mobile = val(f, 'mobile')
        await api.req('PATCH', `/api/users/${u.id}`, { name: val(f, 'name'), email: val(f, 'email'), ...(mobile || !u.mobile?.includes('•') ? { mobile: mobile || null } : {}) })
        const roles = this.picked(f)
        if (!self && [...roles].sort().join() !== [...u.roles].sort().join()) await api.req('PUT', `/api/users/${u.id}/roles`, { roles })
        await this.load(); this.h.render(); return 'Saved'
      })
    }
    if (act === 'reset') {
      if (!u.email) { toast('Give this login an email first (Edit).'); return false }
      this.h.modal.open(`Reset password: ${u.name}`, `<p>${esc(u.name)} gets a new temporary password and is signed out everywhere. Their old password stops working.</p>`, 'Reset', async () => {
        const r = await api.post<{ tempPassword: string }>(`/api/users/${u.id}/reset-password`)
        await this.load(); this.h.render()
        this.handOver(u.name, u.email!, r.tempPassword)
      })
    }
    return false
  }
}
