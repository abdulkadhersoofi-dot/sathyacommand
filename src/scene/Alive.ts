import * as THREE from 'three'
import type { V2 } from '../data/layout'
import type { EventBooking } from '../data/types'
import { centroid, inPoly, scalePoly } from './geo'
import type { Site } from './Site'

// The resort alive: cars on the drive, a pandal with string lights and a crowd on a booked lawn or hall,
// smoke from a busy kitchen, confetti over a venue just booked. Everything here is decoration: it reads
// the store, writes nothing, and switches off under Eco mode.

export interface Effect { start: number; dur: number; update: (k: number) => void; done: () => void }

const CROWD_COLOURS = [0xc0392b, 0xd4a017, 0x2e86ab, 0x8e44ad, 0xf39c12, 0x16a085, 0xe67e22, 0xf5f5f5]
const CONFETTI_COLOURS = [0xe8a317, 0xe0533d, 0x3b7be0, 0x35a46b, 0xf2c94c, 0xffffff]

export class Alive {
  group = new THREE.Group()
  private pandals = new Map<string, THREE.Group>()
  private lightMat = new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffd36b, emissiveIntensity: 0 })
  private crowd: THREE.InstancedMesh
  private smoke: THREE.Points
  private smokeLife: Float32Array
  private smokeLevel = 0
  private smokeAt = new THREE.Vector3()
  private dark = 0
  private live = new Set<string>()

  constructor(private site: Site) {
    this.crowd = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.32, 1.1, 2, 6).translate(0, 0.9, 0), new THREE.MeshStandardMaterial({ roughness: 0.9 }), 400)
    this.crowd.count = 0
    const n = 48
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) pos[i * 3 + 1] = -50   // below ground until the first tick lifts them
    this.smokeLife = new Float32Array(n).map(() => Math.random())
    this.smoke = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)),
      new THREE.PointsMaterial({ color: 0xcfd3d6, size: 3.2, transparent: true, opacity: 0.32, depthWrite: false, sizeAttenuation: true }))
    this.smoke.visible = false
    const k = site.anchors.get('KITCHEN')
    if (k) this.smokeAt.set(k.pos.x, Math.max(3, k.height) + 0.5, k.pos.z)
    this.group.add(this.crowd, this.smoke)
  }

  /** 0 by day, 1 at night: the string lights come on with it. */
  setDark(d: number) { this.dark = d; this.lightMat.emissiveIntensity = d * 2.2 }

  // ---------- events: pandal, string lights, crowd ----------
  /** Called on every data refresh with the venues that have a function today and its state. */
  updateEvents(venues: { id: string; ev: EventBooking }[]) {
    const keep = new Set<string>()
    this.live.clear()
    let c = 0
    const m = new THREE.Matrix4()
    for (const { id, ev } of venues) {
      if (!['in-progress', 'ready', 'live'].includes(ev.setup)) continue
      const a = this.site.anchors.get(id)
      if (!a?.poly || a.height > 0.5) continue   // halls are buildings already; the pandal goes up on lawns and grounds
      keep.add(id)
      if (ev.setup === 'live') this.live.add(id)
      if (!this.pandals.has(id)) this.pandals.set(id, this.buildPandal(a.poly))
      // The crowd: a few setting up, the hall filling as the function starts.
      const people = ev.setup === 'live' ? Math.min(220, Math.round(ev.pax / 6)) : 8
      c = this.placeCrowd(a.poly, people, c, m, id)
    }
    for (const [id, g] of this.pandals) if (!keep.has(id)) { this.group.remove(g); this.pandals.delete(id) }
    this.crowd.count = c
    this.crowd.instanceMatrix.needsUpdate = true
    if (this.crowd.instanceColor) this.crowd.instanceColor.needsUpdate = true
    this.crowd.computeBoundingSphere()
  }

  private buildPandal(poly: V2[]) {
    const g = new THREE.Group()
    const [cx, cz] = centroid(poly)
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1])
    const w = Math.min(44, (Math.max(...xs) - Math.min(...xs)) * 0.55), d = Math.min(30, (Math.max(...zs) - Math.min(...zs)) * 0.55)
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.62, 4.2, 4, 1, true).rotateY(Math.PI / 4), new THREE.MeshStandardMaterial({ color: 0xfff4dc, roughness: 0.9, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }))
    canopy.scale.set(w / Math.max(w, d), 1, d / Math.max(w, d))
    canopy.position.set(cx, 6.2, cz)
    canopy.castShadow = true
    g.add(canopy)
    const trim = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.5, d * 0.9), new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.8 }))
    trim.position.set(cx, 4.1, cz)
    g.add(trim)
    const pole = new THREE.CylinderGeometry(0.12, 0.14, 4.2, 6).translate(0, 2.1, 0)
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xd9c9a3 })
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = new THREE.Mesh(pole, poleMat)
      p.position.set(cx + sx * w * 0.43, 0, cz + sz * d * 0.43)
      g.add(p)
    }
    // string lights along the edge of the venue
    const ring = scalePoly(poly, 0.96)
    const pts: V2[] = []
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length]
      const L = Math.hypot(bx - ax, bz - az)
      for (let t = 0; t < L; t += 3.2) pts.push([ax + ((bx - ax) * t) / L, az + ((bz - az) * t) / L])
    }
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 6, 5), this.lightMat, pts.length)
    const mm = new THREE.Matrix4()
    pts.forEach((p, i) => { mm.makeTranslation(p[0], 3.4 + Math.sin(i * 1.3) * 0.25, p[1]); bulbs.setMatrixAt(i, mm) })
    g.add(bulbs)
    this.group.add(g)
    return g
  }

  private placeCrowd(poly: V2[], n: number, start: number, m: THREE.Matrix4, seed: string) {
    const inner = scalePoly(poly, 0.78)
    const xs = inner.map((p) => p[0]), zs = inner.map((p) => p[1])
    const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
    let s = [...seed].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7)
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
    let i = start, tries = 0
    const col = new THREE.Color()
    while (i < start + n && i < 400 && tries++ < n * 8) {
      const x = minX + rnd() * (maxX - minX), z = minZ + rnd() * (maxZ - minZ)
      if (!inPoly([x, z], inner)) continue
      m.makeTranslation(x, 0, z)
      this.crowd.setMatrixAt(i, m)
      this.crowd.setColorAt(i, col.setHex(CROWD_COLOURS[Math.floor(rnd() * CROWD_COLOURS.length)]))
      i++
    }
    return i
  }

  // ---------- kitchen smoke ----------
  setSmoke(open: number, late: number) {
    this.smokeLevel = open ? Math.min(1, 0.25 + open * 0.12 + late * 0.2) : 0
    this.smoke.visible = this.smokeLevel > 0
  }

  // ---------- cars ----------
  /** The road points from one place to another, following the drawn drive; a straight line when no road is near. */
  route(from: V2, to: V2): THREE.Vector3[] {
    const near = (p: V2, q: V2) => Math.hypot(p[0] - q[0], p[1] - q[1])
    let best: { path: V2[]; i: number; j: number; score: number } | null = null
    for (const path of this.site.roadPaths) {
      let i = 0, j = 0
      path.forEach((p, k) => { if (near(p, from) < near(path[i], from)) i = k; if (near(p, to) < near(path[j], to)) j = k })
      const score = near(path[i], from) + near(path[j], to)
      if (!best || score < best.score) best = { path, i, j, score }
    }
    const pts: V2[] = [from]
    if (best && best.score < 120) {
      const seg = best.i <= best.j ? best.path.slice(best.i, best.j + 1) : best.path.slice(best.j, best.i + 1).reverse()
      pts.push(...seg)
    }
    pts.push(to)
    return pts.map(([x, z]) => new THREE.Vector3(x, 0.6, z))
  }

  /** A small car that drives the path and fades out at the end. */
  car(path: THREE.Vector3[], colour: number, dur: number, effects: Effect[], delay = 0) {
    const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal', 0.25)
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 4.6).translate(0, 0.45, 0), new THREE.MeshStandardMaterial({ color: colour, roughness: 0.4, metalness: 0.2 }))
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.8, 2.4).translate(0, 1.25, -0.2), new THREE.MeshStandardMaterial({ color: 0x1f2a33, roughness: 0.3 }))
    const lamp = new THREE.MeshStandardMaterial({ color: 0xfff6d5, emissive: 0xfff1b0, emissiveIntensity: 0.8 + this.dark * 2 })
    const l1 = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 5), lamp), l2 = l1.clone()
    l1.position.set(-0.7, 0.55, 2.3); l2.position.set(0.7, 0.55, 2.3)
    const car = new THREE.Group()
    car.add(body, cabin, l1, l2)
    car.castShadow = true
    car.visible = false
    this.group.add(car)
    const tmp = new THREE.Vector3()
    effects.push({
      start: performance.now() / 1000 + delay, dur,
      update: (k) => {
        car.visible = true
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
        curve.getPoint(e, car.position)
        curve.getTangent(Math.min(1, e + 0.01), tmp)
        if (tmp.lengthSq() > 0) car.rotation.y = Math.atan2(tmp.x, tmp.z)
        car.scale.setScalar(k > 0.92 ? 1 - (k - 0.92) / 0.08 : 1)
      },
      done: () => { this.group.remove(car); body.geometry.dispose(); cabin.geometry.dispose() },
    })
  }

  // ---------- confetti ----------
  celebrate(at: THREE.Vector3, effects: Effect[]) {
    const n = 140
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.7, 0.45), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), n)
    const vel: THREE.Vector3[] = [], spin: number[] = [], col = new THREE.Color()
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 6 + Math.random() * 14
      vel.push(new THREE.Vector3(Math.cos(a) * s, 14 + Math.random() * 16, Math.sin(a) * s))
      spin.push(Math.random() * 6)
      mesh.setColorAt(i, col.setHex(CONFETTI_COLOURS[i % CONFETTI_COLOURS.length]))
    }
    this.group.add(mesh)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3()
    const dur = 3.2
    effects.push({
      start: performance.now() / 1000, dur,
      update: (k) => {
        const t = k * dur
        for (let i = 0; i < n; i++) {
          p.set(at.x + vel[i].x * t * 0.6, at.y + vel[i].y * t - 9 * t * t, at.z + vel[i].z * t * 0.6)
          if (p.y < 0.3) p.y = 0.3
          e.set(t * spin[i], t * spin[i] * 0.7, i)
          q.setFromEuler(e)
          m.compose(p, q, new THREE.Vector3(1, 1, 1).multiplyScalar(k > 0.8 ? (1 - k) * 5 : 1))
          mesh.setMatrixAt(i, m)
        }
        mesh.instanceMatrix.needsUpdate = true
      },
      done: () => { this.group.remove(mesh); mesh.geometry.dispose() },
    })
  }

  /** Per-frame motion. Returns true while anything is moving. */
  tick(t: number, dt: number): boolean {
    let active = false
    if (this.smoke.visible) {
      const pos = this.smoke.geometry.getAttribute('position') as THREE.BufferAttribute
      const n = pos.count, alive = Math.round(n * this.smokeLevel)
      for (let i = 0; i < n; i++) {
        if (i >= alive) { pos.setXYZ(i, 0, -50, 0); continue }
        let life = this.smokeLife[i] + dt * (0.18 + this.smokeLevel * 0.25)
        if (life > 1) life -= 1
        this.smokeLife[i] = life
        const drift = Math.sin(t * 0.7 + i) * 1.6 * life
        pos.setXYZ(i, this.smokeAt.x + drift + Math.cos(i) * 1.2, this.smokeAt.y + life * 14, this.smokeAt.z + Math.cos(t * 0.5 + i * 2) * 1.4 * life + Math.sin(i) * 1.2)
      }
      pos.needsUpdate = true
      active = true
    }
    if (this.live.size && this.dark > 0.2) { this.lightMat.emissiveIntensity = this.dark * (1.9 + Math.sin(t * 5) * 0.5); active = true }
    return active
  }

  dispose() {
    this.group.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose() })
  }
}
