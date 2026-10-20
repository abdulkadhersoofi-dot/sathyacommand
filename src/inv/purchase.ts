import { esc, toast, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import type { WorkspaceHost } from '../ui/workspace'
import { rupees, type Item, type Store } from './items'
import { receivePo } from './payables'

// Indents (departments ask), purchase orders (stores order, approved within limits, printed and sent)
// and the market list (perishables below their level, ordered at the best rate in one step).

type Host = WorkspaceHost & { stores(): Promise<Store[]>; items(): Promise<Item[]> }

interface IndentLine { line: number; item_id: string; item: string; unit: string; purchase_unit: string; purchaseQty: number; note: string | null; po_number: string | null }
interface Indent { id: string; number: string; store: string; needed_by: string | null; note: string | null; status: string; requested_by: string; requester_id: string; requested_at: string
  decided_by: string | null; decision_note: string | null; lines: IndentLine[]; estimatePaise: number }

const IND_STATE: Record<string, [string, string]> = { submitted: ['Waiting for approval', '--marigold'], approved: ['Approved', '--st-vacant'], rejected: ['Turned down', '--st-departing'], ordered: ['Ordered', '--st-occupied'], cancelled: ['Cancelled', '--muted'] }
const PO_STATE: Record<string, [string, string]> = {
  draft: ['Draft', '--muted'], pending_approval: ['Waiting for approval', '--marigold'], approved: ['Approved', '--st-vacant'], sent: ['Sent', '--st-occupied'],
  partly_received: ['Part received', '--st-arriving'], received: ['Received', '--st-vacant'], cancelled: ['Cancelled', '--muted'], closed: ['Closed', '--muted'],
}
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const qty = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** A list of item lines with a quantity in purchase units, for indents and purchase orders. */
function lineEditor(items: Item[], rows = 6, withRate = false) {
  const opts = `<option value="">—</option>${items.filter((i) => i.active).map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.purchase_unit)})</option>`).join('')}`
  return `<div class="line-editor">${Array.from({ length: rows }, (_, n) => `<div class="le-row"><select name="i_${n}" aria-label="Item ${n + 1}">${opts}</select>
    <input name="q_${n}" type="number" min="0" step="any" placeholder="Qty" aria-label="Quantity ${n + 1}">${withRate ? `<input name="r_${n}" type="number" min="0" step="0.01" placeholder="Rate ₹ (blank: agreed rate)" aria-label="Rate ${n + 1}">` : ''}</div>`).join('')}</div>`
}
function readLines(f: HTMLFormElement, rows: number, withRate = false) {
  const out: { itemId: string; qty: number; rate?: number }[] = []
  for (let n = 0; n < rows; n++) {
    const itemId = val(f, `i_${n}`), q = Number(val(f, `q_${n}`))
    if (!itemId) continue
    if (!(q > 0)) throw new Error('Enter a quantity for each item chosen.')
    out.push({ itemId, qty: q, ...(withRate && val(f, `r_${n}`) !== '' ? { rate: Number(val(f, `r_${n}`)) } : {}) })
  }
  if (!out.length) throw new Error('Choose at least one item.')
  return out
}

export class IndentsView {
  private list: Indent[] = []
  private status = 'open'
  private picked = new Set<string>()
  constructor(private h: Host) {}

  async load() { this.list = await this.h.cached(`/api/indents?status=${this.status}`) }

  html() {
    const chip = (s: string, l: string) => `<button type="button" class="chip" data-is="${s}" aria-pressed="${this.status === s}">${l}</button>`
    const canOrder = this.h.can('purchase.order')
    const approved = this.list.filter((i) => i.status === 'approved')
    return `<div class="ws-toolbar">${this.h.can('purchase.indent') ? '<button type="button" class="btn primary" data-in="new">New indent</button>' : ''}
        ${canOrder && approved.length ? `<button type="button" class="btn" data-in="order" ${this.picked.size ? '' : 'disabled'}>Order ${this.picked.size || ''} ticked</button>` : ''}
        <div class="chips">${chip('open', 'Open')}${chip('ordered', 'Ordered')}${chip('all', 'All')}</div></div>
      ${this.list.map((i) => `<div class="row-card ind-card">
        <div class="rc-title">${canOrder && i.status === 'approved' ? `<input type="checkbox" data-pick="${esc(i.id)}" ${this.picked.has(i.id) ? 'checked' : ''} aria-label="Order ${esc(i.number)}"> ` : ''}${esc(i.number)} · ${esc(i.store)}</div>
        <div class="rc-sub">${i.lines.map((l) => `${esc(l.item)} ${qty(l.purchaseQty)} ${esc(l.purchase_unit)}${l.po_number ? ` <small>(${esc(l.po_number)})</small>` : ''}`).join(' · ')}</div>
        <div class="rc-sub">${esc(i.requested_by)}, ${when(i.requested_at)}${i.needed_by ? ` · needed by ${esc(i.needed_by)}` : ''}${i.estimatePaise ? ` · about ${rupees(i.estimatePaise)}` : ''}${i.note ? ` · ${esc(i.note)}` : ''}${i.decision_note ? ` · ${esc(i.decided_by ?? '')}: ${esc(i.decision_note)}` : ''}</div>
        <div class="rc-right">${tonePill(...(IND_STATE[i.status] ?? [i.status, '--muted']))}
          ${i.status === 'submitted' && this.h.can('indent.approve') && i.requester_id !== this.h.me.id ? `<button type="button" class="btn small primary" data-in="approve:${esc(i.id)}">Approve</button><button type="button" class="btn small" data-in="reject:${esc(i.id)}">Turn down…</button>` : ''}
          ${['submitted', 'approved'].includes(i.status) && (i.requester_id === this.h.me.id || canOrder) ? `<button type="button" class="btn small" data-in="cancel:${esc(i.id)}">Cancel</button>` : ''}</div></div>`).join('') || '<div class="empty">No indents.</div>'}`
  }

  async change(el: HTMLElement): Promise<boolean> {
    const id = el.dataset.pick
    if (!id) return false
    if ((el as HTMLInputElement).checked) this.picked.add(id); else this.picked.delete(id)
    return true
  }

  async click(el: HTMLElement): Promise<boolean> {
    const s = el.closest<HTMLElement>('[data-is]')?.dataset.is
    if (s) { this.status = s; this.picked.clear(); await this.load(); return true }
    const a = el.closest<HTMLElement>('[data-in]')?.dataset.in
    if (!a) return false
    const api = this.h.api, done = async (m: string) => { await this.load(); this.h.render(); return m }
    if (a === 'new') {
      const [items, stores] = await Promise.all([this.h.items(), this.h.stores()])
      this.h.modal.open('New indent', `<div class="form-grid"><label>For<select name="store">${stores.filter((x) => x.active).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label>
        <label>Needed by<input name="needed" type="date"></label></div>${lineEditor(items)}
        <div class="form-grid"><label class="span2">Note<input name="note" maxlength="200" placeholder="e.g. for the Saturday wedding"></label></div>`, 'Send for approval', async (f) => {
        const r = await api.post<{ number: string }>('/api/indents', { storeId: val(f, 'store'), neededBy: val(f, 'needed') || undefined, note: val(f, 'note') || undefined, lines: readLines(f, 6) })
        return done(`${r.number} sent for approval`)
      })
      return false
    }
    if (a === 'order') {
      const r = await api.post<{ pos: { number: string }[] }>('/api/indents/order', { indentIds: [...this.picked] })
      this.picked.clear(); toast(`Draft ${r.pos.map((p) => p.number).join(', ')} raised: check and submit under Purchase orders.`)
      await this.load(); return true
    }
    const [act, id] = a.split(':')
    if (act === 'approve') { await api.post(`/api/indents/${id}/approve`); await this.load(); toast('Approved'); return true }
    if (act === 'cancel') { await api.post(`/api/indents/${id}/cancel`); await this.load(); toast('Cancelled'); return true }
    if (act === 'reject') {
      this.h.modal.open('Turn down indent', '<div class="form-grid"><label class="span2">Why<input name="note" maxlength="200"></label></div>', 'Turn down', async (f) => {
        await api.post(`/api/indents/${id}/reject`, { note: val(f, 'note') }); return done('Turned down')
      })
    }
    return false
  }
}

interface Po { id: string; number: string; vendor: string; vendor_id: string; store: string; store_id: string; status: string; order_date: string; expected_date: string | null
  subtotal_paise: string; gst_paise: string; total_paise: string; market_list: boolean; created_by: string; approved_by: string | null; lines: number }
interface PoLine { line: number; item_id: string; item: string; purchase_unit: string; hsn: string | null; qty: string; rate_paise: string; gst_rate: string; amount_paise: string; gst_paise: string; received_qty: string }

export class PosView {
  private list: Po[] = []
  private status = 'open'
  constructor(private h: Host) {}

  async load() { this.list = await this.h.cached(`/api/pos?status=${this.status}`) }

  html() {
    const chip = (s: string, l: string) => `<button type="button" class="chip" data-ps="${s}" aria-pressed="${this.status === s}">${l}</button>`
    return `<div class="ws-toolbar">${this.h.can('purchase.order') ? '<button type="button" class="btn primary" data-po="new">New purchase order</button>' : ''}
        <div class="chips">${chip('open', 'Open')}${chip('received', 'Received')}${chip('cancelled', 'Cancelled')}${chip('all', 'All')}</div></div>
      ${this.list.map((p) => `<div class="row-card" data-ticket="${esc(p.id)}"><div class="rc-title">${esc(p.number)} · ${esc(p.vendor)}${p.market_list ? ' · market list' : ''}</div>
        <div class="rc-sub">${p.lines} item${p.lines === 1 ? '' : 's'} for ${esc(p.store)} · ${esc(p.order_date)}${p.expected_date ? ` · due ${esc(p.expected_date)}` : ''} · by ${esc(p.created_by)}${p.approved_by ? ` · approved by ${esc(p.approved_by)}` : ''}</div>
        <div class="rc-right"><b class="mono">${rupees(Number(p.total_paise))}</b>${tonePill(...(PO_STATE[p.status] ?? [p.status, '--muted']))}</div></div>`).join('') || '<div class="empty">No purchase orders.</div>'}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const s = el.closest<HTMLElement>('[data-ps]')?.dataset.ps
    if (s) { this.status = s; await this.load(); return true }
    if (el.closest('[data-po=new]')) { await this.create(); return false }
    const id = el.closest<HTMLElement>('[data-ticket]')?.dataset.ticket
    if (id) await this.open(id)
    return false
  }

  private async create() {
    const [items, stores, vendors] = await Promise.all([this.h.items(), this.h.stores(), this.h.api.get<{ id: string; name: string; active: boolean }[]>('/api/vendors')])
    this.h.modal.open('New purchase order', `<div class="form-grid"><label class="span2">Vendor<select name="vendor">${vendors.filter((v) => v.active).map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label>
      <label>Deliver to<select name="store">${stores.filter((x) => x.active).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label>
      <label>Deliver by<input name="expected" type="date"></label></div>${lineEditor(items, 6, true)}
      <div class="form-grid"><label class="span2">Terms<input name="terms" maxlength="200" placeholder="e.g. delivery at the back gate before 10 am; payment 30 days"></label></div>`, 'Save draft', async (f) => {
      const r = await this.h.api.post<{ number: string }>('/api/pos', { vendorId: val(f, 'vendor'), storeId: val(f, 'store'), expectedDate: val(f, 'expected') || undefined, terms: val(f, 'terms') || undefined, lines: readLines(f, 6, true) })
      await this.load(); this.h.render(); return `${r.number} saved as a draft`
    })
  }

  async open(id: string) {
    const po = await this.h.api.get<Po & { lines: PoLine[]; igst: boolean; terms: string | null; vendor_gstin: string | null }>(`/api/pos/${id}`)
    const order = this.h.can('purchase.order')
    const btn = (a: string, l: string, primary = false) => `<button type="button" class="btn${primary ? ' primary' : ''}" data-pa="${a}">${l}</button>`
    const acts = [btn('print', 'Print / PDF')]
    if (order && po.status === 'draft') acts.push(btn('submit', 'Submit', true))
    if (order && po.status === 'approved') acts.push(btn('send', 'Mark sent to vendor', true))
    if (this.h.can('stores.receive') && ['approved', 'sent', 'partly_received'].includes(po.status)) acts.push(btn('receive', 'Receive goods…', po.status !== 'approved'))
    if ((order || this.h.can('purchase.approve')) && ['draft', 'pending_approval', 'approved', 'sent'].includes(po.status)) acts.push(btn('cancel', 'Cancel…'))
    const gst = Number(po.gst_paise)
    this.h.modal.open(`${po.number} · ${po.vendor}`, `<div class="room-head">${tonePill(...(PO_STATE[po.status] ?? [po.status, '--muted']))}${po.igst ? tonePill('IGST', '--muted') : ''}</div>
      <div class="m-table"><div class="m-row po-row head"><span>Item</span><span>Qty</span><span>Rate</span><span>GST</span><span>Amount</span></div>
      ${po.lines.map((l) => `<div class="m-row po-row"><b>${esc(l.item)}${l.hsn ? `<small class="muted"> HSN ${esc(l.hsn)}</small>` : ''}</b><span>${qty(Number(l.qty))} ${esc(l.purchase_unit)}${Number(l.received_qty) ? ` <small class="muted">(${qty(Number(l.received_qty))} in)</small>` : ''}</span>
        <span class="mono">${rupees(Number(l.rate_paise))}</span><span class="mono">${Number(l.gst_rate)}%</span><span class="mono">${rupees(Number(l.amount_paise))}</span></div>`).join('')}</div>
      <dl class="kv"><dt>Taxable</dt><dd>${rupees(Number(po.subtotal_paise))}</dd>${po.igst ? `<dt>IGST</dt><dd>${rupees(gst)}</dd>` : `<dt>CGST + SGST</dt><dd>${rupees(Math.floor(gst / 2))} + ${rupees(gst - Math.floor(gst / 2))}</dd>`}
        <dt>Total</dt><dd><b>${rupees(Number(po.total_paise))}</b></dd>${po.terms ? `<dt>Terms</dt><dd>${esc(po.terms)}</dd>` : ''}</dl>
      <div class="actions room-actions">${acts.join('')}</div>`, 'Done', async () => '')
    this.h.modal.el.querySelector('.room-actions')!.addEventListener('click', async (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-pa]')?.dataset.pa
      if (!a) return
      try {
        if (a === 'print') { await this.h.api.openDocument(`/api/pos/${id}/print`); return }
        if (a === 'receive') { await receivePo(this.h, id, async () => { await this.load(); this.h.render() }); return }
        if (a === 'cancel') {
          this.h.modal.open(`Cancel ${po.number}`, '<div class="form-grid"><label class="span2">Why<input name="reason" maxlength="200"></label></div>', 'Cancel order', async (f) => {
            await this.h.api.post(`/api/pos/${id}/cancel`, { reason: val(f, 'reason') }); await this.load(); this.h.render(); return 'Cancelled'
          })
          return
        }
        const r = await this.h.api.post<{ status?: string }>(`/api/pos/${id}/${a}`)
        this.h.modal.close(); await this.load(); this.h.render()
        toast(a === 'submit' ? (r.status === 'approved' ? 'Approved (within your limit). Print it and send it.' : 'Above your limit: sent to the GM for approval.') : 'Marked sent')
      } catch (err) { toast((err as Error).message) }
    })
  }
}

interface Suggestion { itemId: string; item: string; unit: string; purchaseUnit: string; storeId: string; stock: number; par: number; onOrder: number; qty: number; vendor: string | null; ratePaise: number | null; amountPaise: number | null }

export class MarketView {
  private list: Suggestion[] = []
  private perishable = true
  constructor(private h: Host) {}

  async load() { this.list = await this.h.cached(`/api/purchase/suggestions?perishable=${this.perishable ? 1 : 0}`) }

  html() {
    const total = this.list.reduce((a, s) => a + (s.amountPaise ?? 0), 0)
    return `<form data-form="market"><div class="ws-toolbar"><div class="chips"><button type="button" class="chip" data-mk="1" aria-pressed="${this.perishable}">Today's market list (perishables)</button><button type="button" class="chip" data-mk="0" aria-pressed="${!this.perishable}">Everything below its level</button></div>
        ${this.list.length ? `<button class="btn primary">Raise draft POs</button><span class="muted small">about ${rupees(total)}</span>` : ''}</div>
      <div class="m-table"><div class="m-row mk-row head"><span></span><span>Item</span><span>In stock / level</span><span>Order</span><span>Best rate</span></div>
      ${this.list.map((s, n) => `<div class="m-row mk-row"><input type="checkbox" name="t_${n}" ${s.vendor ? 'checked' : 'disabled'} aria-label="Order ${esc(s.item)}"><b>${esc(s.item)}</b>
        <span class="mono">${qty(s.stock)} / ${qty(s.par)} ${esc(s.unit)}${s.onOrder ? ` <small class="muted">+${qty(s.onOrder)} on order</small>` : ''}</span>
        <span><input name="q_${n}" type="number" min="0" step="any" value="${s.qty}" aria-label="Quantity"> ${esc(s.purchaseUnit)}</span>
        <span>${s.vendor ? `${esc(s.vendor)} · ${rupees(s.ratePaise!)}` : '<span class="fd-warn">no rate</span>'}</span></div>`).join('') || '<div class="empty">Nothing is below its reorder level.</div>'}</div></form>
      <p class="muted small">Each line goes to the vendor with the best current rate; one draft PO per vendor. Set reorder levels on the items to use this.</p>`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const m = el.closest<HTMLElement>('[data-mk]')?.dataset.mk
    if (m === undefined) return false
    this.perishable = m === '1'; await this.load(); return true
  }

  async submit(f: HTMLFormElement): Promise<boolean> {
    const lines = this.list.map((s, n) => ({ s, n })).filter(({ n }) => checked(f, `t_${n}`)).map(({ s, n }) => ({ itemId: s.itemId, qty: Number(val(f, `q_${n}`)), storeId: s.storeId })).filter((l) => l.qty > 0)
    if (!lines.length) throw new Error('Tick what to order.')
    const r = await this.h.api.post<{ pos: { number: string }[] }>('/api/purchase/suggestions/order', { lines, marketList: this.perishable })
    toast(`Draft ${r.pos.map((p) => p.number).join(', ')} raised: submit them under Purchase orders.`)
    await this.load()
    return true
  }
}
