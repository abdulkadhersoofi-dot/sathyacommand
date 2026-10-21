import { esc, toast, tonePill, showDate } from '../ui/dom'
import { val } from '../ui/form-modal'
import { money } from '../acc/books'
import type { BqHost } from './workspace'

// Room blocks: rooms held for a wedding or a group at an agreed rate, kept off general sale until the
// cut-off. Guests are booked into the block one by one or from a pasted rooming list; at the cut-off, rooms
// not picked up go back on sale by themselves.

interface Line { roomTypeId: string; name: string; rooms: number; ratePaise: number; nights: { night: string; picked: number }[] }
interface Block { id: string; number: string; name: string; event_id: string | null; event: string | null; debtor_id: string | null; account: string | null; arrival: string; departure: string; cutoff: string; plan_code: string; status: string
  nights: string[]; lines: Line[]; roomNights: { allotted: number; picked: number; held: number }; stayCount?: number
  stays?: { id: string; guest: string; mobile: string | null; room_type_id: string; arrival: string; departure: string; status: string; room_no: string | null }[] }

const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })

export class BlocksView {
  selected: string | null = null
  private list: Block[] = []
  private d: Block | null = null
  private today = ''
  constructor(private h: BqHost) {}

  async load() {
    if (this.selected) this.d = await this.h.cached(`/api/sales/blocks/${this.selected}`)
    else { const r = await this.h.cached<{ today: string; blocks: Block[] }>('/api/sales/blocks'); this.list = r.blocks; this.today = r.today }
  }
  private async reload() { await this.load(); this.h.render() }

  private statusPill(b: Block) {
    return b.status === 'open' ? tonePill(`Held to ${b.cutoff}`, b.cutoff <= (this.today || b.cutoff) ? '--marigold' : '--st-vacant') : tonePill(b.status === 'released' ? 'Released' : 'Cancelled', '--muted')
  }

  html() {
    if (this.selected && this.d) return this.detail(this.d)
    return `<div class="ws-toolbar">${this.h.can('sales.manage') ? '<button type="button" class="btn primary" data-bk="new">New room block</button>' : ''}</div>
      <p class="muted small">Rooms in a block are kept off general sale until the cut-off; at the cut-off, rooms not picked up go back on sale by themselves.</p>
      ${this.list.map((b) => `<div class="row-card"><div class="rc-title"><span class="mono muted">${esc(b.number)}</span> <button type="button" class="linkish" data-bkopen="${esc(b.id)}">${esc(b.name)}</button></div>
        <div class="rc-sub">${day(b.arrival)} to ${day(b.departure)} · ${b.lines.map((l) => `${l.rooms} ${esc(l.name)} at ${money(l.ratePaise)}`).join(', ')}${b.event ? ` · for ${esc(b.event)}` : ''}${b.account ? ` · ${esc(b.account)}` : ''}</div>
        <div class="rc-right">${this.statusPill(b)}<small class="mono">${b.roomNights.picked} of ${b.roomNights.allotted} room nights booked</small></div></div>`).join('') || '<p class="empty">No room blocks.</p>'}`
  }

  private detail(b: Block) {
    const open = b.status === 'open', manage = this.h.can('sales.manage'), pick = this.h.can('sales.manage', 'front_desk')
    return `<div class="ws-toolbar"><button type="button" class="btn ghost" data-bk="back">← All blocks</button>
        ${open && pick ? '<button type="button" class="btn primary" data-bk="list">Rooming list</button><button type="button" class="btn" data-bk="book">Book a guest</button>' : ''}
        ${open && manage ? '<button type="button" class="btn" data-bk="rooms">Change rooms held</button><button type="button" class="btn ghost" data-bk="release">Release the rest now</button>' : ''}</div>
      <div class="bq-head"><div><div class="muted mono small">${esc(b.number)} · ${esc(b.plan_code)}</div><h2>${esc(b.name)}</h2>
        <div class="small">${day(b.arrival)} to ${day(b.departure)}${b.event ? ` · for <button type="button" class="linkish" data-ev2="${esc(b.event_id!)}">${esc(b.event)}</button>` : ''}${b.account ? ` · ${esc(b.account)}` : ''} · cut-off ${esc(b.cutoff)}</div></div>
        <div class="rc-right">${this.statusPill(b)}</div></div>
      <div class="sec-title">Rooms booked of those held, night by night</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Room</th><th class="n">Rate</th>${b.nights.map((n) => `<th class="n">${day(n)}</th>`).join('')}</tr></thead><tbody>
        ${b.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="n">${money(l.ratePaise)}</td>${l.nights.map((x) => `<td class="n ${x.picked >= l.rooms ? '' : 'muted'}">${x.picked} / ${l.rooms}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>
      <div class="sec-title">Guests <span class="mono">${b.stays?.length ?? 0}</span></div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Guest</th><th>Mobile</th><th>Room</th><th>Arrival</th><th>Departure</th><th>Status</th></tr></thead><tbody>
        ${(b.stays ?? []).map((s) => `<tr><td>${esc(s.guest)}</td><td>${esc(s.mobile ?? '')}</td><td>${esc(s.room_no ?? s.room_type_id)}</td><td>${esc(s.arrival)}</td><td>${esc(s.departure)}</td><td>${esc(s.status.replace('_', ' '))}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nobody booked in the block yet.</td></tr>'}
      </tbody></table></div>`
  }

  /** A new block, for an event or an account if one is given. */
  async create(eventId?: string, eventTitle?: string) {
    const types = (await this.h.api.get<{ id: string; name: string; active: boolean; base_rate_paise: number }[]>('/api/room-types')).filter((t) => t.active)
    const accounts = (await this.h.api.get<{ accounts: { id: string; name: string; active: boolean }[] }>('/api/sales/accounts').catch(() => ({ accounts: [] }))).accounts.filter((a) => a.active)
    this.h.modal.open('New room block', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="120" value="${esc(eventTitle ? `${eventTitle}: guests` : '')}"></label>
        <label>Arrival<input name="arr" type="date"></label><label>Departure<input name="dep" type="date"></label>
        <label>Cut-off (blank: 14 days before)<input name="cut" type="date"></label><label>Meal plan<select name="plan">${['EP', 'CP', 'MAP', 'AP'].map((p) => `<option ${p === 'CP' ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        ${eventId ? '' : `<label class="span2">Company account (optional)<select name="acc"><option value="">—</option>${accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></label>`}
        ${types.map((t) => `<label>${esc(t.name)}: rooms<input name="n:${esc(t.id)}" type="number" min="0" value="0"></label><label>${esc(t.name)}: rate (₹/night)<input name="r:${esc(t.id)}" type="number" min="1" value="${t.base_rate_paise / 100}"></label>`).join('')}</div>`, 'Hold rooms', async (f) => {
      const lines = types.filter((t) => Number(val(f, `n:${t.id}`)) > 0).map((t) => ({ roomTypeId: t.id, rooms: Number(val(f, `n:${t.id}`)), rate: Number(val(f, `r:${t.id}`)) }))
      const r = await this.h.api.post<{ id: string; number: string; cutoff: string }>('/api/sales/blocks', { name: val(f, 'name'), arrival: val(f, 'arr'), departure: val(f, 'dep'), cutoff: val(f, 'cut') || undefined, plan: val(f, 'plan'),
        eventId, debtorId: val(f, 'acc') || undefined, lines })
      this.selected = r.id
      await this.reload()
      return `${r.number}: rooms held until ${showDate(r.cutoff)}`
    })
  }

  async click(el: HTMLElement) {
    const api = this.h.api
    const open = el.closest<HTMLElement>('[data-bkopen]')?.dataset.bkopen
    if (open) { this.selected = open; await this.load(); return true }
    const ev = el.closest<HTMLElement>('[data-ev2]')?.dataset.ev2
    if (ev) { this.h.openEvent(ev); return false }
    const a = el.closest<HTMLElement>('[data-bk]')?.dataset.bk
    if (a === 'back') { this.selected = null; this.d = null; await this.load(); return true }
    if (a === 'new') await this.create()
    const b = this.d
    if (!b) return false
    const base = `/api/sales/blocks/${b.id}`
    if (a === 'list') this.h.modal.open('Rooming list', `<p class="small">One guest per line: <b>name, mobile, room type, arrival, departure, adults, requests</b>. Leave the dates blank for the block's; the room type can be left out when the block has one. Paste from a spreadsheet saved as CSV.</p>
        <div class="form-grid"><label class="span2">Guests<textarea name="csv" rows="8" placeholder="Uncle Raman, 98400 33333, Deluxe Room, , , 2, Ground floor"></textarea></label></div>`, 'Book them', async (f) => {
      const r = await api.post<{ booked: { name: string }[]; errors: { line: number; name: string; error: string }[] }>(`${base}/rooming-list`, { csv: val(f, 'csv') })
      await this.reload()
      if (r.errors.length) {
        this.h.modal.open('Rooming list', `<p>${r.booked.length} booked. ${r.errors.length} not booked:</p><div class="m-table">${r.errors.map((e) => `<div class="m-row bq-ins"><b>Line ${e.line}: ${esc(e.name)}</b><span>${esc(e.error)}</span></div>`).join('')}</div>`, 'Done', async () => '')
        return undefined
      }
      return `${r.booked.length} guests booked`
    })
    if (a === 'book') this.h.modal.open('Book a guest in the block', `<div class="form-grid"><label class="span2">Guest name<input name="name"></label><label>Mobile<input name="mobile" inputmode="tel"></label>
        <label>Room<select name="type">${b.lines.map((l) => `<option value="${esc(l.roomTypeId)}">${esc(l.name)}</option>`).join('')}</select></label>
        <label>Arrival<input name="arr" type="date" value="${esc(b.arrival)}" min="${esc(b.arrival)}" max="${esc(b.departure)}"></label><label>Departure<input name="dep" type="date" value="${esc(b.departure)}" min="${esc(b.arrival)}" max="${esc(b.departure)}"></label>
        <label>Adults<input name="adults" type="number" min="1" value="2"></label></div>`, 'Book', async (f) => {
      await api.post(`${base}/book`, { name: val(f, 'name'), mobile: val(f, 'mobile'), roomTypeId: val(f, 'type'), arrival: val(f, 'arr'), departure: val(f, 'dep'), adults: Number(val(f, 'adults')) })
      await this.reload(); return 'Booked'
    })
    if (a === 'rooms') this.h.modal.open('Rooms held', `<p class="small muted">Never fewer than are already booked; more only if they are free.</p><div class="form-grid">${b.lines.map((l) => `<label>${esc(l.name)}<input name="n:${esc(l.roomTypeId)}" type="number" min="0" value="${l.rooms}"></label>`).join('')}</div>`, 'Save', async (f) => {
      await api.req('PUT', `${base}/lines`, { lines: b.lines.map((l) => ({ roomTypeId: l.roomTypeId, rooms: Number(val(f, `n:${l.roomTypeId}`)) })) })
      await this.reload(); return 'Saved'
    })
    if (a === 'release') { await api.post(`${base}/release`); toast('Rooms not booked are back on sale'); await this.load(); return true }
    return false
  }
}
