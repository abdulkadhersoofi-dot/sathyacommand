import { esc, toast, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { takePhoto, uploadPhoto } from '../ui/photo'
import type { WorkspaceHost } from '../ui/workspace'
import { reportFault } from '../eng/common'

// Shared pieces for the housekeeping screens.

export type HkStatus = 'vacant_clean' | 'inspected' | 'vacant_dirty' | 'occupied_clean' | 'occupied_dirty' | 'out_of_order' | 'out_of_service'

export interface Room {
  space_id: string; room_no: string; twin_id: string | null; kind: string; room_type: string | null; building: string | null; floor: number | null; section: string
  status: HkStatus; dnd: boolean; ooo_reason: string | null; ooo_from: string | null; ooo_to: string | null
  in_house: string | null; guest: string | null; departure: string | null; arriving: string | null; departing: boolean
  discrepancy: 'sleeper' | 'skipper' | null
  task: { id: string; kind: string; status: string; attendant: string | null; startedAt: string | null; score: number | null } | null
}

export const HK: Record<HkStatus, [string, string]> = {
  vacant_clean: ['Clean', '--st-vacant'], inspected: ['Ready', '--st-inspected'], vacant_dirty: ['Dirty', '--st-dirty'],
  occupied_clean: ['Occupied · serviced', '--st-occupied'], occupied_dirty: ['Occupied · to service', '--st-occupied'],
  out_of_order: ['Out of order', '--st-ooo'], out_of_service: ['Out of service', '--muted'],
}
export const TASK: Record<string, string> = { checkout: 'Check-out clean', stayover: 'Stay-over', turndown: 'Turndown', deep_clean: 'Deep clean', touch_up: 'Touch-up', public_area: 'Public area' }
export const TASK_STATE: Record<string, [string, string]> = {
  pending: ['To do', '--muted'], in_progress: ['Cleaning', '--st-arriving'], cleaned: ['To inspect', '--marigold'], inspected: ['Passed', '--st-vacant'], reclean: ['Re-clean', '--st-departing'],
}

export const hkPill = (s: HkStatus) => tonePill(...HK[s])
export const minutes = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))

export interface HkHost extends WorkspaceHost {
  /** Rooms as last loaded (shared by the screens that need a room list). */
  rooms: Room[]
  loadRooms(): Promise<void>
}

/** Everything one can do to a room, by role: status, out of order, do-not-disturb, minibar, what is in the room, found items, extra tasks. */
export async function roomActions(h: HkHost, r: Room) {
  const api = h.api
  const actions: string[] = []
  if (h.can('hk.manage')) {
    if (r.status === 'out_of_order' || r.status === 'out_of_service') actions.push('<button type="button" class="btn" data-ra="back">Return to service</button>')
    else actions.push('<button type="button" class="btn" data-ra="ooo">Out of order…</button>', '<button type="button" class="btn" data-ra="status">Set status…</button>', '<button type="button" class="btn" data-ra="task">Add task…</button>')
  }
  if (h.can('hk.attend', 'hk.manage', 'front_desk')) actions.push(`<button type="button" class="btn" data-ra="dnd">${r.dnd ? 'Clear' : 'Set'} do-not-disturb</button>`)
  if (r.in_house && h.can('hk.attend', 'hk.manage', 'front_desk')) actions.push('<button type="button" class="btn" data-ra="minibar">Minibar used…</button>', '<button type="button" class="btn" data-ra="laundry">Collect laundry…</button>')
  if (h.can('hk.attend', 'hk.manage')) actions.push('<button type="button" class="btn" data-ra="seen-v">I found it empty</button>', '<button type="button" class="btn" data-ra="seen-o">I found a guest / luggage</button>')
  actions.push('<button type="button" class="btn" data-ra="found">Found an item…</button>', '<button type="button" class="btn" data-ra="fault">Report a fault…</button>')
  h.modal.open(`Room ${r.room_no}`, `<div class="room-head">${hkPill(r.status)}${r.dnd ? tonePill('Do not disturb', '--god') : ''}${r.discrepancy ? tonePill(r.discrepancy === 'skipper' ? 'Skipper?' : 'Sleeper?', '--st-departing') : ''}</div>
    <dl class="kv"><dt>Section</dt><dd>${esc(r.section)}</dd>${r.room_type ? `<dt>Type</dt><dd>${esc(r.room_type)}</dd>` : ''}
      ${r.guest ? `<dt>Guest</dt><dd>${esc(r.guest)}${r.departing ? ' · leaving today' : ''}</dd>` : ''}${r.arriving ? '<dt>Arrival</dt><dd>Guest arriving today</dd>' : ''}
      ${r.task ? `<dt>Task</dt><dd>${esc(TASK[r.task.kind] ?? r.task.kind)} · ${esc(TASK_STATE[r.task.status]?.[0] ?? r.task.status)}${r.task.attendant ? ` · ${esc(r.task.attendant)}` : ''}</dd>` : ''}
      ${r.ooo_reason ? `<dt>Out of order</dt><dd>${esc(r.ooo_reason)}${r.ooo_to ? ` until ${esc(r.ooo_to)}` : ''}</dd>` : ''}</dl>
    <div class="actions room-actions">${actions.join('')}</div>`, 'Done', async () => '')
  const done = async (msg: string) => { await h.loadRooms(); h.render(); return msg }
  h.modal.el.querySelector('.room-actions')!.addEventListener('click', async (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-ra]')?.dataset.ra
    if (!a) return
    try {
      if (a === 'dnd') { await api.post(`/api/hk/rooms/${r.space_id}/dnd`, { on: !r.dnd }); h.modal.close(); await done(''); return }
      if (a === 'seen-v' || a === 'seen-o') {
        const res = await api.post<{ discrepancy: string | null }>(`/api/hk/rooms/${r.space_id}/observed`, { occupancy: a === 'seen-v' ? 'vacant' : 'occupied' })
        h.modal.close(); await done('')
        toast(res.discrepancy ? `Does not match reception (${res.discrepancy}). The manager has been told.` : 'Matches reception. Thank you.')
        return
      }
      if (a === 'back') { await api.post(`/api/hk/rooms/${r.space_id}/return-to-service`); h.modal.close(); await done(''); return }
      if (a === 'ooo') {
        h.modal.open(`Room ${r.room_no} out of order`, `<div class="form-grid"><label class="span2">Reason<input name="reason" maxlength="120" placeholder="e.g. AC compressor replacement"></label>
          <label>From<input name="from" type="date"></label><label>Until (leave blank if not known)<input name="to" type="date"></label></div>
          <p class="muted small">The room leaves availability for these dates. Refused while a guest is in it or booked.</p>`, 'Take out of order', async (f) => {
          await api.post(`/api/hk/rooms/${r.space_id}/out-of-order`, { reason: val(f, 'reason'), from: val(f, 'from') || undefined, to: val(f, 'to') || undefined })
          return done('Room out of order')
        })
      }
      if (a === 'status') {
        const opts = (r.in_house ? ['occupied_clean', 'occupied_dirty'] : ['vacant_dirty', 'vacant_clean', 'inspected', 'out_of_service']) as HkStatus[]
        h.modal.open(`Room ${r.room_no} status`, `<div class="form-grid"><label class="span2">Status<select name="status">${opts.map((o) => `<option value="${o}" ${o === r.status ? 'selected' : ''}>${HK[o][0]}</option>`).join('')}</select></label></div>`, 'Save', async (f) => {
          await api.post(`/api/hk/rooms/${r.space_id}/status`, { status: val(f, 'status') }); return done('Status changed')
        })
      }
      if (a === 'task') {
        h.modal.open(`Extra task · room ${r.room_no}`, `<div class="form-grid"><label class="span2">Task<select name="kind">${['turndown', 'deep_clean', 'touch_up', 'stayover', 'checkout'].map((k) => `<option value="${k}">${TASK[k]}</option>`).join('')}</select></label></div>`, 'Add', async (f) => {
          await api.post('/api/hk/tasks', { spaceId: r.space_id, kind: val(f, 'kind') }); return done('Task added')
        })
      }
      if (a === 'minibar') {
        const items = (await api.get<{ id: string; name: string; price_paise: number; active: boolean }[]>('/api/hk/minibar-items')).filter((i) => i.active)
        h.modal.open(`Minibar · room ${r.room_no}`, items.length ? `<div class="count-grid">${items.map((i) => `<label><span>${esc(i.name)} <small class="muted">₹${i.price_paise / 100}</small></span><input name="m_${esc(i.id)}" type="number" min="0" max="50" placeholder="0" aria-label="Quantity used"></label>`).join('')}</div>` : '<p>No minibar items set up yet.</p>', items.length ? 'Charge to the room' : 'Done', async (f) => {
          const used = items.map((i) => ({ itemId: i.id, qty: Number(val(f, `m_${i.id}`) || 0) })).filter((x) => x.qty > 0)
          if (!used.length) return ''
          const res = await api.post<{ total: number }>(`/api/hk/rooms/${r.space_id}/minibar`, { items: used })
          return done(`₹${(res.total / 100).toFixed(2)} added to the guest's bill`)
        })
      }
      if (a === 'laundry') {
        const items = (await api.get<{ id: string; name: string; service: string; price_paise: number; active: boolean }[]>('/api/laundry/items')).filter((i) => i.active)
        const SV: Record<string, string> = { wash_iron: 'Wash & iron', dry_clean: 'Dry clean', press: 'Press' }
        h.modal.open(`Laundry from room ${r.room_no}`, `<div class="count-grid">${items.map((i) => `<label><span>${esc(i.name)} <small class="muted">${SV[i.service]} · ₹${i.price_paise / 100}</small></span><input name="l_${esc(i.id)}" type="number" min="0" max="100" placeholder="0" aria-label="Pieces"></label>`).join('')}</div>
          <label class="check"><input type="checkbox" name="express"> Express (same day, +50%)</label>`, 'Collect', async (f) => {
          const its = items.map((i) => ({ itemId: i.id, qty: Number(val(f, `l_${i.id}`) || 0) })).filter((x) => x.qty > 0)
          if (!its.length) throw new Error('Count the pieces collected.')
          await api.post('/api/laundry/orders', { spaceId: r.space_id, items: its, express: checked(f, 'express') })
          return done('Laundry collected. It is charged when delivered back.')
        })
      }
      if (a === 'found') await foundItem(h, r.space_id, `room ${r.room_no}`)
      if (a === 'fault') reportFault(h, { spaceId: r.space_id, where: `Room ${r.room_no}` })
    } catch (err) { toast((err as Error).message) }
  })
}

/** Log a found item with an optional photo. */
export async function foundItem(h: HkHost, spaceId: string | null, where: string) {
  let photo: string | null = null
  h.modal.open('Found item', `<div class="form-grid"><label class="span2">What is it?<input name="desc" maxlength="200" placeholder="e.g. black phone charger"></label>
    ${spaceId ? '' : '<label class="span2">Where was it found?<input name="place" maxlength="80"></label>'}</div>
    <div class="actions"><button type="button" class="btn" data-photo>Take a photo</button><span class="muted small" data-photo-state></span></div>
    <p class="muted small">${spaceId ? `Found in ${esc(where)}: reception will see the last guest's details.` : ''} Hand the item to the housekeeping desk.</p>`, 'Log item', async (f) => {
    const photoId = photo ? await uploadPhoto(h.api, 'lost_found', photo) : undefined
    await h.api.post('/api/hk/lost-found', { description: val(f, 'desc'), spaceId: spaceId ?? undefined, place: spaceId ? undefined : val(f, 'place'), photoId })
    return 'Item logged'
  })
  h.modal.el.querySelector('[data-photo]')!.addEventListener('click', async () => {
    photo = await takePhoto()
    h.modal.el.querySelector('[data-photo-state]')!.textContent = photo ? 'Photo ready' : ''
  })
}
