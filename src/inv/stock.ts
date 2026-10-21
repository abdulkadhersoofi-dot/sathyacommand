import { esc, toast, tonePill, showDate } from '../ui/dom'
import { val } from '../ui/form-modal'
import { scanQr } from '../ui/qr-scan'
import type { WorkspaceHost } from '../ui/workspace'
import { CATEGORY, rupees, type Item, type Store } from './items'

// What is in each store and what it is worth; issues to departments and transfers between stores;
// opening stock; counts (on the phone, by scanning or searching) and the breakage register.

type Host = WorkspaceHost & { stores(): Promise<Store[]>; items(): Promise<Item[]> }
interface Row { itemId: string; item: string; category: string; unit: string; purchaseUnit: string; factor: number; barcode: string | null; stock: number; avgCostPaise: number; valuePaise: number; par: number | null; low: boolean; nextExpiry: string | null }
const DEPARTMENTS: [string, string][] = [['rooms', 'Rooms'], ['kitchen', 'Kitchen'], ['restaurant', 'Restaurant'], ['bar', 'Bar'], ['banquets', 'Banquets'], ['front_office', 'Front office'],
  ['engineering', 'Engineering'], ['garden', 'Garden'], ['staff_canteen', 'Staff canteen'], ['admin', 'Admin'], ['other', 'Other']]
const BARCODES = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'upc_a', 'code_39']
const pu = (qty: number, r: { factor: number; purchaseUnit: string }) => `${(qty / r.factor).toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${r.purchaseUnit}`
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)

export class StockView {
  private storeId = 'ST-MAIN'
  private rows: Row[] = []
  private ledger = 'own'
  private value = 0
  private q = ''
  constructor(private h: Host) {}

  async load() {
    const r = await this.h.cached<{ items: Row[]; ledger: string; valuePaise: number }>(`/api/stock?storeId=${this.storeId}`)
    this.rows = r.items; this.ledger = r.ledger; this.value = r.valuePaise
  }

  html() {
    const q = this.q.toLowerCase()
    const shown = this.rows.filter((r) => !q || r.item.toLowerCase().includes(q) || r.barcode === this.q)
    const own = this.ledger === 'own'
    return `<div class="ws-toolbar"><select data-store aria-label="Store"></select>
        ${own && this.h.can('stores.issue') ? '<button type="button" class="btn primary" data-sk="issue">Issue to a department</button><button type="button" class="btn" data-sk="transfer">Transfer to a store</button>' : ''}
        ${own && this.h.can('stores.manage') ? '<button type="button" class="btn" data-sk="opening">Opening stock</button>' : ''}
        ${this.h.can('stores.manage', 'stores.issue', 'stores.count') ? '<button type="button" class="btn" data-sk="labels">Print labels</button>' : ''}
        <input class="ws-search" type="search" placeholder="Search or barcode" value="${esc(this.q)}" aria-label="Search stock"><span class="muted small">Worth ${rupees(this.value)}</span></div>
      ${own ? '' : '<p class="muted small">This store keeps its stock in its department\'s book (kitchen, bar, engineering or linen); counts and use are recorded there.</p>'}
      <div class="m-table"><div class="m-row stock-row head"><span>Item</span><span>In stock</span><span>Average cost</span><span>Value</span><span></span></div>
      ${shown.map((r) => `<div class="m-row stock-row${r.low ? ' warn' : ''}"><b>${esc(r.item)}<small class="muted"> ${esc(CATEGORY[r.category] ?? r.category)}</small></b>
        <span class="mono">${pu(r.stock, r)}${r.low ? ` ${tonePill('Below level', '--marigold')}` : ''}</span>
        <span class="mono">${rupees(r.avgCostPaise * r.factor)} <small class="muted">/ ${esc(r.purchaseUnit)}</small></span><span class="mono">${rupees(r.valuePaise)}</span>
        <span>${r.nextExpiry ? `<small class="${r.nextExpiry <= today() ? 'fd-warn' : 'muted'}">use by ${esc(r.nextExpiry)}</small>` : ''}</span></div>`).join('') || '<div class="empty">Nothing in this store.</div>'}</div>`
  }

  mounted(root: HTMLElement) {
    // The store picker is filled after the screen is drawn (the list is cached by the workspace).
    void this.h.stores().then((stores) => {
      const sel = root.querySelector<HTMLSelectElement>('[data-store]')
      if (sel) sel.innerHTML = stores.filter((s) => s.active).map((s) => `<option value="${esc(s.id)}" ${s.id === this.storeId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
    })
  }

  onInput(el: HTMLElement) { if (el.classList.contains('ws-search')) { this.q = (el as HTMLInputElement).value; this.h.render() } }

  async change(el: HTMLElement): Promise<boolean> {
    if (!el.matches('[data-store]')) return false
    this.storeId = (el as HTMLSelectElement).value; await this.load(); return true
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-sk]')?.dataset.sk
    if (!a) return false
    if (a === 'labels') { await this.h.api.openDocument(`/api/items/labels?storeId=${this.storeId}`); return false }
    if (a === 'opening') { await this.opening(); return false }
    await issueForm(this.h, { fromStoreId: this.storeId, transfer: a === 'transfer' }, async () => { await this.load(); this.h.render() })
    return false
  }

  private async opening() {
    const empty = this.rows.filter((r) => r.stock === 0)
    const items = (await this.h.items()).filter((i) => i.default_store_id === this.storeId)
    const list = items.filter((i) => empty.some((r) => r.itemId === i.id) || !this.rows.some((r) => r.itemId === i.id))
    if (!list.length) { toast('Every item here already has stock: correct it with a count.'); return }
    this.h.modal.open('Opening stock', `<p class="muted small">What is on the shelf today, and what it cost. Only for items with no movements yet; after this, counts correct the book.</p>
      <div class="count-grid">${list.map((i) => `<label><span>${esc(i.name)} <small class="muted">${esc(i.purchase_unit)}</small></span><input name="q_${esc(i.id)}" type="number" min="0" step="any" placeholder="qty" aria-label="Quantity"><input name="r_${esc(i.id)}" type="number" min="0" step="0.01" placeholder="₹ each" aria-label="Rate"></label>`).join('')}</div>`, 'Save opening stock', async (f) => {
      const lines = list.filter((i) => val(f, `q_${i.id}`) !== '').map((i) => ({ itemId: i.id, qty: Number(val(f, `q_${i.id}`)), rate: Number(val(f, `r_${i.id}`) || 0) }))
      if (!lines.length) throw new Error('Enter at least one quantity.')
      const r = await this.h.api.post<{ valuePaise: number }>('/api/stock/opening', { storeId: this.storeId, lines })
      await this.load(); this.h.render(); return `Opening stock worth ${rupees(r.valuePaise)} saved`
    })
  }
}

/** Issue to a department, or transfer to another store; optionally against an approved indent (lines filled in from it). */
export async function issueForm(h: Host, o: { fromStoreId: string; transfer?: boolean; indent?: { id: string; number: string; store_id?: string; lines: { item_id: string; purchaseQty: number }[] } }, done: () => Promise<void>) {
  const [items, stores] = await Promise.all([h.items(), h.stores()])
  const opts = (sel?: string) => `<option value="">—</option>${items.map((i) => `<option value="${esc(i.id)}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)} (${esc(i.purchase_unit)})</option>`).join('')}`
  const pre = o.indent?.lines ?? []
  const rows = Math.max(5, pre.length + 1)
  const transfer = o.transfer || !!o.indent
  h.modal.open(o.indent ? `Issue against ${o.indent.number}` : transfer ? 'Transfer to a store' : 'Issue to a department', `<div class="form-grid">
      <label>From<select name="from">${stores.filter((s) => s.active && s.ledger === 'own').map((s) => `<option value="${esc(s.id)}" ${s.id === o.fromStoreId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      ${transfer ? `<label>To store<select name="to">${stores.filter((s) => s.active).map((s) => `<option value="${esc(s.id)}" ${s.id === o.indent?.store_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>`
        : `<label>To department<select name="dept">${DEPARTMENTS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>`}</div>
    <div class="line-editor">${Array.from({ length: rows }, (_, k) => `<div class="le-row"><select name="i_${k}" aria-label="Item">${opts(pre[k]?.item_id)}</select><input name="q_${k}" type="number" min="0" step="any" placeholder="Qty" value="${pre[k] ? pre[k].purchaseQty : ''}"></div>`).join('')}</div>
    <div class="form-grid"><label class="span2">Note<input name="note" maxlength="200"></label></div>`, transfer ? 'Transfer' : 'Issue', async (f) => {
    const lines = []
    for (let k = 0; k < rows; k++) if (val(f, `i_${k}`)) lines.push({ itemId: val(f, `i_${k}`), qty: Number(val(f, `q_${k}`)) })
    if (!lines.length) throw new Error('Choose what is going out.')
    const r = await h.api.post<{ number: string; valuePaise: number }>('/api/stock/issue', {
      fromStoreId: val(f, 'from'), ...(transfer ? { toStoreId: val(f, 'to') } : { department: val(f, 'dept') }), indentId: o.indent?.id, note: val(f, 'note') || undefined, lines,
    })
    await done()
    return `${r.number}: ${rupees(r.valuePaise)} ${transfer ? 'transferred' : 'issued'}`
  })
}

interface Count { id: string; number: string; store: string; business_date: string; status: string; variance_value_paise: string; variance_abs_paise: string; book_value_paise: string; counted_by_name: string; decided_by_name: string | null
  lines: { item: string; unit: string; purchase_unit: string; purchase_factor: string; book_qty: string; counted_qty: string; variance_paise: string }[] }
interface Breakage { id: string; item: string; qty: string; unit: string; value_paise: string; department: string; charge_to: string; guest: string | null; staff_name: string | null; charged_paise: string; at: string; by: string; note: string | null }

export class CountsView {
  private counts: Count[] = []
  private breakage: Breakage[] = []
  constructor(private h: Host) {}

  async load() {
    this.counts = this.h.can('stores.count', 'stores.view', 'stock.approve') ? await this.h.cached('/api/stock/counts') : []
    this.breakage = await this.h.cached('/api/stock/breakage')
  }

  html() {
    const STATE: Record<string, [string, string]> = { pending_approval: ['Waiting for GM', '--marigold'], applied: ['Book corrected', '--st-vacant'], rejected: ['Turned down', '--muted'] }
    const n = (v: string) => Number(v)
    return `<div class="ws-toolbar">${this.h.can('stores.count') ? '<button type="button" class="btn primary" data-ct="count">Count a store</button>' : ''}${this.h.can('stores.breakage') ? '<button type="button" class="btn" data-ct="break">Record breakage</button>' : ''}</div>
      <div class="sec-title">Counts</div>
      ${this.counts.map((c) => `<div class="row-card"><div class="rc-title">${esc(c.number)} · ${esc(c.store)} · ${esc(showDate(c.business_date))}</div>
        <div class="rc-sub">${c.lines.filter((l) => n(l.variance_paise)).slice(0, 6).map((l) => `${esc(l.item)} ${n(l.variance_paise) < 0 ? 'short' : 'over'} ${((n(l.counted_qty) - n(l.book_qty)) / n(l.purchase_factor)).toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${esc(l.purchase_unit)} (${rupees(n(l.variance_paise))})`).join(' · ') || 'No differences'}</div>
        <div class="rc-sub">Counted by ${esc(c.counted_by_name)}${c.decided_by_name ? ` · approved by ${esc(c.decided_by_name)}` : ''} · ${n(c.book_value_paise) ? `${((Math.abs(n(c.variance_value_paise)) / n(c.book_value_paise)) * 100).toFixed(2)}% of ${rupees(n(c.book_value_paise))}` : ''}</div>
        <div class="rc-right"><b class="mono ${n(c.variance_value_paise) < 0 ? 'fd-warn' : ''}">${rupees(n(c.variance_value_paise))}</b>${tonePill(...(STATE[c.status] ?? [c.status, '--muted']))}</div></div>`).join('') || '<div class="empty">No counts yet.</div>'}
      <div class="sec-title">Breakage, last 30 days <span>${rupees(this.breakage.reduce((a, b) => a + n(b.value_paise), 0))}</span></div>
      ${this.breakage.map((b) => `<div class="m-row ping-row"><span class="mono">${new Date(b.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span><b>${n(b.qty)} × ${esc(b.item)}</b>
        <span>${esc(b.department)} · ${b.charge_to === 'guest' ? `charged to ${esc(b.guest ?? 'guest')} ${rupees(n(b.charged_paise))}` : b.charge_to === 'staff' ? `staff: ${esc(b.staff_name ?? '')}` : 'house'} · ${rupees(n(b.value_paise))}</span></div>`).join('') || '<div class="empty">No breakage recorded.</div>'}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-ct]')?.dataset.ct
    if (a === 'count') await this.count()
    if (a === 'break') await this.breakageForm()
    return false
  }

  /** A count sheet for one store: every item, typed or found by scanning its label. */
  private async count() {
    const stores = (await this.h.stores()).filter((s) => s.active)
    this.h.modal.open('Count a store', `<div class="form-grid"><label class="span2">Store<select name="store">${stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label></div>`, 'Start counting', async (f) => {
      const storeId = val(f, 'store')
      const rows = (await this.h.api.get<{ items: Row[] }>(`/api/stock?storeId=${storeId}`)).items
      this.h.modal.open(`Count: ${stores.find((s) => s.id === storeId)?.name}`, `<div class="ws-toolbar"><input data-find type="search" placeholder="Find item or barcode" aria-label="Find item"><button type="button" class="btn" data-scan>Scan</button></div><div data-cam></div>
        <p class="muted small">Count what is on the shelf in the unit shown; leave blank what you did not count. Differences above your limit go to the GM before the book changes.</p>
        <div class="count-grid">${rows.map((r) => `<label data-row="${esc(r.item.toLowerCase())}|${esc(r.barcode ?? '')}|${esc(r.itemId)}"><span>${esc(r.item)} <small class="muted">${esc(r.purchaseUnit)}</small></span><input name="c_${esc(r.itemId)}" type="number" min="0" step="any" aria-label="Counted"></label>`).join('')}</div>
        <div class="form-grid"><label class="span2">Note<input name="note" maxlength="200"></label></div>`, 'Submit count', async (f2) => {
        const lines = rows.filter((r) => val(f2, `c_${r.itemId}`) !== '').map((r) => ({ itemId: r.itemId, counted: Number(val(f2, `c_${r.itemId}`)) * r.factor }))
        if (!lines.length) throw new Error('Enter at least one count.')
        const r = await this.h.api.post<{ number: string; status: string; varianceValuePaise: number }>('/api/stock/counts', { storeId, note: val(f2, 'note') || undefined, lines })
        await this.load(); this.h.render()
        return r.status === 'applied' ? `${r.number}: book corrected (${rupees(r.varianceValuePaise)})` : `${r.number}: variance ${rupees(r.varianceValuePaise)} sent to the GM`
      })
      const el = this.h.modal.el
      const find = (code: string) => {
        const c = code.trim().toLowerCase()
        el.querySelectorAll<HTMLElement>('[data-row]').forEach((x) => { const [name, bar, id] = x.dataset.row!.split('|'); x.hidden = !!c && !name.includes(c) && bar !== code.trim() && id !== code.trim() })
        el.querySelector<HTMLInputElement>('[data-row]:not([hidden]) input')?.focus()
      }
      el.querySelector('[data-find]')!.addEventListener('input', (e) => find((e.target as HTMLInputElement).value))
      el.querySelector('[data-scan]')!.addEventListener('click', async () => {
        const code = await scanQr(el.querySelector<HTMLElement>('[data-cam]')!, BARCODES)
        if (code) { el.querySelector<HTMLInputElement>('[data-find]')!.value = code; find(code) } else toast('Could not read a code: type it or search by name.')
      })
    })
  }

  private async breakageForm() {
    const stores = (await this.h.stores()).filter((s) => s.active && s.ledger === 'own')
    const items = (await this.h.items()).filter((i) => ['crockery', 'housekeeping', 'other', 'engineering'].includes(i.category))
    const guests = await this.h.api.get<{ id: string; name: string; room_no: string | null; status: string }[]>('/api/stock/in-house').catch(() => [])
    this.h.modal.open('Record breakage', `<div class="form-grid">
        <label>From store<select name="store">${stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
        <label>In<select name="dept">${DEPARTMENTS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="span2">Item<select name="item">${items.map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.unit)})</option>`).join('')}</select></label>
        <label>How many<input name="qty" type="number" min="1" step="1" value="1"></label>
        <label>Who bears it<select name="to" data-to><option value="house">The house</option><option value="guest">The guest (on their bill)</option><option value="staff">A member of staff</option></select></label>
        <label class="span2" data-for="guest">Guest<select name="res">${guests.filter((g) => g.status === 'in_house').map((g) => `<option value="${esc(g.id)}">${esc(g.name)}${g.room_no ? ` · room ${esc(g.room_no)}` : ''}</option>`).join('')}</select></label>
        <label data-for="guest">Charge (₹, before GST)<input name="charge" type="number" min="0" step="1"></label>
        <label class="span2" data-for="staff">Staff name<input name="staff" maxlength="60"></label>
        <label class="span2">Note<input name="note" maxlength="200" placeholder="e.g. dropped while clearing table 4"></label></div>`, 'Record', async (f) => {
      const r = await this.h.api.post<{ valuePaise: number; chargedPaise: number }>('/api/stock/breakage', {
        storeId: val(f, 'store'), department: val(f, 'dept'), itemId: val(f, 'item'), qty: Number(val(f, 'qty')), chargeTo: val(f, 'to'), reservationId: val(f, 'res') || undefined,
        charge: val(f, 'charge') ? Number(val(f, 'charge')) : undefined, staffName: val(f, 'staff') || undefined, note: val(f, 'note') || undefined,
      })
      await this.load(); this.h.render()
      return r.chargedPaise ? `Recorded; ${rupees(r.chargedPaise)} added to the guest's bill` : `Recorded (${rupees(r.valuePaise)} at cost)`
    })
    const sync = () => { const v = this.h.modal.el.querySelector<HTMLSelectElement>('[data-to]')!.value; this.h.modal.el.querySelectorAll<HTMLElement>('[data-for]').forEach((x) => { x.hidden = x.dataset.for !== v }) }
    this.h.modal.el.querySelector('[data-to]')!.addEventListener('change', sync); sync()
  }
}
