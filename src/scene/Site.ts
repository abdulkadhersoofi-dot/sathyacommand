import * as THREE from 'three'
import { rectPoly, type SiteLayout, type V2 } from '../data/layout'
import { centroid, distToPolyline, extruded, flatPatch, hipRoof, inPoly, ribbon, scalePoly } from './geo'

// Static scenery: terrain, drives, pool, trees, lamps and the non-room buildings.

const GROUND_COLORS: Record<string, number> = {
  lawn: 0x6f9f55, field: 0xb69468, plot: 0xc7b08a, paved: 0xb9b2a4, deck: 0xd8d1c3,
}

export interface Anchor { pos: THREE.Vector3; poly?: V2[]; height: number }

export class Site {
  root = new THREE.Group()
  risers: { obj: THREE.Object3D; delay: number }[] = []
  pickables: THREE.Object3D[] = []
  materialsBySpace = new Map<string, THREE.MeshStandardMaterial[]>()
  anchors = new Map<string, Anchor>()
  lampMaterial: THREE.MeshStandardMaterial
  waterUniforms = { uTime: { value: 0 }, uNight: { value: 0 } }
  treeUniforms = { uTime: { value: 0 } }
  /** Every drawn object that Twin Studio can select, tagged with userData.layoutId. */
  editables: THREE.Object3D[] = []
  roadPaths: V2[][]

  constructor(public layout: SiteLayout) {
    this.roadPaths = layout.roads.filter((r) => r.kind === 'drive').map((r) => r.pts)
    this.buildTerrain()
    this.buildPool()
    this.buildBuildings()
    this.buildTrees()
    this.lampMaterial = this.buildLamps()
  }

  private addSpaceMaterial(spaceId: string | undefined, m: THREE.MeshStandardMaterial) {
    if (!spaceId) return
    const list = this.materialsBySpace.get(spaceId) ?? []
    list.push(m)
    this.materialsBySpace.set(spaceId, list)
  }

  private buildTerrain() {
    const [x0, z0] = this.layout.bounds.min, [x1, z1] = this.layout.bounds.max
    const w = x1 - x0 + 160, d = z1 - z0 + 160
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xa8a079, roughness: 1, map: grainTexture() }),
    )
    base.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2)
    base.receiveShadow = true
    this.root.add(base)

    this.layout.ground.forEach((g, i) => {
      const mat = new THREE.MeshStandardMaterial({ color: GROUND_COLORS[g.kind], roughness: 1 })
      const mesh = new THREE.Mesh(flatPatch(g.poly, 0.03 + i * 0.004), mat)
      mesh.receiveShadow = true
      mesh.userData.layoutId = g.id
      this.editables.push(mesh)
      if (g.spaceId) {
        mesh.userData.spaceId = g.spaceId
        this.pickables.push(mesh)
        this.addSpaceMaterial(g.spaceId, mat)
        const [cx, cz] = centroid(g.poly)
        if (!this.anchors.has(g.spaceId)) this.anchors.set(g.spaceId, { pos: new THREE.Vector3(cx, 0, cz), poly: g.poly, height: 0 })
      }
      this.root.add(mesh)
    })

    // cricket pitch strip
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(3, 20).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xd8c39a, roughness: 1 }))
    const c = this.anchors.get('GROUND-CRICKET')?.pos
    if (c) {
      pitch.position.set(c.x, 0.07, c.z)
      this.root.add(pitch)
    }

    for (const r of this.layout.roads) {
      const mat = new THREE.MeshStandardMaterial({ color: r.kind === 'highway' ? 0x5d5f61 : 0xa49c8e, roughness: 0.95, side: THREE.DoubleSide })
      const mesh = new THREE.Mesh(ribbon(r.pts, r.width, r.kind === 'highway' ? 0.05 : 0.08), mat)
      mesh.receiveShadow = true
      mesh.userData.layoutId = r.id
      this.editables.push(mesh)
      this.root.add(mesh)
    }
  }

  private buildPool() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.waterUniforms,
      vertexShader: `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `
        uniform float uTime; uniform float uNight; varying vec2 vP;
        void main(){
          float w = sin(vP.x*0.9+uTime*1.4)*sin(vP.y*1.1-uTime*1.1) + sin((vP.x+vP.y)*0.6+uTime*0.8);
          float c = smoothstep(0.9, 1.6, w);
          vec3 day = mix(vec3(0.20,0.62,0.78), vec3(0.75,0.95,1.0), c*0.55);
          vec3 night = mix(vec3(0.05,0.35,0.55), vec3(0.35,0.85,1.0), c*0.7);
          gl_FragColor = vec4(mix(day, night, uNight), 1.0);
        }`,
    })
    for (const p of this.layout.pools) {
      const water = new THREE.Mesh(flatPatch(p.poly, 0.12), mat)
      water.userData.layoutId = p.id
      this.editables.push(water)
      if (p.spaceId) {
        water.userData.spaceId = p.spaceId
        this.pickables.push(water)
        const [cx, cz] = centroid(p.poly)
        this.anchors.set(p.spaceId, { pos: new THREE.Vector3(cx, 0, cz), poly: p.poly, height: 0 })
      }
      this.root.add(water)
    }
  }

  private buildBuildings() {
    const center = new THREE.Vector2(0, 0)
    for (const b of this.layout.buildings) {
      const g = new THREE.Group()
      const wallMat = new THREE.MeshStandardMaterial({ color: b.wallColor, roughness: 0.85 })
      const roofMat = new THREE.MeshStandardMaterial({ color: b.roofColor, roughness: 0.8, flatShading: true, side: THREE.DoubleSide })
      this.addSpaceMaterial(b.spaceId, wallMat)
      this.addSpaceMaterial(b.spaceId, roofMat)

      if (b.roof === 'canopy') {
        // open pavilion: posts + a low white tent roof
        const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.18, b.height, 6), wallMat, 4 * 4)
        const q = scalePoly(b.poly, 0.94)
        let i = 0
        const m = new THREE.Matrix4()
        for (let e = 0; e < 4; e++) {
          const a = q[e], c = q[(e + 1) % 4]
          for (let k = 0; k < 4; k++) {
            const t = k / 4
            m.makeTranslation(a[0] + (c[0] - a[0]) * t, b.height / 2, a[1] + (c[1] - a[1]) * t)
            posts.setMatrixAt(i++, m)
          }
        }
        posts.castShadow = true
        g.add(posts)
        const roof = new THREE.Mesh(hipRoof(b.poly, b.height, 1.6, 1.02), roofMat)
        roof.castShadow = true
        g.add(roof)
        const floor = new THREE.Mesh(flatPatch(b.poly, 0.1), new THREE.MeshStandardMaterial({ color: 0xcfc6b6, roughness: 1 }))
        floor.receiveShadow = true
        g.add(floor)
        roof.userData.spaceId = b.spaceId
        roof.userData.layoutId = posts.userData.layoutId = b.id
        this.pickables.push(roof)
        this.editables.push(roof, posts)
      } else {
        const walls = new THREE.Mesh(extruded(b.poly, b.height), wallMat)
        walls.castShadow = walls.receiveShadow = true
        const roof = b.roof === 'hip'
          ? new THREE.Mesh(hipRoof(b.poly, b.height, Math.min(4, b.height * 0.45)), roofMat)
          : new THREE.Mesh(extruded(scalePoly(b.poly, 1.015), 0.5, b.height), roofMat)
        roof.castShadow = true
        walls.userData.spaceId = roof.userData.spaceId = b.spaceId
        walls.userData.layoutId = roof.userData.layoutId = b.id
        this.pickables.push(walls, roof)
        this.editables.push(walls, roof)
        g.add(walls, roof)
      }

      const [cx, cz] = centroid(b.poly)
      if (b.spaceId && !this.anchors.has(b.spaceId)) {
        this.anchors.set(b.spaceId, { pos: new THREE.Vector3(cx, b.height, cz), poly: b.poly, height: b.height })
      }
      g.userData.base = new THREE.Vector3(cx, 0, cz)
      this.root.add(g)
      this.risers.push({ obj: g, delay: 0.15 + center.distanceTo(new THREE.Vector2(cx, cz)) / 260 })
    }

    // entrance gate arch
    const gate = new THREE.Group()
    const gm = new THREE.MeshStandardMaterial({ color: 0xc8643b, roughness: 0.8 })
    const [gx, gz] = this.layout.gate
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.2, 6, 1.2), gm)
      p.position.set(gx + s * 3.8 * 0.84, 3, gz - s * 3.8 * 0.55)
      p.castShadow = true
      gate.add(p)
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(9, 1, 1.4), gm)
    beam.position.set(gx, 6.3, gz)
    beam.rotation.y = Math.atan2(0.55, 0.84)
    gate.add(beam)
    this.root.add(gate)
    this.risers.push({ obj: gate, delay: 0.05 })
  }

  private buildTrees() {
    const r = mulberry(4242)
    const [x0, z0] = this.layout.bounds.min, [x1, z1] = this.layout.bounds.max
    const blockers = [
      ...this.layout.buildings.map((b) => scalePoly(b.poly, 1.25)),
      ...this.layout.villas.map((v) => scalePoly(v.poly, 1.5)),
      ...this.layout.ground.map((g) => g.poly),
      ...this.layout.pools.map((p) => scalePoly(p.poly, 1.1)),
      ...this.layout.blocks.map((b) => scalePoly(rectPoly(b.rect), 1.12)),
    ]
    const pts: { p: V2; s: number }[] = []
    for (let tries = 0; tries < 6000 && pts.length < 520; tries++) {
      const p: V2 = [x0 + r() * (x1 - x0), z0 + r() * (z1 - z0)]
      if (blockers.some((b) => inPoly(p, b))) continue
      if (this.layout.roads.some((rd) => distToPolyline(p, rd.pts) < rd.width / 2 + 2.2)) continue
      if (pts.some((q) => Math.hypot(q.p[0] - p[0], q.p[1] - p[1]) < 4.2)) continue
      pts.push({ p, s: 2.2 + r() * 2.4 })
    }

    const canopyGeo = new THREE.IcosahedronGeometry(1, 0)
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 1, 5).translate(0, 0.5, 0)
    const canopyMat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true })
    canopyMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.treeUniforms.uTime
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        float ph = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.17;
        transformed.x += sin(uTime * 1.2 + ph) * 0.07 * (position.y + 1.0);
        transformed.z += cos(uTime * 0.9 + ph) * 0.05 * (position.y + 1.0);`)
    }
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, pts.length)
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b5641, roughness: 1 }), pts.length)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color()
    const greens = [0x3f6b34, 0x4c7a3a, 0x5a8a42, 0x355f30, 0x66924a]
    pts.forEach(({ p, s }, i) => {
      const trunkH = s * 0.9
      q.setFromEuler(new THREE.Euler(0, r() * Math.PI, 0))
      m.compose(new THREE.Vector3(p[0], trunkH + s * 0.55, p[1]), q, new THREE.Vector3(s, s * (0.8 + r() * 0.3), s))
      canopies.setMatrixAt(i, m)
      canopies.setColorAt(i, col.setHex(greens[Math.floor(r() * greens.length)]).offsetHSL(0, 0, (r() - 0.5) * 0.06))
      m.compose(new THREE.Vector3(p[0], 0, p[1]), q, new THREE.Vector3(1, trunkH + s * 0.3, 1))
      trunks.setMatrixAt(i, m)
    })
    canopies.castShadow = true
    const g = new THREE.Group()
    g.add(canopies, trunks)
    this.root.add(g)
    this.risers.push({ obj: g, delay: 0.9 })
  }

  private buildLamps() {
    const pts: V2[] = []
    for (const path of this.roadPaths) {
      let acc = 0
      for (let i = 0; i < path.length - 1; i++) {
        const [ax, az] = path[i], [bx, bz] = path[i + 1]
        const L = Math.hypot(bx - ax, bz - az)
        for (let t = 16 - acc; t < L; t += 16) {
          const k = t / L
          pts.push([ax + (bx - ax) * k + ((bz - az) / L) * 3.4, az + (bz - az) * k - ((bx - ax) / L) * 3.4])
        }
        acc = (acc + L) % 16
      }
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0xfff1cc, emissive: 0xffc566, emissiveIntensity: 0 })
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 8, 6), mat, pts.length)
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.08, 3.2, 5).translate(0, 1.6, 0), new THREE.MeshStandardMaterial({ color: 0x3d3f42 }), pts.length)
    const m = new THREE.Matrix4()
    pts.forEach((p, i) => {
      m.makeTranslation(p[0], 3.3, p[1]); bulbs.setMatrixAt(i, m)
      m.makeTranslation(p[0], 0, p[1]); poles.setMatrixAt(i, m)
    })
    this.root.add(bulbs, poles)
    return mat
  }
}

export function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function grainTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(128, 128)
  const r = mulberry(7)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 225 + r() * 30
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v * 0.97; img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(30, 30)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
