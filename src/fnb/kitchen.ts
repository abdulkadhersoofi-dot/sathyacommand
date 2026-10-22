import { esc } from '../ui/dom'
import { checked } from '../ui/form-modal'
import { chips, minutesAgo, type MenuItem, type Ticket, type Ws } from './common'
import { printTickets } from './print'
import { toolbar } from '../ui/toolbar'

// Kitchen and bar screens: each station's tickets, oldest first, with timers that turn amber at
// 10 minutes and red at 20. Start, ready, recall, served; all-day counts; sold-out switches.

interface KdsTicket {
  id: string; number: number; kind: 'KOT' | 'BOT'; station_id: string; status: 'new' | 'cooking' | 'ready'; prints: number; created_at: string
  order_number: number; order_kind: string; table_label: string | null; room_no: string | null; outlet: string; covers: number; order_status?: string
  lines: { id: string; name: string; qty: number; note: string | null; seat: number | null; course: number; status: string; void_reason: string | null; allergens: string[]; jain: boolean }[]
}

export class KitchenView {
  stationId = ''
  private data: { tickets: KdsTicket[]; allDay: { name: string; qty: number }[] } = { tickets: [], allDay: [] }

  constructor(private ws: Ws) {}

  async load() {
    this.data = await this.ws.api.get(`/api/fnb/kds${this.stationId ? `?stationId=${this.stationId}` : ''}`)
  }

  html() {
    const stations: [string, string][] = [['', 'All stations'], ...this.ws.stations.filter((s) => s.active).map((s): [string, string] => [s.id, s.name])]
    const t = this.data.tickets
    const canCook = this.ws.can('kitchen'), canServe = this.ws.can('fnb.order')
    const card = (k: KdsTicket) => {
      const age = minutesAgo(k.created_at)
      const where = k.table_label ? `Table ${k.table_label}` : k.room_no ? `Room ${k.room_no}` : 'Takeaway'
      return `<article class="kds" data-status="${k.status}" data-age="${age >= 20 ? 'late' : age >= 10 ? 'warn' : 'ok'}">
        <header><span class="kds-no">${k.kind} ${k.number}</span><span class="kds-age" data-created="${esc(k.created_at)}">${age} min</span></header>
        <div class="kds-where"><b>${esc(where)}</b> · ${esc(k.outlet)} · ${k.covers} pax${this.stationId ? '' : ` · ${esc(this.ws.stations.find((s) => s.id === k.station_id)?.name ?? k.station_id)}`}${k.order_status === 'closed' ? ' · <b>paid</b>' : ''}</div>
        <ul>${k.lines.map((l) => `<li class="${l.status === 'void' ? 'void' : ''}"><b>${l.qty}</b> ${esc(l.name)}${l.seat ? ` <i>seat ${l.seat}</i>` : ''}
          ${l.note ? `<div class="kds-note">${esc(l.note)}</div>` : ''}
          ${l.allergens.length || l.jain ? `<div class="kds-alert">${[...l.allergens.map((a) => a.toUpperCase()), ...(l.jain ? ['JAIN'] : [])].map(esc).join(' · ')}</div>` : ''}
          ${l.status === 'void' ? `<div class="kds-note">Cancelled${l.void_reason ? `: ${esc(l.void_reason)}` : ''}</div>` : ''}</li>`).join('')}</ul>
        <footer>
          ${canCook && k.status === 'new' ? `<button type="button" class="btn" data-kds="cooking" data-kot="${esc(k.id)}">Start</button>` : ''}
          ${canCook && k.status === 'cooking' ? `<button type="button" class="btn primary" data-kds="ready" data-kot="${esc(k.id)}">Ready</button>` : ''}
          ${canCook && k.status === 'ready' ? `<button type="button" class="btn" data-kds="cooking" data-kot="${esc(k.id)}">Recall</button>` : ''}
          ${canServe && k.status === 'ready' ? `<button type="button" class="btn primary" data-kds="served" data-kot="${esc(k.id)}">Served</button>` : ''}
          <button type="button" class="btn ghost" data-kds="reprint" data-kot="${esc(k.id)}">Print</button>
        </footer></article>`
    }
    const col = (title: string, list: KdsTicket[]) => `<section class="kds-col"><div class="sec-title">${title} <span>${list.length}</span></div>${list.map(card).join('') || '<div class="empty">None</div>'}</section>`
    return toolbar({ filters: chips(stations, this.stationId, 'station'), more: this.ws.can('kitchen', 'menu.edit') ? [{ attrs: 'data-kds="soldout"', label: 'Sold out today' }] : [] }) + `
      <div class="kds-wrap">
        <div class="kds-board">${col('New', t.filter((k) => k.status === 'new'))}${col('Cooking', t.filter((k) => k.status === 'cooking'))}${col('Ready', t.filter((k) => k.status === 'ready'))}</div>
        <aside class="kds-allday"><div class="sec-title">All day</div>${this.data.allDay.map((a) => `<div class="kv-row"><span>${esc(a.name)}</span><b>${a.qty}</b></div>`).join('') || '<div class="empty">Nothing to make.</div>'}</aside>
      </div>`
  }

  /** Updates the timers without rebuilding the board. */
  tick() {
    document.querySelectorAll<HTMLElement>('.ws .kds-age[data-created]').forEach((el) => {
      const age = minutesAgo(el.dataset.created!)
      el.textContent = `${age} min`
      el.closest<HTMLElement>('.kds')!.dataset.age = age >= 20 ? 'late' : age >= 10 ? 'warn' : 'ok'
    })
  }

  async click(t: HTMLElement): Promise<boolean> {
    const station = t.closest<HTMLElement>('[data-station]')?.dataset.station
    if (station !== undefined) { this.stationId = station; await this.load(); return true }
    const el = t.closest<HTMLElement>('[data-kds]')
    if (!el) return false
    const act = el.dataset.kds!, kot = el.dataset.kot
    if (act === 'reprint') {
      const tk = await this.ws.api.post<Ticket>(`/api/fnb/kots/${kot}/reprint`)
      printTickets([tk], (id) => this.ws.stations.find((s) => s.id === id)?.name ?? id)
      return true
    }
    if (act === 'soldout') { await this.soldOut(); return true }
    await this.ws.api.post(`/api/fnb/kots/${kot}/status`, { status: act })
    await this.load()
    return true
  }

  /** Sold-out switches for this station's dishes, applied to every outlet that sells them. */
  private async soldOut() {
    const menus = await Promise.all(this.ws.outlets.filter((o) => o.active).map((o) => this.ws.api.get<{ items: MenuItem[] }>(`/api/fnb/menu?outletId=${o.id}`)))
    const byCode = new Map<string, MenuItem[]>()
    for (const m of menus) for (const i of m.items) if (!this.stationId || i.station_id === this.stationId) byCode.set(`${i.code}|${i.name}`, [...(byCode.get(`${i.code}|${i.name}`) ?? []), i])
    const rows = [...byCode.values()].sort((a, b) => a[0].name.localeCompare(b[0].name))
    this.ws.modal.open('Sold out today', `<p class="muted">Untick a dish when it runs out. Captains can't order it until you tick it again.</p>
      <div class="soldout">${rows.map((r) => `<label><input type="checkbox" name="${esc(r[0].code + '|' + r[0].name)}" ${r.every((i) => i.available) ? 'checked' : ''}> ${esc(r[0].name)}</label>`).join('')}</div>`, 'Save', async (f) => {
      let changed = 0
      for (const r of rows) {
        const on = checked(f, r[0].code + '|' + r[0].name)
        for (const i of r.filter((x) => x.available !== on)) { await this.ws.api.post(`/api/fnb/items/${i.id}/availability`, { available: on }); changed++ }
      }
      await this.load(); this.ws.render()
      return changed ? 'Menu updated on every tablet' : ''
    })
  }
}
