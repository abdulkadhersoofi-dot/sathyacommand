import * as THREE from 'three'
import { SITE } from '../data/registry'
import type { Store } from '../data/store'
import { extruded, hipRoof, centroid, scalePoly } from './geo'
import { mainBlockPoly } from './Site'
import { FACADE, HK_HEX, STATUS_HEX, revenueColor } from './palette'

// Status-driven lodging: the Park Wing as one instanced mesh of room cells,
// and the garden villas as individual cottages with a status halo.

interface Cell { id: string; floor: number; x: number; z: number; sx: number; sz: number }

const SLAB = 0.32

export class Rooms {
  group = new THREE.Group()
  pickables: THREE.Object3D[] = []
  glow = { value: 0.12 }
  private cells: Cell[] = []
  private roomMesh: THREE.InstancedMesh
  private slabMesh: THREE.InstancedMesh
  private baseColors = new Map<string, THREE.Color>()
  private pulsing = new Set<string>()
  private hovered: string | null = null
  private explode = 0
  private explodeTarget = 0
  private villaParts = new Map<string, { walls: THREE.MeshStandardMaterial; roof: THREE.MeshStandardMaterial; halo: THREE.Mesh; center: THREE.Vector3 }>()
  private tmpC = new THREE.Color()
  private fh = SITE.mainBlock.floorHeight

  constructor() {
    this.layoutCells()
    const n = this.cells.length
    const roomMat = new THREE.MeshStandardMaterial({ roughness: 0.75, map: windowTexture() })
    roomMat.onBeforeCompile = (sh) => {
      sh.uniforms.uGlow = this.glow
      sh.fragmentShader = 'uniform float uGlow;\n' + sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n totalEmissiveRadiance += vColor.rgb * uGlow;',
      )
    }
    this.roomMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), roomMat, n)
    this.roomMesh.castShadow = this.roomMesh.receiveShadow = true
    this.roomMesh.userData.instanceIds = this.cells.map((c) => c.id)
    this.cells.forEach((c, i) => this.roomMesh.setColorAt(i, FACADE))

    const floors = SITE.mainBlock.floors
    this.slabMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.9 }), 12 * (floors + 1))
    this.slabMesh.castShadow = true
    for (let f = 0; f <= floors; f++) {
      for (let k = 0; k < 12; k++) {
        this.slabMesh.setColorAt(f * 12 + k, new THREE.Color(f === floors ? 0x9a7c62 : 0xd9d2c5))
      }
    }
    this.layoutMatrices()

    // courtyard garden
    const court = new THREE.Mesh(
      extruded(scalePoly(mainBlockPoly(), 0.45), 0.15),
      new THREE.MeshStandardMaterial({ color: 0x78a65c, roughness: 1 }),
    )
    court.receiveShadow = true
    this.group.add(this.roomMesh, this.slabMesh, court)
    this.pickables.push(this.roomMesh)
    this.buildVillas()
  }

  private layoutCells() {
    const [[x0, z0], , [x1, z1]] = mainBlockPoly()
    const d = SITE.mainBlock.depth
    const W = x1 - x0, innerZ = z1 - z0 - 2 * d
    const sides: { n: number; cell: (i: number) => Omit<Cell, 'id' | 'floor'> }[] = [
      { n: 4, cell: (i) => ({ x: x0 + W * (i + 0.5) / 4, z: z0 + d / 2, sx: W / 4, sz: d }) },
      { n: 2, cell: (i) => ({ x: x1 - d / 2, z: z0 + d + innerZ * (i + 0.5) / 2, sx: d, sz: innerZ / 2 }) },
      { n: 4, cell: (i) => ({ x: x1 - W * (i + 0.5) / 4, z: z1 - d / 2, sx: W / 4, sz: d }) },
      { n: 2, cell: (i) => ({ x: x0 + d / 2, z: z1 - d - innerZ * (i + 0.5) / 2, sx: d, sz: innerZ / 2 }) },
    ]
    for (let f = 1; f <= SITE.mainBlock.floors; f++) {
      let r = 1
      for (const s of sides) {
        for (let i = 0; i < s.n; i++, r++) {
          this.cells.push({ id: `MAIN-${f}-${f}${String(r).padStart(2, '0')}`, floor: f, ...s.cell(i) })
        }
      }
    }
  }

  private floorBase(f: number) { return (f - 1) * this.fh + (f - 1) * this.explode * 5 }

  private layoutMatrices() {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion()
    this.cells.forEach((c, i) => {
      const h = this.fh - SLAB
      m.compose(new THREE.Vector3(c.x, this.floorBase(c.floor) + SLAB + h / 2, c.z), q, new THREE.Vector3(c.sx - 0.45, h, c.sz - 0.45))
      this.roomMesh.setMatrixAt(i, m)
    })
    const floors = SITE.mainBlock.floors
    const ring = this.cells.slice(0, 12)
    for (let f = 0; f <= floors; f++) {
      ring.forEach((c, k) => {
        const y = f < floors ? this.floorBase(f + 1) + SLAB / 2 : this.floorBase(floors) + this.fh + SLAB / 2
        m.compose(new THREE.Vector3(c.x, y, c.z), q, new THREE.Vector3(c.sx + 0.3, f === floors ? SLAB * 1.6 : SLAB, c.sz + 0.3))
        this.slabMesh.setMatrixAt(f * 12 + k, m)
      })
    }
    this.roomMesh.instanceMatrix.needsUpdate = true
    this.slabMesh.instanceMatrix.needsUpdate = true
    this.roomMesh.computeBoundingSphere()
    this.slabMesh.computeBoundingSphere()
  }

  private buildVillas() {
    for (const v of SITE.villas) {
      const walls = new THREE.MeshStandardMaterial({ color: FACADE, roughness: 0.85 })
      const roof = new THREE.MeshStandardMaterial({ color: 0xc8643b, roughness: 0.8, flatShading: true, side: THREE.DoubleSide })
      const w = new THREE.Mesh(extruded(v.poly, 3.2), walls)
      const r = new THREE.Mesh(hipRoof(v.poly, 3.2, 2.4, 1.12), roof)
      w.castShadow = r.castShadow = true
      w.userData.spaceId = r.userData.spaceId = v.id
      const [cx, cz] = centroid(v.poly)
      const size = Math.max(...v.poly.map(([x, z]) => Math.hypot(x - cx, z - cz)))
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(size * 1.05, size * 1.45, 40).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }),
      )
      halo.position.set(cx, 0.15, cz)
      this.group.add(w, r, halo)
      this.pickables.push(w, r)
      this.villaParts.set(v.id, { walls, roof, halo, center: new THREE.Vector3(cx, 3.2, cz) })
    }
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
    const c = this.cells.find((x) => x.id === id)
    if (c) return new THREE.Vector3(c.x, this.floorBase(c.floor) + this.fh, c.z)
    return this.villaParts.get(id)?.center.clone()
  }

  isMainBlock(id: string) { return id.startsWith('MAIN-') }
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
