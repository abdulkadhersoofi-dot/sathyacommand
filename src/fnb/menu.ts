import { esc, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { chips, DIET, dietDot, rs, type Category, type MenuItem, type Outlet, type Station, type Table, type Ws } from './common'

// Menu editor: outlets, menu sections and dishes (English and Tamil), prices, kitchen stations and
// tables. Price changes by anyone but the GM wait in the approval inbox; everything is logged.

type Sub = 'items' | 'tables' | 'stations' | 'outlets'
const OUTLET_KIND: Record<string, string> = { restaurant: 'Restaurant', room_service: 'Room service', bar: 'Bar', poolside: 'Poolside', banquet: 'Banquet' }

export class MenuView {
  outletId = ''
  sub: Sub = 'items'
  private menu: { categories: Category[]; items: MenuItem[] } = { categories: [], items: [] }
  private tables: Table[] = []
  private classes: { id: string; label: string; active: boolean }[] = []
  private allOutlets: Outlet[] = []
  private allStations: Station[] = []

  constructor(private ws: Ws) {}

  async load() {
    const all = await this.ws.api.get<{ outlets: Outlet[]; stations: Station[] }>('/api/fnb/outlets?all=true')
    this.allOutlets = all.outlets; this.allStations = all.stations
    if (!this.allOutlets.some((o) => o.id === this.outletId)) this.outletId = (this.allOutlets.find((o) => o.active && o.kind === 'restaurant') ?? this.allOutlets[0])?.id ?? ''
    if (this.outletId) {
      this.menu = await this.ws.api.get(`/api/fnb/menu?outletId=${this.outletId}&all=true`)
      this.tables = (await this.ws.api.get<(Table & { active?: boolean })[]>(`/api/fnb/tables?outletId=${this.outletId}`))
    }
    this.classes = await this.ws.api.get('/api/vat-rates')
  }

  private get canEdit() { return this.ws.can('menu.edit') }
  private get canPrice() { return this.ws.can('menu.price') }
  private station = (id: string) => this.allStations.find((s) => s.id === id)?.name ?? id

  html() {
    const subs: [Sub, string][] = [['items', 'Dishes'], ['tables', 'Tables'], ['stations', 'Kitchen stations'], ['outlets', 'Outlets']]
    const outletChips = this.sub === 'items' || this.sub === 'tables'
      ? chips(this.allOutlets.filter((o) => o.active).map((o) => [o.id, o.name]), this.outletId, 'moutlet') : ''
    return `<div class="ws-toolbar">${chips(subs, this.sub, 'msub')}</div>${outletChips}` + (
      this.sub === 'items' ? this.itemsHtml() : this.sub === 'tables' ? this.tablesHtml() : this.sub === 'stations' ? this.stationsHtml() : this.outletsHtml())
  }

  private itemsHtml() {
    const { categories, items } = this.menu
    const placeholder = items.some((i) => i.placeholder && i.active !== false)
    const bar = `<div class="ws-toolbar">
      ${this.canEdit ? '<button type="button" class="btn primary" data-m="add-item">Add dish</button><button type="button" class="btn" data-m="add-cat">Add section</button>' : ''}
      ${this.canPrice ? '<button type="button" class="btn" data-m="import">Import menu…</button>' : ''}</div>
      ${placeholder ? '<p class="fd-warn small">Dishes marked "sample" are placeholders. Import the real menu or edit them.</p>' : ''}`
    const groups = [...categories.map((c) => ({ c, list: items.filter((i) => i.category_id === c.id) })), { c: null, list: items.filter((i) => !i.category_id || !categories.some((c) => c.id === i.category_id)) }]
    return bar + groups.filter((g) => g.c || g.list.length).map(({ c, list }) => `
      <div class="sec-title">${esc(c?.name ?? 'No section')} <span>${list.length}${c && this.canEdit ? ` · <button type="button" class="linkish" data-cat="${esc(c.id)}">Rename</button>` : ''}</span></div>
      <div class="m-table">${list.map((i) => `<div class="m-row${i.active === false ? ' retired' : ''}">
        <span class="mono">${esc(i.code)}</span>
        <span class="m-name">${dietDot(i.diet)}${esc(i.name)}${i.name_ta ? `<small>${esc(i.name_ta)}</small>` : ''}</span>
        <span class="mono">${rs(i.price_paise)}</span>
        <span class="muted small">${esc(this.station(i.station_id))}${i.liquor_class ? ` · ${esc(this.classes.find((x) => x.id === i.liquor_class)?.label ?? i.liquor_class)}` : ''}</span>
        <span>${i.active === false ? tonePill('Retired', '--st-ooo') : !i.available ? tonePill('Sold out', '--st-departing') : i.placeholder ? tonePill('Sample', '--marigold') : ''}</span>
        ${this.canEdit || this.canPrice ? `<button type="button" class="btn small" data-edit-item="${esc(i.id)}">Edit</button>` : '<span></span>'}
      </div>`).join('') || '<div class="empty">No dishes in this section.</div>'}</div>`).join('')
  }

  private tablesHtml() {
    return (this.canEdit ? '<div class="ws-toolbar"><button type="button" class="btn primary" data-m="add-table">Add table</button></div>' : '')
      + `<div class="m-table">${this.tables.map((t) => `<div class="m-row m-row-4"><b>${esc(t.label)}</b><span>${t.seats} seats</span><span class="muted">${esc(t.section ?? '')}</span>
        ${this.canEdit ? `<button type="button" class="btn small" data-edit-table="${esc(t.id)}">Edit</button>` : '<span></span>'}</div>`).join('') || '<div class="empty">This outlet has no tables (room service and takeaway don\'t need them).</div>'}</div>`
  }

  private stationsHtml() {
    return (this.canEdit ? '<div class="ws-toolbar"><button type="button" class="btn primary" data-m="add-station">Add station</button></div>' : '')
      + `<p class="muted small">Each dish goes to one station. Kitchen stations get KOTs, bar stations get BOTs.</p>
      <div class="m-table">${this.allStations.map((s) => `<div class="m-row m-row-4${s.active ? '' : ' retired'}"><span class="mono">${esc(s.id)}</span><b>${esc(s.name)}</b><span class="muted">${s.kind === 'bar' ? 'Bar (BOT)' : 'Kitchen (KOT)'}${s.active ? '' : ' · retired'}</span>
        ${this.canEdit ? `<button type="button" class="btn small" data-edit-station="${esc(s.id)}">Edit</button>` : '<span></span>'}</div>`).join('')}</div>`
  }

  private outletsHtml() {
    return (this.canEdit ? '<div class="ws-toolbar"><button type="button" class="btn primary" data-m="add-outlet">Add outlet</button></div>' : '')
      + `<div class="m-table">${this.allOutlets.map((o) => `<div class="m-row m-row-4${o.active ? '' : ' retired'}"><span class="mono">${esc(o.id)}</span><b>${esc(o.name)}</b>
        <span class="muted">${OUTLET_KIND[o.kind] ?? o.kind}${o.serves_liquor ? ' · serves liquor' : ''}${o.active ? '' : ' · closed'}</span>
        ${this.canEdit ? `<button type="button" class="btn small" data-edit-outlet="${esc(o.id)}">Edit</button>` : '<span></span>'}</div>`).join('')}</div>`
  }

  // ---------- forms ----------
  private itemForm(i?: MenuItem) {
    const api = this.ws.api
    const cats = this.menu.categories
    const priceOnly = !this.canEdit
    const opt = (v: string, label: string, cur: string | null | undefined) => `<option value="${esc(v)}" ${v === (cur ?? '') ? 'selected' : ''}>${esc(label)}</option>`
    this.ws.modal.open(i ? `Edit ${i.name}` : 'Add dish', `<div class="form-grid">
      ${priceOnly ? '' : `<label>Code<input name="code" maxlength="12" value="${esc(i?.code ?? '')}" ${i ? 'disabled' : 'required'}></label>
      <label>Section<select name="category">${cats.map((c) => opt(c.id, c.name, i?.category_id ?? cats[0]?.id)).join('')}${opt('__new', 'New section…', '')}</select></label>
      <label class="span2" data-newcat hidden>New section name<input name="newCategory" maxlength="40"></label>
      <label class="span2">Name (English)<input name="name" maxlength="80" value="${esc(i?.name ?? '')}" required></label>
      <label class="span2">Name (Tamil)<input name="nameTa" maxlength="80" value="${esc(i?.name_ta ?? '')}" lang="ta"></label>`}
      <label>Price ₹<input name="price" type="number" min="0" step="0.5" value="${i ? i.price_paise / 100 : ''}" required></label>
      ${priceOnly ? '' : `<label>Station<select name="station">${this.allStations.filter((s) => s.active).map((s) => opt(s.id, `${s.name}${s.kind === 'bar' ? ' (bar)' : ''}`, i?.station_id)).join('')}</select></label>
      <label>Diet<select name="diet">${Object.entries(DIET).map(([k, v]) => opt(k, v, i?.diet ?? 'veg')).join('')}</select></label>
      <label>Liquor (TN VAT)<select name="liquor">${opt('', 'Not liquor (GST)', i?.liquor_class)}${this.classes.filter((c) => c.active).map((c) => opt(c.id, c.label, i?.liquor_class)).join('')}</select></label>
      <label class="span2">Allergens (comma separated)<input name="allergens" value="${esc(i?.allergens.join(', ') ?? '')}" placeholder="e.g. dairy, gluten, peanut"></label>
      <label class="check"><input type="checkbox" name="jain" ${i?.jain ? 'checked' : ''}> Jain</label>
      ${i ? `<label class="check"><input type="checkbox" name="active" ${i.active !== false ? 'checked' : ''}> On the menu</label>` : ''}`}
      </div>
      ${!this.canPrice ? '<p class="muted small">A price change goes to the GM for approval.</p>' : ''}`, i ? 'Save' : 'Add dish', async (f) => {
      let categoryId: string | undefined = val(f, 'category') || undefined
      if (categoryId === '__new') {
        const name = val(f, 'newCategory')
        if (!name) throw new Error('Name the new section.')
        categoryId = (await api.post<{ id: string }>('/api/fnb/categories', { outletId: this.outletId, name })).id
      }
      const body: Record<string, unknown> = { price: Number(val(f, 'price')) }
      if (!priceOnly) Object.assign(body, {
        name: val(f, 'name'), nameTa: val(f, 'nameTa') || null, categoryId, stationId: val(f, 'station'), diet: val(f, 'diet'),
        liquorClass: val(f, 'liquor') || null, allergens: val(f, 'allergens').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean), jain: checked(f, 'jain'),
      })
      if (!i) {
        await api.post('/api/fnb/items', { ...body, outletId: this.outletId, code: val(f, 'code').toUpperCase() })
        await this.reload(); return 'Dish added'
      }
      if (!priceOnly) body.active = checked(f, 'active')
      if (body.price === i.price_paise / 100) delete body.price
      const r = await api.req<{ pending?: boolean }>('PATCH', `/api/fnb/items/${i.id}`, body)
      await this.reload()
      return r.pending ? 'Saved. The new price waits for the GM\'s approval.' : 'Saved'
    })
    const sel = this.ws.modal.el.querySelector<HTMLSelectElement>('select[name=category]')
    const stationSel = this.ws.modal.el.querySelector<HTMLSelectElement>('select[name=station]')
    // A new dish goes to the station most of its section already uses (else the first kitchen station).
    const pickStation = () => {
      if (i || !stationSel) return
      const counts = new Map<string, number>()
      for (const x of this.menu.items) if (x.category_id === sel?.value) counts.set(x.station_id, (counts.get(x.station_id) ?? 0) + 1)
      const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? this.allStations.find((s) => s.active && s.kind === 'kitchen')?.id
      if (best) stationSel.value = best
    }
    pickStation()
    sel?.addEventListener('change', () => { this.ws.modal.el.querySelector<HTMLElement>('[data-newcat]')!.hidden = sel.value !== '__new'; pickStation() })
    if (sel && !cats.length) { sel.value = '__new'; this.ws.modal.el.querySelector<HTMLElement>('[data-newcat]')!.hidden = false }
  }

  private async reload() { await this.load(); this.ws.render() }

  async click(t: HTMLElement): Promise<boolean> {
    const api = this.ws.api, modal = this.ws.modal
    const get = (k: string) => t.closest<HTMLElement>(`[data-${k}]`)?.getAttribute(`data-${k}`) ?? undefined
    const sub = get('msub'); if (sub) { this.sub = sub as Sub; return true }
    const o = get('moutlet'); if (o) { this.outletId = o; await this.load(); return true }
    const ei = get('edit-item'); if (ei) { this.itemForm(this.menu.items.find((x) => x.id === ei)); return true }
    const cat = get('cat')
    if (cat) {
      const c = this.menu.categories.find((x) => x.id === cat)!
      modal.open('Rename section', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="40" value="${esc(c.name)}"></label><label>Order on the menu<input name="sort" type="number" value="${c.sort}"></label></div>`, 'Save', async (f) => {
        await api.req('PATCH', `/api/fnb/categories/${cat}`, { name: val(f, 'name'), sort: Number(val(f, 'sort')) }); await this.reload(); return 'Saved'
      })
      return true
    }
    const et = get('edit-table')
    if (et) {
      const tb = this.tables.find((x) => x.id === et)!
      modal.open(`Table ${tb.label}`, `<div class="form-grid"><label>Label<input name="label" maxlength="10" value="${esc(tb.label)}"></label><label>Seats<input name="seats" type="number" min="1" max="40" value="${tb.seats}"></label>
        <label class="span2">Section<input name="section" maxlength="30" value="${esc(tb.section ?? '')}"></label><label class="check"><input type="checkbox" name="retire"> Remove this table</label></div>`, 'Save', async (f) => {
        await api.req('PATCH', `/api/fnb/tables/${et}`, checked(f, 'retire') ? { active: false } : { label: val(f, 'label'), seats: Number(val(f, 'seats')), section: val(f, 'section') || null })
        await this.reload(); return 'Saved'
      })
      return true
    }
    const es = get('edit-station')
    if (es) {
      const s = this.allStations.find((x) => x.id === es)!
      modal.open(`Station ${s.name}`, `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="40" value="${esc(s.name)}"></label><label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> In use</label></div>`, 'Save', async (f) => {
        await api.req('PATCH', `/api/fnb/stations/${es}`, { name: val(f, 'name'), active: checked(f, 'active') }); await this.reload(); return 'Saved'
      })
      return true
    }
    const eo = get('edit-outlet'); if (eo) { this.outletForm(this.allOutlets.find((x) => x.id === eo)); return true }
    const act = get('m')
    if (!act) return false
    if (act === 'add-item') this.itemForm()
    if (act === 'add-cat') {
      modal.open('Add section', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="40" placeholder="e.g. Starters"></label></div>`, 'Add', async (f) => {
        await api.post('/api/fnb/categories', { outletId: this.outletId, name: val(f, 'name') }); await this.reload(); return 'Section added'
      })
    }
    if (act === 'add-table') {
      modal.open('Add table', `<div class="form-grid"><label>Label<input name="label" maxlength="10" placeholder="T21"></label><label>Seats<input name="seats" type="number" min="1" max="40" value="4"></label><label class="span2">Section<input name="section" maxlength="30"></label></div>`, 'Add', async (f) => {
        await api.post('/api/fnb/tables', { outletId: this.outletId, label: val(f, 'label'), seats: Number(val(f, 'seats')), section: val(f, 'section') || undefined }); await this.reload(); return 'Table added'
      })
    }
    if (act === 'add-station') {
      modal.open('Add kitchen or bar station', `<div class="form-grid"><label>Code<input name="id" maxlength="10" placeholder="TANDOOR"></label><label>Kind<select name="kind"><option value="kitchen">Kitchen (KOT)</option><option value="bar">Bar (BOT)</option></select></label>
        <label class="span2">Name<input name="name" maxlength="40"></label></div>`, 'Add', async (f) => {
        await api.post('/api/fnb/stations', { id: val(f, 'id').toUpperCase(), name: val(f, 'name'), kind: val(f, 'kind') }); await this.reload(); return 'Station added'
      })
    }
    if (act === 'add-outlet') this.outletForm()
    if (act === 'import') this.importForm()
    return true
  }

  private outletForm(o?: Outlet) {
    this.ws.modal.open(o ? `Edit ${o.name}` : 'Add outlet', `<div class="form-grid">
      <label>Code<input name="id" maxlength="10" value="${esc(o?.id ?? '')}" ${o ? 'disabled' : 'placeholder="CAFE"'}></label>
      <label>Kind<select name="kind">${Object.entries(OUTLET_KIND).map(([k, v]) => `<option value="${k}" ${k === (o?.kind ?? 'restaurant') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="span2">Name<input name="name" maxlength="60" value="${esc(o?.name ?? '')}"></label>
      <label class="span2">Building on the 3D map (place code, e.g. RESTAURANT)<input name="space" maxlength="40" value="${esc(o?.space_id ?? '')}"></label>
      <label class="check"><input type="checkbox" name="liquor" ${o?.serves_liquor ? 'checked' : ''}> Serves liquor (within the bar licence)</label>
      ${o ? `<label class="check"><input type="checkbox" name="active" ${o.active ? 'checked' : ''}> Open</label>` : ''}</div>`, o ? 'Save' : 'Add outlet', async (f) => {
      const body = { name: val(f, 'name'), kind: val(f, 'kind'), spaceId: val(f, 'space') || null, servesLiquor: checked(f, 'liquor') }
      if (o) await this.ws.api.req('PATCH', `/api/fnb/outlets/${o.id}`, { ...body, active: checked(f, 'active') })
      else await this.ws.api.post('/api/fnb/outlets', { ...body, id: val(f, 'id').toUpperCase() })
      await this.reload()
      return o ? 'Saved' : 'Outlet added'
    })
  }

  /** Paste rows from a spreadsheet or the Champagne export: code, name, Tamil name, price, station, diet, liquor class, section. */
  private importForm() {
    const outlet = this.allOutlets.find((o) => o.id === this.outletId)
    this.ws.modal.open(`Import menu · ${outlet?.name ?? ''}`, `<p class="muted small">One dish per line, columns separated by commas or tabs:<br><span class="mono">code, name, Tamil name, price, station, diet, liquor class, section</span><br>
      Diet is veg, egg or non_veg. Leave liquor class empty for food. Stations: ${this.allStations.filter((s) => s.active).map((s) => esc(s.id)).join(', ')}.</p>
      <div class="form-grid"><label class="span2">Dishes<textarea name="rows" rows="10" placeholder="BF02, Masala Dosa, மசாலா தோசை, 150, SI, veg, , Breakfast"></textarea></label>
      <label class="check span2"><input type="checkbox" name="replace" checked> Retire sample dishes that are not in this list</label></div>`, 'Import', async (f) => {
      const lines = val(f, 'rows').split('\n').map((l) => l.trim()).filter(Boolean)
      const items = lines.map((l, n) => {
        const c = l.split(l.includes('\t') ? '\t' : ',').map((x) => x.trim())
        if (c.length < 5) throw new Error(`Line ${n + 1}: needs at least code, name, Tamil name, price and station.`)
        return { code: c[0].toUpperCase(), name: c[1], nameTa: c[2] || null, price: Number(c[3]), stationId: c[4].toUpperCase(), diet: c[5] || 'veg', liquorClass: c[6] || null, category: c[7] || undefined }
      })
      const r = await this.ws.api.post<{ created: number; updated: number; retired: number }>('/api/fnb/menu/import', { outletId: this.outletId, items, replacePlaceholders: checked(f, 'replace') })
      await this.reload()
      return `Imported: ${r.created} new, ${r.updated} updated, ${r.retired} sample dishes retired`
    })
  }
}
