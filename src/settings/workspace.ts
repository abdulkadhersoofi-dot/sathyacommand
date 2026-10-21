import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { esc, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { Workspace, type View, type WorkspaceHost } from '../ui/workspace'

// Settings for the MD: the resort's profile (names, GSTIN, PAN, TAN, address, contact, invoice prefix, who
// signs TDS returns, when the day closes by itself) and the getting-started checklist.

type Tab = 'start' | 'profile'
interface Profile { name: string; legal_name: string | null; gstin: string | null; pan: string | null; tan: string | null; address: string | null; city: string | null; pin: string | null; phone: string | null; email: string | null
  website: string | null; invoice_prefix: string; tds_responsible: string | null; tds_responsible_designation: string | null; auto_close: boolean; day_close_at: string }
export interface SetupStep { key: string; title: string; why: string; done: boolean; open: string }

class ProfileView implements View {
  private p: Profile | null = null
  constructor(private h: WorkspaceHost) {}
  async load() { this.p = await this.h.cached('/api/property') }
  html() {
    const p = this.p!
    const f = (label: string, name: string, value: string | null, extra = '', span = false) => `<label${span ? ' class="span2"' : ''}>${esc(label)}<input name="${name}" value="${esc(value ?? '')}" ${extra}></label>`
    return `<form class="settings-form" data-profile>
      <div class="sec-title">The resort</div>
      <div class="form-grid">${f('Name guests see', 'name', p.name, 'maxlength="120" required')}${f('Legal name (as registered)', 'legalName', p.legal_name, 'maxlength="160" placeholder="Sathya Park Resorts Private Limited"')}
        ${f('Address', 'address', p.address, 'maxlength="300"', true)}${f('City / town', 'city', p.city, 'maxlength="80"')}${f('PIN code', 'pin', p.pin, 'inputmode="numeric" maxlength="6"')}
        ${f('Phone', 'phone', p.phone, 'inputmode="tel"')}${f('Email', 'email', p.email, 'type="email"')}${f('Website', 'website', p.website, 'placeholder="https://"', true)}</div>
      <div class="sec-title">Tax</div>
      <div class="form-grid">${f('GSTIN', 'gstin', p.gstin, 'maxlength="15" style="text-transform:uppercase" placeholder="33XXXXX0000X1Z5"')}${f('PAN', 'pan', p.pan, 'maxlength="10" style="text-transform:uppercase"')}
        ${f('TAN (for TDS)', 'tan', p.tan, 'maxlength="10" style="text-transform:uppercase" placeholder="CHES12345A"')}${f('Tax invoice number prefix', 'invoicePrefix', p.invoice_prefix, 'maxlength="5" style="text-transform:uppercase"')}
        ${f('Person who signs TDS returns and Form 16', 'tdsResponsible', p.tds_responsible, 'maxlength="120"')}${f('Their designation', 'tdsDesignation', p.tds_responsible_designation, 'maxlength="80" placeholder="Director"')}</div>
      <p class="muted small">The GSTIN fills in the PAN. Every tax invoice prints the legal name, GSTIN and address.</p>
      <div class="sec-title">Closing the day</div>
      <div class="form-grid"><label class="span2 check"><input type="checkbox" name="autoClose" ${p.auto_close ? 'checked' : ''}> Close the day by itself if nobody has closed it</label>
        <label>At (24-hour time)<input name="dayCloseAt" type="time" value="${esc(p.day_close_at)}"></label></div>
      <p class="muted small">Closing the day posts tonight's room charges, marks no-shows, puts the day's takings in the books and moves the hotel date on. The night auditor can still close it earlier from the front desk.</p>
      <div class="ws-toolbar"><button type="submit" class="btn primary">Save the profile</button></div></form>`
  }
  async submit(f: HTMLFormElement) {
    this.p = await this.h.api.req<Profile>('PATCH', '/api/property', {
      name: val(f, 'name'), legalName: val(f, 'legalName'), address: val(f, 'address'), city: val(f, 'city'), pin: val(f, 'pin'), phone: val(f, 'phone'), email: val(f, 'email'), website: val(f, 'website'),
      gstin: val(f, 'gstin'), pan: val(f, 'pan'), tan: val(f, 'tan'), invoicePrefix: val(f, 'invoicePrefix'), tdsResponsible: val(f, 'tdsResponsible'), tdsDesignation: val(f, 'tdsDesignation'),
      autoClose: checked(f, 'autoClose'), dayCloseAt: val(f, 'dayCloseAt'),
    })
    window.dispatchEvent(new CustomEvent('sathya:setup-changed'))
    return true
  }
  async click() { return false }
}

class StartView implements View {
  private steps: SetupStep[] = []
  constructor(private h: WorkspaceHost & { go(tab: Tab): void }) {}
  async load() { this.steps = (await this.h.cached<{ steps: SetupStep[] }>('/api/setup-status')).steps }
  html() {
    const left = this.steps.filter((s) => !s.done).length
    return `<p>${left ? `${left} of ${this.steps.length} things still to set up before the resort runs on the system.` : 'Everything here is set up.'}</p>
      ${this.steps.map((s, i) => `<div class="row-card setup-step${s.done ? ' done' : ''}"><div class="rc-title">${i + 1}. ${esc(s.title)}</div><div class="rc-sub">${esc(s.why)}</div>
        <div class="rc-right">${s.done ? tonePill('Done', '--st-vacant') : `<button type="button" class="btn small primary" data-setup="${esc(s.open)}">Set up</button>`}</div></div>`).join('')}`
  }
  async click(el: HTMLElement) {
    const open = el.closest<HTMLElement>('[data-setup]')?.dataset.setup
    if (!open) return false
    if (open === 'settings:profile') { this.h.go('profile'); return false }
    document.getElementById(open)?.click()
    return false
  }
}

export class SettingsWorkspace extends Workspace<Tab> {
  protected views: Record<Tab, View>
  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Settings', onClose)
    this.views = { start: new StartView(this), profile: new ProfileView(this) }
    this.tab = 'start'
  }
  static allowed(me: Me) { return me.permissions.includes('*') }
  tabs(): [Tab, string][] { return [['start', 'Getting started'], ['profile', 'Resort profile']] }
  go(tab: Tab) { void this.show(tab) }
}
