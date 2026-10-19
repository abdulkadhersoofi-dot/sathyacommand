import { randomUUID } from 'node:crypto'
import { appendAudit } from './audit-store'
import { HttpError, type Caller } from './context'
import type { Db } from './db'
import { LODGING } from './fo-core'

// Housekeeping state of every room, moved along by the front office (check-in, check-out, room moves),
// the night audit (stay-overs become dirty) and the housekeeping team (clean, inspect, out of order).

export type HkStatus = 'vacant_clean' | 'inspected' | 'vacant_dirty' | 'occupied_clean' | 'occupied_dirty' | 'out_of_order' | 'out_of_service'
export type TaskKind = 'checkout' | 'stayover' | 'turndown' | 'deep_clean' | 'touch_up' | 'public_area'

/** Workload credits: a check-out room takes about twice as long as a stay-over. */
export const CREDITS: Record<TaskKind, number> = { checkout: 2, stayover: 1, turndown: 0.5, deep_clean: 4, touch_up: 0.5, public_area: 1 }

export const CHECKLISTS: Record<TaskKind, string[]> = {
  checkout: ['Strip and remake beds with fresh linen', 'Bathroom cleaned and sanitised', 'Fresh towels', 'Amenities refilled', 'Minibar checked and refilled',
    'Dust, vacuum and mop', 'AC, TV, lights and hot water working', 'Checked for left-behind items'],
  stayover: ['Make beds', 'Bathroom cleaned', 'Towels changed if on the floor', 'Amenities topped up', 'Bins emptied', 'Floor swept'],
  turndown: ['Bed turned down', 'Curtains drawn', 'Water and chocolate placed', 'Lights set'],
  deep_clean: ['Mattress turned', 'Curtains and upholstery cleaned', 'AC filters cleaned', 'Behind and under furniture cleaned', 'Grout and tiles scrubbed', 'Pest check'],
  touch_up: ['Quick tidy', 'Bathroom wiped', 'Bins emptied'],
  public_area: ['Floor cleaned', 'Washrooms cleaned and stocked', 'Bins emptied', 'Furniture arranged'],
}

const SYSTEM: Caller = { userId: 'system', name: 'System', role: 'system', roles: [], godMode: false, permissions: new Set(), sessionId: '', scope: 'full' }
const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`

/** Every lodging room has a housekeeping row; its section defaults to building and floor. */
export async function ensureRoomHk(db: Db, now = new Date()) {
  await db.query(
    `insert into room_hk (space_id, section, updated_at)
     select s.id, coalesce(s.building, 'Rooms') || case when s.floor is not null then ' · floor ' || s.floor else '' end, $2
       from space s where s.kind = any($1) and s.active and not exists (select 1 from room_hk h where h.space_id = s.id)`, [LODGING, now])
}

export async function hkOf(t: Db, spaceId: string) {
  const [h] = await t.query<{ status: HkStatus; dnd: boolean; room_no: string | null }>(
    'select h.status, h.dnd, s.room_no from room_hk h join space s on s.id = h.space_id where h.space_id = $1', [spaceId])
  return h ?? null
}

export async function setHk(t: Db, spaceId: string, status: HkStatus, who: Caller, now: Date, extra: Record<string, unknown> = {}) {
  const before = await hkOf(t, spaceId)
  if (!before) return
  await t.query('update room_hk set status = $2, updated_at = $3, updated_by = $4 where space_id = $1', [spaceId, status, now, who.userId])
  if (before.status !== status) {
    await appendAudit(t, { actor: who, action: status === 'inspected' ? 'hk.room_ready' : 'hk.status', entity: { type: 'room', id: spaceId },
      before: { status: before.status }, after: { status, roomNo: before.room_no, ...extra } }, now)
  }
}

/** Adds a cleaning task unless the room already has an open one of that kind for the day. */
export async function addTask(t: Db, spaceId: string, kind: TaskKind, day: string, now: Date, priority = 0) {
  await t.query(
    `insert into hk_task (id, space_id, business_date, kind, credits, priority, checklist, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
    [newId('HT'), spaceId, day, kind, CREDITS[kind], priority, JSON.stringify(CHECKLISTS[kind].map((item) => ({ item, done: false }))), now])
}

/** Check-in refuses rooms out of order; the room becomes occupied (and clean). */
export async function onCheckIn(t: Db, spaceId: string, who: Caller, now: Date) {
  const h = await hkOf(t, spaceId)
  if (!h) return { warning: null }
  if (h.status === 'out_of_order') throw new HttpError(409, `Room ${h.room_no} is out of order. Choose another room.`)
  const warning = h.status === 'vacant_dirty' ? `Room ${h.room_no} has not been cleaned yet.` : h.status === 'vacant_clean' ? `Room ${h.room_no} is clean but not inspected.` : null
  await setHk(t, spaceId, 'occupied_clean', who, now)
  await t.query(`update hk_task set status = 'cancelled' where space_id = $1 and kind = 'checkout' and status in ('pending', 'reclean')`, [spaceId])
  return { warning }
}

/** Check-out leaves the room dirty with a check-out clean for today. */
export async function onCheckOut(t: Db, spaceId: string, day: string, who: Caller, now: Date) {
  await t.query(`update room_hk set dnd = false, dnd_since = null where space_id = $1`, [spaceId])
  await setHk(t, spaceId, 'vacant_dirty', who, now)
  await t.query(`update hk_task set status = 'cancelled' where space_id = $1 and kind = 'stayover' and status in ('pending', 'reclean')`, [spaceId])
  await addTask(t, spaceId, 'checkout', day, now, 10)
}

/** A guest moved rooms: the old one needs a check-out clean, the new one is occupied. */
export async function onRoomMove(t: Db, from: string, to: string, day: string, who: Caller, now: Date) {
  await onCheckOut(t, from, day, who, now)
  await setHk(t, to, 'occupied_clean', who, now)
}

/** Closing the day: every occupied room needs its stay-over service tomorrow; do-not-disturb resets. */
export async function onNightAudit(t: Db, nextDay: string, now: Date) {
  const rooms = await t.query<{ space_id: string }>(
    `select r.space_id from reservation r join room_hk h on h.space_id = r.space_id where r.status = 'in_house' and r.space_id is not null`)
  for (const r of rooms) {
    await setHk(t, r.space_id, 'occupied_dirty', SYSTEM, now)
    await addTask(t, r.space_id, 'stayover', nextDay, now)
  }
  await t.query('update room_hk set dnd = false, dnd_since = null where dnd')
  // Rooms whose out-of-order period has ended come back as dirty, to be checked before sale.
  const back = await t.query<{ space_id: string }>(`select space_id from room_hk where status = 'out_of_order' and ooo_to is not null and ooo_to < $1`, [nextDay])
  for (const r of back) {
    await t.query('update room_hk set ooo_reason = null, ooo_from = null, ooo_to = null where space_id = $1', [r.space_id])
    await setHk(t, r.space_id, 'vacant_dirty', SYSTEM, now, { note: 'Out-of-order period ended' })
    await addTask(t, r.space_id, 'checkout', nextDay, now)
  }
  return rooms.length
}
