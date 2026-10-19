import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { priceGuard, rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { requireCaller } from './auth'
import { ensureRoomHk } from '../hk-core'

// Rooms and room types are data, not code: add, rename, renumber, retype or archive them at any time.
// Rooms are archived, never deleted, so past bookings and bills keep pointing at them.

const LODGING_KINDS = ['room', 'villa', 'suite', 'cottage', 'tent', 'dormitory']
const PROPERTY = 'sathya'

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function editor(ctx: Ctx, req: Parameters<typeof requireCaller>[1]) {
  const who = await requireCaller(ctx, req)
  if (!can(who, 'inventory.edit')) throw new HttpError(403, 'Only the MD or GM can change rooms and room types.')
  return who
}

interface RoomInput { roomNo?: string; kind?: string; roomTypeId?: string; name?: string; building?: string | null; floor?: number | null; twinId?: string | null; active?: boolean }

async function checkRoomInput(t: Db, r: RoomInput, partial: boolean) {
  if (!partial || r.roomNo !== undefined) {
    if (!r.roomNo || !/^[A-Za-z0-9-]{1,12}$/.test(r.roomNo)) throw new HttpError(400, 'Room number must be 1–12 letters, digits or dashes.')
  }
  if (!partial || r.kind !== undefined) {
    if (!LODGING_KINDS.includes(r.kind ?? '')) throw new HttpError(400, `Kind must be one of: ${LODGING_KINDS.join(', ')}.`)
  }
  if (!partial || r.roomTypeId !== undefined) {
    const [rt] = await t.query<{ active: boolean }>('select active from room_type where id = $1', [r.roomTypeId])
    if (!rt) throw new HttpError(400, `No room type "${r.roomTypeId}".`)
    if (!rt.active) throw new HttpError(400, `Room type "${r.roomTypeId}" is archived.`)
  }
}

const defaultName = (kind: string, roomNo: string) => `${kind[0].toUpperCase()}${kind.slice(1)} ${roomNo}`

async function upsertRoom(ctx: Ctx, t: Db, who: Caller, r: RoomInput) {
  const [existing] = await t.query<Record<string, unknown>>('select * from space where property_id = $1 and room_no = $2', [PROPERTY, r.roomNo])
  const name = r.name ?? defaultName(r.kind!, r.roomNo!)
  if (existing) {
    await t.query(
      `update space set kind = $2, name = $3, room_type_id = $4, building = $5, floor = $6, twin_id = coalesce($7, twin_id),
              active = true, sellable = true, placeholder = false, updated_at = $8 where id = $1`,
      [existing.id, r.kind, name, r.roomTypeId, r.building ?? null, r.floor ?? null, r.twinId ?? null, ctx.now()])
    return { id: existing.id as string, created: false, before: existing }
  }
  // Ids never change when a room is renumbered, so a new room may find its natural id taken.
  let id = `RM-${r.roomNo}`
  if ((await t.query('select 1 from space where id = $1', [id])).length) id = `RM-${r.roomNo}-${randomUUID().slice(0, 6)}`
  await t.query(
    `insert into space (id, property_id, kind, name, room_no, room_type_id, building, floor, twin_id, sellable, placeholder, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, false, $10)`,
    [id, PROPERTY, r.kind, name, r.roomNo, r.roomTypeId, r.building ?? null, r.floor ?? null, r.twinId ?? null, ctx.now()])
  return { id, created: true, before: null }
}

export function inventoryRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---------- room types ----------
  app.post('/api/room-types', async (req) => {
    const who = await editor(ctx, req)
    const b = req.body as { id?: string; name?: string; baseRate?: number; maxOccupancy?: number }
    if (!b?.name || !(b.baseRate! > 0)) throw new HttpError(400, 'Send name and baseRate (₹).')
    const id = b.id ? slug(b.id) : slug(b.name)
    const amount = rupees(b.baseRate!)
    const guard = priceGuard(ctx.tax, amount)
    if (!guard.allowed && !who.permissions.has('*')) throw new HttpError(403, guard.message ?? 'Needs MD approval.', { requires: guard.requires })
    return ctx.db.tx(async (t) => {
      const [dup] = await t.query('select 1 from room_type where id = $1', [id])
      if (dup) throw new HttpError(409, `A room type "${id}" already exists.`)
      await t.query('insert into room_type (id, property_id, name, base_rate_paise, max_occupancy, updated_at) values ($1, $2, $3, $4, $5, $6)',
        [id, PROPERTY, b.name, amount, b.maxOccupancy ?? 2, ctx.now()])
      await appendAudit(t, { actor: who, action: 'room_type.create', entity: { type: 'room_type', id },
        after: { name: b.name, base_rate_paise: amount, max_occupancy: b.maxOccupancy ?? 2 } }, ctx.now())
      return { id }
    })
  })

  app.patch('/api/room-types/:id', async (req) => {
    const who = await editor(ctx, req)
    const { id } = req.params as { id: string }
    const b = req.body as { name?: string; baseRate?: number; maxOccupancy?: number; active?: boolean }
    return ctx.db.tx(async (t) => {
      const [before] = await t.query<{ name: string; base_rate_paise: number; max_occupancy: number; active: boolean }>(
        'select name, base_rate_paise, max_occupancy, active from room_type where id = $1 for update', [id])
      if (!before) throw new HttpError(404, `No room type "${id}".`)
      const after = { ...before }
      if (b.name !== undefined) after.name = b.name
      if (b.maxOccupancy !== undefined) after.max_occupancy = b.maxOccupancy
      if (b.baseRate !== undefined) {
        after.base_rate_paise = rupees(b.baseRate)
        const guard = priceGuard(ctx.tax, after.base_rate_paise)
        if (!guard.allowed && !who.permissions.has('*')) throw new HttpError(403, guard.message ?? 'Needs MD approval.', { requires: guard.requires })
      }
      if (b.active === false) {
        const [{ n }] = await t.query<{ n: number }>('select count(*)::int n from space where room_type_id = $1 and active', [id])
        if (n) throw new HttpError(409, `${n} active room(s) still use this type. Move them to another type first.`)
        after.active = false
      } else if (b.active === true) after.active = true
      await t.query('update room_type set name = $2, base_rate_paise = $3, max_occupancy = $4, active = $5, updated_at = $6 where id = $1',
        [id, after.name, after.base_rate_paise, after.max_occupancy, after.active, ctx.now()])
      await appendAudit(t, { actor: who, action: 'room_type.update', entity: { type: 'room_type', id }, before, after }, ctx.now())
      return { id, ...after }
    })
  })

  // ---------- rooms ----------
  app.get('/api/rooms', async (req) => {
    await requireCaller(ctx, req)
    const q = req.query as { includeArchived?: string }
    return ctx.db.query(
      `select s.id, s.room_no, s.kind, s.name, s.room_type_id, t.name as room_type, s.building, s.floor, s.twin_id,
              s.placeholder, s.active
         from space s left join room_type t on t.id = s.room_type_id
        where s.kind = any($1) ${q.includeArchived === 'true' ? '' : 'and s.active'}
        order by s.building nulls last, s.floor nulls last, s.room_no`, [LODGING_KINDS])
  })

  app.post('/api/rooms', async (req, reply) => {
    const who = await editor(ctx, req)
    const r = req.body as RoomInput
    return ctx.db.tx(async (t) => {
      await checkRoomInput(t, r, false)
      const [dup] = await t.query('select 1 from space where property_id = $1 and room_no = $2', [PROPERTY, r.roomNo])
      if (dup) throw new HttpError(409, `Room ${r.roomNo} already exists.`)
      const res = await upsertRoom(ctx, t, who, r)
      await ensureRoomHk(t, ctx.now())
      await appendAudit(t, { actor: who, action: 'room.create', entity: { type: 'room', id: res.id }, after: r }, ctx.now())
      return reply.status(201).send({ id: res.id })
    })
  })

  app.patch('/api/rooms/:id', async (req) => {
    const who = await editor(ctx, req)
    const { id } = req.params as { id: string }
    const r = req.body as RoomInput
    return ctx.db.tx(async (t) => {
      const [before] = await t.query<Record<string, unknown>>('select * from space where id = $1 and kind = any($2) for update', [id, LODGING_KINDS])
      if (!before) throw new HttpError(404, `No room ${id}.`)
      await checkRoomInput(t, r, true)
      if (r.roomNo && r.roomNo !== before.room_no) {
        const [dup] = await t.query('select 1 from space where property_id = $1 and room_no = $2', [PROPERTY, r.roomNo])
        if (dup) throw new HttpError(409, `Room ${r.roomNo} already exists.`)
      }
      const roomNo = r.roomNo ?? (before.room_no as string)
      const kind = r.kind ?? (before.kind as string)
      const renamed = r.name ?? (r.roomNo || r.kind ? defaultName(kind, roomNo) : (before.name as string))
      await t.query(
        `update space set room_no = $2, kind = $3, name = $4, room_type_id = $5, building = $6, floor = $7, twin_id = $8,
                active = $9, placeholder = false, updated_at = $10 where id = $1`,
        [id, roomNo, kind, renamed, r.roomTypeId ?? before.room_type_id,
          r.building !== undefined ? r.building : before.building, r.floor !== undefined ? r.floor : before.floor,
          r.twinId !== undefined ? r.twinId : before.twin_id, r.active ?? before.active, ctx.now()])
      const [after] = await t.query('select * from space where id = $1', [id])
      await appendAudit(t, { actor: who, action: r.active === false ? 'room.archive' : 'room.update', entity: { type: 'room', id }, before, after }, ctx.now())
      return after
    })
  })

  app.delete('/api/rooms/:id', async (req) => {
    const who = await editor(ctx, req)
    const { id } = req.params as { id: string }
    return ctx.db.tx(async (t) => {
      const [before] = await t.query<{ active: boolean }>('select active from space where id = $1 and kind = any($2)', [id, LODGING_KINDS])
      if (!before) throw new HttpError(404, `No room ${id}.`)
      // Phase 2.5 adds: refuse while future reservations exist for this room.
      await t.query('update space set active = false, updated_at = $2 where id = $1', [id, ctx.now()])
      await appendAudit(t, { actor: who, action: 'room.archive', entity: { type: 'room', id }, before, after: { active: false } }, ctx.now())
      return { ok: true, archived: id }
    })
  })

  // Load the resort's real room list in one go. Existing room numbers are updated, new ones added;
  // with replacePlaceholders, placeholder rooms not in the list are archived.
  app.post('/api/rooms/import', async (req) => {
    const who = await editor(ctx, req)
    const b = req.body as { rooms?: RoomInput[]; replacePlaceholders?: boolean }
    if (!Array.isArray(b?.rooms) || !b.rooms.length) throw new HttpError(400, 'Send rooms: a list of rooms.')
    const seen = new Set<string>()
    for (const r of b.rooms) {
      if (seen.has(r.roomNo ?? '')) throw new HttpError(400, `Room ${r.roomNo} appears twice in the list.`)
      seen.add(r.roomNo ?? '')
    }
    return ctx.db.tx(async (t) => {
      let created = 0, updated = 0, archived = 0
      for (const r of b.rooms!) {
        try { await checkRoomInput(t, r, false) } catch (e) {
          throw e instanceof HttpError ? new HttpError(400, `Room ${r.roomNo ?? '?'}: ${e.message}`) : e
        }
        const res = await upsertRoom(ctx, t, who, r)
        await ensureRoomHk(t, ctx.now())
        res.created ? created++ : updated++
      }
      if (b.replacePlaceholders) {
        const rows = await t.query<{ id: string }>(
          `update space set active = false, updated_at = $2 where placeholder and active and kind = any($3) and not (room_no = any($1)) returning id`,
          [[...seen], ctx.now(), LODGING_KINDS])
        archived = rows.length
      }
      await appendAudit(t, { actor: who, action: 'room.import', entity: { type: 'property', id: PROPERTY },
        after: { created, updated, archivedPlaceholders: archived, rooms: b.rooms!.length } }, ctx.now())
      const [{ n }] = await t.query<{ n: number }>('select count(*)::int n from space where active and kind = any($1)', [LODGING_KINDS])
      return { created, updated, archivedPlaceholders: archived, activeRooms: n }
    })
  })
}
