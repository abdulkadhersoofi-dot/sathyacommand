import { esc, toast, tonePill } from '../ui/dom'
import { val } from '../ui/form-modal'
import { chips, dietDot, minutesAgo, rs, type Category, type MenuItem, type Table, type Ticket, type Ws } from './common'
import { printTickets } from './print'

// The captain's tablet: tables of an outlet, then the order screen. Items go into a cart on the tablet
// and reach the kitchen only on "Send", one ticket per station.

interface OrderLine { id: string; item_id: string; name: string; price_paise: number; qty: number; liquor_class: string | null; note: string | null; status: 'pending' | 'sent' | 'void'; kot_id: string | null; kot_number: number | null; kot_kind: string | null; kot_status: string | null; void_reason: string | null }
interface OrderKot { id: string; number: number; kind: string; station_id: string; status: string; prints: number; created_at: string }
export interface OrderView {
  id: string; number: number; outlet_id: string; outlet: string; kind: string; table_id: string | null; table_label: string | null; room_no: string | null; guest: string | null
  covers: number; status: string; opened_at: string; items: OrderLine[]; kots: OrderKot[]
  totals: { food: number; gstRate: number; cgst: number; sgst: number; liquorBeforeVat: number; vat: number; vatMissing: string[]; payable: number }
}
interface RoomOrder { id: string; number: number; room_no: string | null; guest: string | null; opened_at: string; kitchen: string | null; subtotal_paise: number; pending_items: number; kind: string; table_label: string | null }

const KITCHEN_STATE: Record<string, [string, string]> = { new: ['Sent', '--st-arriving'], cooking: ['Cooking', '--st-occupied'], ready: ['Ready', '--st-vacant'], served: ['Served', '--st-ooo'] }

export class CaptainView {
  outletId = ''
  private tables: Table[] = []
  private roomOrders: RoomOrder[] = []
  private order: OrderView | null = null
  private menu: { categories: Category[]; items: MenuItem[] } = { categories: [], items: [] }
  private menuFor = ''
  private cat = ''
  private search = ''
  private cart = new Map<string, { qty: number; note: string }>()
  private ageOk = new Set<string>()
  private lastTickets: Ticket[] = []

  constructor(private ws: Ws) {}

  private get outlet() { return this.ws.outlets.find((o) => o.id === this.outletId) }

  async load() {
    if (!this.ws.outlets.some((o) => o.id === this.outletId)) this.outletId = (this.ws.outlets.find((o) => o.kind === 'restaurant') ?? this.ws.outlets[0])?.id ?? ''
    if (!this.outletId) return
    if (this.order) {
      this.order = await this.ws.api.get<OrderView>(`/api/fnb/orders/${this.order.id}`)
      if (this.order.status !== 'open') { this.order = null; this.cart.clear() }
    }
    const outletId = this.order?.outlet_id ?? this.outletId
    if (this.menuFor !== outletId) {
      this.menu = await this.ws.api.get(`/api/fnb/menu?outletId=${outletId}`)
      this.menuFor = outletId
      this.cat = ''
    } else if (this.order) {
      this.menu = await this.ws.api.get(`/api/fnb/menu?outletId=${outletId}`)
    }
    if (!this.order) {
      this.tables = await this.ws.api.get(`/api/fnb/tables?outletId=${this.outletId}`)
      this.roomOrders = await this.ws.api.get(`/api/fnb/orders?outletId=${this.outletId}`)
    }
  }

  /** Opens a specific order (e.g. from the kitchen panel). */
  async openOrder(id: string) {
    this.order = await this.ws.api.get<OrderView>(`/api/fnb/orders/${id}`)
    this.outletId = this.order.outlet_id
    this.cart.clear()
  }

  get dirty() { return this.cart.size > 0 }

  html(): string {
    if (!this.outletId) return '<div class="empty">No outlets yet. Add one under Menu.</div>'
    return this.order ? this.orderHtml(this.order) : this.tablesHtml()
  }

  // ---------- tables ----------
  private tablesHtml() {
    const o = this.outlet!
    const head = chips(this.ws.outlets.filter((x) => x.active).map((x) => [x.id, x.name]), this.outletId, 'outlet')
    if (o.kind === 'room_service') {
      return head + `<div class="ws-toolbar"><button class="btn primary" type="button" data-cap="new-room">New room-service order</button></div>
        <div class="sec-title">Open room-service orders <span>${this.roomOrders.length}</span></div>
        ${this.roomOrders.length ? this.roomOrders.map((r) => `<button type="button" class="row-card ws-row" data-order="${esc(r.id)}">
          <div class="rc-title">Room ${esc(r.room_no ?? '?')} · ${esc(r.guest ?? '')}</div>
          <div class="rc-sub">Order ${r.number} · ${minutesAgo(r.opened_at)} min · ${rs(Number(r.subtotal_paise))}${r.pending_items ? ` · ${r.pending_items} not sent` : ''}</div>
          <div class="rc-right">${r.kitchen ? tonePill(...KITCHEN_STATE[r.kitchen]) : tonePill('Delivered', '--st-ooo')}</div></button>`).join('') : '<div class="empty">No open room-service orders.</div>'}`
    }
    const sections = [...new Set(this.tables.map((t) => t.section ?? ''))]
    const takeaway = this.roomOrders.filter((r) => r.kind === 'takeaway')
    return head + sections.map((sec) => `<div class="sec-title">${esc(sec || 'Tables')}</div><div class="tables">${this.tables.filter((t) => (t.section ?? '') === sec).map((t) => {
      const state = !t.order_id ? 'free' : t.ready_tickets ? 'ready' : 'open'
      return `<button type="button" class="tbl" data-table="${esc(t.id)}" data-state="${state}">
        <b>${esc(t.label)}</b>
        <span>${t.order_id ? `Order ${t.order_number} · ${t.covers} pax · ${minutesAgo(t.opened_at!)} min` : `${t.seats} seats`}</span>
        ${t.ready_tickets ? '<em>Food ready</em>' : ''}</button>`
    }).join('')}</div>`).join('')
      + `<div class="ws-toolbar"><button class="btn" type="button" data-cap="takeaway">Takeaway order</button></div>`
      + (takeaway.length ? `<div class="sec-title">Takeaway</div>` + takeaway.map((r) => `<button type="button" class="row-card ws-row" data-order="${esc(r.id)}"><div class="rc-title">Order ${r.number}</div><div class="rc-sub">${minutesAgo(r.opened_at)} min · ${rs(Number(r.subtotal_paise))}</div></button>`).join('') : '')
  }

  // ---------- order ----------
  private orderHtml(o: OrderView) {
    const where = o.table_label ? `Table ${o.table_label}` : o.room_no ? `Room ${o.room_no}${o.guest ? ` · ${o.guest}` : ''}` : 'Takeaway'
    return `<div class="ord">
      <div class="ord-menu">
        <div class="ord-top"><button type="button" class="btn small" data-cap="back">← ${esc(this.outlet?.kind === 'room_service' ? 'Orders' : 'Tables')}</button>
          <input class="ws-search" type="search" placeholder="Search dishes or code" value="${esc(this.search)}" aria-label="Search the menu"></div>
        <div class="ord-items">${this.itemsHtml()}</div>
      </div>
      <div class="ord-ticket">
        <div class="ord-head"><div><div class="dr-kicker">${esc(o.outlet)} · Order ${o.number}</div><div class="dr-title">${esc(where)}</div>
          <div class="muted small">${o.covers} cover${o.covers > 1 ? 's' : ''} · open ${minutesAgo(o.opened_at)} min</div></div></div>
        ${this.linesHtml(o)}
        ${this.totalsHtml(o)}
        <div class="actions">
          <button type="button" class="btn primary" data-cap="send" ${this.cart.size ? '' : 'disabled'}>Send to kitchen${this.cart.size ? ` (${[...this.cart.values()].reduce((a, c) => a + c.qty, 0)})` : ''}</button>
          ${this.lastTickets.length ? '<button type="button" class="btn" data-cap="print">Print tickets</button>' : ''}
          ${o.kind === 'dine_in' ? '<button type="button" class="btn" data-cap="move">Move table</button>' : ''}
          ${o.items.some((i) => i.status === 'sent') ? '' : '<button type="button" class="btn ghost" data-cap="cancel-order">Cancel order</button>'}
        </div>
      </div></div>`
  }

  private itemsHtml() {
    const q = this.search.toLowerCase()
    const items = this.menu.items.filter((i) => (!this.cat || i.category_id === this.cat) && (!q || i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q) || (i.name_ta ?? '').includes(this.search)))
    const cats: [string, string][] = [['', 'All'], ...this.menu.categories.filter((c) => this.menu.items.some((i) => i.category_id === c.id)).map((c): [string, string] => [c.id, c.name])]
    return chips(cats, this.cat, 'cat') + `<div class="menu-grid">${items.map((i) => {
      const inCart = this.cart.get(i.id)?.qty
      return `<button type="button" class="dish" data-item="${esc(i.id)}" ${i.available ? '' : 'disabled'}>
        <span class="dish-name">${dietDot(i.diet)}${esc(i.name)}</span>${i.name_ta ? `<span class="dish-ta">${esc(i.name_ta)}</span>` : ''}
        <span class="dish-foot"><span class="mono">${rs(i.price_paise)}</span>${!i.available ? '<em>Sold out</em>' : i.liquor_class ? '<em>Liquor</em>' : ''}${inCart ? `<b class="dish-qty">${inCart}</b>` : ''}</span></button>`
    }).join('') || '<div class="empty">No dishes match.</div>'}</div>`
  }

  private linesHtml(o: OrderView) {
    const sent = o.items.filter((i) => i.status !== 'pending')
    const pendingServer = o.items.filter((i) => i.status === 'pending')
    const byKot = new Map<string, OrderLine[]>()
    for (const i of sent) byKot.set(i.kot_id ?? '', [...(byKot.get(i.kot_id ?? '') ?? []), i])
    let h = ''
    for (const k of o.kots) {
      const lines = byKot.get(k.id) ?? []
      const [label, color] = KITCHEN_STATE[k.status]
      h += `<div class="ord-kot"><div class="ord-kot-head"><span class="mono">${k.kind} ${k.number} · ${esc(this.ws.stations.find((s) => s.id === k.station_id)?.name ?? k.station_id)}</span>${tonePill(label, color)}
        ${k.status === 'ready' ? `<button type="button" class="btn small primary" data-served="${esc(k.id)}">Served</button>` : ''}
        <button type="button" class="btn small ghost" data-reprint="${esc(k.id)}" title="Reprint (marked COPY)">Reprint</button></div>
        ${lines.map((l) => `<div class="ord-line${l.status === 'void' ? ' void' : ''}"><span>${l.qty} × ${esc(l.name)}${l.note ? ` <i>${esc(l.note)}</i>` : ''}${l.void_reason && l.status === 'void' ? ` <i>(${esc(l.void_reason)})</i>` : ''}</span>
          <span class="mono">${rs(l.price_paise * l.qty)}</span>${l.status === 'sent' ? `<button type="button" class="x" data-void="${esc(l.id)}" aria-label="Cancel ${esc(l.name)}">✕</button>` : '<span></span>'}</div>`).join('')}</div>`
    }
    for (const l of pendingServer) h += `<div class="ord-line pending"><span>${l.qty} × ${esc(l.name)} <i>not sent</i></span><span class="mono">${rs(l.price_paise * l.qty)}</span><button type="button" class="x" data-void="${esc(l.id)}" aria-label="Remove">✕</button></div>`
    if (this.cart.size) {
      h += `<div class="sec-title">To send</div>` + [...this.cart].map(([id, c]) => {
        const m = this.menu.items.find((i) => i.id === id)
        return `<div class="ord-line cart"><span>${esc(m?.name ?? id)}${c.note ? ` <i>${esc(c.note)}</i>` : ''}</span>
          <span class="qty"><button type="button" class="btn small" data-dec="${esc(id)}" aria-label="One less">−</button><b>${c.qty}</b><button type="button" class="btn small" data-inc="${esc(id)}" aria-label="One more">+</button></span>
          <button type="button" class="btn small ghost" data-note="${esc(id)}">Note</button></div>`
      }).join('')
    }
    return h || '<div class="empty">Tap dishes to add them.</div>'
  }

  private totalsHtml(o: OrderView) {
    const t = o.totals
    return `<dl class="kv ord-totals">
      <dt>Food & soft drinks</dt><dd>${rs(t.food)}</dd>
      ${t.food ? `<dt>GST ${t.gstRate}%</dt><dd>${rs(t.cgst + t.sgst)}</dd>` : ''}
      ${t.liquorBeforeVat ? `<dt>Liquor</dt><dd>${rs(t.liquorBeforeVat)}</dd><dt>TN VAT</dt><dd>${rs(t.vat)}${t.vatMissing.length ? ' <span class="fd-warn">+ rate not set</span>' : ''}</dd>` : ''}
      <dt><b>Total so far</b></dt><dd><b>${rs(t.payable)}</b></dd>
      ${this.cart.size ? `<dt>Not sent yet (before tax)</dt><dd>${rs([...this.cart].reduce((a, [id, c]) => a + (this.menu.items.find((m) => m.id === id)?.price_paise ?? 0) * c.qty, 0))}</dd>` : ''}</dl>
      ${t.vatMissing.length ? `<p class="muted small">No VAT rate yet for ${t.vatMissing.map(esc).join(', ')}. Accounts set it under Licences &amp; tax.</p>` : ''}`
  }

  // ---------- actions ----------
  /** Returns true when the click was handled. */
  async click(t: HTMLElement): Promise<boolean> {
    const d = (k: string) => t.closest<HTMLElement>(`[data-${k}]`)?.dataset[k.replace(/-(.)/g, (_, c) => c.toUpperCase())]
    const api = this.ws.api
    const outlet = d('outlet'); if (outlet !== undefined) { this.outletId = outlet; this.order = null; await this.load(); return true }
    const cat = d('cat'); if (cat !== undefined) { this.cat = cat; this.refreshItems(); return true }
    const table = d('table')
    if (table) {
      const tb = this.tables.find((x) => x.id === table)!
      if (tb.order_id) { await this.openOrder(tb.order_id); await this.load(); return true }
      this.ws.modal.open(`Table ${tb.label}`, `<div class="form-grid"><label>Guests (covers)<input name="covers" type="number" min="1" max="200" value="${Math.min(2, tb.seats)}"></label></div>`, 'Open order', async (f) => {
        const o = await api.post<OrderView>('/api/fnb/orders', { outletId: this.outletId, tableId: tb.id, covers: Number(val(f, 'covers')) })
        this.order = o; this.cart.clear(); await this.load(); this.ws.render(); return ''
      })
      return true
    }
    const order = d('order'); if (order) { await this.openOrder(order); await this.load(); return true }
    const item = d('item')
    if (item) {
      const m = this.menu.items.find((i) => i.id === item)!
      const add = () => { const c = this.cart.get(item) ?? { qty: 0, note: '' }; c.qty++; this.cart.set(item, c); this.ws.render() }
      if (m.liquor_class && !this.ageOk.has(this.order!.id)) {
        this.ws.modal.open('Before serving liquor', `<p>Confirm the guest is <b>21 or older</b> (the legal age in Tamil Nadu) and is not visibly intoxicated.</p>`, 'Confirmed', async () => { this.ageOk.add(this.order!.id); add(); return '' })
      } else add()
      return true
    }
    const inc = d('inc'); if (inc) { this.cart.get(inc)!.qty++; return true }
    const dec = d('dec'); if (dec) { const c = this.cart.get(dec)!; if (--c.qty <= 0) this.cart.delete(dec); return true }
    const note = d('note')
    if (note) {
      const c = this.cart.get(note)!
      this.ws.modal.open('Instructions for the kitchen', `<div class="form-grid"><label class="span2">Note<input name="note" maxlength="120" value="${esc(c.note)}" placeholder="e.g. less spicy, no onion"></label></div>`, 'Save', async (f) => { c.note = val(f, 'note'); this.ws.render(); return '' })
      return true
    }
    const voidId = d('void')
    if (voidId) {
      const line = this.order!.items.find((i) => i.id === voidId)!
      if (line.status === 'pending') { await api.post(`/api/fnb/order-items/${voidId}/void`, {}); await this.load(); return true }
      this.ws.modal.open(`Cancel ${line.qty} × ${line.name}`, `<p class="muted">The kitchen already has this. A manager must approve, and the MD sees it in God Mode.</p>
        <div class="form-grid"><label class="span2">Reason<input name="reason" required maxlength="120" placeholder="e.g. guest changed mind, wrong item"></label></div>`, 'Cancel item', async (f) => {
        const r = await api.post<{ pending?: boolean }>(`/api/fnb/order-items/${voidId}/void`, { reason: val(f, 'reason') })
        await this.load(); this.ws.render()
        return r.pending ? 'Sent to the F&B manager for approval' : 'Item cancelled'
      })
      return true
    }
    const served = d('served'); if (served) { await api.post(`/api/fnb/kots/${served}/status`, { status: 'served' }); await this.load(); return true }
    const reprint = d('reprint')
    if (reprint) {
      const tk = await api.post<Ticket>(`/api/fnb/kots/${reprint}/reprint`)
      printTickets([tk], (id) => this.ws.stations.find((s) => s.id === id)?.name ?? id)
      return true
    }
    const act = d('cap')
    if (!act) return false
    if (act === 'back') {
      if (this.cart.size && !confirm('Leave without sending the new items?')) return true
      this.order = null; this.cart.clear(); this.lastTickets = []; await this.load()
    }
    if (act === 'send') {
      const o = this.order!
      const items = [...this.cart].map(([itemId, c]) => ({ itemId, qty: c.qty, note: c.note || undefined }))
      await api.post(`/api/fnb/orders/${o.id}/items`, { items })
      this.cart.clear()
      const r = await api.post<{ tickets: Ticket[] }>(`/api/fnb/orders/${o.id}/send`)
      this.lastTickets = r.tickets
      toast(`Sent: ${r.tickets.map((x) => `${x.kind} ${x.number} → ${this.ws.stations.find((s) => s.id === x.station_id)?.name ?? x.station_id}`).join(', ')}`)
      await this.load()
    }
    if (act === 'print') printTickets(this.lastTickets, (id) => this.ws.stations.find((s) => s.id === id)?.name ?? id)
    if (act === 'move') {
      const free = (await api.get<Table[]>(`/api/fnb/tables?outletId=${this.order!.outlet_id}`)).filter((x) => !x.order_id)
      this.ws.modal.open('Move to table', `<div class="form-grid"><label class="span2">Table<select name="table">${free.map((x) => `<option value="${esc(x.id)}">${esc(x.label)} · ${x.seats} seats</option>`).join('')}</select></label></div>`, 'Move', async (f) => {
        this.order = await api.post<OrderView>(`/api/fnb/orders/${this.order!.id}/move`, { tableId: val(f, 'table') })
        this.ws.render(); return 'Moved'
      })
    }
    if (act === 'cancel-order') {
      this.ws.modal.open(`Cancel order ${this.order!.number}`, `<div class="form-grid"><label class="span2">Reason<input name="reason" maxlength="120"></label></div>`, 'Cancel order', async (f) => {
        await api.post(`/api/fnb/orders/${this.order!.id}/cancel`, { reason: val(f, 'reason') })
        this.order = null; this.cart.clear(); await this.load(); this.ws.render(); return 'Order cancelled'
      })
    }
    if (act === 'takeaway') { this.order = await api.post<OrderView>('/api/fnb/orders', { outletId: this.outletId, kind: 'takeaway' }); this.cart.clear(); await this.load() }
    if (act === 'new-room') {
      const guests = this.ws.inHouse().filter((g) => g.roomNo)
      this.ws.modal.open('Room-service order', guests.length ? `<div class="form-grid"><label class="span2">Room<select name="res">${guests.map((g) => `<option value="${esc(g.id)}">Room ${esc(g.roomNo!)} · ${esc(g.guest)}</option>`).join('')}</select></label></div>` : '<p>No guests are checked in.</p>',
        guests.length ? 'Open order' : 'Done', async (f) => {
          if (!guests.length) return ''
          this.order = await api.post<OrderView>('/api/fnb/orders', { outletId: this.outletId, reservationId: val(f, 'res') })
          this.cart.clear(); await this.load(); this.ws.render(); return ''
        })
    }
    return true
  }

  onInput(t: HTMLElement) {
    if (!t.classList.contains('ws-search')) return
    this.search = (t as HTMLInputElement).value
    this.refreshItems()
  }

  private refreshItems() {
    const box = document.querySelector('.ws .ord-items')
    if (box) box.innerHTML = this.itemsHtml()
  }
}
