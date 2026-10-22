import { minutesOpen, type Store } from '../data/store'
import { addDays, fmtDay, fmtTime, inr } from '../data/dates'
import { esc, statusPill, tonePill } from './dom'
import { kotCard } from './cards'

// Right-hand rail: live feed, front desk, kitchen board, events.

export type Tab = 'live' | 'arrivals' | 'kitchen' | 'events'

const FEED_COLOR: Record<string, string> = {
  kot: '--marigold', checkin: '--st-occupied', checkout: '--st-departing', hk: '--st-dirty', alert: '--god',
}

export function sideHtml(store: Store, tab: Tab, freshIds: Set<string>) {
  if (tab === 'live') return liveHtml(store, freshIds)
  if (tab === 'arrivals') return deskHtml(store)
  if (tab === 'kitchen') return kitchenHtml(store)
  return eventsHtml(store)
}

function liveHtml(store: Store, fresh: Set<string>) {
  let h = ''
  const k = store.kpis()
  const alerts: string[] = []
  if (store.isToday) {
    if (k.lateKots) alerts.push(`<div class="row-card" data-focus="KITCHEN"><div class="rc-title">${k.lateKots} KOT${k.lateKots > 1 ? 's' : ''} over 20 minutes</div><div class="rc-sub">Main Kitchen</div><div class="rc-right">${tonePill('Late', '--st-departing')}</div></div>`)
    const overdue = store.reservations.filter((r) => r.departure === store.date && r.status === 'in-house')
    if (new Date().getHours() >= 11 && overdue.length) alerts.push(`<div class="row-card" data-tab-go="arrivals"><div class="rc-title">${overdue.length} late check-out${overdue.length > 1 ? 's' : ''}</div><div class="rc-sub">Past 11:00 and still in-house</div><div class="rc-right">${tonePill('Overdue', '--st-departing')}</div></div>`)
    if (k.dirty) alerts.push(`<div class="row-card" data-layer-go="housekeeping"><div class="rc-title">${k.dirty} room${k.dirty > 1 ? 's' : ''} to clean</div><div class="rc-sub">Show the housekeeping layer</div><div class="rc-right">${tonePill('Housekeeping', '--st-dirty')}</div></div>`)
  }
  if (alerts.length) h += `<div class="sec-title">Needs attention</div>${alerts.join('')}`
  if (store.godMode) {
    h += `<div class="sec-title">Owner audit log</div>` + (store.audit.length
      ? `<ul class="feed">${store.audit.slice(0, 8).map((a) => `<li><span class="t">${fmtTime(a.at.toISOString())}</span><span class="dot" style="--c: var(--god)"></span><span class="x">${esc(a.text)}</span></li>`).join('')}</ul>`
      : `<div class="empty">No owner actions this session.</div>`)
  }
  h += `<div class="sec-title">Live activity ${store.isToday ? '' : `<span>shows today</span>`}</div>`
  h += store.feed.length ? `<ul class="feed">${store.feed.slice(0, 40).map((f) => `
    <li class="${fresh.has(f.id) ? 'fresh' : ''}" ${f.spaceId ? `data-focus="${esc(f.spaceId.startsWith('T') ? 'RESTAURANT' : f.spaceId)}"` : ''}>
      <span class="t">${fmtTime(f.at.toISOString())}</span><span class="dot" style="--c: var(${FEED_COLOR[f.kind]})"></span><span class="x">${esc(f.text)}</span>
    </li>`).join('')}</ul>` : `<div class="empty">Waiting for activity…</div>`
  return h
}

function deskHtml(store: Store) {
  const d = store.date
  const arr = store.reservations.filter((r) => r.arrival === d && r.status !== 'cancelled').sort((a, b) => (a.eta ?? '').localeCompare(b.eta ?? ''))
  const dep = store.reservations.filter((r) => r.departure === d && r.status !== 'cancelled')
  const card = (r: typeof arr[number], mode: 'in' | 'out') => {
    const sp = store.spaceById.get(r.spaceId)!
    const done = mode === 'in' ? r.status !== 'confirmed' : r.status === 'checked-out'
    const pill = mode === 'in'
      ? (done ? statusPill('occupied').replace('In-house', 'Checked in') : statusPill('arriving'))
      : (done ? tonePill('Checked out', '--st-ooo') : statusPill('departing'))
    const time = mode === 'in' ? (r.checkInAt && done ? 'in ' + fmtTime(r.checkInAt) : 'ETA ' + r.eta) : (r.checkOutAt ? 'out ' + fmtTime(r.checkOutAt) : 'by 11:00')
    return `<div class="row-card" data-focus="${sp.id}">
      <div class="rc-title">${r.vip ? '<span class="vip">VIP</span> ' : ''}${esc(r.guest)}</div>
      <div class="rc-sub">${esc(sp.name)} · ${r.pax} pax · ${esc(r.source)}${store.godMode && r.balance ? ` · due ${inr(r.balance)}` : ''}</div>
      <div class="rc-right">${pill}<span class="mono">${time}</span></div></div>`
  }
  return `
    <div class="sec-title">Arrivals · ${fmtDay(d)} <span>${arr.length}</span></div>
    ${arr.length ? arr.map((r) => card(r, 'in')).join('') : '<div class="empty">No arrivals.</div>'}
    <div class="sec-title">Departures <span>${dep.length}</span></div>
    ${dep.length ? dep.map((r) => card(r, 'out')).join('') : '<div class="empty">No departures.</div>'}`
}

function kitchenHtml(store: Store) {
  if (!store.isToday) {
    const n = store.orders.length
    return `<div class="sec-title">${fmtDay(store.date)}</div>` + (n
      ? `<div class="empty">${n} KOTs were raised on this date.${store.godMode ? ` F&amp;B sales ${inr(store.kpis().fnb)}.` : ''}</div>` + store.orders.slice(-15).reverse().map((o) => kotCard(store, o.id, true)).join('')
      : `<div class="empty">No orders yet. The kitchen board fills in on the day.</div>`)
  }
  // The kitchen's own columns: an order is "ready" until the waiter marks it served, then it leaves this list.
  const cols: [string, 'placed' | 'cooking' | 'ready'][] = [['New', 'placed'], ['Cooking', 'cooking'], ['Ready · waiting for the waiter', 'ready']]
  const served = store.orders.filter((o) => o.status === 'served').length
  return cols.map(([label, st]) => {
    const list = store.orders.filter((o) => o.status === st).sort((a, b) => minutesOpen(b) - minutesOpen(a))
    return `<div class="sec-title">${label} <span>${list.length}</span></div>` + (list.length ? list.map((o) => kotCard(store, o.id, true)).join('') : `<div class="empty">None</div>`)
  }).join('') + `<p class="muted small">${served ? `${served} order${served > 1 ? 's' : ''} served today. ` : ''}An order's place here is its slowest ticket: with two stations, it stays in Cooking until both are ready. The kitchen screen shows the tickets by station.</p>`
}

function eventsHtml(store: Store) {
  const today = store.events.filter((e) => e.date === store.date)
  const next = store.events.filter((e) => e.date > store.date && e.date <= addDays(store.date, 7)).sort((a, b) => a.date.localeCompare(b.date))
  const card = (e: typeof today[number], showDate: boolean) => `
    <div class="row-card" data-focus="${e.spaceId}" ${showDate ? `data-date="${e.date}"` : ''}>
      <div class="rc-title">${esc(e.title)}</div>
      <div class="rc-sub">${esc(store.spaceById.get(e.spaceId)!.name)} · ${showDate ? fmtDay(e.date) + ' · ' : ''}${e.slot}</div>
      <div class="rc-right"><span class="mono">${e.pax} pax</span>${store.godMode ? `<span class="mono">${inr(e.value)}</span>` : tonePill(e.setup.replace('-', ' '), e.setup === 'live' ? '--marigold' : '--muted')}</div>
    </div>`
  return `
    <div class="sec-title">${fmtDay(store.date)} <span>${today.length}</span></div>
    ${today.length ? today.map((e) => card(e, false)).join('') : '<div class="empty">No events on this date.</div>'}
    <div class="sec-title">Next 7 days <span>${next.length}</span></div>
    ${next.length ? next.map((e) => card(e, true)).join('') : '<div class="empty">Nothing booked.</div>'}`
}
