import { esc, showDate } from './dom'
import { inr } from '../data/dates'

// A guest's stay as money: the room bill grouped by what it was for, and what the guest still has open
// elsewhere (orders not yet charged to the room, laundry not yet delivered). Shown on the desk's booking
// page and in the room's drawer on the 3D map.

export interface StayLine { id: string; kind: string; description: string; amount_paise: number; business_date: string; reverses: string | null; ref: string | null }
export interface OpenItems {
  orders: { id: string; number: number; outlet: string; kind: string; status: string; subtotal_paise: number; sent_items: number; pending_items: number; opened_at: string }[]
  laundry: { id: string; items: { name: string; qty: number }[]; express: boolean; total_paise: number; picked_at: string }[]
}
export interface StayDetail { lines: StayLine[]; balance: number; openItems: OpenItems; documents: { id: string; doc_type: string; number: string; issue_date: string; total_paise: number }[]; /** Room nights not yet charged, with GST. */ pendingPaise?: number }

export const rs = (p: number) => inr(Math.round(p / 100))
const GROUPS: [string, string, string[]][] = [
  ['room', 'Room', ['room', 'extra_bed']], ['fnb', 'Restaurant & bar', ['fnb', 'liquor']], ['laundry', 'Laundry', ['laundry']], ['other', 'Other services', ['misc']], ['paid', 'Paid', ['payment', 'refund']],
]

export const openCount = (o: OpenItems | undefined) => (o ? o.orders.length + o.laundry.length : 0)

/** The bill grouped by what it was for, each group with its subtotal; reversed lines are struck through. */
export function billHtml(lines: StayLine[], opts: { reverse?: (l: StayLine) => string; compact?: boolean } = {}) {
  if (!lines.length) return '<p class="muted small">Nothing charged or paid yet. Room nights are charged each night when the day closes.</p>'
  const reversed = new Set(lines.map((l) => l.reverses).filter(Boolean))
  const byId = new Map(lines.map((l) => [l.id, l]))
  const groupOf = (l: StayLine) => {
    const k = l.kind === 'reversal' ? byId.get(l.reverses ?? '')?.kind ?? 'misc' : l.kind
    return GROUPS.find((g) => g[2].includes(k))?.[0] ?? 'other'
  }
  return GROUPS.map(([key, label]) => {
    const list = lines.filter((l) => groupOf(l) === key)
    if (!list.length) return ''
    const sum = list.reduce((a, l) => a + Number(l.amount_paise), 0)
    const struck = (l: StayLine) => reversed.has(l.id) || l.kind === 'reversal'
    return `<div class="stay-group"><div class="stay-group-head"><span>${label}</span><span class="num">${key === 'paid' ? rs(-sum) : rs(sum)}</span></div>
      ${list.map((l) => `<div class="fd-line${struck(l) ? ' struck' : ''}${opts.compact ? ' compact' : ''}">
        <span>${esc(showDate(l.business_date))}</span><span>${esc(l.description)}${l.ref && !opts.compact ? ` <span class="muted small">${esc(l.ref)}</span>` : ''}</span>
        <span class="num">${Number(l.amount_paise) < 0 ? '−' : ''}${rs(Math.abs(Number(l.amount_paise)))}</span>${opts.reverse && !struck(l) && !['payment', 'refund', 'reversal'].includes(l.kind) ? opts.reverse(l) : '<span></span>'}</div>`).join('')}</div>`
  }).join('')
}

/** What the guest still has open elsewhere, each with its amount. */
export function openItemsHtml(o: OpenItems) {
  const rows = [
    ...o.orders.map((x) => `<div class="fd-line"><span>${esc(x.outlet)}</span><span>Order ${x.number}${x.kind === 'room_service' ? ' · room service' : ''}${!x.sent_items ? ' · <i>nothing sent to the kitchen</i>' : x.status === 'billed' ? ' · billed, not paid' : ' · not billed'}${x.pending_items ? ` · ${x.pending_items} item${x.pending_items > 1 ? 's' : ''} not sent` : ''}</span><span class="num">${rs(x.subtotal_paise)}</span><span></span></div>`),
    ...o.laundry.map((x) => `<div class="fd-line"><span>Laundry</span><span>${x.items.map((i) => `${i.qty} × ${esc(i.name)}`).join(', ')}${x.express ? ' · express' : ''} · with the laundry</span><span class="num">${rs(x.total_paise)}</span><span></span></div>`),
  ]
  return rows.join('')
}
