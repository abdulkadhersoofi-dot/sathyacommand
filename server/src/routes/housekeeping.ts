import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { rupees, splitGst } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { businessDate, folioBalance, LODGING } from '../fo-core'
import { placeAt } from '../geo'
import { addTask, CHECKLISTS, CREDITS, hkOf, setHk, type HkStatus, type TaskKind } from '../hk-core'
import { requireCaller } from './auth'

// Housekeeping: the room board, the day's tasks (assigned by section and workload), cleaning with
// checklist and photos, supervisor inspection, out-of-order rooms, do-not-disturb, sleeper / skipper
// checks, minibar charges and lost & found.

const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
const DATE = /^\d{4}-\d{2}-\d{2}$/
const PASS_SCORE = 80
const KINDS = Object.keys(CREDITS) as TaskKind[]

interface Task { id: string; space_id: string | null; area: string | null; business_date: string; kind: TaskKind; credits: string; status: string; assigned_to: string | null; started_at: string | null; checklist: { item: string; done: boolean }[] }

export function housekeepingRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }

  async function task(t: Db, id: string) {
    const [x] = await t.query<Task>('select id, space_id, area, business_date::text, kind, credits, status, assigned_to, started_at, checklist from hk_task where id = $1 for update', [id])
    if (!x) throw new HttpError(404, 'No such task.')
    return x
  }

  const mine = (who: Caller, x: Task) => x.assigned_to === who.userId || can(who, 'hk.manage') || can(who, 'hk.inspect')

  // ---------- the room board ----------
  app.get('/api/hk/rooms', async (req) => {
    await need(req, 'hk.view', 'hk.attend', 'hk.manage', 'hk.inspect', 'front_desk')
    const day = await businessDate(db)
    const rooms = await db.query<{ space_id: string; status: HkStatus; observed: string | null; observed_at: string | null; in_house: string | null; arriving: string | null }>(
      `select h.space_id, s.room_no, s.twin_id, s.kind, t.name as room_type, s.building, s.floor, h.section, h.status, h.dnd, h.dnd_since,
              h.ooo_reason, h.ooo_from::text, h.ooo_to::text, h.observed, h.observed_at,
              (select r.id from reservation r where r.space_id = s.id and r.status = 'in_house' limit 1) as in_house,
              (select g.name from reservation r join guest g on g.id = r.guest_id where r.space_id = s.id and r.status = 'in_house' limit 1) as guest,
              (select r.departure::text from reservation r where r.space_id = s.id and r.status = 'in_house' limit 1) as departure,
              (select r.id from reservation r where r.space_id = s.id and r.status = 'confirmed' and r.arrival = $1 limit 1) as arriving,
              (select json_build_object('id', k.id, 'kind', k.kind, 'status', k.status, 'attendant', u.name, 'startedAt', k.started_at, 'score', k.score)
                 from hk_task k left join app_user u on u.id = k.assigned_to
                where k.space_id = s.id and k.status <> 'cancelled' and (k.business_date = $1 or k.status in ('pending', 'in_progress', 'reclean'))
                order by k.business_date desc, k.created_at desc limit 1) as task
         from room_hk h join space s on s.id = h.space_id left join room_type t on t.id = s.room_type_id
        where s.active and s.kind = any($2) order by s.building nulls last, s.floor nulls last, s.room_no`, [day, LODGING])
    return {
      businessDate: day,
      rooms: rooms.map((r) => ({
        ...r,
        departing: !!r.in_house && (r as unknown as { departure: string }).departure <= day,
        // Housekeeping saw the room empty but reception has a guest in it (skipper), or the other way round (sleeper).
        discrepancy: r.observed && r.observed_at && new Date(r.observed_at).getTime() > now().getTime() - 18 * 3600_000
          ? (r.observed === 'vacant' && r.in_house ? 'skipper' : r.observed === 'occupied' && !r.in_house ? 'sleeper' : null) : null,
      })),
    }
  })

  // People who clean rooms (for assigning the day's work).
  app.get('/api/hk/staff', async (req) => {
    await need(req, 'hk.manage', 'hk.inspect')
    return db.query(
      `select distinct u.id, u.name, array_agg(distinct ur.role_id) as roles from app_user u join user_role ur on ur.user_id = u.id join role r on r.id = ur.role_id
        where u.active and 'hk.attend' = any(r.permissions) group by u.id order by u.name`)
  })

  // ---------- tasks ----------
  app.get('/api/hk/tasks', async (req) => {
    const who = await need(req, 'hk.attend', 'hk.manage', 'hk.inspect')
    const q = req.query as { date?: string; mine?: string }
    const day = q.date ?? await businessDate(db)
    const onlyMine = q.mine === 'true' || (!can(who, 'hk.manage') && !can(who, 'hk.inspect'))
    return db.query(
      `select k.id, k.space_id, s.room_no, s.twin_id, k.area, k.business_date::text, k.kind, k.credits, k.priority, k.status, k.assigned_to, u.name as attendant,
              k.started_at, k.finished_at, k.checklist, k.photos, k.notes, k.score, k.inspection_notes, h.section, h.dnd, h.status as room_status,
              (select g.name from reservation r join guest g on g.id = r.guest_id where r.space_id = k.space_id and r.status = 'in_house' limit 1) as guest
         from hk_task k left join space s on s.id = k.space_id left join room_hk h on h.space_id = k.space_id left join app_user u on u.id = k.assigned_to
        where k.status <> 'cancelled' and (k.business_date = $1 or (k.business_date < $1 and k.status in ('pending', 'in_progress', 'reclean')))
          and ($2::text is null or k.assigned_to = $2)
        order by case k.status when 'in_progress' then 0 when 'reclean' then 1 when 'pending' then 2 when 'cleaned' then 3 else 4 end, k.priority desc, h.section, s.room_no`,
      [day, onlyMine ? who.userId : null])
  })

  app.post('/api/hk/tasks', async (req, reply) => {
    const who = await need(req, 'hk.manage')
    const b = req.body as { spaceId?: string; area?: string; kind?: TaskKind; date?: string; assignedTo?: string }
    if (!KINDS.includes(b?.kind as TaskKind)) throw new HttpError(400, `kind: ${KINDS.join(', ')}.`)
    if (!b.spaceId && !b.area?.trim()) throw new HttpError(400, 'Choose a room or name the area.')
    return db.tx(async (t) => {
      const day = b.date ?? await businessDate(t)
      if (!DATE.test(day)) throw new HttpError(400, 'date as YYYY-MM-DD.')
      const id = newId('HT')
      try {
        await t.query(`insert into hk_task (id, space_id, area, business_date, kind, credits, checklist, assigned_to, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, b.spaceId ?? null, b.area?.trim() ?? null, day, b.kind, CREDITS[b.kind!], JSON.stringify(CHECKLISTS[b.kind!].map((item) => ({ item, done: false }))), b.assignedTo ?? null, now()])
      } catch { throw new HttpError(409, 'That room already has this task open for the day.') }
      await appendAudit(t, { actor: who, action: 'hk.task_add', entity: { type: 'hk_task', id }, after: b }, now())
      return reply.status(201).send({ id })
    })
  })

  // Shares the day's unassigned tasks among the attendants on duty: each section goes to one person
  // where possible, and nobody gets far more work (credits) than the others.
  app.post('/api/hk/assign', async (req) => {
    const who = await need(req, 'hk.manage')
    const b = req.body as { attendants?: string[]; date?: string; rebalance?: boolean }
    if (!Array.isArray(b?.attendants) || !b.attendants.length) throw new HttpError(400, 'Choose the attendants on duty.')
    return db.tx(async (t) => {
      const day = b.date ?? await businessDate(t)
      const valid = await t.query<{ id: string; name: string }>(`select u.id, u.name from app_user u where u.id = any($1) and u.active`, [b.attendants])
      if (valid.length !== b.attendants!.length) throw new HttpError(400, 'Some of those people are not active staff.')
      if (b.rebalance) await t.query(`update hk_task set assigned_to = null where business_date <= $1 and status in ('pending', 'reclean')`, [day])
      const open = await t.query<{ id: string; credits: string; section: string | null; assigned_to: string | null; status: string }>(
        `select k.id, k.credits, coalesce(h.section, k.area, '') as section, k.assigned_to, k.status from hk_task k left join room_hk h on h.space_id = k.space_id
          where k.business_date <= $1 and k.status in ('pending', 'reclean', 'in_progress') order by section, k.priority desc, k.id`, [day])
      const load = new Map(valid.map((v) => [v.id, 0]))
      for (const k of open) if (k.assigned_to && load.has(k.assigned_to)) load.set(k.assigned_to, load.get(k.assigned_to)! + Number(k.credits))
      const sectionOwner = new Map<string, string>()
      const target = (open.reduce((a, k) => a + Number(k.credits), 0) / valid.length) * 1.15
      let assigned = 0
      for (const k of open.filter((x) => !x.assigned_to)) {
        const owner = sectionOwner.get(k.section ?? '')
        const lightest = [...load.entries()].sort((a, b2) => a[1] - b2[1])[0][0]
        const pick = owner && load.get(owner)! + Number(k.credits) <= target ? owner : lightest
        await t.query('update hk_task set assigned_to = $2 where id = $1', [k.id, pick])
        load.set(pick, load.get(pick)! + Number(k.credits))
        sectionOwner.set(k.section ?? '', pick)
        assigned++
      }
      await appendAudit(t, { actor: who, action: 'hk.assign', entity: { type: 'hk_day', id: day }, after: { assigned, attendants: valid.map((v) => v.name) } }, now())
      return { assigned, workload: valid.map((v) => ({ userId: v.id, name: v.name, credits: load.get(v.id) })) }
    })
  })

  app.patch('/api/hk/tasks/:id', async (req) => {
    const who = await need(req, 'hk.manage')
    const b = req.body as { assignedTo?: string | null; status?: 'cancelled' }
    return db.tx(async (t) => {
      const x = await task(t, (req.params as { id: string }).id)
      if (b.assignedTo !== undefined) await t.query('update hk_task set assigned_to = $2 where id = $1', [x.id, b.assignedTo])
      if (b.status === 'cancelled') await t.query(`update hk_task set status = 'cancelled' where id = $1`, [x.id])
      await appendAudit(t, { actor: who, action: 'hk.task_update', entity: { type: 'hk_task', id: x.id }, after: b }, now())
      return { ok: true }
    })
  })

  app.post('/api/hk/tasks/:id/start', async (req) => {
    const who = await need(req, 'hk.attend', 'hk.manage')
    return db.tx(async (t) => {
      const x = await task(t, (req.params as { id: string }).id)
      if (!mine(who, x)) throw new HttpError(403, 'This room is assigned to someone else.')
      if (!['pending', 'reclean'].includes(x.status)) throw new HttpError(409, `Already ${x.status.replace('_', ' ')}.`)
      if (x.space_id) {
        const h = await hkOf(t, x.space_id)
        if (h?.dnd) throw new HttpError(409, `Room ${h.room_no} has Do Not Disturb on. Try again after 2 pm or call the guest.`)
      }
      await t.query(`update hk_task set status = 'in_progress', started_at = $2, assigned_to = coalesce(assigned_to, $3) where id = $1`, [x.id, now(), who.userId])
      await appendAudit(t, { actor: who, action: 'hk.clean_start', entity: { type: 'hk_task', id: x.id }, after: { room: x.space_id, kind: x.kind } }, now())
      if (x.space_id) await placeAt(t, who.userId, x.space_id, now())
      return { ok: true }
    })
  })

  app.post('/api/hk/tasks/:id/finish', async (req) => {
    const who = await need(req, 'hk.attend', 'hk.manage')
    const b = (req.body ?? {}) as { checklist?: { item: string; done: boolean }[]; photos?: string[]; notes?: string }
    return db.tx(async (t) => {
      const x = await task(t, (req.params as { id: string }).id)
      if (!mine(who, x)) throw new HttpError(403, 'This room is assigned to someone else.')
      if (x.status !== 'in_progress') throw new HttpError(409, 'Start the room first.')
      const checklist = Array.isArray(b.checklist) ? b.checklist : x.checklist
      const missed = checklist.filter((c) => !c.done)
      if (missed.length && !b.notes?.trim()) throw new HttpError(400, `Not ticked: ${missed.map((m) => m.item).join(', ')}. Tick them or add a note why.`)
      const photos = (b.photos ?? []).slice(0, 6)
      if (photos.length) {
        const [{ n }] = await t.query<{ n: number }>('select count(*)::int as n from upload where id = any($1)', [photos])
        if (n !== photos.length) throw new HttpError(400, 'A photo did not upload. Take it again.')
      }
      await t.query(`update hk_task set status = 'cleaned', finished_at = $2, checklist = $3, photos = $4, notes = $5 where id = $1`,
        [x.id, now(), JSON.stringify(checklist), photos, b.notes?.trim() || null])
      const minutes = x.started_at ? Math.round((now().getTime() - new Date(x.started_at).getTime()) / 60_000) : null
      if (x.space_id) {
        const h = await hkOf(t, x.space_id)
        if (h && h.status !== 'out_of_order') await setHk(t, x.space_id, h.status.startsWith('occupied') ? 'occupied_clean' : 'vacant_clean', who, now(), { minutes })
      }
      await appendAudit(t, { actor: who, action: 'hk.clean_finish', entity: { type: 'hk_task', id: x.id }, after: { room: x.space_id, minutes, photos: photos.length, missed: missed.length } }, now())
      return { ok: true, minutes }
    })
  })

  // The supervisor's check: a pass makes a vacant room ready to sell (reception sees it at once); a fail sends it back.
  app.post('/api/hk/tasks/:id/inspect', async (req) => {
    const who = await need(req, 'hk.inspect')
    const b = req.body as { score?: number; notes?: string }
    if (!(Number.isInteger(b?.score) && b.score! >= 0 && b.score! <= 100)) throw new HttpError(400, 'Score 0–100.')
    return db.tx(async (t) => {
      const x = await task(t, (req.params as { id: string }).id)
      if (x.status !== 'cleaned') throw new HttpError(409, 'Only cleaned rooms can be inspected.')
      if (x.assigned_to === who.userId && !who.permissions.has('*')) throw new HttpError(403, 'Someone else must inspect your own room.')
      const pass = b.score! >= PASS_SCORE
      if (!pass && !b.notes?.trim()) throw new HttpError(400, 'Say what needs re-cleaning.')
      await t.query(`update hk_task set status = $2, inspected_by = $3, inspected_at = $4, score = $5, inspection_notes = $6 where id = $1`,
        [x.id, pass ? 'inspected' : 'reclean', who.userId, now(), b.score, b.notes?.trim() || null])
      if (x.space_id) {
        const h = await hkOf(t, x.space_id)
        if (h && h.status !== 'out_of_order') {
          const occupied = h.status.startsWith('occupied')
          await setHk(t, x.space_id, pass ? (occupied ? 'occupied_clean' : 'inspected') : (occupied ? 'occupied_dirty' : 'vacant_dirty'), who, now(), { score: b.score })
        }
      }
      await appendAudit(t, { actor: who, action: pass ? 'hk.inspect_pass' : 'hk.inspect_fail', entity: { type: 'hk_task', id: x.id }, after: { room: x.space_id, score: b.score }, note: b.notes }, now())
      return { ok: true, pass }
    })
  })

  // ---------- room status ----------
  app.post('/api/hk/rooms/:id/status', async (req) => {
    const who = await need(req, 'hk.manage')
    const { id } = req.params as { id: string }
    const status = (req.body as { status?: HkStatus })?.status
    const allowed: HkStatus[] = ['vacant_clean', 'inspected', 'vacant_dirty', 'out_of_service', 'occupied_clean', 'occupied_dirty']
    if (!allowed.includes(status!)) throw new HttpError(400, `status: ${allowed.join(', ')} (use out-of-order for repairs).`)
    return db.tx(async (t) => {
      const h = await hkOf(t, id)
      if (!h) throw new HttpError(404, 'No such room.')
      const [res] = await t.query('select 1 from reservation where space_id = $1 and status = $2', [id, 'in_house'])
      if (!!res !== status!.startsWith('occupied')) throw new HttpError(409, res ? 'A guest is checked in to this room: use an occupied status.' : 'No guest is checked in: use a vacant status.')
      if (h.status === 'out_of_order') throw new HttpError(409, 'Return the room to service first.')
      await setHk(t, id, status!, who, now(), { manual: true })
      return { ok: true }
    })
  })

  app.post('/api/hk/rooms/:id/out-of-order', async (req) => {
    const who = await need(req, 'hk.manage')
    const { id } = req.params as { id: string }
    const b = req.body as { reason?: string; from?: string; to?: string }
    if (!b?.reason?.trim()) throw new HttpError(400, 'Give the reason (e.g. AC compressor replacement).')
    return db.tx(async (t) => {
      const h = await hkOf(t, id)
      if (!h) throw new HttpError(404, 'No such room.')
      const from = b.from ?? await businessDate(t)
      if (!DATE.test(from) || (b.to && (!DATE.test(b.to) || b.to < from))) throw new HttpError(400, 'Dates as YYYY-MM-DD, to on or after from.')
      const [inHouse] = await t.query('select 1 from reservation where space_id = $1 and status = $2', [id, 'in_house'])
      if (inHouse) throw new HttpError(409, `A guest is in room ${h.room_no}. Move them first.`)
      const booked = await t.query<{ night: string; reservation_id: string }>(
        `select night::text, reservation_id from room_night where space_id = $1 and not released and night >= $2 and ($3::date is null or night <= $3) order by night`, [id, from, b.to ?? null])
      if (booked.length) throw new HttpError(409, `Room ${h.room_no} is booked on ${booked.map((n) => n.night).join(', ')}. Move those bookings first.`, { bookings: [...new Set(booked.map((n) => n.reservation_id))] })
      await t.query('update room_hk set ooo_reason = $2, ooo_from = $3, ooo_to = $4 where space_id = $1', [id, b.reason!.trim(), from, b.to ?? null])
      await setHk(t, id, 'out_of_order', who, now(), { reason: b.reason, from, to: b.to ?? null })
      return { ok: true }
    })
  })

  app.post('/api/hk/rooms/:id/return-to-service', async (req) => {
    const who = await need(req, 'hk.manage')
    const { id } = req.params as { id: string }
    return db.tx(async (t) => {
      const h = await hkOf(t, id)
      if (h?.status !== 'out_of_order' && h?.status !== 'out_of_service') throw new HttpError(409, 'The room is in service.')
      await t.query('update room_hk set ooo_reason = null, ooo_from = null, ooo_to = null where space_id = $1', [id])
      await setHk(t, id, 'vacant_dirty', who, now(), { note: 'Returned to service' })
      await addTask(t, id, 'checkout', await businessDate(t), now(), 5)
      return { ok: true }
    })
  })

  app.post('/api/hk/rooms/:id/dnd', async (req) => {
    const who = await need(req, 'hk.attend', 'hk.manage', 'front_desk')
    const { id } = req.params as { id: string }
    const on = (req.body as { on?: boolean })?.on
    if (typeof on !== 'boolean') throw new HttpError(400, 'Send on: true or false.')
    return db.tx(async (t) => {
      const [r] = await t.query<{ room_no: string }>('update room_hk h set dnd = $2, dnd_since = case when $2 then $3::timestamptz else null end from space s where s.id = h.space_id and h.space_id = $1 returning s.room_no', [id, on, now()])
      if (!r) throw new HttpError(404, 'No such room.')
      await appendAudit(t, { actor: who, action: on ? 'hk.dnd_on' : 'hk.dnd_off', entity: { type: 'room', id }, after: { roomNo: r.room_no } }, now())
      return { ok: true }
    })
  })

  // What housekeeping actually found in the room, checked against reception (sleeper / skipper).
  app.post('/api/hk/rooms/:id/observed', async (req) => {
    const who = await need(req, 'hk.attend', 'hk.manage')
    const { id } = req.params as { id: string }
    const seen = (req.body as { occupancy?: string })?.occupancy
    if (seen !== 'vacant' && seen !== 'occupied') throw new HttpError(400, 'occupancy: vacant or occupied.')
    return db.tx(async (t) => {
      const h = await hkOf(t, id)
      if (!h) throw new HttpError(404, 'No such room.')
      await t.query('update room_hk set observed = $2, observed_at = $3 where space_id = $1', [id, seen, now()])
      const [inHouse] = await t.query<{ id: string }>('select id from reservation where space_id = $1 and status = $2', [id, 'in_house'])
      const kind = seen === 'vacant' && inHouse ? 'skipper' : seen === 'occupied' && !inHouse ? 'sleeper' : null
      if (kind) await appendAudit(t, { actor: who, action: 'hk.discrepancy', entity: { type: 'room', id }, after: { roomNo: h.room_no, kind, reservation: inHouse?.id ?? null } }, now())
      return { ok: true, discrepancy: kind }
    })
  })

  // ---------- minibar ----------
  app.get('/api/hk/minibar-items', async (req) => {
    await requireCaller(ctx, req)
    return db.query('select id, name, price_paise, gst_rate, active from minibar_item order by active desc, name')
  })

  app.post('/api/hk/minibar-items', async (req, reply) => {
    const who = await need(req, 'hk.manage', 'menu.price')
    const b = req.body as { name?: string; price?: number; gstRate?: number }
    if (!b?.name?.trim() || !(b.price! >= 0)) throw new HttpError(400, 'Name and price (₹) are required.')
    if (b.gstRate !== undefined && ![0, 5, 12, 18, 28, 40].includes(b.gstRate)) throw new HttpError(400, 'GST rate: 0, 5, 12, 18, 28 or 40%.')
    const id = newId('MB')
    await db.tx(async (t) => {
      await t.query('insert into minibar_item (id, name, price_paise, gst_rate) values ($1,$2,$3,$4)', [id, b.name!.trim(), rupees(b.price!), b.gstRate ?? 18])
      await appendAudit(t, { actor: who, action: 'minibar_item.add', entity: { type: 'minibar_item', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/hk/minibar-items/:id', async (req) => {
    const who = await need(req, 'hk.manage', 'menu.price')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; price?: number; gstRate?: number; active?: boolean }
    return db.tx(async (t) => {
      const [before] = await t.query('select * from minibar_item where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such item.')
      await t.query('update minibar_item set name = coalesce($2, name), price_paise = coalesce($3, price_paise), gst_rate = coalesce($4, gst_rate), active = coalesce($5, active) where id = $1',
        [id, b.name?.trim() ?? null, b.price !== undefined ? rupees(b.price) : null, b.gstRate ?? null, b.active ?? null])
      const [after] = await t.query('select * from minibar_item where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'minibar_item.update', entity: { type: 'minibar_item', id }, before, after }, now())
      return after
    })
  })

  // What the attendant found used goes straight onto the guest's bill.
  app.post('/api/hk/rooms/:id/minibar', async (req) => {
    const who = await need(req, 'hk.attend', 'hk.manage', 'front_desk')
    const { id } = req.params as { id: string }
    const b = req.body as { items?: { itemId: string; qty: number }[] }
    if (!Array.isArray(b?.items) || !b.items.length) throw new HttpError(400, 'Add the items used.')
    return db.tx(async (t) => {
      const [r] = await t.query<{ id: string; folio_id: string; room_no: string }>(
        `select r.id, s.room_no, (select f.id from folio f where f.reservation_id = r.id and f.status = 'open' order by f.created_at limit 1) as folio_id
           from reservation r join space s on s.id = r.space_id where r.space_id = $1 and r.status = 'in_house'`, [id])
      if (!r?.folio_id) throw new HttpError(409, 'No guest is checked in to this room.')
      const day = await businessDate(t)
      let total = 0
      for (const l of b.items!) {
        if (!(Number.isInteger(l.qty) && l.qty >= 1 && l.qty <= 50)) throw new HttpError(400, 'Quantity 1–50.')
        const [m] = await t.query<{ name: string; price_paise: number; gst_rate: string }>('select name, price_paise, gst_rate from minibar_item where id = $1 and active', [l.itemId])
        if (!m) throw new HttpError(400, `No minibar item ${l.itemId}.`)
        const g = splitGst(Number(m.price_paise) * l.qty, Number(m.gst_rate))
        await t.query(
          `insert into folio_line (id, folio_id, business_date, posted_at, kind, description, sac, gst_rate, taxable_paise, cgst_paise, sgst_paise, amount_paise, posted_by, ref)
           values ($1,$2,$3,$4,'misc',$5,$6,$7,$8,$9,$10,$11,$12,'minibar')`,
          [newId('L'), r.folio_id, day, now(), `Minibar · ${l.qty} × ${m.name}`, ctx.tax.gst.other_services?.minibar?.sac ?? null, Number(m.gst_rate), g.taxable, g.cgst, g.sgst, g.total, who.userId])
        total += g.total
      }
      await appendAudit(t, { actor: who, action: 'minibar.post', entity: { type: 'reservation', id: r.id }, amount: total, after: { room: r.room_no, items: b.items } }, now())
      return { ok: true, total, balance: await folioBalance(t, r.folio_id) }
    })
  })

  // ---------- lost & found ----------
  app.get('/api/hk/lost-found', async (req) => {
    await need(req, 'hk.view', 'hk.attend', 'hk.manage', 'front_desk')
    const status = (req.query as { status?: string }).status ?? 'held'
    return db.query(
      `select l.id, l.description, l.place, s.room_no, l.photo_id, l.status, u.name as found_by, l.found_at, l.handed_to, l.handed_note, l.closed_at,
              g.name as guest, g.mobile as guest_mobile
         from lost_found l join app_user u on u.id = l.found_by left join space s on s.id = l.space_id
         left join reservation r on r.id = l.reservation_id left join guest g on g.id = r.guest_id
        where ($1 = 'all' or l.status = $1) order by l.found_at desc limit 200`, [status])
  })

  app.post('/api/hk/lost-found', async (req, reply) => {
    const who = await need(req, 'hk.attend', 'hk.manage', 'front_desk', 'fnb.order')
    const b = req.body as { description?: string; spaceId?: string; place?: string; photoId?: string }
    if (!b?.description?.trim() || b.description.length > 200) throw new HttpError(400, 'Describe the item (up to 200 characters).')
    if (!b.spaceId && !b.place?.trim()) throw new HttpError(400, 'Say where it was found.')
    return db.tx(async (t) => {
      // Found in a room: link the guest who stayed there last, so reception can call them.
      const [last] = b.spaceId ? await t.query<{ id: string }>(
        `select id from reservation where space_id = $1 and status in ('in_house', 'checked_out') order by (status = 'in_house') desc, checked_out_at desc nulls last, checked_in_at desc limit 1`, [b.spaceId]) : []
      const id = newId('LF')
      await t.query('insert into lost_found (id, description, space_id, place, photo_id, reservation_id, found_by, found_at) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, b.description!.trim(), b.spaceId ?? null, b.place?.trim() ?? null, b.photoId ?? null, last?.id ?? null, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'lost_found.log', entity: { type: 'lost_found', id }, after: { description: b.description, room: b.spaceId ?? null, place: b.place ?? null } }, now())
      return reply.status(201).send({ id, reservationId: last?.id ?? null })
    })
  })

  app.post('/api/hk/lost-found/:id/close', async (req) => {
    const who = await need(req, 'hk.manage', 'front_desk')
    const { id } = req.params as { id: string }
    const b = req.body as { outcome?: 'returned' | 'disposed'; handedTo?: string; note?: string }
    if (b?.outcome !== 'returned' && b?.outcome !== 'disposed') throw new HttpError(400, 'outcome: returned or disposed.')
    if (b.outcome === 'returned' && !b.handedTo?.trim()) throw new HttpError(400, 'Who collected it? (name and ID seen)')
    if (b.outcome === 'disposed' && !can(who, 'hk.manage')) throw new HttpError(403, 'Only the executive housekeeper or a manager can dispose of items.')
    return db.tx(async (t) => {
      const [l] = await t.query<{ status: string; description: string }>('select status, description from lost_found where id = $1 for update', [id])
      if (!l) throw new HttpError(404, 'No such item.')
      if (l.status !== 'held') throw new HttpError(409, `Already ${l.status}.`)
      await t.query('update lost_found set status = $2, handed_to = $3, handed_note = $4, closed_by = $5, closed_at = $6 where id = $1', [id, b.outcome, b.handedTo?.trim() ?? null, b.note?.trim() ?? null, who.userId, now()])
      await appendAudit(t, { actor: who, action: `lost_found.${b.outcome}`, entity: { type: 'lost_found', id }, after: { description: l.description, handedTo: b.handedTo ?? null }, note: b.note }, now())
      return { ok: true }
    })
  })
}
