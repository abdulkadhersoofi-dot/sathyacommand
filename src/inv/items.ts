import { esc, toast, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { toolbar } from '../ui/toolbar'
import type { WorkspaceHost } from '../ui/workspace'

// The item master: what the resort buys, how it is counted (stock unit) and bought (purchase unit), its
// HSN, GST rate and input tax credit, and which department book it feeds.

export interface Item {
  id: string; name: string; category: string; unit: string; purchase_unit: string; purchase_factor: string; hsn: string | null; gst_rate: string | null; itc: string
  perishable: boolean; shelf_life_days: number | null; default_store_id: string | null; default_store: string | null; par_level: string | null; reorder_qty: string | null
  ingredient: string | null; spare: string | null; linen_item: string | null; brand: string | null; barcode: string | null; best_rate_paise: number | null; active: boolean
}
export interface Store { id: string; name: string; kind: string; ledger: string; space: string | null; active: boolean }

export const CATEGORY: Record<string, string> = {
  food: 'Food', beverage: 'Beverages', liquor: 'Liquor', housekeeping: 'Housekeeping', amenities: 'Guest amenities', linen: 'Linen', engineering: 'Engineering',
  crockery: 'Crockery & glassware', stationery: 'Stationery', cleaning: 'Cleaning', other: 'Other',
}
export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
/** "2.5 bag of 25 kg" from a stock quantity. */
export const inPurchase = (qty: number, i: { purchase_factor: string; purchase_unit: string }) =>
  `${(qty / Number(i.purchase_factor)).toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${i.purchase_unit}`

const linkOf = (i: Item) => i.ingredient ? `Kitchen: ${i.ingredient}` : i.brand ? `Bar: ${i.brand}` : i.spare ? `Spares: ${i.spare}` : i.linen_item ? `Linen: ${i.linen_item}` : null

export class ItemsView {
  private list: Item[] = []
  private q = ''
  private cat = ''
  constructor(private h: WorkspaceHost & { stores(): Promise<Store[]> }) {}

  async load() { this.list = await this.h.cached('/api/items?all=1') }

  html() {
    const q = this.q.toLowerCase()
    const shown = this.list.filter((i) => (!this.cat || i.category === this.cat) && (!q || `${i.name} ${i.hsn ?? ''} ${i.barcode ?? ''}`.toLowerCase().includes(q)))
    const cats = [...new Set(this.list.map((i) => i.category))]
    const manage = this.h.can('stores.manage')
    return `${toolbar({
      primary: manage ? [{ attrs: 'data-it="add"', label: 'Add item' }] : [],
      filters: `<input class="ws-search" type="search" placeholder="Search name, HSN or barcode" value="${esc(this.q)}" aria-label="Search items">
        <div class="chips"><button type="button" class="chip" data-ic="" aria-pressed="${!this.cat}">All ${this.list.length}</button>${cats.map((c) => `<button type="button" class="chip" data-ic="${c}" aria-pressed="${this.cat === c}">${esc(CATEGORY[c] ?? c)}</button>`).join('')}</div>`,
      more: manage ? [{ attrs: 'data-it="import"', label: 'Bring in kitchen, bar, spares and linen' }] : [],
    })}
      <div class="m-table"><div class="m-row item-row head"><span>Item</span><span>Bought as</span><span>HSN · GST</span><span>Best rate</span><span>Book</span></div>
      ${shown.map((i) => `<div class="m-row item-row${i.active ? '' : ' retired'}" data-asset="${esc(i.id)}"><b>${esc(i.name)}<small class="muted"> ${esc(CATEGORY[i.category] ?? i.category)}${i.perishable ? ' · perishable' : ''}</small></b>
        <span>${esc(i.purchase_unit)} <small class="muted">= ${Number(i.purchase_factor).toLocaleString('en-IN')} ${esc(i.unit)}</small></span>
        <span>${i.hsn ? esc(i.hsn) : '<span class="fd-warn">HSN?</span>'} · ${i.gst_rate != null ? `${Number(i.gst_rate)}%` : '<span class="fd-warn">GST?</span>'}${i.itc !== 'full' ? ` ${tonePill(i.itc === 'blocked' ? 'ITC blocked' : 'No ITC', '--muted')}` : ''}</span>
        <span class="mono">${i.best_rate_paise != null ? rupees(i.best_rate_paise) : '—'}</span><span class="muted small">${esc(linkOf(i) ?? i.default_store ?? '')}</span></div>`).join('') || '<div class="empty">No items.</div>'}</div>`
  }

  onInput(el: HTMLElement) { if (el.classList.contains('ws-search')) { this.q = (el as HTMLInputElement).value; this.h.render() } }

  async click(el: HTMLElement): Promise<boolean> {
    const c = el.closest<HTMLElement>('[data-ic]')?.dataset.ic
    if (c !== undefined) { this.cat = c; return true }
    const a = el.closest<HTMLElement>('[data-it]')?.dataset.it
    if (a === 'import') {
      const r = await this.h.api.post<{ added: number }>('/api/items/from-departments')
      toast(r.added ? `${r.added} items added from the department books. Fill in their HSN and GST.` : 'Everything is already in the item master.')
      await this.load(); return true
    }
    if (a === 'add') { await this.edit(); return false }
    const id = el.closest<HTMLElement>('[data-asset]')?.dataset.asset
    if (id && this.h.can('stores.manage')) await this.edit(this.list.find((i) => i.id === id))
    return false
  }

  private async edit(i?: Item) {
    const stores = (await this.h.stores()).filter((s) => s.active)
    const units = ['g', 'ml', 'pcs', 'm', 'set', 'pair']
    const linked = i && linkOf(i)
    this.h.modal.open(i ? i.name : 'Add item', `<div class="form-grid">
        <label class="span2">Name<input name="name" maxlength="80" value="${esc(i?.name ?? '')}" placeholder="e.g. Ponni rice, Toilet roll, Glass tumbler"></label>
        <label>Category<select name="category">${Object.entries(CATEGORY).map(([k, v]) => `<option value="${k}" ${k === i?.category ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Kept in<select name="store"><option value="">—</option>${stores.map((s) => `<option value="${esc(s.id)}" ${s.id === i?.default_store_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label>Counted in (stock unit)<select name="unit" ${linked ? 'disabled' : ''}>${units.map((u) => `<option ${u === (i?.unit ?? 'g') ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        <label>Bought as<input name="purchaseUnit" maxlength="30" value="${esc(i?.purchase_unit ?? '')}" placeholder="kg, litre, case of 24, box of 100"></label>
        <label class="span2">How many stock units in one “bought as”<input name="factor" type="number" min="0.001" step="any" value="${i ? Number(i.purchase_factor) : ''}" placeholder="e.g. 1000 (g in a kg), 24 (bottles in a case)"></label>
        <label>HSN code<input name="hsn" inputmode="numeric" maxlength="8" value="${esc(i?.hsn ?? '')}"></label>
        <label>GST rate<select name="gst"><option value="">— not set —</option>${[0, 0.25, 3, 5, 12, 18, 28, 40].map((r) => `<option value="${r}" ${i?.gst_rate != null && Number(i.gst_rate) === r ? 'selected' : ''}>${r}%</option>`).join('')}</select></label>
        <label>Input tax credit<select name="itc">${[['full', 'Claimable'], ['none', 'Not claimable (e.g. used for exempt supplies)'], ['blocked', 'Blocked (food for staff, gifts…)']].map(([k, v]) => `<option value="${k}" ${k === (i?.itc ?? 'full') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Barcode<input name="barcode" maxlength="40" value="${esc(i?.barcode ?? '')}"></label>
        <label>Reorder below (stock units)<input name="par" type="number" min="0" step="any" value="${i?.par_level != null ? Number(i.par_level) : ''}"></label>
        <label>Order quantity (stock units)<input name="reorder" type="number" min="0" step="any" value="${i?.reorder_qty != null ? Number(i.reorder_qty) : ''}"></label>
        <label class="check"><input type="checkbox" name="perishable" ${i?.perishable ? 'checked' : ''}> Perishable (batches and expiry)</label>
        <label>Shelf life (days)<input name="shelf" type="number" min="1" value="${i?.shelf_life_days ?? ''}"></label>
        ${i ? `<label class="check span2"><input type="checkbox" name="active" ${i.active ? 'checked' : ''}> In use</label>` : ''}</div>
      ${linked ? `<p class="muted small">Linked to ${esc(linked)}: goods received into its store go straight into that book.</p>` : ''}
      <p class="muted small">HSN and GST rates are confirmed by the CA; leave them blank until then.</p>`, i ? 'Save' : 'Add', async (f) => {
      const n = (k: string) => (val(f, k) === '' ? null : Number(val(f, k)))
      const body = {
        name: val(f, 'name'), category: val(f, 'category'), defaultStoreId: val(f, 'store') || null, ...(linked ? {} : { unit: val(f, 'unit') }),
        purchaseUnit: val(f, 'purchaseUnit'), purchaseFactor: Number(val(f, 'factor')), hsn: val(f, 'hsn') || null, gstRate: n('gst'), itc: val(f, 'itc'),
        barcode: val(f, 'barcode') || null, parLevel: n('par'), reorderQty: n('reorder'), perishable: checked(f, 'perishable'), shelfLifeDays: n('shelf'), ...(i ? { active: checked(f, 'active') } : {}),
      }
      if (i) await this.h.api.req('PATCH', `/api/items/${i.id}`, body)
      else await this.h.api.post('/api/items', body)
      await this.load(); this.h.render(); return i ? 'Saved' : 'Item added'
    })
  }
}

export class StoresView {
  constructor(private h: WorkspaceHost & { stores(fresh?: boolean): Promise<Store[]> }) {}
  private list: Store[] = []

  async load() { this.list = await this.h.stores(true) }

  html() {
    const BOOK: Record<string, string> = { own: 'Kept here', kitchen: 'Kitchen ingredient book', bar: 'Bar register (ml)', spares: 'Engineering spares book', linen: 'Linen book' }
    return `${toolbar({ primary: this.h.can('stores.manage') ? [{ attrs: 'data-sv="add"', label: 'Add store' }] : [] })}
      ${this.list.map((s) => `<div class="row-card${s.active ? '' : ' retired'}"><div class="rc-title">${esc(s.name)}</div><div class="rc-sub">${esc(BOOK[s.ledger] ?? s.ledger)}${s.space ? ` · ${esc(s.space)}` : ''}</div></div>`).join('')}
      <p class="muted small">Department stores keep stock in the books the kitchen, bar, engineering and housekeeping already use: goods received or issued into them go straight there.</p>`
  }

  async click(el: HTMLElement): Promise<boolean> {
    if (!el.closest('[data-sv=add]')) return false
    this.h.modal.open('Add store', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="60" placeholder="e.g. Banquet store, Amenities store"></label>
      <label>Kind<select name="kind"><option value="main">Main store</option><option value="housekeeping">Housekeeping</option><option value="other">Other</option></select></label></div>`, 'Add', async (f) => {
      await this.h.api.post('/api/stores', { name: val(f, 'name'), kind: val(f, 'kind') }); await this.load(); this.h.render(); return 'Store added'
    })
    return false
  }
}
