import type { Layer, Store } from '../data/store'
import { fmtDay, inr, todayKey } from '../data/dates'

// Layers, legend, KPI strip and the date scrubber.

const LAYERS: { id: Layer; label: string; god?: boolean }[] = [
  { id: 'rooms', label: 'Occupancy' },
  { id: 'fnb', label: 'Food & KOTs' },
  { id: 'events', label: 'Events' },
  { id: 'housekeeping', label: 'Housekeeping' },
  { id: 'revenue', label: 'Revenue', god: true },
]

export function layersHtml(store: Store) {
  return `<div class="layers-title">Layers</div>` + LAYERS.map((l) => {
    const locked = l.god && !store.godMode
    return `<button class="layer" type="button" data-layer="${l.id}" aria-pressed="${store.layers.has(l.id)}" ${locked ? 'disabled title="Unlock God Mode to see revenue"' : ''}>
      <span class="sw"></span>${l.label}${locked ? '<span class="lock">OWNER</span>' : ''}</button>`
  }).join('')
}

export function legendHtml(store: Store) {
  const i = (v: string, t: string) => `<span><i style="background: var(${v})"></i>${t}</span>`
  if (store.layers.has('housekeeping')) return i('--st-vacant', 'Clean') + i('--st-inspected', 'Inspected') + i('--st-dirty', 'Dirty') + i('--st-ooo', 'Out of order')
  if (store.layers.has('revenue')) return `<span>Room revenue tonight</span><span>₹0 <span class="ramp"></span> ₹11k</span>`
  if (store.layers.has('rooms')) return i('--st-vacant', 'Vacant') + i('--st-arriving', 'Arriving') + i('--st-occupied', 'In-house') + i('--st-departing', 'Departing') + (store.isToday ? i('--st-dirty', 'To clean') : '') + i('--st-ooo', 'Out of order')
  return `<span class="muted">Pick a layer to colour the rooms</span>`
}

export function kpisHtml(store: Store) {
  const k = store.kpis()
  const tile = (label: string, value: string, sub = '', tone = '', cls = '') =>
    `<div class="kpi ${cls}" ${tone ? `data-tone="${tone}"` : ''}><div class="kpi-l">${label}</div><div class="kpi-v">${value}${sub ? `<small>${sub}</small>` : ''}</div></div>`
  let h = tile('Occupancy', `${Math.round(k.occupancy * 100)}%`, `${k.occupied}/${k.sellable}`)
  h += tile('Arrivals', `${k.arrivals}`)
  h += tile('Departures', `${k.departures}`)
  h += tile('In-house', `${k.guests}`, 'guests')
  if (store.isToday) h += tile('Open KOTs', `${k.openKots}`, k.lateKots ? `${k.lateKots} late` : '', k.lateKots ? 'alert' : '')
  h += tile('Events', `${k.events}`)
  if (store.isToday) h += tile('To clean', `${k.dirty}`)
  if (store.godMode) {
    h += tile('Room revenue', inr(k.roomRev), '', '', 'god')
    h += tile('ADR', inr(Math.round(k.adr)), '', '', 'god')
    h += tile('F&amp;B', inr(k.fnb), '', '', 'god')
    h += tile('Events value', inr(k.eventRev), '', '', 'god')
  } else {
    h += `<div class="kpi locked">Revenue figures need God Mode</div>`
  }
  return h
}

let seriesCache: { key: string; html: string } | null = null

export function timelineHtml(store: Store) {
  const today = todayKey()
  const series = store.occupancySeries()
  const key = series.map((s) => s.occ.toFixed(2) + s.events).join() + today
  if (!seriesCache || seriesCache.key !== key) {
    const bars = series.map((s) => {
      const dow = new Date(s.date + 'T12:00').getDay()
      const cls = [s.date < today ? 'past' : '', s.date === today ? 'today' : '', dow === 0 || dow === 6 ? 'weekend' : ''].join(' ')
      return `<div class="tl-bar ${cls}" data-date="${s.date}"><i style="height:${Math.max(6, s.occ * 82)}%"></i>${s.events >= 2 ? '<b></b>' : ''}</div>`
    }).join('')
    const months = series.map((s, i) => (s.date.endsWith('-01') ? `<span class="tl-month" style="left:${(i / series.length) * 100}%">${fmtDay(s.date, { month: 'short' })}</span>` : '')).join('')
    seriesCache = { key, html: bars + months }
  }
  const idx = series.findIndex((s) => s.date === store.date)
  const left = ((idx + 0.5) / series.length) * 100
  const label = store.date === today ? 'Today' : fmtDay(store.date)
  return seriesCache.html + `<div class="tl-sel" style="left:${left}%"><span>${label}</span></div>`
}
