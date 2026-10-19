import { esc, toast } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { currentFix } from './tracker'
import type { StaffHost } from './today'

// Shifts and the weekly roster (who works which shift each day, or has the day off);
// and the resort's boundary, map alignment, selfie rule and beacons.

interface Shift { id: string; name: string; starts: string; ends: string; active: boolean }
interface Entry { user_id: string; day: string; shift_id: string | null }
interface Person { id: string; name: string; roles: string[] }

const isoDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10)
const addDays = (day: string, n: number) => isoDay(new Date(new Date(`${day}T00:00:00+05:30`).getTime() + n * 86_400_000))
function monday(day: string) {
  const dow = new Date(`${day}T12:00:00+05:30`).getUTCDay()
  return addDays(day, -((dow + 6) % 7))
}
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export class RostersView {
  private week = monday(isoDay(new Date()))
  private shifts: Shift[] = []
  private people: Person[] = []
  private entries = new Map<string, string | null>()
  private edits = new Map<string, string | null>()
  private filter = ''
  constructor(private h: StaffHost) {}

  private days() { return Array.from({ length: 7 }, (_, i) => addDays(this.week, i)) }

  async load() {
    this.shifts = await this.h.cached('/api/staff/shifts')
    this.people = await this.h.cached('/api/staff/people')
    const rows = await this.h.cached<Entry[]>(`/api/staff/roster?from=${this.week}&to=${addDays(this.week, 6)}`)
    this.entries = new Map(rows.map((r) => [`${r.user_id}|${r.day}`, r.shift_id]))
    this.edits.clear()
  }

  html() {
    const active = this.shifts.filter((s) => s.active)
    const days = this.days()
    const cell = (p: Person, d: string) => {
      const k = `${p.id}|${d}`
      const v = this.edits.has(k) ? this.edits.get(k) : this.entries.get(k)
      const has = this.edits.has(k) || this.entries.has(k)
      return `<select data-cell="${esc(k)}" aria-label="${esc(p.name)} ${d}" class="${this.edits.has(k) ? 'edited' : ''}"><option value="" ${has ? '' : 'selected'}>—</option><option value="off" ${has && v === null ? 'selected' : ''}>Off</option>
        ${active.map((s) => `<option value="${esc(s.id)}" ${v === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`
    }
    const people = this.people.filter((p) => !this.filter || p.roles.includes(this.filter))
    const roles = [...new Set(this.people.flatMap((p) => p.roles))].sort()
    return `<div class="sec-title">Shifts</div>
      <div class="chips">${this.shifts.map((s) => `<button type="button" class="chip ${s.active ? '' : 'off'}" data-rs="shift:${esc(s.id)}">${esc(s.name)} ${esc(s.starts)}–${esc(s.ends)}</button>`).join('')}
        <button type="button" class="chip" data-rs="add-shift">+ Shift</button></div>
      <div class="ws-toolbar"><button type="button" class="btn" data-rs="prev">‹</button><b>Week of ${new Date(`${this.week}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</b><button type="button" class="btn" data-rs="next">›</button>
        <select data-role-filter aria-label="Role"><option value="">Everyone</option>${roles.map((r) => `<option ${r === this.filter ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
        <button type="button" class="btn" data-rs="copy">Copy last week</button>
        <button type="button" class="btn primary" data-rs="save" ${this.edits.size ? '' : 'disabled'}>Save ${this.edits.size || ''} change${this.edits.size === 1 ? '' : 's'}</button></div>
      <div class="roster-wrap"><table class="roster"><thead><tr><th>Name</th>${days.map((d) => `<th>${new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })}</th>`).join('')}</tr></thead>
      <tbody>${people.map((p) => `<tr><th>${esc(p.name)}<small class="muted"> ${esc(p.roles.join(', ').replace(/_/g, ' '))}</small></th>${days.map((d) => `<td>${cell(p, d)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="muted small">“—” is not rostered. Late marks count from the shift's start, with 5 minutes' grace.</p>`
  }

  async change(el: HTMLElement): Promise<boolean> {
    if (el.matches('[data-role-filter]')) { this.filter = (el as HTMLSelectElement).value; return true }
    const k = el.dataset.cell
    if (!k) return false
    const v = (el as HTMLSelectElement).value
    if (v === '') { this.edits.delete(k); return true }
    const shift = v === 'off' ? null : v
    if (this.entries.has(k) && this.entries.get(k) === shift) this.edits.delete(k)
    else this.edits.set(k, shift)
    return true
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-rs]')?.dataset.rs
    if (!a) return false
    const api = this.h.api
    if (a === 'prev' || a === 'next') {
      if (this.edits.size && !confirm('Leave this week without saving the changes?')) return false
      this.week = addDays(this.week, a === 'prev' ? -7 : 7); await this.load(); return true
    }
    if (a === 'save') {
      const entries = [...this.edits].map(([k, shiftId]) => { const [userId, day] = k.split('|'); return { userId, day, shiftId } })
      await api.req('PUT', '/api/staff/roster', { entries })
      toast('Roster saved'); await this.load(); return true
    }
    if (a === 'copy') {
      const prev = await api.get<Entry[]>(`/api/staff/roster?from=${addDays(this.week, -7)}&to=${addDays(this.week, -1)}`)
      for (const r of prev) {
        const k = `${r.user_id}|${addDays(r.day, 7)}`
        if (this.entries.get(k) !== r.shift_id || !this.entries.has(k)) this.edits.set(k, r.shift_id)
      }
      toast(prev.length ? 'Last week copied: check and save.' : 'Nothing rostered last week.'); return true
    }
    const form = (s?: Shift) => `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="40" value="${esc(s?.name ?? '')}" placeholder="e.g. Morning"></label>
      <label>Starts<input name="starts" type="time" value="${esc(s?.starts ?? '')}"></label><label>Ends<input name="ends" type="time" value="${esc(s?.ends ?? '')}"></label>
      ${s ? `<label class="check span2"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> In use</label>` : ''}</div><p class="muted small">A shift may end after midnight (e.g. 22:00–06:00).</p>`
    if (a === 'add-shift') {
      this.h.modal.open('New shift', form(), 'Add', async (f) => {
        if (!HHMM.test(val(f, 'starts')) || !HHMM.test(val(f, 'ends'))) throw new Error('Set the start and end times.')
        await api.post('/api/staff/shifts', { name: val(f, 'name'), starts: val(f, 'starts'), ends: val(f, 'ends') }); await this.load(); this.h.render(); return 'Shift added'
      })
    }
    if (a.startsWith('shift:')) {
      const s = this.shifts.find((x) => x.id === a.slice(6))!
      this.h.modal.open(`Shift: ${s.name}`, form(s), 'Save', async (f) => {
        await api.req('PATCH', `/api/staff/shifts/${s.id}`, { name: val(f, 'name'), starts: val(f, 'starts'), ends: val(f, 'ends'), active: checked(f, 'active') }); await this.load(); this.h.render(); return 'Saved'
      })
    }
    return false
  }
}

interface Geo { lat: number | null; lng: number | null; radiusM: number; mapX: number; mapZ: number; rotation: number; selfieRequired: boolean }
interface Beacon { id: string; name: string; space_id: string | null; space: string | null; floor: number | null }

export class StaffSettingsView {
  private g: Geo | null = null
  private beacons: Beacon[] = []
  constructor(private h: StaffHost) {}

  async load() {
    this.g = await this.h.api.get('/api/staff/settings')
    this.beacons = await this.h.api.get('/api/staff/beacons')
  }

  html() {
    const g = this.g!
    return `<form class="form-grid settings-form" data-form="geo">
        <div class="sec-title span2">Resort boundary</div>
        <p class="muted small span2">Staff can clock in only inside this circle; on duty, more than 15 minutes outside it tells the operations manager.
          Stand at the middle of the resort and press “Use my location”, or type it from Google Maps.</p>
        <label>Centre latitude<input name="lat" type="number" step="0.000001" min="-90" max="90" value="${g.lat ?? ''}"></label>
        <label>Centre longitude<input name="lng" type="number" step="0.000001" min="-180" max="180" value="${g.lng ?? ''}"></label>
        <label>Radius (metres)<input name="radius" type="number" min="50" max="5000" step="10" value="${g.radiusM}"></label>
        <div class="actions"><button type="button" class="btn" data-ss="here">Use my location</button></div>
        <div class="sec-title span2">Lining up with the 3D map</div>
        <p class="muted small span2">Where that centre point sits on the 3D model (metres east and south of the model's origin), and how far the model is turned from true north (degrees).</p>
        <label>Map x (east)<input name="mapX" type="number" step="0.1" value="${g.mapX}"></label>
        <label>Map z (south)<input name="mapZ" type="number" step="0.1" value="${g.mapZ}"></label>
        <label>Rotation (°)<input name="rotation" type="number" step="0.5" min="-180" max="180" value="${g.rotation}"></label>
        <label class="check span2"><input type="checkbox" name="selfie" ${g.selfieRequired ? 'checked' : ''}> Ask for a selfie at clock-in</label>
        <div class="actions span2"><button class="btn primary">Save</button></div>
      </form>
      <div class="sec-title">Indoor beacons <span>${this.beacons.length}</span></div>
      <p class="muted small">Bluetooth beacons place staff inside buildings where GPS is poor (packaged phone app only). Rooms and public areas with a QR label also place the person when scanned.</p>
      ${this.beacons.map((b) => `<div class="m-row ping-row"><span class="mono">${esc(b.id)}</span><b>${esc(b.name)}</b><span>${esc(b.space ?? '')}${b.floor != null ? ` · floor ${b.floor}` : ''}</span></div>`).join('')}
      <div class="ws-toolbar"><button type="button" class="btn" data-ss="beacon">Add beacon</button></div>`
  }

  async submit(f: HTMLFormElement): Promise<boolean> {
    const n = (k: string) => (val(f, k) === '' ? undefined : Number(val(f, k)))
    const lat = n('lat'), lng = n('lng')
    this.g = await this.h.api.req('PUT', '/api/staff/settings', {
      ...(lat !== undefined && lng !== undefined ? { lat, lng } : {}), radiusM: n('radius'), mapX: n('mapX'), mapZ: n('mapZ'), rotation: n('rotation'), selfieRequired: checked(f, 'selfie'),
    })
    return true
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-ss]')?.dataset.ss
    if (a === 'here') {
      toast('Getting your location…')
      const fix = await currentFix()
      if (!fix) { toast('Location not available: allow location for this site.'); return false }
      const f = el.closest('form')!
      ;(f.elements.namedItem('lat') as HTMLInputElement).value = fix.lat.toFixed(6)
      ;(f.elements.namedItem('lng') as HTMLInputElement).value = fix.lng.toFixed(6)
      toast(`Got it (±${Math.round(fix.accuracy)} m). Press Save.`)
      return false
    }
    if (a === 'beacon') {
      const day = isoDay(new Date())
      const spaces = await this.h.api.get<{ spaces: { id: string; name: string; kind: string }[] }>(`/api/dashboard?from=${day}&to=${day}`).then((s) => s.spaces).catch(() => [])
      this.h.modal.open('Add beacon', `<div class="form-grid"><label class="span2">Beacon id (as the phone reads it)<input name="id" maxlength="64" placeholder="e.g. FDA50693-…:1:7"></label>
        <label class="span2">Name<input name="name" maxlength="60" placeholder="e.g. Kitchen store"></label>
        <label>In<select name="space"><option value="">—</option>${spaces.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
        <label>Floor<input name="floor" type="number" min="-2" max="20"></label></div>`, 'Add', async (f) => {
        await this.h.api.post('/api/staff/beacons', { id: val(f, 'id'), name: val(f, 'name'), spaceId: val(f, 'space') || undefined, floor: val(f, 'floor') ? Number(val(f, 'floor')) : undefined })
        await this.load(); this.h.render(); return 'Beacon added'
      })
    }
    return false
  }
}
