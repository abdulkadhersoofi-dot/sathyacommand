import { MockAdapter } from './data/adapters/mock'
import { HttpAdapter } from './data/adapters/http'
import type { HmsAdapter } from './data/adapters/HmsAdapter'
import { Store, type Layer } from './data/store'
import type { DomainEvent, HkStatus } from './data/types'
import { addDays, fmtDay, inr, todayKey } from './data/dates'
import { World } from './scene/World'
import { $, toast } from './ui/dom'
import { drawerHtml, tipHtml } from './ui/cards'
import { sideHtml, type Tab } from './ui/side'
import { kpisHtml, layersHtml, legendHtml, timelineHtml } from './ui/dock'

// Phase 1 runs on the mock HMS. Set VITE_GATEWAY_URL to point at the
// Resort Gateway and the same UI runs on live data.
const gateway = import.meta.env.VITE_GATEWAY_URL as string | undefined
const adapter: HmsAdapter = gateway ? new HttpAdapter(gateway) : new MockAdapter()
const store = new Store(adapter)

let tab: Tab = 'live'
let tipId: string | null = null
let tipTouch = false
let drawerId: string | null = null
const fresh = new Set<string>()

const stage = $('#stage')
const tip = $('#tip')
const drawer = $('#drawer')

const world = new World(stage, $('#labels'), store, {
  onHover(id, x, y) {
    if (tipTouch) return
    world.highlight(id ?? drawerId)
    showTip(id, x, y, false)
  },
  onTap(id, x, y, pointer) {
    if (pointer === 'mouse') {
      hideTip()
      if (id) openDrawer(id)
      else closeDrawer()
      return
    }
    if (!id) { hideTip(); world.highlight(drawerId); return }
    world.highlight(id)
    showTip(id, x, y, true)
  },
  onFocus(id) {
    world.focus(id)
    syncExplode()
    openDrawer(id)
  },
})

// ---------- tooltip ----------
function showTip(id: string | null, x: number, y: number, touch: boolean) {
  tipId = id
  tipTouch = touch && !!id
  if (!id) { tip.hidden = true; return }
  tip.innerHTML = tipHtml(store, id, touch)
  tip.classList.toggle('touch', touch)
  tip.hidden = false
  if (!touch) {
    const r = stage.getBoundingClientRect()
    const w = tip.offsetWidth, h = tip.offsetHeight
    let left = x - r.left + 18, top = y - r.top + 18
    if (left + w > r.width - 8) left = x - r.left - w - 18
    if (top + h > r.height - 8) top = Math.max(8, y - r.top - h - 18)
    tip.style.left = `${Math.max(8, left)}px`
    tip.style.top = `${top}px`
  }
}
function hideTip() { tip.hidden = true; tipId = null; tipTouch = false }
tip.addEventListener('click', (e) => {
  const open = (e.target as HTMLElement).closest<HTMLElement>('[data-open]')
  if (open) { openDrawer(open.dataset.open!); hideTip() }
})

// ---------- drawer ----------
function openDrawer(id: string) {
  drawerId = id
  store.select(id)
  world.highlight(id)
  renderDrawer()
  drawer.classList.add('open')
  drawer.setAttribute('aria-hidden', 'false')
  $('#side').classList.remove('open')
}
function closeDrawer() {
  drawerId = null
  store.select(null)
  drawer.classList.remove('open')
  drawer.setAttribute('aria-hidden', 'true')
  world.highlight(null)
}
function renderDrawer() {
  if (!drawerId) return
  const scroll = $('#drawer-inner').scrollTop
  $('#drawer-inner').innerHTML = drawerHtml(store, drawerId)
  $('#drawer-inner').scrollTop = scroll
}

// ---------- panels ----------
function renderSide() {
  const body = $('#side-body')
  const scroll = body.scrollTop
  body.innerHTML = sideHtml(store, tab, fresh)
  body.scrollTop = scroll
  fresh.clear()
  const k = store.kpis()
  const c = $('#kot-count')
  c.textContent = store.isToday ? String(k.openKots) : ''
  c.toggleAttribute('data-late', k.lateKots > 0)
}

function renderChrome() {
  $('#layers').innerHTML = layersHtml(store)
  $('#legend').innerHTML = legendHtml(store)
  $('#kpis').innerHTML = kpisHtml(store)
  $('#tl-track').innerHTML = timelineHtml(store)
  const chip = $('#date-chip')
  const diff = Math.round((+new Date(store.date + 'T12:00') - +new Date(todayKey() + 'T12:00')) / 864e5)
  chip.textContent = diff === 0 ? `Today · ${fmtDay(store.date)}` : `${fmtDay(store.date)} · ${diff > 0 ? `in ${diff} day${diff > 1 ? 's' : ''}` : `${-diff} day${diff < -1 ? 's' : ''} ago`}`
  chip.toggleAttribute('data-past', diff < 0)
  chip.toggleAttribute('data-future', diff > 0)
  $('#tl-track').setAttribute('aria-valuetext', fmtDay(store.date))
}

function renderAll() {
  world.refresh()
  renderChrome()
  renderSide()
  renderDrawer()
  if (tipId && !tip.hidden) tip.innerHTML = tipHtml(store, tipId, tipTouch)
}

store.on((why, payload) => {
  if (why === 'select') return
  if (why === 'live') {
    const e = payload as DomainEvent
    if (store.feed[0]) fresh.add(store.feed[0].id)
    if (store.isToday) animate(e)
  }
  renderAll()
})

function animate(e: DomainEvent) {
  if (e.type === 'order.created' && store.layers.has('fnb')) world.overlays.orderArc(e.order)
  if (e.type === 'order.updated' && e.order.status === 'ready' && store.layers.has('fnb')) world.overlays.foodRunner(e.order)
  if (e.type === 'reservation.updated') world.overlays.guestMove(e.reservation, e.change)
}

// ---------- interactions ----------
document.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement
  const layer = t.closest<HTMLElement>('[data-layer]')
  if (layer) { store.toggleLayer(layer.dataset.layer as Layer); return }

  const act = t.closest<HTMLElement>('[data-act]')
  if (act) {
    e.stopPropagation()
    const { act: a, res, order, space, hk } = act.dataset
    if (a === 'checkin') { await adapter.checkIn(res!); toast('Checked in') }
    if (a === 'checkout') { await adapter.checkOut(res!); toast('Checked out. Room sent to housekeeping') }
    if (a === 'advance') await adapter.advanceOrder(order!)
    if (a === 'hk') {
      await adapter.setHousekeeping(space!, hk as HkStatus)
      if (store.godMode && hk === 'clean' && act.textContent?.includes('Return')) {
        store.logAudit(`Returned ${store.spaceById.get(space!)?.name} to service`)
        store.invalidate('audit')
      }
      toast(`Marked ${hk}`)
    }
    if (a === 'waive') {
      const r = store.reservations.find((x) => x.id === res)!
      store.logAudit(`Waived ${inr(r.balance)} for ${r.guest} (${r.id})`)
      r.balance = 0
      store.invalidate('audit')
      toast('Balance waived and logged')
    }
    return
  }

  if (t.closest('[data-close]')) { closeDrawer(); return }

  const dateGo = t.closest<HTMLElement>('[data-date]')
  const focusGo = t.closest<HTMLElement>('[data-focus]')
  if (dateGo && !t.closest('#tl-track')) await store.setDate(dateGo.dataset.date!)
  if (focusGo) {
    const id = focusGo.dataset.focus!
    if (store.spaceById.has(id)) { world.focus(id); syncExplode(); openDrawer(id) }
    return
  }
  const tabGo = t.closest<HTMLElement>('[data-tab-go]')
  if (tabGo) setTab(tabGo.dataset.tabGo as Tab)
  const layerGo = t.closest<HTMLElement>('[data-layer-go]')
  if (layerGo) store.toggleLayer(layerGo.dataset.layerGo as Layer)
})

function setTab(t: Tab) {
  tab = t
  document.querySelectorAll<HTMLElement>('#tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)))
  renderSide()
}
$('#tabs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')
  if (b) { setTab(b.dataset.tab as Tab); $('#side').classList.add('open') }
})
$('#side-grip').addEventListener('click', () => $('#side').classList.toggle('open'))

// timeline scrubbing
const track = $('#tl-track')
let scrubbing = false
const dateAt = (x: number) => {
  const r = track.getBoundingClientRect()
  const bars = track.querySelectorAll<HTMLElement>('.tl-bar')
  const i = Math.max(0, Math.min(bars.length - 1, Math.floor(((x - r.left) / r.width) * bars.length)))
  return bars[i]?.dataset.date
}
track.addEventListener('pointerdown', (e) => { scrubbing = true; track.setPointerCapture(e.pointerId); const d = dateAt(e.clientX); if (d) store.setDate(d) })
track.addEventListener('pointermove', (e) => { if (!scrubbing) return; const d = dateAt(e.clientX); if (d) store.setDate(d) })
track.addEventListener('pointerup', () => (scrubbing = false))
track.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') stepDay(-1)
  if (e.key === 'ArrowRight') stepDay(1)
})
function stepDay(n: number) {
  const d = addDays(store.date, n)
  if (d >= store.rangeFrom && d <= store.rangeTo) store.setDate(d)
}
$('#tl-prev').addEventListener('click', () => stepDay(-1))
$('#tl-next').addEventListener('click', () => stepDay(1))
$('#tl-today').addEventListener('click', () => store.setDate(todayKey()))
$('#date-chip').addEventListener('click', () => store.setDate(todayKey()))

// map tools
$('#btn-zoom-in').addEventListener('click', () => world.zoom(0.7))
$('#btn-zoom-out').addEventListener('click', () => world.zoom(1.4))
$('#btn-home').addEventListener('click', () => { world.home(); syncExplode() })
$('#btn-explode').addEventListener('click', () => { world.setExplode(!world.rooms.exploded); syncExplode() })
function syncExplode() { $('#btn-explode').setAttribute('aria-pressed', String(world.rooms.exploded)) }

const nightBtn = $('#btn-night')
nightBtn.setAttribute('aria-pressed', String(world.night))
nightBtn.addEventListener('click', () => { world.setNight(!world.night); nightBtn.setAttribute('aria-pressed', String(world.night)) })
const ecoBtn = $('#btn-eco')
ecoBtn.setAttribute('aria-pressed', String(world.eco))
ecoBtn.addEventListener('click', () => { world.setEco(!world.eco); ecoBtn.setAttribute('aria-pressed', String(world.eco)) })

// God Mode
const godBtn = $('#btn-god')
const modal = $('#pin-modal')
godBtn.addEventListener('click', () => {
  if (store.godMode) { store.setGodMode(false); godBtn.setAttribute('aria-pressed', 'false'); toast('God Mode off'); return }
  modal.hidden = false
  $('#pin-error').hidden = true
  const input = $<HTMLInputElement>('#pin-input')
  input.value = ''
  input.focus()
})
$('#pin-cancel').addEventListener('click', () => (modal.hidden = true))
$('#pin-form').addEventListener('submit', (e) => {
  e.preventDefault()
  if ($<HTMLInputElement>('#pin-input').value !== '1234') { $('#pin-error').hidden = false; return }
  modal.hidden = true
  store.setGodMode(true)
  godBtn.setAttribute('aria-pressed', 'true')
  toast('God Mode on: revenue, rates and owner actions unlocked')
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!modal.hidden) modal.hidden = true; else if (drawerId) closeDrawer(); else hideTip() }
})

// clock + ageing KOTs
function tick() {
  $('#clock').textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}
tick()
setInterval(tick, 15000)
setInterval(() => { if (store.isToday) { store.invalidate('clock') } }, 30000)
setTimeout(() => $('#hint').style.opacity = '0', 9000)

$('#source-label').textContent = `Sathya Park & Resorts · ${adapter.name}`
store.load().then(renderAll).catch((err) => toast(`Couldn't load HMS data: ${err.message}`))
