import * as THREE from 'three'
import type { V2 } from '../data/registry'

// Footprints are [x, z] in metres. Shapes live in the XY plane, so z is
// negated going in and the geometry is rotated flat (-90° about X) coming out.

export function shapeOf(poly: V2[]) {
  return new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)))
}

export function flatPatch(poly: V2[], y: number) {
  const g = new THREE.ShapeGeometry(shapeOf(poly))
  g.rotateX(-Math.PI / 2)
  g.translate(0, y, 0)
  return g
}

export function extruded(poly: V2[], height: number, y = 0) {
  const g = new THREE.ExtrudeGeometry(shapeOf(poly), { depth: height, bevelEnabled: false })
  g.rotateX(-Math.PI / 2)
  g.translate(0, y, 0)
  return g
}

export function centroid(poly: V2[]): V2 {
  const n = poly.length
  return [poly.reduce((a, p) => a + p[0], 0) / n, poly.reduce((a, p) => a + p[1], 0) / n]
}

export function scalePoly(poly: V2[], k: number): V2[] {
  const [cx, cz] = centroid(poly)
  return poly.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k])
}

// Hip roof over a 4-corner footprint: two ridge points inset from the short edges.
export function hipRoof(poly: V2[], baseY: number, rise: number, overhang = 1.07) {
  const q = scalePoly(poly, overhang)
  const len = (a: V2, b: V2) => Math.hypot(b[0] - a[0], b[1] - a[1])
  // rotate the quad so q[0]-q[1] is a short edge
  const k = len(q[0], q[1]) <= len(q[1], q[2]) ? 0 : 1
  const [a, b, c, d] = [q[k], q[(k + 1) % 4], q[(k + 2) % 4], q[(k + 3) % 4]]
  const short = (len(a, b) + len(c, d)) / 2
  const mAB: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const mCD: V2 = [(c[0] + d[0]) / 2, (c[1] + d[1]) / 2]
  const L = len(mAB, mCD)
  const t = Math.min(0.49, short / 2 / L)
  const r1: V2 = [mAB[0] + (mCD[0] - mAB[0]) * t, mAB[1] + (mCD[1] - mAB[1]) * t]
  const r2: V2 = [mCD[0] + (mAB[0] - mCD[0]) * t, mCD[1] + (mAB[1] - mCD[1]) * t]
  const top = baseY + rise
  const V = (p: V2, y: number) => [p[0], y, p[1]]
  const tris = [
    [V(a, baseY), V(r1, top), V(b, baseY)],
    [V(c, baseY), V(r2, top), V(d, baseY)],
    [V(b, baseY), V(r1, top), V(r2, top)], [V(b, baseY), V(r2, top), V(c, baseY)],
    [V(d, baseY), V(r2, top), V(r1, top)], [V(d, baseY), V(r1, top), V(a, baseY)],
  ]
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(2), 3))
  g.computeVertexNormals()  // winding varies with footprint order; roof material is double-sided
  return g
}

// Road ribbon along a centre-line.
export function ribbon(pts: V2[], width: number, y: number) {
  const pos: number[] = []
  const left: V2[] = [], right: V2[] = []
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]
    let dx = b[0] - a[0], dz = b[1] - a[1]
    const l = Math.hypot(dx, dz) || 1
    dx /= l; dz /= l
    const h = width / 2
    left.push([p[0] - dz * h, p[1] + dx * h])
    right.push([p[0] + dz * h, p[1] - dx * h])
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const [l0, l1, r0, r1] = [left[i], left[i + 1], right[i], right[i + 1]]
    // keep every triangle counter-clockwise seen from above so it faces up
    for (const [a, b, c] of [[l0, r0, l1], [l1, r0, r1]]) {
      const up = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0
      const [p, q] = up ? [b, c] : [c, b]
      pos.push(a[0], y, a[1], p[0], y, p[1], q[0], y, q[1])
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

export function inPoly([x, z]: V2, poly: V2[]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

export function distToPolyline([x, z]: V2, pts: V2[]) {
  let best = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1]
    const dx = bx - ax, dz = bz - az
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
    best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)))
  }
  return best
}

export const ease = {
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
}
