import { esc, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { chips, DIET, dietDot, rs, type Category, type MenuItem, type Outlet, type Station, type Table, type Ws } from './common'
import { toolbar, type Action } from '../ui/toolbar'

// Menu editor: outlets, menu sections and dishes (English and Tamil), prices, kitchen stations and
// tables. Price changes by anyone but the GM wait in the approval inbox; everything is logged.

type Sub = 'items' | 'tables' | 'stations' | 'outlets' | 'printers'
interface Printer { id: string; name: string; host: string; port: number; width: number; active: boolean }
interface PrintJob { id: string; kind: string; ref: string; status: string; attempts: number; error: string | null; created_at: string; printer: string }
const OUTLET_KIND: Record<string, string> = { restaurant: 'Restaurant', room_service: 'Room service', bar: 'Bar', poolside: 'Poolside', banquet: 'Banquet' }

export class MenuView {
  outletId = ''
  sub: Sub = 'items'
  private menu: { categories: Category[]; items: MenuItem[] } = { categories: [], items: [] }
  private tables: Table[] = []
  private classes: { id: string; label: string; active: boolean }[] = []
  private allOutlets: Outlet[] = []
  private allStations: Station[] = []
  private brands: { id: string; name: string; liquor_class: string; bottle_ml: number; active: boolean }[] = []
  private printing: { printers: Printer[]; stations: { id: string; name: string; printer_id: string | null }[]; outlets: { id: string; name: string; bill_printer_id: string | null }[]; agentConfigured: boolean; agentLastSeen: string | null } | null = null
  private jobs: PrintJob[] = []

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
    this.brands = await this.ws.api.get('/api/bar/brands')
    if (this.sub === 'printers') { this.printing = await this.ws.api.get('/api/printers'); this.jobs = await this.ws.api.get('/api/print-jobs') }
  }

  private get canEdit() { return this.ws.can('menu.edit') }
  private get canPrice() { return this.ws.can('menu.price') }
  private station = (id: string) => this.allStations.find((s) => s.id === id)?.name ?? id

  html() {
    const subs: [Sub, string][] = [['items', 'Dishes'], ['tables', 'Tables'], ['stations', 'Kitchen stations'], ['outlets', 'Outlets'], ['printers', 'Printers']]
    const outletChips = this.sub === 'items' || this.sub === 'tables'
      ? chips(this.allOutlets.filter((o) => o.active).map((o) => [o.id, o.name]), this.outletId, 'moutlet') : ''
    // One toolbar for the whole Menu tab: the sub-tab's main action on the left, the sub-tab and outlet chips in the middle.
    const primary: Action[] = this.sub === 'items' ? (this.canEdit ? [{ attrs: 'data-m="add-item"', label: 'Add dish' }, { attrs: 'data-m="add-cat"', label: 'Add section', primary: false }] : [])
      : this.sub === 'tables' ? (this.canEdit ? [{ attrs: 'data-m="add-table"', label: 'Add table' }] : [])
      : this.sub === 'stations' ? (this.canEdit ? [{ attrs: 'data-m="add-station"', label: 'Add station' }] : [])
      : this.sub === 'printers' ? (this.ws.can('printers.manage') ? [{ attrs: 'data-m="add-printer"', label: 'Add printer' }] : [])
      : this.canEdit ? [{ attrs: 'data-m="add-outlet"', label: 'Add outlet' }] : []
    const more: Action[] = this.sub === 'items' && this.canPrice ? [{ attrs: 'data-m="import"', label: 'Import menu' }] : []
    return toolbar({ primary, filters: chips(subs, this.sub, 'msub') + outletChips, more }) + (
      this.sub === 'items' ? this.itemsHtml() : this.sub === 'tables' ? this.tablesHtml() : this.sub === 'stations' ? this.stationsHtml() : this.sub === 'printers' ? this.printersHtml() : this.outletsHtml())
  }

  private itemsHtml() {
    const { categories, items } = this.menu
    const placeholder = items.some((i) => i.placeholder && i.active !== false)
    const bar = placeholder ? '<p class="fd-warn small">Dishes marked "sample" are placeholders. Import the real menu or edit them.</p>' : ''
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
    return `<div class="m-table">${this.tables.map((t) => `<div class="m-row m-row-4"><b>${esc(t.label)}</b><span>${t.seats} seats</span><span class="muted">${esc(t.section ?? '')}</span>
        ${this.canEdit ? `<button type="button" class="btn small" data-edit-table="${esc(t.id)}">Edit</button>` : '<span></span>'}</div>`).join('') || '<div class="empty">This outlet has no tables (room service and takeaway don\'t need them).</div>'}</div>`
  }

  private stationsHtml() {
    return `<p class="muted small">Each dish goes to one station. Kitchen stations get KOTs, bar stations get BOTs.</p>
      <div class="m-table">${this.allStations.map((s) => `<div class="m-row m-row-4${s.active ? '' : ' retired'}"><span class="mono">${esc(s.id)}</span><b>${esc(s.name)}</b><span class="muted">${s.kind === 'bar' ? 'Bar (BOT)' : 'Kitchen (KOT)'}${s.active ? '' : ' · retired'}</span>
        ${this.canEdit ? `<button type="button" class="btn small" data-edit-station="${esc(s.id)}">Edit</button>` : '<span></span>'}</div>`).join('')}</div>`
  }

  private printersHtml() {
    const p = this.printing!
    const canEdit = this.ws.can('printers.manage')
    const opts = (cur: string | null) => `<option value="">Screen only</option>${p.printers.filter((x) => x.active).map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}`
    const seen = p.agentLastSeen ? Math.round((Date.now() - new Date(p.agentLastSeen).getTime()) / 60000) : null
    const JOB: Record<string, [string, string]> = { queued: ['Waiting', '--marigold'], printing: ['Printing', '--st-occupied'], done: ['Printed', '--st-vacant'], failed: ['Failed', '--st-departing'] }
    return `<p class="muted small">Kitchen, bar and bill printers on the resort network print through the print agent on the edge box.
        ${p.agentConfigured ? (seen == null ? 'The agent has not collected a job yet.' : `The agent last collected jobs ${seen} min ago.`) : '<span class="fd-warn">The print agent is not set up on this server yet (see the edge box guide).</span>'}</p>
      <div class="m-table">${p.printers.map((x) => `<div class="m-row m-row-4${x.active ? '' : ' retired'}"><b>${esc(x.name)}</b><span class="mono">${esc(x.host)}:${x.port}</span><span class="muted small">${x.width === 48 ? '80 mm' : x.width === 32 ? '58 mm' : `${x.width} chars`}</span>
        ${canEdit ? `<span><button type="button" class="btn small" data-test-printer="${esc(x.id)}">Test</button> <button type="button" class="btn small" data-edit-printer="${esc(x.id)}">Edit</button></span>` : '<span></span>'}</div>`).join('') || '<div class="empty">No printers yet. Tickets show on the kitchen screens only.</div>'}</div>
      ${p.printers.length ? `<form class="form-grid print-routes" data-routes>
        <div class="sec-title span2">Kitchen and bar tickets</div>
        ${p.stations.map((s) => `<label>${esc(s.name)}<select name="s_${esc(s.id)}" ${canEdit ? '' : 'disabled'}>${opts(s.printer_id)}</select></label>`).join('')}
        <div class="sec-title span2">Bills</div>
        ${p.outlets.map((o) => `<label>${esc(o.name)}<select name="o_${esc(o.id)}" ${canEdit ? '' : 'disabled'}>${opts(o.bill_printer_id)}</select></label>`).join('')}
        ${canEdit ? '<div class="span2"><button type="submit" class="btn">Save routing</button></div>' : ''}</form>` : ''}
      <div class="sec-title">Recent print jobs</div>
      ${this.jobs.map((j) => `<div class="row-card"><div class="rc-title">${esc(j.ref)} · ${esc(j.printer)}</div><div class="rc-sub">${new Date(j.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}${j.attempts > 1 ? ` · ${j.attempts} tries` : ''}${j.error ? ` · ${esc(j.error)}` : ''}</div>
        <div class="rc-right">${tonePill(...JOB[j.status])}${j.status === 'failed' ? `<button type="button" class="btn small" data-retry-job="${esc(j.id)}">Retry</button>` : ''}</div></div>`).join('') || '<div class="empty">Nothing printed yet.</div>'}`
  }

  async submit(form: HTMLFormElement): Promise<boolean> {
    if (!form.hasAttribute('data-routes') || !this.printing) return false
    const stations = Object.fromEntries(this.printing.stations.map((s) => [s.id, val(form, `s_${s.id}`) || null]))
    const outlets = Object.fromEntries(this.printing.outlets.map((o) => [o.id, val(form, `o_${o.id}`) || null]))
    await this.ws.api.req('PUT', '/api/printers/routes', { stations, outlets })
    await this.load()
    return true
  }

  private printerForm(p?: Printer) {
    this.ws.modal.open(p ? `Printer · ${p.name}` : 'Add printer', `<div class="form-grid">
      <label class="span2">Name<input name="name" maxlength="40" value="${esc(p?.name ?? '')}" placeholder="e.g. Main kitchen"></label>
      <label>IP address<input name="host" maxlength="64" value="${esc(p?.host ?? '')}" placeholder="192.168.1.50"></label><label>Port<input name="port" type="number" value="${p?.port ?? 9100}"></label>
      <label>Paper<select name="width"><option value="48" ${p?.width !== 32 ? 'selected' : ''}>80 mm</option><option value="32" ${p?.width === 32 ? 'selected' : ''}>58 mm</option></select></label>
      ${p ? `<label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> In use</label>` : ''}</div>
      <p class="muted small">Thermal printers on the network listen on port 9100. Print a test page after adding it.</p>`, p ? 'Save' : 'Add', async (f) => {
      const body = { name: val(f, 'name'), host: val(f, 'host'), port: Number(val(f, 'port')), width: Number(val(f, 'width')) }
      if (p) await this.ws.api.req('PATCH', `/api/printers/${p.id}`, { ...body, active: checked(f, 'active') })
      else await this.ws.api.post('/api/printers', body)
      await this.reload(); return 'Saved'
    })
  }

  private outletsHtml() {
    return `<div class="m-table">${this.allOutlets.map((o) => `<div class="m-row m-row-4${o.active ? '' : ' retired'}"><span class="mono">${esc(o.id)}</span><b>${esc(o.name)}</b>
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
      <label data-pour ${i?.liquor_class ? '' : 'hidden'}>Brand poured<select name="brand"><option value="">Not tracked</option>${this.brands.filter((b) => b.active).map((b) => `<option value="${esc(b.id)}" data-cls="${esc(b.liquor_class)}" ${b.id === i?.brand_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
      <label data-pour ${i?.liquor_class ? '' : 'hidden'}>Pour (ml)<input name="pour" type="number" min="5" step="5" value="${i?.pour_ml ?? 30}"></label>
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
      const pour = async (id: string) => {
        if (priceOnly || !body.liquorClass) return
        const brandId = val(f, 'brand') || null
        if (brandId !== (i?.brand_id ?? null) || Number(val(f, 'pour')) !== (i?.pour_ml ?? null)) await api.post(`/api/fnb/items/${id}/pour`, { brandId, pourMl: Number(val(f, 'pour')) })
      }
      if (!i) {
        const r = await api.post<{ id: string }>('/api/fnb/items', { ...body, outletId: this.outletId, code: val(f, 'code').toUpperCase() })
        await pour(r.id)
        await this.reload(); return 'Dish added'
      }
      await pour(i.id)
      if (!priceOnly) body.active = checked(f, 'active')
      if (body.price === i.price_paise / 100) delete body.price
      const r = await api.req<{ pending?: boolean }>('PATCH', `/api/fnb/items/${i.id}`, body)
      await this.reload()
      return r.pending ? 'Saved. The new price waits for the GM\'s approval.' : 'Saved'
    })
    const liq = this.ws.modal.el.querySelector<HTMLSelectElement>('select[name=liquor]')
    liq?.addEventListener('change', () => this.ws.modal.el.querySelectorAll<HTMLElement>('[data-pour]').forEach((x) => { x.hidden = !liq.value }))
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
    const sub = get('msub'); if (sub) { this.sub = sub as Sub; await this.load(); return true }
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
    const ep = get('edit-printer'); if (ep) { this.printerForm(this.printing!.printers.find((x) => x.id === ep)); return true }
    const tp = get('test-printer'); if (tp) { await api.post(`/api/printers/${tp}/test`); await this.load(); return true }
    const rj = get('retry-job'); if (rj) { await api.post(`/api/print-jobs/${rj}/retry`); await this.load(); return true }
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
    if (act === 'add-printer') this.printerForm()
    if (act === 'import') this.importForm()
    return true
  }

  private outletForm(o?: Outlet) {
    this.ws.modal.open(o ? `Edit ${o.name}` : 'Add outlet', `<div class="form-grid">
      <label>Code<input name="id" maxlength="10" value="${esc(o?.id ?? '')}" ${o ? 'disabled' : 'placeholder="CAFE"'}></label>
      <label>Kind<select name="kind">${Object.entries(OUTLET_KIND).map(([k, v]) => `<option value="${k}" ${k === (o?.kind ?? 'restaurant') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="span2">Name<input name="name" maxlength="60" value="${esc(o?.name ?? '')}"></label>
      <label class="span2">Where on the map (its orders show there)<select name="space" data-places><option value="">Choose the place…</option></select></label>
      <label class="check"><input type="checkbox" name="liquor" ${o?.serves_liquor ? 'checked' : ''}> Serves liquor (within the bar licence)</label>
      ${o ? `<label class="check"><input type="checkbox" name="active" ${o.active ? 'checked' : ''}> Open</label>` : ''}</div>`, o ? 'Save' : 'Add outlet', async (f) => {
      const body = { name: val(f, 'name'), kind: val(f, 'kind'), spaceId: val(f, 'space') || null, servesLiquor: checked(f, 'liquor') }
      if (o) await this.ws.api.req('PATCH', `/api/fnb/outlets/${o.id}`, { ...body, active: checked(f, 'active') })
      else await this.ws.api.post('/api/fnb/outlets', { ...body, id: val(f, 'id').toUpperCase() })
      await this.reload()
      return o ? 'Saved' : 'Outlet added'
    })
    // Every hall, lawn, building and pool on the map, by name: an outlet's orders are shown above the place chosen.
    const sel = this.ws.modal.el.querySelector<HTMLSelectElement>('[data-places]')!
    void this.ws.api.get<{ id: string; kind: string; name: string | null; room_no: string | null }[]>('/api/spaces').then((sp) => {
      const places = sp.filter((x) => !x.room_no && !['room', 'villa', 'suite'].includes(x.kind)).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
      sel.insertAdjacentHTML('beforeend', places.map((x) => `<option value="${esc(x.id)}" ${x.id === o?.space_id ? "selected" : ""}>${esc(x.name ?? x.id)} · ${esc(x.kind)}</option>`).join(''))
    }).catch(() => {})
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
