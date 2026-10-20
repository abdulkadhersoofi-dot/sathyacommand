import { esc, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { money } from '../acc/books'
import { STYLE_LABEL, type Venue } from './calendar'
import type { BqHost } from './workspace'

// What is sold: each venue's rental, turnaround and capacity by setup, and the menus, decor and services.

interface Pkg { id: string; name: string; kind: string; price_paise: number; per: string; veg: boolean | null; items: string[]; min_pax: number; active: boolean }

export class VenuesView {
  private venues: Venue[] = []
  private pkgs: Pkg[] = []
  constructor(private h: BqHost) {}

  async load() {
    this.venues = await this.h.cached('/api/banquets/venues')
    this.pkgs = await this.h.cached('/api/banquets/packages')
  }

  html() {
    const edit = this.h.can('venues.manage')
    return `<div class="sec-title">Venues</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Venue</th><th class="n">Rental per function</th><th class="n">Turnaround</th>${Object.values(STYLE_LABEL).map((s) => `<th class="n">${esc(s)}</th>`).join('')}<th></th></tr></thead><tbody>
        ${this.venues.map((v) => `<tr><td><b>${esc(v.name)}</b> <small class="muted">${esc(v.kind)}</small></td><td class="n">${money(v.rental_paise)}</td><td class="n">${v.turnaround_minutes / 60} h</td>
          ${Object.keys(STYLE_LABEL).map((s) => `<td class="n">${v.setups[s] ?? '—'}</td>`).join('')}<td>${edit ? `<button type="button" class="btn small" data-venue="${esc(v.id)}">Edit</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted small">The figures are placeholders until the resort's own are entered. The turnaround keeps a venue free before and after each booking for setting up and clearing.</p>
      <div class="sec-title">Menus and packages ${edit ? '<button type="button" class="btn small primary" data-pkg="new">Add</button>' : ''}</div>
      <div class="m-table">${this.pkgs.map((p) => `<div class="m-row bq-pkg ${p.active ? '' : 'retired'}"><b>${esc(p.name)}</b><span>${esc({ menu: 'Menu', decor: 'Decor', service: 'Service' }[p.kind] ?? p.kind)}${p.veg === true ? ' · veg' : p.veg === false ? ' · non-veg' : ''}</span>
          <span class="mono">${money(p.price_paise)}/${esc(p.per)}${p.min_pax ? ` <small class="muted">min ${p.min_pax}</small>` : ''}</span><small class="muted">${esc(p.items.join(' · '))}</small>
          <span class="rc-right">${p.active ? '' : tonePill('Archived', '--muted')}${edit ? `<button type="button" class="btn small" data-pkg="${esc(p.id)}">Edit</button>` : ''}</span></div>`).join('')}</div>`
  }

  async click(el: HTMLElement) {
    const api = this.h.api
    const done = async (msg: string) => { await this.load(); this.h.render(); return msg }
    const vid = el.closest<HTMLElement>('[data-venue]')?.dataset.venue
    if (vid) {
      const v = this.venues.find((x) => x.id === vid)!
      this.h.modal.open(v.name, `<div class="form-grid"><label>Rental per function (₹)<input name="rent" type="number" min="0" value="${v.rental_paise / 100}"></label>
          <label>Turnaround (minutes)<input name="turn" type="number" min="0" max="1440" value="${v.turnaround_minutes}"></label>
          ${Object.entries(STYLE_LABEL).map(([k, l]) => `<label>${esc(l)} (guests)<input name="cap:${k}" type="number" min="0" value="${v.setups[k] ?? ''}"></label>`).join('')}</div>`, 'Save', async (f) => {
        await api.req('PUT', `/api/banquets/venues/${vid}`, { rental: Number(val(f, 'rent')), turnaroundMinutes: Number(val(f, 'turn')),
          setups: Object.fromEntries(Object.keys(STYLE_LABEL).map((k) => [k, Number(val(f, `cap:${k}`) || 0)])) })
        return done('Saved')
      })
      return false
    }
    const pid = el.closest<HTMLElement>('[data-pkg]')?.dataset.pkg
    if (pid) {
      const p = this.pkgs.find((x) => x.id === pid)
      this.h.modal.open(p ? p.name : 'Add a package', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="80" value="${esc(p?.name ?? '')}"></label>
          <label>Kind<select name="kind">${[['menu', 'Menu'], ['decor', 'Decor'], ['service', 'Service']].map(([k, l]) => `<option value="${k}" ${p?.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Per<select name="per">${[['plate', 'Plate'], ['event', 'Event']].map(([k, l]) => `<option value="${k}" ${p?.per === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Price (₹)<input name="price" type="number" min="0" value="${p ? p.price_paise / 100 : ''}"></label><label>Minimum plates<input name="min" type="number" min="0" value="${p?.min_pax ?? 0}"></label>
          <label>Food<select name="veg"><option value="">—</option><option value="1" ${p?.veg === true ? 'selected' : ''}>Vegetarian</option><option value="0" ${p?.veg === false ? 'selected' : ''}>Non-vegetarian</option></select></label>
          ${p ? `<label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> On sale</label>` : ''}
          <label class="span2">What it includes, one per line<textarea name="items" rows="5">${esc(p?.items.join('\n') ?? '')}</textarea></label></div>`, 'Save', async (f) => {
        const body = { name: val(f, 'name'), kind: val(f, 'kind'), per: val(f, 'per'), price: Number(val(f, 'price')), minPax: Number(val(f, 'min') || 0), veg: val(f, 'veg') === '' ? null : val(f, 'veg') === '1', items: val(f, 'items'), ...(p ? { active: checked(f, 'active') } : {}) }
        if (p) await api.req('PATCH', `/api/banquets/packages/${p.id}`, body)
        else await api.post('/api/banquets/packages', body)
        return done('Saved')
      })
    }
    return false
  }
}
