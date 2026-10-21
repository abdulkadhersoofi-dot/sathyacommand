import qrcode from 'qrcode-generator'
import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { esc, toast, tonePill, showDate } from '../ui/dom'
import { val } from '../ui/form-modal'
import { Workspace, type View, type WorkspaceHost } from '../ui/workspace'
import { money } from '../acc/books'

// Guests: requests from the QR in each room, the messages each guest is due (sent from the desk's own
// WhatsApp until a provider is set up), feedback with replies, activities and their bookings, and the QR
// card for every room.

type Tab = 'requests' | 'messages' | 'feedback' | 'activities' | 'qr'
const KIND: Record<string, string> = { housekeeping: 'Housekeeping', food: 'Room service', maintenance: 'Fault', other: 'Request' }
const TEMPLATE: Record<string, string> = { confirmation: 'Booking confirmed', pre_arrival: 'Day before arrival', welcome: 'Welcome, room page', feedback: 'After the stay' }
const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60_000); return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago` }
const stars = (n: number | null) => (n ? `${'★'.repeat(n)}${'☆'.repeat(5 - n)}` : '—')

class RequestsView implements View {
  private rows: { id: string; kind: string; items: { name: string; qty: number; price_paise?: number }[]; note: string | null; status: string; created_at: string; room_no: string; guest: string | null; handled_by: string | null; ticket_id: string | null }[] = []
  constructor(private h: WorkspaceHost) {}
  async load() { this.rows = await this.h.cached('/api/guest/requests') }
  tick() { void this.load().then(() => this.h.render()) }
  html() {
    return `<p class="muted small">From the QR card in each room. Faults also go to engineering as a ticket. This list refreshes by itself.</p>
      ${this.rows.map((r) => `<div class="row-card ${['done', 'cancelled'].includes(r.status) ? 'retired' : ''}"><div class="rc-title">Room ${esc(r.room_no)} · ${esc(KIND[r.kind] ?? r.kind)}</div>
        <div class="rc-sub">${esc(r.items.map((i) => `${i.name}${i.qty > 1 ? ` × ${i.qty}` : ''}`).join(', '))}${r.note ? `${r.items.length ? ' · ' : ''}<i>${esc(r.note)}</i>` : ''} · ${esc(r.guest ?? '')} · ${esc(ago(r.created_at))}${r.handled_by ? ` · ${esc(r.handled_by)}` : ''}</div>
        <div class="rc-right">${r.status === 'new' ? `${tonePill('New', '--st-departing')}<button type="button" class="btn small primary" data-rq="${esc(r.id)}|accept">On it</button>` : r.status === 'accepted' ? `<button type="button" class="btn small primary" data-rq="${esc(r.id)}|done">Done</button>` : tonePill(r.status === 'done' ? 'Done' : 'Cancelled', '--muted')}
          ${['new', 'accepted'].includes(r.status) ? `<button type="button" class="btn small ghost" data-rq="${esc(r.id)}|cancel">Cancel</button>` : ''}</div></div>`).join('') || '<p class="empty">No requests from rooms.</p>'}`
  }
  async click(el: HTMLElement) {
    const a = el.closest<HTMLElement>('[data-rq]')?.dataset.rq
    if (!a) return false
    const [id, step] = a.split('|')
    await this.h.api.post(`/api/guest/requests/${id}/${step}`)
    await this.load(); return true
  }
}

class MessagesView implements View {
  private d: { provider: string | null; messages: { id: string; template: string; body: string; mobile: string; status: string; due_at: string; sent_at: string | null; guest: string | null; sent_by: string | null; error: string | null }[] } = { provider: null, messages: [] }
  constructor(private h: WorkspaceHost) {}
  async load() { this.d = await this.h.cached('/api/guest/messages') }
  html() {
    return `<p class="muted small">${this.d.provider ? `Sent by ${esc(this.d.provider)} as they fall due.` : 'No WhatsApp provider is set up yet: open each message in WhatsApp with one tap, send it from the desk\'s phone, then mark it sent.'}</p>
      ${this.d.messages.map((m) => `<div class="row-card ${m.status === 'queued' ? '' : 'retired'}"><div class="rc-title">${esc(m.guest ?? m.mobile)} · ${esc(TEMPLATE[m.template] ?? m.template)}</div>
        <div class="rc-sub">${esc(m.body)}${m.error ? ` <b class="fd-warn">${esc(m.error)}</b>` : ''}</div>
        <div class="rc-right">${m.status === 'queued' || m.status === 'failed' ? `<a class="btn small primary" href="https://wa.me/${esc(m.mobile.replace(/\D/g, ''))}?text=${encodeURIComponent(m.body)}" target="_blank" rel="noopener">Open in WhatsApp</a>
          <button type="button" class="btn small" data-msg="${esc(m.id)}|sent">Mark sent</button><button type="button" class="btn small ghost" data-msg="${esc(m.id)}|skip">Skip</button>` : tonePill(m.status === 'sent' ? `Sent${m.sent_by ? ` by ${m.sent_by}` : ''}` : m.status, '--muted')}</div></div>`).join('') || '<p class="empty">No messages due.</p>'}`
  }
  async click(el: HTMLElement) {
    const a = el.closest<HTMLElement>('[data-msg]')?.dataset.msg
    if (!a) return false
    const [id, step] = a.split('|')
    await this.h.api.post(`/api/guest/messages/${id}/${step}`)
    await this.load(); return true
  }
}

class FeedbackView implements View {
  private d: { feedback: { id: string; overall: number; room: number | null; food: number | null; service: number | null; cleanliness: number | null; comment: string | null; created_at: string; reply: string | null; replied_by: string | null; guest: string | null; room_no: string | null }[]; averages: Record<string, number | null>; count: number; low: number } = { feedback: [], averages: {}, count: 0, low: 0 }
  constructor(private h: WorkspaceHost) {}
  async load() { this.d = await this.h.cached('/api/guest/feedback') }
  html() {
    const a = this.d.averages
    return `<div class="row-card mc-card"><div class="mc-figs">${[['overall', 'Overall'], ['room', 'Room'], ['cleanliness', 'Cleanliness'], ['food', 'Food'], ['service', 'Service']].map(([k, l]) => `<span><small>${l}</small><b class="mono">${a[k] ?? '—'}</b></span>`).join('')}
        <span><small>Poor (1–2)</small><b class="mono ${this.d.low ? 'fd-warn' : ''}">${this.d.low} of ${this.d.count}</b></span></div></div>
      ${this.d.feedback.map((f) => `<div class="row-card"><div class="rc-title">${stars(f.overall)} ${esc(f.guest ?? 'Guest')}${f.room_no ? ` · room ${esc(f.room_no)}` : ''}</div>
        <div class="rc-sub">${f.comment ? `“${esc(f.comment)}”` : '<span class="muted">No comment</span>'} · room ${stars(f.room)} · clean ${stars(f.cleanliness)} · food ${stars(f.food)} · service ${stars(f.service)}
          ${f.reply ? `<div><b>Reply</b> (${esc(f.replied_by ?? '')}): ${esc(f.reply)}</div>` : ''}</div>
        <div class="rc-right">${f.overall <= 2 && !f.reply ? tonePill('Needs a reply', '--st-departing') : ''}${!f.reply && this.h.can('feedback.manage') ? `<button type="button" class="btn small" data-fbr="${esc(f.id)}">Reply…</button>` : ''}</div></div>`).join('') || '<p class="empty">No feedback yet.</p>'}`
  }
  async click(el: HTMLElement) {
    const id = el.closest<HTMLElement>('[data-fbr]')?.dataset.fbr
    if (!id) return false
    const f = this.d.feedback.find((x) => x.id === id)!
    const draft = f.overall <= 2
      ? `Dear ${f.guest?.split(' ')[0] ?? 'guest'}, thank you for telling us, and we are sorry your stay fell short${f.comment ? '' : ''}. We have looked into it with the team and put it right. We would be glad to welcome you back and show you the resort at its best.`
      : `Dear ${f.guest?.split(' ')[0] ?? 'guest'}, thank you for staying with us and for your kind words. We look forward to welcoming you again.`
    this.h.modal.open('Reply to the guest', `<p class="small">${stars(f.overall)} ${f.comment ? `“${esc(f.comment)}”` : ''}</p><div class="form-grid"><label class="span2">Reply<textarea name="reply" rows="5" maxlength="2000">${esc(draft)}</textarea></label></div>
      <p class="muted small">The reply is kept here; send it to the guest on WhatsApp or by email.</p>`, 'Save reply', async (form) => {
      await this.h.api.post(`/api/guest/feedback/${id}/reply`, { reply: val(form, 'reply') }); await this.load(); this.h.render(); return 'Reply saved'
    })
    return false
  }
}

class ActivitiesView implements View {
  private day = ''
  private d: { day: string; activities: { id: string; name: string; price_paise: number; per: string; capacity: number | null; opens: string | null; closes: string | null; active: boolean; place_name: string | null; notes: string | null }[]
    bookings: { id: string; activity: string; guest_name: string; at: string; qty: number; amount_paise: number; room_no: string | null; on_bill: boolean }[]; inHouse: { id: string; guest: string; room_no: string | null }[] } | null = null
  constructor(private h: WorkspaceHost) {}
  async load() { this.d = await this.h.cached(`/api/guest/activities${this.day ? `?day=${this.day}` : ''}`); this.day = this.d!.day }
  html() {
    const d = this.d!, manage = this.h.can('activities.manage')
    return `<div class="ws-toolbar"><label class="inline">Day <input type="date" data-actday value="${esc(d.day)}"></label>${manage ? '<button type="button" class="btn" data-act="new">Add an activity</button>' : ''}</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Activity</th><th>Where</th><th>Hours</th><th class="n">Price</th><th class="n">Slots</th><th></th></tr></thead><tbody>
        ${d.activities.filter((a) => a.active).map((a) => `<tr><td><b>${esc(a.name)}</b>${a.notes ? ` <small class="muted">${esc(a.notes)}</small>` : ''}</td><td>${esc(a.place_name ?? '')}</td><td>${esc(a.opens ?? '')}${a.closes ? `–${esc(a.closes)}` : ''}</td>
          <td class="n">${a.price_paise ? `${money(a.price_paise)} / ${esc(a.per)}` : 'free'}</td><td class="n">${a.capacity ?? '—'}</td><td><button type="button" class="btn small primary" data-actbook="${esc(a.id)}">Book</button></td></tr>`).join('')}
      </tbody></table></div>
      <div class="sec-title">Booked for ${esc(showDate(d.day))} <span>${d.bookings.length}</span></div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Time</th><th>Activity</th><th>Guest</th><th class="n">How many</th><th class="n">Amount</th></tr></thead><tbody>
        ${d.bookings.map((b) => `<tr><td class="mono">${esc(b.at)}</td><td>${esc(b.activity)}</td><td>${esc(b.guest_name)}${b.room_no ? ` · room ${esc(b.room_no)}` : ''}</td><td class="n">${b.qty}</td><td class="n">${money(b.amount_paise)}${b.on_bill ? ' <small class="muted">on bill</small>' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing booked.</td></tr>'}
      </tbody></table></div>`
  }
  async change(el: HTMLElement) { if (!el.matches('[data-actday]')) return false; this.day = (el as HTMLInputElement).value; await this.load(); return true }
  async click(el: HTMLElement) {
    const d = this.d!
    const id = el.closest<HTMLElement>('[data-actbook]')?.dataset.actbook
    if (id) {
      const a = d.activities.find((x) => x.id === id)!
      this.h.modal.open(`Book: ${a.name}`, `<div class="form-grid"><label class="span2">Guest<select name="res"><option value="">Not staying (pays on the spot)</option>${d.inHouse.map((r) => `<option value="${esc(r.id)}">${r.room_no ? `Room ${esc(r.room_no)} · ` : ''}${esc(r.guest)}</option>`).join('')}</select></label>
          <label class="span2">Name (if not staying)<input name="name" maxlength="120"></label><label>Time<input name="at" type="time" value="${esc(a.opens ?? '10:00')}"></label><label>${a.per === 'hour' ? 'Hours' : a.per === 'person' ? 'People' : 'Sessions'}<input name="qty" type="number" min="1" value="1"></label></div>
          <p class="muted small">${a.price_paise ? `${money(a.price_paise)} per ${esc(a.per)} before GST; a staying guest's goes on the room bill.` : 'Free.'}</p>`, 'Book', async (f) => {
        const r = await this.h.api.post<{ chargedPaise: number }>(`/api/guest/activities/${id}/book`, { reservationId: val(f, 'res') || undefined, guestName: val(f, 'name') || undefined, day: d.day, at: val(f, 'at'), qty: Number(val(f, 'qty')) })
        await this.load(); this.h.render(); return r.chargedPaise ? `Booked: ${money(r.chargedPaise)} on the room bill` : 'Booked'
      })
    }
    if (el.closest('[data-act=new]')) this.h.modal.open('Add an activity', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="80"></label>
        <label>Price (₹, 0 if free)<input name="price" type="number" min="0" value="0"></label><label>Per<select name="per"><option value="person">Person</option><option value="hour">Hour</option><option value="session">Session</option></select></label>
        <label>Opens<input name="opens" type="time"></label><label>Closes<input name="closes" type="time"></label><label>Slots at a time<input name="cap" type="number" min="1"></label><label class="span2">Notes<input name="notes" maxlength="300"></label></div>`, 'Add', async (f) => {
      await this.h.api.post('/api/guest/activities', { name: val(f, 'name'), price: Number(val(f, 'price')), per: val(f, 'per'), opens: val(f, 'opens') || undefined, closes: val(f, 'closes') || undefined, capacity: val(f, 'cap') ? Number(val(f, 'cap')) : undefined, notes: val(f, 'notes') })
      await this.load(); this.h.render(); return 'Added'
    })
    return false
  }
}

class QrView implements View {
  private rooms: { id: string; room_no: string; building: string | null; url: string }[] = []
  constructor(private h: WorkspaceHost) {}
  async load() { this.rooms = await this.h.cached('/api/guest/room-qr') }
  html() {
    return `<div class="ws-toolbar"><button type="button" class="btn primary" data-qrprint>Print all cards</button><span class="muted small">One card per room: guests scan it for housekeeping, room service, faults, things to do and feedback. Only the guest staying in the room can send requests.</span></div>
      <div class="qr-cards">${this.rooms.map((r) => { const q = qrcode(0, 'M'); q.addData(r.url); q.make()
        return `<div class="qr-card"><div class="qr-svg">${q.createSvgTag({ cellSize: 3, margin: 2, scalable: true })}</div><b>Room ${esc(r.room_no)}</b><small>Scan for room service, housekeeping and help</small></div>` }).join('')}</div>`
  }
  async click(el: HTMLElement) {
    if (!el.closest('[data-qrprint]')) return false
    const w = window.open('', '_blank')
    if (!w) { toast('Allow pop-ups to print the cards.'); return false }
    w.document.write(`<!doctype html><title>Room QR cards</title><style>body{font:14px system-ui;margin:0}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:0}.c{border:1px dashed #999;padding:18px;text-align:center;page-break-inside:avoid}.c svg{width:150px;height:150px}b{display:block;font-size:20px;margin-top:6px}</style>
      <div class="g">${document.querySelector('.qr-cards')!.innerHTML.replace(/class="qr-card"/g, 'class="c"')}</div><script>print()</script>`)
    w.document.close()
    return false
  }
}

export class GuestsWorkspace extends Workspace<Tab> {
  protected views: Record<Tab, View>
  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Guests', onClose)
    this.views = { requests: new RequestsView(this), messages: new MessagesView(this), feedback: new FeedbackView(this), activities: new ActivitiesView(this), qr: new QrView(this) }
    this.tab = this.tabs()[0][0]
  }
  static allowed(me: Me) { return ['*', 'guest.requests', 'front_desk', 'feedback.manage', 'activities.manage'].some((p) => me.permissions.includes(p)) }
  tabs(): [Tab, string][] {
    const t: [Tab, string][] = [['requests', 'Requests from rooms']]
    if (this.can('front_desk', 'guest.requests')) t.push(['messages', 'Messages'])
    if (this.can('feedback.manage', 'front_desk')) t.push(['feedback', 'Feedback'])
    if (this.can('front_desk', 'activities.manage')) t.push(['activities', 'Activities'])
    t.push(['qr', 'Room QR cards'])
    return t
  }
}
