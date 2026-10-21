import { esc, toast, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { rs, type Ws } from './common'

// Bills for an order: split, discount, company details, then settle by cash, card, UPI, company credit
// or charge to the guest's room. Food goes on a GST invoice, liquor on a TN VAT invoice.

interface Amounts { foodGross: number; foodDiscount: number; service: number; foodTaxable: number; cgst: number; sgst: number; gstRate: number; liquorGross: number; liquorDiscount: number; liquorTaxable: number; vat: number; total: number; roundOff: number; payable: number; vatMissing: string[]; food: { description: string }[]; liquor: { description: string }[] }
export interface Bill { id: string; part: number; parts: number; status: string; discount_percent: string; discount_reason: string | null; service_percent: string; bill_to: { company: string; gstin?: string } | null; amounts: Amounts; prints: number; gst_number: string | null; vat_number: string | null; reservation_id: string | null; payments: { method: string; amount: number; reference: string | null }[] }
interface Line { id: string; name: string; qty: number; status: string; price_paise: number }
interface OrderRef { id: string; number: number; kind: string; status: string; items: Line[]; reservation_id?: string | null; room_no: string | null }

const METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', company: 'Company credit', room: 'Charge to room' }

export class Billing {
  bills: Bill[] = []
  private serviceCharge = 0
  private cashier: { open: boolean; expectedInDrawer?: number } = { open: false }

  constructor(private ws: Ws, private reload: () => Promise<void>) {}

  async load(orderId: string | null) {
    this.bills = orderId ? await this.ws.api.get<Bill[]>(`/api/fnb/orders/${orderId}/bills`) : []
    this.serviceCharge = (await this.ws.api.get<{ serviceChargePercent: number }>('/api/fnb/billing-settings')).serviceChargePercent
    if (this.ws.can('fnb.bill')) this.cashier = await this.ws.api.get('/api/cashier/current')
  }

  /** Cashier shift strip for the tables screen. */
  shiftHtml() {
    if (!this.ws.can('fnb.bill')) return ''
    return this.cashier.open
      ? `<button type="button" class="btn" data-bill="close-shift">Close cashier shift · ${rs(this.cashier.expectedInDrawer ?? 0)} in drawer</button>`
      : '<button type="button" class="btn" data-bill="open-shift">Open cashier shift</button>'
  }

  /** The bills panel shown on a billed order. */
  html(o: OrderRef) {
    const settledAny = this.bills.some((b) => b.status === 'settled')
    return this.bills.map((b) => {
      const a = b.amounts
      return `<div class="bill-card${b.status === 'settled' ? ' settled' : ''}">
        <div class="ord-kot-head"><span class="mono">${b.parts > 1 ? `Bill ${b.part} of ${b.parts}` : 'Bill'}${b.bill_to ? ` · ${esc(b.bill_to.company)}` : ''}</span>
          ${b.status === 'settled' ? tonePill('Paid', '--st-vacant') : tonePill('To pay', '--marigold')}</div>
        <dl class="kv">
          ${a.foodGross ? `<dt>Food &amp; soft drinks</dt><dd>${rs(a.foodGross)}</dd>` : ''}
          ${a.liquorGross ? `<dt>Liquor</dt><dd>${rs(a.liquorGross)}</dd>` : ''}
          ${a.foodDiscount + a.liquorDiscount ? `<dt>Discount ${Number(b.discount_percent)}%</dt><dd>−${rs(a.foodDiscount + a.liquorDiscount)}</dd>` : ''}
          ${a.service ? `<dt>Service charge ${Number(b.service_percent)}%</dt><dd>${rs(a.service)}</dd>` : ''}
          ${a.foodTaxable ? `<dt>GST ${a.gstRate}%</dt><dd>${rs(a.cgst + a.sgst)}</dd>` : ''}
          ${a.liquorGross ? `<dt>TN VAT</dt><dd>${rs(a.vat)}</dd>` : ''}
          ${a.roundOff ? `<dt>Round off</dt><dd>${rs(a.roundOff)}</dd>` : ''}
          <dt><b>${b.status === 'settled' ? 'Paid' : 'To pay'}</b></dt><dd><b>${rs(b.reservation_id ? a.total : a.payable)}</b></dd>
        </dl>
        ${a.vatMissing.length ? `<p class="fd-warn small">No VAT rate set for ${a.vatMissing.map(esc).join(', ')}. Set it under Licences &amp; tax, then bill again.</p>` : ''}
        ${b.status === 'settled' ? `<p class="muted small">${b.payments.map((p) => `${METHOD[p.method] ?? p.method} ${rs(p.amount)}`).join(' · ')}${b.gst_number ? ` · Tax invoice ${esc(b.gst_number)}` : ''}${b.vat_number ? ` · VAT invoice ${esc(b.vat_number)}` : ''}</p>` : ''}
        <div class="actions">
          ${b.status === 'open' && this.ws.can('fnb.bill') ? `<button type="button" class="btn primary small" data-settle="${esc(b.id)}">Take payment</button>` : ''}
          <button type="button" class="btn small" data-print-bill="${esc(b.id)}">${b.prints ? 'Reprint' : 'Print'}${b.status === 'settled' ? ' invoice' : ' bill'}</button>
          <button type="button" class="btn small ghost" data-printer-bill="${esc(b.id)}" title="Send to the outlet's bill printer">To printer</button>
        </div></div>`
    }).join('') + (o.status === 'billed' && !settledAny && this.ws.can('fnb.bill')
      ? '<div class="actions"><button type="button" class="btn small" data-bill="rebill">Change split or discount</button><button type="button" class="btn small ghost" data-bill="unbill">Cancel bill (add more items)</button></div>' : '')
  }

  /** Bill form: one bill, equal split, or item by item; discount; service charge; company details. */
  billForm(o: OrderRef) {
    const items = o.items.filter((i) => i.status !== 'void')
    this.ws.modal.open(`Bill order ${o.number}`, `<div class="form-grid">
      <label class="span2">Split<select name="split"><option value="1">One bill</option>${[2, 3, 4, 5, 6].map((n) => `<option value="${n}">Split equally in ${n}</option>`).join('')}<option value="items">Item by item…</option></select></label>
      <div class="span2" data-items hidden>${items.map((i) => `<label class="split-row"><span>${i.qty} × ${esc(i.name)} <span class="mono">${rs(i.price_paise * i.qty)}</span></span>
        <select name="g_${esc(i.id)}">${[1, 2, 3, 4].map((n) => `<option value="${n}">Bill ${n}</option>`).join('')}</select></label>`).join('')}</div>
      <label>Discount %<input name="discount" type="number" min="0" max="100" step="0.5" value="0"></label>
      <label>Reason<input name="reason" maxlength="120" placeholder="e.g. regular guest"></label>
      ${this.serviceCharge ? `<label class="check span2"><input type="checkbox" name="service" checked> Service charge ${this.serviceCharge}% (remove if the guest asks)</label>` : ''}
      <label class="check span2"><input type="checkbox" name="company"> Company bill (GST invoice in the company's name)</label>
      <div class="span2 form-grid" data-company hidden>
        <label class="span2">Company name<input name="cname" maxlength="100"></label>
        <label>GSTIN<input name="gstin" maxlength="15"></label><label>PIN code<input name="pin" maxlength="6" inputmode="numeric"></label>
        <label class="span2">Address<input name="address" maxlength="150"></label><label>City<input name="city" maxlength="60"></label>
      </div></div>
      <p class="muted small">Discounts above your limit go to a manager; the bill shows no discount until approved.</p>`, 'Make bill', async (f) => {
      const split = val(f, 'split')
      const body: Record<string, unknown> = {
        discountPercent: Number(val(f, 'discount') || 0), discountReason: val(f, 'reason') || undefined,
        serviceCharge: this.serviceCharge ? checked(f, 'service') : undefined,
      }
      if (split === 'items') {
        const groups = new Map<string, string[]>()
        for (const i of items) { const g = val(f, `g_${i.id}`); groups.set(g, [...(groups.get(g) ?? []), i.id]) }
        body.groups = [...groups.entries()].sort().map(([, ids]) => ids)
      } else body.parts = Number(split)
      if (checked(f, 'company')) body.billTo = { company: val(f, 'cname'), gstin: val(f, 'gstin').toUpperCase() || undefined, address: val(f, 'address') || undefined, city: val(f, 'city') || undefined, pin: val(f, 'pin') || undefined }
      const r = await this.ws.api.post<{ pending?: boolean; message?: string }>(`/api/fnb/orders/${o.id}/bill`, body)
      await this.reload()
      return r.pending ? r.message ?? 'Discount sent for approval' : 'Bill ready'
    })
    const el = this.ws.modal.el
    el.querySelector('select[name=split]')!.addEventListener('change', (e) => { el.querySelector<HTMLElement>('[data-items]')!.hidden = (e.target as HTMLSelectElement).value !== 'items' })
    el.querySelector('input[name=company]')!.addEventListener('change', (e) => { el.querySelector<HTMLElement>('[data-company]')!.hidden = !(e.target as HTMLInputElement).checked })
  }

  private settleForm(b: Bill, o: OrderRef) {
    const due = b.amounts.payable
    const guests = this.ws.inHouse().filter((g) => g.roomNo)
    const roomDefault = o.kind === 'room_service' ? o.reservation_id ?? '' : ''
    const row = (n: number) => `<div class="pay-row" data-row="${n}" ${n > 0 ? 'hidden' : ''}>
      <select name="m${n}">${Object.entries(METHOD).filter(([k]) => k !== 'room' && (k !== 'company' || b.bill_to)).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <input name="a${n}" type="number" min="0" step="0.01" value="${n === 0 ? (due / 100).toFixed(2) : ''}" aria-label="Amount ₹">
      <input name="r${n}" maxlength="60" placeholder="Card slip / UPI UTR" aria-label="Reference"></div>`
    this.ws.modal.open(`Payment · ${rs(due)}`, `
      ${guests.length ? `<label class="check"><input type="checkbox" name="toRoom" ${roomDefault ? 'checked' : ''}> Charge to a guest's room</label>
      <div class="form-grid" data-room ${roomDefault ? '' : 'hidden'}><label class="span2">Room<select name="res">${guests.map((g) => `<option value="${esc(g.id)}" ${g.id === roomDefault ? 'selected' : ''}>Room ${esc(g.roomNo!)} · ${esc(g.guest)}</option>`).join('')}</select></label>
        <p class="muted small span2">Food goes on the room bill (and the stay's tax invoice); liquor gets its VAT invoice now.</p></div>` : ''}
      <div data-pay ${roomDefault ? 'hidden' : ''}>${[0, 1, 2].map(row).join('')}
        <button type="button" class="btn small ghost" data-addpay>Split payment</button>
        <p class="fd-count">Entered: <b>${rs(due)}</b></p>
        <label class="cash-tender">Cash tendered ₹ (for change)<input name="tender" type="number" min="0" step="1"></label><p class="muted small" data-change></p></div>`, 'Settle', async (f) => {
      let body: Record<string, unknown>
      if (checked(f, 'toRoom')) body = { payments: [{ method: 'room', amount: due / 100 }], reservationId: val(f, 'res') }
      else {
        const payments = [0, 1, 2].map((n) => ({ method: val(f, `m${n}`), amount: Number(val(f, `a${n}`) || 0), reference: val(f, `r${n}`) || undefined })).filter((p) => p.amount > 0)
        body = { payments }
      }
      const r = await this.ws.api.post<{ gstInvoice: string | null; vatInvoice: string | null; orderClosed: boolean }>(`/api/fnb/bills/${b.id}/settle`, body)
      await this.reload()
      const toRoom = checked(f, 'toRoom')
      const room = toRoom ? guests.find((g) => g.id === val(f, 'res'))?.roomNo : null
      return `${toRoom ? `Charged to room ${room ?? ''}`.trim() : 'Paid'}${r.gstInvoice ? ` · Tax invoice ${r.gstInvoice}` : ''}${r.vatInvoice ? ` · VAT invoice ${r.vatInvoice}` : ''}${r.orderClosed ? (o.kind === 'room_service' ? ' · order closed' : ' · table free') : ''}`
    })
    const el = this.ws.modal.el, form = el.querySelector('form')!
    const sync = () => {
      const room = (form.elements.namedItem('toRoom') as HTMLInputElement | null)?.checked ?? false
      el.querySelector<HTMLElement>('[data-room]')?.toggleAttribute('hidden', !room)
      el.querySelector<HTMLElement>('[data-pay]')!.hidden = room
      const sum = [0, 1, 2].reduce((s, n) => s + Math.round(Number(val(form, `a${n}`) || 0) * 100), 0)
      el.querySelector('.fd-count b')!.textContent = rs(sum)
      const cash = [0, 1, 2].filter((n) => val(form, `m${n}`) === 'cash').reduce((s, n) => s + Math.round(Number(val(form, `a${n}`) || 0) * 100), 0)
      const tender = Math.round(Number(val(form, 'tender') || 0) * 100)
      el.querySelector<HTMLElement>('.cash-tender')!.hidden = !cash
      el.querySelector<HTMLElement>('[data-change]')!.textContent = cash && tender >= cash ? `Give back ${rs(tender - cash)}` : ''
      for (const n of [0, 1, 2]) el.querySelector<HTMLInputElement>(`input[name=r${n}]`)!.hidden = ['cash', 'company'].includes(val(form, `m${n}`))
    }
    form.addEventListener('input', sync)
    form.addEventListener('change', sync)
    el.querySelector('[data-addpay]')!.addEventListener('click', () => {
      const hidden = el.querySelector<HTMLElement>('.pay-row[hidden]')
      if (hidden) hidden.hidden = false
      sync()
    })
    sync()
  }

  async click(t: HTMLElement, o: OrderRef | null): Promise<boolean> {
    const api = this.ws.api
    const settle = t.closest<HTMLElement>('[data-settle]')?.dataset.settle
    if (settle && o) { this.settleForm(this.bills.find((b) => b.id === settle)!, o); return true }
    const print = t.closest<HTMLElement>('[data-print-bill]')?.dataset.printBill
    if (print) { await api.openDocument(`/api/fnb/bills/${print}/print`, 'POST'); await this.reload(); return true }
    const toPrinter = t.closest<HTMLElement>('[data-printer-bill]')?.dataset.printerBill
    if (toPrinter) { await api.post(`/api/fnb/bills/${toPrinter}/print-job`); toast('Sent to the bill printer'); await this.reload(); return true }
    const act = t.closest<HTMLElement>('[data-bill]')?.dataset.bill
    if (!act) return false
    if (act === 'bill' && o) this.billForm(o)
    if (act === 'rebill' && o) this.billForm(o)
    if (act === 'unbill' && o) { await api.post(`/api/fnb/orders/${o.id}/unbill`); toast('Bill cancelled. Add items, then bill again.'); await this.reload() }
    if (act === 'open-shift') {
      this.ws.modal.open('Open cashier shift', `<div class="form-grid"><label class="span2">Cash in the drawer now ₹<input name="float" type="number" min="0" value="0"></label></div>`, 'Open shift', async (f) => {
        await api.post('/api/cashier/open', { openingFloat: Number(val(f, 'float')) }); await this.reload(); return 'Shift opened'
      })
    }
    if (act === 'close-shift') {
      this.ws.modal.open('Close cashier shift', `<p class="muted">Expected in the drawer: <b>${rs(this.cashier.expectedInDrawer ?? 0)}</b>.</p><div class="form-grid"><label class="span2">Cash counted ₹<input name="counted" type="number" min="0" step="1"></label></div>`, 'Close shift', async (f) => {
        const r = await api.post<{ variance: number; flagged: boolean }>('/api/cashier/close', { countedCash: Number(val(f, 'counted')) })
        await this.reload()
        return r.variance === 0 ? 'Shift closed. Cash matches.' : `Shift closed. ${r.variance > 0 ? 'Excess' : 'Short'} ${rs(Math.abs(r.variance))}${r.flagged ? ', flagged to the MD' : ''}.`
      })
    }
    return true
  }
}
