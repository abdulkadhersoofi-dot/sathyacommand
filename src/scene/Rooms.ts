import * as THREE from 'three'
import { blockCells, rectPoly, type SiteLayout } from '../data/layout'
import type { Store } from '../data/store'
import { extruded, hipRoof, centroid, scalePoly } from './geo'
import { FACADE, HK_HEX, STATUS_HEX, revenueColor } from './palette'

// Status-driven lodging: every room block as one instanced mesh of room cells,
// and the villas / cottages as individual buildings with a status halo.

interface Cell { id: string; floor: number; x: number; z: number; sx: number; sz: number; fh: number; blockId: string }

const SLAB = 0.32

export class Rooms {
  group = new THREE.Group()
  pickables: THREE.Object3D[] = []
  editables: THREE.Object3D[] = []
  glow = { value: 0.12 }
  private cells: Cell[] = []
  private cellById = new Map<string, Cell>()
  private slabs: { cell: Cell; level: number; top: boolean }[] = []
  private roomMesh: THREE.InstancedMesh
  private slabMesh: THREE.InstancedMesh
  private baseColors = new Map<string, THREE.Color>()
  private pulsing = new Set<string>()
  private hovered: string | null = null
  private explode = 0
  private explodeTarget = 0
  private villaParts = new Map<string, { walls: THREE.MeshStandardMaterial; roof: THREE.MeshStandardMaterial; halo: THREE.Mesh; center: THREE.Vector3 }>()
  private tmpC = new THREE.Color()

  constructor(private layout: SiteLayout) {
    for (const b of layout.blocks) {
      const cells = blockCells(b).map((c) => ({ ...c, fh: b.floorHeight, blockId: b.id }))
      this.cells.push(...cells)
      // one slab ring under each floor and a roof ring on top, following the first floor's cells
      const ring = cells.filter((c) => c.floor === 1)
      for (let level = 0; level <= b.floors; level++) for (const c of ring) this.slabs.push({ cell: c, level, top: level === b.floors })
    }
    for (const c of this.cells) this.cellById.set(c.id, c)

    const roomMat = new THREE.MeshStandardMaterial({ roughness: 0.75, map: windowTexture() })
    roomMat.onBeforeCompile = (sh) => {
      sh.uniforms.uGlow = this.glow
      sh.fragmentShader = 'uniform float uGlow;\n' + sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n totalEmissiveRadiance += vColor.rgb * uGlow;',
      )
    }
    this.roomMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), roomMat, Math.max(1, this.cells.length))
    this.roomMesh.count = this.cells.length
    this.roomMesh.castShadow = this.roomMesh.receiveShadow = true
    this.roomMesh.userData.instanceIds = this.cells.map((c) => c.id)
    this.cells.forEach((_c, i) => this.roomMesh.setColorAt(i, FACADE))

    this.slabMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.9 }), Math.max(1, this.slabs.length))
    this.slabMesh.count = this.slabs.length
    this.slabMesh.castShadow = true
    this.slabs.forEach((s, i) => this.slabMesh.setColorAt(i, new THREE.Color(s.top ? 0x9a7c62 : 0xd9d2c5)))
    this.layoutMatrices()
    this.group.add(this.roomMesh, this.slabMesh)
    if (this.cells.length) this.pickables.push(this.roomMesh)
    this.editables.push(this.roomMesh, this.slabMesh)

    // courtyard gardens
    for (const b of layout.blocks) {
      const court = new THREE.Mesh(
        extruded(scalePoly(rectPoly(b.rect), 0.45), 0.15),
        new THREE.MeshStandardMaterial({ color: 0x78a65c, roughness: 1 }),
      )
      court.receiveShadow = true
      court.userData.layoutId = b.id
      this.editables.push(court)
      this.group.add(court)
    }
    this.buildVillas()
  }

  private floorBase(f: number, fh: number) { return (f - 1) * fh + (f - 1) * this.explode * 5 }

  private layoutMatrices() {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion()
    this.cells.forEach((c, i) => {
      const h = c.fh - SLAB
      m.compose(new THREE.Vector3(c.x, this.floorBase(c.floor, c.fh) + SLAB + h / 2, c.z), q, new THREE.Vector3(c.sx - 0.45, h, c.sz - 0.45))
      this.roomMesh.setMatrixAt(i, m)
    })
    this.slabs.forEach((s, i) => {
      const c = s.cell
      const y = s.top ? this.floorBase(s.level, c.fh) + c.fh + SLAB / 2 : this.floorBase(s.level + 1, c.fh) + SLAB / 2
      m.compose(new THREE.Vector3(c.x, y, c.z), q, new THREE.Vector3(c.sx + 0.3, s.top ? SLAB * 1.6 : SLAB, c.sz + 0.3))
      this.slabMesh.setMatrixAt(i, m)
    })
    this.roomMesh.instanceMatrix.needsUpdate = true
    this.slabMesh.instanceMatrix.needsUpdate = true
    this.roomMesh.computeBoundingSphere()
    this.slabMesh.computeBoundingSphere()
  }

  private buildVillas() {
    for (const v of this.layout.villas) {
      const walls = new THREE.MeshStandardMaterial({ color: FACADE, roughness: 0.85 })
      const roof = new THREE.MeshStandardMaterial({ color: v.kind === 'tent' ? 0xf3f1ec : 0xc8643b, roughness: 0.8, flatShading: true, side: THREE.DoubleSide })
      const wallH = v.kind === 'tent' ? 2.2 : 3.2
      const w = new THREE.Mesh(extruded(v.poly, wallH), walls)
      const r = new THREE.Mesh(hipRoof(v.poly, wallH, 2.4, 1.12), roof)
      w.castShadow = r.castShadow = true
      w.userData.spaceId = r.userData.spaceId = v.id
      w.userData.layoutId = r.userData.layoutId = v.id
      const [cx, cz] = centroid(v.poly)
      const size = Math.max(...v.poly.map(([x, z]) => Math.hypot(x - cx, z - cz)))
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(size * 1.05, size * 1.45, 40).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }),
      )
      halo.position.set(cx, 0.15, cz)
      this.group.add(w, r, halo)
      this.pickables.push(w, r)
      this.editables.push(w, r)
      this.villaParts.set(v.id, { walls, roof, halo, center: new THREE.Vector3(cx, wallH, cz) })
    }
  }

  /** The layout object (block or villa) a ray hit belongs to. */
  layoutIdFromHit(hit: THREE.Intersection): string | undefined {
    if (hit.object === this.roomMesh && hit.instanceId != null) return this.cells[hit.instanceId]?.blockId
    if (hit.object === this.slabMesh && hit.instanceId != null) return this.slabs[hit.instanceId]?.cell.blockId
    return hit.object.userData.layoutId
  }

  // Recolour everything for the current date and layer.
  update(store: Store) {
    const mode = store.layers.has('rooms') ? 'rooms' : store.layers.has('housekeeping') ? 'hk' : store.layers.has('revenue') ? 'rev' : 'none'
    this.pulsing.clear()
    const ids = [...this.cells.map((c) => c.id), ...this.villaParts.keys()]
    for (const id of ids) {
      if (!store.spaceById.has(id)) continue
      const st = store.state(id)
      let col: THREE.Color
      if (mode === 'rooms') {
        col = new THREE.Color(STATUS_HEX[st.status])
        if (st.status === 'arriving' || st.status === 'departing') this.pulsing.add(id)
      } else if (mode === 'hk') {
        col = new THREE.Color(HK_HEX[store.hk[id] ?? 'clean'])
      } else if (mode === 'rev') {
        col = revenueColor(st.revenue / 11000)
      } else col = FACADE.clone()
      this.baseColors.set(id, col)
      const villa = this.villaParts.get(id)
      if (villa) {
        villa.halo.visible = mode !== 'none'
        ;(villa.halo.material as THREE.MeshBasicMaterial).color.copy(col)
        villa.walls.color.copy(mode === 'none' ? FACADE : FACADE.clone().lerp(col, 0.55))
      }
    }
    this.paint(0)
  }

  setGlow(night: boolean) { this.glow.value = night ? 0.55 : 0.1 }

  private paint(t: number) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 4.2)
    this.cells.forEach((c, i) => {
      const base = this.baseColors.get(c.id) ?? FACADE
      this.tmpC.copy(base)
      if (this.pulsing.has(c.id)) this.tmpC.lerp(FACADE, pulse * 0.45)
      if (this.hovered === c.id) this.tmpC.lerp(new THREE.Color(0xffffff), 0.45)
      this.roomMesh.setColorAt(i, this.tmpC)
    })
    this.roomMesh.instanceColor!.needsUpdate = true
    for (const [id, v] of this.villaParts) {
      const hov = this.hovered === id
      v.walls.emissive.setHex(hov ? 0x444444 : 0)
      v.roof.emissive.setHex(hov ? 0x3a1a0a : 0)
      const mat = v.halo.material as THREE.MeshBasicMaterial
      mat.opacity = this.pulsing.has(id) ? 0.35 + 0.6 * pulse : 0.85
      v.halo.scale.setScalar(this.pulsing.has(id) ? 1 + pulse * 0.08 : 1)
    }
  }

  highlight(id: string | null) { this.hovered = id; this.paint(performance.now() / 1000) }

  setExplode(on: boolean) { this.explodeTarget = on ? 1 : 0 }
  get exploded() { return this.explodeTarget === 1 }

  // Returns true while something is still moving.
  tick(t: number, ambient: boolean) {
    let moving = false
    if (Math.abs(this.explode - this.explodeTarget) > 0.001) {
      this.explode += (this.explodeTarget - this.explode) * 0.14
      if (Math.abs(this.explode - this.explodeTarget) < 0.002) this.explode = this.explodeTarget
      this.layoutMatrices()
      moving = true
    }
    if (ambient && this.pulsing.size) { this.paint(t); moving = true }
    return moving
  }

  idFromHit(hit: THREE.Intersection): string | undefined {
    if (hit.object === this.roomMesh && hit.instanceId != null) return this.cells[hit.instanceId].id
    return hit.object.userData.spaceId
  }

  anchor(id: string): THREE.Vector3 | undefined {
    const c = this.cellById.get(id)
    if (c) return new THREE.Vector3(c.x, this.floorBase(c.floor, c.fh) + c.fh, c.z)
    return this.villaParts.get(id)?.center.clone()
  }

  isMainBlock(id: string) { return this.cellById.has(id) }
}

function windowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, 64, 64)
  g.fillStyle = '#b9c4cc'
  g.fillRect(14, 16, 36, 30)
  g.fillStyle = '#e4e7e9'
  g.fillRect(31, 16, 2, 30)
  g.fillRect(12, 46, 40, 3)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
