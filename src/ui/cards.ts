import { minutesOpen, orderTotal, type Store } from '../data/store'
import type { Reservation, Space } from '../data/types'
import { addDays, fmtDay, fmtTime, inr, todayKey } from '../data/dates'
import { esc, hkPill, maskPhone, statusPill, tonePill } from './dom'

// HTML for the hover / tap card and the full detail drawer.

const nights = (r: Reservation) => Math.round((+new Date(r.departure) - +new Date(r.arrival)) / 864e5)
const row = (k: string, v: string) => `<div class="tip-row"><span>${k}</span><span>${v}</span></div>`
const kindLabel = (s: Space) =>
  s.type === 'room' ? `${s.category} · Floor ${s.floor}` : s.type === 'villa' ? s.category! : s.capacity ? `Up to ${s.capacity.toLocaleString('en-IN')} guests` : ''

function nextStay(store: Store, id: string) {
  return store.reservations
    .filter((r) => r.spaceId === id && r.arrival > store.date && r.status !== 'cancelled')
    .sort((a, b) => a.arrival.localeCompare(b.arrival))[0]
}

function poolCount(store: Store) {
  const h = new Date().getHours()
  if (!store.isToday) return null
  if (h < 7 || h >= 19) return 0
  return Math.max(2, Math.round(store.kpis().guests * 0.09))
}

export function tipHtml(store: Store, id: string, touch: boolean) {
  const st = store.state(id)
  const s = st.space
  const god = store.godMode
  let head = ''
  let body = ''
  if (s.type === 'room' || s.type === 'villa') {
    head = statusPill(st.status)
    const g = st.stay
    if (g) {
      body += row('Guest', `${g.vip ? '<span class="vip">VIP</span> ' : ''}${esc(g.guest)}`)
      body += row('Guests', `${g.pax}`)
      body += row('Check-in', `${fmtDay(g.arrival, { day: 'numeric', month: 'short' })} · ${g.checkInAt ? fmtTime(g.checkInAt) : 'ETA ' + g.eta}`)
      body += row('Check-out', `${fmtDay(g.departure, { day: 'numeric', month: 'short' })} · 11:00`)
      if (god) body += row('Balance due', g.balance ? inr(g.balance) : 'Settled')
      const open = store.isToday ? store.ordersFor(id).filter((o) => o.status !== 'served').length : 0
      if (open) body += row('Room service', `${open} open order${open > 1 ? 's' : ''}`)
    }
    if (st.departing && st.departing !== g) body += row('Leaving', `${esc(st.departing.guest)} · by 11:00`)
    if (!g && !st.departing) {
      if (store.isToday && st.hk) body += row('Housekeeping', hkPill(st.hk))
      const n = nextStay(store, id)
      body += row('Next arrival', n ? `${fmtDay(n.arrival, { day: 'numeric', month: 'short' })} · ${esc(n.guest)}` : 'None booked')
    }
  } else if (['hall', 'lawn', 'pavilion', 'ground'].includes(s.type)) {
    const ev = st.events[0]
    if (ev) {
      head = tonePill(ev.setup === 'live' ? 'Live now' : ev.setup === 'done' ? 'Done' : 'Booked', '--marigold')
      body += row('Event', esc(ev.title))
      body += row('When', ev.slot)
      body += row('Guests', `${ev.pax}`)
      body += row('Setup', ev.setup.replace('-', ' '))
      if (god) body += row('Value · paid', `${inr(ev.value)} · ${inr(ev.advance)}`)
    } else {
      head = tonePill('Available', '--st-vacant')
      const next = store.events.filter((e) => e.spaceId === id && e.date > store.date).sort((a, b) => a.date.localeCompare(b.date))[0]
      body += row('Next booking', next ? `${fmtDay(next.date)} · ${esc(next.kind)}` : 'None in 60 days')
    }
  } else if (s.type === 'kitchen') {
    const open = store.orders.filter((o) => o.status !== 'served')
    const late = store.isToday ? open.filter((o) => minutesOpen(o) > 20).length : 0
    head = late ? tonePill(`${late} late`, '--st-departing') : tonePill('On time', '--st-vacant')
    body += row('New', `${open.filter((o) => o.status === 'placed').length}`)
    body += row('Cooking', `${open.filter((o) => o.status === 'cooking').length}`)
    body += row('Ready to send', `${open.filter((o) => o.status === 'ready').length}`)
    body += row('KOTs on this date', `${store.orders.length}`)
  } else if (s.type === 'restaurant') {
    const t = store.orders.filter((o) => o.kind === 'table')
    body += row('Table orders', `${t.length}`)
    body += row('Open now', `${store.isToday ? t.filter((o) => o.status !== 'served').length : 0}`)
    if (god) body += row('F&B sales', inr(t.reduce((a, o) => a + orderTotal(o), 0)))
  } else if (s.type === 'reception') {
    const k = store.kpis()
    body += row('Arrivals', `${k.arrivals}`)
    body += row('Departures', `${k.departures}`)
    body += row('In-house guests', `${k.guests}`)
  } else if (s.type === 'pool') {
    const c = poolCount(store)
    body += row('Hours', '07:00 – 19:00')
    body += row('In the pool now', c == null ? '—' : c === 0 ? 'Closed' : `~${c}`)
  } else {
    body += `<div class="tip-meta">Back-of-house area. Housekeeping and maintenance tickets attach here in Phase 3.</div>`
  }
  return `
    <div class="tip-head"><div><div class="tip-name">${esc(s.name)}</div><div class="tip-meta">${esc(kindLabel(s))}</div></div>${head}</div>
    ${body}
    ${touch ? `<button class="btn primary tip-open" data-open="${esc(id)}" type="button">Open details</button>` : ''}`
}

// ---------------- drawer ----------------

function gantt(store: Store, id: string) {
  const start = addDays(store.date, -3)
  const days = Array.from({ length: 14 }, (_, i) => addDays(start, i))
  const end = addDays(start, 14)
  const idx = (d: string) => Math.round((+new Date(d + 'T12:00') - +new Date(start + 'T12:00')) / 864e5)
  const bars = store.reservations
    .filter((r) => r.spaceId === id && r.departure > start && r.arrival < end && r.status !== 'cancelled')
    .map((r) => {
      const a = Math.max(0, idx(r.arrival) + 0.5), b = Math.min(14, idx(r.departure) + 0.5)
      return `<div class="gantt-bar ${r.departure <= todayKey() ? 'past' : ''}" style="left:${(a / 14) * 100}%;width:${((b - a) / 14) * 100}%" title="${esc(r.guest)}">${esc(r.guest.split(' ')[0])}</div>`
    }).join('')
  return `
    <div class="gantt">
      <div class="gantt-days">${days.map((d) => `<span class="${d === store.date ? 'sel' : ''}">${fmtDay(d, { day: 'numeric' })}</span>`).join('')}</div>
      <div class="gantt-lane">${bars}<div class="gantt-sel" style="left:${(3 / 14) * 100}%;width:${100 / 14}%"></div></div>
    </div>`
}

function guestBlock(store: Store, r: Reservation, title: string) {
  const god = store.godMode
  return `
    <div class="guest">
      <div class="dr-kicker">${title}</div>
      <div class="guest-name">${esc(r.guest)} ${r.vip ? '<span class="vip">VIP</span>' : ''}</div>
      <dl class="kv">
        <dt>Booking</dt><dd class="mono">${r.id} · ${esc(r.source)}</dd>
        <dt>Phone</dt><dd class="mono">${esc(maskPhone(r.phone, god))}</dd>
        <dt>Guests</dt><dd>${r.pax}</dd>
        <dt>Check-in</dt><dd>${fmtDay(r.arrival)} · ${r.checkInAt ? 'in at ' + fmtTime(r.checkInAt) : 'ETA ' + r.eta}</dd>
        <dt>Check-out</dt><dd>${fmtDay(r.departure)} · ${r.checkOutAt ? 'out at ' + fmtTime(r.checkOutAt) : 'by 11:00'}</dd>
        <dt>Nights</dt><dd>${nights(r)}</dd>
        ${god ? `<dt>Rate</dt><dd>${inr(r.rate)} / night</dd><dt>Balance due</dt><dd>${r.balance ? inr(r.balance) : 'Settled'}</dd>` : ''}
      </dl>
      ${r.notes ? `<div class="note">${esc(r.notes)}</div>` : ''}
      ${actionsFor(store, r)}
    </div>`
}

function actionsFor(store: Store, r: Reservation) {
  if (!store.isToday) return ''
  const btns: string[] = []
  if (r.status === 'confirmed' && r.arrival === store.date) btns.push(`<button class="btn primary" data-act="checkin" data-res="${r.id}">Check in</button>`)
  if (r.status === 'in-house') btns.push(`<button class="btn" data-act="checkout" data-res="${r.id}">Check out</button>`)
  if (store.live && r.folioId && (r.status === 'in-house' || r.status === 'confirmed')) btns.push(`<button class="btn" data-act="pay" data-res="${r.id}">Payment</button>`)
  if (!store.live && store.godMode && r.balance && r.status !== 'checked-out') btns.push(`<button class="btn god" data-act="waive" data-res="${r.id}">Waive ${inr(r.balance)}</button>`)
  return btns.length ? `<div class="actions">${btns.join('')}</div>` : ''
}

function ordersList(store: Store, id: string) {
  const list = store.ordersFor(id)
  if (!list.length) return `<div class="empty">No room-service orders on this date.</div>`
  return list.map((o) => kotCard(store, o.id)).join('')
}

export function kotCard(store: Store, orderId: string, withFrom = false) {
  const o = store.orders.find((x) => x.id === orderId)!
  const age = Math.round(minutesOpen(o))
  const live = store.isToday && o.status !== 'served'
  const late = live && age > 20
  const next = { placed: 'Start cooking', cooking: 'Mark ready', ready: 'Mark served', served: '' }[o.status]
  const color = { placed: '--st-arriving', cooking: '--st-occupied', ready: '--st-vacant', served: '--st-ooo' }[o.status]
  return `
    <div class="kot" style="--c: var(${color})">
      <div class="kot-head"><span class="kot-id">${o.id}</span><span class="kot-age" ${late ? 'data-late' : ''}>${live ? age + ' min' : fmtTime(o.placedAt)}</span></div>
      ${withFrom ? `<div class="kot-from" data-focus="${esc(o.kind === 'table' ? 'RESTAURANT' : o.origin)}">${esc(o.originLabel)}</div>` : ''}
      <div class="kot-items">${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</div>
      <div class="kot-foot">
        <span class="pill" style="--c: var(${color})">${o.status}</span>
        ${store.godMode ? `<span class="mono">${inr(orderTotal(o))}</span>` : ''}
        ${live && next ? `<button class="btn small" data-act="advance" data-order="${o.id}">${next}</button>` : ''}
      </div>
    </div>`
}

export function drawerHtml(store: Store, id: string) {
  const st = store.state(id)
  const s = st.space
  const god = store.godMode
  let body = ''
  if (s.type === 'room' || s.type === 'villa') {
    body += `<div class="sec-title">Next 14 days</div>${gantt(store, id)}`
    if (st.departing && st.departing !== st.stay) body += guestBlock(store, st.departing, 'Checking out')
    if (st.stay) body += guestBlock(store, st.stay, st.status === 'arriving' ? 'Arriving' : 'In-house')
    if (!st.stay && !st.departing) {
      const n = nextStay(store, id)
      body += `<div class="guest"><div class="dr-kicker">Vacant on ${fmtDay(store.date)}</div><div class="note">${n ? `Next: ${esc(n.guest)}, arriving ${fmtDay(n.arrival)}` : 'No upcoming bookings in the next 60 days.'}</div></div>`
    }
    if (store.isToday && store.live) {
      body += `<div class="sec-title">Housekeeping</div><div class="empty">Live room cleaning status arrives with the housekeeping module (Phase 4).</div>`
    } else if (store.isToday) {
      const hk = store.hk[id] ?? 'clean'
      body += `<div class="sec-title">Housekeeping <span>${hkPill(hk)}</span></div><div class="actions">`
      if (hk === 'out-of-order') body += god ? `<button class="btn god" data-act="hk" data-space="${id}" data-hk="clean">Return to service</button>` : `<span class="actions-note">Only the owner can release an out-of-order room.</span>`
      else {
        if (hk !== 'dirty') body += `<button class="btn" data-act="hk" data-space="${id}" data-hk="dirty">Mark dirty</button>`
        if (hk !== 'clean') body += `<button class="btn" data-act="hk" data-space="${id}" data-hk="clean">Mark clean</button>`
        if (hk !== 'inspected') body += `<button class="btn" data-act="hk" data-space="${id}" data-hk="inspected">Mark inspected</button>`
      }
      body += `</div>`
    }
    body += `<div class="sec-title">Room service</div>${ordersList(store, id)}`
  } else if (['hall', 'lawn', 'pavilion', 'ground'].includes(s.type)) {
    const evs = st.events
    body += `<div class="sec-title">${fmtDay(store.date)}</div>`
    body += evs.length ? evs.map((e) => `
      <div class="guest">
        <div class="dr-kicker">${esc(e.kind)}</div>
        <div class="guest-name">${esc(e.title)}</div>
        <dl class="kv">
          <dt>Client</dt><dd>${esc(e.client)}</dd>
          <dt>Time</dt><dd>${e.slot}</dd>
          <dt>Guests</dt><dd>${e.pax}</dd>
          <dt>Setup</dt><dd>${e.setup.replace('-', ' ')}</dd>
          ${god ? `<dt>Contract</dt><dd>${inr(e.value)}</dd><dt>Advance paid</dt><dd>${inr(e.advance)}</dd><dt>Outstanding</dt><dd>${inr(e.value - e.advance)}</dd>` : ''}
        </dl>
      </div>`).join('') : `<div class="empty">Free on this date.</div>`
    const upcoming = store.events.filter((e) => e.spaceId === id && e.date > store.date).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8)
    body += `<div class="sec-title">Upcoming</div>` + (upcoming.length ? upcoming.map((e) => `
      <div class="row-card" data-date="${e.date}"><div class="rc-title">${esc(e.title)}</div><div class="rc-sub">${fmtDay(e.date)} · ${e.slot}</div><div class="rc-right"><span class="mono">${e.pax} pax</span>${god ? `<span class="mono">${inr(e.value)}</span>` : ''}</div></div>`).join('') : `<div class="empty">Nothing booked.</div>`)
  } else if (s.type === 'kitchen' || s.type === 'restaurant') {
    const list = (s.type === 'restaurant' ? store.orders.filter((o) => o.kind === 'table') : store.orders).slice().reverse()
    const open = list.filter((o) => o.status !== 'served')
    body += `<div class="sec-title">Open orders <span>${open.length}</span></div>` + (open.length ? open.map((o) => kotCard(store, o.id, true)).join('') : `<div class="empty">No open orders.</div>`)
    body += `<div class="sec-title">Served <span>${list.length - open.length}</span></div>` + list.filter((o) => o.status === 'served').slice(0, 12).map((o) => kotCard(store, o.id, true)).join('')
  } else {
    body += `<div class="note" style="margin-top:12px">${tipHtml(store, id, false)}</div>`
  }

  const head = (s.type === 'room' || s.type === 'villa') ? statusPill(st.status) : ''
  return `
    <div class="dr-head">
      <div>
        <div class="dr-kicker">${esc(s.type === 'room' ? 'Park Wing' : s.type)}${s.hmsRoomNo ? ` · HMS room ${esc(s.hmsRoomNo)}` : ''}</div>
        <div class="dr-title">${esc(s.name)}</div>
        <div class="tip-meta">${esc(kindLabel(s))} ${head}</div>
      </div>
      <button class="dr-close" type="button" data-close aria-label="Close">✕</button>
    </div>
    ${s.verify ? `<div class="verify">Location and use traced from the satellite image. Confirm on site.</div>` : ''}
    ${body}
    ${store.isToday && !store.live ? `<div class="actions-note">Actions update the sample HMS. From Phase 4 they write back to the live HMS and are recorded in the audit log.</div>` : ''}`
}
