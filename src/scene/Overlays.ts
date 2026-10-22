import * as THREE from 'three'
import { blockCells, rectPoly, type V2 } from '../data/layout'
import { minutesOpen, type Store } from '../data/store'
import type { Order, Reservation } from '../data/types'
import { centroid, ease, inPoly, scalePoly } from './geo'
import type { Site } from './Site'
import type { Rooms } from './Rooms'
import { Alive, type Effect } from './Alive'

// Everything drawn on top of the site: venue event overlays, kitchen load
// ring, room-service markers, HTML labels, and short-lived motion (order arcs,
// arriving / departing guests, food runners).

interface Label { el: HTMLElement; pos: THREE.Vector3; lift: number }
/** A point drawn on the map for a live layer (staff on duty, faults, assets…), in layout metres. */
export interface MapPin { id: string; x: number; z: number; colour: number; shape: 'person' | 'marker' | 'dot'; label?: string; detail?: string | null; tone?: string; pulse?: boolean; faded?: boolean; clickable?: boolean }

const MARIGOLD = 0xe8a317
const ROLE_COLOURS: [RegExp, number][] = [[/security/, 0x3b7be0], [/room_attendant|hk_/, 0x2bb3a3], [/captain|steward|chef|kitchen|bartender/, MARIGOLD],
  [/engineer|maintenance/, 0xe07b2c], [/manager|gm|md|owner|accounts/, 0x9b6bd6], [/reception|front/, 0x35a46b]]
/** Staff pins are coloured by role. */
export const roleColour = (roles: string) => ROLE_COLOURS.find(([r]) => r.test(roles))?.[1] ?? 0x8a8f98
const LABEL_HEIGHT = { person: 10.5, marker: 11, dot: 4.5 }
const VENUE_TABLE_TYPES = new Set(['LAWN-GRAND', 'LAWN-GARDEN', 'GROUND-CRICKET', 'GROUND-NORTH', 'PAVILION'])

export class Overlays {
  group = new THREE.Group()
  private labels = new Map<string, Label>()
  private effects: Effect[] = []
  private lastTick = 0
  /** Cars, pandals, crowds, smoke and confetti. */
  alive: Alive
  private venueLines = new Map<string, THREE.LineLoop>()
  private tables: THREE.InstancedMesh
  private kitchenRing: THREE.Mesh
  private markers: THREE.InstancedMesh
  private lateMarkers: THREE.InstancedMesh
  /** One marker per place with open orders: above the room, or above the outlet (bar, poolside, cafeteria…). */
  private markerTargets: { p: THREE.Vector3; late: boolean; origin: string }[] = []
  private labelledOutlets = new Set<string>()
  /** Places whose label carries a detail (events, orders), to clear when they no longer do. */
  private detailed = new Set<string>()
  private liveVenues = new Set<string>()
  private pinGroup = new THREE.Group()
  private pins = new Map<string, Map<string, { obj: THREE.Group; ring: THREE.Mesh | null; shape: MapPin['shape']; colour: number }>>()
  private pinGeo = {
    head: new THREE.SphereGeometry(0.85, 14, 10).translate(0, 3.1, 0), body: new THREE.ConeGeometry(0.75, 2.4, 12).rotateX(Math.PI).translate(0, 1.2, 0),
    gem: new THREE.OctahedronGeometry(1, 0).translate(0, 4.2, 0), stem: new THREE.CylinderGeometry(0.14, 0.14, 3.4, 6).translate(0, 1.7, 0),
    dot: new THREE.BoxGeometry(1.1, 1.1, 1.1).translate(0, 0.55, 0), ring: new THREE.RingGeometry(1.6, 2.4, 32).rotateX(-Math.PI / 2).translate(0, 0.15, 0),
  }

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
    const k = site.anchors.get('KITCHEN')?.pos ?? new THREE.Vector3()
    this.kitchenRing.position.set(k.x, 0.2, k.z)
    this.markers = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(1.4, 0),
      new THREE.MeshStandardMaterial({ color: MARIGOLD, emissive: MARIGOLD, emissiveIntensity: 0.6, roughness: 0.4 }), 80,
    )
    this.markers.count = 0
    // Late orders get their own red markers: an instanced mesh has one colour.
    this.lateMarkers = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(1.7, 0),
      new THREE.MeshStandardMaterial({ color: 0xe0533d, emissive: 0xe0533d, emissiveIntensity: 0.9, roughness: 0.4 }), 40,
    )
    this.lateMarkers.count = 0
    this.alive = new Alive(site)
    this.group.add(this.tables, this.kitchenRing, this.markers, this.lateMarkers, this.pinGroup, this.alive.group)
    this.buildLabels()
  }

  /** Removes this overlay's HTML labels (used when the scene is rebuilt from a new layout). */
  dispose() {
    this.alive.dispose()
    for (const l of this.labels.values()) l.el.remove()
    this.labels.clear()
    for (const layer of [...this.pins.keys()]) this.setPins(layer, null)
  }

  // ---------- live pins (staff, faults, assets) ----------
  /** Draws one layer's pins (null hides the layer). A pulsing red ring marks an alarm; a faded pin is out of date. */
  setPins(layer: string, list: MapPin[] | null) {
    let have = this.pins.get(layer)
    if (!have) { have = new Map(); this.pins.set(layer, have) }
    const keep = new Set((list ?? []).map((p) => p.id))
    const drop = (id: string) => {
      const p = have!.get(id)!
      this.pinGroup.remove(p.obj)
      p.obj.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; m?.dispose() })
      have!.delete(id)
      this.labels.get(`${layer}:${id}`)?.el.remove()
      this.labels.delete(`${layer}:${id}`)
    }
    for (const id of [...have.keys()]) if (!keep.has(id)) drop(id)
    for (const s of list ?? []) {
      const key = `${layer}:${s.id}`
      let p = have.get(s.id)
      if (p && (p.shape !== s.shape || p.colour !== s.colour)) { drop(s.id); p = undefined }
      if (!p) {
        const mat = new THREE.MeshStandardMaterial({ color: s.colour, emissive: s.colour, emissiveIntensity: 0.55, roughness: 0.45, transparent: true })
        const obj = new THREE.Group()
        const g = this.pinGeo
        const parts = s.shape === 'person' ? [g.head, g.body] : s.shape === 'marker' ? [g.gem, g.stem] : [g.dot]
        obj.add(...parts.map((geo) => new THREE.Mesh(geo, mat)))
        if (s.shape !== 'dot') obj.scale.setScalar(2.2)            // tall enough to stand above the trees
        p = { obj, ring: null, shape: s.shape, colour: s.colour }
        have.set(s.id, p)
        this.pinGroup.add(obj)
      }
      const y = this.surfaceAt(s.x, s.z)
      p.obj.position.set(s.x, y, s.z)
      p.obj.children.forEach((c) => { const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial; if (m.emissive) m.opacity = s.faded ? 0.45 : 1 })
      if (s.pulse && !p.ring) {
        p.ring = new THREE.Mesh(this.pinGeo.ring, new THREE.MeshBasicMaterial({ color: 0xe0533d, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }))
        p.obj.add(p.ring)
      } else if (!s.pulse && p.ring) { p.obj.remove(p.ring); (p.ring.material as THREE.Material).dispose(); p.ring = null }
      if (s.label && !this.labels.has(key)) {
        this.addLabel(key, s.label, new THREE.Vector3())
        this.labels.get(key)!.el.classList.add('pin-label', `${layer}-label`)
        if (s.clickable) this.labels.get(key)!.el.dataset.pin = key       // tapping the label opens the record
      } else if (!s.label && this.labels.has(key)) { this.labels.get(key)!.el.remove(); this.labels.delete(key) }
      const l = this.labels.get(key)
      if (l && s.label) {
        l.el.querySelector('.ml-name')!.textContent = s.label
        l.pos.set(s.x, y + LABEL_HEIGHT[s.shape], s.z)
        this.setLabelDetail(key, s.detail ?? null, s.tone ?? '')
        l.el.classList.toggle('stale', !!s.faded)
      }
    }
  }

  private ray = new THREE.Raycaster()
  /** Height of the roof or ground at a point, so a pin in a building stands on top of it. */
  private surfaceAt(x: number, z: number) {
    this.ray.set(new THREE.Vector3(x, 300, z), new THREE.Vector3(0, -1, 0))
    const hit = this.ray.intersectObjects([this.rooms.group], true).find((h) => (h.object as THREE.Mesh).isMesh && h.object.visible)
    return hit ? Math.max(0, hit.point.y) : 0
  }

  pinAt(layer: string, id: string): THREE.Vector3 | null { return this.pins.get(layer)?.get(id)?.obj.position.clone() ?? null }

  // ---------- labels ----------
  /** Every building, named ground, pool, block and villa is labelled with its own name, so new ones are too. */
  private buildLabels() {
    const l = this.site.layout
    const GROUND_NAMES: Record<string, string> = { 'LAWN-GRAND': 'Grand Lawn', 'LAWN-GARDEN': 'Garden Lawn', 'GROUND-CRICKET': 'Cricket Ground', 'GROUND-NORTH': 'North Ground', POOL: 'Pool' }
    const seen = new Set<string>()
    // A space with ground or water (the pool deck, a lawn) is labelled there, so its live figures never land on a shed beside it.
    for (const g of l.ground) {
      const name = g.label?.trim() || (g.spaceId ? GROUND_NAMES[g.spaceId] : undefined)
      if (!name) continue
      const [cx, cz] = centroid(g.poly)
      this.addLabel(g.spaceId && !this.labels.has(g.spaceId) ? g.spaceId : `g:${g.id}`, name, new THREE.Vector3(cx, 2, cz), g.spaceId)
    }
    for (const p of l.pools) {
      const name = p.label?.trim() || (p.spaceId ? GROUND_NAMES[p.spaceId] : 'Pool')
      const [cx, cz] = centroid(p.poly)
      if (!this.labels.has(p.spaceId ?? `p:${p.id}`)) this.addLabel(p.spaceId ?? `p:${p.id}`, name ?? 'Pool', new THREE.Vector3(cx, 2, cz), p.spaceId)
    }
    // A building drawn in parts (a hall and its annex) is labelled once; the label key is its HMS space when it has one and nothing else took it, so live figures attach to it.
    for (const b of l.buildings) {
      const name = b.label?.trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      const [cx, cz] = centroid(b.poly)
      this.addLabel(b.spaceId && !this.labels.has(b.spaceId) ? b.spaceId : `b:${b.id}`, name, new THREE.Vector3(cx, b.height + 2, cz), b.spaceId)
    }
    for (const b of l.blocks) {
      const [cx, cz] = centroid(rectPoly(b.rect))
      this.addLabel(`block:${b.id}`, `${b.label} · ${blockCells(b).length} rooms`, new THREE.Vector3(cx, b.floors * b.floorHeight + 3, cz))
    }
    for (const v of l.villas) {
      const [cx, cz] = centroid(v.poly)
      this.addLabel(`villa:${v.id}`, v.label?.trim() || v.id, new THREE.Vector3(cx, 6, cz))
      this.labels.get(`villa:${v.id}`)!.el.classList.add('villa-label')
    }
  }

  private addLabel(key: string, text: string, pos: THREE.Vector3, spaceId?: string) {
    this.labels.get(key)?.el.remove()          // never leave a replaced label behind on the screen
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
      if (key.startsWith('block:')) v.y += this.rooms.exploded ? 10 : 0
      v.project(camera)
      const prio = (l.el.dataset.tone === 'alert' ? 4 : 0) + (l.el.classList.contains('has-detail') ? 2 : 0) + (key.startsWith('block:') || l.el.classList.contains('pin-label') ? 1 : 0)
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
    const busy: { id: string; ev: (typeof store.events)[number] }[] = []
    // A place may carry both its events and its food orders (a lawn café on a wedding day): the label shows both.
    const detail = new Map<string, { html: string[]; tone: string }>()
    const add = (id: string, html: string, tone: string) => { const d = detail.get(id) ?? { html: [], tone }; d.html.push(html); if (tone === 'alert' || tone === 'live') d.tone = tone; detail.set(id, d) }
    for (const [id] of this.site.anchors) {
      const sp = store.spaceById.get(id)
      if (!sp || !['hall', 'lawn', 'pavilion', 'ground'].includes(sp.type)) continue
      const st = store.state(id)
      // Every function of the day, in time order: the pandal and crowd follow the live one (else the next firm one).
      const evs = st.events
      const firm = evs.filter((e) => e.firm !== false)
      const ev = firm.find((e) => e.setup === 'live') ?? firm.find((e) => e.setup !== 'done') ?? firm[0] ?? evs[0]
      if (showEvents && ev && store.isToday && ev.firm !== false) busy.push({ id, ev })
      if (showEvents && ev) {
        const tone = firm.some((e) => e.setup === 'live') ? 'live' : firm.some((e) => e.status !== 'hold') ? 'event' : firm.length ? 'hold' : 'pencil'
        const line = (e: (typeof evs)[number]) => `<span class="ml-line${e.setup === 'live' ? ' now' : ''}"><span class="ml-sub">${e.slot}</span> ${e.kind} · ${e.pax} pax${e.setup === 'live' ? ' · <b>LIVE</b>' : e.firm === false ? ' · pencilled' : e.status === 'hold' ? ' · on hold' : ''}</span>`
        add(id, evs.length > 1 ? `${evs.length} functions today<br>${evs.map(line).join('<br>')}` : line(ev), tone)
        this.outline(id, true, tone)
        if (ev.setup === 'live' || ev.setup === 'ready') this.liveVenues.add(id)
        if (VENUE_TABLE_TYPES.has(id) && ev.firm !== false) t = this.placeTables(id, Math.min(160, Math.round(ev.pax / 8)), t, m)
      } else this.outline(id, false)
    }
    this.tables.count = t
    this.tables.instanceMatrix.needsUpdate = true
    this.tables.computeBoundingSphere()
    this.alive.updateEvents(busy)

    // kitchen
    const open = store.orders.filter((o) => o.status !== 'served')
    const late = store.isToday ? open.filter((o) => minutesOpen(o) > 20).length : 0
    this.kitchenRing.visible = showFnb && store.isToday
    this.alive.setSmoke(showFnb && store.isToday ? open.length : 0, late)
    ;(this.kitchenRing.material as THREE.MeshBasicMaterial).color.setHex(late ? 0xe0533d : open.length > 8 ? MARIGOLD : 0x35a46b)
    if (showFnb && store.isToday) add('KITCHEN', `${open.length} open KOT${open.length === 1 ? '' : 's'}${late ? ` · <b>${late} late</b>` : ''}`, late ? 'alert' : 'fnb')
    // Each outlet's label counts its own orders; the kitchen counts them all.
    const byOutlet = new Map<string, Order[]>()
    for (const o of store.orders.filter((x) => x.kind === 'table')) byOutlet.set(o.origin, [...(byOutlet.get(o.origin) ?? []), o])
    this.labelledOutlets.clear()
    if (showFnb) {
      for (const [id, list] of byOutlet) {
        const openHere = list.filter((o) => o.status !== 'served'), lateHere = store.isToday ? openHere.filter((o) => minutesOpen(o) > 20).length : 0
        add(id, `${list.length} order${list.length === 1 ? '' : 's'}${store.isToday ? ` · ${openHere.length} open${lateHere ? ` · <b>${lateHere} late</b>` : ''}` : ''}`, lateHere ? 'alert' : 'fnb')
        this.labelledOutlets.add(id)
      }
    }
    for (const id of this.detailed) if (!detail.has(id)) this.setLabelDetail(id, null)
    this.detailed.clear()
    for (const [id, d] of detail) { this.setLabelDetail(id, d.html.join('<br>'), d.tone); this.detailed.add(id) }

    // markers above every room and outlet with an open order: red when one is late
    this.markerTargets = []
    if (showFnb && store.isToday) {
      const seen = new Map<string, { p: THREE.Vector3; late: boolean; origin: string }>()
      for (const o of open) {
        const lateNow = minutesOpen(o) > 20
        const had = seen.get(o.origin)
        if (had) { had.late ||= lateNow; continue }
        const p = o.kind === 'room' ? this.rooms.anchor(o.origin)?.add(new THREE.Vector3(0, 3.2, 0)) : this.outletTop(o.origin)
        if (p) seen.set(o.origin, { p, late: lateNow, origin: o.origin })
      }
      // A guest leaving today with an order or laundry still open: red above the room, so the lobby screen sees it.
      for (const r of store.reservations) {
        if (r.status !== 'in-house' || r.departure > store.date || !r.openItems || !r.spaceId || seen.has(r.spaceId)) continue
        const p = this.rooms.anchor(r.spaceId)?.add(new THREE.Vector3(0, 3.2, 0))
        if (p) seen.set(r.spaceId, { p, late: true, origin: r.spaceId })
      }
      this.markerTargets = [...seen.values()]
    }
    this.markers.count = this.markerTargets.filter((m) => !m.late).length
    this.lateMarkers.count = this.markerTargets.filter((m) => m.late).length
    this.placeMarkers(0)

    // reception & lodging summaries
    const k = store.kpis()
    if (store.layers.has('rooms')) { this.setLabelDetail('RECEPTION', `${k.arrivals} arriving · ${k.departures} leaving`, 'rooms'); this.detailed.add('RECEPTION') }
  }

  /** The venue's outline says what its day is: marigold for a signed event, amber for a hold, grey dashes for a pencilled enquiry. */
  private outline(id: string, on: boolean, tone = 'event') {
    let line = this.venueLines.get(id)
    if (!on) { if (line) line.visible = false; return }
    if (!line) {
      const poly = this.site.anchors.get(id)!.poly!
      const p = scalePoly(poly, 1.04)
      const g = new THREE.BufferGeometry().setFromPoints([...p, p[0]].map(([x, z]) => new THREE.Vector3(x, 0.35, z)))
      line = new THREE.LineLoop(g, new THREE.LineDashedMaterial({ color: MARIGOLD, transparent: true, opacity: 0.95, dashSize: 3, gapSize: 0 }))
      line.computeLineDistances()
      this.venueLines.set(id, line)
      this.group.add(line)
    }
    const mat = line.material as THREE.LineDashedMaterial
    mat.color.setHex(tone === 'pencil' ? 0x8a8f99 : tone === 'hold' ? 0xf0c04a : MARIGOLD)
    mat.gapSize = tone === 'pencil' ? 2 : 0
    mat.needsUpdate = true
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

  /** A point above an outlet (its building roof, or a lawn or deck) for its order marker. */
  private outletTop(id: string): THREE.Vector3 | null {
    const a = this.site.anchors.get(id)
    if (!a) return null
    // High enough to clear the place's name label, which sits at its roof.
    return a.pos.clone().setY(Math.max(1.2, a.height) + 7)
  }

  /** The place a marker belongs to (for a tap): the first `markers.count` are on time, the rest late. */
  markerOrigin(mesh: THREE.Object3D, instanceId: number): string | null {
    const list = mesh === this.lateMarkers ? this.markerTargets.filter((m) => m.late) : this.markerTargets.filter((m) => !m.late)
    return list[instanceId]?.origin ?? null
  }
  get markerMeshes(): THREE.Object3D[] { return [this.markers, this.lateMarkers] }

  private placeMarkers(t: number) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion()
    let onTime = 0, late = 0
    this.markerTargets.forEach((x, i) => {
      const p = x.p
      // A late order's marker beats faster and bigger, so it is seen from across the map.
      const beat = x.late ? 1.15 + Math.sin(t * 6 + i) * 0.25 : 1 + Math.sin(t * 2.4 + i) * 0.08
      q.setFromEuler(new THREE.Euler(0, t * (x.late ? 3 : 1.6) + i, 0))
      m.compose(p.clone().setY(p.y + Math.sin(t * 2.4 + i) * 0.4), q, new THREE.Vector3(beat, 1.4 * beat, beat))
      if (x.late) this.lateMarkers.setMatrixAt(late++, m); else this.markers.setMatrixAt(onTime++, m)
    })
    for (const mesh of [this.markers, this.lateMarkers]) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere() }
  }

  // ---------- motion ----------
  private anchorOf(id: string): THREE.Vector3 {
    const r = this.rooms.anchor(id)
    if (r) return r
    const a = this.site.anchors.get(id)
    if (a) return a.pos.clone().setY(Math.max(1, a.height))
    return (this.site.anchors.get('RESTAURANT')?.pos ?? new THREE.Vector3()).clone().setY(4.6)   // restaurant tables
  }

  /** An order sent: the waiter walks from the table (or the room's wing) to the kitchen with the ticket, and the ticket arcs in. */
  orderArc(o: Order) {
    // The walk runs over the roofs (the straight line between two buildings is indoors), so it stays in view.
    const from = this.anchorOf(o.origin)
    const k = this.anchorOf('KITCHEN')
    this.walker([from.clone(), from.clone().lerp(k, 0.5).setY(Math.max(from.y, k.y) + 0.6), k.clone()], MARIGOLD, 2.6, 0, true)
    this.arc(from, k.clone().setY(k.y + 3), MARIGOLD, 1.8)
  }

  /** Food ready: the waiter walks from the kitchen back to the table or the room with the tray. */
  foodRunner(o: Order) {
    const k = this.anchorOf('KITCHEN')
    const to = this.anchorOf(o.origin)
    this.walker([k.clone(), k.clone().lerp(to, 0.5).setY(Math.max(to.y, k.y) + 0.6), to], 0x35a46b, 3.2, 0, true)
  }

  guestMove(res: Reservation, change: 'check-in' | 'check-out') {
    const rec = (this.site.anchors.get('RECEPTION')?.pos ?? new THREE.Vector3()).clone().setY(1.2)
    const room = this.anchorOf(res.spaceId)
    const walk = [rec, new THREE.Vector3(room.x, 1.2, room.z), room]
    const drive = this.alive.route(this.site.layout.gate, [rec.x, rec.z])
    if (change === 'check-in') {
      // The car comes up the drive to reception; the guest walks on to the room.
      this.alive.car(drive, 0x3b7be0, 5, this.effects)
      this.walker(walk, 0x3b7be0, 4, 4.6)
    } else {
      this.walker(walk.slice().reverse(), 0xe0533d, 4)
      this.alive.car(drive.slice().reverse(), 0xe0533d, 5, this.effects, 3.6)
    }
  }

  /** A vehicle logged at the gate drives in to the lobby (or out to the road). */
  vehicle(direction: 'in' | 'out') {
    const rec = this.site.anchors.get('RECEPTION')?.pos ?? new THREE.Vector3()
    const drive = this.alive.route(this.site.layout.gate, [rec.x, rec.z])
    this.alive.car(direction === 'in' ? drive : drive.slice().reverse(), 0xf6d34a, 5, this.effects)
  }

  /** Confetti over a venue: an event just became definite. */
  celebrate(id: string) {
    const a = this.site.anchors.get(id)
    if (a) this.alive.celebrate(a.pos.clone().setY(Math.max(4, a.height) + 6), this.effects)
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

  private walker(path: THREE.Vector3[], color: number, dur: number, delay = 0, person = false) {
    const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal', 0.2)
    const dot = person ? this.figure(color) : this.glowDot(color)
    const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(80)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }))
    dot.visible = trail.visible = delay === 0
    this.group.add(dot, trail)
    this.effects.push({
      start: performance.now() / 1000 + delay, dur,
      update: (k) => {
        dot.visible = trail.visible = true
        const p = curve.getPoint(ease.inOutCubic(k))
        dot.position.copy(p)
        if (person) {
          // A little bob with each step, facing the way it walks.
          dot.position.y += Math.abs(Math.sin(k * dur * 9)) * 0.25
          const ahead = curve.getPoint(Math.min(1, ease.inOutCubic(k) + 0.01))
          if (ahead.distanceToSquared(p) > 1e-4) dot.lookAt(ahead.x, dot.position.y, ahead.z)
        }
        ;(trail.material as THREE.LineBasicMaterial).opacity = 0.35 * (1 - Math.max(0, k - 0.8) * 5)
      },
      done: () => { this.group.remove(dot, trail); trail.geometry.dispose() },
    })
  }

  /** A small figure: body, head and a tray in the colour of the errand. */
  private figure(color: number) {
    const g = new THREE.Group()
    const skin = new THREE.MeshStandardMaterial({ color: 0xf1ebe1, roughness: 0.8 })
    const cloth = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.9 })
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 1.1, 4, 8).translate(0, 1.0, 0), cloth)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 8).translate(0, 2.05, 0), skin)
    const tray = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 0.7).translate(0, 1.45, 0.75), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 }))
    g.add(body, head, tray)
    g.scale.setScalar(1.6)
    return g
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
      if (now < e.start) return true
      const k = Math.min(1, (now - e.start) / e.dur)
      e.update(k)
      if (k >= 1) { e.done(); return false }
      return true
    })
    let active = this.effects.length > 0
    if (ambient) active = this.alive.tick(t, Math.min(0.1, t - (this.lastTick || t))) || active
    this.lastTick = t
    if (ambient) {
      if (this.markerTargets.length) { this.placeMarkers(t); active = true }
      const pulse = 0.55 + 0.45 * Math.sin(t * 3)
      for (const [id, line] of this.venueLines) {
        if (!line.visible) continue
        ;(line.material as THREE.LineBasicMaterial).opacity = this.liveVenues.has(id) ? pulse : 0.9
        if (this.liveVenues.has(id)) active = true
      }
      for (const p of [...this.pins.values()].flatMap((m) => [...m.values()])) {
        if (!p.ring) continue
        const k = (t * 1.2) % 1
        p.ring.scale.setScalar(1 + k * 2.2)
        ;(p.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k)
        active = true
      }
      if (this.kitchenRing.visible) {
        this.kitchenRing.scale.setScalar(1 + Math.sin(t * 2) * 0.03)
        active = true
      }
    }
    return active
  }
}
