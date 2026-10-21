import './guest.css'

// The resort's own booking page: dates and guests, rooms with each meal plan's price (GST included), the
// guest's details, then the booking with a deposit link (when the resort takes payments online) and the
// link to check in online.

interface Price { plan: string; name: string; roomPaise: number; gstPaise: number; firstNightPaise: number }
interface RoomType { roomTypeId: string; name: string; maxOccupancy: number; available: boolean; reason: string | null; roomsLeft: number | null; nights: number; prices: Price[] }
interface Booked { reservationId: string; totalPaise: number; payment: { url: string; amountPaise: number; payBy: string } | null; checkinUrl: string }

const app = document.getElementById('g-app')!
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error ?? 'Something went wrong. Please call the resort.')
  return j as T
}

let resort = { name: 'Sathya Park & Resorts', city: null as string | null, today: new Date().toISOString().slice(0, 10), payOnline: false }
const state = { arrival: '', departure: '', adults: 2, children: 0, rooms: [] as RoomType[], pick: null as { room: RoomType; price: Price } | null }

const head = () => `<header class="g-head"><span class="g-mark" aria-hidden="true"></span><div><h1>${esc(resort.name)}</h1><p>${esc(resort.city ?? '')}${resort.city ? ' · ' : ''}Book your stay directly with the resort</p></div></header>`

function search(error = '') {
  app.innerHTML = `${head()}<form class="g-card" id="g-search"><h2>When are you coming?</h2><div class="g-grid">
      <label>Arrival<input name="arrival" type="date" required min="${resort.today}" value="${esc(state.arrival)}"></label>
      <label>Departure<input name="departure" type="date" required min="${addDays(resort.today, 1)}" value="${esc(state.departure)}"></label>
      <label>Adults<input name="adults" type="number" min="1" max="6" value="${state.adults}"></label>
      <label>Children<input name="kids" type="number" min="0" max="4" value="${state.children}"></label></div>
      <div class="g-actions"><button class="g-btn primary" type="submit">See rooms</button></div>${error ? `<p class="g-error" role="alert">${esc(error)}</p>` : ''}</form>
    ${state.rooms.length ? rooms() : ''}`
  const f = document.getElementById('g-search') as HTMLFormElement
  f.arrival.addEventListener('change', () => { if (!f.departure.value || f.departure.value <= f.arrival.value) f.departure.value = addDays(f.arrival.value, 1) })
  f.addEventListener('submit', async (e) => {
    e.preventDefault()
    Object.assign(state, { arrival: f.arrival.value, departure: f.departure.value, adults: Number(f.adults.value), children: Number(f.kids.value) })
    try {
      const r = await call<{ roomTypes: RoomType[] }>('GET', `/public/availability?arrival=${state.arrival}&departure=${state.departure}&adults=${state.adults}&children=${state.children}`)
      state.rooms = r.roomTypes
      search()
      document.getElementById('g-rooms')?.scrollIntoView({ behavior: 'smooth' })
    } catch (x) { state.rooms = []; search((x as Error).message) }
  })
  app.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) => b.addEventListener('click', () => {
    const [id, plan] = b.dataset.pick!.split('|')
    const room = state.rooms.find((r) => r.roomTypeId === id)!
    state.pick = { room, price: room.prices.find((p) => p.plan === plan)! }
    details()
  }))
}

function rooms() {
  const n = state.rooms[0]?.nights ?? 0
  return `<section id="g-rooms"><p class="g-note">${day(state.arrival)} to ${day(state.departure)} · ${n} night${n > 1 ? 's' : ''} · prices include GST</p>
    ${state.rooms.map((r) => `<div class="g-card g-room ${r.available ? '' : 'g-off'}"><div><h3>${esc(r.name)}</h3><div class="g-sub">Up to ${r.maxOccupancy} guests${r.roomsLeft ? ` · only ${r.roomsLeft} left` : ''}</div></div>
      <div></div><div class="g-plans">${r.available ? r.prices.map((p) => `<button type="button" class="g-plan" data-pick="${esc(r.roomTypeId)}|${esc(p.plan)}"><span>${esc(p.name)}</span><b>${inr(p.roomPaise + p.gstPaise)}</b></button>`).join('') : `<span class="g-note">${esc(r.reason ?? 'Not available')}</span>`}</div></div>`).join('')}</section>`
}

function details(error = '') {
  const { room, price } = state.pick!
  app.innerHTML = `${head()}<div class="g-card"><h2>${esc(room.name)}, ${esc(price.name)}</h2><dl class="g-sum"><dt>Dates</dt><dd>${day(state.arrival)} to ${day(state.departure)}</dd>
      <dt>Guests</dt><dd>${state.adults} adult${state.adults > 1 ? 's' : ''}${state.children ? `, ${state.children} child${state.children > 1 ? 'ren' : ''}` : ''}</dd>
      <dt>Room</dt><dd>${inr(price.roomPaise)}</dd><dt>GST</dt><dd>${inr(price.gstPaise)}</dd><dt>Total</dt><dd>${inr(price.roomPaise + price.gstPaise)}</dd></dl>
      ${resort.payOnline ? `<p class="g-note">A deposit of the first night, ${inr(price.firstNightPaise)}, confirms the booking. Pay it within two hours by UPI or card; otherwise the booking lapses.</p>` : '<p class="g-note">Nothing to pay now: you pay at the resort.</p>'}</div>
    <form class="g-card" id="g-guest"><h2>Your details</h2><div class="g-grid">
      <label class="full">Name<input name="name" required maxlength="120" autocomplete="name"></label>
      <label>Mobile<input name="mobile" required inputmode="tel" autocomplete="tel" placeholder="98400 00000"></label>
      <label>Email (optional)<input name="email" type="email" autocomplete="email"></label>
      <label class="full">Anything we should know?<textarea name="requests" rows="2" maxlength="500" placeholder="Arrival time, a cot, an anniversary…"></textarea></label>
      <label class="g-hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
      <div class="g-actions"><button class="g-btn" type="button" data-back>Back</button><button class="g-btn primary" type="submit">Book</button></div><p class="g-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p></form>`
  app.querySelector('[data-back]')!.addEventListener('click', () => search())
  const f = document.getElementById('g-guest') as HTMLFormElement
  f.addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = f.querySelector<HTMLButtonElement>('button[type=submit]')!
    btn.disabled = true
    try {
      const r = await call<Booked>('POST', '/public/bookings', { roomTypeId: room.roomTypeId, plan: price.plan, arrival: state.arrival, departure: state.departure, adults: state.adults, children: state.children,
        name: (f.elements.namedItem('name') as HTMLInputElement).value, mobile: f.mobile.value, email: f.email.value || undefined, requests: f.requests.value || undefined, website: f.website.value || undefined })
      done(r)
    } catch (x) {
      const err = f.querySelector<HTMLElement>('.g-error')!
      err.textContent = (x as Error).message; err.hidden = false; btn.disabled = false
    }
  })
}

function done(b: Booked) {
  app.innerHTML = `${head()}<div class="g-card"><h2 class="g-ok">${b.payment ? 'Booking held' : 'Booked'}</h2><dl class="g-sum"><dt>Booking</dt><dd class="mono">${esc(b.reservationId)}</dd><dt>Total</dt><dd>${inr(b.totalPaise)}</dd></dl>
      ${b.payment ? `<p>Pay the deposit of <b>${inr(b.payment.amountPaise)}</b> by ${new Date(b.payment.payBy).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} to confirm it.</p>
        <div class="g-actions"><a class="g-btn primary" href="${esc(b.payment.url)}">Pay the deposit</a></div>` : '<p>We look forward to having you. The resort may call you to confirm.</p>'}
      <p class="g-note">Save time at the desk: <a href="${esc(b.checkinUrl)}">check in online</a> before you arrive. Keep this link; it opens your booking.</p></div>`
}

/** Back from the payment page (or opening a saved link): the booking as it stands. */
async function existing(id: string, t: string) {
  try {
    const b = await call<{ id: string; status: string; guest: string; arrival: string; departure: string; room_type: string; roomPaise: number; paidPaise: number; payment: { url: string; amountPaise: number } | null }>('GET', `/public/bookings/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}`)
    app.innerHTML = `${head()}<div class="g-card"><h2>${b.status === 'cancelled' ? 'This booking was cancelled' : b.paidPaise > 0 ? '<span class="g-ok">Confirmed</span>' : 'Your booking'}</h2>
      <dl class="g-sum"><dt>Booking</dt><dd class="mono">${esc(b.id)}</dd><dt>Guest</dt><dd>${esc(b.guest)}</dd><dt>Room</dt><dd>${esc(b.room_type)}</dd><dt>Dates</dt><dd>${day(b.arrival)} to ${day(b.departure)}</dd>
      ${b.paidPaise ? `<dt>Paid</dt><dd>${inr(b.paidPaise)}</dd>` : ''}</dl>
      ${b.payment ? `<div class="g-actions"><a class="g-btn primary" href="${esc(b.payment.url)}">Pay the deposit (${inr(b.payment.amountPaise)})</a></div>` : ''}
      ${b.status === 'confirmed' ? `<p class="g-note"><a href="/checkin.html?r=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}">Check in online</a> before you arrive.</p>` : ''}</div>`
  } catch (x) { app.innerHTML = `${head()}<div class="g-card"><p class="g-error">${esc((x as Error).message)}</p></div>` }
}

async function start() {
  try { resort = { ...resort, ...(await call<typeof resort>('GET', '/public/property')) } } catch { /* the page still works with the defaults */ }
  document.title = `Book a stay · ${resort.name}`
  state.arrival = addDays(resort.today, 1); state.departure = addDays(resort.today, 2)
  const q = new URLSearchParams(location.search)
  if (q.get('r') && q.get('t')) await existing(q.get('r')!, q.get('t')!)
  else search()
}
void start()
