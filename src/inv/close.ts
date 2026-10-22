import { esc, tonePill, showDate } from '../ui/dom'
import { val } from '../ui/form-modal'
import { toolbar } from '../ui/toolbar'
import type { WorkspaceHost } from '../ui/workspace'
import { rupees } from './items'

// Month close: each store's month valued from its book, the closing count, the variance against the
// limit agreed for that store, theoretical against actual food cost, and the GM's sign-off.

interface Figures { openingPaise: number; receiptsPaise: number; issuesPaise: number; lossesPaise: number; variancePaise: number; closingPaise: number; basePaise: number; variancePercent: number; moved: boolean }
interface Food { salesPaise: number; theoreticalCostPaise: number; theoreticalPercent: number; wastagePaise: number; countLossPaise: number; actualCostPaise: number; actualPercent: number; dishesWithoutRecipe: string[] }
interface Close { id: string; status: string; variance_percent: string; closing_paise: string; note: string | null; prepared_by_name: string; decided_by_name: string | null; decided_at: string | null }
interface StoreMonth { storeId: string; name: string; ledger: string; limitPercent: number; figures: Figures; count: { ref: string; date: string } | null; close: Close | null; countNeeded: boolean; withinLimit: boolean; food: Food | null }
interface Overview { month: string; from: string; to: string; over: boolean; countFrom: string; stores: StoreMonth[] }

const STATE: Record<string, [string, string]> = { closed: ['Closed', '--st-vacant'], pending_approval: ['With the GM', '--marigold'], rejected: ['Sent back', '--st-departing'] }

export class MonthCloseView {
  private month = ''                 // the server's default: the month before the business date
  private o: Overview | null = null
  constructor(private h: WorkspaceHost) {}

  async load() {
    this.o = await this.h.cached<Overview>(`/api/month-close${this.month ? `?month=${this.month}` : ''}`)
    this.month = this.o.month
  }

  html() {
    const o = this.o!
    const closed = o.stores.filter((s) => s.close?.status === 'closed').length
    return `${toolbar({
      filters: `<label class="inline">Month <input type="month" data-month value="${esc(this.month)}" aria-label="Month"></label>`,
      more: [{ attrs: 'data-mc="print"', label: 'Stock statement' }],
      end: `<span class="muted small">${closed} of ${o.stores.length} stores closed · closing count from ${esc(o.countFrom)} to ${esc(o.to)}</span>`,
    })}
      ${o.over ? '' : `<div class="banner-note">${esc(o.month)} is not over yet: the figures are the month so far. Close it from ${esc(o.to)} onwards, after the closing counts.</div>`}
      ${o.stores.map((s) => this.card(s, o)).join('')}`
  }

  private card(s: StoreMonth, o: Overview) {
    const f = s.figures, c = s.close
    const open = !c || c.status === 'rejected'
    const varTone = s.withinLimit ? '--st-vacant' : '--st-departing'
    const canClose = open && o.over && this.h.can('stores.count', 'stock.approve') && (s.count || !s.countNeeded)
    return `<div class="row-card mc-card">
      <div class="rc-title">${esc(s.name)} ${c ? tonePill(...(STATE[c.status] ?? [c.status, '--muted'])) : ''}</div>
      <div class="mc-figs">
        <span><small>Opening</small><b class="mono">${rupees(f.openingPaise)}</b></span>
        <span><small>Received</small><b class="mono">${rupees(f.receiptsPaise)}</b></span>
        <span><small>Issued / used</small><b class="mono">${rupees(0 - f.issuesPaise)}</b></span>
        <span><small>Losses</small><b class="mono">${rupees(0 - f.lossesPaise)}</b></span>
        <span><small>Count variance</small><b class="mono ${f.variancePaise < 0 ? 'fd-warn' : ''}">${rupees(f.variancePaise)}</b></span>
        <span><small>Closing</small><b class="mono">${rupees(f.closingPaise)}</b></span>
      </div>
      <div class="rc-sub">Variance ${tonePill(`${f.variancePercent.toFixed(2)}% of ${rupees(f.basePaise)}`, varTone)} limit ${s.limitPercent}%
        ${this.h.can('stock.approve') ? `<button type="button" class="btn small" data-mc="limit" data-id="${esc(s.storeId)}">Change limit</button>` : ''}</div>
      <div class="rc-sub">${s.count ? `Closing count ${esc(s.count.ref)} on ${esc(showDate(s.count.date))}` : s.countNeeded ? `<span class="fd-warn">No closing count yet</span>: count the store between ${esc(o.countFrom)} and ${esc(o.to)}.` : 'Nothing held or moved this month: no count needed.'}</div>
      ${s.food ? `<div class="rc-sub">Food cost on sales of ${rupees(s.food.salesPaise)}: theoretical ${rupees(s.food.theoreticalCostPaise)} (${s.food.theoreticalPercent}%) · actual ${rupees(s.food.actualCostPaise)} (${s.food.actualPercent}%) with wastage ${rupees(s.food.wastagePaise)} and count loss ${rupees(s.food.countLossPaise)}${s.food.dishesWithoutRecipe.length ? ` · ${s.food.dishesWithoutRecipe.length} dishes have no recipe` : ''}</div>` : ''}
      ${c ? `<div class="rc-sub">Prepared by ${esc(c.prepared_by_name)}${c.decided_by_name ? ` · ${c.status === 'rejected' ? 'sent back' : 'signed off'} by ${esc(c.decided_by_name)}` : ''}${c.note ? ` · “${esc(c.note)}”` : ''}</div>` : ''}
      ${canClose ? `<div class="rc-right"><button type="button" class="btn primary" data-mc="close" data-id="${esc(s.storeId)}">Close ${esc(o.month)}…</button></div>` : ''}
    </div>`
  }

  async change(el: HTMLElement): Promise<boolean> {
    if (!el.matches('[data-month]')) return false
    const v = (el as HTMLInputElement).value
    if (!/^\d{4}-\d{2}$/.test(v)) return false
    this.month = v; await this.load(); return true
  }

  async click(el: HTMLElement): Promise<boolean> {
    const b = el.closest<HTMLElement>('[data-mc]')
    if (!b) return false
    const s = this.o!.stores.find((x) => x.storeId === b.dataset.id)
    if (b.dataset.mc === 'print') { await this.h.api.openDocument(`/api/month-close/print?month=${this.month}`); return false }
    if (b.dataset.mc === 'limit' && s) {
      this.h.modal.open(`Variance limit: ${s.name}`, `<div class="form-grid"><label class="span2">Limit (% of what the store gives out in a month)<input name="pct" type="number" min="0" max="100" step="0.1" value="${s.limitPercent}"></label></div>`, 'Save', async (f) => {
        await this.h.api.post(`/api/stores/${s.storeId}/variance-limit`, { percent: Number(val(f, 'pct')) })
        await this.load(); this.h.render()
        return 'Limit saved'
      })
    }
    if (b.dataset.mc === 'close' && s) {
      const over = !s.withinLimit
      this.h.modal.open(`Close ${this.month}: ${s.name}`, `<p>Closing value <b>${rupees(s.figures.closingPaise)}</b>; count variance ${rupees(s.figures.variancePaise)}, <b class="${over ? 'fd-warn' : ''}">${s.figures.variancePercent.toFixed(2)}%</b> against the ${s.limitPercent}% agreed.</p>
        <p class="muted small">Once closed, nothing more can be dated in ${esc(this.month)} for this store.${this.h.can('stock.approve') ? '' : ' The GM signs it off.'}</p>
        <div class="form-grid"><label class="span2">${over ? 'Explain the variance (needed: it is over the limit)' : 'Note'}<textarea name="note" rows="3" maxlength="500"${over ? ' required minlength="10"' : ''}></textarea></label></div>`, 'Close the month', async (f) => {
        const r = await this.h.api.post<{ status: string }>('/api/month-close', { storeId: s.storeId, month: this.month, note: val(f, 'note') || undefined })
        await this.load(); this.h.render()
        return r.status === 'closed' ? `${s.name}: ${this.month} closed` : `${s.name}: sent to the GM to sign off`
      })
    }
    return false
  }
}
