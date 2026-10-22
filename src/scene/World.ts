import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Store } from '../data/store'
import { Site } from './Site'
import { defaultLayout, type SiteLayout } from '../data/layout'
import { Rooms } from './Rooms'
import { Overlays, type MapPin } from './Overlays'
import { ease } from './geo'

export interface WorldCallbacks {
  onHover(id: string | null, x: number, y: number, pointer: string): void
  onTap(id: string | null, x: number, y: number, pointer: string): void
  onFocus(id: string): void
}

const HOME_POS = new THREE.Vector3(62, 150, 200)
const HOME_TARGET = new THREE.Vector3(10, 0, 14)
/** The hour of the day in India, with minutes as a fraction. */
const istHour = () => { const d = new Date(Date.now() + 330 * 60_000); return d.getUTCHours() + d.getUTCMinutes() / 60 }

export class World {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  site: Site
  rooms: Rooms
  overlays: Overlays
  layout: SiteLayout
  /** Twin Studio is open: normal hover / tap is off and the studio handles the pointer. */
  editMode = false
  night = false
  /** true: the Night button holds the scene after dark; null: the sky follows the clock. */
  nightOverride: boolean | null = null
  eco = false

  private hemi = new THREE.HemisphereLight(0xeaf4ff, 0x7d6b4f, 1.3)
  private sun = new THREE.DirectionalLight(0xfff1dc, 2.4)
  private raycaster = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private pendingPick: { x: number; y: number; pointer: string } | null = null
  private hoverId: string | null = null
  private dirty = true
  private lastFrame = 0
  private tweens: { start: number; dur: number; fn: (k: number) => void }[] = []
  private introUntil = 0
  private down = { x: 0, y: 0, t: 0 }
  private lastTap = { id: '' as string | null, t: 0 }
  private size = { w: 1, h: 1 }

  constructor(private host: HTMLElement, private labelLayer: HTMLElement, private store: Store, private cb: WorldCallbacks, layout: SiteLayout = defaultLayout()) {
    this.layout = layout
    this.site = new Site(layout)
    this.rooms = new Rooms(layout)
    const lowEnd = (navigator.hardwareConcurrency ?? 8) <= 4 || ((navigator as any).deviceMemory ?? 8) <= 4
    this.eco = lowEnd
    this.renderer = new THREE.WebGLRenderer({ antialias: !lowEnd, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowEnd ? 1.25 : 2))
    this.renderer.shadowMap.enabled = !lowEnd
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    host.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 2000)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.08, minDistance: 30, maxDistance: 520,
      maxPolarAngle: 1.38, screenSpacePanning: false, zoomToCursor: true,
    })
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
    this.controls.addEventListener('change', () => (this.dirty = true))

    this.sun.position.set(-140, 220, 120)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const sc = this.sun.shadow.camera
    sc.left = sc.bottom = -190; sc.right = sc.top = 190; sc.near = 50; sc.far = 600
    this.sun.shadow.bias = -0.0004
    this.scene.add(this.hemi, this.sun, this.site.root, this.rooms.group)
    this.overlays = new Overlays(this.site, this.rooms, labelLayer)
    this.scene.add(this.overlays.group)

    this.applyTime(istHour())
    setInterval(() => { if (this.nightOverride === null) this.applyTime(istHour()) }, 60_000)
    this.bindPointer()
    new ResizeObserver(() => this.resize()).observe(host)
    this.resize()
    this.intro()
    this.renderer.setAnimationLoop(() => this.frame())
  }

  /** Replaces the whole resort with a new layout (Twin Studio edits, or a newly published version). */
  rebuild(layout: SiteLayout) {
    const dispose = (root: THREE.Object3D) => root.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose()
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []
      mats.forEach((x) => x.dispose())
    })
    this.scene.remove(this.site.root, this.rooms.group, this.overlays.group)
    this.overlays.dispose()
    dispose(this.site.root); dispose(this.rooms.group)
    this.layout = layout
    this.site = new Site(layout)
    this.rooms = new Rooms(layout)
    this.overlays = new Overlays(this.site, this.rooms, this.labelLayer)
    this.overlays.group.visible = !this.editMode
    this.scene.add(this.site.root, this.rooms.group, this.overlays.group)
    this.applyTime(this.nightOverride ? 22 : istHour())
    for (const [layer, list] of this.pinLists) this.overlays.setPins(layer, list)
    this.refresh()
  }

  private pinLists = new Map<string, MapPin[] | null>()
  /** A live layer's pins on the map (null hides it). */
  setPins(layer: string, list: MapPin[] | null) {
    this.pinLists.set(layer, list)
    this.overlays.setPins(layer, list)
    this.dirty = true
  }

  /** Flies to one pin; false if that layer has no such pin. */
  focusPin(layer: string, id: string) {
    const p = this.overlays.pinAt(layer, id)
    if (!p) return false
    this.flyTo(p, 60)
    return true
  }

  invalidate() { this.dirty = true }

  /** Twin Studio on/off: pointer goes to the editor and live status rings and arcs are hidden. */
  setEditMode(on: boolean) {
    this.editMode = on
    this.overlays.group.visible = !on
    this.invalidate()
  }

  /** Which layout object is under the pointer (Twin Studio). */
  layoutHit(clientX: number, clientY: number): string | null {
    this.setNdc(clientX, clientY)
    const hits = this.raycaster.intersectObjects([...this.rooms.editables, ...this.site.editables], false)
    for (const h of hits) {
      const id = this.rooms.layoutIdFromHit(h)
      if (id) return id
    }
    return null
  }

  /** The point on the ground under the pointer, in layout metres. */
  groundAt(clientX: number, clientY: number): [number, number] | null {
    this.setNdc(clientX, clientY)
    const p = new THREE.Vector3()
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? [p.x, p.z] : null
  }

  private setNdc(x: number, y: number) {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.camera)
  }

  /** Slides the view so a ground point is in the middle of the screen. */
  panTo(x: number, z: number) {
    const fromT = this.controls.target.clone(), fromP = this.camera.position.clone()
    const d = new THREE.Vector3(x - fromT.x, 0, z - fromT.z)
    this.tween(0.5, (k) => {
      const e = ease.inOutCubic(k)
      this.controls.target.copy(fromT).addScaledVector(d, e)
      this.camera.position.copy(fromP).addScaledVector(d, e)
    })
  }

  /** Looks straight down at the resort, like a site plan. */
  planView(on: boolean) {
    const fromT = this.controls.target.clone(), fromP = this.camera.position.clone()
    const toT = on ? new THREE.Vector3(10, 0, 14) : HOME_TARGET
    const toP = on ? new THREE.Vector3(10, 330, 14.5) : HOME_POS
    this.controls.enableRotate = !on
    // On the plan, one finger or the left button slides the map instead of orbiting.
    this.controls.mouseButtons.LEFT = on ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE
    this.controls.touches.ONE = on ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE
    this.tween(0.8, (k) => {
      const e = ease.inOutCubic(k)
      this.controls.target.lerpVectors(fromT, toT, e)
      this.camera.position.lerpVectors(fromP, toP, e)
    })
  }

  // ---------- state from the store ----------
  refresh() {
    this.rooms.update(this.store)
    this.overlays.update(this.store)
    this.dirty = true
  }

  /** The Night button: a preview of the resort after dark; off again, the sky follows the clock. */
  setNight(on: boolean) {
    this.nightOverride = on ? true : null
    this.applyTime(on ? 22 : istHour())
  }

  /** Sky, sun, lamps and lit windows for an hour of the day in India: dawn around 6, dusk around 18. */
  applyTime(h: number) {
    const dark = h < 5.5 || h >= 19 ? 1 : h < 7 ? 1 - (h - 5.5) / 1.5 : h < 17 ? 0 : (h - 17) / 2
    const dusk = Math.max(0, 1 - Math.abs(dark - 0.5) * 2)   // the orange hour, strongest at half light
    const mix = (a: number, b: number, k: number) => new THREE.Color(a).lerp(new THREE.Color(b), k)
    const bg = mix(0xd3ded7, 0x0d1726, dark).lerp(new THREE.Color(0xf0b58a), dusk * 0.55)
    this.scene.background = bg
    this.scene.fog = new THREE.Fog(bg, 420, 900)
    this.hemi.color.copy(mix(0xeaf4ff, 0x5272a8, dark).lerp(new THREE.Color(0xffc9a0), dusk * 0.5))
    this.hemi.groundColor.copy(mix(0x7d6b4f, 0x1b1c24, dark))
    this.hemi.intensity = 1.3 - 0.75 * dark
    this.sun.color.copy(mix(0xfff1dc, 0x9fb8ff, dark).lerp(new THREE.Color(0xff9a52), dusk * 0.7))
    this.sun.intensity = 2.4 - 1.95 * dark
    // The sun's path: in the east at dawn, overhead at noon, low in the west at dusk; the moon's light at night.
    const ang = ((Math.min(18, Math.max(6, h)) - 6) / 12) * Math.PI
    this.sun.position.set(-Math.cos(ang) * 240, Math.max(60, Math.sin(ang) * 230), 120 - Math.sin(ang) * 40)
    this.site.lampMaterial.emissiveIntensity = dark * 2.4
    this.site.waterUniforms.uNight.value = dark
    this.rooms.setGlow(dark > 0.4)
    this.overlays.alive.setDark(dark)
    this.night = dark > 0.5
    this.dirty = true
  }

  // ---------- tour mode: the camera glides around the resort until someone touches it ----------
  private tourOn = false
  private tourAngle = 0
  onTourEnd: () => void = () => {}
  get touring() { return this.tourOn }
  startTour() {
    if (this.tourOn || this.editMode) return
    this.tourOn = true
    this.tourAngle = Math.atan2(this.camera.position.z - HOME_TARGET.z, this.camera.position.x - HOME_TARGET.x)
    this.controls.enabled = false
    this.dirty = true
  }
  stopTour() {
    if (!this.tourOn) return
    this.tourOn = false
    this.controls.enabled = true
    this.onTourEnd()
  }

  setEco(on: boolean) {
    this.eco = on
    this.renderer.shadowMap.enabled = !on
    this.scene.traverse((o) => { if ((o as THREE.Mesh).material) ((o as THREE.Mesh).material as THREE.Material).needsUpdate = true })
    this.dirty = true
  }

  setExplode(on: boolean) { this.rooms.setExplode(on); this.dirty = true }

  highlight(id: string | null) {
    this.rooms.highlight(id)
    for (const [sid, mats] of this.site.materialsBySpace) {
      for (const m of mats) m.emissive.setHex(sid === id ? (this.night ? 0x554433 : 0x2f2a22) : 0x000000)
    }
    this.dirty = true
  }

  // ---------- camera ----------
  private intro() {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const risers = [...this.site.risers, { obj: this.rooms.group, delay: 0.05 }]
    if (reduce) {
      this.camera.position.copy(HOME_POS)
      this.controls.target.copy(HOME_TARGET)
      return
    }
    risers.forEach((r) => r.obj.scale.set(1, 0.001, 1))
    const p0 = new THREE.Vector3(8, 420, 30), t0 = new THREE.Vector3(8, 0, 10)
    this.camera.position.copy(p0)
    this.controls.target.copy(t0)
    const now = performance.now() / 1000
    this.introUntil = now + 3.2
    this.tween(2.8, (k) => {
      const e = ease.inOutCubic(k)
      this.camera.position.lerpVectors(p0, HOME_POS, e)
      this.controls.target.lerpVectors(t0, HOME_TARGET, e)
    }, 0.25)
    for (const r of risers) {
      this.tween(1.1, (k) => r.obj.scale.set(1, Math.max(0.001, ease.outBack(k)), 1), 0.5 + r.delay * 1.4)
    }
  }

  private tween(dur: number, fn: (k: number) => void, delay = 0) {
    this.tweens.push({ start: performance.now() / 1000 + delay, dur, fn })
  }

  flyTo(target: THREE.Vector3, distance: number) {
    const fromT = this.controls.target.clone(), fromP = this.camera.position.clone()
    const dir = fromP.clone().sub(fromT).normalize()
    if (dir.y < 0.45) { dir.y = 0.45; dir.normalize() }
    const toP = target.clone().add(dir.multiplyScalar(distance))
    this.tween(0.95, (k) => {
      const e = ease.inOutCubic(k)
      this.controls.target.lerpVectors(fromT, target, e)
      this.camera.position.lerpVectors(fromP, toP, e)
    })
  }

  focus(id: string) {
    const roomPos = this.rooms.anchor(id)
    const a = roomPos ?? this.site.anchors.get(id)?.pos
    if (!a) return
    if (this.rooms.isMainBlock(id)) this.setExplode(true)
    const sp = this.store.spaceById.get(id)
    const dist = sp?.type === 'room' ? 70 : sp?.type === 'villa' ? 55 : ['lawn', 'ground', 'hall'].includes(sp?.type ?? '') ? 120 : 80
    this.flyTo(new THREE.Vector3(a.x, roomPos ? a.y * 0.5 : 0, a.z), dist)
  }

  home() {
    this.setExplode(false)
    const fromT = this.controls.target.clone(), fromP = this.camera.position.clone()
    this.tween(1.1, (k) => {
      const e = ease.inOutCubic(k)
      this.controls.target.lerpVectors(fromT, HOME_TARGET, e)
      this.camera.position.lerpVectors(fromP, HOME_POS, e)
    })
  }

  zoom(f: number) {
    const off = this.camera.position.clone().sub(this.controls.target)
    const len = THREE.MathUtils.clamp(off.length() * f, this.controls.minDistance, this.controls.maxDistance)
    const fromP = this.camera.position.clone()
    const toP = this.controls.target.clone().add(off.setLength(len))
    this.tween(0.35, (k) => this.camera.position.lerpVectors(fromP, toP, ease.outCubic(k)))
  }

  // ---------- pointer ----------
  private bindPointer() {
    const el = this.renderer.domElement
    el.addEventListener('pointermove', (e) => {
      if (this.editMode) return
      if (e.pointerType === 'mouse' && e.buttons === 0) this.pendingPick = { x: e.clientX, y: e.clientY, pointer: 'hover' }
    })
    el.addEventListener('pointerleave', () => { this.setHover(null, 0, 0, 'mouse') })
    el.addEventListener('pointerdown', (e) => { this.stopTour(); this.down = { x: e.clientX, y: e.clientY, t: performance.now() } })
    el.addEventListener('wheel', () => this.stopTour(), { passive: true })
    el.addEventListener('pointerup', (e) => {
      if (this.editMode) return
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y)
      if (moved > 8 || performance.now() - this.down.t > 450) return
      const id = this.pick(e.clientX, e.clientY)
      const now = performance.now()
      if (id && this.lastTap.id === id && now - this.lastTap.t < 320) {
        this.cb.onFocus(id)
        this.lastTap = { id: null, t: 0 }
        return
      }
      this.lastTap = { id, t: now }
      this.cb.onTap(id, e.clientX, e.clientY, e.pointerType)
    })
  }

  private pick(x: number, y: number): string | null {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.camera)
    // An order marker counts as a tap on its room or outlet.
    const [mk] = this.raycaster.intersectObjects(this.overlays.markerMeshes, false)
    if (mk && mk.instanceId != null) { const id = this.overlays.markerOrigin(mk.object, mk.instanceId); if (id && this.store.spaceById.has(id)) return id }
    const hits = this.raycaster.intersectObjects([...this.rooms.pickables, ...this.site.pickables], false)
    for (const h of hits) {
      const id = this.rooms.idFromHit(h)
      if (id && this.store.spaceById.has(id)) return id
    }
    return null
  }

  private setHover(id: string | null, x: number, y: number, pointer: string) {
    if (id !== this.hoverId) {
      this.hoverId = id
      this.renderer.domElement.style.cursor = id ? 'pointer' : 'grab'
    }
    this.cb.onHover(id, x, y, pointer)
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight
    this.size = { w, h }
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / Math.max(h, 1)
    this.camera.fov = w < 640 ? 50 : 38
    this.camera.updateProjectionMatrix()
    this.dirty = true
  }

  // ---------- loop ----------
  private frame() {
    const now = performance.now() / 1000
    let active = now < this.introUntil
    this.tweens = this.tweens.filter((tw) => {
      if (now < tw.start) { active = true; return true }
      const k = Math.min(1, (now - tw.start) / tw.dur)
      tw.fn(k)
      active = true
      return k < 1
    })
    if (this.tourOn) {
      // A slow orbit with a gentle rise and fall, like a drone over the resort.
      const dt = Math.min(0.1, now - (this.lastFrame || now))
      this.tourAngle += dt * 0.06
      const r = 230 + Math.sin(now * 0.09) * 50, y = 125 + Math.sin(now * 0.06) * 40
      this.camera.position.set(HOME_TARGET.x + Math.cos(this.tourAngle) * r, y, HOME_TARGET.z + Math.sin(this.tourAngle) * r)
      this.controls.target.copy(HOME_TARGET)
      this.camera.lookAt(HOME_TARGET)
      active = true
    }
    this.lastFrame = now
    const ambient = !this.eco
    if (ambient) {
      this.site.waterUniforms.uTime.value = now
      this.site.treeUniforms.uTime.value = now
    }
    active = this.rooms.tick(now, ambient) || active
    active = this.overlays.tick(now, ambient) || active
    if (this.pendingPick) {
      const p = this.pendingPick
      this.pendingPick = null
      this.setHover(this.pick(p.x, p.y), p.x, p.y, 'mouse')
    }
    const moved = this.controls.update()
    if (moved || active || ambient || this.dirty) {
      this.renderer.render(this.scene, this.camera)
      this.overlays.projectLabels(this.camera, this.size.w, this.size.h)
      this.dirty = false
    }
  }
}
