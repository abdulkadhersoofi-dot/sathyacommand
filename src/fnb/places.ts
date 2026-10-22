import { esc } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import type { Outlet, Ws } from './common'

// A food place: anywhere on the map that takes food orders. The restaurant, the bar, the pool deck, a
// cafeteria, a lawn on a day without an event. It serves its own menu or another place's, and may have
// tables. One small form, reached from Orders, from Menu and from the map.

export const KIND_LABEL: Record<string, string> = { restaurant: 'Restaurant', cafe: 'Café or cafeteria', bar: 'Bar', poolside: 'Poolside', lawn: 'Lawn or ground', room_service: 'Room service', banquet: 'Banquet service' }
/** Kinds that seat guests at tables. */
export const SEATED = new Set(['restaurant', 'cafe', 'bar', 'poolside', 'lawn'])
const KIND_FOR_SPACE: Record<string, string> = { restaurant: 'restaurant', bar: 'bar', pool: 'poolside', lawn: 'lawn', ground: 'lawn', pavilion: 'lawn', hall: 'cafe' }

interface Place { id: string; kind: string; name: string | null; room_no: string | null }

/**
 * Opens the form; `preset` fills in the place when it comes from the map. `onSaved` gets the new or
 * changed outlet's id so the caller can refresh and, for a new place, start taking orders there.
 */
export function foodPlaceForm(ws: Ws, onSaved: (id: string, created: boolean) => Promise<void>, o?: Outlet, preset?: { spaceId: string; name: string; kind: string }) {
  const own = ws.outlets.filter((x) => !x.menu_of && x.id !== o?.id)
  const menuDefault = o?.menu_of ?? (o ? '' : own.find((x) => x.kind === 'restaurant')?.id ?? '')
  const kind = o?.kind ?? (preset ? KIND_FOR_SPACE[preset.kind] ?? 'cafe' : 'restaurant')
  const form = ws.modal.open(o ? `${o.name}` : 'Add a food place', `<div class="form-grid">
      <label class="span2">Name<input name="name" maxlength="60" value="${esc(o?.name ?? preset?.name ?? '')}" placeholder="Grand Lawn café" required></label>
      <label class="span2">Where on the map<select name="space" data-places><option value="">Choose the place…</option>${preset ? `<option value="${esc(preset.spaceId)}" selected>${esc(preset.name)}</option>` : ''}</select></label>
      <label>What it is<select name="kind">${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Menu<select name="menuOf"><option value="">Its own menu</option>${own.map((x) => `<option value="${esc(x.id)}" ${x.id === menuDefault ? 'selected' : ''}>Same as ${esc(x.name)}</option>`).join('')}</select></label>
      ${o ? '' : `<div class="span2 fp-tables" data-fp-tables><div class="sec-title">Tables</div><div class="form-grid">
        <label>How many<input name="tcount" type="number" min="0" max="200" value="10" inputmode="numeric"></label>
        <label>Seats each<input name="tseats" type="number" min="1" max="50" value="4" inputmode="numeric"></label>
        <label>Labelled<input name="tprefix" maxlength="6" value="${esc(prefixFor(preset?.name ?? ''))}" placeholder="G"> <small class="muted">G1, G2…</small></label></div></div>`}
      <label class="check span2"><input type="checkbox" name="liquor" ${o?.serves_liquor ? 'checked' : ''}> Serves liquor (within the bar licence)</label>
      ${o ? `<label class="check span2"><input type="checkbox" name="active" ${o.active ? 'checked' : ''}> Open for orders</label>` : ''}</div>
      <p class="muted small">Orders here show above this place on the map. A place that serves another's menu gets every change to that menu; its tickets still go to the stations the dishes are cooked at.</p>`,
    o ? 'Save' : 'Add the place', async (f) => {
      const body = { name: val(f, 'name'), kind: val(f, 'kind'), spaceId: val(f, 'space') || null, servesLiquor: checked(f, 'liquor'), menuOf: val(f, 'menuOf') || null }
      if (o) {
        await ws.api.req('PATCH', `/api/fnb/outlets/${o.id}`, { ...body, active: checked(f, 'active') })
        await onSaved(o.id, false)
        return 'Saved'
      }
      const count = Number(val(f, 'tcount')) || 0
      const r = await ws.api.post<{ id: string; tables: number }>('/api/fnb/outlets', { ...body, tables: count ? { count, seats: Number(val(f, 'tseats')) || 4, prefix: val(f, 'tprefix') } : undefined })
      await onSaved(r.id, true)
      return `${body.name} added${r.tables ? ` with ${r.tables} tables` : ''}`
    })
  // The table prefix follows the name until it is typed by hand ("Grand Lawn café" → GLC1, GLC2…).
  const nameIn = form.querySelector<HTMLInputElement>('[name=name]')!, prefixIn = form.querySelector<HTMLInputElement>('[name=tprefix]')
  let prefixTyped = false
  prefixIn?.addEventListener('input', () => { prefixTyped = true })
  nameIn.addEventListener('input', () => { if (prefixIn && !prefixTyped) prefixIn.value = prefixFor(nameIn.value) })
  // Kinds without tables hide the table fields.
  const kindSel = form.querySelector<HTMLSelectElement>('[name=kind]')!, tables = form.querySelector<HTMLElement>('[data-fp-tables]')
  const syncTables = () => { if (tables) tables.hidden = !SEATED.has(kindSel.value) }
  kindSel.addEventListener('change', syncTables); syncTables()
  // Every hall, lawn, ground, building and pool on the map, by name.
  const sel = form.querySelector<HTMLSelectElement>('[data-places]')!
  void ws.api.get<Place[]>('/api/spaces').then((sp) => {
    const places = sp.filter((x) => !x.room_no && !['room', 'villa', 'suite'].includes(x.kind)).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
    const current = o?.space_id ?? preset?.spaceId ?? ''
    sel.innerHTML = `<option value="">Not on the map</option>` + places.map((x) => `<option value="${esc(x.id)}" ${x.id === current ? 'selected' : ''}>${esc(x.name ?? x.id)} · ${esc(x.kind)}</option>`).join('')
  }).catch(() => {})
}

/** "Grand Lawn" → "GL": the table labels' prefix. */
function prefixFor(name: string) {
  const words = name.split(/\s+/).filter(Boolean)
  return (words.length > 1 ? words.map((w) => w[0]).join('') : name.slice(0, 1)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3)
}
