import { esc, tonePill, showDate } from '../ui/dom'
import { val } from '../ui/form-modal'
import { chips, rs, type Ws } from './common'

// Bar stock: what is in the bar now (full bottles and the open one), the daily stock register,
// TASMAC purchases, breakage, physical counts and brands; and excise: the register in bottles for a
// period (printed for the licence), the TCS credit on purchases, and peg measures due for stamping.

interface Brand { id: string; name: string; liquor_class: string; class_label: string; bottle_ml: number; placeholder: boolean; active: boolean }
interface Stock { id: string; name: string; bottle_ml: number; ml: number; fullBottles: number; openMl: number; negative: boolean; valuePaise: number }
interface RegRow { id: string; name: string; bottle_ml: number; opening: number; received: number; sold: number; breakage: number; adjusted: number; closing: number }
interface Purchase { id: string; supplier: string; invoice_no: string; invoice_date: string; lines: { name: string; bottles: number; costPaise: number }[]; total_paise: number; tcs_paise: number; permit_no: string | null; received_by: string }
interface Count { id: string; business_date: string; variance_percent: string; status: string; counted_by: string; lines: { name: string; bookMl: number; countedMl: number; varianceMl: number }[] }
type Sub = 'stock' | 'register' | 'purchases' | 'counts' | 'excise' | 'brands'
interface ExciseRow { id: string; name: string; label: string; bottle_ml: number; bottles: { opening: number; received: number; sold: number; breakage: number; adjusted: number; closing: number }; bulkLitres: { closing: number } }
interface Measure { id: string; name: string; kind: string; capacity: string | null; location: string | null; stamp_no: string | null; stamped_on: string | null; due_on: string | null; active: boolean }

const bottles = (ml: number, size: number) => {
  const neg = ml < 0, a = Math.abs(ml), full = Math.floor(a / size), open = a % size
  return `${neg ? '−' : ''}${full} btl${open ? ` + ${open} ml` : ''}`
}

export class BarView {
  sub: Sub = 'stock'
  date = ''
  private brands: Brand[] = []
  private stock: Stock[] = []
  private register: { date: string; brands: RegRow[] } = { date: '', brands: [] }
  private purchases: Purchase[] = []
  private counts: Count[] = []
  private excise: { from: string; to: string; brands: ExciseRow[] } | null = null
  private tcs: { fy: string; section: string; quarters: { quarter: number; purchases: number; tcsPaise: number }[] } | null = null
  private measures: Measure[] = []
  private from = ''
  private to = ''

  constructor(private ws: Ws) {}

  private get manager() { return this.ws.can('bar.stock') }

  async load() {
    const api = this.ws.api
    this.brands = await api.get('/api/bar/brands')
    if (this.sub === 'stock') this.stock = await api.get('/api/bar/stock')
    if (this.sub === 'register') this.register = await api.get(`/api/bar/register${this.date ? `?date=${this.date}` : ''}`)
    if (this.sub === 'purchases') this.purchases = await api.get('/api/bar/purchases')
    if (this.sub === 'counts') { this.stock = await api.get('/api/bar/stock'); this.counts = this.ws.can('bar.stock', 'bar.approve') ? await api.get('/api/bar/counts') : [] }
    if (this.sub === 'excise') {
      if (!this.to) { const d = new Date(Date.now() + 330 * 60_000); this.to = d.toISOString().slice(0, 10); this.from = `${this.to.slice(0, 8)}01` }
      this.excise = await api.get(`/api/excise/register?from=${this.from}&to=${this.to}`)
      this.tcs = await api.get<NonNullable<BarView['tcs']>>('/api/excise/tcs').catch(() => null)
      this.measures = await api.get('/api/excise/measures')
    }
  }

  html() {
    const subs: [Sub, string][] = [['stock', 'In the bar'], ['register', 'Daily register'], ['purchases', 'TASMAC purchases'], ['counts', 'Physical count'], ['excise', 'Excise'], ['brands', 'Brands']]
    const bar = `<div class="ws-toolbar">${chips(subs, this.sub, 'bsub')}<button type="button" class="btn" data-b="breakage">Report breakage</button></div>`
    if (this.sub === 'stock') {
      return bar + `<div class="m-table">${this.stock.map((s) => `<div class="m-row m-row-4${s.negative ? ' warn' : ''}"><b>${esc(s.name)}</b><span class="mono">${bottles(s.ml, s.bottle_ml)}</span>
        <span class="muted small">${s.ml} ml${s.valuePaise ? ` · ${rs(s.valuePaise)} at cost` : ''}</span><span>${s.negative ? tonePill('Below zero', '--st-departing') : ''}</span></div>`).join('') || '<div class="empty">No brands yet. Add them under Brands.</div>'}</div>
        ${this.stock.some((s) => s.negative) ? '<p class="fd-warn small">Below zero means more was sold than bought: enter the TASMAC invoice or count the stock.</p>' : ''}`
    }
    if (this.sub === 'register') {
      const r = this.register
      return bar + `<div class="ws-toolbar"><label class="inline">Date <input type="date" name="regdate" value="${esc(r.date)}"></label><span class="muted small">ml · bottles in brackets</span></div>
        <div class="m-table reg"><div class="m-row reg-row head"><span>Brand</span><span>Opening</span><span>Received</span><span>Sold</span><span>Breakage</span><span>Adjusted</span><span>Closing</span></div>
        ${r.brands.map((b) => `<div class="m-row reg-row"><b>${esc(b.name)}</b>${[b.opening, b.received, b.sold, b.breakage, b.adjusted, b.closing].map((v, i) => `<span class="mono${i === 5 ? ' strong' : ''}">${v}${i === 0 || i === 5 ? `<small>${bottles(v, b.bottle_ml)}</small>` : ''}</span>`).join('')}</div>`).join('')}</div>`
    }
    if (this.sub === 'purchases') {
      return bar + (this.manager ? '<div class="ws-toolbar"><button type="button" class="btn primary" data-b="purchase">Enter TASMAC invoice</button></div>' : '')
        + (this.purchases.map((p) => `<div class="row-card"><div class="rc-title">${esc(p.supplier)} · ${esc(p.invoice_no)}</div>
          <div class="rc-sub">${esc(showDate(p.invoice_date))} · ${p.lines.map((l) => `${l.bottles} × ${esc(l.name)}`).join(', ')} · received by ${esc(p.received_by)}${p.permit_no ? ` · permit ${esc(p.permit_no)}` : ''}${Number(p.tcs_paise) ? ` · TCS ${rs(Number(p.tcs_paise))}` : ''}</div>
          <div class="rc-right"><span class="mono">${rs(p.total_paise)}</span></div></div>`).join('') || '<div class="empty">No purchases entered.</div>')
    }
    if (this.sub === 'counts') {
      return bar + (this.manager ? '<div class="ws-toolbar"><button type="button" class="btn primary" data-b="count">Enter a physical count</button></div><p class="muted small">Count full bottles and measure the open bottle. The GM approves before the book stock changes; a variance above 3% is flagged to the MD.</p>' : '')
        + this.counts.map((c) => `<div class="row-card"><div class="rc-title">${esc(showDate(c.business_date))} · variance ${Number(c.variance_percent)}%</div>
          <div class="rc-sub">${c.lines.map((l) => `${esc(l.name)} ${l.varianceMl > 0 ? '+' : ''}${l.varianceMl} ml`).join(' · ')} · ${esc(c.counted_by)}</div>
          <div class="rc-right">${tonePill(c.status === 'approved' ? 'Approved' : c.status === 'rejected' ? 'Rejected' : 'Waiting for GM', c.status === 'approved' ? '--st-vacant' : c.status === 'rejected' ? '--st-ooo' : '--marigold')}</div></div>`).join('')
    }
    if (this.sub === 'excise' && this.excise) {
      const e = this.excise, f = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
      const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
      return bar + `<div class="ws-toolbar"><label class="inline">From <input type="date" name="exfrom" value="${esc(e.from)}"></label><label class="inline">To <input type="date" name="exto" value="${esc(e.to)}"></label>
          <button type="button" class="btn" data-b="print-daily">Print daily register</button><button type="button" class="btn" data-b="print-period">Print statement</button></div>
        <div class="m-table reg"><div class="m-row reg-row head"><span>Brand (bottles)</span><span>Opening</span><span>Received</span><span>Sold</span><span>Breakage</span><span>Adjusted</span><span>Closing</span></div>
        ${e.brands.map((b) => `<div class="m-row reg-row"><b>${esc(b.name)}<small class="muted"> ${esc(b.label)} · ${b.bottle_ml} ml</small></b>${[b.bottles.opening, b.bottles.received, b.bottles.sold, b.bottles.breakage, b.bottles.adjusted, b.bottles.closing].map((v, i) => `<span class="mono${i === 5 ? ' strong' : ''}">${f(v)}${i === 5 ? `<small>${f(b.bulkLitres.closing)} L</small>` : ''}</span>`).join('')}</div>`).join('')}</div>
        ${this.tcs ? `<div class="sec-title">TCS collected by TASMAC, ${esc(this.tcs.fy)} <span>${esc(this.tcs.section)} · a credit against income tax</span></div>
          <div class="chips">${this.tcs.quarters.map((q) => `<span class="chip">Q${q.quarter}: ${rs(q.tcsPaise)} (${q.purchases})</span>`).join('')}</div>` : ''}
        <div class="sec-title">Peg measures and scales <span>legal metrology stamping</span></div>
        ${this.ws.can('bar.settings', 'licences.edit') ? '<div class="ws-toolbar"><button type="button" class="btn" data-b="measure">Add measure</button></div>' : ''}
        ${this.measures.filter((m) => m.active).map((m) => `<div class="row-card${m.due_on && m.due_on <= today ? ' late' : ''}"><div class="rc-title">${esc(m.name)}</div>
          <div class="rc-sub">${esc([m.capacity, m.location, m.stamp_no && `stamp ${m.stamp_no}`].filter(Boolean).join(' · '))}${m.stamped_on ? ` · stamped ${esc(showDate(m.stamped_on))}` : ''}</div>
          <div class="rc-right">${m.due_on ? tonePill(`due ${showDate(m.due_on)}`, m.due_on <= today ? '--st-departing' : '--muted') : tonePill('no date', '--marigold')}${this.ws.can('bar.settings', 'licences.edit') ? `<button type="button" class="btn small" data-measure="${esc(m.id)}">Restamped…</button>` : ''}</div></div>`).join('') || '<div class="empty">No measures registered.</div>'}`
    }
    return bar + (this.manager ? '<div class="ws-toolbar"><button type="button" class="btn primary" data-b="add-brand">Add brand</button></div>' : '')
      + `<div class="m-table">${this.brands.map((b) => `<div class="m-row m-row-4${b.active ? '' : ' retired'}"><b>${esc(b.name)}</b><span>${esc(b.class_label)}</span><span class="mono">${b.bottle_ml} ml${b.placeholder ? ' · sample' : ''}</span>
        ${this.manager ? `<button type="button" class="btn small" data-edit-brand="${esc(b.id)}">Edit</button>` : '<span></span>'}</div>`).join('')}</div>
        <p class="muted small">Link each liquor dish to its brand and pour size in Menu → dish → Edit.</p>`
  }

  async click(t: HTMLElement): Promise<boolean> {
    const api = this.ws.api, modal = this.ws.modal
    const sub = t.closest<HTMLElement>('[data-bsub]')?.dataset.bsub as Sub | undefined
    if (sub) { this.sub = sub; await this.load(); return true }
    const eb = t.closest<HTMLElement>('[data-edit-brand]')?.dataset.editBrand
    if (eb) {
      const b = this.brands.find((x) => x.id === eb)!
      modal.open(`Brand · ${b.name}`, `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="80" value="${esc(b.name)}"></label>
        <label class="check"><input type="checkbox" name="active" ${b.active ? 'checked' : ''}> Stocked</label></div>`, 'Save', async (f) => {
        await api.req('PATCH', `/api/bar/brands/${eb}`, { name: val(f, 'name'), active: (f.elements.namedItem('active') as HTMLInputElement).checked })
        await this.load(); this.ws.render(); return 'Saved'
      })
      return true
    }
    const ms = t.closest<HTMLElement>('[data-measure]')?.dataset.measure
    if (ms) {
      const m = this.measures.find((x) => x.id === ms)!
      modal.open(`Restamped · ${m.name}`, `<div class="form-grid"><label>Stamped on<input name="on" type="date"></label><label>Stamp / certificate no.<input name="no" maxlength="40" value="${esc(m.stamp_no ?? '')}"></label></div>
        <p class="muted small">The next due date is set a year later.</p>`, 'Save', async (f) => {
        await api.req('PATCH', `/api/excise/measures/${ms}`, { stampedOn: val(f, 'on'), stampNo: val(f, 'no') || undefined }); await this.load(); this.ws.render(); return 'Saved'
      })
      return true
    }
    const act = t.closest<HTMLElement>('[data-b]')?.dataset.b
    if (!act) return false
    if (act === 'print-daily' || act === 'print-period') { await api.openDocument(`/api/excise/register/print?from=${this.from}&to=${this.to}${act === 'print-daily' ? '&daily=1' : ''}`); return false }
    if (act === 'measure') {
      modal.open('Add measure', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="60" placeholder="e.g. Peg measure 30 ml #1"></label>
        <label>Kind<select name="kind"><option value="peg_measure">Peg measure</option><option value="scale">Weighing scale</option><option value="dispenser">Dispenser</option><option value="other">Other</option></select></label>
        <label>Capacity<input name="cap" maxlength="20" placeholder="30 ml"></label><label>Where<input name="loc" maxlength="40" placeholder="Bar"></label>
        <label>Stamp no.<input name="no" maxlength="40"></label><label>Last stamped<input name="on" type="date"></label><label>Next due (blank: a year later)<input name="due" type="date"></label></div>`, 'Add', async (f) => {
        await api.post('/api/excise/measures', { name: val(f, 'name'), kind: val(f, 'kind'), capacity: val(f, 'cap') || undefined, location: val(f, 'loc') || undefined, stampNo: val(f, 'no') || undefined, stampedOn: val(f, 'on') || undefined, dueOn: val(f, 'due') || undefined })
        await this.load(); this.ws.render(); return 'Measure added'
      })
      return true
    }
    const brandOpts = this.brands.filter((b) => b.active).map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')
    if (act === 'add-brand') {
      const classes = await api.get<{ id: string; label: string; active: boolean }[]>('/api/vat-rates')
      modal.open('Add brand', `<div class="form-grid"><label class="span2">Brand and size<input name="name" maxlength="80" placeholder="e.g. Kingfisher Premium 650 ml"></label>
        <label>Class<select name="cls">${classes.filter((c) => c.active).map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}</select></label>
        <label>Bottle ml<select name="ml">${[180, 330, 375, 500, 650, 750, 1000].map((m) => `<option ${m === 750 ? 'selected' : ''}>${m}</option>`).join('')}</select></label></div>`, 'Add', async (f) => {
        await api.post('/api/bar/brands', { name: val(f, 'name'), liquorClass: val(f, 'cls'), bottleMl: Number(val(f, 'ml')) })
        await this.load(); this.ws.render(); return 'Brand added'
      })
    }
    if (act === 'breakage') {
      modal.open('Report breakage or spillage', `<div class="form-grid"><label class="span2">Brand<select name="brand" required><option value="">Choose the brand…</option>${brandOpts}</select></label>
        <label>Lost (ml)<input name="ml" type="number" min="1" step="1" placeholder="750"></label><label>Reason<input name="reason" maxlength="120" placeholder="Bottle dropped"></label></div>
        <p class="muted small">Keep the broken bottle for the manager. Above the role's limit the GM approves.</p>`, 'Report', async (f) => {
        if (!val(f, 'brand')) throw new Error('Choose the brand that was lost.')
        const r = await api.post<{ pending?: boolean }>('/api/bar/breakage', { brandId: val(f, 'brand'), ml: Number(val(f, 'ml')), reason: val(f, 'reason') })
        await this.load(); this.ws.render(); return r.pending ? 'Sent for approval' : 'Breakage recorded'
      })
    }
    if (act === 'purchase') {
      const line = (n: number) => `<div class="pay-row" ${n > 2 ? 'hidden' : ''} data-pl="${n}"><select name="b${n}"><option value="">—</option>${brandOpts}</select>
        <input name="n${n}" type="number" min="0" step="1" placeholder="Bottles" aria-label="Bottles"><input name="c${n}" type="number" min="0" step="0.01" placeholder="₹ per bottle" aria-label="Cost per bottle"></div>`
      modal.open('TASMAC invoice', `<div class="form-grid"><label>Invoice no.<input name="inv" maxlength="40"></label><label>Invoice date<input name="date" type="date"></label>
        <label>Transport permit no.<input name="permit" maxlength="40"></label><label>Permit date<input name="pdate" type="date"></label></div>
        ${Array.from({ length: 12 }, (_, i) => line(i)).join('')}<button type="button" class="btn small ghost" data-moreline>Another brand</button>
        <div class="form-grid"><label>VAT on the invoice ₹<input name="vat" type="number" min="0" step="0.01" value="0"></label><label>TCS on the invoice ₹ (blank: 1%)<input name="tcs" type="number" min="0" step="0.01"></label></div>`, 'Save purchase', async (f) => {
        const lines = Array.from({ length: 12 }, (_, i) => ({ brandId: val(f, `b${i}`), bottles: Number(val(f, `n${i}`) || 0), cost: Number(val(f, `c${i}`) || 0) })).filter((l) => l.brandId && l.bottles)
        await api.post('/api/bar/purchases', { supplier: 'TASMAC', invoiceNo: val(f, 'inv'), invoiceDate: val(f, 'date'), permitNo: val(f, 'permit'), permitDate: val(f, 'pdate') || undefined,
          vat: Number(val(f, 'vat') || 0), tcs: val(f, 'tcs') === '' ? undefined : Number(val(f, 'tcs')), lines })
        await this.load(); this.ws.render(); return 'Purchase saved and stock updated'
      })
      modal.el.querySelector('[data-moreline]')!.addEventListener('click', () => { const h = modal.el.querySelector<HTMLElement>('[data-pl][hidden]'); if (h) h.hidden = false })
    }
    if (act === 'count') {
      modal.open('Physical count', `<p class="muted small">Leave a brand blank to skip it.</p><div class="count-grid">${this.stock.map((s) => `<label><span>${esc(s.name)} <small class="muted">book ${bottles(s.ml, s.bottle_ml)}</small></span>
        <input name="f_${esc(s.id)}" type="number" min="0" step="1" placeholder="Full bottles" aria-label="Full bottles"><input name="o_${esc(s.id)}" type="number" min="0" max="${s.bottle_ml - 1}" step="1" placeholder="Open ml" aria-label="Open bottle ml"></label>`).join('')}</div>`, 'Submit count', async (f) => {
        const lines = this.stock.filter((s) => val(f, `f_${s.id}`) !== '' || val(f, `o_${s.id}`) !== '').map((s) => ({ brandId: s.id, fullBottles: Number(val(f, `f_${s.id}`) || 0), openMl: Number(val(f, `o_${s.id}`) || 0) }))
        const r = await api.post<{ variancePercent: number; alert: boolean }>('/api/bar/counts', { lines })
        await this.load(); this.ws.render()
        return `Count saved: ${r.variancePercent}% variance${r.alert ? ', flagged to the MD' : ''}. Waiting for the GM.`
      })
    }
    return true
  }

  async change(t: HTMLElement): Promise<boolean> {
    const name = (t as HTMLInputElement).name
    if (name === 'exfrom' || name === 'exto') {
      if (name === 'exfrom') this.from = (t as HTMLInputElement).value; else this.to = (t as HTMLInputElement).value
      await this.load(); return true
    }
    if (name !== 'regdate') return false
    this.date = (t as HTMLInputElement).value
    await this.load()
    return true
  }
}
