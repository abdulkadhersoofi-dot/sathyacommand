import { esc, toast, tonePill, showDate } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { takePhoto, uploadPhoto } from '../ui/photo'
import { toolbar } from '../ui/toolbar'
import type { WorkspaceHost } from '../ui/workspace'
import { rupees, type Item, type Store } from './items'

// Goods received (against a PO, or a cash purchase without one), vendor bills matched three ways, and
// payments with TDS and the MSME due dates.

type Host = WorkspaceHost & { stores(): Promise<Store[]>; items(): Promise<Item[]> }
const q3 = (n: number | string) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 })
const n = (v: string | number | null | undefined) => Number(v ?? 0)

interface GrnLine { line: number; item: string; purchase_unit: string; qty_received: string; qty_accepted: string; reject_reason: string | null; batch_no: string | null; expiry: string | null; billed_qty: string }
interface Grn { id: string; number: string; po_number: string | null; vendor: string; vendor_id: string; store: string; challan_no: string | null; business_date: string; value_paise: string; received_by: string; note: string | null; lines: GrnLine[] }
interface PoLine { line: number; item_id: string; item: string; purchase_unit: string; qty: string; received_qty: string }

/** The receive-goods form for a PO: each line's count, what was accepted, why the rest was rejected, batch and expiry. */
export async function receivePo(h: WorkspaceHost, poId: string, done: () => Promise<void>) {
  const po = await h.api.get<{ number: string; vendor: string; store: string; lines: PoLine[] }>(`/api/pos/${poId}`)
  const open = po.lines.filter((l) => n(l.received_qty) < n(l.qty))
  let photo: string | null = null
  h.modal.open(`Receive ${po.number} · ${po.vendor}`, `<p class="muted small">Into ${esc(po.store)}. Count what arrived; take in only what passes the quality check.</p>
    <div class="form-grid"><label>Delivery challan no.<input name="challan" maxlength="30"></label></div>
    <div class="grn-lines">${open.map((l) => `<div class="grn-line"><b>${esc(l.item)}</b><span class="muted small">ordered ${q3(l.qty)}${n(l.received_qty) ? `, ${q3(l.received_qty)} already in` : ''} ${esc(l.purchase_unit)}</span>
      <label>Arrived<input name="got_${l.line}" type="number" min="0" step="any" value="${q3(n(l.qty) - n(l.received_qty)).replace(/,/g, '')}"></label>
      <label>Accepted<input name="ok_${l.line}" type="number" min="0" step="any" placeholder="all"></label>
      <label>Rejected because<input name="why_${l.line}" maxlength="80" placeholder="if any rejected"></label>
      <label>Batch<input name="batch_${l.line}" maxlength="30"></label><label>Expiry<input name="exp_${l.line}" type="date"></label></div>`).join('')}</div>
    <div class="actions"><button type="button" class="btn" data-photo>Photo of the delivery</button><span class="muted small" data-photo-state></span></div>`, 'Take into stock', async (f) => {
    const lines = open.map((l) => ({
      poLine: l.line, qtyReceived: Number(val(f, `got_${l.line}`) || 0), qtyAccepted: val(f, `ok_${l.line}`) === '' ? undefined : Number(val(f, `ok_${l.line}`)),
      rejectReason: val(f, `why_${l.line}`) || undefined, batchNo: val(f, `batch_${l.line}`) || undefined, expiry: val(f, `exp_${l.line}`) || undefined,
    })).filter((l) => l.qtyReceived > 0)
    const photoIds = photo ? [await uploadPhoto(h.api, 'other', photo)] : []
    const r = await h.api.post<{ number: string }>('/api/grns', { poId, challanNo: val(f, 'challan') || undefined, photoIds, lines })
    await done()
    return `${r.number}: goods taken into stock`
  })
  h.modal.el.querySelector('[data-photo]')!.addEventListener('click', async () => {
    photo = await takePhoto(); h.modal.el.querySelector('[data-photo-state]')!.textContent = photo ? 'Photo ready' : ''
  })
}

export class ReceiptsView {
  private list: Grn[] = []
  private expiring: { id: string; item: string; store: string; batch_no: string | null; expiry: string; qty_left: string; unit: string; days_left: number }[] = []
  constructor(private h: Host) {}

  async load() {
    this.list = await this.h.cached('/api/grns')
    this.expiring = await this.h.cached('/api/stock/expiring?days=3')
  }

  html() {
    return `${toolbar({
      primary: [
        ...(this.h.can('stores.receive') ? [{ attrs: 'data-gr="po"', label: 'Receive against a purchase order' }] : []),
        ...(this.h.can('purchase.order') ? [{ attrs: 'data-gr="cash"', label: 'Cash purchase without an order', primary: false }] : []),
      ],
    })}
      ${this.expiring.length ? `<div class="sec-title">Expiring in 3 days <span>${this.expiring.length}</span></div>${this.expiring.map((x) => `<div class="row-card late"><div class="rc-title">${esc(x.item)} · ${q3(x.qty_left)} ${esc(x.unit)}</div>
        <div class="rc-sub">${esc(x.store)}${x.batch_no ? ` · batch ${esc(x.batch_no)}` : ''} · ${x.days_left < 0 ? '<span class="fd-warn">expired</span>' : `expires ${esc(x.expiry)}`}</div>
        ${this.h.can('stores.issue') ? `<div class="rc-right"><button type="button" class="btn small" data-gr="expire:${esc(x.id)}">Write off</button></div>` : ''}</div>`).join('')}` : ''}
      <div class="sec-title">Goods received <span>${this.list.length}</span></div>
      ${this.list.map((g) => `<div class="row-card"><div class="rc-title">${esc(g.number)} · ${esc(g.vendor)}${g.po_number ? ` · ${esc(g.po_number)}` : ' · <span class="fd-warn">no PO</span>'}</div>
        <div class="rc-sub">${g.lines.map((l) => `${esc(l.item)} ${q3(l.qty_accepted)} ${esc(l.purchase_unit)}${n(l.qty_accepted) < n(l.qty_received) ? ` <span class="fd-warn">(${q3(n(l.qty_received) - n(l.qty_accepted))} rejected: ${esc(l.reject_reason ?? '')})</span>` : ''}`).join(' · ')}</div>
        <div class="rc-sub">${esc(g.store)} · ${esc(showDate(g.business_date))} · ${esc(g.received_by)}${g.challan_no ? ` · challan ${esc(g.challan_no)}` : ''}${g.note ? ` · ${esc(g.note)}` : ''}</div>
        <div class="rc-right"><b class="mono">${rupees(n(g.value_paise))}</b></div></div>`).join('') || '<div class="empty">Nothing received yet.</div>'}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-gr]')?.dataset.gr
    if (!a) return false
    const done = async () => { await this.load(); this.h.render() }
    if (a.startsWith('expire:')) {
      if (!confirm('Write this batch off as expired? It comes out of stock at cost.')) return false
      const r = await this.h.api.post<{ valuePaise: number }>(`/api/stock/batches/${a.slice(7)}/expire`)
      toast(`Written off (${rupees(r.valuePaise)})`); await this.load(); return true
    }
    if (a === 'po') {
      const pos = (await this.h.api.get<{ id: string; number: string; vendor: string; status: string; store: string }[]>('/api/pos')).filter((p) => ['approved', 'sent', 'partly_received'].includes(p.status))
      if (!pos.length) { toast('No approved purchase orders waiting for goods.'); return false }
      this.h.modal.open('Receive against a PO', `<div class="form-grid"><label class="span2">Purchase order<select name="po">${pos.map((p) => `<option value="${esc(p.id)}">${esc(p.number)} · ${esc(p.vendor)} · ${esc(p.store)}</option>`).join('')}</select></label></div>`, 'Next', async (f) => {
        await receivePo(this.h, val(f, 'po'), done)
      })
    }
    if (a === 'cash') {
      const [items, stores, vendors] = await Promise.all([this.h.items(), this.h.stores(), this.h.api.get<{ id: string; name: string; active: boolean }[]>('/api/vendors')])
      const opts = `<option value="">—</option>${items.map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.purchase_unit)})</option>`).join('')}`
      this.h.modal.open('Cash purchase without a PO', `<div class="form-grid"><label>Bought from<select name="vendor">${vendors.filter((v) => v.active).map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label>
        <label>Into<select name="store">${stores.filter((s) => s.active).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
        <label class="span2">Why there was no PO<input name="note" maxlength="200" placeholder="e.g. milk ran short for breakfast"></label></div>
        <div class="line-editor">${[0, 1, 2, 3].map((k) => `<div class="le-row"><select name="i_${k}" aria-label="Item">${opts}</select><input name="q_${k}" type="number" min="0" step="any" placeholder="Qty"><input name="r_${k}" type="number" min="0" step="0.01" placeholder="Price ₹ each"></div>`).join('')}</div>`, 'Take into stock', async (f) => {
        const lines = [0, 1, 2, 3].filter((k) => val(f, `i_${k}`)).map((k) => ({ itemId: val(f, `i_${k}`), qtyReceived: Number(val(f, `q_${k}`)), rate: Number(val(f, `r_${k}`)) }))
        if (!lines.length) throw new Error('Choose what was bought.')
        const r = await this.h.api.post<{ number: string }>('/api/grns', { vendorId: val(f, 'vendor'), storeId: val(f, 'store'), note: val(f, 'note'), lines })
        await done(); return `${r.number} taken into stock`
      })
    }
    return false
  }
}

interface Bill {
  id: string; vendor: string; vendor_id: string; bill_no: string; bill_date: string; po_number: string | null; grns: string | null; taxable_paise: string; cgst_paise: string; sgst_paise: string; igst_paise: string
  total_paise: string; itc_paise: string; balance_paise: string; due_date: string; msme_due_date: string | null; msme: string; match: string; differences: string[]; status: string
  entered_by: string; entered_by_name: string; approved_by_name: string | null; daysToDue: number; msmeLate: boolean
}
const MATCH: Record<string, [string, string]> = { matched: ['Matches PO and goods', '--st-vacant'], difference: ['Difference', '--st-departing'], no_po: ['No PO', '--marigold'] }
const BILL_STATE: Record<string, [string, string]> = { entered: ['To pass', '--marigold'], approved: ['Passed for payment', '--st-occupied'], partly_paid: ['Part paid', '--st-arriving'], paid: ['Paid', '--st-vacant'], cancelled: ['Cancelled', '--muted'] }

export class BillsView {
  private list: Bill[] = []
  private status = 'open'
  constructor(private h: Host) {}

  async load() { this.list = await this.h.cached(`/api/bills?status=${this.status}`) }

  html() {
    const chip = (s: string, l: string) => `<button type="button" class="chip" data-bs="${s}" aria-pressed="${this.status === s}">${l}</button>`
    return `${toolbar({
      primary: this.h.can('purchase.bill') ? [{ attrs: 'data-bl="new"', label: 'Enter a bill' }] : [],
      filters: `<div class="chips">${chip('open', 'Open')}${chip('paid', 'Paid')}${chip('all', 'All')}</div>`,
    })}
      ${this.list.map((b) => `<div class="row-card${b.msmeLate || (b.msme_due_date && b.daysToDue <= 10 && b.status !== 'paid') ? ' late' : ''}"><div class="rc-title">${esc(b.vendor)} · bill ${esc(b.bill_no)} · ${esc(showDate(b.bill_date))}</div>
        <div class="rc-sub">${b.po_number ? esc(b.po_number) : 'no PO'}${b.grns ? ` · ${esc(b.grns)}` : ''} · taxable ${rupees(n(b.taxable_paise))} + GST ${rupees(n(b.cgst_paise) + n(b.sgst_paise) + n(b.igst_paise))}${n(b.itc_paise) ? ` (ITC ${rupees(n(b.itc_paise))})` : ''}</div>
        ${b.differences.length ? `<div class="rc-sub fd-warn">${b.differences.map(esc).join(' · ')}</div>` : ''}
        <div class="rc-sub">${b.msme_due_date ? `<b>MSME: pay by ${esc(showDate(b.msme_due_date))}</b>${b.msmeLate ? ' <span class="fd-warn">late: the expense is not deductible this year</span>' : b.status !== 'paid' ? ` (${b.daysToDue} days)` : ''}` : `Due ${esc(showDate(b.due_date))}`} · entered by ${esc(b.entered_by_name)}${b.approved_by_name ? ` · passed by ${esc(b.approved_by_name)}` : ''}</div>
        <div class="rc-right"><b class="mono">${rupees(n(b.total_paise))}</b>${tonePill(...(MATCH[b.match] ?? [b.match, '--muted']))}${tonePill(...(BILL_STATE[b.status] ?? [b.status, '--muted']))}
          ${b.status === 'entered' && (this.h.can('purchase.approve') || (b.match === 'matched' && this.h.can('purchase.bill') && b.entered_by !== this.h.me.id)) ? `<button type="button" class="btn small" data-bl="pass:${esc(b.id)}">Pass…</button>` : ''}
          ${['entered', 'approved'].includes(b.status) && n(b.total_paise) === n(b.balance_paise) && this.h.can('purchase.bill') ? `<button type="button" class="btn small" data-bl="cancel:${esc(b.id)}">Cancel…</button>` : ''}</div></div>`).join('') || '<div class="empty">No bills.</div>'}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const s = el.closest<HTMLElement>('[data-bs]')?.dataset.bs
    if (s) { this.status = s; await this.load(); return true }
    const a = el.closest<HTMLElement>('[data-bl]')?.dataset.bl
    if (!a) return false
    const api = this.h.api, done = async (m: string) => { await this.load(); this.h.render(); return m }
    if (a === 'new') { await this.enter(); return false }
    const [act, id] = a.split(':')
    const bill = this.list.find((b) => b.id === id)!
    if (act === 'pass') {
      this.h.modal.open(`Pass bill ${bill.bill_no}`, `${bill.differences.length ? `<p class="fd-warn">${bill.differences.map(esc).join('<br>')}</p>` : bill.match === 'no_po' ? '<p>There is no purchase order or goods receipt behind this bill.</p>' : '<p>The bill matches the PO and the goods received.</p>'}
        <div class="form-grid"><label class="span2">${bill.match === 'difference' ? 'Why the difference is accepted' : 'Note (optional)'}<input name="reason" maxlength="200"></label></div>`, 'Pass for payment', async (f) => {
        await api.post(`/api/bills/${id}/approve`, { reason: val(f, 'reason') || undefined }); return done('Passed for payment')
      })
    }
    if (act === 'cancel') {
      this.h.modal.open(`Cancel bill ${bill.bill_no}?`, '<div class="form-grid"><label class="span2">Why<input name="reason" maxlength="200"></label></div>', 'Cancel bill', async (f) => {
        await api.post(`/api/bills/${id}/cancel`, { reason: val(f, 'reason') }); return done('Bill cancelled')
      }, { danger: true, cancelLabel: 'Keep the bill' })
    }
    return false
  }

  /** Enter a vendor's bill: pick the vendor, tick the goods receipts it covers (lines filled in from them), or type service lines. */
  private async enter() {
    const vendors = (await this.h.api.get<{ id: string; name: string; active: boolean }[]>('/api/vendors')).filter((v) => v.active)
    this.h.modal.open('Enter a bill', `<div class="form-grid"><label class="span2">Vendor<select name="vendor">${vendors.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label></div>`, 'Next', async (f) => {
      const vendorId = val(f, 'vendor')
      const grns = await this.h.api.get<(Grn & { po_id: string | null; lines: (GrnLine & { item_id: string; rate_paise: string })[] })[]>(`/api/grns?vendorId=${vendorId}&unbilled=1&days=365`)
      const items = await this.h.items()
      const opts = `<option value="">— service —</option>${items.map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.purchase_unit)})</option>`).join('')}`
      const lines: { itemId: string; qty: number; rate: number }[] = []
      for (const g of grns) for (const l of g.lines) if (n(l.qty_accepted) > n(l.billed_qty)) lines.push({ itemId: l.item_id, qty: n(l.qty_accepted) - n(l.billed_qty), rate: n(l.rate_paise) / 100 })
      const rows = Math.max(4, lines.length + 2)
      // A supplier's bill for a banquet event (decor, DJ…) can be tied to the event, for its cost.
      const events = this.h.can('events.view', 'events.manage') ? (await this.h.api.get<{ id: string; number: string; title: string; status: string; date: string | null }[]>('/api/banquets/events').catch(() => []))
        .filter((e) => e.status !== 'lost') : []
      this.h.modal.open('Enter a bill', `<div class="form-grid"><label>Bill number<input name="no" maxlength="30"></label><label>Bill date<input name="date" type="date"></label>
        ${events.length ? `<label class="span2">For a banquet event (optional)<select name="event"><option value="">—</option>${events.map((e) => `<option value="${esc(e.id)}">${esc(e.number)} ${esc(e.title)}${e.date ? ` · ${esc(showDate(e.date))}` : ''}</option>`).join('')}</select></label>` : ''}</div>
        ${grns.length ? `<fieldset class="grn-pick"><legend>Goods receipts it covers</legend>${grns.map((g) => `<label class="check"><input type="checkbox" name="g_${esc(g.id)}" checked> ${esc(g.number)}${g.po_number ? ` (${esc(g.po_number)})` : ''} · ${esc(showDate(g.business_date))}</label>`).join('')}</fieldset>` : '<p class="muted small">No goods received from this vendor waiting for a bill: enter service lines (AMC, repairs, contract work).</p>'}
        <p class="muted small">Enter the lines as they are on the bill: quantity in the purchase unit and the rate before GST. Differences from the PO and the goods received are flagged.</p>
        <div class="line-editor bill-lines">${Array.from({ length: rows }, (_, k) => `<div class="le-row bill-row"><select name="i_${k}" aria-label="Item">${opts.replace(`value="${esc(lines[k]?.itemId ?? '-')}"`, `value="${esc(lines[k]?.itemId ?? '-')}" selected`)}</select>
          <input name="d_${k}" maxlength="80" placeholder="or service description"><input name="q_${k}" type="number" min="0" step="any" placeholder="Qty" value="${lines[k] ? lines[k].qty : ''}">
          <input name="r_${k}" type="number" min="0" step="0.01" placeholder="Rate ₹" value="${lines[k] ? lines[k].rate : ''}"><select name="t_${k}" aria-label="GST"><option value="">GST: item's</option>${[0, 5, 12, 18, 28].map((r) => `<option value="${r}">${r}%</option>`).join('')}</select>
          <label class="check" title="Reverse charge: the resort pays this GST to the government (security agency, goods transport, advocate, unregistered landlord, sponsorship)"><input type="checkbox" name="rc_${k}"> RCM</label></div>`).join('')}</div>
        <div class="form-grid"><label>Round-off (₹)<input name="round" type="number" step="0.01" min="-1" max="1" value="0"></label></div>`, 'Enter bill', async (f2) => {
        const out = []
        for (let k = 0; k < rows; k++) {
          const itemId = val(f2, `i_${k}`), desc = val(f2, `d_${k}`), q = Number(val(f2, `q_${k}`)), r = val(f2, `r_${k}`)
          if (!itemId && !desc) continue
          if (!(q > 0) || r === '') throw new Error('Each line needs a quantity and a rate.')
          out.push({ itemId: itemId || undefined, description: itemId ? undefined : desc, qty: q, rate: Number(r), gstRate: val(f2, `t_${k}`) === '' ? undefined : Number(val(f2, `t_${k}`)),
            rcm: (f2.elements.namedItem(`rc_${k}`) as HTMLInputElement | null)?.checked || undefined })
        }
        if (!out.length) throw new Error('Enter the lines of the bill.')
        const r = await this.h.api.post<{ match: string; differences: string[]; totalPaise: number }>('/api/bills', {
          vendorId, billNo: val(f2, 'no'), billDate: val(f2, 'date'), grnIds: grns.filter((g) => checked(f2, `g_${g.id}`)).map((g) => g.id), lines: out, roundOff: Number(val(f2, 'round') || 0),
          eventId: val(f2, 'event') || undefined,
        })
        await this.load(); this.h.render()
        return r.match === 'matched' ? `Bill entered (${rupees(r.totalPaise)}): matches. Another person in accounts passes it.` : r.match === 'no_po' ? 'Bill entered: no PO behind it, the GM passes it.' : `Bill entered with differences: ${r.differences.join('; ')}`
      })
    })
  }
}

interface Payment { id: string; number: string; vendor: string; pay_date: string; mode: string; reference: string | null; gross_paise: string; tds_paise: string; tds_section: string | null; net_paise: string; status: string; bills: string | null }

export class PaymentsView {
  private bills: Bill[] = []
  private payments: Payment[] = []
  private tds: { summary: { section: string; quarter: number; entries: number; tds_paise: string }[]; fy: string } | null = null
  constructor(private h: Host) {}

  async load() {
    this.bills = (await this.h.cached<Bill[]>('/api/bills')).filter((b) => ['approved', 'partly_paid'].includes(b.status))
    this.payments = await this.h.cached('/api/payments')
    this.tds = await this.h.cached('/api/tds')
  }

  html() {
    const byVendor = new Map<string, Bill[]>()
    for (const b of this.bills) byVendor.set(b.vendor_id, [...(byVendor.get(b.vendor_id) ?? []), b])
    const PAY: Record<string, [string, string]> = { pending_approval: ['Waiting for GM', '--marigold'], approved: ['To pay', '--st-occupied'], paid: ['Paid', '--st-vacant'], cancelled: ['Cancelled', '--muted'] }
    const pay = this.h.can('purchase.pay')
    return `<div class="sec-title">To pay <span>${rupees(this.bills.reduce((a, b) => a + n(b.balance_paise), 0))}</span></div>
      ${[...byVendor.values()].map((bs) => `<div class="row-card${bs.some((b) => b.msme_due_date && b.daysToDue <= 10) ? ' late' : ''}"><div class="rc-title">${esc(bs[0].vendor)}${bs[0].msme !== 'none' ? ` ${tonePill(`MSME ${bs[0].msme}`, '--marigold')}` : ''}</div>
        <div class="rc-sub">${bs.map((b) => `${esc(b.bill_no)} ${rupees(n(b.balance_paise))} · ${b.msme_due_date ? `<b>by ${esc(showDate(b.msme_due_date))}</b>` : `due ${esc(showDate(b.due_date))}`}`).join(' · ')}</div>
        <div class="rc-right"><b class="mono">${rupees(bs.reduce((a, b) => a + n(b.balance_paise), 0))}</b>${pay ? `<button type="button" class="btn small" data-py="new:${esc(bs[0].vendor_id)}">Pay…</button>` : ''}</div></div>`).join('') || '<div class="empty">Nothing passed for payment.</div>'}
      <div class="sec-title">Payments</div>
      ${this.payments.slice(0, 50).map((p) => `<div class="row-card"><div class="rc-title">${esc(p.number)} · ${esc(p.vendor)}</div>
        <div class="rc-sub">${esc(p.bills ?? '')} · ${esc(showDate(p.pay_date))} · ${esc(p.mode)}${p.reference ? ` ${esc(p.reference)}` : ''}${n(p.tds_paise) ? ` · TDS ${esc(p.tds_section ?? '')} ${rupees(n(p.tds_paise))}` : ''}</div>
        <div class="rc-right"><b class="mono">${rupees(n(p.net_paise))}</b>${tonePill(...(PAY[p.status] ?? [p.status, '--muted']))}${pay && p.status === 'approved' ? `<button type="button" class="btn small" data-py="paid:${esc(p.id)}:${esc(p.mode)}">Mark paid…</button>` : ''}${pay && ['approved', 'pending_approval'].includes(p.status) ? `<button type="button" class="btn small" data-py="cancel:${esc(p.id)}">Cancel</button>` : ''}</div></div>`).join('') || '<div class="empty">No payments yet.</div>'}
      ${this.tds?.summary.length ? `<div class="sec-title">TDS deducted, ${esc(this.tds.fy)} <span>deposit by the 7th of the next month</span></div>${this.tds.summary.map((s) => `<div class="m-row ping-row"><b>${esc(s.section)}</b><span>Quarter ${s.quarter} · ${s.entries} deduction${s.entries > 1 ? 's' : ''}</span><span class="mono">${rupees(n(s.tds_paise))}</span></div>`).join('')}` : ''}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-py]')?.dataset.py
    if (!a) return false
    const api = this.h.api, done = async (m: string) => { await this.load(); this.h.render(); return m }
    const [act, id, mode] = a.split(':')
    if (act === 'cancel') { await api.post(`/api/payments/${id}/cancel`); await this.load(); toast('Payment cancelled'); return true }
    if (act === 'paid') {
      this.h.modal.open('Mark paid', `<div class="form-grid"><label class="span2">${mode === 'cheque' ? 'Cheque number' : mode === 'cash' ? 'Voucher / note (optional)' : 'UTR / transaction reference'}<input name="ref" maxlength="40"></label></div>`, 'Mark paid', async (f) => {
        await api.post(`/api/payments/${id}/paid`, { reference: val(f, 'ref') || undefined }); return done('Paid')
      })
      return false
    }
    const bills = this.bills.filter((b) => b.vendor_id === id)
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
    this.h.modal.open(`Pay ${bills[0].vendor}`, `<fieldset class="grn-pick"><legend>Bills</legend>${bills.map((b) => `<label class="check"><input type="checkbox" name="b_${esc(b.id)}" checked data-recalc> ${esc(b.bill_no)} · ${rupees(n(b.balance_paise))}</label>`).join('')}</fieldset>
      <div class="pay-preview muted small" data-preview>Working out TDS…</div>
      <div class="form-grid"><label>Date<input name="date" type="date" value="${today}"></label><label>Mode<select name="mode"><option value="bank">Bank transfer</option><option value="upi">UPI</option><option value="cheque">Cheque</option><option value="cash">Cash</option></select></label>
        <label class="span2">Reference (UTR, cheque no.; can be added when paid)<input name="ref" maxlength="40"></label></div>`, 'Record payment', async (f) => {
      const body = { vendorId: id, billIds: bills.filter((b) => checked(f, `b_${b.id}`)).map((b) => b.id), payDate: val(f, 'date'), mode: val(f, 'mode'), reference: val(f, 'ref') || undefined }
      let r: { status: string; number: string }
      try { r = await api.post('/api/payments', body) } catch (e) {
        if (!(e as { body?: { cashWarning?: boolean } }).body?.cashWarning || !confirm(`${(e as Error).message}\n\nPay in cash anyway?`)) throw e
        r = await api.post('/api/payments', { ...body, acceptCashWarning: true })
      }
      return done(r.status === 'pending_approval' ? `${r.number} is above your limit: sent to the GM.` : `${r.number} recorded: mark it paid with the reference once the money goes.`)
    })
    const preview = async () => {
      const form = this.h.modal.el.querySelector('form')!
      const billIds = bills.filter((b) => checked(form, `b_${b.id}`)).map((b) => b.id)
      const out = this.h.modal.el.querySelector<HTMLElement>('[data-preview]')!
      if (!billIds.length) { out.textContent = 'Choose the bills.'; return }
      try {
        const p = await api.post<{ gross: number; tds: number; rate: number; section: string; reason: string; net: number }>('/api/payments/preview', { vendorId: id, billIds })
        out.innerHTML = `Bills ${rupees(p.gross)} − TDS ${p.tds ? `${esc(p.section)} at ${p.rate}% ${rupees(p.tds)}` : `nil (${esc(p.reason)})`} = <b>pay ${rupees(p.net)}</b>`
      } catch (e) { out.textContent = (e as Error).message }
    }
    this.h.modal.el.querySelectorAll('[data-recalc]').forEach((x) => x.addEventListener('change', () => void preview()))
    void preview()
    return false
  }
}
