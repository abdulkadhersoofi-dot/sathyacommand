import DEFAULT from './default-layout.json'

// The resort's 3D layout as plain data (metres, x east, z south), shared by the 3D app, Twin Studio
// and the server that stores layout versions.

export type V2 = [number, number]
export type GroundKind = 'lawn' | 'field' | 'plot' | 'paved' | 'deck'
export type Roof = 'flat' | 'hip' | 'canopy'
export type LodgingKind = 'villa' | 'cottage' | 'suite' | 'tent'

export interface GroundPatch { id: string; kind: GroundKind; poly: V2[]; spaceId?: string }
export interface Pool { id: string; poly: V2[]; spaceId?: string }
export interface Road { id: string; kind: 'drive' | 'highway'; width: number; pts: V2[] }
export interface Building { id: string; spaceId?: string; label: string; poly: V2[]; height: number; roof: Roof; roofColor: number; wallColor: number }
/** A multi-storey room block: rooms ring a courtyard; `ring` = rooms on the north, east, south and west sides. */
export interface RoomBlock {
  id: string; label: string; idPrefix: string; numberPrefix: string
  rect: [number, number, number, number]; floors: number; floorHeight: number; depth: number; ring: [number, number, number, number]
}
export interface Cottage { id: string; label?: string; kind: LodgingKind; poly: V2[] }

export interface SiteLayout {
  schema: 1
  bounds: { min: V2; max: V2 }
  ground: GroundPatch[]
  pools: Pool[]
  roads: Road[]
  gate: V2
  buildings: Building[]
  blocks: RoomBlock[]
  villas: Cottage[]
}

export const DEFAULT_LAYOUT = DEFAULT as SiteLayout
export const defaultLayout = (): SiteLayout => structuredClone(DEFAULT_LAYOUT)

export const rectPoly = ([x0, z0, x1, z1]: [number, number, number, number]): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]

export interface BlockCell { id: string; roomNo: string; floor: number; x: number; z: number; sx: number; sz: number }

/** Room cells of a block, numbered clockwise from the north-west corner on each floor (101, 102, …). */
export function blockCells(b: RoomBlock): BlockCell[] {
  const [x0, z0, x1, z1] = b.rect
  const d = Math.min(b.depth, (x1 - x0) / 2.2, (z1 - z0) / 2.2)
  const W = x1 - x0, innerZ = z1 - z0 - 2 * d
  const [n, e, s, w] = b.ring
  const sides: { n: number; cell: (i: number) => Omit<BlockCell, 'id' | 'floor' | 'roomNo'> }[] = [
    { n, cell: (i) => ({ x: x0 + W * (i + 0.5) / n, z: z0 + d / 2, sx: W / n, sz: d }) },
    { n: e, cell: (i) => ({ x: x1 - d / 2, z: z0 + d + innerZ * (i + 0.5) / e, sx: d, sz: innerZ / e }) },
    { n: s, cell: (i) => ({ x: x1 - W * (i + 0.5) / s, z: z1 - d / 2, sx: W / s, sz: d }) },
    { n: w, cell: (i) => ({ x: x0 + d / 2, z: z1 - d - innerZ * (i + 0.5) / w, sx: d, sz: innerZ / w }) },
  ]
  const out: BlockCell[] = []
  for (let f = 1; f <= b.floors; f++) {
    let r = 1
    for (const side of sides) {
      for (let i = 0; i < side.n; i++, r++) {
        const roomNo = `${b.numberPrefix}${f}${String(r).padStart(2, '0')}`
        out.push({ id: `${b.idPrefix}-${f}-${roomNo}`, roomNo, floor: f, ...side.cell(i) })
      }
    }
  }
  return out
}

export interface LodgingObject { id: string; label: string; roomNo: string | null; kind: 'room' | LodgingKind; floor: number; building: string }

/** Every lodging object in the drawing that a bookable HMS room can link to. */
export function lodgingObjects(layout: SiteLayout): LodgingObject[] {
  return [
    ...layout.blocks.flatMap((b) => blockCells(b).map((c) => ({ id: c.id, label: `${b.label} · Room ${c.roomNo}`, roomNo: c.roomNo, kind: 'room' as const, floor: c.floor, building: b.label }))),
    ...layout.villas.map((v) => ({ id: v.id, label: v.label ?? v.id, roomNo: null, kind: v.kind, floor: 0, building: 'Villas' })),
  ]
}

const ID = /^[A-Za-z0-9_-]{1,40}$/
const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

/** Plain-language problems that stop a layout being saved. Empty means it is valid. */
export function validateLayout(l: SiteLayout): string[] {
  const out: string[] = []
  if (!l || l.schema !== 1) return ['This is not a Sathya site layout.']
  for (const k of ['ground', 'pools', 'roads', 'buildings', 'blocks', 'villas'] as const) if (!Array.isArray(l[k])) out.push(`Missing ${k}.`)
  if (out.length) return out
  const poly = (name: string, p: unknown) => {
    if (!Array.isArray(p) || p.length < 3 || p.length > 64 || !p.every((pt) => Array.isArray(pt) && pt.length === 2 && num(pt[0], -3000, 3000) && num(pt[1], -3000, 3000))) {
      out.push(`${name} has an invalid outline.`)
    }
  }
  const ids = new Map<string, number>()
  const all = [...l.ground, ...l.pools, ...l.roads, ...l.buildings, ...l.blocks, ...l.villas]
  for (const o of all) {
    if (!ID.test(o.id ?? '')) out.push(`"${o.id}" is not a valid id (letters, digits, - and _ only).`)
    ids.set(o.id, (ids.get(o.id) ?? 0) + 1)
  }
  for (const [id, n] of ids) if (n > 1) out.push(`Two objects share the id "${id}".`)
  for (const g of l.ground) { poly(`Ground ${g.id}`, g.poly); if (!['lawn', 'field', 'plot', 'paved', 'deck'].includes(g.kind)) out.push(`Ground ${g.id} has an unknown kind.`) }
  for (const p of l.pools) poly(`Pool ${p.id}`, p.poly)
  for (const r of l.roads) {
    if (!num(r.width, 1, 40)) out.push(`Road ${r.id}: width must be 1–40 m.`)
    if (!Array.isArray(r.pts) || r.pts.length < 2 || r.pts.length > 200) out.push(`Road ${r.id} needs 2–200 points.`)
  }
  for (const b of l.buildings) {
    poly(`Building "${b.label}"`, b.poly)
    if (b.roof === 'hip' && b.poly?.length !== 4) out.push(`Building "${b.label}": a hip roof needs a 4-corner outline.`)
    if (!num(b.height, 2, 40)) out.push(`Building "${b.label}": height must be 2–40 m.`)
    if (!['flat', 'hip', 'canopy'].includes(b.roof)) out.push(`Building "${b.label}" has an unknown roof type.`)
    if (!num(b.roofColor, 0, 0xffffff) || !num(b.wallColor, 0, 0xffffff)) out.push(`Building "${b.label}" has an invalid colour.`)
    if (typeof b.label !== 'string' || !b.label.trim() || b.label.length > 60) out.push(`Building ${b.id} needs a name up to 60 characters.`)
  }
  for (const b of l.blocks) {
    const [x0, z0, x1, z1] = b.rect ?? []
    if (!(num(x0, -3000, 3000) && num(x1, -3000, 3000) && num(z0, -3000, 3000) && num(z1, -3000, 3000) && x1 - x0 >= 8 && z1 - z0 >= 8)) out.push(`Block "${b.label}" must be at least 8 × 8 m.`)
    if (!Number.isInteger(b.floors) || b.floors < 1 || b.floors > 12) out.push(`Block "${b.label}": 1–12 floors.`)
    if (!num(b.floorHeight, 2.5, 6)) out.push(`Block "${b.label}": floor height must be 2.5–6 m.`)
    if (!num(b.depth, 4, 30)) out.push(`Block "${b.label}": room depth must be 4–30 m.`)
    if (!Array.isArray(b.ring) || b.ring.length !== 4 || !b.ring.every((n) => Number.isInteger(n) && n >= 0 && n <= 20) || b.ring.reduce((a, n) => a + n, 0) < 1) {
      out.push(`Block "${b.label}": rooms per side must be 0–20, at least one room in total.`)
    }
    if (!/^[A-Z0-9]{1,8}$/.test(b.idPrefix ?? '')) out.push(`Block "${b.label}": code must be 1–8 capital letters or digits.`)
    if (!/^[A-Z0-9]{0,3}$/.test(b.numberPrefix ?? '')) out.push(`Block "${b.label}": room-number prefix can be up to 3 capital letters or digits.`)
  }
  for (const v of l.villas) {
    poly(`Villa ${v.id}`, v.poly)
    if (v.poly?.length !== 4) out.push(`Villa ${v.id} needs a 4-corner outline.`)
    if (!['villa', 'cottage', 'suite', 'tent'].includes(v.kind)) out.push(`Villa ${v.id} has an unknown kind.`)
  }
  if (!out.length) {
    const seen = new Set<string>()
    for (const o of lodgingObjects(l)) {
      if (seen.has(o.id)) out.push(`Two rooms in the drawing are both called ${o.id}. Give one block a different code.`)
      seen.add(o.id)
    }
  }
  return out
}

/** What changed between two layouts, by object id. */
export function layoutDiff(before: SiteLayout | null, after: SiteLayout) {
  const index = (l: SiteLayout | null) => new Map(
    l ? [...l.ground, ...l.pools, ...l.roads, ...l.buildings, ...l.blocks, ...l.villas].map((o) => [o.id, JSON.stringify(o)]) : [],
  )
  const a = index(before), b = index(after)
  return {
    added: [...b.keys()].filter((k) => !a.has(k)),
    removed: [...a.keys()].filter((k) => !b.has(k)),
    changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)),
  }
}
