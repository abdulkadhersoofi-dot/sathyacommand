import { esc, toast, tonePill, showDate } from '../ui/dom'
import { val } from '../ui/form-modal'
import { money, type Host } from './books'

// TN VAT on liquor, the fixed-asset register with depreciation, and department budgets against actuals.

const download = (name: string, text: string, type: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
}
const lastMonth = (day: string) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(0); return d.toISOString().slice(0, 7) }

interface Vat { period: string; due: string; byRate: { liquorClass: string; rate: number; taxable: number; vat: number }[]; invoices: unknown[]; purchases: { invoice: string; date: string; permit: string | null; value: number; vat: number; tcs: number }[]; totals: { salesPaise: number; outputVatPaise: number; purchasesPaise: number; inputVatPaise: number; creditAllowed: boolean; payablePaise: number }; filed: { ack_no: string; filed_on: string } | null }

export class VatView {
  private period = ''
  private d: Vat | null = null
  constructor(private h: Host) {}
  async load() { this.period ||= lastMonth(this.h.to); this.d = await this.h.cached(`/api/vat/${this.period}`) }
  html() {
    const d = this.d!
    return `<div class="ws-toolbar"><label class="inline">Month <input type="month" data-period value="${esc(this.period)}"></label>
        <button type="button" class="btn" data-vt="sales.csv">Sales register (CSV)</button><button type="button" class="btn" data-vt="purchases.csv">Purchase register (CSV)</button>
        ${this.h.can('vat.file') && !d.filed ? '<button type="button" class="btn primary" data-vt="file">Return filed…</button>' : ''}
        ${d.filed ? tonePill(`Filed ${d.filed.filed_on} · ${d.filed.ack_no}`, '--st-vacant') : tonePill(`Due ${showDate(d.due)}`, '--marigold')}</div>
      <div class="sec-title">Liquor sold (${d.invoices.length} VAT invoices)</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Class</th><th class="n">Rate</th><th class="n">Value</th><th class="n">VAT</th></tr></thead><tbody>
        ${d.byRate.map((r) => `<tr><td>${esc(r.liquorClass)}</td><td class="n">${r.rate}%</td><td class="n">${money(r.taxable)}</td><td class="n">${money(r.vat)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No liquor sold this month.</td></tr>'}
      </tbody><tfoot><tr><td colspan="2">Total</td><td class="n">${money(d.totals.salesPaise)}</td><td class="n">${money(d.totals.outputVatPaise)}</td></tr></tfoot></table></div>
      <div class="sec-title">Bought from TASMAC</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Invoice</th><th>Date</th><th>Permit</th><th class="n">Value</th><th class="n">VAT</th><th class="n">TCS</th></tr></thead><tbody>
        ${d.purchases.map((p) => `<tr><td class="mono">${esc(p.invoice)}</td><td>${esc(showDate(p.date))}</td><td>${esc(p.permit ?? '')}</td><td class="n">${money(p.value)}</td><td class="n">${money(p.vat)}</td><td class="n">${money(p.tcs)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">None this month.</td></tr>'}
      </tbody></table></div>
      <div class="row-card mc-card"><div class="mc-figs"><span><small>VAT on sales</small><b class="mono">${money(d.totals.outputVatPaise)}</b></span><span><small>VAT paid to TASMAC</small><b class="mono">${money(d.totals.inputVatPaise)}</b></span>
        <span><small>To pay</small><b class="mono">${money(d.totals.payablePaise)}</b></span></div>
        <div class="rc-sub">${d.totals.creditAllowed ? 'VAT paid to TASMAC is set off.' : 'VAT paid to TASMAC is not set off until the CA confirms it may be.'}</div></div>`
  }
  async change(el: HTMLElement) { if (!el.matches('[data-period]')) return false; this.period = (el as HTMLInputElement).value; await this.load(); return true }
  async click(el: HTMLElement) {
    const a = el.closest<HTMLElement>('[data-vt]')?.dataset.vt
    if (a?.endsWith('.csv')) download(`VAT_${a.replace('.csv', '')}_${this.period}.csv`, await this.h.api.req<string>('GET', `/api/vat/${this.period}/${a}`), 'text/csv')
    if (a === 'file') this.h.modal.open(`VAT return ${this.period} filed`, `<div class="form-grid"><label>Acknowledgement no.<input name="ack" maxlength="30"></label><label>Filed on<input name="on" type="date" value="${esc(this.h.to)}"></label></div>`, 'Record', async (f) => {
      await this.h.api.post('/api/vat/returns', { period: this.period, ackNo: val(f, 'ack'), filedOn: val(f, 'on') })
      await this.load(); this.h.render()
      return 'Recorded as filed'
    })
    return false
  }
}

interface Asset { id: string; code: string; name: string; category: string; dept: string | null; put_to_use: string; cost_paise: number; life_years: string; accumulatedPaise: number; bookValuePaise: number; disposed_on: string | null }
interface Reg { classes: Record<string, { label: string; life: number; itRate: number }>; departments: Record<string, string>; assets: Asset[]; runs: { month: string; amount_paise: string; voucher: string | null }[]; nextMonth: string; businessDate: string }
interface ItBlock { label: string; rate: number; openingPaise: number; additionsFullPaise: number; additionsHalfPaise: number; salesPaise: number; depreciationPaise: number; closingPaise: number }

export class AssetsView {
  private d: Reg | null = null
  private it: { fy: string; blocks: ItBlock[] } | null = null
  constructor(private h: Host) {}
  async load() { this.d = await this.h.cached('/api/assets/register'); this.it = await this.h.cached('/api/assets/it-depreciation') }
  html() {
    const d = this.d!, manage = this.h.can('assets.manage'), it = this.it!
    const due = dueMonths(d.nextMonth, d.businessDate)
    const label = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    const depBtn = !d.assets.length ? '' : !due.length ? `<span class="muted small">Depreciation is posted up to ${esc(label(lastMonth(`${d.nextMonth}-15`)))}.</span>`
      : `<button type="button" class="btn" data-fa="dep">Post depreciation for ${esc(label(due[0]))}${due.length > 1 ? ` to ${esc(label(due[due.length - 1]))} (${due.length} months)` : ''}</button>`
    return `<div class="ws-toolbar">${manage ? `<button type="button" class="btn primary" data-fa="add">Add an asset…</button>${depBtn}` : ''}</div>
      <p class="muted small">Assets bought on a vendor bill are put in the books by charging the bill's line to the asset account; add them here too, so they are depreciated. Depreciation in the books is straight line over the Companies Act lives; the income-tax figure below is by block.</p>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Asset</th><th>Class</th><th>In use from</th><th class="n">Cost</th><th class="n">Depreciation</th><th class="n">Book value</th><th></th></tr></thead><tbody>
        ${d.assets.map((a) => `<tr class="${a.disposed_on ? 'retired' : ''}"><td><span class="mono">${esc(a.code)}</span> ${esc(a.name)}${a.dept ? ` <small class="muted">${esc(d.departments[a.dept] ?? a.dept)}</small>` : ''}</td>
          <td>${esc(d.classes[a.category]?.label ?? a.category)} <small class="muted">${Number(a.life_years)} yrs</small></td><td>${esc(showDate(a.put_to_use))}</td><td class="n">${money(a.cost_paise)}</td><td class="n">${money(a.accumulatedPaise)}</td>
          <td class="n">${a.disposed_on ? `sold ${esc(showDate(a.disposed_on))}` : money(a.bookValuePaise)}</td><td>${manage && !a.disposed_on ? `<button type="button" class="btn small" data-dispose="${esc(a.id)}">Sold / scrapped…</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No assets yet.</td></tr>'}
      </tbody></table></div>
      ${d.runs.length ? `<p class="small muted">Depreciation posted: ${d.runs.slice(0, 6).map((r) => `${esc(r.month)} ${money(Number(r.amount_paise))}`).join(' · ')}</p>` : ''}
      <div class="sec-title">Income-tax depreciation ${esc(it.fy)}</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Block</th><th class="n">Rate</th><th class="n">Opening</th><th class="n">Added (180+ days)</th><th class="n">Added (under 180)</th><th class="n">Sold</th><th class="n">Depreciation</th><th class="n">Closing</th></tr></thead><tbody>
        ${it.blocks.map((b) => `<tr><td>${esc(b.label)}</td><td class="n">${b.rate}%</td><td class="n">${money(b.openingPaise)}</td><td class="n">${money(b.additionsFullPaise)}</td><td class="n">${money(b.additionsHalfPaise)}</td><td class="n">${money(b.salesPaise)}</td><td class="n">${money(b.depreciationPaise)}</td><td class="n">${money(b.closingPaise)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No assets.</td></tr>'}
      </tbody></table></div>`
  }
  async click(el: HTMLElement) {
    const done = async (msg: string) => { await this.load(); this.h.render(); return msg }
    const a = el.closest<HTMLElement>('[data-fa]')
    if (a?.dataset.fa === 'dep') {
      // Every month that is over and not yet posted, in order.
      let total = 0, months = 0
      try {
        for (const m of dueMonths(this.d!.nextMonth, this.d!.businessDate)) {
          const r = await this.h.api.post<{ amountPaise: number }>('/api/assets/depreciation', { month: m }).catch((e) => { if (/Nothing to depreciate/.test((e as Error).message)) return null; throw e })
          if (!r) break
          total += r.amountPaise; months++
        }
      } finally { await this.load(); this.h.render() }
      toast(months ? `${money(total)} depreciation posted for ${months} month${months === 1 ? '' : 's'}` : 'Nothing to depreciate yet')
    }
    if (a?.dataset.fa === 'add') {
      const d = this.d!
      this.h.modal.open('Add an asset', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="80"></label>
          <label>Class<select name="cat">${Object.entries(d.classes).map(([k, c]) => `<option value="${k}">${esc(c.label)} (${c.life} yrs)</option>`).join('')}</select></label>
          <label>Department<select name="dept"><option value="">—</option>${Object.entries(d.departments).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
          <label>Cost (₹)<input name="cost" type="number" min="1"></label><label>In use from<input name="from" type="date"></label>
          <label>Life (years, blank: the class's)<input name="life" type="number" min="1" step="0.5"></label>
          <label class="span2"><span><input type="checkbox" name="opening"> Held before the books began (if it is not already in your opening balances, it is put in at cost less the depreciation already taken)</span></label>
          <label>Depreciation already taken (₹)<input name="dep" type="number" min="0" value="0"></label></div>`, 'Add', async (f) => {
        const r = await this.h.api.post<{ note: string | null }>('/api/assets/register', { name: val(f, 'name'), category: val(f, 'cat'), dept: val(f, 'dept') || undefined, cost: Number(val(f, 'cost')), putToUse: val(f, 'from'),
          lifeYears: val(f, 'life') ? Number(val(f, 'life')) : undefined, openingDep: Number(val(f, 'dep') || 0), postOpening: (f.elements.namedItem('opening') as HTMLInputElement).checked })
        return done(r.note ? `Asset added. ${r.note}` : 'Asset added')
      })
    }
    const id = el.closest<HTMLElement>('[data-dispose]')?.dataset.dispose
    if (id) this.h.modal.open('Sold or scrapped', `<div class="form-grid"><label>Date<input name="on" type="date" value="${esc(this.h.to)}"></label><label>It fetched (₹, 0 if scrapped)<input name="sale" type="number" min="0" value="0"></label></div>`, 'Record', async (f) => {
      const r = await this.h.api.post<{ profitPaise: number }>(`/api/assets/register/${id}/dispose`, { date: val(f, 'on'), sale: Number(val(f, 'sale')) })
      return done(r.profitPaise >= 0 ? `Profit ${money(r.profitPaise)}` : `Loss ${money(-r.profitPaise)}`)
    })
    return false
  }
}

interface Row3 { actualPaise: number; budgetPaise: number; variancePaise: number }
interface Budget { from: string; to: string; rows: { dept: string; name: string; revenue: Row3; cost: Row3; profit: Row3 }[] }
const DEPT_NAMES: Record<string, string> = { rooms: 'Rooms', fnb: 'Food & beverage', bar: 'Bar', banquets: 'Banquets', other: 'Other operated', admin: 'Administrative & general', sales: 'Sales & marketing', maintenance: 'Maintenance', utilities: 'Utilities' }

export class BudgetView {
  private d: Budget | null = null
  constructor(private h: Host) {}
  async load() { this.d = await this.h.cached(`/api/budgets/vs-actual?from=${this.h.from}&to=${this.h.to}`) }
  html() {
    const d = this.d!
    const cell = (x: Row3, good: (v: number) => boolean) => `<td class="n">${money(x.actualPaise)}</td><td class="n">${money(x.budgetPaise)}</td><td class="n ${x.budgetPaise && !good(x.variancePaise) ? 'fd-warn' : ''}">${x.budgetPaise ? money(x.variancePaise) : ''}</td>`
    return `<div class="ws-toolbar"><label class="inline">From <input type="date" data-range="from" value="${esc(this.h.from)}"></label><label class="inline">To <input type="date" data-range="to" value="${esc(this.h.to)}"></label>
        ${this.h.can('budget.manage') ? '<button type="button" class="btn primary" data-bg="set">Set a budget…</button>' : ''}</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th rowspan="2">Department</th><th colspan="3" class="n">Revenue</th><th colspan="3" class="n">Costs</th><th colspan="3" class="n">Profit</th></tr>
        <tr><th class="n">Actual</th><th class="n">Budget</th><th class="n">±</th><th class="n">Actual</th><th class="n">Budget</th><th class="n">±</th><th class="n">Actual</th><th class="n">Budget</th><th class="n">±</th></tr></thead><tbody>
        ${d.rows.map((r) => `<tr><td>${esc(r.name)}</td>${cell(r.revenue, (v) => v >= 0)}${cell(r.cost, (v) => v >= 0)}${cell(r.profit, (v) => v >= 0)}</tr>`).join('') || '<tr><td colspan="10" class="empty">No figures for these dates.</td></tr>'}
      </tbody></table></div>`
  }
  async change(el: HTMLElement) {
    const k = (el as HTMLInputElement).dataset.range as 'from' | 'to' | undefined
    if (!k) return false
    this.h[k] = (el as HTMLInputElement).value; await this.load(); return true
  }
  async click(el: HTMLElement) {
    if (el.closest('[data-bg=set]')) {
      const y = Number(this.h.to.slice(0, 4)), fy = Number(this.h.to.slice(5, 7)) >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`
      this.h.modal.open('Budget for the year', `<p class="muted small">The year's amount is spread evenly over its twelve months.</p><div class="form-grid">
          <label>Year<input name="fy" value="${fy}"></label><label>Department<select name="dept">${Object.entries(DEPT_NAMES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
          <label>Revenue for the year (₹)<input name="rev" type="number" min="0"></label><label>Costs for the year (₹)<input name="cost" type="number" min="0"></label></div>`, 'Save', async (f) => {
        if (val(f, 'rev') !== '') await this.h.api.req('PUT', '/api/budgets', { fy: val(f, 'fy'), dept: val(f, 'dept'), kind: 'revenue', annual: Number(val(f, 'rev')) })
        if (val(f, 'cost') !== '') await this.h.api.req('PUT', '/api/budgets', { fy: val(f, 'fy'), dept: val(f, 'dept'), kind: 'cost', annual: Number(val(f, 'cost')) })
        await this.load(); this.h.render()
        return 'Budget saved'
      })
    }
    return false
  }
}

/** The books for the CA's Tally, as Tally's XML import. */
export async function downloadTally(h: Host) {
  download(`Tally_${h.from}_${h.to}.xml`, await h.api.req<string>('GET', `/api/accounts/tally.xml?from=${h.from}&to=${h.to}&masters=1`), 'application/xml')
}

/** Months from the next one due up to the last month that is over. */
function dueMonths(next: string, businessDate: string) {
  const out: string[] = []
  const cur = businessDate.slice(0, 7)
  for (let m = next; m < cur && out.length < 36;) {
    out.push(m)
    const x = new Date(`${m}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); m = x.toISOString().slice(0, 7)
  }
  return out
}
