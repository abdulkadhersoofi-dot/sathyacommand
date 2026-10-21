import type { Store } from '../data/store'
import type { Reservation } from '../data/types'
import { fmtDay, fmtTime, inr, setToday, todayKey } from '../data/dates'
import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import { esc, showDate, statusPill, toast, tonePill } from './dom'
import { checked, FormModal, val } from './form-modal'

/** Where a booking came from; an OTA booking needs the OTA's booking ID to match its payout. */
const SOURCES: Record<string, string> = { direct: 'Direct', phone: 'Phone', walk_in: 'Walk-in', website: 'Website', travel_agent: 'Travel agent', corporate: 'Corporate', booking_com: 'Booking.com', makemytrip: 'MakeMyTrip', goibibo: 'Goibibo', agoda: 'Agoda', expedia: 'Expedia', airbnb: 'Airbnb', cleartrip: 'Cleartrip', yatra: 'Yatra', easemytrip: 'EaseMyTrip' }

// Front desk on the live HMS: the desk panel plus forms for booking, check-in, payment,
// check-out (with the tax invoice), cashier shift and closing the day.

interface RoomType { id: string; name: string; base_rate_paise: number; max_occupancy: number; active: boolean; rooms: number }
interface Room { id: string; room_no: string; kind: string; room_type_id: string; room_type: string; building: string | null; floor: number | null; hk_status: string | null }
/** One booking as the server holds it (GET /api/reservations/:id). Money in paise. */
interface Detail {
  id: string; status: 'confirmed' | 'in_house' | 'checked_out' | 'cancelled' | 'no_show'; arrival: string; departure: string; adults: number; children: number
  room_type_id: string; room_type: string; space_id: string | null; room_no: string | null; rate_plan_code: string; source: string; ota_ref: string | null
  eta: string | null; requests: string | null; cancel_reason: string | null; bill_to_company: string | null
  guest: { name: string; mobile: string | null; email: string | null; nationality: string; vip: boolean }
  nights: { night: string; amount_paise: number; extras_paise: number; released: boolean; posted_line_id: string | null }[]
  folios: { id: string; bill_to: string; status: string }[]
  lines: { id: string; kind: string; description: string; amount_paise: number; business_date: string; reverses: string | null; ref: string | null }[]
  balance: number
  documents: { id: string; doc_type: string; number: string; issue_date: string; total_paise: number }[]
}
interface Found { id: string; status: string; guest: string; mobile: string | null; room_no: string | null; arrival: string; departure: string; source: string; ota_ref: string | null }

const PLANS: Record<string, string> = { EP: 'Room only', CP: 'With breakfast', MAP: 'Breakfast + 1 meal', AP: 'All meals' }
const STATUS_NAMES: Record<string, string> = { confirmed: 'Confirmed', in_house: 'Checked in', checked_out: 'Checked out', cancelled: 'Cancelled', no_show: 'No-show' }
const DOC_NAMES: Record<string, string> = { invoice: 'Tax invoice', credit_note: 'Credit note', receipt_voucher: 'Advance receipt', refund_voucher: 'Refund voucher' }
const READY = new Set(['inspected', 'vacant_clean'])
/** Room nights not charged yet, with GST at the slab for each night (5% up to ₹7,500, 18% above). */
const toCharge = (d: Detail, onlyFirst = false) => {
  const left = d.nights.filter((n) => !n.released && !n.posted_line_id)
  return (onlyFirst ? left.slice(0, 1) : left).reduce((a, n) => {
    const v = Number(n.amount_paise) + Number(n.extras_paise)
    return a + Math.round(v * (Number(n.amount_paise) > 750000 ? 1.18 : 1.05))
  }, 0)
}
interface Cashier { open: boolean; cashTaken?: number; expectedInDrawer?: number }

const can = (me: Me, p: string) => me.permissions.includes('*') || me.permissions.includes(p)
const rs = (p: number) => inr(Math.round(p / 100))

/** 1st, 2nd, 3rd, 4th… */
const ordinal = (n: number) => { const v = n % 100; return `${n}${['th', 'st', 'nd', 'rd'][(v - 20) % 10] ?? ['th', 'st', 'nd', 'rd'][v] ?? 'th'}` }

export class FrontDesk {
  cashier: Cashier = { open: false }
  private modal = new FormModal()

  constructor(private api: Api, private store: Store, public me: Me, private rerender: () => void) {
    void this.refreshCashier()
  }

  async refreshCashier() {
    try { this.cashier = await this.api.get<Cashier>('/api/cashier/current') } catch { this.cashier = { open: false } }
    this.rerender()
  }

  // ---------- desk panel ----------
  html(): string {
    const s = this.store
    const today = todayKey()
    const res = s.reservations
    const arrivals = res.filter((r) => r.arrival === today && r.status !== 'cancelled').sort((a, b) => (a.eta ?? '').localeCompare(b.eta ?? ''))
    const inHouse = res.filter((r) => r.status === 'in-house')
    const departures = inHouse.filter((r) => r.departure <= today)
    const c = this.cashier
    const desk = can(this.me, 'front_desk')
    const toolbar = `<div class="fd-toolbar">
      ${desk ? '<button class="btn primary" data-fd="book" type="button">New booking</button>' : ''}
      ${desk ? '<button class="btn" data-fd="find" type="button">Find a booking</button>' : ''}
      ${c.open ? `<button class="btn" data-fd="close-shift" type="button">Close shift · ${rs(c.expectedInDrawer ?? 0)} in drawer</button>` : `<button class="btn" data-fd="open-shift" type="button">Open cashier shift</button>`}
      ${can(this.me, 'night_audit') ? '<button class="btn" data-fd="night-audit" type="button">Close the day</button>' : ''}
    </div>
    <div class="fd-date">Business date <b>${fmtDay(today)}</b></div>`
    const card = (r: Reservation, actions: string) => `<div class="row-card" ${r.spaceId ? `data-focus="${esc(r.spaceId)}"` : ''}>
      <div class="rc-title">${r.vip ? '<span class="vip">VIP</span> ' : ''}${esc(r.guest)}</div>
      <div class="rc-sub">${r.roomNo ? `Room ${esc(r.roomNo)}` : 'No room yet'} · ${r.pax} pax${r.company ? ` · ${esc(r.company)}` : ''}${r.balance ? ` · <b>due ${rs(r.balance * 100)}</b>` : ''}
        ${r.pastStays ? ` · <span class="fd-tag ok">Returning guest · ${ordinal(r.pastStays + 1)} stay</span>` : ''}${r.onlineCheckin ? ' · <span class="fd-tag ok">Checked in online</span>' : ''}${r.payBy ? ` · <span class="fd-tag warn">Deposit due by ${new Date(r.payBy).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>` : ''}${r.otaRef ? ` · <span class="fd-tag">${esc(SOURCES[r.source] ?? r.source)} ${esc(r.otaRef)}</span>` : ''}</div>
      <div class="rc-right">${actions}${desk ? `<button class="btn small ghost" data-fd="open" data-res="${esc(r.id)}" type="button">Open</button>` : ''}</div></div>`
    const btn = (act: string, id: string, label: string, primary = false) => desk ? `<button class="btn small${primary ? ' primary' : ''}" data-fd="${act}" data-res="${esc(id)}" type="button">${label}</button>` : ''
    return toolbar + `
      <div class="sec-title">Arrivals <span>${arrivals.length}</span></div>
      ${arrivals.length ? arrivals.map((r) => card(r, r.status === 'confirmed'
        ? `${statusPill('arriving')}<span class="mono">ETA ${r.eta ?? '—'}</span>${btn('checkin', r.id, 'Check in', true)}`
        : r.status === 'checked-out' ? `${tonePill('Checked out', '--st-ooo')}<span class="mono">${fmtTime(r.checkOutAt)}</span>`
        : `${statusPill('occupied').replace('In-house', 'Checked in')}<span class="mono">${fmtTime(r.checkInAt)}</span>`)).join('') : '<div class="empty">No arrivals today.</div>'}
      <div class="sec-title">Due out <span>${departures.length}</span></div>
      ${departures.length ? departures.map((r) => card(r, `${statusPill('departing')}${btn('pay', r.id, 'Payment')}${btn('checkout', r.id, 'Check out', true)}`)).join('') : '<div class="empty">No departures due.</div>'}
      <div class="sec-title">In-house <span>${inHouse.length}</span></div>
      ${inHouse.length ? inHouse.filter((r) => r.departure > today).map((r) => card(r, `<span class="mono">until ${fmtDay(r.departure, { day: 'numeric', month: 'short' })}</span>${btn('pay', r.id, 'Payment')}${btn('checkout', r.id, 'Check out')}`)).join('') : '<div class="empty">Nobody in-house.</div>'}`
  }

  /** Handles a click on any [data-fd] button. Returns true if it was ours. */
  handle(el: HTMLElement): boolean {
    const act = el.dataset.fd
    if (!act) return false
    const id = el.dataset.res ?? ''
    if (act === 'book') void this.newBooking()
    if (act === 'find') void this.findBooking()
    if (act === 'open') void this.openBooking(id)
    if (act === 'checkin') void this.checkIn(id)
    if (act === 'pay') void this.payment(id)
    if (act === 'checkout') void this.checkOut(id)
    if (act === 'open-shift') void this.openShift()
    if (act === 'close-shift') void this.closeShift()
    if (act === 'night-audit') void this.nightAudit()
    return true
  }

  // ---------- modal plumbing ----------
  private open(...a: Parameters<FormModal['open']>) { return this.modal.open(...a) }
  close() { this.modal.close() }
  private val = val
  private async after() { await this.store.reload(); await this.refreshCashier() }
  /** The booking from the loaded dates, or from the server when it is outside them (found by search). */
  private async find(id: string): Promise<Reservation> {
    const r = this.store.reservations.find((x) => x.id === id)
    if (r) return r
    const d = await this.detail(id)
    return {
      id: d.id, spaceId: '', guest: d.guest.name, phone: d.guest.mobile ?? '', pax: d.adults + d.children, arrival: d.arrival, departure: d.departure,
      status: d.status === 'in_house' ? 'in-house' : d.status === 'checked_out' ? 'checked-out' : d.status === 'confirmed' ? 'confirmed' : 'cancelled',
      source: d.source, rate: 0, balance: d.balance / 100, folioId: d.folios[0]?.id, roomNo: d.room_no, roomTypeId: d.room_type_id,
      serverSpaceId: d.space_id, company: d.bill_to_company,
    }
  }
  private detail(id: string) { return this.api.get<Detail>(`/api/reservations/${encodeURIComponent(id)}`) }

  // ---------- forms ----------
  async newBooking() {
    const types = (await this.api.get<RoomType[]>('/api/room-types')).filter((t) => t.active)
    // Company accounts with contracted rates (Phase 7); none when this login cannot read them.
    const accounts = (await this.api.get<{ accounts: { id: string; name: string; active: boolean; rates: number }[] }>('/api/sales/accounts').catch(() => ({ accounts: [] }))).accounts.filter((a) => a.active)
    const today = todayKey()
    const form = this.open('New booking', `
      <div class="form-grid">
        <label class="span2">Guest name<input name="name" required autocomplete="off"></label>
        <label>Mobile<input name="mobile" inputmode="tel"></label>
        <label>Nationality<select name="nationality"><option value="IN">Indian</option><option value="OTHER">Foreign national</option></select></label>
        <label class="span2" data-country hidden>Country code (e.g. GB, US, AE)<input name="country" maxlength="2"></label>
        <label>Room type<select name="roomTypeId">${types.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} · ${rs(t.base_rate_paise)}</option>`).join('')}</select></label>
        <label>Meal plan<select name="plan"><option value="EP">Room only (EP)</option><option value="CP">With breakfast (CP)</option><option value="MAP">Breakfast + 1 meal (MAP)</option><option value="AP">All meals (AP)</option></select></label>
        <label>Arrival<input name="arrival" type="date" value="${today}" min="${today}"></label>
        <label>Nights<input name="nights" type="number" min="1" max="60" value="1"></label>
        <label>Adults<input name="adults" type="number" min="1" value="2"></label>
        <label>Children<input name="children" type="number" min="0" value="0"></label>
        ${accounts.length ? `<label class="span2">Company account (its contracted rate, billed to it)<select name="debtor"><option value="">—</option>${accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.rates ? ' · contracted rate' : ''}</option>`).join('')}</select></label>` : ''}
        <label>Booked through<select name="source">${Object.entries(SOURCES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label data-ota hidden>OTA booking ID<input name="otaRef" maxlength="40" autocomplete="off"></label>
        <label>Expected arrival time<input name="eta" type="time"></label>
      </div>
      <details class="bq-more"><summary>Company bill (GST invoice to a company)</summary>
      <div class="form-grid">
        <label class="span2">Company name<input name="company" autocomplete="off"></label>
        <label>Company GSTIN<input name="gstin" maxlength="15" autocomplete="off"></label>
        <label>Company PIN code<input name="pin" maxlength="6" inputmode="numeric"></label>
        <label class="span2">Company address<input name="address"></label>
        <label>Company city<input name="city"></label>
      </div></details>
      <div class="fd-quote" aria-live="polite"></div>`, 'Book', async (f) => {
      const nights = Number(this.val(f, 'nights'))
      const arrival = this.val(f, 'arrival')
      const nationality = this.val(f, 'nationality') === 'OTHER' ? this.val(f, 'country').toUpperCase() : 'IN'
      if (nationality !== 'IN' && !/^[A-Z]{2}$/.test(nationality)) throw new Error('Enter the 2-letter country code for a foreign guest.')
      const r = await this.api.post<{ id: string; roomTotal: number }>('/api/reservations', {
        guest: { name: this.val(f, 'name'), mobile: this.val(f, 'mobile') || undefined, nationality },
        roomTypeId: this.val(f, 'roomTypeId'), plan: this.val(f, 'plan'), arrival, departure: addDaysLocal(arrival, nights),
        adults: Number(this.val(f, 'adults')), children: Number(this.val(f, 'children')), eta: this.val(f, 'eta') || undefined,
        billToCompany: this.val(f, 'company') || undefined, billToGstin: this.val(f, 'gstin').toUpperCase() || undefined,
        billToAddress: this.val(f, 'address') || undefined, billToCity: this.val(f, 'city') || undefined, billToPin: this.val(f, 'pin') || undefined,
        source: this.val(f, 'source'), otaRef: this.val(f, 'otaRef') || undefined, debtorId: this.val(f, 'debtor') || undefined,
      })
      await this.after()
      toast(`Booked ${r.id} · ${rs(r.roomTotal)} for the room before tax`)
      void this.openBooking(r.id)
      return undefined
    })
    const quote = form.querySelector<HTMLElement>('.fd-quote')!
    const country = form.querySelector<HTMLElement>('[data-country]')!
    const ota = form.querySelector<HTMLElement>('[data-ota]')!
    const update = async () => {
      country.hidden = this.val(form, 'nationality') !== 'OTHER'
      ota.hidden = !['booking_com', 'makemytrip', 'goibibo', 'agoda', 'expedia', 'airbnb', 'cleartrip', 'yatra', 'easemytrip', 'travel_agent'].includes(this.val(form, 'source'))
      try {
        const q = await this.api.post<{ lines: { rate: number }[]; taxable: number; cgst: number; sgst: number; total: number }>('/api/quote', {
          roomTypeId: this.val(form, 'roomTypeId'), plan: this.val(form, 'plan'), checkIn: this.val(form, 'arrival'), nights: Number(this.val(form, 'nights')),
        })
        const rates = [...new Set(q.lines.map((l) => l.rate))].join(' / ')
        quote.innerHTML = `Room ${rs(q.taxable)} + GST ${rates}% ${rs(q.cgst + q.sgst)} = <b>${rs(q.total)}</b>`
      } catch (e) { quote.textContent = (e as Error).message }
    }
    form.addEventListener('change', () => void update())
    void update()
  }

  // ---------- find and open a booking ----------
  async findBooking() {
    const form = this.open('Find a booking', `
      <label class="fd-search">Guest name, mobile, booking number, room or OTA ID<input name="q" type="search" autocomplete="off" placeholder="e.g. Kumar, 98400…, R-1A2B, 204"></label>
      <div class="fd-found" aria-live="polite"></div>`, 'Done', async () => '')
    const out = form.querySelector<HTMLElement>('.fd-found')!
    let timer = 0
    const run = async () => {
      const q = this.val(form, 'q')
      try {
        const rows = await this.api.get<Found[]>(q.length >= 2 ? `/api/reservations?q=${encodeURIComponent(q)}` : '/api/reservations?upcoming=true')
        out.innerHTML = `<div class="sec-title">${q.length >= 2 ? `Found <span>${rows.length}</span>` : `Coming up <span>${rows.length}</span>`}</div>
          ${rows.length ? rows.slice(0, 50).map((r) => `<button type="button" class="fd-hit" data-open="${esc(r.id)}">
            <b>${esc(r.guest)}</b> <span class="fd-tag">${esc(STATUS_NAMES[r.status] ?? r.status)}</span>
            <span class="muted small">${esc(showDate(r.arrival))} → ${esc(showDate(r.departure))}${r.room_no ? ` · Room ${esc(r.room_no)}` : ''} · ${esc(r.id)}${r.mobile ? ` · ${esc(r.mobile)}` : ''}</span></button>`).join('')
            : `<div class="empty">${q.length >= 2 ? 'No booking matches. Check the spelling, or search by mobile number.' : 'No bookings after today yet.'}</div>`}`
      } catch (e) { out.innerHTML = `<div class="empty">${esc((e as Error).message)}</div>` }
    }
    form.querySelector('input')!.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(() => void run(), 250) })
    out.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-open]'); if (b) void this.openBooking(b.dataset.open!) })
    void run()
  }

  /** The whole booking on one screen: the stay, the bill so far, receipts and invoices, and what can be done next. */
  async openBooking(id: string) {
    const d = await this.detail(id)
    const today = todayKey()
    const pending = toCharge(d)
    const charges = d.lines.filter((l) => l.amount_paise > 0 || l.kind === 'reversal').reduce((a, l) => a + Number(l.amount_paise), 0)
    const paid = d.lines.filter((l) => l.kind === 'payment' || l.kind === 'refund').reduce((a, l) => a - Number(l.amount_paise), 0)
    const nights = d.nights.filter((n) => !n.released || n.posted_line_id).length
    const reversed = new Set(d.lines.map((l) => l.reverses).filter(Boolean))
    const open = d.status === 'confirmed' || d.status === 'in_house'
    const act = (a: string, label: string, primary = false) => `<button type="button" class="btn small${primary ? ' primary' : ''}" data-bk="${a}">${label}</button>`
    const actions = d.status === 'confirmed'
      ? [d.arrival === today ? act('checkin', 'Check in', true) : '', act('pay', 'Take advance'), act('room', d.space_id ? 'Change room' : 'Assign room'), act('bed', 'Extra bed'), act('discount', 'Discount'), act('cancel', 'Cancel booking')]
      : d.status === 'in_house'
        ? [act('checkout', 'Check out', true), act('pay', 'Payment'), act('charge', 'Add a charge'), act('room', 'Move room'), act('bed', 'Extra bed'), act('discount', 'Discount')]
        : []
    const balanceLine = d.balance > 0 ? `<b class="fd-warn">Due now ${rs(d.balance)}</b>` : d.balance < 0 ? `<b>Paid in advance ${rs(-d.balance)}</b>` : 'Nothing due right now'
    const form = this.open(`${d.guest.vip ? 'VIP · ' : ''}${d.guest.name}`, `
      <p class="muted">${esc(d.id)} · ${esc(STATUS_NAMES[d.status] ?? d.status)}${d.guest.mobile ? ` · ${esc(d.guest.mobile)}` : ''}${d.cancel_reason ? ` · ${esc(d.cancel_reason)}` : ''}</p>
      <dl class="kv">
        <dt>Stay</dt><dd>${esc(showDate(d.arrival))} → ${esc(showDate(d.departure))} · ${nights} night${nights === 1 ? '' : 's'}</dd>
        <dt>Room</dt><dd>${d.room_no ? `Room ${esc(d.room_no)} · ` : 'Not assigned · '}${esc(d.room_type)} · ${esc(PLANS[d.rate_plan_code] ?? d.rate_plan_code)}</dd>
        <dt>Guests</dt><dd>${d.adults} adult${d.adults === 1 ? '' : 's'}${d.children ? `, ${d.children} child${d.children === 1 ? '' : 'ren'}` : ''}</dd>
        <dt>Booked through</dt><dd>${esc(SOURCES[d.source] ?? d.source)}${d.ota_ref ? ` · ${esc(d.ota_ref)}` : ''}</dd>
        ${d.bill_to_company ? `<dt>Bill to</dt><dd>${esc(d.bill_to_company)}</dd>` : ''}
        ${d.eta ? `<dt>Arriving</dt><dd>${esc(d.eta)}</dd>` : ''}
      </dl>
      <div class="sec-title">Bill</div>
      ${d.lines.length ? `<div class="fd-bill">${d.lines.map((l) => `<div class="fd-line${reversed.has(l.id) || l.kind === 'reversal' ? ' struck' : ''}">
          <span>${esc(showDate(l.business_date))}</span><span>${esc(l.description)}${l.ref ? ` <span class="muted small">${esc(l.ref)}</span>` : ''}</span>
          <span class="num">${l.amount_paise < 0 ? '−' : ''}${rs(Math.abs(Number(l.amount_paise)))}</span>
          ${open && can(this.me, 'folio.reverse') && !['payment', 'refund', 'reversal'].includes(l.kind) && !reversed.has(l.id) ? `<button type="button" class="btn small ghost" data-bk="reverse" data-line="${esc(l.id)}" title="Reverse this charge">Reverse</button>` : '<span></span>'}</div>`).join('')}</div>`
        : '<p class="muted small">Nothing charged or paid yet. Room nights are charged each night when the day closes.</p>'}
      <dl class="kv"><dt>Charged so far</dt><dd>${rs(charges)}</dd><dt>Paid</dt><dd>${rs(paid)}</dd>
        ${open && pending ? `<dt>Still to be charged</dt><dd>about ${rs(pending)} with GST</dd>` : ''}<dt>Balance</dt><dd>${balanceLine}</dd></dl>
      ${d.documents.length ? `<div class="sec-title">Invoices and receipts</div>${d.documents.map((x) => `<div class="fd-line"><span>${esc(showDate(x.issue_date))}</span><span>${esc(DOC_NAMES[x.doc_type] ?? x.doc_type)} ${esc(x.number)}</span><span class="num">${rs(Number(x.total_paise))}</span>
        <button type="button" class="btn small" data-bk="print" data-doc="${esc(x.id)}">Print</button></div>`).join('')}` : ''}
      ${actions.length ? `<div class="fd-actions">${actions.join('')}</div>` : ''}`, 'Done', async () => '')
    form.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-bk]')
      if (!b) return
      const a = b.dataset.bk
      if (a === 'print') { void this.api.openDocument(`/api/tax-documents/${b.dataset.doc}/print`); return }
      if (a === 'checkin') void this.checkIn(id)
      if (a === 'checkout') void this.checkOut(id)
      if (a === 'pay') void this.payment(id)
      if (a === 'charge') void this.addCharge(d)
      if (a === 'room') void this.changeRoom(d)
      if (a === 'bed') void this.extraBed(d)
      if (a === 'discount') void this.discount(d)
      if (a === 'cancel') void this.cancel(d)
      if (a === 'reverse') void this.reverse(d, b.dataset.line!)
    })
  }

  /** After an action on an open booking: refresh, say what happened, and show the booking again. */
  private async done(id: string, msg: string) {
    await this.after()
    toast(msg)
    await this.openBooking(id)
    return undefined
  }

  /** Free rooms, clean ones first; rooms still to be cleaned and other room types listed separately. */
  private async roomChoices(r: { id: string; arrival: string; departure: string; roomTypeId?: string; serverSpaceId?: string | null }) {
    const rooms = await this.api.get<Room[]>('/api/rooms')
    const busy = new Set(this.store.reservations
      .filter((x) => x.id !== r.id && x.serverSpaceId && x.status !== 'cancelled' && x.status !== 'checked-out' && x.arrival < r.departure && x.departure > r.arrival)
      .map((x) => x.serverSpaceId))
    const free = rooms.filter((m) => !busy.has(m.id) && m.hk_status !== 'out_of_order' && m.hk_status !== 'out_of_service'
      && (m.id === r.serverSpaceId || !m.hk_status?.startsWith('occupied')))
    const opt = (m: Room, attrs = '') => `<option value="${esc(m.id)}" ${m.id === r.serverSpaceId ? 'selected' : ''} ${attrs}>${esc(m.room_no)} · ${esc(m.room_type)}${m.building ? ` · ${esc(m.building)}` : ''}</option>`
    const same = free.filter((m) => m.room_type_id === r.roomTypeId)
    const ready = same.filter((m) => !m.hk_status || READY.has(m.hk_status) || m.id === r.serverSpaceId)
    const dirty = same.filter((m) => !ready.includes(m))
    const others = free.filter((m) => m.room_type_id !== r.roomTypeId)
    return `${ready.length ? `<optgroup label="Ready">${ready.map((m) => opt(m)).join('')}</optgroup>` : ''}
      ${dirty.length ? `<optgroup label="Not cleaned yet">${dirty.map((m) => opt(m, 'data-dirty')).join('')}</optgroup>` : ''}
      ${others.length ? `<optgroup label="Another room type (guest keeps the booked rate)">${others.map((m) => opt(m, `data-upgrade ${m.hk_status && !READY.has(m.hk_status) ? 'data-dirty' : ''}`)).join('')}</optgroup>` : ''}`
  }

  /** Shows a note under the room list when the chosen room is another type or still to be cleaned. */
  private roomNote(form: HTMLFormElement) {
    const sel = form.querySelector<HTMLSelectElement>('select[name=room]')!
    const note = form.querySelector<HTMLElement>('[data-room-note]')!
    const dirtyBox = form.querySelector<HTMLElement>('[data-not-clean]')
    const show = () => {
      const o = sel.selectedOptions[0]
      const msgs: string[] = []
      if (o?.hasAttribute('data-upgrade')) msgs.push('This is a different room type. The guest keeps the rate they booked; to charge more, add a charge or change the rate.')
      if (o?.hasAttribute('data-dirty')) msgs.push('This room has not been cleaned since the last guest.')
      note.textContent = msgs.join(' ')
      note.hidden = !msgs.length
      if (dirtyBox) dirtyBox.hidden = !o?.hasAttribute('data-dirty')
    }
    sel.addEventListener('change', show)
    show()
  }

  async checkIn(id: string) {
    const r = await this.find(id)
    const choices = await this.roomChoices(r)
    // What the guest filled in before arrival (online check-in): shown, and the ID type chosen for the desk.
    const oc = r.onlineCheckin ? (await this.api.get<{ onlineCheckin: { eta: string | null; id_type: string | null; id_last4: string | null; address: string | null; purpose: string | null; preferences: string | null; company: string | null; gstin: string | null } | null }>(`/api/reservations/${id}`)).onlineCheckin : null
    const idMap: Record<string, string> = { aadhaar: 'aadhaar', passport: 'passport', driving_licence: 'dl', voter_id: 'voter' }
    const hints: Record<string, string> = { aadhaar: '12 digits', passport: 'e.g. K1234567', dl: 'as printed on the licence', voter: 'as printed on the card' }
    const form = this.open(`Check in ${r.guest}`, `
      <p class="muted">${fmtDay(r.arrival)} → ${fmtDay(r.departure)} · ${r.pax} guest${r.pax > 1 ? 's' : ''}</p>
      ${oc ? `<div class="fd-online"><b>Checked in online</b>${oc.eta ? ` · arriving ${esc(oc.eta)}` : ''}${oc.id_type ? ` · ${esc(oc.id_type.replace('_', ' '))}${oc.id_last4 ? ` ending ${esc(oc.id_last4)}` : ''}` : ''}${oc.purpose ? ` · ${esc(oc.purpose)}` : ''}
        ${oc.address ? `<div class="small">${esc(oc.address)}</div>` : ''}${oc.preferences ? `<div class="small">Wants: ${esc(oc.preferences)}</div>` : ''}${oc.company ? `<div class="small">Bill to ${esc(oc.company)}${oc.gstin ? ` (${esc(oc.gstin)})` : ''}</div>` : ''}</div>` : ''}
      <div class="form-grid">
        <label class="span2">Room<select name="room">${choices}</select></label>
        <p class="fd-warn span2" data-room-note hidden></p>
        <label class="span2 check" data-not-clean hidden><input type="checkbox" name="notClean"> Check in before it is cleaned (housekeeping cleans it with the guest in)</label>
        <label>ID type<select name="idType">${[['aadhaar', 'Aadhaar'], ['passport', 'Passport'], ['dl', 'Driving licence'], ['voter', 'Voter ID']].map(([v, l]) => `<option value="${v}" ${idMap[oc?.id_type ?? ''] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>ID number<input name="idNumber" autocomplete="off" required placeholder="12 digits"></label>
      </div>
      <p class="muted small">Only the last 4 characters of the ID number are stored.</p>`, 'Check in', async (f) => {
      const sel = f.querySelector<HTMLSelectElement>('select[name=room]')!
      if (!sel.value) throw new Error('No free room of this type. Choose another type from the list, or free a room first.')
      const upgrade = sel.selectedOptions[0]?.hasAttribute('data-upgrade') ?? false
      try {
        const out = await this.api.post<{ formCDue: string | null; housekeeping: string | null }>(`/api/reservations/${id}/check-in`,
          { spaceId: sel.value, upgrade, idType: this.val(f, 'idType'), idNumber: this.val(f, 'idNumber'), notClean: checked(f, 'notClean') })
        await this.after()
        return [out.formCDue ? `Checked in. Form C is due by ${new Date(out.formCDue).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.` : 'Checked in.', out.housekeeping ?? ''].join(' ').trim()
      } catch (e) {
        if ((e as { body?: { notClean?: boolean } }).body?.notClean) f.querySelector<HTMLElement>('[data-not-clean]')!.hidden = false
        throw e
      }
    })
    const idType = form.querySelector<HTMLSelectElement>('select[name=idType]')!
    const setHint = () => { form.querySelector<HTMLInputElement>('input[name=idNumber]')!.placeholder = hints[idType.value] ?? '' }
    idType.addEventListener('change', setHint)
    setHint()
    this.roomNote(form)
  }

  async payment(id: string) {
    const r = await this.find(id)
    const d = await this.detail(id)
    const pending = toCharge(d)
    const suggest = Math.max(0, d.balance + pending)
    this.open(`Payment · ${r.guest}`, `
      <dl class="kv">
        <dt>Balance on the bill</dt><dd>${d.balance > 0 ? rs(d.balance) : d.balance < 0 ? `${rs(-d.balance)} paid in advance` : 'nil'}</dd>
        ${pending ? `<dt>Room nights still to be charged</dt><dd>about ${rs(pending)} with GST</dd>` : ''}
        <dt>To settle the whole stay</dt><dd><b>${rs(suggest)}</b></dd>
      </dl>
      ${d.status === 'confirmed' ? '<p class="muted small">Before arrival this is an advance: a receipt voucher is issued for it.</p>' : ''}
      <div class="form-grid">
        <label>Method<select name="method"><option value="upi">UPI</option><option value="card">Card</option><option value="cash">Cash</option><option value="bank">Bank transfer</option><option value="company">Company account</option><option value="ota">OTA prepaid</option></select></label>
        <label>Amount ₹<input name="amount" type="number" min="1" step="0.01" value="${suggest ? (suggest / 100).toFixed(2).replace(/\.00$/, '') : ''}" required></label>
        <label class="span2">Reference (UPI / card slip / UTR)<input name="reference" autocomplete="off"></label>
      </div>`, 'Record payment', async (f) => {
      const out = await this.api.post<{ balance: number; voucher: string | null }>(`/api/folios/${d.folios[0].id}/payments`, {
        method: this.val(f, 'method'), amount: Number(this.val(f, 'amount')), reference: this.val(f, 'reference') || undefined,
      })
      return this.done(id, `Payment recorded${out.voucher ? ` · receipt ${out.voucher}` : ''} · ${out.balance > 0 ? `${rs(out.balance)} still due` : out.balance < 0 ? `${rs(-out.balance)} in advance` : 'nothing due'}`)
    })
  }

  async checkOut(id: string) {
    const r = await this.find(id)
    const d = await this.detail(id)
    const today = todayKey()
    const early = d.departure > today
    // Leaving on the day they arrived: tonight's room is charged at check-out.
    const dayUse = d.arrival === today && !d.nights.some((n) => n.posted_line_id)
    const due = d.balance + (dayUse ? toCharge(d, true) : 0)
    this.open(`Check out ${r.guest}`, `
      <p>${d.room_no ? `Room ${esc(d.room_no)} · ` : ''}${fmtDay(d.arrival)} → ${fmtDay(d.departure)}</p>
      ${early && !dayUse ? `<p class="fd-warn">Leaving early: nights from ${fmtDay(today)} are released and not charged.</p>` : ''}
      ${dayUse ? '<p class="fd-warn">Day use: today\'s room charge is added now.</p>' : ''}
      <div class="fd-bill">${d.lines.map((l) => `<div class="fd-line"><span>${esc(showDate(l.business_date))}</span><span>${esc(l.description)}</span><span class="num">${l.amount_paise < 0 ? '−' : ''}${rs(Math.abs(Number(l.amount_paise)))}</span><span></span></div>`).join('')}
        ${dayUse ? `<div class="fd-line"><span>${esc(showDate(today))}</span><span>Room (day use), with GST</span><span class="num">about ${rs(toCharge(d, true))}</span><span></span></div>` : ''}</div>
      <dl class="kv"><dt>${due > 0 ? 'To pay now' : due < 0 ? 'To refund' : 'Balance'}</dt><dd><b>${due ? rs(Math.abs(due)) : 'nil, settled'}</b></dd></dl>
      ${due > 0 ? `<div class="form-grid">
        <label>Paid by<select name="method"><option value="upi">UPI</option><option value="card">Card</option><option value="cash">Cash</option><option value="bank">Bank transfer</option><option value="company">Company account</option></select></label>
        <label>Amount ₹<input name="amount" type="number" min="1" step="0.01" value="${(due / 100).toFixed(2).replace(/\.00$/, '')}"></label>
        <label class="span2">Reference (UPI / card slip / UTR)<input name="reference" autocomplete="off"></label></div>` : ''}
      ${due < 0 ? '<p class="fd-warn">The guest paid more than the bill. Open the booking and record a refund before check-out.</p>' : ''}
      <p class="muted small">The tax invoice is issued automatically.${d.bill_to_company ? ' This is a company bill, so it is also queued for e-invoicing.' : ''}</p>`, due > 0 ? 'Take payment and check out' : 'Check out and issue invoice', async (f) => {
      if (due > 0) {
        const amount = Number(this.val(f, 'amount'))
        if (amount > 0) await this.api.post(`/api/folios/${d.folios[0].id}/payments`, { method: this.val(f, 'method'), amount, reference: this.val(f, 'reference') || undefined })
      }
      try {
        const out = await this.api.post<{ invoice: { id: string; number: string; irnStatus: string } | null }>(`/api/reservations/${id}/check-out`)
        await this.after()
        if (out.invoice) this.showInvoice(out.invoice)
        return out.invoice ? undefined : 'Checked out'
      } catch (e) {
        await this.after()
        const bal = (e as { body?: { balance?: number } }).body?.balance
        if (bal && bal > 0) throw new Error(`${rs(bal)} is still due. Enter it above and try again.`)
        throw e
      }
    })
  }

  async addCharge(d: Detail) {
    this.open(`Add a charge · ${d.guest.name}`, `
      <div class="form-grid">
        <label>What for<select name="kind"><option value="misc">Other service</option><option value="laundry">Laundry (GST 18%)</option></select></label>
        <label>GST rate<select name="gst"><option value="18">18%</option><option value="5">5%</option><option value="12">12%</option><option value="0">None</option></select></label>
        <label class="span2">Description<input name="description" required placeholder="e.g. Airport pickup"></label>
        <label>Amount ₹ (before GST)<input name="amount" type="number" min="1" step="0.01" required></label>
      </div>`, 'Add to bill', async (f) => {
      await this.api.post(`/api/folios/${d.folios[0].id}/charges`, { kind: this.val(f, 'kind'), description: this.val(f, 'description'), amount: Number(this.val(f, 'amount')), gstRate: Number(this.val(f, 'gst')) })
      return this.done(d.id, 'Added to the bill')
    })
  }

  async changeRoom(d: Detail) {
    const r = { id: d.id, arrival: d.arrival, departure: d.departure, roomTypeId: d.room_type_id, serverSpaceId: d.space_id }
    const form = this.open(`${d.space_id ? 'Change room' : 'Assign a room'} · ${d.guest.name}`, `
      <div class="form-grid"><label class="span2">Room<select name="room">${await this.roomChoices(r)}</select></label>
      <p class="fd-warn span2" data-room-note hidden></p></div>
      ${d.status === 'in_house' ? '<p class="muted small">The old room goes on the cleaning list.</p>' : ''}`, d.space_id ? 'Move' : 'Assign', async (f) => {
      const sel = f.querySelector<HTMLSelectElement>('select[name=room]')!
      if (sel.value === d.space_id) return ''
      const out = await this.api.post<{ roomNo: string }>(`/api/reservations/${d.id}/assign-room`, { spaceId: sel.value, upgrade: sel.selectedOptions[0]?.hasAttribute('data-upgrade') ?? false })
      return this.done(d.id, `Room ${out.roomNo}`)
    })
    this.roomNote(form)
  }

  async extraBed(d: Detail) {
    const now = d.nights.find((n) => !n.released && !n.posted_line_id)?.extras_paise ?? 0
    this.open(`Extra bed · ${d.guest.name}`, `
      <div class="form-grid"><label class="span2">Extra bed ₹ per night (0 removes it)<input name="amount" type="number" min="0" step="1" value="${Number(now) / 100 || ''}" required></label></div>
      <p class="muted small">Applies to the nights not yet charged; GST is added with the room.</p>`, 'Save', async (f) => {
      const out = await this.api.post<{ nights: string[] }>(`/api/reservations/${d.id}/extra-bed`, { amount: Number(this.val(f, 'amount')) })
      return this.done(d.id, `Extra bed set for ${out.nights.length} night${out.nights.length === 1 ? '' : 's'}`)
    })
  }

  async discount(d: Detail) {
    this.open(`Discount · ${d.guest.name}`, `
      <div class="form-grid"><label>Discount on the room rate %<input name="percent" type="number" min="0" max="100" step="0.5" required></label>
      <label class="span2">Reason<input name="reason" required placeholder="e.g. Repeat guest"></label></div>
      <p class="muted small">Applies to the nights not yet charged. Above your limit it goes to a manager for approval.</p>`, 'Apply', async (f) => {
      const out = await this.api.post<{ pending?: boolean; message?: string; nightsRepriced?: number }>(`/api/reservations/${d.id}/discount`, { percent: Number(this.val(f, 'percent')), reason: this.val(f, 'reason') })
      return this.done(d.id, out.pending ? out.message ?? 'Sent for approval' : `Discount applied to ${out.nightsRepriced} night${out.nightsRepriced === 1 ? '' : 's'}`)
    })
  }

  async cancel(d: Detail) {
    this.open(`Cancel the booking · ${d.guest.name}`, `
      <p>${esc(showDate(d.arrival))} → ${esc(showDate(d.departure))}${d.room_no ? ` · Room ${esc(d.room_no)}` : ''}. The rooms go back on sale.</p>
      ${d.balance < 0 ? `<p class="fd-warn">${rs(-d.balance)} was paid in advance. Refund it, or keep it as a cancellation charge, from the booking afterwards.</p>` : ''}
      <div class="form-grid"><label class="span2">Reason<input name="reason" required placeholder="e.g. Guest changed plans"></label></div>`, 'Cancel booking', async (f) => {
      await this.api.post(`/api/reservations/${d.id}/cancel`, { reason: this.val(f, 'reason') })
      return this.done(d.id, 'Booking cancelled')
    })
  }

  async reverse(d: Detail, lineId: string) {
    const l = d.lines.find((x) => x.id === lineId)!
    this.open('Reverse a charge', `<p>${esc(l.description)} · ${rs(Number(l.amount_paise))}</p>
      <div class="form-grid"><label class="span2">Reason<input name="reason" required></label></div>`, 'Reverse', async (f) => {
      await this.api.post(`/api/folio-lines/${lineId}/reverse`, { reason: this.val(f, 'reason') })
      return this.done(d.id, 'Charge reversed')
    })
  }

  private showInvoice(inv: { id: string; number: string; irnStatus: string }) {
    this.open('Checked out', `<p>Tax invoice <b>${esc(inv.number)}</b> issued.</p>
      ${inv.irnStatus === 'pending' ? '<p class="muted">Company bill: accounts will generate the e-invoice (IRN).</p>' : ''}`, 'Done', async () => '',
    `<button type="button" class="btn" data-print>Print invoice</button>`)
    this.modal.el.querySelector('[data-print]')!.addEventListener('click', () => void this.api.openDocument(`/api/tax-documents/${inv.id}/print`))
  }

  async openShift() {
    this.open('Open cashier shift', `<div class="form-grid"><label class="span2">Cash in the drawer now ₹<input name="float" type="number" min="0" value="0"></label></div>`,
      'Open shift', async (f) => {
        await this.api.post('/api/cashier/open', { openingFloat: Number(this.val(f, 'float')) })
        await this.refreshCashier()
        return 'Shift opened'
      })
  }

  async closeShift() {
    const notes = [500, 200, 100, 50, 20, 10]
    const form = this.open('Close cashier shift', `
      <p class="muted">Expected in the drawer: <b>${rs(this.cashier.expectedInDrawer ?? 0)}</b>. Count the notes.</p>
      <div class="form-grid">${notes.map((n) => `<label>₹${n} × <input name="n${n}" type="number" min="0" value="0"></label>`).join('')}
        <label>Coins ₹<input name="coins" type="number" min="0" value="0"></label></div>
      <p class="fd-count">Counted: <b>₹0</b></p>`, 'Close shift', async (f) => {
      const denominations: Record<string, number> = {}
      for (const n of notes) { const c = Number(this.val(f, `n${n}`)); if (c) denominations[n] = c }
      const coins = Number(this.val(f, 'coins'))
      if (coins) denominations['1'] = coins
      const counted = Object.entries(denominations).reduce((a, [n, c]) => a + Number(n) * c, 0)
      const out = await this.api.post<{ variance: number; flagged: boolean }>('/api/cashier/close', { countedCash: counted, denominations })
      await this.refreshCashier()
      return out.variance === 0 ? 'Shift closed. Cash matches.' : `Shift closed. ${out.variance > 0 ? 'Excess' : 'Short'} ${rs(Math.abs(out.variance))}${out.flagged ? ', flagged to the MD' : ''}.`
    })
    const total = form.querySelector<HTMLElement>('.fd-count b')!
    form.addEventListener('input', () => {
      const sum = notes.reduce((a, n) => a + n * Number(this.val(form, `n${n}`)), 0) + Number(this.val(form, 'coins'))
      total.textContent = inr(sum)
    })
  }

  async nightAudit() {
    const day = todayKey()
    // Closing a day that has not happened yet on the calendar is almost always a mistake.
    const info = await this.api.get<{ businessDate: string; calendarDate: string }>('/api/business-date').catch(() => null)
    const ahead = !!info && info.businessDate >= info.calendarDate && new Date().getHours() >= 6
    const inHouse = this.store.reservations.filter((r) => r.status === 'in-house').length
    const pendingArrivals = this.store.reservations.filter((r) => r.arrival === day && r.status === 'confirmed').length
    this.open(`Close ${fmtDay(day)}`, `
      <p>This posts tonight's room charges for ${inHouse} in-house guest${inHouse === 1 ? '' : 's'} and moves the hotel to the next business day.</p>
      ${pendingArrivals ? `<p class="fd-warn">${pendingArrivals} arrival${pendingArrivals > 1 ? 's have' : ' has'} not checked in and will be marked no-show.</p>` : ''}
      ${this.cashier.open ? '<p class="fd-warn">Your cashier shift is still open.</p>' : ''}
      ${ahead ? `<p class="fd-warn">Today is ${fmtDay(info!.calendarDate)} and the day has not ended yet. Closing it now moves the hotel to tomorrow: today's later check-ins and bills would be dated tomorrow.</p>
        <label class="check"><input type="checkbox" name="sure"> Yes, close ${fmtDay(day)} now</label>` : ''}`, 'Close the day', async (f) => {
      if (ahead && !checked(f, 'sure')) throw new Error('Tick the box to close the day early, or wait: it closes by itself overnight.')
      const s = await this.api.post<{ roomsSold: number; occupancy: number; roomRevenue: number; roomGst: number; noShows: string[]; formCOverdue: string[]; eInvoicesDueWithin5Days: unknown[]; nextBusinessDate: string
        fnb?: { bills: number; foodSales: number; foodGst: number; liquorSales: number; liquorVat: number; openOrders: number[] } }>('/api/night-audit')
      setToday(s.nextBusinessDate)
      window.dispatchEvent(new CustomEvent('sathya:day-closed'))
      await this.store.setDate(s.nextBusinessDate)
      await this.store.reload()
      this.open('Day closed', `<dl class="kv">
        <dt>Rooms sold</dt><dd>${s.roomsSold} (${s.occupancy}%)</dd>
        <dt>Room revenue</dt><dd>${rs(s.roomRevenue)} + GST ${rs(s.roomGst)}</dd>
        ${s.fnb ? `<dt>Restaurant &amp; bar</dt><dd>${rs(s.fnb.foodSales)} + GST ${rs(s.fnb.foodGst)} · liquor ${rs(s.fnb.liquorSales)} + VAT ${rs(s.fnb.liquorVat)}</dd>
          ${s.fnb.openOrders.length ? `<dt>Open restaurant orders</dt><dd class="fd-warn">${s.fnb.openOrders.length}</dd>` : ''}` : ''}
        <dt>No-shows</dt><dd>${s.noShows.length}</dd>
        <dt>Form C overdue</dt><dd>${s.formCOverdue.length}</dd>
        <dt>E-invoices due in 5 days</dt><dd>${s.eInvoicesDueWithin5Days.length}</dd>
        <dt>New business date</dt><dd>${fmtDay(s.nextBusinessDate)}</dd></dl>`, 'Done', async () => '')
      return undefined
    })
  }
}

function addDaysLocal(key: string, n: number) {
  const d = new Date(key + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const liveBadge = (me: Me) => tonePill(`${me.name}${me.godMode ? ' · God Mode' : ''}`, '--accent')
