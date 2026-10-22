import { esc, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import type { Ws } from './common'
import { toolbar } from '../ui/toolbar'

// Licences & tax: licence and permit numbers (printed on bills) with renewal dates, TN VAT rates for
// each liquor class with their history, and the bar's licensed hours and dry days.

interface Licence { id: string; kind: string; name: string; number: string; authority: string | null; valid_from: string | null; valid_until: string | null; print_on: string[]; notes: string | null; active: boolean; state: string; updated_by: string }
interface VatClass { id: string; label: string; active: boolean; rate: number | null; upcoming: VatRow[]; history: VatRow[] }
interface VatRow { effective_from: string; rate: number; note: string | null; set_by: string }
interface BillingSettings { upiVpa: string | null; upiPayee: string | null; serviceChargePercent: number }
interface Bar { open: string | null; close: string | null; dryDays: { day: string; reason: string }[]; liquorNow: { allowed: boolean; reason: string | null }; legalAge: number }

const KINDS: [string, string][] = [
  ['fssai', 'FSSAI food licence'], ['fl3', 'FL-3 bar licence'], ['tn_vat', 'TN VAT registration (TIN)'], ['trade', 'Trade licence'],
  ['fire_noc', 'Fire NOC'], ['pollution', 'Pollution Control Board consent'], ['lift', 'Lift licence'], ['music', 'Music licence (PPL / IPRS)'],
  ['weights', 'Legal metrology (peg measures)'], ['other', 'Other…'],
]
const PRINT: [string, string][] = [['fnb_bill', 'Restaurant bills'], ['vat_bill', 'Liquor (VAT) bills'], ['room_invoice', 'Room invoices']]
const STATE: Record<string, [string, string]> = {
  valid: ['Valid', '--st-vacant'], renew_soon: ['Renew soon', '--marigold'], expired: ['Expired', '--st-departing'], no_expiry: ['No expiry', '--muted'], archived: ['Archived', '--st-ooo'],
}
const fmt = (d: string | null) => (d ? new Date(d + 'T12:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')

export class SettingsView {
  private licences: Licence[] = []
  private vat: VatClass[] = []
  private bar: Bar | null = null
  private billing: BillingSettings | null = null
  private businessDate = ''

  constructor(private ws: Ws) {}

  async load() {
    const api = this.ws.api
    ;[this.licences, this.vat, this.bar, { businessDate: this.businessDate }, this.billing] = await Promise.all([
      api.get<Licence[]>('/api/licences'), api.get<VatClass[]>('/api/vat-rates'), api.get<Bar>('/api/fnb/bar-settings'), api.get<{ businessDate: string }>('/api/business-date'),
      api.get<BillingSettings>('/api/fnb/billing-settings'),
    ])
  }

  html() {
    const canLic = this.ws.can('licences.edit'), canVat = this.ws.can('tax.vat'), canBar = this.ws.can('bar.settings')
    const b = this.bar!
    const due = this.licences.filter((l) => l.state === 'expired' || l.state === 'renew_soon').length
    return `<div class="set-grid">
    <section>
      <div class="sec-title">Licences &amp; permits <span>${due ? `${due} need attention` : `${this.licences.filter((l) => l.active).length} active`}</span></div>
      ${canLic ? toolbar({ primary: [{ attrs: 'data-s="add-licence"', label: 'Add licence' }] }) : ''}
      ${this.licences.map((l) => `<div class="row-card${l.active ? '' : ' retired'}">
        <div class="rc-title">${esc(l.name)}</div>
        <div class="rc-sub"><span class="mono">${esc(l.number)}</span>${l.authority ? ` · ${esc(l.authority)}` : ''}${l.valid_until ? ` · valid until ${fmt(l.valid_until)}` : ''}${l.print_on.length ? ` · printed on ${l.print_on.map((p) => PRINT.find((x) => x[0] === p)?.[1].toLowerCase() ?? p).join(', ')}` : ''}</div>
        <div class="rc-right">${tonePill(...STATE[l.state])}${canLic ? `<button type="button" class="btn small" data-licence="${esc(l.id)}">Edit</button>` : ''}</div></div>`).join('') || '<div class="empty">No licences yet. Add FSSAI, the FL-3 bar licence and the TN VAT registration so they print on bills.</div>'}
    </section>
    <section>
      <div class="sec-title">TN VAT on liquor <span>rates in force on ${fmt(this.businessDate)}</span></div>
      ${canVat ? toolbar({ primary: [{ attrs: 'data-s="add-class"', label: 'Add liquor class' }] }) : ''}
      ${this.vat.map((c) => `<div class="row-card${c.active ? '' : ' retired'}">
        <div class="rc-title">${esc(c.label)} <span class="mono muted">${esc(c.id)}</span></div>
        <div class="rc-sub">${c.upcoming.length ? `From ${fmt(c.upcoming[c.upcoming.length - 1].effective_from)}: ${c.upcoming[c.upcoming.length - 1].rate}% · ` : ''}${c.history.length ? `<details><summary>History</summary>${c.history.map((h) => `<div class="small">${fmt(h.effective_from)} · ${h.rate}% · ${esc(h.set_by)}${h.note ? ` · ${esc(h.note)}` : ''}</div>`).join('')}</details>` : 'No rate set yet'}</div>
        <div class="rc-right">${c.rate == null ? tonePill('Not set', '--st-departing') : `<b class="vat-rate">${c.rate}%</b>`}${canVat ? `<button type="button" class="btn small" data-vat="${esc(c.id)}">Set rate</button>` : ''}</div></div>`).join('')}
      ${this.vat.some((c) => c.rate == null && c.active) ? '<p class="fd-warn small">Liquor bills need a rate for every class sold. Confirm the rates with the CA.</p>' : ''}
    </section>
    <section>
      <div class="sec-title">Bar licence hours &amp; dry days <span>${b.liquorNow.allowed ? 'Liquor can be served now' : 'Liquor closed now'}</span></div>
      ${!b.liquorNow.allowed ? `<p class="muted small">${esc(b.liquorNow.reason ?? '')}</p>` : ''}
      <form class="form-grid bar-hours" data-s-form="hours">
        <label>Opens<input name="open" type="time" value="${esc(b.open ?? '')}" ${canBar ? '' : 'disabled'}></label>
        <label>Closes<input name="close" type="time" value="${esc(b.close ?? '')}" ${canBar ? '' : 'disabled'}></label>
        ${canBar ? '<div class="span2"><button class="btn" type="submit">Save hours</button></div>' : ''}
      </form>
      <p class="muted small">Staff must check guests are ${b.legalAge} or older before serving liquor.</p>
      <div class="sec-title">Dry days <span>${b.dryDays.length}</span></div>
      ${canBar ? toolbar({ primary: [{ attrs: 'data-s="add-dry"', label: 'Add dry day' }] }) : ''}
      ${b.dryDays.map((d) => `<div class="row-card"><div class="rc-title">${fmt(d.day)}</div><div class="rc-sub">${esc(d.reason)}</div>
        <div class="rc-right">${canBar ? `<button type="button" class="btn small ghost" data-dry="${esc(d.day)}">Remove</button>` : ''}</div></div>`).join('') || '<div class="empty">No dry days entered. Add them as the state notifies them.</div>'}
    </section>
    <section>
      <div class="sec-title">Restaurant bills</div>
      <form class="form-grid bar-hours" data-s-form="billing">
        <label class="span2">UPI ID for the QR code on bills<input name="upiVpa" value="${esc(this.billing!.upiVpa ?? '')}" placeholder="sathyaresorts@okaxis" ${this.ws.can('menu.price') ? '' : 'disabled'}></label>
        <label class="span2">Payee name shown in the UPI app<input name="upiPayee" value="${esc(this.billing!.upiPayee ?? '')}" maxlength="60" ${this.ws.can('menu.price') ? '' : 'disabled'}></label>
        <label>Service charge %<input name="service" type="number" min="0" max="20" step="0.5" value="${this.billing!.serviceChargePercent}" ${this.ws.can('menu.price') ? '' : 'disabled'}></label>
        ${this.ws.can('menu.price') ? '<div class="span2"><button class="btn" type="submit">Save</button></div>' : ''}
      </form>
      <p class="muted small">Service charge is optional by law: bills say so, and staff remove it when a guest asks.</p>
    </section></div>`
  }

  private licenceForm(l?: Licence) {
    const known = KINDS.some(([k]) => k === l?.kind)
    const kind = l ? (known ? l.kind : 'other') : 'fssai'
    this.ws.modal.open(l ? `Edit ${l.name}` : 'Add licence', `<div class="form-grid">
      <label class="span2">Type<select name="kind">${KINDS.map(([k, v]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="span2" data-custom ${kind === 'other' ? '' : 'hidden'}>Short code (e.g. boiler, signage)<input name="custom" maxlength="30" value="${esc(l && !known ? l.kind : '')}"></label>
      <label class="span2">Name<input name="name" maxlength="80" value="${esc(l?.name ?? KINDS[0][1])}"></label>
      <label class="span2">Licence number<input name="number" maxlength="40" value="${esc(l?.number ?? '')}" autocomplete="off"></label>
      <label class="span2">Issued by<input name="authority" maxlength="80" value="${esc(l?.authority ?? '')}"></label>
      <label>Valid from<input name="validFrom" type="date" value="${esc(l?.valid_from ?? '')}"></label>
      <label>Valid until<input name="validUntil" type="date" value="${esc(l?.valid_until ?? '')}"></label>
      <fieldset class="span2"><legend>Print the number on</legend>${PRINT.map(([k, v]) => `<label class="check"><input type="checkbox" name="p_${k}" ${l ? (l.print_on.includes(k) ? 'checked' : '') : k !== 'room_invoice' ? 'checked' : ''}> ${v}</label>`).join('')}</fieldset>
      <label class="span2">Notes<input name="notes" maxlength="200" value="${esc(l?.notes ?? '')}"></label>
      ${l ? `<label class="check"><input type="checkbox" name="active" ${l.active ? 'checked' : ''}> In force</label>` : ''}</div>`, l ? 'Save' : 'Add licence', async (f) => {
      const k = val(f, 'kind') === 'other' ? val(f, 'custom').toLowerCase().replace(/[^a-z0-9_]+/g, '_') : val(f, 'kind')
      const body = {
        kind: k, name: val(f, 'name'), number: val(f, 'number'), authority: val(f, 'authority') || null, validFrom: val(f, 'validFrom') || null, validUntil: val(f, 'validUntil') || null,
        printOn: PRINT.map(([p]) => p).filter((p) => checked(f, `p_${p}`)), notes: val(f, 'notes') || null,
      }
      if (l) await this.ws.api.req('PATCH', `/api/licences/${l.id}`, { ...body, active: checked(f, 'active') })
      else await this.ws.api.post('/api/licences', body)
      await this.reload()
      return l ? 'Licence saved' : 'Licence added'
    })
    const sel = this.ws.modal.el.querySelector<HTMLSelectElement>('select[name=kind]')!
    sel.addEventListener('change', () => {
      this.ws.modal.el.querySelector<HTMLElement>('[data-custom]')!.hidden = sel.value !== 'other'
      const name = this.ws.modal.el.querySelector<HTMLInputElement>('input[name=name]')!
      if (!l && sel.value !== 'other') name.value = KINDS.find(([k]) => k === sel.value)![1]
    })
  }

  private async reload() { await this.load(); this.ws.render() }

  async click(t: HTMLElement): Promise<boolean> {
    const api = this.ws.api, modal = this.ws.modal
    const get = (k: string) => t.closest<HTMLElement>(`[data-${k}]`)?.getAttribute(`data-${k}`) ?? undefined
    const lic = get('licence'); if (lic) { this.licenceForm(this.licences.find((x) => x.id === lic)); return true }
    const vat = get('vat')
    if (vat) {
      const c = this.vat.find((x) => x.id === vat)!
      modal.open(`TN VAT rate · ${c.label}`, `<div class="form-grid">
        <label>Rate %<input name="rate" type="number" min="0" max="100" step="0.01" value="${c.rate ?? ''}" required></label>
        <label>From<input name="from" type="date" value="${esc(this.businessDate)}" ${this.ws.me.permissions.includes('*') ? '' : `min="${esc(this.businessDate)}"`}></label>
        <label class="span2">Reference (G.O., CA advice)<input name="note" maxlength="200"></label></div>
        <p class="muted small">Bills on earlier dates keep the old rate. Only the MD can set a rate for a past date.</p>`, 'Set rate', async (f) => {
        await api.req('PUT', `/api/vat-rates/${vat}`, { rate: Number(val(f, 'rate')), effectiveFrom: val(f, 'from') || undefined, note: val(f, 'note') || undefined })
        await this.reload(); return 'VAT rate saved'
      })
      return true
    }
    const dry = get('dry')
    if (dry) { await api.req('DELETE', `/api/fnb/dry-days/${dry}`); await this.load(); return true }
    const act = get('s')
    if (!act) return false
    if (act === 'add-licence') this.licenceForm()
    if (act === 'add-class') {
      modal.open('Add liquor class', `<div class="form-grid"><label>Code<input name="id" maxlength="30" placeholder="brandy"></label><label>Name<input name="label" maxlength="40" placeholder="Brandy"></label></div>`, 'Add', async (f) => {
        await api.post('/api/vat-classes', { id: val(f, 'id').toLowerCase(), label: val(f, 'label') }); await this.reload(); return 'Class added. Set its rate next.'
      })
    }
    if (act === 'add-dry') {
      modal.open('Add dry day', `<div class="form-grid"><label>Date<input name="day" type="date" min="${esc(this.businessDate)}"></label><label class="span2">Reason<input name="reason" maxlength="120" placeholder="e.g. Thiruvalluvar Day, election"></label></div>`, 'Add', async (f) => {
        await api.post('/api/fnb/dry-days', { day: val(f, 'day'), reason: val(f, 'reason') }); await this.reload(); return 'Dry day added'
      })
    }
    return true
  }

  async submit(form: HTMLFormElement): Promise<boolean> {
    if (form.dataset.sForm === 'billing') {
      await this.ws.api.req('PUT', '/api/fnb/billing-settings', { upiVpa: val(form, 'upiVpa') || null, upiPayee: val(form, 'upiPayee') || null, serviceChargePercent: Number(val(form, 'service') || 0) })
      await this.load()
      return true
    }
    if (form.dataset.sForm !== 'hours') return false
    await this.ws.api.req('PUT', '/api/fnb/bar-settings', { open: val(form, 'open') || undefined, close: val(form, 'close') || undefined })
    await this.load()
    return true
  }
}
