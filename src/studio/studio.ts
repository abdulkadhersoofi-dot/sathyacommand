import * as THREE from 'three'
import { blockCells, lodgingObjects, rectPoly, validateLayout, type Building, type Cottage, type GroundPatch, type LodgingKind, type Pool, type RoomBlock, type SiteLayout, type V2 } from '../data/layout'
import type { World } from '../scene/World'
import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import { esc, toast } from '../ui/dom'

// Twin Studio: edit the 3D resort on a plan view. Click to select, drag to move, change size, floors,
// roof and colours in the panel, add from templates, undo / redo. In live mode a draft is saved and
// published as a new version; in the demo the changes stay on this screen.

type Kind = 'building' | 'block' | 'villa' | 'ground' | 'pool'
interface Sel { kind: Kind; id: string }

const MARIGOLD = 0xe8a317
const can = (me: Me | null, p: string) => !!me && (me.permissions.includes('*') || me.permissions.includes(p))
const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')
const centroid = (p: V2[]): V2 => [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length]
const rot = (p: V2[], deg: number): V2[] => {
  const [cx, cz] = centroid(p), a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return p.map(([x, z]) => [cx + (x - cx) * c - (z - cz) * s, cz + (x - cx) * s + (z - cz) * c])
}
const rectAt = ([cx, cz]: V2, w: number, d: number, deg = 0): V2[] => rot([[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]], deg)
const round2 = (v: number) => Math.round(v * 100) / 100
/** Width (first edge), depth (second edge) and angle of a 4-corner outline. */
function quadSize(p: V2[]) {
  const e1: V2 = [p[1][0] - p[0][0], p[1][1] - p[0][1]], e2: V2 = [p[2][0] - p[1][0], p[2][1] - p[1][1]]
  return { w: Math.hypot(...e1), d: Math.hypot(...e2), deg: (Math.atan2(e1[1], e1[0]) * 180) / Math.PI }
}

export class Studio {
  open = false
  private layout!: SiteLayout
  private original!: SiteLayout
  private baseVersion: number | null = null
  private undo: string[] = []
  private redo: string[] = []
  private sel: Sel | null = null
  private panel: HTMLElement
  private helpers = new THREE.Group()
  private drag: { start: V2; moved: boolean; original: string } | null = null
  private rooms: { id: string; room_no: string; twin_id: string | null }[] = []

  constructor(private world: World, private api: Api | null, private me: Me | null, private onExit: (published: boolean) => void) {
    this.panel = document.createElement('aside')
    this.panel.className = 'drawer studio'
    this.panel.setAttribute('aria-label', 'Twin Studio')
    document.getElementById('app')!.appendChild(this.panel)
    this.panel.addEventListener('click', (e) => this.onPanelClick(e))
    this.panel.addEventListener('change', (e) => this.onPanelChange(e))
    world.scene.add(this.helpers)
    const el = world.renderer.domElement
    el.addEventListener('pointerdown', (e) => this.onDown(e), true)
    el.addEventListener('pointermove', (e) => this.onMove(e), true)
    el.addEventListener('pointerup', (e) => this.onUp(e), true)
  }

  static allowed(me: Me | null, live: boolean) { return !live || can(me, 'site.edit') || can(me, 'site.publish') }

  async enter() {
    this.original = structuredClone(this.world.layout)
    this.layout = structuredClone(this.world.layout)
    this.undo = []; this.redo = []; this.sel = null
    if (this.api) {
      try { this.baseVersion = (await this.api.get<{ version: number }>('/api/site')).version } catch { this.baseVersion = null }
      try { this.rooms = await this.api.get('/api/rooms?includeArchived=false') } catch { this.rooms = [] }
    }
    this.open = true
    this.world.setEditMode(true)
    this.world.planView(true)
    this.panel.classList.add('open')
    this.render()
  }

  exit(published = false) {
    this.open = false
    this.world.setEditMode(false)
    this.world.controls.enabled = true
    this.world.planView(false)
    this.panel.classList.remove('open')
    this.helpers.clear()
    // Live: unpublished edits are dropped (a saved draft stays in Versions). Demo: they stay on screen.
    if (!published && this.api) this.world.rebuild(this.original)
    this.onExit(published)
  }

  // ---------- editing primitives ----------
  private commit(mutate: (l: SiteLayout) => void, keepSel = true) {
    this.undo.push(JSON.stringify(this.layout))
    this.redo = []
    mutate(this.layout)
    if (!keepSel) this.sel = null
    this.world.rebuild(this.layout)
    this.render()
  }

  private find(sel: Sel | null = this.sel): Building | RoomBlock | Cottage | GroundPatch | Pool | undefined {
    if (!sel) return undefined
    const l = this.layout
    return ({ building: l.buildings, block: l.blocks, villa: l.villas, ground: l.ground, pool: l.pools }[sel.kind] as { id: string }[]).find((o) => o.id === sel.id) as never
  }

  private kindOf(id: string): Kind | null {
    const l = this.layout
    if (l.buildings.some((o) => o.id === id)) return 'building'
    if (l.blocks.some((o) => o.id === id)) return 'block'
    if (l.villas.some((o) => o.id === id)) return 'villa'
    if (l.pools.some((o) => o.id === id)) return 'pool'
    if (l.ground.some((o) => o.id === id)) return 'ground'
    return null
  }

  private outline(sel: Sel | null = this.sel): V2[] | null {
    const o = this.find(sel)
    if (!o) return null
    return 'rect' in o ? rectPoly(o.rect) : (o as { poly: V2[] }).poly
  }

  private translate(sel: Sel, dx: number, dz: number) {
    const o = this.find(sel)!
    if ('rect' in o) { const [a, b, c, d] = o.rect; o.rect = [round2(a + dx), round2(b + dz), round2(c + dx), round2(d + dz)] }
    else (o as { poly: V2[] }).poly = (o as { poly: V2[] }).poly.map(([x, z]) => [round2(x + dx), round2(z + dz)])
  }

  private drawHelpers(offset: V2 = [0, 0]) {
    this.helpers.clear()
    const p = this.outline()
    if (!p) { this.world.invalidate(); return }
    const pts = p.map(([x, z]) => new THREE.Vector3(x + offset[0], 0.6, z + offset[1]))
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: MARIGOLD }))
    const fill = new THREE.Mesh(
      new THREE.ShapeGeometry(new THREE.Shape(pts.map((v) => new THREE.Vector2(v.x, -v.z)))).rotateX(-Math.PI / 2).translate(0, 0.55, 0),
      new THREE.MeshBasicMaterial({ color: MARIGOLD, transparent: true, opacity: 0.18, depthWrite: false }),
    )
    // Drawn over roofs so the selection shows on tall buildings too.
    for (const m of [fill, line]) { m.material.depthTest = false; m.renderOrder = 20 }
    this.helpers.add(fill, line)
    this.world.invalidate()
  }

  // ---------- pointer ----------
  private onDown(e: PointerEvent) {
    if (!this.open || e.button !== 0) return
    const id = this.world.layoutHit(e.clientX, e.clientY)
    const kind = id ? this.kindOf(id) : null
    if (!id || !kind) return
    if (this.sel?.id !== id) { this.sel = { kind, id }; this.render(); return }
    const g = this.world.groundAt(e.clientX, e.clientY)
    if (!g) return
    this.drag = { start: g, moved: false, original: JSON.stringify(this.layout) }
    this.world.controls.enabled = false
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    e.stopPropagation()
  }

  private onMove(e: PointerEvent) {
    if (!this.drag) return
    const g = this.world.groundAt(e.clientX, e.clientY)
    if (!g) return
    const dx = g[0] - this.drag.start[0], dz = g[1] - this.drag.start[1]
    if (Math.hypot(dx, dz) > 0.5) this.drag.moved = true
    this.drawHelpers([dx, dz])
    e.stopPropagation()
  }

  private onUp(e: PointerEvent) {
    if (!this.drag) return
    const g = this.world.groundAt(e.clientX, e.clientY)
    const d = this.drag
    this.drag = null
    this.world.controls.enabled = true
    if (!g || !d.moved || !this.sel) { this.drawHelpers(); return }
    const sel = this.sel
    this.commit(() => this.translate(sel, g[0] - d.start[0], g[1] - d.start[1]))
    e.stopPropagation()
  }

  private boxes(): { id: string; name: string; box: [number, number, number, number] }[] {
    const l = this.layout
    const bb = (p: V2[]): [number, number, number, number] => [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))]
    return [
      ...l.buildings.map((o) => ({ id: o.id, name: o.label, box: bb(o.poly) })),
      ...l.villas.map((o) => ({ id: o.id, name: o.label ?? o.id, box: bb(o.poly) })),
      ...l.pools.map((o) => ({ id: o.id, name: 'Pool', box: bb(o.poly) })),
      ...l.blocks.map((o) => ({ id: o.id, name: o.label, box: o.rect })),
    ]
  }

  /** Names of drawn buildings whose footprint overlaps this one (outline boxes, so a warning, not a rule). */
  private overlapping(id: string) {
    const all = this.boxes(), me = all.find((b) => b.id === id)
    if (!me) return []
    const [a0, b0, a1, b1] = me.box
    return all.filter((o) => o.id !== id && !o.id.startsWith(`${id}-`) && o.box[0] < a1 - 0.5 && o.box[2] > a0 + 0.5 && o.box[1] < b1 - 0.5 && o.box[3] > b0 + 0.5).map((o) => o.name)
  }

  // ---------- templates ----------
  /** The nearest point to `c` where a w × d footprint does not overlap anything already drawn. */
  private freeSpot(c: V2, w: number, d: number): V2 {
    const boxes = this.boxes().map((b) => b.box)
    const free = ([x, z]: V2) => boxes.every(([x0, z0, x1, z1]) => x + w / 2 + 2 < x0 || x - w / 2 - 2 > x1 || z + d / 2 + 2 < z0 || z - d / 2 - 2 > z1)
    for (let r = 0; r <= 200; r += 4) {
      const steps = r ? Math.ceil((2 * Math.PI * r) / 4) : 1
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * 2 * Math.PI, p: V2 = [round2(c[0] + r * Math.cos(a)), round2(c[1] + r * Math.sin(a))]
        if (free(p)) return p
      }
    }
    return c
  }

  private add(t: string) {
    const target: V2 = [round2(this.world.controls.target.x), round2(this.world.controls.target.z)]
    const used = new Set(lodgingObjects(this.layout).map((o) => o.id).concat(this.layout.buildings.map((b) => b.id), this.layout.ground.map((g) => g.id)))
    const next = (prefix: string) => { let i = 1; while (used.has(`${prefix}-${i}`)) i++; return `${prefix}-${i}` }
    const lodging: Record<string, [LodgingKind, number, number]> = { villa: ['villa', 10, 9], cottage: ['cottage', 8, 7], tent: ['tent', 6, 5] }
    const buildings: Record<string, Omit<Building, 'id' | 'poly'> & { w: number; d: number }> = {
      hall: { label: 'New hall', height: 9, roof: 'hip', roofColor: 0xb4483a, wallColor: 0xf1ebe1, w: 30, d: 20 },
      restaurant: { label: 'New restaurant', height: 5, roof: 'hip', roofColor: 0xc8643b, wallColor: 0xf1ebe1, w: 18, d: 12 },
      pavilion: { label: 'New pavilion', height: 5, roof: 'canopy', roofColor: 0xf3f1ec, wallColor: 0xd8d4cc, w: 20, d: 12 },
      building: { label: 'New building', height: 6, roof: 'flat', roofColor: 0xd9d2c6, wallColor: 0xebe5da, w: 15, d: 10 },
    }
    this.commit((l) => {
      if (lodging[t]) {
        const [kind, w, d] = lodging[t]
        const c = this.freeSpot(target, w, d)
        const id = next(kind === 'villa' ? 'VILLA' : kind.toUpperCase())
        l.villas.push({ id, kind, label: `New ${kind} ${id.split('-')[1]}`, poly: rectAt(c, w, d) })
        this.sel = { kind: 'villa', id }
      } else if (buildings[t]) {
        const { w, d, ...b } = buildings[t]
        const c = this.freeSpot(target, w, d)
        const id = next('B')
        l.buildings.push({ id, ...b, poly: rectAt(c, w, d) })
        this.sel = { kind: 'building', id }
      } else if (t === 'block') {
        const codes = new Set(l.blocks.map((b) => b.idPrefix)), prefixes = new Set(l.blocks.map((b) => b.numberPrefix))
        let n = 2; while (codes.has(`BLK${n}`)) n++
        const letter = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('').find((x) => !prefixes.has(x)) ?? ''
        const id = `block-${n}`
        const c = this.freeSpot(target, 30, 30)
        l.blocks.push({ id, label: `Block ${letter || n}`, idPrefix: `BLK${n}`, numberPrefix: letter, rect: [c[0] - 15, c[1] - 15, c[0] + 15, c[1] + 15], floors: 2, floorHeight: 3.4, depth: 9, ring: [3, 1, 3, 1] })
        this.sel = { kind: 'block', id }
      } else if (t === 'lawn') {
        const id = next('LAWN')
        const c = this.freeSpot(target, 30, 20)
        l.ground.push({ id, kind: 'lawn', poly: rectAt(c, 30, 20) })
        this.sel = { kind: 'ground', id }
      } else if (t === 'pool') {
        const id = next('POOL')
        const c = this.freeSpot(target, 20, 12)
        l.ground.push({ id: `${id}-DECK`, kind: 'deck', poly: rectAt(c, 20, 12) })
        l.pools.push({ id, poly: rectAt(c, 14, 7) })
        this.sel = { kind: 'pool', id }
      }
    })
    const p = this.outline()
    if (p) this.world.panTo(...centroid(p))
    toast('Added. Click it again and drag it into place.')
  }

  // ---------- panel ----------
  private rendering = false
  private render() {
    // Replacing the panel blurs a focused input, which can fire 'change' and come back here.
    if (this.rendering) return
    this.rendering = true
    try { this.renderPanel() } finally { this.rendering = false }
  }

  private renderPanel() {
    this.drawHelpers()
    const live = !!this.api
    const o = this.find()
    const problems = validateLayout(this.layout)
    const field = (label: string, name: string, value: string | number, type = 'text', extra = '') =>
      `<label>${label}<input name="${name}" type="${type}" value="${esc(String(value))}" ${extra}></label>`
    let inspector = '<p class="muted">Click a building, block, villa, lawn or pool to select it. Click it again and drag to move it.</p>'
    if (o && this.sel) {
      const k = this.sel.kind
      let fields = ''
      if (k === 'building') {
        const b = o as Building
        const q = b.poly.length === 4 ? quadSize(b.poly) : null
        fields = field('Name', 'label', b.label, 'text', 'maxlength="60"')
          + field('Height (m)', 'height', b.height, 'number', 'min="2" max="40" step="0.5"')
          + `<label>Roof<select name="roof">${['hip', 'flat', 'canopy'].map((r) => `<option ${r === b.roof ? 'selected' : ''} value="${r}">${{ hip: 'Pitched (hip)', flat: 'Flat', canopy: 'Open canopy' }[r]}</option>`).join('')}</select></label>`
          + field('Roof colour', 'roofColor', hex(b.roofColor), 'color') + field('Wall colour', 'wallColor', hex(b.wallColor), 'color')
          + (q ? field('Width (m)', 'w', round2(q.w), 'number', 'min="3" step="0.5"') + field('Depth (m)', 'd', round2(q.d), 'number', 'min="3" step="0.5"') : '')
      } else if (k === 'block') {
        const b = o as RoomBlock
        const cells = blockCells(b)
        fields = field('Name', 'label', b.label, 'text', 'maxlength="60"')
          + field('Floors', 'floors', b.floors, 'number', 'min="1" max="12"') + field('Floor height (m)', 'floorHeight', b.floorHeight, 'number', 'min="2.5" max="6" step="0.1"')
          + field('Rooms north', 'r0', b.ring[0], 'number', 'min="0" max="20"') + field('Rooms east', 'r1', b.ring[1], 'number', 'min="0" max="20"')
          + field('Rooms south', 'r2', b.ring[2], 'number', 'min="0" max="20"') + field('Rooms west', 'r3', b.ring[3], 'number', 'min="0" max="20"')
          + field('Width (m)', 'bw', round2(b.rect[2] - b.rect[0]), 'number', 'min="8" step="1"') + field('Depth (m)', 'bd', round2(b.rect[3] - b.rect[1]), 'number', 'min="8" step="1"')
          + field('Room depth (m)', 'depth', b.depth, 'number', 'min="4" max="30" step="0.5"')
          + field('Code', 'idPrefix', b.idPrefix, 'text', 'maxlength="8"') + field('Room no. prefix', 'numberPrefix', b.numberPrefix, 'text', 'maxlength="3"')
          + `<p class="muted span2">${cells.length} rooms: ${esc(cells[0]?.roomNo ?? '')} … ${esc(cells[cells.length - 1]?.roomNo ?? '')}</p>`
      } else if (k === 'villa') {
        const v = o as Cottage
        const q = quadSize(v.poly)
        const linked = this.rooms.find((r) => r.twin_id === v.id)
        fields = field('Name', 'label', v.label ?? '', 'text', 'maxlength="60"')
          + `<label>Type<select name="vkind">${['villa', 'cottage', 'suite', 'tent'].map((x) => `<option ${x === v.kind ? 'selected' : ''}>${x}</option>`).join('')}</select></label>`
          + field('Width (m)', 'w', round2(q.w), 'number', 'min="3" step="0.5"') + field('Depth (m)', 'd', round2(q.d), 'number', 'min="3" step="0.5"')
          + (live && can(this.me, 'inventory.edit') ? `<label class="span2">Bookable HMS room<select name="link"><option value="">Not linked</option>${this.rooms.map((r) => `<option value="${esc(r.id)}" ${r.twin_id === v.id ? 'selected' : ''}>${esc(r.room_no)}${r.twin_id && r.twin_id !== v.id ? ' (drawn elsewhere)' : ''}</option>`).join('')}</select></label>
            <p class="muted span2">${linked ? `Linked to room ${esc(linked.room_no)}.` : 'Link it so bookings show on this building.'} Linking takes effect once this layout is published.</p>` : '')
      } else if (k === 'ground') {
        const g = o as GroundPatch
        fields = `<label>Surface<select name="gkind">${['lawn', 'field', 'plot', 'paved', 'deck'].map((x) => `<option ${x === g.kind ? 'selected' : ''}>${x}</option>`).join('')}</select></label>`
      }
      const clash = k === 'ground' ? [] : this.overlapping(this.sel.id)
      if (clash.length) fields += `<p class="verify span2">Overlaps ${clash.map(esc).join(', ')}. Drag it clear before publishing.</p>`
      const canRotate = k !== 'block'
      inspector = `<div class="sec-title">Selected · ${esc(k === 'villa' ? (o as Cottage).kind : k)} <span class="mono">${esc(this.sel.id)}</span></div>
        <div class="form-grid studio-fields">${fields}</div>
        <div class="actions">${canRotate ? '<button class="btn small" data-st="rot-" type="button">↺ 15°</button><button class="btn small" data-st="rot+" type="button">↻ 15°</button>' : ''}
          ${k !== 'ground' && k !== 'pool' ? '' : '<button class="btn small" data-st="grow" type="button">Bigger</button><button class="btn small" data-st="shrink" type="button">Smaller</button>'}
          <button class="btn small" data-st="delete" type="button">Remove</button></div>`
    }
    this.panel.innerHTML = `<div class="drawer-inner">
      <div class="dr-head"><div><div class="dr-kicker">Twin Studio</div><div class="dr-title">Edit resort</div>
        <div class="tip-meta">${live ? `Editing a copy of version ${this.baseVersion ?? '—'}. Guests and staff see no change until you publish.` : 'Demo: changes stay on this screen and are not saved.'}</div></div>
        <button class="dr-close" type="button" data-st="exit" aria-label="Close">✕</button></div>
      <div class="sec-title">Add</div>
      <div class="studio-add">${[['villa', 'Villa'], ['cottage', 'Cottage'], ['tent', 'Tent'], ['block', 'Room block'], ['hall', 'Hall'], ['restaurant', 'Restaurant'], ['pavilion', 'Pavilion'], ['building', 'Building'], ['lawn', 'Lawn'], ['pool', 'Pool']]
        .map(([t, n]) => `<button class="btn small" type="button" data-add="${t}">${n}</button>`).join('')}</div>
      <div class="actions"><button class="btn small" data-st="undo" type="button" ${this.undo.length ? '' : 'disabled'}>Undo</button><button class="btn small" data-st="redo" type="button" ${this.redo.length ? '' : 'disabled'}>Redo</button></div>
      ${inspector}
      ${problems.length ? `<div class="verify">${problems.slice(0, 4).map(esc).join('<br>')}</div>` : ''}
      ${live ? `<div class="sec-title">Save</div>
        <label class="studio-note">Note for this version<input id="st-note" placeholder="e.g. Added Lake Wing" maxlength="120"></label>
        <div class="actions"><button class="btn" data-st="save" type="button" ${problems.length || !this.undo.length ? 'disabled' : ''}>Save draft</button>
        ${can(this.me, 'site.publish') ? `<button class="btn primary" data-st="publish" type="button" ${problems.length || !this.undo.length ? 'disabled' : ''}>Publish</button>` : ''}</div>
        <div id="st-versions"></div>` : ''}
    </div>`
    if (live) void this.renderVersions()
  }

  private async renderVersions() {
    const box = this.panel.querySelector('#st-versions')
    if (!box || !this.api) return
    try {
      const vs = await this.api.get<{ id: number; status: string; note: string | null; created_by: string; published_at: string | null; created_at: string }[]>('/api/site/versions')
      box.innerHTML = `<div class="sec-title">Versions</div>` + vs.slice(0, 8).map((v) => `<div class="row-card"><div class="rc-title">Version ${v.id}${v.note ? ` · ${esc(v.note)}` : ''}</div>
        <div class="rc-sub">${esc(v.created_by)} · ${new Date(v.published_at ?? v.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
        <div class="rc-right"><span class="pill" style="--c: var(${v.status === 'published' ? '--st-vacant' : '--muted'})">${v.status === 'published' ? 'Live' : v.status}</span>
        ${v.status === 'superseded' && can(this.me, 'site.publish') ? `<button class="btn small" data-restore="${v.id}" type="button">Restore</button>` : ''}</div></div>`).join('')
    } catch { box.innerHTML = '' }
  }

  private onPanelChange(e: Event) {
    const t = e.target as HTMLInputElement
    if (!t.name || t.id === 'st-note' || !this.sel) return
    const v = t.value
    const n = Number(v)
    const sel = this.sel
    if (t.name === 'link') { void this.link(v); return }
    this.commit(() => {
      const o = this.find(sel) as never as Record<string, unknown>
      if (sel.kind === 'building') {
        const b = o as unknown as Building
        if (t.name === 'label') b.label = v
        if (t.name === 'height') b.height = n
        if (t.name === 'roof') b.roof = v as Building['roof']
        if (t.name === 'roofColor') b.roofColor = parseInt(v.slice(1), 16)
        if (t.name === 'wallColor') b.wallColor = parseInt(v.slice(1), 16)
        if ((t.name === 'w' || t.name === 'd') && b.poly.length === 4) {
          const q = quadSize(b.poly)
          b.poly = rectAt(centroid(b.poly), t.name === 'w' ? n : q.w, t.name === 'd' ? n : q.d, q.deg).map(([x, z]) => [round2(x), round2(z)])
        }
      } else if (sel.kind === 'block') {
        const b = o as unknown as RoomBlock
        if (t.name === 'label') b.label = v
        if (t.name === 'floors') b.floors = Math.round(n)
        if (t.name === 'floorHeight') b.floorHeight = n
        if (t.name === 'depth') b.depth = n
        if (/^r[0-3]$/.test(t.name)) b.ring[Number(t.name[1])] = Math.round(n)
        if (t.name === 'idPrefix') b.idPrefix = v.toUpperCase()
        if (t.name === 'numberPrefix') b.numberPrefix = v.toUpperCase()
        if (t.name === 'bw' || t.name === 'bd') {
          const [x0, z0, x1, z1] = b.rect, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
          const w = t.name === 'bw' ? n : x1 - x0, d = t.name === 'bd' ? n : z1 - z0
          b.rect = [round2(cx - w / 2), round2(cz - d / 2), round2(cx + w / 2), round2(cz + d / 2)]
        }
      } else if (sel.kind === 'villa') {
        const c = o as unknown as Cottage
        if (t.name === 'label') c.label = v
        if (t.name === 'vkind') c.kind = v as LodgingKind
        if (t.name === 'w' || t.name === 'd') {
          const q = quadSize(c.poly)
          c.poly = rectAt(centroid(c.poly), t.name === 'w' ? n : q.w, t.name === 'd' ? n : q.d, q.deg).map(([x, z]) => [round2(x), round2(z)])
        }
      } else if (sel.kind === 'ground' && t.name === 'gkind') {
        (o as unknown as GroundPatch).kind = v as GroundPatch['kind']
      }
    })
  }

  private async link(roomId: string) {
    if (!this.api || !this.sel) return
    try {
      const current = this.rooms.find((r) => r.twin_id === this.sel!.id)
      if (current && current.id !== roomId) await this.api.req('PATCH', `/api/rooms/${current.id}`, { twinId: null })
      if (roomId) await this.api.req('PATCH', `/api/rooms/${roomId}`, { twinId: this.sel.id })
      this.rooms = await this.api.get('/api/rooms')
      toast(roomId ? 'Room linked' : 'Room unlinked')
      this.render()
    } catch (e) { toast((e as Error).message) }
  }

  private onPanelClick(e: MouseEvent) {
    const t = e.target as HTMLElement
    const add = t.closest<HTMLElement>('[data-add]')
    if (add) { this.add(add.dataset.add!); return }
    const restore = t.closest<HTMLElement>('[data-restore]')
    if (restore) { void this.restore(Number(restore.dataset.restore)); return }
    const a = t.closest<HTMLElement>('[data-st]')?.dataset.st
    if (!a) return
    const sel = this.sel
    if (a === 'exit') this.exit()
    if (a === 'undo' && this.undo.length) { this.redo.push(JSON.stringify(this.layout)); this.layout = JSON.parse(this.undo.pop()!); this.world.rebuild(this.layout); if (!this.find()) this.sel = null; this.render() }
    if (a === 'redo' && this.redo.length) { this.undo.push(JSON.stringify(this.layout)); this.layout = JSON.parse(this.redo.pop()!); this.world.rebuild(this.layout); this.render() }
    if (!sel) { if (a === 'save') void this.save(false); if (a === 'publish') void this.save(true); return }
    if (a === 'rot-' || a === 'rot+') this.commit(() => { const o = this.find(sel) as { poly: V2[] }; o.poly = rot(o.poly, a === 'rot+' ? 15 : -15).map(([x, z]) => [round2(x), round2(z)]) })
    if (a === 'grow' || a === 'shrink') this.commit(() => {
      const o = this.find(sel) as { poly: V2[] }
      const [cx, cz] = centroid(o.poly), k = a === 'grow' ? 1.15 : 1 / 1.15
      o.poly = o.poly.map(([x, z]) => [round2(cx + (x - cx) * k), round2(cz + (z - cz) * k)])
    })
    if (a === 'delete') {
      if (this.api && sel.kind === 'villa' && this.rooms.some((r) => r.twin_id === sel.id)) toast('This villa is linked to a bookable room. Publishing will unlink it, or refuse if a guest is booked.')
      this.commit((l) => {
        const drop = <T extends { id: string }>(xs: T[]) => xs.filter((x) => x.id !== sel.id)
        l.buildings = drop(l.buildings); l.blocks = drop(l.blocks); l.villas = drop(l.villas); l.ground = drop(l.ground); l.pools = drop(l.pools)
        if (sel.kind === 'pool') l.ground = l.ground.filter((g) => g.id !== `${sel.id}-DECK`)
      }, false)
    }
    if (a === 'save') void this.save(false)
    if (a === 'publish') void this.save(true)
  }

  private async save(publish: boolean) {
    if (!this.api) return
    const note = (this.panel.querySelector<HTMLInputElement>('#st-note')?.value ?? '').trim()
    try {
      const d = await this.api.post<{ id: number; added: string[]; removed: string[]; changed: string[] }>('/api/site/drafts', { layout: this.layout, note: note || undefined, basedOn: this.baseVersion })
      if (!publish) { toast(`Draft saved as version ${d.id} (${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed)`); this.render(); return }
      const p = await this.api.post<{ version: number; unlinkedRooms: string[]; unlinkedObjects: { id: string; roomNo: string | null }[] }>(`/api/site/versions/${d.id}/publish`)
      toast(`Version ${p.version} is live.${p.unlinkedObjects.length ? ` ${p.unlinkedObjects.length} drawn rooms have no bookable HMS room yet.` : ''}`)
      this.exit(true)
    } catch (e) {
      const problems = (e as { body?: { problems?: string[] } }).body?.problems
      toast(problems?.length ? problems[0] : (e as Error).message)
    }
  }

  private async restore(id: number) {
    if (!this.api) return
    try {
      const p = await this.api.post<{ version: number }>(`/api/site/versions/${id}/restore`)
      toast(`Version ${id} restored as version ${p.version}.`)
      this.exit(true)
    } catch (e) { toast((e as Error).message) }
  }
}
