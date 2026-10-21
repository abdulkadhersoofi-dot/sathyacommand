import type { Store } from '../data/store'
import type { Reservation } from '../data/types'
import { fmtDay, fmtTime, inr, setToday, todayKey } from '../data/dates'
import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import { esc, statusPill, tonePill } from './dom'
import { FormModal, val } from './form-modal'

/** Where a booking came from; an OTA booking needs the OTA's booking ID to match its payout. */
const SOURCES: Record<string, string> = { direct: 'Direct', phone: 'Phone', walk_in: 'Walk-in', website: 'Website', travel_agent: 'Travel agent', corporate: 'Corporate', booking_com: 'Booking.com', makemytrip: 'MakeMyTrip', goibibo: 'Goibibo', agoda: 'Agoda', expedia: 'Expedia', airbnb: 'Airbnb', cleartrip: 'Cleartrip', yatra: 'Yatra', easemytrip: 'EaseMyTrip' }

// Front desk on the live HMS: the desk panel plus forms for booking, check-in, payment,
// check-out (with the tax invoice), cashier shift and closing the day.

interface RoomType { id: string; name: string; base_rate_paise: number; max_occupancy: number; active: boolean; rooms: number }
interface Room { id: string; room_no: string; kind: string; room_type_id: string; room_type: string; building: string | null; floor: number | null }
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
    const toolbar = `<div class="fd-toolbar">
      <button class="btn primary" data-fd="book" type="button">New booking</button>
      ${c.open ? `<button class="btn" data-fd="close-shift" type="button">Close shift · ${rs(c.expectedInDrawer ?? 0)} in drawer</button>` : `<button class="btn" data-fd="open-shift" type="button">Open cashier shift</button>`}
      ${can(this.me, 'night_audit') ? '<button class="btn" data-fd="night-audit" type="button">Close the day</button>' : ''}
    </div>
    <div class="fd-date">Business date <b>${fmtDay(today)}</b></div>`
    const card = (r: Reservation, actions: string) => `<div class="row-card" ${r.spaceId ? `data-focus="${esc(r.spaceId)}"` : ''}>
      <div class="rc-title">${r.vip ? '<span class="vip">VIP</span> ' : ''}${esc(r.guest)}</div>
      <div class="rc-sub">${r.roomNo ? `Room ${esc(r.roomNo)}` : 'No room yet'} · ${r.pax} pax${r.company ? ` · ${esc(r.company)}` : ''}${r.balance ? ` · <b>due ${rs(r.balance * 100)}</b>` : ''}
        ${r.pastStays ? ` · <span class="fd-tag ok">Returning guest · ${ordinal(r.pastStays + 1)} stay</span>` : ''}${r.onlineCheckin ? ' · <span class="fd-tag ok">Checked in online</span>' : ''}${r.payBy ? ` · <span class="fd-tag warn">Deposit due by ${new Date(r.payBy).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>` : ''}${r.otaRef ? ` · <span class="fd-tag">${esc(r.source.replace('_', '.'))} ${esc(r.otaRef)}</span>` : ''}</div>
      <div class="rc-right">${actions}</div></div>`
    const btn = (act: string, id: string, label: string, primary = false) => `<button class="btn small${primary ? ' primary' : ''}" data-fd="${act}" data-res="${esc(id)}" type="button">${label}</button>`
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
  private find(id: string) {
    const r = this.store.reservations.find((x) => x.id === id)
    if (!r) throw new Error('That booking is not in view any more. Refresh and try again.')
    return r
  }

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
        <label class="span2">Company (for a GST bill)<input name="company" autocomplete="off"></label>
        <label>Company GSTIN<input name="gstin" maxlength="15" autocomplete="off"></label>
        <label>Company PIN code<input name="pin" maxlength="6" inputmode="numeric"></label>
        <label class="span2">Company address<input name="address"></label>
        <label>Company city<input name="city"></label>
        <label>Expected arrival time<input name="eta" type="time"></label>
        <label>Booked through<select name="source">${Object.entries(SOURCES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>OTA booking ID<input name="otaRef" maxlength="40" autocomplete="off" placeholder="for OTA bookings"></label>
      </div>
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
      return `Booked ${r.id} · ${rs(r.roomTotal)} for the room before tax`
    })
    const quote = form.querySelector<HTMLElement>('.fd-quote')!
    const country = form.querySelector<HTMLElement>('[data-country]')!
    const update = async () => {
      country.hidden = this.val(form, 'nationality') !== 'OTHER'
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

  async checkIn(id: string) {
    const r = this.find(id)
    const rooms = await this.api.get<Room[]>('/api/rooms')
    const busy = new Set(this.store.reservations
      .filter((x) => x.id !== r.id && x.serverSpaceId && x.status !== 'cancelled' && x.status !== 'checked-out' && x.arrival < r.departure && x.departure > r.arrival)
      .map((x) => x.serverSpaceId))
    const options = rooms.filter((m) => m.room_type_id === r.roomTypeId && !busy.has(m.id))
    const others = rooms.filter((m) => m.room_type_id !== r.roomTypeId && !busy.has(m.id))
    const current = r.serverSpaceId
    // What the guest filled in before arrival (online check-in): shown, and the ID type chosen for the desk.
    const oc = r.onlineCheckin ? (await this.api.get<{ onlineCheckin: { eta: string | null; id_type: string | null; id_last4: string | null; address: string | null; purpose: string | null; preferences: string | null; company: string | null; gstin: string | null } | null }>(`/api/reservations/${id}`)).onlineCheckin : null
    const idMap: Record<string, string> = { aadhaar: 'aadhaar', passport: 'passport', driving_licence: 'dl', voter_id: 'voter' }
    this.open(`Check in ${r.guest}`, `
      <p class="muted">${fmtDay(r.arrival)} → ${fmtDay(r.departure)} · ${r.pax} guest${r.pax > 1 ? 's' : ''}</p>
      ${oc ? `<div class="fd-online"><b>Checked in online</b>${oc.eta ? ` · arriving ${esc(oc.eta)}` : ''}${oc.id_type ? ` · ${esc(oc.id_type.replace('_', ' '))}${oc.id_last4 ? ` ending ${esc(oc.id_last4)}` : ''}` : ''}${oc.purpose ? ` · ${esc(oc.purpose)}` : ''}
        ${oc.address ? `<div class="small">${esc(oc.address)}</div>` : ''}${oc.preferences ? `<div class="small">Wants: ${esc(oc.preferences)}</div>` : ''}${oc.company ? `<div class="small">Bill to ${esc(oc.company)}${oc.gstin ? ` (${esc(oc.gstin)})` : ''}</div>` : ''}</div>` : ''}
      <div class="form-grid">
        <label class="span2">Room<select name="room">
          ${options.map((m) => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.room_no)} · ${esc(m.room_type)}${m.building ? ` · ${esc(m.building)}` : ''}</option>`).join('')}
          ${others.length ? `<optgroup label="Upgrade / other type">${others.map((m) => `<option value="${esc(m.id)}" data-upgrade>${esc(m.room_no)} · ${esc(m.room_type)}</option>`).join('')}</optgroup>` : ''}
        </select></label>
        <label>ID type<select name="idType">${[['aadhaar', 'Aadhaar'], ['passport', 'Passport'], ['dl', 'Driving licence'], ['voter', 'Voter ID']].map(([v, l]) => `<option value="${v}" ${idMap[oc?.id_type ?? ''] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>ID number<input name="idNumber" autocomplete="off" required></label>
      </div>
      <p class="muted small">Only the last 4 characters of the ID number are stored.</p>`, 'Check in', async (f) => {
      const sel = f.querySelector<HTMLSelectElement>('select[name=room]')!
      const upgrade = sel.selectedOptions[0]?.hasAttribute('data-upgrade') ?? false
      const out = await this.api.post<{ formCDue: string | null }>(`/api/reservations/${id}/check-in`, { spaceId: sel.value, upgrade, idType: this.val(f, 'idType'), idNumber: this.val(f, 'idNumber') })
      await this.after()
      return out.formCDue ? `Checked in. Form C is due by ${new Date(out.formCDue).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.` : 'Checked in'
    })
  }

  async payment(id: string) {
    const r = this.find(id)
    const due = Math.max(0, r.balance)
    this.open(`Payment · ${r.guest}`, `
      <p class="muted">${due ? `Balance due ${rs(due * 100)}` : 'Nothing due right now. A payment before arrival is recorded as an advance with a receipt voucher.'}</p>
      <div class="form-grid">
        <label>Method<select name="method"><option value="upi">UPI</option><option value="card">Card</option><option value="cash">Cash</option><option value="bank">Bank transfer</option><option value="company">Company account</option><option value="ota">OTA prepaid</option></select></label>
        <label>Amount ₹<input name="amount" type="number" min="1" step="0.01" value="${due || ''}" required></label>
        <label class="span2">Reference (UPI / card slip / UTR)<input name="reference" autocomplete="off"></label>
      </div>`, 'Record payment', async (f) => {
      const out = await this.api.post<{ balance: number; voucher: string | null }>(`/api/folios/${r.folioId}/payments`, {
        method: this.val(f, 'method'), amount: Number(this.val(f, 'amount')), reference: this.val(f, 'reference') || undefined,
      })
      await this.after()
      return `Payment recorded${out.voucher ? ` · receipt voucher ${out.voucher}` : ''} · balance ${rs(out.balance)}`
    })
  }

  async checkOut(id: string) {
    const r = this.find(id)
    const early = r.departure > todayKey()
    this.open(`Check out ${r.guest}`, `
      <p>${r.roomNo ? `Room ${esc(r.roomNo)} · ` : ''}${fmtDay(r.arrival)} → ${fmtDay(r.departure)}</p>
      ${early ? `<p class="fd-warn">Leaving early: nights from ${fmtDay(todayKey())} will be released and not charged.</p>` : ''}
      <p class="muted">The tax invoice is issued automatically.${r.company ? ' This is a company bill, so it will also be queued for e-invoicing.' : ''}</p>`, 'Check out and issue invoice', async () => {
      try {
        const out = await this.api.post<{ invoice: { id: string; number: string; irnStatus: string } | null }>(`/api/reservations/${id}/check-out`)
        await this.after()
        if (out.invoice) this.showInvoice(out.invoice)
        return out.invoice ? undefined : 'Checked out'
      } catch (e) {
        const bal = (e as { body?: { balance?: number } }).body?.balance
        if (bal && bal > 0) throw new Error(`${rs(bal)} is still due. Take the payment first.`)
        throw e
      }
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
    const inHouse = this.store.reservations.filter((r) => r.status === 'in-house').length
    const pendingArrivals = this.store.reservations.filter((r) => r.arrival === day && r.status === 'confirmed').length
    this.open(`Close ${fmtDay(day)}`, `
      <p>This posts tonight's room charges for ${inHouse} in-house guest${inHouse === 1 ? '' : 's'} and moves the hotel to the next business day.</p>
      ${pendingArrivals ? `<p class="fd-warn">${pendingArrivals} arrival${pendingArrivals > 1 ? 's have' : ' has'} not checked in and will be marked no-show.</p>` : ''}
      ${this.cashier.open ? '<p class="fd-warn">Your cashier shift is still open.</p>' : ''}`, 'Close the day', async () => {
      const s = await this.api.post<{ roomsSold: number; occupancy: number; roomRevenue: number; roomGst: number; noShows: string[]; formCOverdue: string[]; eInvoicesDueWithin5Days: unknown[]; nextBusinessDate: string
        fnb?: { bills: number; foodSales: number; foodGst: number; liquorSales: number; liquorVat: number; openOrders: number[] } }>('/api/night-audit')
      setToday(s.nextBusinessDate)
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
