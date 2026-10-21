import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { addTicket, newId } from '../eng-core'
import { businessDate, LODGING } from '../fo-core'
import { tokenOk } from '../channels'
import { chargeRoom, ONLINE, planMessages, roomLink, roomToken, stayIn } from '../guest'
import { requireCaller } from './auth'

// The guest journey. For guests (no login): each room's QR page (requests, room service, things to do,
// feedback) and the feedback page after the stay. For staff: requests from rooms, messages to guests,
// feedback with replies, activities and their bookings, and the QR cards for every room.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const str = (v: unknown, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null }
const n = (v: unknown) => Number(v ?? 0)
const REQ_KINDS = ['housekeeping', 'food', 'maintenance', 'other']
const HK_ITEMS = ['Clean the room', 'Fresh towels', 'Extra pillow', 'Extra blanket', 'Toiletries', 'Drinking water', 'Turn-down service', 'Iron and board']

const tries = new Map<string, { n: number; reset: number }>()
function limit(req: FastifyRequest, key: string, max: number, nowMs: number) {
  const k = `${key}:${req.ip}`, t = tries.get(k)
  if (!t || t.reset < nowMs) { tries.set(k, { n: 1, reset: nowMs + 3_600_000 }); return }
  if (++t.n > max) throw new HttpError(429, 'Too many requests from here. Please call the front desk.')
}

export function guestRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id

  /** A room's QR page is opened only with the room's signed link (printed on its card). */
  async function room(req: FastifyRequest) {
    const { id } = req.params as { id: string }
    const t = String((req.query as { t?: string }).t ?? '')
    const want = Buffer.from(await roomToken(db, id)), got = Buffer.from(t)
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new HttpError(404, 'This QR code is not valid. Please call the front desk.')
    const [s] = await db.query<{ id: string; room_no: string; name: string }>('select id, room_no, name from space where id = $1 and active', [id])
    if (!s) throw new HttpError(404, 'This QR code is not valid. Please call the front desk.')
    return s
  }

  // ---------- the room's QR page ----------
  app.get('/public/room/:id', async (req) => {
    const s = await room(req)
    const stay = await stayIn(db, s.id)
    const [p] = await db.query<{ name: string }>('select name from property limit 1')
    const menu = await db.query<{ id: string; name: string; price_paise: string; diet: string; category: string | null }>(
      `select m.id, m.name, m.price_paise, m.diet, c.name as category from menu_item m join outlet o on o.id = m.outlet_id left join menu_category c on c.id = m.category_id
        where o.kind = 'room_service' and o.active and m.active and m.available and m.liquor_class is null order by c.sort, m.name`)
    const activities = await db.query<{ id: string; name: string; price_paise: string; per: string; opens: string | null; closes: string | null; notes: string | null }>(
      'select id, name, price_paise, per, opens, closes, notes from activity where active order by name')
    const open = stay ? await db.query('select id, kind, items, note, status, created_at from guest_request where reservation_id = $1 and status in ($2, $3) order by created_at', [stay.id, 'new', 'accepted']) : []
    return { resort: p.name, room: s.room_no ?? s.name, guest: stay ? stay.guest.split(' ')[0] : null, departure: stay?.departure ?? null, occupied: !!stay,
      housekeeping: HK_ITEMS, menu: menu.map((m) => ({ ...m, price_paise: n(m.price_paise) })), activities: activities.map((a) => ({ ...a, price_paise: n(a.price_paise) })), open }
  })

  app.post('/public/room/:id/requests', async (req, reply) => {
    const s = await room(req)
    limit(req, `room:${s.id}`, 30, now().getTime())
    const b = (req.body ?? {}) as { kind?: string; items?: { id?: string; name?: string; qty?: number }[]; note?: string }
    if (!REQ_KINDS.includes(b.kind ?? '')) throw new HttpError(400, `What is it for? (${REQ_KINDS.join(', ')})`)
    return db.tx(async (t) => {
      const stay = await stayIn(t, s.id)
      // Only the guests staying in the room can ask from it.
      if (!stay) throw new HttpError(409, 'This room has no guest checked in. Please call the front desk.')
      let items: { name: string; qty: number; price_paise?: number }[] = []
      if (b.kind === 'food') {
        for (const i of b.items ?? []) {
          const [m] = await t.query<{ name: string; price_paise: string }>(`select m.name, m.price_paise from menu_item m join outlet o on o.id = m.outlet_id where m.id = $1 and o.kind = 'room_service' and m.active and m.available`, [i.id])
          if (!m) throw new HttpError(400, 'An item is no longer available.')
          const qty = Math.round(n(i.qty))
          if (!(qty > 0 && qty <= 20)) throw new HttpError(400, 'Quantity: 1 to 20.')
          items.push({ name: m.name, qty, price_paise: n(m.price_paise) })
        }
        if (!items.length) throw new HttpError(400, 'Choose what you would like.')
      } else {
        items = (b.items ?? []).map((i) => ({ name: String(i.name ?? '').slice(0, 60), qty: Math.max(1, Math.min(10, Math.round(n(i.qty) || 1))) })).filter((i) => i.name)
        if (b.kind === 'housekeeping' && items.some((i) => !HK_ITEMS.includes(i.name))) throw new HttpError(400, 'Choose from the list, or write a note.')
        if (!items.length && !str(b.note)) throw new HttpError(400, 'Tell us what you need.')
      }
      const id = newId('GR')
      // A fault goes straight to engineering as a ticket on the room.
      const ticket = b.kind === 'maintenance' ? await addTicket(t, { kind: 'fault', title: `Room ${s.room_no}: ${str(b.note, 120) ?? 'guest reported a problem'}`, detail: 'Reported by the guest from the room QR', priority: 'high', spaceId: s.id }, ONLINE, now()) : null
      await t.query('insert into guest_request (id, space_id, reservation_id, kind, items, note, ticket_id, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, s.id, stay.id, b.kind, JSON.stringify(items), str(b.note, 500), ticket, now()])
      await appendAudit(t, { actor: ONLINE, action: 'guest.request', entity: { type: 'guest_request', id }, after: { room: s.room_no, kind: b.kind, items: items.length } }, now())
      return reply.status(201).send({ id })
    })
  })

  // ---------- feedback ----------
  async function saveFeedback(t: Db, reservationId: string | null, spaceId: string | null, b: Record<string, unknown>) {
    const score = (k: string, required = false) => {
      const v = b[k]
      if (v == null || v === '') { if (required) throw new HttpError(400, 'How was your stay overall? (1 to 5)'); return null }
      const x = Number(v)
      if (!(Number.isInteger(x) && x >= 1 && x <= 5)) throw new HttpError(400, 'Scores are 1 to 5.')
      return x
    }
    const overall = score('overall', true)!
    const id = newId('FB')
    const ins = await t.query(`insert into guest_feedback (id, reservation_id, space_id, overall, room, food, service, cleanliness, comment, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (reservation_id) do nothing returning id`, [id, reservationId, spaceId, overall, score('room'), score('food'), score('service'), score('cleanliness'), str(b.comment, 2000), now()])
    if (!ins.length) throw new HttpError(409, 'Thank you: we already have your feedback.')
    // A poor score reaches the managers and God Mode at once, before it reaches Google.
    await appendAudit(t, { actor: ONLINE, action: overall <= 2 ? 'guest.feedback_low' : 'guest.feedback', entity: { type: 'guest_feedback', id }, after: { overall }, note: str(b.comment, 120) ?? undefined }, now())
    return { ok: true, review: overall >= 4 && process.env.GOOGLE_REVIEW_URL ? process.env.GOOGLE_REVIEW_URL : null }
  }

  app.post('/public/bookings/:id/feedback', async (req) => {
    const { id } = req.params as { id: string }
    if (!(await tokenOk(db, id, String((req.query as { t?: string }).t ?? '')))) throw new HttpError(404, 'This link is not valid.')
    limit(req, 'feedback', 10, now().getTime())
    return db.tx(async (t) => {
      const [r] = await t.query<{ status: string; space_id: string | null }>('select status, space_id from reservation where id = $1', [id])
      if (!['in_house', 'checked_out'].includes(r?.status ?? '')) throw new HttpError(409, 'Feedback opens once you have stayed with us.')
      return saveFeedback(t, id, r.space_id, (req.body ?? {}) as Record<string, unknown>)
    })
  })

  app.post('/public/room/:id/feedback', async (req) => {
    const s = await room(req)
    limit(req, 'feedback', 10, now().getTime())
    return db.tx(async (t) => {
      const stay = await stayIn(t, s.id)
      if (!stay) throw new HttpError(409, 'This room has no guest checked in.')
      return saveFeedback(t, stay.id, s.id, (req.body ?? {}) as Record<string, unknown>)
    })
  })

  // ---------- staff: requests from rooms ----------
  app.get('/api/guest/requests', async (req) => {
    await need(req, 'guest.requests', 'front_desk')
    const all = (req.query as { all?: string }).all === '1'
    const rows = await db.query(
      `select q.id, q.kind, q.items, q.note, q.status, q.created_at, q.handled_at, q.done_at, q.ticket_id, s.room_no, g.name as guest, u.name as handled_by
         from guest_request q join space s on s.id = q.space_id left join reservation r on r.id = q.reservation_id left join guest g on g.id = r.guest_id left join app_user u on u.id = q.handled_by
        where ($1 or q.status in ('new','accepted') or q.created_at > $2) order by q.status = 'new' desc, q.created_at desc limit 200`, [all, new Date(now().getTime() - 12 * 3_600_000)])
    return rows
  })

  app.post('/api/guest/requests/:id/:step', async (req) => {
    const who = await need(req, 'guest.requests', 'front_desk')
    const { step } = req.params as { step: string }
    if (!['accept', 'done', 'cancel'].includes(step)) throw new HttpError(404, 'accept, done or cancel.')
    return db.tx(async (t) => {
      const [q] = await t.query<{ status: string; kind: string }>('select status, kind from guest_request where id = $1 for update', [idOf(req)])
      if (!q) throw new HttpError(404, 'No such request.')
      if (['done', 'cancelled'].includes(q.status)) throw new HttpError(409, `Already ${q.status}.`)
      if (step === 'accept') await t.query(`update guest_request set status = 'accepted', handled_by = $2, handled_at = $3 where id = $1`, [idOf(req), who.userId, now()])
      else await t.query(`update guest_request set status = $2, handled_by = coalesce(handled_by, $3), handled_at = coalesce(handled_at, $4), done_at = $4 where id = $1`, [idOf(req), step === 'done' ? 'done' : 'cancelled', who.userId, now()])
      await appendAudit(t, { actor: who, action: `guest.request_${step}`, entity: { type: 'guest_request', id: idOf(req) } }, now())
      return { ok: true }
    })
  })

  // ---------- staff: messages to guests ----------
  app.get('/api/guest/messages', async (req) => {
    await need(req, 'front_desk', 'guest.requests')
    await planMessages(db, now())
    const rows = await db.query(
      `select m.id, m.template, m.body, m.mobile, m.status, m.due_at, m.sent_at, m.error, m.reservation_id, g.name as guest, u.name as sent_by
         from guest_message m left join reservation r on r.id = m.reservation_id left join guest g on g.id = r.guest_id left join app_user u on u.id = m.sent_by
        where m.status in ('queued','failed') or m.created_at > $1 order by m.status = 'queued' desc, m.due_at desc limit 200`, [new Date(now().getTime() - 3 * 86_400_000)])
    return { provider: ctx.whatsapp?.name ?? null, messages: rows }
  })

  /** Sent by hand from the desk's WhatsApp (or not to be sent). */
  app.post('/api/guest/messages/:id/:step', async (req) => {
    const who = await need(req, 'front_desk', 'guest.requests')
    const { step } = req.params as { step: string }
    if (!['sent', 'skip'].includes(step)) throw new HttpError(404, 'sent or skip.')
    const r = await db.query(`update guest_message set status = $2, sent_at = $3, sent_by = $4 where id = $1 and status in ('queued','failed') returning id`,
      [idOf(req), step === 'sent' ? 'sent' : 'skipped', now(), who.userId])
    if (!r.length) throw new HttpError(409, 'Already sent or skipped.')
    return { ok: true }
  })

  // ---------- staff: feedback ----------
  app.get('/api/guest/feedback', async (req) => {
    await need(req, 'feedback.manage', 'front_desk')
    const rows = await db.query<{ overall: number }>(
      `select f.id, f.overall, f.room, f.food, f.service, f.cleanliness, f.comment, f.created_at, f.reply, f.replied_at, u.name as replied_by, g.name as guest, s.room_no, f.reservation_id
         from guest_feedback f left join reservation r on r.id = f.reservation_id left join guest g on g.id = r.guest_id left join space s on s.id = f.space_id left join app_user u on u.id = f.replied_by
        order by f.reply is null and f.overall <= 2 desc, f.created_at desc limit 300`)
    const avg = (k: string) => { const xs = rows.map((r) => (r as unknown as Record<string, number | null>)[k]).filter((x): x is number => x != null); return xs.length ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 10) / 10 : null }
    return { feedback: rows, averages: { overall: avg('overall'), room: avg('room'), food: avg('food'), service: avg('service'), cleanliness: avg('cleanliness') }, count: rows.length, low: rows.filter((r) => r.overall <= 2).length }
  })

  app.post('/api/guest/feedback/:id/reply', async (req) => {
    const who = await need(req, 'feedback.manage')
    const reply = str(((req.body ?? {}) as { reply?: string }).reply, 2000)
    if (!reply) throw new HttpError(400, 'Write the reply.')
    const r = await db.query('update guest_feedback set reply = $2, replied_by = $3, replied_at = $4 where id = $1 returning id', [idOf(req), reply, who.userId, now()])
    if (!r.length) throw new HttpError(404, 'No such feedback.')
    await appendAudit(db, { actor: who, action: 'guest.feedback_reply', entity: { type: 'guest_feedback', id: idOf(req) } }, now())
    return { ok: true }
  })

  // ---------- staff: activities ----------
  app.get('/api/guest/activities', async (req) => {
    await need(req, 'front_desk', 'activities.manage')
    const q = req.query as { day?: string }
    const day = DATE.test(q.day ?? '') ? q.day! : await businessDate(db)
    const acts = (await db.query<{ price_paise: string }>('select a.*, s.name as place_name from activity a left join space s on s.id = a.place order by a.active desc, a.name')).map((a) => ({ ...a, price_paise: n(a.price_paise) }))
    const bookings = (await db.query<{ amount_paise: string }>(
      `select b.id, b.activity_id, a.name as activity, b.guest_name, b.day::text, b.at, b.qty, b.amount_paise, b.status, b.reservation_id, s.room_no, b.folio_line_id is not null as on_bill
         from activity_booking b join activity a on a.id = b.activity_id left join reservation r on r.id = b.reservation_id left join space s on s.id = r.space_id
        where b.day = $1 order by b.at, a.name`, [day])).map((b) => ({ ...b, amount_paise: n(b.amount_paise) }))
    const inHouse = await db.query(`select r.id, g.name as guest, s.room_no from reservation r join guest g on g.id = r.guest_id left join space s on s.id = r.space_id where r.status = 'in_house' order by s.room_no`)
    return { day, activities: acts, bookings, inHouse }
  })

  app.post('/api/guest/activities', async (req, reply) => {
    const who = await need(req, 'activities.manage')
    const b = (req.body ?? {}) as { id?: string; name?: string; place?: string; price?: number; per?: string; capacity?: number; opens?: string; closes?: string; notes?: string; active?: boolean }
    const name = str(b.name, 80)
    if (!name) throw new HttpError(400, 'Name the activity.')
    if (!['person', 'hour', 'session'].includes(b.per ?? '')) throw new HttpError(400, 'Priced per person, hour or session.')
    if (!(n(b.price) >= 0)) throw new HttpError(400, 'Price: ₹0 or more.')
    if ((b.opens && !TIME.test(b.opens)) || (b.closes && !TIME.test(b.closes))) throw new HttpError(400, 'Times as HH:MM.')
    const id = b.id ?? newId('ACT')
    await db.tx(async (t) => {
      await t.query(`insert into activity (id, name, place, price_paise, per, capacity, opens, closes, notes, active, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        on conflict (id) do update set name = excluded.name, place = excluded.place, price_paise = excluded.price_paise, per = excluded.per, capacity = excluded.capacity, opens = excluded.opens, closes = excluded.closes, notes = excluded.notes, active = excluded.active`,
        [id, name, b.place || null, rupees(n(b.price)), b.per, b.capacity || null, b.opens || null, b.closes || null, str(b.notes, 300), b.active ?? true, now()])
      await appendAudit(t, { actor: who, action: 'activity.save', entity: { type: 'activity', id }, amount: rupees(n(b.price)), note: name }, now())
    })
    return reply.status(201).send({ id })
  })

  /** Books an activity: on the guest's bill (with GST) when they are staying, else paid on the spot. */
  app.post('/api/guest/activities/:id/book', async (req, reply) => {
    const who = await need(req, 'front_desk', 'activities.manage')
    const b = (req.body ?? {}) as { reservationId?: string; guestName?: string; day?: string; at?: string; qty?: number }
    const qty = Math.round(n(b.qty ?? 1))
    if (!(qty > 0 && qty <= 50)) throw new HttpError(400, 'How many: 1 to 50.')
    if (!TIME.test(b.at ?? '')) throw new HttpError(400, 'Enter the time, as HH:MM.')
    return db.tx(async (t) => {
      const [a] = await t.query<{ name: string; price_paise: string; capacity: number | null; opens: string | null; closes: string | null; active: boolean; per: string }>('select * from activity where id = $1', [idOf(req)])
      if (!a?.active) throw new HttpError(404, 'No such activity.')
      const day = DATE.test(b.day ?? '') ? b.day! : await businessDate(t)
      if ((a.opens && b.at! < a.opens) || (a.closes && b.at! >= a.closes)) throw new HttpError(400, `${a.name} is open ${a.opens} to ${a.closes}.`)
      if (a.capacity) {
        const [{ used }] = await t.query<{ used: string | null }>(`select sum(qty) as used from activity_booking where activity_id = $1 and day = $2 and at = $3 and status = 'booked'`, [idOf(req), day, b.at])
        if (n(used) + (a.per === 'hour' ? 1 : qty) > a.capacity) throw new HttpError(409, `${a.name} is full at ${b.at}.`)
      }
      let guest = str(b.guestName, 120)
      if (b.reservationId) {
        const [r] = await t.query<{ status: string; guest: string }>('select r.status, g.name as guest from reservation r join guest g on g.id = r.guest_id where r.id = $1', [b.reservationId])
        if (r?.status !== 'in_house') throw new HttpError(409, 'Only a guest staying now can charge it to the room.')
        guest = r.guest
      }
      if (!guest) throw new HttpError(400, 'Enter the guest\'s name, or their room.')
      const amount = n(a.price_paise) * qty
      const rate = Number(ctx.tax.gst.other_services?.activities_and_sports?.rate ?? 18)
      const id = newId('AB')
      const charge = b.reservationId && amount > 0 ? await chargeRoom(ctx, t, who, b.reservationId, `${a.name}, ${qty} ${a.per}${qty > 1 ? 's' : ''} on ${day} at ${b.at}`, amount, rate) : null
      await t.query('insert into activity_booking (id, activity_id, reservation_id, guest_name, day, at, qty, amount_paise, folio_line_id, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [id, idOf(req), b.reservationId ?? null, guest, day, b.at, qty, amount, charge?.lineId ?? null, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'activity.book', entity: { type: 'activity_booking', id }, amount, after: { activity: a.name, qty, onBill: !!charge } }, now())
      return reply.status(201).send({ id, amountPaise: amount, chargedPaise: charge?.total ?? 0 })
    })
  })

  // ---------- staff: the QR card for every room ----------
  app.get('/api/guest/room-qr', async (req) => {
    await need(req, 'guest.requests', 'front_desk', 'activities.manage')
    const rooms = await db.query<{ id: string; room_no: string; building: string | null }>(`select id, room_no, building from space where kind = any($1) and active order by building, room_no`, [LODGING])
    const out = []
    for (const r of rooms) out.push({ ...r, url: await roomLink(db, r.id) })
    return out
  })
}
