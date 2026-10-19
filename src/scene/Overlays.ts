import * as THREE from 'three'
import { SITE, type V2 } from '../data/registry'
import { minutesOpen, type Store } from '../data/store'
import type { Order, Reservation } from '../data/types'
import { centroid, ease, inPoly, scalePoly } from './geo'
import type { Site } from './Site'
import type { Rooms } from './Rooms'
import { mainBlockPoly } from './Site'

// Everything drawn on top of the site: venue event overlays, kitchen load
// ring, room-service markers, HTML labels, and short-lived motion (order arcs,
// arriving / departing guests, food runners).

interface Label { el: HTMLElement; pos: THREE.Vector3; lift: number }
interface Effect { start: number; dur: number; update: (k: number) => void; done: () => void }

const MARIGOLD = 0xe8a317
const VENUE_TABLE_TYPES = new Set(['LAWN-GRAND', 'LAWN-GARDEN', 'GROUND-CRICKET', 'GROUND-NORTH', 'PAVILION'])

export class Overlays {
  group = new THREE.Group()
  private labels = new Map<string, Label>()
  private effects: Effect[] = []
  private venueLines = new Map<string, THREE.LineLoop>()
  private tables: THREE.InstancedMesh
  private kitchenRing: THREE.Mesh
  private markers: THREE.InstancedMesh
  private markerTargets: THREE.Vector3[] = []
  private liveVenues = new Set<string>()

  constructor(private site: Site, private rooms: Rooms, private labelLayer: HTMLElement) {
    this.tables = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.75, 0.75, 0.8, 10).translate(0, 0.4, 0),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), 600,
    )
    this.tables.count = 0
    this.tables.castShadow = true
    this.kitchenRing = new THREE.Mesh(
      new THREE.RingGeometry(14, 16.5, 56).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x35a46b, transparent: true, opacity: 0.7, depthWrite: false }),
    )
    const k = site.anchors.get('KITCHEN')!.pos
    this.kitchenRing.position.set(k.x, 0.2, k.z)
    this.markers = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.9, 0),
      new THREE.MeshStandardMaterial({ color: MARIGOLD, emissive: MARIGOLD, emissiveIntensity: 0.6, roughness: 0.4 }), 80,
    )
    this.markers.count = 0
    this.group.add(this.tables, this.kitchenRing, this.markers)
    this.buildLabels()
  }

  // ---------- labels ----------
  private buildLabels() {
    const named: [string, string][] = [
      ['RECEPTION', 'Reception'], ['RESTAURANT', 'Sathya Dine'], ['KITCHEN', 'Kitchen'],
      ['HALL-JSH', 'A. John Samuel Hall'], ['CONV-HALL', 'Convention Hall'], ['LAWN-GRAND', 'Grand Lawn'],
      ['LAWN-GARDEN', 'Garden Lawn'], ['PAVILION', 'Pavilion'], ['POOL', 'Pool'],
      ['GROUND-CRICKET', 'Cricket Ground'], ['GROUND-NORTH', 'North Ground'], ['SERVICE', 'Service Block'],
    ]
    for (const [id, name] of named) {
      const a = this.site.anchors.get(id)
      if (!a) continue
      this.addLabel(id, name, a.pos.clone().setY(a.height + 2), id)
    }
    const [cx, cz] = centroid(mainBlockPoly())
    this.addLabel('park-wing', 'Park Wing · 36 rooms', new THREE.Vector3(cx, SITE.mainBlock.floors * SITE.mainBlock.floorHeight + 3, cz))
    const v = centroid(SITE.villas.map((x) => centroid(x.poly)))
    this.addLabel('villas', 'Garden Villas', new THREE.Vector3(v[0], 8, v[1]))
  }

  private addLabel(key: string, text: string, pos: THREE.Vector3, spaceId?: string) {
    const el = document.createElement('div')
    el.className = 'map-label'
    if (spaceId) el.dataset.space = spaceId
    el.innerHTML = `<span class="ml-name"></span><span class="ml-detail" hidden></span>`
    el.querySelector('.ml-name')!.textContent = text
    this.labelLayer.appendChild(el)
    this.labels.set(key, { el, pos, lift: 0 })
  }

  private setLabelDetail(key: string, html: string | null, tone = '') {
    const l = this.labels.get(key)
    if (!l) return
    const d = l.el.querySelector<HTMLElement>('.ml-detail')!
    d.hidden = !html
    d.innerHTML = html ?? ''
    l.el.dataset.tone = tone
    l.el.classList.toggle('has-detail', !!html)
  }

  // Project labels to screen space, then hide lower-priority ones that collide.
  projectLabels(camera: THREE.Camera, w: number, h: number) {
    const v = new THREE.Vector3()
    const placed: { x: number; y: number; w: number; h: number }[] = []
    const items = [...this.labels.entries()].map(([key, l]) => {
      v.copy(l.pos)
      if (key === 'park-wing') v.y += this.rooms.exploded ? 10 : 0
      v.project(camera)
      const prio = (l.el.classList.contains('has-detail') ? 2 : 0) + (key === 'park-wing' ? 1 : 0)
      return { l, x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, onScreen: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1, prio, depth: v.z }
    }).sort((a, b) => b.prio - a.prio || a.depth - b.depth)
    for (const it of items) {
      const bw = it.l.el.offsetWidth, bh = it.l.el.offsetHeight
      const box = { x: it.x - bw / 2, y: it.y - bh, w: bw, h: bh }
      const clash = placed.some((p) => box.x < p.x + p.w + 4 && box.x + box.w + 4 > p.x && box.y < p.y + p.h + 2 && box.y + box.h + 2 > p.y)
      const show = it.onScreen && !clash
      it.l.el.style.visibility = show ? 'visible' : 'hidden'
      if (show) {
        placed.push(box)
        it.l.el.style.transform = `translate(${it.x}px, ${it.y}px) translate(-50%, -100%)`
      }
    }
  }

  // ---------- data-driven overlays ----------
  update(store: Store) {
    const showEvents = store.layers.has('events')
    const showFnb = store.layers.has('fnb')

    // venues
    this.liveVenues.clear()
    let t = 0
    const m = new THREE.Matrix4()
    for (const [id] of this.site.anchors) {
      const sp = store.spaceById.get(id)
      if (!sp || !['hall', 'lawn', 'pavilion', 'ground'].includes(sp.type)) continue
      const st = store.state(id)
      const ev = st.events[0]
      if (showEvents && ev) {
        this.setLabelDetail(id, `${ev.kind} · ${ev.pax} pax<br><span class="ml-sub">${ev.slot}${ev.setup === 'live' ? ' · <b>LIVE</b>' : ''}</span>`, ev.setup === 'live' ? 'live' : 'event')
        this.outline(id, true)
        if (ev.setup === 'live' || ev.setup === 'ready') this.liveVenues.add(id)
        if (VENUE_TABLE_TYPES.has(id)) t = this.placeTables(id, Math.min(160, Math.round(ev.pax / 8)), t, m)
      } else {
        this.setLabelDetail(id, null)
        this.outline(id, false)
      }
    }
    this.tables.count = t
    this.tables.instanceMatrix.needsUpdate = true
    this.tables.computeBoundingSphere()

    // kitchen
    const open = store.orders.filter((o) => o.status !== 'served')
    const late = store.isToday ? open.filter((o) => minutesOpen(o) > 20).length : 0
    this.kitchenRing.visible = showFnb && store.isToday
    ;(this.kitchenRing.material as THREE.MeshBasicMaterial).color.setHex(late ? 0xe0533d : open.length > 8 ? MARIGOLD : 0x35a46b)
    this.setLabelDetail('KITCHEN', showFnb && store.isToday ? `${open.length} open KOT${open.length === 1 ? '' : 's'}${late ? ` · <b>${late} late</b>` : ''}` : null, late ? 'alert' : 'fnb')
    const tableOrders = store.orders.filter((o) => o.kind === 'table')
    this.setLabelDetail('RESTAURANT', showFnb ? `${tableOrders.length} orders${store.isToday ? ` · ${tableOrders.filter((o) => o.status !== 'served').length} open` : ''}` : null, 'fnb')

    // room-service markers above rooms with an open order
    this.markerTargets = []
    if (showFnb && store.isToday) {
      const seen = new Set<string>()
      for (const o of open.filter((x) => x.kind === 'room')) {
        if (seen.has(o.origin)) continue
        seen.add(o.origin)
        const p = this.rooms.anchor(o.origin)
        if (p) this.markerTargets.push(p.add(new THREE.Vector3(0, 2.2, 0)))
      }
    }
    this.markers.count = this.markerTargets.length
    this.placeMarkers(0)

    // reception & lodging summaries
    const k = store.kpis()
    this.setLabelDetail('RECEPTION', store.layers.has('rooms') ? `${k.arrivals} arriving · ${k.departures} leaving` : null, 'rooms')
  }

  private outline(id: string, on: boolean) {
    let line = this.venueLines.get(id)
    if (!on) { if (line) line.visible = false; return }
    if (!line) {
      const poly = this.site.anchors.get(id)!.poly!
      const p = scalePoly(poly, 1.04)
      const g = new THREE.BufferGeometry().setFromPoints(p.map(([x, z]) => new THREE.Vector3(x, 0.35, z)))
      line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: MARIGOLD, transparent: true, opacity: 0.95 }))
      this.venueLines.set(id, line)
      this.group.add(line)
    }
    line.visible = true
  }

  private placeTables(id: string, n: number, start: number, m: THREE.Matrix4) {
    const poly = scalePoly(this.site.anchors.get(id)!.poly!, 0.82)
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1])
    const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
    const area = (maxX - minX) * (maxZ - minZ)
    const step = Math.max(3.2, Math.sqrt(area / Math.max(n, 1)) * 0.82)
    let i = start, placed = 0
    for (let z = minZ + step / 2; z < maxZ && placed < n; z += step) {
      for (let x = minX + step / 2; x < maxX && placed < n; x += step) {
        if (!inPoly([x, z] as V2, poly) || i >= 600) continue
        m.makeTranslation(x, 0.05, z)
        this.tables.setMatrixAt(i++, m)
        placed++
      }
    }
    return i
  }

  private placeMarkers(t: number) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion()
    this.markerTargets.forEach((p, i) => {
      q.setFromEuler(new THREE.Euler(0, t * 1.6 + i, 0))
      m.compose(p.clone().setY(p.y + Math.sin(t * 2.4 + i) * 0.4), q, new THREE.Vector3(1, 1.4, 1))
      this.markers.setMatrixAt(i, m)
    })
    this.markers.instanceMatrix.needsUpdate = true
    this.markers.computeBoundingSphere()
  }

  // ---------- motion ----------
  private anchorOf(id: string): THREE.Vector3 {
    const r = this.rooms.anchor(id)
    if (r) return r
    const a = this.site.anchors.get(id)
    if (a) return a.pos.clone().setY(Math.max(1, a.height))
    return this.site.anchors.get('RESTAURANT')!.pos.clone().setY(4.6)   // restaurant tables
  }

  orderArc(o: Order) {
    const from = this.anchorOf(o.origin)
    const to = this.site.anchors.get('KITCHEN')!.pos.clone().setY(4.2)
    this.arc(from, to, MARIGOLD, 1.8)
  }

  foodRunner(o: Order) {
    if (o.kind !== 'room') return
    const k = this.site.anchors.get('KITCHEN')!.pos
    const to = this.anchorOf(o.origin)
    this.walker([k.clone().setY(1.2), new THREE.Vector3(to.x, 1.2, to.z), to], MARIGOLD, 3.2)
  }

  guestMove(res: Reservation, change: 'check-in' | 'check-out') {
    const gate = new THREE.Vector3(SITE.gate[0], 1.2, SITE.gate[1])
    const mid = (x: number, y: number) => { const [a, b] = [(x - 440) * 0.4, (y - 500) * 0.4]; return new THREE.Vector3(a, 1.2, b) }
    const rec = this.site.anchors.get('RECEPTION')!.pos.clone().setY(1.2)
    const room = this.anchorOf(res.spaceId)
    const path = [gate, mid(586, 726), mid(548, 684), rec, new THREE.Vector3(room.x, 1.2, room.z), room]
    if (change === 'check-out') path.reverse()
    this.walker(path, change === 'check-in' ? 0x3b7be0 : 0xe0533d, 4.5)
  }

  private arc(from: THREE.Vector3, to: THREE.Vector3, color: number, dur: number) {
    const mid = from.clone().add(to).multiplyScalar(0.5)
    mid.y += 10 + from.distanceTo(to) * 0.35
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to)
    const pts = curve.getPoints(48)
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
    const line = new THREE.Line(geo, mat)
    const dot = this.glowDot(color)
    this.group.add(line, dot)
    this.effects.push({
      start: performance.now() / 1000, dur: dur + 0.8,
      update: (k) => {
        const travel = Math.min(1, (k * (dur + 0.8)) / dur)
        geo.setDrawRange(0, Math.ceil(ease.outCubic(travel) * 49))
        dot.position.copy(curve.getPoint(ease.outCubic(travel)))
        const fade = Math.max(0, (k * (dur + 0.8) - dur) / 0.8)
        mat.opacity = 0.9 * (1 - fade)
        ;(dot.material as THREE.MeshBasicMaterial).opacity = 1 - fade
        dot.scale.setScalar(1 + fade * 2)
      },
      done: () => { this.group.remove(line, dot); geo.dispose(); mat.dispose() },
    })
  }

  private walker(path: THREE.Vector3[], color: number, dur: number) {
    const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal', 0.2)
    const dot = this.glowDot(color)
    const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(80)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }))
    this.group.add(dot, trail)
    this.effects.push({
      start: performance.now() / 1000, dur,
      update: (k) => {
        dot.position.copy(curve.getPoint(ease.inOutCubic(k)))
        ;(trail.material as THREE.LineBasicMaterial).opacity = 0.35 * (1 - Math.max(0, k - 0.8) * 5)
      },
      done: () => { this.group.remove(dot, trail); trail.geometry.dispose() },
    })
  }

  private glowDot(color: number) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), new THREE.MeshBasicMaterial({ color, transparent: true }))
    const halo = new THREE.Mesh(new THREE.SphereGeometry(1.8, 12, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false }))
    dot.add(halo)
    return dot
  }

  // Returns true while anything is animating.
  tick(t: number, ambient: boolean) {
    const now = performance.now() / 1000
    this.effects = this.effects.filter((e) => {
      const k = Math.min(1, (now - e.start) / e.dur)
      e.update(k)
      if (k >= 1) { e.done(); return false }
      return true
    })
    let active = this.effects.length > 0
    if (ambient) {
      if (this.markerTargets.length) { this.placeMarkers(t); active = true }
      const pulse = 0.55 + 0.45 * Math.sin(t * 3)
      for (const [id, line] of this.venueLines) {
        if (!line.visible) continue
        ;(line.material as THREE.LineBasicMaterial).opacity = this.liveVenues.has(id) ? pulse : 0.9
        if (this.liveVenues.has(id)) active = true
      }
      if (this.kitchenRing.visible) {
        this.kitchenRing.scale.setScalar(1 + Math.sin(t * 2) * 0.03)
        active = true
      }
    }
    return active
  }
}
