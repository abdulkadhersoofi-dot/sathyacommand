import { MockAdapter } from './data/adapters/mock'
import { LiveAdapter } from './data/adapters/live'
import type { HmsAdapter } from './data/adapters/HmsAdapter'
import { Api, serverAvailable } from './live/api'
import { signIn, type Me } from './live/signin'
import { FrontDesk } from './ui/frontdesk'
import { FnbWorkspace } from './fnb/workspace'
import { HkWorkspace } from './hk/workspace'
import { StaffWorkspace } from './staff/workspace'
import { EngWorkspace } from './eng/workspace'
import { SecurityWorkspace } from './sec/workspace'
import { InventoryWorkspace } from './inv/workspace'
import { AccountsWorkspace } from './acc/workspace'
import { EMERGENCY, type Emergency } from './sec/desk'
import { Outbox } from './live/outbox'
import { Store, type Layer } from './data/store'
import type { DomainEvent, HkStatus } from './data/types'
import { addDays, fmtDay, inr, setToday, todayKey } from './data/dates'
import { World } from './scene/World'
import { roleColour } from './scene/Overlays'
import { Studio } from './studio/studio'
import { defaultLayout, type SiteLayout } from './data/layout'
import { $, toast } from './ui/dom'
import { FormModal, val } from './ui/form-modal'
import { showDemoGuide } from './ui/demo-guide'
import { drawerHtml, tipHtml } from './ui/cards'
import { sideHtml, type Tab } from './ui/side'
import { kpisHtml, layersHtml, legendHtml, timelineHtml } from './ui/dock'

// When an HMS server answers (same address, or VITE_GATEWAY_URL), the app signs the user in and runs
// on live data. Otherwise (the hosted demo) it runs on the built-in sample resort.
const base = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? ''
const liveMode = await serverAvailable(base)
let api: Api | null = null
let me: Me | null = null
if (liveMode) {
  api = new Api(base)
  me = await signIn(api)
  setToday((await api.get<{ businessDate: string }>('/api/business-date')).businessDate)
}
// The resort drawing: the published Twin Studio version when live, the traced default otherwise.
const fetchLayout = async () => api ? (await api.get<{ layout: SiteLayout }>('/api/site')).layout : defaultLayout()
let layout = defaultLayout()
try { layout = await fetchLayout() } catch { /* keep the traced default */ }
const liveAdapter = api ? new LiveAdapter(api) : null
const adapter: HmsAdapter = liveAdapter ?? new MockAdapter()
const store = new Store(adapter)
store.live = liveMode
let fd: FrontDesk | null = null
let fnb: FnbWorkspace | null = null
let hkWs: HkWorkspace | null = null
let staffWs: StaffWorkspace | null = null
let engWs: EngWorkspace | null = null
let secWs: SecurityWorkspace | null = null
let invWs: InventoryWorkspace | null = null
let accWs: AccountsWorkspace | null = null

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
}, layout)

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
  body.innerHTML = fd && tab === 'arrivals' ? fd.html() : sideHtml(store, tab, fresh)
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
  if (why === 'site') { if (!studio.open) void refreshLayout(); return }
  if (why === 'hkchange' && hkWs?.open && !hkWs.modal.isOpen) void hkWs.refresh()
  if (why === 'layers') void loadStaff()
  if (why === 'eng') {
    if (engWs?.open && !engWs.modal.isOpen) void engWs.refresh()
    void loadEng()
  }
  if (why === 'layers') { void loadEng(); void loadSec() }
  if (why === 'security') {
    const e = payload as { action: string }
    if (secWs?.open && !secWs.modal.isOpen) void secWs.refresh()
    void loadSec()
    if (e.action.startsWith('security.emergency')) void checkEmergency()
    if (!['security.incident', 'security.patrol_missed', 'security.key_overdue', 'security.emergency_start', 'security.emergency_end', 'security.emergency_help'].includes(e.action)) return
  }
  if (why === 'staff') {
    const e = payload as { action: string; actor: string }
    if (staffWs?.open && !staffWs.modal.isOpen) void staffWs.refresh()
    if (e.action === 'staff.sos' && store.staffAllowed) {
      sosAlert(e.actor)
      if (!store.layers.has('staff')) store.toggleLayer('staff')
    }
    void loadStaff()
    if (e.action !== 'staff.sos') return
  }
  if (why === 'fnb') {
    // Another tablet changed an order or the menu: refresh the restaurant screen unless a form is open there.
    if (fnb?.open && !fnb.modal.isOpen) void fnb.refresh()
    if (!/^(kot|bot|order)/.test((payload as { action: string }).action)) return
  }
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
  if (e.type === 'snapshot.changed' && (e.action === 'reservation.check_in' || e.action === 'reservation.check_out')) {
    const r = store.reservations.find((x) => x.id === e.entityId)
    if (r?.spaceId) world.overlays.guestMove(r, e.action === 'reservation.check_in' ? 'check-in' : 'check-out')
  }
}

// ---------- staff on duty (managers and security) ----------
interface LiveStaff { user_id: string; name: string; roles: string | null; at: string | null; x: string | number | null; z: string | number | null; inside: boolean | null; sos: boolean }
async function loadStaff() {
  if (!api || !store.staffAllowed) return
  if (!store.layers.has('staff')) { world.setPins('staff', null); return }
  try {
    const rows = await api.get<LiveStaff[]>('/api/staff/live')
    world.setPins('staff', rows.filter((r) => r.x != null && r.z != null).map((r) => ({
      id: r.user_id, label: r.name, x: Number(r.x), z: Number(r.z), shape: 'person', colour: roleColour(r.roles ?? ''), pulse: r.sos,
      detail: r.sos ? '<b>SOS</b>' : r.inside === false ? 'Outside the boundary' : null, tone: r.sos ? 'alert' : r.inside === false ? 'event' : '',
      faded: !r.at || Date.now() - new Date(r.at).getTime() > 10 * 60_000,
    })))
  } catch { /* offline: keep the last pins */ }
}
setInterval(() => { if (!document.hidden) void loadStaff() }, 15_000)

/** An SOS stays on screen until someone opens it. */
function sosAlert(who: string) {
  let el = document.getElementById('sos-alert') as HTMLButtonElement | null
  if (!el) {
    el = document.createElement('button')
    el.id = 'sos-alert'
    el.type = 'button'
    el.className = 'sos-alert'
    el.setAttribute('role', 'alert')
    el.addEventListener('click', () => { el!.hidden = true; hideWorkspaces(); void staffWs?.show('team') })
    document.getElementById('app')!.appendChild(el)
  }
  el.textContent = `🚨 SOS from ${who}. Tap to see where and respond.`
  el.hidden = false
}

// ---------- maintenance layer (engineering) ----------
interface EngMap {
  assets: { id: string; name: string; category: string; open: number; pos: { x: number; z: number } | null }[]
  tickets: { id: string; title: string; priority: string; status: string; kind: string; reportedAt: string; escalation: number; pos: { x: number; z: number } | null }[]
}
const PRIORITY_COLOUR: Record<string, number> = { urgent: 0xe0533d, high: 0xe8a317, normal: 0x3b7be0, low: 0x8a8f98 }
async function loadEng() {
  if (!api || !store.engAllowed) return
  if (!store.layers.has('engineering')) { world.setPins('assets', null); world.setPins('faults', null); return }
  try {
    const m = await api.get<EngMap>('/api/eng/map')
    world.setPins('assets', m.assets.filter((a) => a.pos && !a.open).map((a) => ({ id: a.id, x: a.pos!.x, z: a.pos!.z, shape: 'dot', colour: 0x7f8ea3 })))
    world.setPins('faults', m.tickets.filter((k) => k.pos).map((k) => {
      const mins = Math.round((Date.now() - new Date(k.reportedAt).getTime()) / 60000)
      return { id: k.id, x: k.pos!.x, z: k.pos!.z, shape: 'marker', colour: PRIORITY_COLOUR[k.priority] ?? 0x8a8f98, label: k.title.length > 34 ? k.title.slice(0, 33) + '…' : k.title,
        detail: k.escalation ? `<b>Late</b> · ${mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`}` : k.status === 'on_hold' ? 'On hold' : null,
        tone: k.escalation ? 'alert' : '', pulse: k.priority === 'urgent' || k.escalation > 0 }
    }))
  } catch { /* offline: keep the last pins */ }
}
setInterval(() => { if (!document.hidden) void loadEng() }, 60_000)

// ---------- security layer, and emergency mode for everyone ----------
interface SecMap {
  cameras: { id: string; name: string; hasView: boolean; pos: { x: number; z: number } | null }[]
  checkpoints: { id: string; name: string; overdue: boolean; pos: { x: number; z: number } | null }[]
  incidents: { id: string; title: string; severity: string; pos: { x: number; z: number } | null }[]
  vehicles: { id: string; label: string | null; tag: string | null; pos: { x: number; z: number } }[]
  assemblyPoints: { id: string; name: string; pos: { x: number; z: number } }[]
}
let emergencyOn = false
async function loadSec() {
  if (!api || !store.secAllowed) return
  const off = !store.layers.has('security')
  if (off) { for (const l of ['cameras', 'checkpoints', 'incidents', 'vehicles']) world.setPins(l, null); if (!emergencyOn) world.setPins('assembly', null); return }
  try {
    const m = await api.get<SecMap>('/api/security/map')
    const has = <T extends { pos: { x: number; z: number } | null }>(l: T[]) => l.filter((x): x is T & { pos: { x: number; z: number } } => !!x.pos)
    world.setPins('cameras', has(m.cameras).map((c) => ({ id: c.id, x: c.pos.x, z: c.pos.z, shape: 'dot', colour: 0x3b7be0, label: `📹 ${c.name}`, clickable: true })))
    world.setPins('checkpoints', has(m.checkpoints).map((c) => ({ id: c.id, x: c.pos.x, z: c.pos.z, shape: 'dot', colour: c.overdue ? 0xe0533d : 0x35a46b,
      label: c.overdue ? c.name : undefined, detail: c.overdue ? '<b>Patrol missed</b>' : null, tone: c.overdue ? 'alert' : '', pulse: c.overdue })))
    world.setPins('incidents', has(m.incidents).map((i) => ({ id: i.id, x: i.pos.x, z: i.pos.z, shape: 'marker', colour: i.severity === 'low' ? 0xe8a317 : 0xe0533d,
      label: i.title.length > 34 ? i.title.slice(0, 33) + '…' : i.title, detail: i.severity === 'low' ? null : `<b>${i.severity}</b>`, tone: i.severity === 'low' ? 'event' : 'alert',
      pulse: i.severity === 'critical', clickable: true })))
    world.setPins('vehicles', m.vehicles.map((v) => ({ id: v.id, x: v.pos.x, z: v.pos.z, shape: 'dot', colour: 0xf6d34a })))
    world.setPins('assembly', m.assemblyPoints.map((p) => ({ id: p.id, x: p.pos.x, z: p.pos.z, shape: 'marker', colour: 0x35a46b, label: `Assembly: ${p.name}` })))
  } catch { /* offline: keep the last pins */ }
}
setInterval(() => { if (!document.hidden) void loadSec() }, 30_000)

/** An emergency shows on every signed-in screen until it is ended, with the person's own roll-call answer. */
async function checkEmergency() {
  if (!api) return
  let e: Emergency
  try { e = await api.get<Emergency>('/api/security/emergency') } catch { return }
  let el = document.getElementById('em-banner')
  emergencyOn = !!e.active
  if (!e.active) { if (el) el.hidden = true; if (!store.layers.has('security')) world.setPins('assembly', null); return }
  if (!el) {
    el = document.createElement('div')
    el.id = 'em-banner'
    el.className = 'em-banner'
    el.setAttribute('role', 'alert')
    el.addEventListener('click', async (ev) => {
      const a = (ev.target as HTMLElement).closest<HTMLElement>('[data-emb]')?.dataset.emb
      if (!a) return
      if (a === 'open') { hideWorkspaces(); void secWs?.show('emergency'); return }
      const r = await api!.post('/api/security/emergency/check', { status: a }).catch((x: Error) => { toast(x.message); return null })
      if (r) { toast(a === 'safe' ? 'Marked safe' : 'Security has been told you need help'); void checkEmergency() }
    })
    document.getElementById('app')!.appendChild(el)
  }
  const mine = e.mine?.status
  el.innerHTML = `<span>🚨 ${EMERGENCY[e.active.kind] ?? 'Emergency'}${e.active.note ? `: ${e.active.note.replace(/[<>&]/g, '')}` : ''}. Go to the nearest assembly point${e.points.length ? ` (${e.points.map((p) => p.name.replace(/[<>&]/g, '')).join(', ')})` : ''}.</span>
    ${mine === 'safe' ? '<span>You are marked safe.</span>' : '<button type="button" class="btn" data-emb="safe">I am safe</button>'}
    ${mine === 'need_help' ? '<span>Help is coming.</span>' : '<button type="button" class="btn" data-emb="need_help">I need help</button>'}
    <button type="button" class="btn ghost" data-emb="open">${e.counts ? `Roll-call ${e.counts.safe}/${e.counts.total}` : 'Details'}</button>`
  el.hidden = false
  // Everyone sees where to go.
  const pts = await api.get<{ id: string; name: string; x: string | null; z: string | null }[]>('/api/security/assembly-points').catch(() => [])
  world.setPins('assembly', pts.filter((p) => p.x != null).map((p) => ({ id: p.id, x: Number(p.x), z: Number(p.z), shape: 'marker', colour: 0x35a46b, label: `Assembly: ${p.name}`, pulse: true })))
}

function hideWorkspaces() { for (const w of [fnb, hkWs, staffWs, engWs, secWs, invWs, accWs]) if (w?.open) w.hide() }

// ---------- interactions ----------
document.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement
  const layer = t.closest<HTMLElement>('[data-layer]')
  if (layer) { store.toggleLayer(layer.dataset.layer as Layer); return }
  const hkRoom = t.closest<HTMLElement>('[data-hk-room]')
  if (hkRoom && hkWs && liveAdapter) { e.stopPropagation(); void hkWs.openRoom(liveAdapter.serverIdOf.get(hkRoom.dataset.hkRoom!) ?? hkRoom.dataset.hkRoom!); return }
  const pin = t.closest<HTMLElement>('[data-pin]')?.dataset.pin
  if (pin) {
    const [layer, id] = pin.split(':')
    if (layer === 'cameras' && secWs) void secWs.openCamera(id)
    if (layer === 'incidents' && secWs) { hideWorkspaces(); void secWs.openIncident(id) }
    if (layer === 'faults' && engWs) { hideWorkspaces(); void engWs.openTicket(id) }
    return
  }
  const engRoom = t.closest<HTMLElement>('[data-eng-room]')
  if (engRoom && engWs && liveAdapter) { e.stopPropagation(); engWs.report(liveAdapter.serverIdOf.get(engRoom.dataset.engRoom!) ?? engRoom.dataset.engRoom!, engRoom.dataset.engName ?? ''); return }
  const fnbOrder = t.closest<HTMLElement>('[data-fnb-order]')
  if (fnbOrder && fnb) { e.stopPropagation(); void fnb.openOrder(fnbOrder.dataset.fnbOrder!); return }
  const fdBtn = t.closest<HTMLElement>('[data-fd]')
  if (fdBtn && fd) { e.stopPropagation(); fd.handle(fdBtn); return }

  const act = t.closest<HTMLElement>('[data-act]')
  if (act) {
    e.stopPropagation()
    const { act: a, res, order, space, hk } = act.dataset
    if (fd) {
      if (a === 'checkin') void fd.checkIn(res!)
      if (a === 'checkout') void fd.checkOut(res!)
      if (a === 'pay') void fd.payment(res!)
      return
    }
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

// Twin Studio
const studioBtn = $('#btn-studio')
const studio = new Studio(world, api, me, (published) => {
  studioBtn.setAttribute('aria-pressed', 'false')
  document.body.classList.remove('studio-on')
  if (published) void refreshLayout()
})
studioBtn.hidden = !Studio.allowed(me, liveMode)
studioBtn.addEventListener('click', () => {
  if (studio.open) { studio.exit(); return }
  closeDrawer(); hideTip(); $('#side').classList.remove('open')
  document.body.classList.add('studio-on')
  studioBtn.setAttribute('aria-pressed', 'true')
  void studio.enter()
})
async function refreshLayout() {
  try {
    world.rebuild(await fetchLayout())
    await store.reloadSpaces()
  } catch (err) { toast(`Couldn't load the new layout: ${(err as Error).message}`) }
}

// God Mode
const godBtn = $('#btn-god')
const modal = $('#pin-modal')
godBtn.addEventListener('click', () => {
  if (me) {
    // Live: God Mode belongs to the signed-in role (already verified with the authenticator), no PIN.
    store.setGodMode(!store.godMode)
    godBtn.setAttribute('aria-pressed', String(store.godMode))
    toast(store.godMode ? 'God Mode on' : 'God Mode off')
    return
  }
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
  if (e.key === 'Escape') {
    if (document.querySelector('.fd-modal:not([hidden])')) { document.querySelectorAll<HTMLElement>('.fd-modal:not([hidden])').forEach((m) => m.querySelector<HTMLElement>('[data-x]')?.click()); return }
    if (fnb?.open) { fnb.hide(); return }
    if (hkWs?.open) { hkWs.hide(); return }
    if (staffWs?.open) { staffWs.hide(); return }
    if (engWs?.open) { engWs.hide(); return }
    if (secWs?.open) { secWs.hide(); return }
    if (invWs?.open) { invWs.hide(); return }
    if (accWs?.open) { accWs.hide(); return }
    if (studio.open) return; if (!modal.hidden) modal.hidden = true; else if (fd && document.querySelector('.fd-modal:not([hidden])')) fd.close(); else if (drawerId) closeDrawer(); else hideTip() }
})

// clock + ageing KOTs
function tick() {
  $('#clock').textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}
tick()
setInterval(tick, 15000)
setInterval(() => { if (store.isToday) { store.invalidate('clock') } }, 30000)
setTimeout(() => $('#hint').style.opacity = '0', 9000)

$('#source-label').textContent = me ? `Sathya Park & Resorts · ${me.name}` : `Sathya Park & Resorts · ${adapter.name}`
// The hosted demo: say where the modules are, once on the first visit and whenever asked.
if (!liveMode) {
  const liveUrl = (import.meta.env.VITE_LIVE_URL as string | undefined) || undefined
  const guide = document.createElement('button')
  guide.className = 'icon-btn demo-btn'
  guide.type = 'button'
  guide.textContent = liveUrl ? 'Open the live HMS' : 'Where are the modules?'
  guide.title = 'This is the sample demo: front desk, restaurant, housekeeping, staff, engineering, security, stores and accounts run on the live HMS'
  guide.addEventListener('click', () => showDemoGuide(liveUrl))
  document.querySelector('.topbar-actions')!.prepend(guide)
  const badge = document.querySelector<HTMLElement>('.sample-badge')!
  badge.style.cursor = 'pointer'
  badge.title = 'Sample demo: click to see where the live HMS is'
  badge.addEventListener('click', () => showDemoGuide(liveUrl))
  let seen = false
  try { seen = localStorage.getItem('sathya.demoGuideSeen') === '1'; localStorage.setItem('sathya.demoGuideSeen', '1') } catch { /* private window: show it */ }
  if (!seen) showDemoGuide(liveUrl)
}
if (api && me && liveAdapter) {
  const badge = document.querySelector<HTMLElement>('.sample-badge')!
  badge.textContent = 'Live'
  badge.classList.add('live')
  badge.title = 'Connected to the Sathya HMS server'
  godBtn.hidden = !me.godMode
  const out = document.createElement('button')
  out.className = 'icon-btn'
  out.type = 'button'
  out.textContent = 'Sign out'
  out.addEventListener('click', async () => { try { await api!.post('/auth/sign-out') } finally { api!.setToken(null); location.reload() } })
  // Changing one's own password; other devices are signed out.
  const pw = document.createElement('button')
  pw.className = 'icon-btn'
  pw.type = 'button'
  pw.id = 'btn-password'
  pw.textContent = 'Password'
  pw.title = `Signed in as ${me.name}: change your password`
  const pwModal = new FormModal()
  pw.addEventListener('click', () => pwModal.open('Change your password', `<div class="form-grid"><label class="span2">Current password<input name="current" type="password" autocomplete="current-password" required></label>
    <label class="span2">New password<input name="next" type="password" autocomplete="new-password" minlength="8" required></label>
    <label class="span2">Type it again<input name="again" type="password" autocomplete="new-password" minlength="8" required></label></div>
    <p class="muted small">At least 8 characters. Your other devices are signed out.</p>`, 'Change', async (f) => {
    if (val(f, 'next') !== val(f, 'again')) throw new Error('The two new passwords are not the same.')
    await api!.post('/auth/password', { current: (f.elements.namedItem('current') as HTMLInputElement).value, next: (f.elements.namedItem('next') as HTMLInputElement).value })
    return 'Password changed'
  }))
  document.querySelector('.topbar-actions')!.append(pw, out)
  fd = new FrontDesk(api, store, me, () => renderSide())
  const outbox = new Outbox(api)
  fnb = new FnbWorkspace(api, me, outbox, () => store.reservations.filter((r) => r.status === 'in-house').map((r) => ({ id: r.id, guest: r.guest, roomNo: r.roomNo ?? null })), () => renderSide())
  hkWs = new HkWorkspace(api, me, outbox, () => renderSide())
  const hkBtn = $('#btn-hk')
  hkBtn.hidden = !HkWorkspace.allowed(me)
  hkBtn.addEventListener('click', () => { if (hkWs!.open) hkWs!.hide(); else { hideWorkspaces(); void hkWs!.show() } })
  const fnbBtn = $('#btn-fnb')
  fnbBtn.hidden = false
  fnbBtn.addEventListener('click', () => { if (fnb!.open) fnb!.hide(); else { hideWorkspaces(); void fnb!.show() } })

  // Staff app: everyone clocks in and out here; managers and security also see the team on the map.
  store.staffAllowed = me.permissions.includes('*') || me.permissions.includes('staff.track')
  if (store.staffAllowed) store.layers.add('staff')
  staffWs = new StaffWorkspace(api, me, outbox, {
    openWork(kind, ref) {
      if (kind === 'housekeeping' && hkWs) void hkWs.show('mine')
      if (kind === 'pickup' && fnb) void fnb.show('kitchen')
      if (kind === 'engineering' && engWs) void engWs.openTicket(ref)
      if (kind === 'patrol' && secWs) void secWs.show('patrols')
    },
    showOnMap(userId) {
      if (!store.layers.has('staff')) store.toggleLayer('staff')
      void loadStaff().then(() => { if (userId && !world.focusPin('staff', userId)) toast('The map has no position for this person yet.') })
    },
  }, () => renderSide())
  const staffBtn = $('#btn-staff')
  staffBtn.hidden = false
  staffBtn.addEventListener('click', () => { if (staffWs!.open) staffWs!.hide(); else { hideWorkspaces(); void staffWs!.show() } })
  // While on duty the phone shares its location: say so on every screen.
  const duty = document.createElement('button')
  duty.type = 'button'
  duty.className = 'duty-pill'
  duty.hidden = true
  duty.textContent = '📍 Location on: on duty'
  duty.addEventListener('click', () => { hideWorkspaces(); void staffWs!.show('today') })
  document.getElementById('app')!.appendChild(duty)
  staffWs.tracker.onChange = () => { duty.hidden = !staffWs!.tracker.active }
  void staffWs.resume()
  void loadStaff()

  // Engineering: anyone reports a fault; engineering sees assets and every open ticket on the map.
  store.engAllowed = me.permissions.includes('*') || me.permissions.includes('eng.work') || me.permissions.includes('eng.manage')
  engWs = new EngWorkspace(api, me, outbox, () => renderSide())
  const engBtn = $('#btn-eng')
  engBtn.hidden = false
  engBtn.addEventListener('click', () => { if (engWs!.open) engWs!.hide(); else { hideWorkspaces(); void engWs!.show() } })

  // Security: guards and managers get the full workspace and map layer; everyone can report an incident and answer a roll-call.
  store.secAllowed = ['*', 'security.gate', 'security.view'].some((x) => me!.permissions.includes(x))
  secWs = new SecurityWorkspace(api, me, outbox, () => renderSide())
  const secBtn = $('#btn-sec')
  secBtn.hidden = false
  secBtn.addEventListener('click', () => { if (secWs!.open) secWs!.hide(); else { hideWorkspaces(); void secWs!.show() } })
  void checkEmergency()

  // Stores & purchase: stores, accounts and managers.
  if (InventoryWorkspace.allowed(me)) {
    invWs = new InventoryWorkspace(api, me, outbox, () => renderSide())
    const invBtn = $('#btn-inv')
    invBtn.hidden = false
    invBtn.addEventListener('click', () => { if (invWs!.open) invWs!.hide(); else { hideWorkspaces(); void invWs!.show() } })
  }
  // Accounts: accounts, the GM, the MD and the auditor.
  if (AccountsWorkspace.allowed(me)) {
    accWs = new AccountsWorkspace(api, me, outbox, () => renderSide())
    const accBtn = $('#btn-acc')
    accBtn.hidden = false
    accBtn.addEventListener('click', () => { if (accWs!.open) accWs!.hide(); else { hideWorkspaces(); void accWs!.show() } })
  }
  addModulesMenu()
  setTab('arrivals')
}

/** One labelled menu of every module this person can open: the top-bar icons alone are easy to miss. */
function addModulesMenu() {
  const btn = document.createElement('button')
  btn.className = 'icon-btn modules-btn'
  btn.type = 'button'
  btn.setAttribute('aria-haspopup', 'menu')
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg><b>Modules</b>'
  const menu = document.createElement('div')
  menu.className = 'modules-menu'
  menu.setAttribute('role', 'menu')
  menu.hidden = true
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false') }
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!menu.hidden) { close(); return }
    const targets = [...document.querySelectorAll<HTMLElement>('.topbar-actions [id^="btn-"]:not([hidden]), #btn-studio:not([hidden])')]
      .filter((b) => !['btn-night', 'btn-eco'].includes(b.id))
    menu.innerHTML = targets.map((b) => {
      const [name, what] = b.id === 'btn-god' ? ['God Mode', 'every change, approvals and alerts'] : (b.getAttribute('title') ?? b.textContent ?? '').split(/:\s*/)
      return `<button type="button" role="menuitem" data-open="${b.id}"><b>${name}</b>${what ? `<small>${what}</small>` : ''}</button>`
    }).join('')
    menu.hidden = false
    btn.setAttribute('aria-expanded', 'true')
  })
  menu.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-open]')?.dataset.open
    if (!id) return
    close()
    document.getElementById(id)?.click()
  })
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target as Node)) close() })
  const bar = document.querySelector('.topbar-actions')!
  bar.prepend(btn)
  bar.appendChild(menu)
}
store.load().then(renderAll).catch((err) => toast(`Couldn't load HMS data: ${err.message}`))
