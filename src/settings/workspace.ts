import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { esc, showDate, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { Workspace, type View, type WorkspaceHost } from '../ui/workspace'

// Settings for the MD: the resort's profile (names, GSTIN, PAN, TAN, address, contact, invoice prefix, who
// signs TDS returns, when the day closes by itself), room types and rates, and the getting-started checklist.

type Tab = 'start' | 'profile' | 'rates'
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
  /** The PAN is characters 3–12 of the GSTIN: filled in as the GSTIN is typed. */
  onInput(t: HTMLElement) {
    if (!(t instanceof HTMLInputElement) || t.name !== 'gstin') return
    const g = t.value.trim().toUpperCase()
    const pan = t.form?.elements.namedItem('pan') as HTMLInputElement | null
    if (pan && /^\d{2}[A-Z]{5}\d{4}[A-Z]/.test(g)) pan.value = g.slice(2, 12)
  }
}

interface RoomType { id: string; name: string; base_rate_paise: number; max_occupancy: number; active: boolean; rooms: number }
interface RateRow { code: string; name: string; meal_plan: string; room_type_id: string | null; valid_from: string | null; valid_to: string | null; amount_paise: number | null }
const PLAN_LABEL: Record<string, string> = { EP: 'Room only (EP)', CP: 'With breakfast (CP)', MAP: 'Breakfast + 1 meal (MAP)', AP: 'All meals (AP)' }
const inr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`
const nextDay = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10) }

/** Room types and the nightly rate for each meal plan, by season. Reception's booking form prices from here. */
class RatesView implements View {
  private types: RoomType[] = []
  private rates: RateRow[] = []
  private today = ''
  constructor(private h: WorkspaceHost) {}
  async load() {
    const [types, rates, day] = await Promise.all([this.h.cached<RoomType[]>('/api/room-types'), this.h.cached<RateRow[]>('/api/rate-plans'),
      this.h.cached<{ businessDate: string }>('/api/business-date')])
    this.types = types.filter((t) => t.active); this.rates = rates.filter((r) => r.room_type_id); this.today = day.businessDate
  }
  private plans() { return [...new Set(this.rates.map((r) => r.code))].sort((a, b) => ['EP', 'CP', 'MAP', 'AP'].indexOf(a) - ['EP', 'CP', 'MAP', 'AP'].indexOf(b)) }
  /** The rate in force today, else the next one to start. */
  private current(plan: string, type: string) {
    const rows = this.rates.filter((r) => r.code === plan && r.room_type_id === type && r.valid_to! >= this.today).sort((a, b) => a.valid_from!.localeCompare(b.valid_from!))
    return rows.find((r) => r.valid_from! <= this.today) ?? rows[0]
  }
  private latest(plan: string, type: string) {
    return this.rates.filter((r) => r.code === plan && r.room_type_id === type).sort((a, b) => b.valid_to!.localeCompare(a.valid_to!))[0]
  }
  html() {
    const plans = this.plans()
    const soon = new Date(`${this.today}T00:00:00Z`); soon.setUTCDate(soon.getUTCDate() + 60)
    const ends = this.types.flatMap((t) => plans.map((p) => this.latest(p, t.id)?.valid_to)).filter(Boolean) as string[]
    const firstEnd = ends.sort()[0]
    return `${firstEnd && firstEnd <= soon.toISOString().slice(0, 10) ? `<div class="setup-banner">Some rates end on <b>${esc(showDate(firstEnd))}</b>. After that date reception cannot book those rooms. Add the next season's rates.</div>` : ''}
      <div class="ws-toolbar"><button type="button" class="btn primary" data-rate-set>Set a rate</button><button type="button" class="btn" data-rate-extend>Next season: carry rates forward</button></div>
      <div class="sec-title">Rate per night before GST</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Room type</th>${plans.map((p) => `<th class="n">${esc(PLAN_LABEL[p] ?? p)}</th>`).join('')}</tr></thead><tbody>
      ${this.types.map((t) => `<tr><td><b>${esc(t.name)}</b><div class="muted small">${t.rooms} room${t.rooms === 1 ? '' : 's'} · up to ${t.max_occupancy} guests</div></td>
        ${plans.map((p) => { const r = this.current(p, t.id); return `<td class="n"><button type="button" class="link-btn" data-rate="${esc(p)}|${esc(t.id)}">${r ? `${inr(r.amount_paise!)}<div class="muted small">${r.valid_from! > this.today ? `from ${esc(showDate(r.valid_from))}` : `to ${esc(showDate(r.valid_to))}`}</div>` : '<span class="muted">Not sold · set</span>'}</button></td>` }).join('')}</tr>`).join('')}
      </tbody></table></div>
      <p class="muted small">A night above ₹7,500 moves the room to 18% GST, and the restaurant with it, so it needs the MD's approval. Packages with meals (CP, MAP, AP) count their full price.</p>
      <div class="sec-title">Room types</div>
      ${this.types.map((t) => `<div class="row-card"><div class="rc-title">${esc(t.name)}</div><div class="rc-sub">${t.rooms} room${t.rooms === 1 ? '' : 's'} · up to ${t.max_occupancy} guests · rack rate ${inr(t.base_rate_paise)}</div>
        <div class="rc-right"><button type="button" class="btn small" data-rtype="${esc(t.id)}">Edit</button></div></div>`).join('')}`
  }
  async click(el: HTMLElement) {
    const cell = el.closest<HTMLElement>('[data-rate]')?.dataset.rate
    if (cell) { const [p, t] = cell.split('|'); this.setRate(p, t); return false }
    if (el.closest('[data-rate-set]')) { this.setRate(); return false }
    if (el.closest('[data-rate-extend]')) { this.extend(); return false }
    const rt = el.closest<HTMLElement>('[data-rtype]')?.dataset.rtype
    if (rt) { this.editType(rt); return false }
    return false
  }
  private setRate(plan = 'EP', type = this.types[0]?.id ?? '') {
    const last = this.latest(plan, type)
    const cur = this.current(plan, type)
    this.h.modal.open('Set a rate', `<div class="form-grid">
        <label>Room type<select name="type">${this.types.map((t) => `<option value="${esc(t.id)}" ${t.id === type ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
        <label>Meal plan<select name="plan">${this.plans().map((p) => `<option value="${esc(p)}" ${p === plan ? 'selected' : ''}>${esc(PLAN_LABEL[p] ?? p)}</option>`).join('')}</select></label>
        <label>From<input name="from" type="date" required value="${esc(cur?.valid_from && cur.valid_from > this.today ? cur.valid_from : this.today)}"></label>
        <label>To<input name="to" type="date" required value="${esc(last?.valid_to ?? '')}"></label>
        <label>Rate per night ₹ (before GST)<input name="amount" type="number" min="1" step="1" required value="${cur ? cur.amount_paise! / 100 : ''}"></label></div>
      <p class="muted small">From and to are both nights the rate applies to. A rate starting on the same date as an existing one replaces it.</p>`, 'Save the rate', async (f) => {
      const from = val(f, 'from'), to = val(f, 'to')
      if (!from || !to || to < from) throw new Error('Choose the first and last night, the last on or after the first.')
      const r = await this.h.api.req<{ pending?: boolean; message?: string }>('PUT', '/api/rates', { plan: val(f, 'plan'), roomTypeId: val(f, 'type'), validFrom: from, validTo: to, amount: Number(val(f, 'amount')) })
      await this.load(); this.h.render()
      return r.pending ? `Sent to the MD for approval. ${r.message ?? ''}` : 'Rate saved'
    })
  }
  private extend() {
    const plans = this.plans()
    const pairs = this.types.flatMap((t) => plans.map((p) => ({ t, p, last: this.latest(p, t.id) }))).filter((x) => x.last)
    const from = pairs.map((x) => x.last!.valid_to!).sort()[0]
    const y = Number((from ?? this.today).slice(0, 4)) + 1
    this.h.modal.open('Next season', `<p class="muted small">Each rate is carried on from the day after it ends, with the increase below. You can change any single rate afterwards.</p>
      <div class="form-grid"><label>Until<input name="until" type="date" required value="${y}-03-31"></label>
        <label>Increase %<input name="pct" type="number" step="0.5" value="0"></label></div>`, 'Carry the rates forward', async (f) => {
      const until = val(f, 'until'), pct = Number(val(f, 'pct') || 0)
      let saved = 0, pending = 0, skipped = 0
      for (const x of pairs) {
        const start = nextDay(x.last!.valid_to!)
        if (start > until) { skipped++; continue }
        const amount = Math.round((x.last!.amount_paise! / 100) * (1 + pct / 100))
        const r = await this.h.api.req<{ pending?: boolean }>('PUT', '/api/rates', { plan: x.p, roomTypeId: x.t.id, validFrom: start, validTo: until, amount })
        if (r.pending) pending++; else saved++
      }
      await this.load(); this.h.render()
      return `${saved} rate${saved === 1 ? '' : 's'} carried to ${showDate(until)}${pending ? `; ${pending} above ₹7,500 sent to the MD` : ''}${skipped ? `; ${skipped} already ran past that date` : ''}.`
    })
  }
  private editType(id: string) {
    const t = this.types.find((x) => x.id === id)!
    this.h.modal.open(`Room type · ${t.name}`, `<div class="form-grid">
        <label class="span2">Name<input name="name" required value="${esc(t.name)}"></label>
        <label>Most guests<input name="occ" type="number" min="1" max="12" value="${t.max_occupancy}"></label>
        <label>Rack rate ₹<input name="base" type="number" min="1" value="${t.base_rate_paise / 100}"></label></div>
      <p class="muted small">The rack rate is shown on the booking form; what a guest pays comes from the rates above.</p>`, 'Save', async (f) => {
      await this.h.api.req('PATCH', `/api/room-types/${encodeURIComponent(id)}`, { name: val(f, 'name'), maxOccupancy: Number(val(f, 'occ')), baseRate: Number(val(f, 'base')) })
      await this.load(); this.h.render()
      return 'Saved'
    })
  }
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
    if (open.startsWith('settings:')) { this.h.go(open.slice(9) as Tab); return false }
    // "btn-staff:logins" opens that workspace on that tab.
    const [btn, tab] = open.split(':')
    document.getElementById(btn)?.click()
    if (tab) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 150))
        const t = document.querySelector<HTMLElement>(`[data-wstab="${tab}"]`)
        if (t) { t.click(); break }
      }
    }
    return false
  }
}

export class SettingsWorkspace extends Workspace<Tab> {
  protected views: Record<Tab, View>
  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Settings', onClose)
    this.views = { start: new StartView(this), profile: new ProfileView(this), rates: new RatesView(this) }
    this.tab = 'start'
  }
  static allowed(me: Me) { return me.permissions.includes('*') }
  tabs(): [Tab, string][] { return [['start', 'Getting started'], ['profile', 'Resort profile'], ['rates', 'Rooms & rates']] }
  go(tab: Tab) { void this.show(tab) }
}
