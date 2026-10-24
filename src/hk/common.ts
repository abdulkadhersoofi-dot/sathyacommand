import { esc, toast, tonePill, showDate } from '../ui/dom'
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

const ICON: Record<string, string> = {
  broom: '<svg viewBox="0 0 24 24"><path d="M3 21l6-6M9 15l6-6m0 0l4-4m-4 4l5 5M3 21c2-5 5-6 8-4s4 5 2 7"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg>',
  double: '<svg viewBox="0 0 24 24"><path d="M2 12l5 5 7-7M9 17l2 2 11-11"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4M3 3l18 18"/></svg>',
  bed: '<svg viewBox="0 0 24 24"><path d="M3 18V8M3 12h18v6M7 12V9h5v3M21 18v-2"/></svg>',
  wrench: '<svg viewBox="0 0 24 24"><path d="M14 7a4 4 0 0 1 5 5l-9 9-5-5 9-9zM3 21l5-5"/></svg>',
}
const tile = (ra: string, icon: string, label: string, sub: string, tone: string) =>
  `<button type="button" class="hk-tile" data-ra="${ra}" style="--tile: var(${tone})">${ICON[icon]}<b>${esc(label)}</b><small>${esc(sub)}</small></button>`

/**
 * The room card, built for the hand: one or two big tiles for what this person does now (start, room is
 * clean, inspected, needs re-clean, serviced, do-not-disturb), small buttons for the rest, and the
 * managers' tools under More.
 */
export async function roomActions(h: HkHost, r: Room) {
  const api = h.api
  const attend = h.can('hk.attend', 'hk.manage'), inspect = h.can('hk.inspect'), manage = h.can('hk.manage'), desk = h.can('front_desk')
  const t = r.task
  const tiles: string[] = []
  let note = ''
  if (r.status === 'out_of_order' || r.status === 'out_of_service') {
    if (manage) tiles.push(tile('back', 'wrench', 'Back in service', 'the room can be sold again', '--st-vacant'))
    else note = 'This room is out of order.'
  } else if (t && ['pending', 'reclean'].includes(t.status)) {
    if (attend) tiles.push(tile('start', 'broom', t.status === 'reclean' ? 'Clean it again' : 'Start cleaning', TASK[t.kind] ?? t.kind, '--st-occupied'))
  } else if (t && t.status === 'in_progress') {
    if (attend) tiles.push(tile('clean', 'check', 'Room is clean', 'tick the list, then done', '--st-vacant'))
  } else if (t && t.status === 'cleaned') {
    if (inspect) tiles.push(tile('inspect-ok', 'double', 'Inspected · ready', 'the room can be given', '--st-inspected'), tile('inspect-no', 'redo', 'Needs re-clean', 'say what is wrong', '--st-departing'))
    else note = 'Cleaned. Waiting for the supervisor to inspect it.'
  } else if (r.in_house) {
    if (manage) tiles.push(r.status === 'occupied_dirty' ? tile('set:occupied_clean', 'bed', 'Serviced', 'the guest\'s room is done', '--st-vacant') : tile('set:occupied_dirty', 'broom', 'Needs service', 'put it on the list', '--st-dirty'))
  } else if (r.status === 'vacant_dirty') {
    if (manage) tiles.push(tile('set:vacant_clean', 'check', 'Room is clean', 'cleaned without a task', '--st-vacant'))
    else if (attend) note = 'No task on this room yet: the supervisor assigns it, then Start cleaning shows here.'
  } else if (r.status === 'vacant_clean') {
    if (inspect || manage) tiles.push(tile('set:inspected', 'double', 'Inspected · ready', 'the room can be given', '--st-inspected'))
    if (manage) tiles.push(tile('set:vacant_dirty', 'broom', 'Needs cleaning', 'back on the list', '--st-dirty'))
  } else if (r.status === 'inspected' && manage) tiles.push(tile('set:vacant_dirty', 'broom', 'Needs cleaning', 'back on the list', '--st-dirty'))
  if (attend || desk) tiles.push(tile('dnd', 'bell', r.dnd ? 'Do not disturb · on' : 'Do not disturb', r.dnd ? 'tap to clear it' : 'the guest asked not to be disturbed', r.dnd ? '--god' : '--marigold'))

  const small: string[] = []
  if (r.in_house && (attend || desk)) small.push('<button type="button" class="btn" data-ra="minibar">Minibar used…</button>', '<button type="button" class="btn" data-ra="laundry">Collect laundry…</button>')
  if (attend) small.push('<button type="button" class="btn" data-ra="seen-v">I found it empty</button>', '<button type="button" class="btn" data-ra="seen-o">I found a guest / luggage</button>')
  small.push('<button type="button" class="btn" data-ra="found">Found an item…</button>', '<button type="button" class="btn" data-ra="fault">Report a fault…</button>')
  const more = manage && r.status !== 'out_of_order' && r.status !== 'out_of_service'
    ? `<details class="menu hk-more"><summary class="btn">More ▾</summary><div class="menu-list" role="menu"><button type="button" class="menu-row" data-ra="task">Add a task…</button><button type="button" class="menu-row" data-ra="status">Change the status…</button><div class="menu-sep"></div><button type="button" class="menu-row danger" data-ra="ooo">Out of order…</button></div></details>` : ''

  h.modal.open(`Room ${r.room_no}`, `<div class="room-head">${hkPill(r.status)}${r.dnd ? tonePill('Do not disturb', '--god') : ''}${r.discrepancy ? tonePill(r.discrepancy === 'skipper' ? 'Skipper?' : 'Sleeper?', '--st-departing') : ''}
      ${t ? tonePill(`${TASK[t.kind] ?? t.kind} · ${TASK_STATE[t.status]?.[0] ?? t.status}`, TASK_STATE[t.status]?.[1] ?? '--muted') : ''}</div>
    <dl class="kv"><dt>Section</dt><dd>${esc(r.section)}</dd>${r.room_type ? `<dt>Type</dt><dd>${esc(r.room_type)}</dd>` : ''}
      ${r.guest ? `<dt>Guest</dt><dd>${esc(r.guest)}${r.departing ? ' · leaving today' : ''}</dd>` : ''}${r.arriving ? '<dt>Arrival</dt><dd>Guest arriving today</dd>' : ''}
      ${t?.attendant ? `<dt>Attendant</dt><dd>${esc(t.attendant)}</dd>` : ''}
      ${r.ooo_reason ? `<dt>Out of order</dt><dd>${esc(r.ooo_reason)}${r.ooo_to ? ` until ${esc(showDate(r.ooo_to))}` : ''}</dd>` : ''}</dl>
    ${tiles.length ? `<div class="hk-tiles">${tiles.join('')}</div>` : ''}${note ? `<p class="muted hk-note">${esc(note)}</p>` : ''}
    <div class="actions room-actions">${small.join('')}${more}</div>`, 'Done', async () => '')
  const done = async (msg: string) => { await h.loadRooms(); h.render(); return msg }
  h.modal.el.querySelector('form')!.addEventListener('click', async (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-ra]')?.dataset.ra
    if (!a) return
    try {
      if (a === 'start') { await api.post(`/api/hk/tasks/${t!.id}/start`); h.modal.close(); await done(`Room ${r.room_no}: cleaning started`); return }
      if (a === 'clean') {
        // The checklist as big tick rows, all ticked: untick what was not done and say why.
        const task = (await api.get<{ id: string; checklist: { item: string; done: boolean }[] }[]>('/api/hk/tasks')).find((x) => x.id === t!.id)
        const list = task?.checklist ?? []
        h.modal.open(`Room ${r.room_no} is clean`, `<ul class="checklist big">${list.map((c, i) => `<li><label><input type="checkbox" name="c${i}" checked> ${esc(c.item)}</label></li>`).join('')}</ul>
          <div class="form-grid"><label class="span2">Anything not done, or to tell the supervisor<input name="notes" maxlength="200"></label></div>`, 'Room is clean', async (f) => {
          const checklist = list.map((c, i) => ({ item: c.item, done: checked(f, `c${i}`) }))
          const notes = val(f, 'notes')
          if (checklist.some((c) => !c.done) && !notes) throw new Error('Tick every item, or say what was not done.')
          const out = await api.post<{ minutes: number }>(`/api/hk/tasks/${t!.id}/finish`, { checklist, notes: notes || undefined })
          return done(`Room ${r.room_no} done in ${out.minutes} min. Waiting for inspection.`)
        })
        return
      }
      if (a === 'inspect-ok') { await api.post(`/api/hk/tasks/${t!.id}/inspect`, { score: 100 }); h.modal.close(); await done(`Room ${r.room_no}: inspected and ready`); return }
      if (a === 'inspect-no') {
        h.modal.open(`Room ${r.room_no} needs re-cleaning`, `<div class="form-grid"><label class="span2">What is wrong<input name="notes" required maxlength="200" placeholder="e.g. bathroom floor, dust on the TV"></label></div>`, 'Send it back', async (f) => {
          await api.post(`/api/hk/tasks/${t!.id}/inspect`, { score: 0, notes: val(f, 'notes') }); return done(`Room ${r.room_no} goes back for cleaning`)
        })
        return
      }
      if (a.startsWith('set:')) { await api.post(`/api/hk/rooms/${r.space_id}/status`, { status: a.slice(4) }); h.modal.close(); await done(`Room ${r.room_no}: ${HK[a.slice(4) as HkStatus][0]}`); return }
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
