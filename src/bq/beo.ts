import { esc, tonePill, showDate } from '../ui/dom'
import { toolbar } from '../ui/toolbar'
import { STYLE_LABEL } from './calendar'
import type { BqHost } from './workspace'

// Event orders: each department's sheet for the events ahead, from the latest revision, acknowledged by the
// department so sales knows it has been read.

interface BeoFn { id: string; name: string; venue: string; date: string; from: string; to: string; style: string; pax: number; menu: { name: string; veg: boolean | null; items: string[] } | null
  plates: number; seating: { tables: number; chairs: number; note: string }; parking: number; extras: { description: string; qty: number }[] }
interface Beo { number: string; title: string; kind: string; client: string; mobile: string | null; owner: string | null; functions: BeoFn[]; extras: { description: string; qty: number }[]; instructions: Record<string, string>; checks: { label: string; status: string; ref: string | null }[] }
interface Order { eventId: string; revision: number; issuedAt: string; by: string; beo: Beo; acks: Record<string, { by: string; at: string }> }

export class BeoView {
  private dept = ''
  private depts: { id: string; name: string }[] = []
  private orders: Order[] = []
  constructor(private h: BqHost) {}

  async load() {
    const r = await this.h.cached<{ depts: { id: string; name: string }[]; orders: Order[] }>('/api/banquets/beo')
    this.depts = r.depts; this.orders = r.orders
    if (!this.depts.some((d) => d.id === this.dept)) this.dept = this.depts[0]?.id ?? ''
  }

  private sheet(f: BeoFn) {
    const when = `<b>${esc(f.name)}</b> · ${esc(f.venue)} · ${esc(showDate(f.date))} <span class="mono">${esc(f.from)}–${esc(f.to)}</span> · ${f.pax} guests`
    const extras = f.extras.length ? `<div class="small">Also: ${f.extras.map((x) => `${esc(x.description)}${x.qty !== 1 ? ` × ${x.qty}` : ''}`).join(', ')}</div>` : ''
    switch (this.dept) {
      case 'kitchen': return `<div>${when}</div>${f.menu ? `<div><b>${f.plates} plates</b> of ${esc(f.menu.name)}${f.menu.veg === true ? ' (veg)' : f.menu.veg === false ? ' (non-veg)' : ''} <small class="muted">guarantee + 5%</small></div><div class="small">${esc(f.menu.items.join(' · '))}</div>` : '<div class="muted small">No menu with this function.</div>'}`
      case 'service': return `<div>${when}</div><div>${esc(STYLE_LABEL[f.style] ?? f.style)}${f.menu ? ` · ${esc(f.menu.name)}` : ''}</div>${extras}`
      case 'housekeeping': return `<div>${when}</div><div><b>${esc(STYLE_LABEL[f.style] ?? f.style)}</b>: ${f.seating.tables ? `${f.seating.tables} tables, ` : ''}${f.seating.chairs} chairs <small class="muted">${esc(f.seating.note)}; adjust on site</small></div>${extras}`
      case 'engineering': return `<div>${when}</div><div class="small">Power, sound and lights from setup until clearing.</div>${extras}`
      case 'security': return `<div>${when}</div><div>Parking for about <b>${f.parking}</b> cars <small class="muted">one per three guests</small></div>`
      default: return `<div>${when}</div>${extras}`
    }
  }

  html() {
    if (!this.depts.length) return '<p class="empty">Event orders are read by the kitchen, service, housekeeping, engineering, security and front office.</p>'
    return `${this.depts.length > 1 ? toolbar({ filters: this.depts.map((d) => `<button type="button" class="chip" data-bdept="${esc(d.id)}" aria-pressed="${d.id === this.dept}">${esc(d.name)}</button>`).join('') }) : `<div class="sec-title">${esc(this.depts[0].name)}</div>`}
      ${this.orders.map((o) => {
        const ack = o.acks[this.dept], ins = o.beo.instructions[this.dept]
        return `<div class="row-card bq-beo"><div class="rc-title"><span class="mono muted">${esc(o.beo.number)}</span> ${esc(o.beo.title)} <small class="muted">revision ${o.revision}</small></div>
          <div class="bq-beo-body">${o.beo.functions.map((f) => `<div class="bq-beo-fn">${this.sheet(f)}</div>`).join('')}
            ${ins ? `<div class="bq-beo-ins"><b>Instructions:</b> ${esc(ins)}</div>` : ''}
            ${o.beo.extras.length && this.dept !== 'kitchen' ? `<div class="small">For the event: ${o.beo.extras.map((x) => esc(x.description)).join(', ')}</div>` : ''}
            <div class="muted small">Client ${esc(o.beo.client)}${o.beo.owner ? ` · sales ${esc(o.beo.owner)}` : ''} · sent by ${esc(o.by)} ${esc(new Date(o.issuedAt).toLocaleString('en-IN'))}</div></div>
          <div class="rc-right">${ack ? tonePill(`Read by ${ack.by}`, '--st-vacant') : `<button type="button" class="btn small primary" data-back="${esc(o.eventId)}|${o.revision}">Acknowledge</button>`}</div></div>`
      }).join('') || '<p class="empty">No event orders for the days ahead.</p>'}`
  }

  async click(el: HTMLElement) {
    const d = el.closest<HTMLElement>('[data-bdept]')?.dataset.bdept
    if (d) { this.dept = d; return true }
    const a = el.closest<HTMLElement>('[data-back]')?.dataset.back
    if (a) {
      const [id, rev] = a.split('|')
      await this.h.api.post(`/api/banquets/events/${id}/beo/${rev}/ack`, { dept: this.dept })
      await this.load(); return true
    }
    return false
  }
}
