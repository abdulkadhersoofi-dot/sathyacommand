import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { cashReceiptCheck, rupees, splitGst } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import {
  applyDiscount, businessDate, folioBalance, freeByNight, LODGING, nightsOf, PROPERTY, rateFor, reservationBalance,
  describeOpenItems, openStayItems,
} from '../fo-core'
import { createApproval } from './approvals'
import { issueReceiptVoucher, issueRefundVoucher, issueStayInvoice } from '../invoicing'
import { validateGstin } from '@sathya/tax'
import { checkCredit, debtorFor, OTAS, otaDebtorFor, SOURCES } from '../receivables'
import { requireCaller } from './auth'
import { closesAt, istOf, postNight } from './nightaudit'
import { onCheckIn, onCheckOut, onRoomMove } from '../hk-core'
import { blockPickup, contractRate, sweepBlocks } from '../sales'

// Reservations, room assignment, check-in / check-out, guest bills (folios) and payments.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
const RESERVATION_LOCK = 7_301_002

async function frontDesk(ctx: Ctx, req: FastifyRequest) {
  const who = await requireCaller(ctx, req)
  if (!can(who, 'front_desk')) throw new HttpError(403, 'This needs front desk access.')
  return who
}

async function discountLimit(db: Db, who: Caller) {
  if (who.permissions.has('*')) return 100
  const rows = await db.query<{ limits: Record<string, unknown> }>('select limits from role where id = any($1)', [who.roles])
  return Math.max(0, ...rows.map((r) => Number(r.limits?.discount_percent ?? 0)))
}

async function loadReservation(db: Db, id: string, lock = false) {
  const [r] = await db.query<{
    id: string; status: string; guest_id: string; room_type_id: string; space_id: string | null; arrival: string; departure: string
    rate_plan_code: string; adults: number; children: number; bill_to_company: string | null; bill_to_gstin: string | null
  }>(`select id, status, guest_id, room_type_id, space_id, arrival::text, departure::text, rate_plan_code, adults, children,
             bill_to_company, bill_to_gstin from reservation where id = $1 ${lock ? 'for update' : ''}`, [id])
  if (!r) throw new HttpError(404, 'No such reservation.')
  return r
}

async function assignRoom(db: Db, reservationId: string, spaceId: string, roomTypeId: string, allowUpgrade: boolean) {
  const [s] = await db.query<{ room_type_id: string; active: boolean; kind: string; room_no: string }>(
    'select room_type_id, active, kind, room_no from space where id = $1', [spaceId])
  if (!s || !LODGING.includes(s.kind)) throw new HttpError(404, `No room ${spaceId}.`)
  if (!s.active) throw new HttpError(409, `Room ${s.room_no} is archived.`)
  if (s.room_type_id !== roomTypeId && !allowUpgrade) throw new HttpError(409, `Room ${s.room_no} is a different room type. Send upgrade: true to move the guest anyway.`)
  const [hk] = await db.query<{ status: string }>('select status from room_hk where space_id = $1', [spaceId])
  if (hk?.status === 'out_of_order') throw new HttpError(409, `Room ${s.room_no} is out of order.`)
  try {
    await db.query('update room_night set space_id = $2 where reservation_id = $1 and not released', [reservationId, spaceId])
  } catch (e) {
    if (String((e as Error).message).includes('room_night_one_per_room')) throw new HttpError(409, `Room ${s.room_no} is already booked on some of these nights.`)
    throw e
  }
  await db.query('update reservation set space_id = $2 where id = $1', [reservationId, spaceId])
  return s.room_no
}

const showDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const PLAN_NAMES: Record<string, string> = { EP: 'room only (EP)', CP: 'with breakfast (CP)', MAP: 'breakfast and one meal (MAP)', AP: 'all meals (AP)' }
/** Why a stay cannot be priced, in words the desk can act on. */
export async function noRateMessage(t: Db, plan: string, roomTypeId: string, night: string) {
  const [rt] = await t.query<{ name: string }>('select name from room_type where id = $1', [roomTypeId])
  const [last] = await t.query<{ to: string | null }>(`select max(r.valid_to)::text as to from rate r join rate_plan p on p.id = r.rate_plan_id where p.code = $1 and r.room_type_id = $2`, [plan, roomTypeId])
  const what = `${rt?.name ?? roomTypeId} ${PLAN_NAMES[plan] ?? plan}`
  return last?.to && last.to < night
    ? `Rates for ${what} are set only up to ${showDay(last.to)}. The MD or GM adds the next season in Settings → Rooms & rates.`
    : `There is no rate for ${what} on ${showDay(night)}. Choose another meal plan, or the MD or GM sets it in Settings → Rooms & rates.`
}

export interface BookingInput {
  guest?: { name?: string; mobile?: string; email?: string; nationality?: string; company?: string; gstin?: string }
  roomTypeId?: string; plan?: string; arrival?: string; departure?: string; adults?: number; children?: number
  source?: string; otaRef?: string; eta?: string; billToCompany?: string; billToGstin?: string; requests?: string
  billToAddress?: string; billToCity?: string; billToPin?: string
  /** A company account: its contracted rate applies, and the bill goes to it (Phase 7). */
  debtorId?: string
  /** A room block (a wedding or a group): one of its rooms, at the block's rate (Phase 7). */
  blockId?: string
  /** The price of each night as an OTA sold it, from the channel manager (Phase 7). */
  nightAmounts?: number[]
}

/**
 * Books a stay: checks the dates, the room type and the rooms free each night (rooms held in other blocks
 * count as taken), prices every night (the block's rate, else the company's contracted rate, else the rate
 * table), and opens the guest's bill.
 */
export async function bookStay(ctx: Ctx, t: Db, who: Caller, b: BookingInput) {
  const now = () => ctx.now()
  if (!b?.guest?.name?.trim()) throw new HttpError(400, 'Give the guest\'s name.')
  if (!b.roomTypeId || !b.plan) throw new HttpError(400, 'Choose the room type and the meal plan.')
  if (!DATE.test(b.arrival ?? '') || !DATE.test(b.departure ?? '')) throw new HttpError(400, 'Give the arrival date and the number of nights.')
  if (b.departure! <= b.arrival!) throw new HttpError(400, 'A stay is at least one night.')
  if (b.adults !== undefined && !(Number.isInteger(b.adults) && b.adults >= 1)) throw new HttpError(400, 'A booking needs at least one adult.')
  if (b.children !== undefined && !(Number.isInteger(b.children) && b.children >= 0)) throw new HttpError(400, 'Children: 0 or more.')
  if (b.guest.mobile) {
    const digits = b.guest.mobile.replace(/\D/g, '')
    const indian = (b.guest.nationality ?? 'IN').toUpperCase() === 'IN'
    if (indian ? !/^(91)?[6-9]\d{9}$/.test(digits) : digits.length < 8) throw new HttpError(400, indian ? 'Mobile: a 10-digit Indian number.' : 'Mobile: the full number with its country code.')
  }
  const nights = nightsOf(b.arrival!, b.departure!)
  if (nights.length > 60) throw new HttpError(400, 'A single reservation can be at most 60 nights.')
  const today = await businessDate(t)
  if (b.arrival! < today) throw new HttpError(400, `Arrival can't be before today (${showDay(today)}).`)
  if (b.source && !SOURCES[b.source]) throw new HttpError(400, `Booked through: ${Object.keys(SOURCES).join(', ')}.`)
  if (b.source && OTAS[b.source] && !b.otaRef?.trim()) throw new HttpError(400, `The ${OTAS[b.source]} booking ID, to match the OTA's payout.`)
  if (b.debtorId) {
    const [d] = await t.query<{ name: string; gstin: string | null; address: string | null; city: string | null; active: boolean }>('select name, gstin, address, city, active from debtor where id = $1', [b.debtorId])
    if (!d) throw new HttpError(404, 'No such company account.')
    if (!d.active) throw new HttpError(409, `${d.name}'s account is closed.`)
    b.billToCompany ||= d.name; b.billToGstin ||= d.gstin ?? undefined; b.billToAddress ||= d.address ?? undefined; b.billToCity ||= d.city ?? undefined
  }
  if (b.billToGstin) {
    const v = validateGstin(b.billToGstin)
    if (!v.ok) throw new HttpError(400, `Company GSTIN: ${v.reason}`)
    b.billToGstin = v.gstin
    if (!b.billToCompany?.trim()) throw new HttpError(400, 'Give the company\'s legal name for a GST bill.')
  }

  await t.query('select pg_advisory_xact_lock($1)', [RESERVATION_LOCK])     // one booking decision at a time
  await sweepBlocks(t, today, who, now())
  const [rt] = await t.query<{ max_occupancy: number; active: boolean }>('select max_occupancy, active from room_type where id = $1', [b.roomTypeId])
  if (!rt?.active) throw new HttpError(400, `No active room type "${b.roomTypeId}".`)
  const adults = b.adults ?? 1, children = b.children ?? 0
  if (adults + children > rt.max_occupancy + 1) throw new HttpError(400, `At most ${rt.max_occupancy + 1} guests (with an extra bed) for this room type.`)
  let blockRate: number | null = null
  if (b.blockId) {
    const [bl] = await t.query<{ name: string; status: string; arrival: string; departure: string; rooms: number | null; rate_paise: string | null; plan_code: string }>(
      `select k.name, k.status, k.arrival::text, k.departure::text, l.rooms, l.rate_paise, k.plan_code from room_block k left join room_block_line l on l.block_id = k.id and l.room_type_id = $2 where k.id = $1`, [b.blockId, b.roomTypeId])
    if (!bl) throw new HttpError(404, 'No such room block.')
    if (bl.status !== 'open') throw new HttpError(409, `The ${bl.name} block is ${bl.status}.`)
    if (bl.rooms == null) throw new HttpError(400, `The ${bl.name} block holds no ${b.roomTypeId} rooms.`)
    if (b.arrival! < bl.arrival || b.departure! > bl.departure) throw new HttpError(400, `The ${bl.name} block runs from ${bl.arrival} to ${bl.departure}.`)
    const full = (await blockPickup(t, b.blockId, b.roomTypeId!, nights)).filter((x) => x.picked >= bl.rooms!)
    if (full.length) throw new HttpError(409, `All ${bl.rooms} ${b.roomTypeId} rooms in the ${bl.name} block are taken on ${full.map((x) => x.night).join(', ')}.`)
    // Held rooms can still be lost to a room going out of order.
    const none = (await freeByNight(t, b.roomTypeId!, nights, undefined, b.blockId)).filter((n) => n.free <= 0)
    if (none.length) throw new HttpError(409, `No ${b.roomTypeId} room is free on ${none.map((n) => n.night).join(', ')}.`)
    blockRate = Number(bl.rate_paise)
    b.plan = bl.plan_code
  } else {
    const full = (await freeByNight(t, b.roomTypeId!, nights)).filter((n) => n.free <= 0)
    if (full.length) throw new HttpError(409, `No ${b.roomTypeId} rooms left on ${full.map((n) => n.night).join(', ')}.`, { fullNights: full.map((n) => n.night) })
  }
  if (b.nightAmounts && (b.nightAmounts.length !== nights.length || b.nightAmounts.some((a) => !(Number.isInteger(a) && a > 0)))) throw new HttpError(400, 'One price per night, in paise.')
  const amounts: number[] = b.nightAmounts ? [...b.nightAmounts] : []
  for (const n of b.nightAmounts ? [] : nights) {
    const a = blockRate ?? (b.debtorId ? await contractRate(t, b.debtorId, b.plan!, b.roomTypeId!, n) : null) ?? await rateFor(t, b.plan!, b.roomTypeId!, n)
    if (a == null) throw new HttpError(422, await noRateMessage(t, b.plan!, b.roomTypeId!, n))
    amounts.push(a)
  }

  const g = b.guest!
  const digits = g.mobile ? g.mobile.replace(/\D/g, '') : ''
  const mobile = digits ? ((g.nationality ?? 'IN').toUpperCase() === 'IN' ? '+91' + digits.slice(-10) : '+' + digits) : null
  // The same person comes back: same mobile and the same name. Someone else on a shared number is a new guest.
  let [guest] = mobile ? await t.query<{ id: string }>('select id from guest where mobile = $1 and lower(trim(name)) = lower(trim($2)) order by created_at desc limit 1', [mobile, g.name!]) : []
  if (!guest) {
    guest = { id: newId('G') }
    await t.query('insert into guest (id, name, mobile, email, nationality, company, gstin) values ($1, $2, $3, $4, $5, $6, $7)',
      [guest.id, g.name!.trim(), mobile, g.email ?? null, (g.nationality ?? 'IN').toUpperCase(), g.company ?? null, g.gstin ?? null])
  }
  const id = newId('R')
  await t.query(
    `insert into reservation (id, property_id, guest_id, status, room_type_id, rate_plan_code, arrival, departure, adults, children,
       source, eta, bill_to_company, bill_to_gstin, requests, created_by, created_at, bill_to_address, bill_to_city, bill_to_pin, ota_ref, debtor_id, block_id)
     values ($1, $2, $3, 'confirmed', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
    [id, PROPERTY, guest.id, b.roomTypeId, b.plan, b.arrival, b.departure, adults, children, b.source ?? 'direct', b.eta ?? null,
      b.billToCompany ?? null, b.billToGstin ?? null, b.requests ?? null, who.userId, now(),
      b.billToAddress ?? null, b.billToCity ?? null, b.billToPin ?? null, b.otaRef?.trim() || null, b.debtorId ?? null, b.blockId ?? null])
  for (let i = 0; i < nights.length; i++) {
    await t.query('insert into room_night (reservation_id, night, room_type_id, amount_paise) values ($1, $2, $3, $4)',
      [id, nights[i], b.roomTypeId, amounts[i]])
  }
  await t.query('insert into folio (id, reservation_id, bill_to, gstin) values ($1, $2, $3, $4)',
    [newId('F'), id, b.billToCompany ?? g.name!.trim(), b.billToGstin ?? null])
  const total = amounts.reduce((a, x) => a + x, 0)
  await appendAudit(t, { actor: who, action: 'reservation.create', entity: { type: 'reservation', id }, amount: total,
    after: { guest: g.name, roomTypeId: b.roomTypeId, plan: b.plan, arrival: b.arrival, departure: b.departure, nights: nights.length, block: b.blockId ?? null, company: b.debtorId ?? null } }, now())
  return { id, guestId: guest.id, nights: nights.length, roomTotal: total }
}

export function frontOfficeRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  app.get('/api/business-date', async (req) => {
    await requireCaller(ctx, req)
    const [p] = await db.query<{ d: string; auto_close: boolean; day_close_at: string }>('select business_date::text as d, auto_close, day_close_at from property limit 1')
    // The calendar date in India beside the hotel's business day, and when the day closes by itself.
    return { businessDate: p.d, calendarDate: istOf(ctx.now()).date, autoClose: p.auto_close, dayCloseAt: p.day_close_at, closesAt: closesAt(p.d, p.day_close_at).toISOString() }
  })

  app.post('/api/availability', async (req) => {
    await requireCaller(ctx, req)
    const b = req.body as { from?: string; to?: string }
    if (!DATE.test(b?.from ?? '') || !DATE.test(b?.to ?? '') || b.to! <= b.from!) throw new HttpError(400, 'Send from and to (YYYY-MM-DD), to after from.')
    const nights = nightsOf(b.from!, b.to!)
    if (nights.length > 92) throw new HttpError(400, 'Ask for at most 92 nights at a time.')
    const types = await db.query<{ id: string; name: string }>('select id, name from room_type where active order by base_rate_paise')
    return Promise.all(types.map(async (t) => ({ roomTypeId: t.id, name: t.name, nights: await freeByNight(db, t.id, nights) })))
  })

  // ---------- reservations ----------
  app.post('/api/reservations', async (req, reply) => {
    const who = await frontDesk(ctx, req)
    const result = await db.tx((t) => bookStay(ctx, t, who, (req.body ?? {}) as BookingInput))
    return reply.status(201).send(result)
  })

  app.get('/api/reservations', async (req) => {
    await frontDesk(ctx, req)
    const q = req.query as { status?: string; date?: string; q?: string; upcoming?: string }
    const params: unknown[] = []
    const where: string[] = []
    if (q.status) { params.push(q.status); where.push(`r.status = $${params.length}`) }
    if (q.date) { params.push(q.date); where.push(`$${params.length}::date >= r.arrival and $${params.length}::date <= r.departure`) }
    // Find a booking by guest name, mobile, booking number, room or OTA reference.
    const term = q.q?.trim()
    if (term) {
      params.push(`%${term.toLowerCase()}%`, term.toLowerCase(), term.replace(/\D/g, ''))
      const n = params.length - 2
      where.push(`(lower(g.name) like $${n} or lower(r.id) like $${n} or lower(coalesce(r.ota_ref, '')) like $${n} or lower(coalesce(s.room_no, '')) = $${n + 1}
        or (length($${n + 2}) >= 4 and coalesce(g.mobile, '') like '%' || $${n + 2} || '%'))`)
    }
    if (q.upcoming === 'true') where.push(`r.arrival > (select business_date from property limit 1) and r.status = 'confirmed'`)
    return db.query(
      `select r.id, r.status, g.name as guest, g.mobile, r.room_type_id, s.room_no, r.arrival::text, r.departure::text, r.adults, r.children, r.source, r.eta, r.ota_ref
         from reservation r join guest g on g.id = r.guest_id left join space s on s.id = r.space_id
        ${where.length ? 'where ' + where.join(' and ') : ''} order by ${term ? 'r.arrival desc' : 'r.arrival'}, g.name limit ${term ? 50 : 500}`, params)
  })

  app.get('/api/reservations/:id', async (req) => {
    await frontDesk(ctx, req)
    const { id } = req.params as { id: string }
    const r = await loadReservation(db, id)
    const [guest] = await db.query('select id, name, mobile, email, nationality, id_type, id_last4, company, gstin, vip from guest where id = $1', [r.guest_id])
    const nights = await db.query('select night::text, space_id, amount_paise, extras_paise, released, posted_line_id from room_night where reservation_id = $1 order by night', [id])
    const folios = await db.query<{ id: string }>('select id, label, bill_to, gstin, status from folio where reservation_id = $1 order by created_at', [id])
    const lines = await db.query(
      `select l.* from folio_line l join folio f on f.id = l.folio_id where f.reservation_id = $1 order by l.posted_at, l.id`, [id])
    const [formC] = await db.query('select due_at, submitted_at, reference from form_c where reservation_id = $1', [id])
    const [online] = await db.query('select eta, nationality, id_type, id_last4, address, purpose, preferences, company, gstin, submitted_at from online_checkin where reservation_id = $1', [id])
    const paymentLinks = await db.query('select url, amount_paise, status, created_at, paid_at from payment_link where reservation_id = $1 order by created_at', [id])
    const documents = await db.query(`select id, doc_type, number, issue_date::text, total_paise from tax_document where reservation_id = $1 order by issued_at, number`, [id])
    const [more] = await db.query(`select r.source, r.ota_ref, r.eta, r.requests, r.cancel_reason, r.checked_in_at, r.checked_out_at, s.room_no, t.name as room_type
                                     from reservation r left join space s on s.id = r.space_id join room_type t on t.id = r.room_type_id where r.id = $1`, [id])
    return { ...r, ...more, guest, nights, folios, lines, balance: await reservationBalance(db, id), formC: formC ?? null, onlineCheckin: online ?? null, paymentLinks, documents,
      openItems: r.status === 'in_house' ? await openStayItems(db, id) : { orders: [], laundry: [] } }
  })

  app.post('/api/reservations/:id/assign-room', async (req) => {
    const who = await frontDesk(ctx, req)
    const { id } = req.params as { id: string }
    const b = req.body as { spaceId?: string; upgrade?: boolean }
    if (!b?.spaceId) throw new HttpError(400, 'Send spaceId.')
    return db.tx(async (t) => {
      const r = await loadReservation(t, id, true)
      if (!['confirmed', 'in_house'].includes(r.status)) throw new HttpError(409, `Reservation is ${r.status}.`)
      const roomNo = await assignRoom(t, id, b.spaceId!, r.room_type_id, !!b.upgrade)
      if (r.status === 'in_house' && r.space_id && r.space_id !== b.spaceId) await onRoomMove(t, r.space_id, b.spaceId!, await businessDate(t), who, now())
      await appendAudit(t, { actor: who, action: r.space_id ? 'reservation.room_move' : 'reservation.assign_room', entity: { type: 'reservation', id },
        before: { spaceId: r.space_id }, after: { spaceId: b.spaceId, roomNo, upgrade: !!b.upgrade } }, now())
      return { ok: true, roomNo }
    })
  })

  app.post('/api/reservations/:id/discount', async (req, reply) => {
    const who = await frontDesk(ctx, req)
    const { id } = req.params as { id: string }
    const b = req.body as { percent?: number; reason?: string }
    if (!(typeof b?.percent === 'number' && b.percent >= 0 && b.percent <= 100)) throw new HttpError(400, 'Send percent between 0 and 100.')
    if (!b.reason?.trim()) throw new HttpError(400, 'Give a reason for the discount.')
    const limit = await discountLimit(db, who)
    if (b.percent > limit) {
      const approvalId = await db.tx(async (t) => {
        const aid = await createApproval(ctx, t, 'reservation.discount', who.userId, { reservationId: id, percent: b.percent }, b.reason)
        await appendAudit(t, { actor: who, action: 'reservation.discount_requested', entity: { type: 'reservation', id },
          after: { percent: b.percent, yourLimit: limit }, note: b.reason }, now())
        return aid
      })
      return reply.status(202).send({ pending: true, approvalId, message: `Your limit is ${limit}%. Sent for approval.` })
    }
    return db.tx(async (t) => {
      const changed = await applyDiscount(t, id, b.percent!)
      await appendAudit(t, { actor: who, action: 'reservation.discount', entity: { type: 'reservation', id }, after: { percent: b.percent, nights: changed }, note: b.reason }, now())
      return { ok: true, nightsRepriced: changed }
    })
  })

  app.post('/api/reservations/:id/cancel', async (req) => {
    const who = await frontDesk(ctx, req)
    const { id } = req.params as { id: string }
    const reason = (req.body as { reason?: string })?.reason?.trim()
    if (!reason) throw new HttpError(400, 'Give a reason for cancelling.')
    return db.tx(async (t) => {
      const r = await loadReservation(t, id, true)
      if (r.status !== 'confirmed') throw new HttpError(409, `Only confirmed reservations can be cancelled; this one is ${r.status}.`)
      await t.query('update room_night set released = true where reservation_id = $1', [id])
      await t.query(`update reservation set status = 'cancelled', cancel_reason = $2 where id = $1`, [id, reason])
      await appendAudit(t, { actor: who, action: 'reservation.cancel', entity: { type: 'reservation', id }, note: reason }, now())
      return { ok: true, balance: await reservationBalance(t, id) }
    })
  })

  app.post('/api/reservations/:id/extra-bed', async (req) => {
    const who = await frontDesk(ctx, req)
    const { id } = req.params as { id: string }
    const b = req.body as { amount?: number; nights?: string[] }
    if (!(b?.amount! >= 0)) throw new HttpError(400, 'Send amount (₹ per night; 0 removes it).')
    return db.tx(async (t) => {
      const r = await loadReservation(t, id, true)
      if (!['confirmed', 'in_house'].includes(r.status)) throw new HttpError(409, `Reservation is ${r.status}.`)
      const rows = await t.query<{ night: string }>(
        `update room_night set extras_paise = $2 where reservation_id = $1 and not released and posted_line_id is null
           and ($3::date[] is null or night = any($3::date[])) returning night::text`, [id, rupees(b.amount!), b.nights ?? null])
      await appendAudit(t, { actor: who, action: 'reservation.extra_bed', entity: { type: 'reservation', id }, after: { amountPerNight: rupees(b.amount!), nights: rows.map((x) => x.night) } }, now())
      return { ok: true, nights: rows.map((x) => x.night) }
    })
  })

  // ---------- check-in / check-out ----------
  app.post('/api/reservations/:id/check-in', async (req) => {
    const who = await frontDesk(ctx, req)
    const { id } = req.params as { id: string }
    const b = req.body as { spaceId?: string; upgrade?: boolean; idType?: string; idNumber?: string; notClean?: boolean }
    if (!b?.idType || !b.idNumber) throw new HttpError(400, 'Record the guest\'s ID type and number.')
    const idNo = b.idNumber.replace(/[\s-]/g, '').toUpperCase()
    if (b.idType === 'aadhaar' && !/^\d{12}$/.test(idNo)) throw new HttpError(400, 'Aadhaar: 12 digits.')
    if (b.idType === 'passport' && !/^[A-Z0-9]{6,9}$/.test(idNo)) throw new HttpError(400, 'Passport number: 6 to 9 letters and digits.')
    if (idNo.length < 6) throw new HttpError(400, 'Enter the full ID number (only its last 4 characters are kept).')
    return db.tx(async (t) => {
      const r = await loadReservation(t, id, true)
      if (r.status !== 'confirmed') throw new HttpError(409, `Reservation is ${r.status}.`)
      const today = await businessDate(t)
      if (r.arrival !== today) throw new HttpError(409, `This booking arrives on ${showDay(r.arrival)}; today is ${showDay(today)}.`)
      if (b.spaceId) await assignRoom(t, id, b.spaceId, r.room_type_id, !!b.upgrade)
      else if (!r.space_id) throw new HttpError(409, 'Assign a room first.')
      const last4 = b.idNumber!.replace(/\s/g, '').slice(-4)
      await t.query('update guest set id_type = $2, id_last4 = $3 where id = $1', [r.guest_id, b.idType, last4])
      await t.query(`update reservation set status = 'in_house', checked_in_at = $2 where id = $1`, [id, now()])
      const [{ space_id: roomId }] = await t.query<{ space_id: string }>('select space_id from reservation where id = $1', [id])
      const hk = await onCheckIn(t, roomId, who, now(), !!b.notClean)
      const [g] = await t.query<{ nationality: string; name: string }>('select nationality, name from guest where id = $1', [r.guest_id])
      let formCDue: string | null = null
      if (g.nationality !== 'IN') {
        formCDue = new Date(now().getTime() + 24 * 3600_000).toISOString()
        await t.query('insert into form_c (reservation_id, due_at) values ($1, $2) on conflict do nothing', [id, formCDue])
      }
      await appendAudit(t, { actor: who, action: 'reservation.check_in', entity: { type: 'reservation', id },
        after: { guest: g.name, idType: b.idType, idLast4: last4, formCDue } }, now())
      return { ok: true, formCDue, housekeeping: hk.warning }
    })
  })

  app.post('/api/form-c/:reservationId', async (req) => {
    const who = await frontDesk(ctx, req)
    const { reservationId } = req.params as { reservationId: string }
    const ref = (req.body as { reference?: string })?.reference?.trim()
    if (!ref) throw new HttpError(400, 'Send the Form C reference number.')
    const rows = await db.query('update form_c set submitted_at = $2, submitted_by = $3, reference = $4 where reservation_id = $1 and submitted_at is null returning reservation_id',
      [reservationId, now(), who.userId, ref])
    if (!rows.length) throw new HttpError(404, 'No pending Form C for this reservation.')
    await appendAudit(db, { actor: who, action: 'form_c.submitted', entity: { type: 'reservation', id: reservationId }, after: { reference: ref } }, now())
    return { ok: true }
  })

  app.post('/api/reservations/:id/check-out', async (req) => {
    const who = await frontDesk(ctx, req)
    const { id } = req.params as { id: string }
    return db.tx(async (t) => {
      const r = await loadReservation(t, id, true)
      if (r.status !== 'in_house') throw new HttpError(409, `Reservation is ${r.status}.`)
      // Nothing may be left behind: every order and every piece of laundry goes on the room bill first.
      const openItems = await openStayItems(t, id)
      if (openItems.orders.length || openItems.laundry.length) {
        throw new HttpError(409, `Not yet: ${describeOpenItems(openItems).join('; ')}. Put them on the room bill first.`, { openItems })
      }
      const today = await businessDate(t)
      // Leaving on the day they arrived (day use): the first night is charged now, as at the night audit.
      const [{ posted }] = await t.query<{ posted: number }>('select count(*)::int as posted from room_night where reservation_id = $1 and posted_line_id is not null', [id])
      if (!posted && r.arrival === today) {
        await postNight(ctx, t, id, today, who)
        // Charged, but the room is free to sell again tonight.
        await t.query('update room_night set released = true where reservation_id = $1 and night = $2', [id, today])
      }
      // Leaving early: nights from today onward are released, not charged.
      const released = await t.query<{ night: string }>(
        `update room_night set released = true where reservation_id = $1 and night >= $2 and posted_line_id is null and not released returning night::text`, [id, today])
      const balance = await reservationBalance(t, id)
      if (balance !== 0) {
        throw new HttpError(409, balance > 0 ? `₹${(balance / 100).toFixed(2)} is still due. Take payment before check-out.` : `₹${(-balance / 100).toFixed(2)} is owed to the guest. Refund it before check-out.`, { balance })
      }
      const invoice = await issueStayInvoice(ctx, t, who, id)
      await t.query(`update reservation set status = 'checked_out', checked_out_at = $2 where id = $1`, [id, now()])
      await t.query(`update folio set status = 'closed' where reservation_id = $1`, [id])
      if (r.space_id) await onCheckOut(t, r.space_id, today, who, now())
      await appendAudit(t, { actor: who, action: 'reservation.check_out', entity: { type: 'reservation', id },
        after: { early: released.length > 0, releasedNights: released.map((n) => n.night), invoice: invoice?.number ?? null } }, now())
      return { ok: true, releasedNights: released.map((n) => n.night), invoice }
    })
  })

  /**
   * Before check-out: everything the guest still has open goes on the room bill. An order with food sent is
   * billed and charged to the room (items never sent are dropped); an order with nothing sent is cancelled;
   * laundry is delivered and charged. Each step runs as the desk would, so every rule and audit entry applies.
   */
  app.post('/api/reservations/:id/settle-items', async (req) => {
    const who = await frontDesk(ctx, req)
    const { id } = req.params as { id: string }
    const r = await loadReservation(db, id)
    if (r.status !== 'in_house') throw new HttpError(409, `Reservation is ${r.status}.`)
    const headers = { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' }
    const call = async (url: string, payload: unknown = {}) => {
      const res = await app.inject({ method: 'POST', url, headers, payload: payload as object })
      const body = res.json() as Record<string, unknown>
      if (res.statusCode >= 300) throw new HttpError(res.statusCode, String(body.error ?? 'Could not settle.'))
      return body
    }
    const items = await openStayItems(db, id)
    const done: string[] = []
    for (const o of items.orders) {
      if (!o.sent_items) {
        await db.tx(async (t) => {
          await t.query(`update order_item set status = 'void', void_reason = 'Order cancelled at check-out', voided_by = $2, voided_at = $3 where order_id = $1 and status = 'pending'`, [o.id, who.userId, now()])
          await t.query(`update fnb_bill set status = 'void' where order_id = $1 and status = 'open'`, [o.id])
          await t.query(`update fnb_order set status = 'cancelled', closed_at = $2 where id = $1`, [o.id, now()])
          await appendAudit(t, { actor: who, action: 'order.cancel', entity: { type: 'fnb_order', id: o.id }, after: { number: o.number }, note: 'Nothing sent to the kitchen; cancelled at check-out' }, now())
        })
        done.push(`${o.outlet} order ${o.number}: cancelled (nothing was sent to the kitchen)`)
        continue
      }
      if (o.pending_items) {
        await db.tx((t) => t.query(`update order_item set status = 'void', void_reason = 'Not sent before check-out', voided_by = $2, voided_at = $3 where order_id = $1 and status = 'pending'`, [o.id, who.userId, now()]))
      }
      let bills = (await db.query<{ id: string }>(`select id from fnb_bill where order_id = $1 and status = 'open' order by part`, [o.id]))
      if (!bills.length) bills = ((await call(`/api/fnb/orders/${o.id}/bill`, {})) as { bills: { id: string }[] }).bills
      for (const b of bills) await call(`/api/fnb/bills/${b.id}/settle`, { payments: [{ method: 'room', amount: 1 }], reservationId: id })
      done.push(`${o.outlet} order ${o.number}: charged to the room`)
    }
    for (const l of items.laundry) {
      const out = (await call(`/api/laundry/orders/${l.id}/deliver`)) as { chargedPaise: number }
      done.push(`Laundry: delivered and ₹${(out.chargedPaise / 100).toFixed(0)} charged`)
    }
    await appendAudit(db, { actor: who, action: 'reservation.settle_items', entity: { type: 'reservation', id }, after: { done } }, now())
    return { done, balance: await reservationBalance(db, id), openItems: await openStayItems(db, id) }
  })

  // ---------- folio charges, reversals, payments ----------
  app.post('/api/folios/:id/charges', async (req, reply) => {
    const who = await frontDesk(ctx, req)
    const { id } = req.params as { id: string }
    const b = req.body as { kind?: 'laundry' | 'misc'; description?: string; amount?: number; gstRate?: number; sac?: string }
    if (!b?.description?.trim() || !(b.amount! > 0)) throw new HttpError(400, 'Send description and amount (₹).')
    const rate = b.kind === 'laundry' ? 18 : b.gstRate
    if (b.kind !== 'laundry' && b.kind !== 'misc') throw new HttpError(400, 'kind must be laundry or misc.')
    if (![0, 5, 12, 18, 28].includes(rate as number)) throw new HttpError(400, 'gstRate must be 0, 5, 12, 18 or 28.')
    return db.tx(async (t) => {
      const [f] = await t.query<{ status: string }>('select status from folio where id = $1 for update', [id])
      if (!f) throw new HttpError(404, 'No such bill.')
      if (f.status !== 'open') throw new HttpError(409, 'This bill is closed.')
      const g = splitGst(rupees(b.amount!), rate!)
      const lineId = newId('L')
      const sac = b.kind === 'laundry' ? ctx.tax.gst.other_services?.laundry?.sac ?? null : b.sac ?? null
      await t.query(
        `insert into folio_line (id, folio_id, business_date, posted_at, kind, description, sac, gst_rate, taxable_paise, cgst_paise, sgst_paise, amount_paise, posted_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [lineId, id, await businessDate(t), now(), b.kind, b.description, sac, rate, g.taxable, g.cgst, g.sgst, g.total, who.userId])
      await appendAudit(t, { actor: who, action: 'folio.charge', entity: { type: 'folio', id }, amount: g.total, after: { lineId, kind: b.kind, description: b.description, gstRate: rate } }, now())
      return reply.status(201).send({ lineId, total: g.total, balance: await folioBalance(t, id) })
    })
  })

  app.post('/api/folio-lines/:id/reverse', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'folio.reverse')) throw new HttpError(403, 'Only a manager can reverse a charge.')
    const { id } = req.params as { id: string }
    const reason = (req.body as { reason?: string })?.reason?.trim()
    if (!reason) throw new HttpError(400, 'Give a reason for the reversal.')
    return db.tx(async (t) => {
      const [l] = await t.query<{ folio_id: string; kind: string; description: string; gst_rate: number | null; taxable_paise: number; cgst_paise: number; sgst_paise: number; amount_paise: number }>(
        'select * from folio_line where id = $1', [id])
      if (!l) throw new HttpError(404, 'No such line.')
      if (['payment', 'refund', 'reversal'].includes(l.kind)) throw new HttpError(409, 'Payments are corrected with a refund, not a reversal.')
      const [f] = await t.query<{ status: string }>('select status from folio where id = $1', [l.folio_id])
      if (f.status !== 'open') throw new HttpError(409, 'This bill is closed.')
      const rid = newId('L')
      try {
        await t.query(
          `insert into folio_line (id, folio_id, business_date, posted_at, kind, description, gst_rate, taxable_paise, cgst_paise, sgst_paise, amount_paise, reverses, posted_by, ref)
           values ($1, $2, $3, $4, 'reversal', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [rid, l.folio_id, await businessDate(t), now(), `Reversal: ${l.description}`, l.gst_rate, -l.taxable_paise, -l.cgst_paise, -l.sgst_paise, -l.amount_paise, id, who.userId, reason])
      } catch (e) {
        if (String((e as Error).message).includes('folio_line_one_reversal')) throw new HttpError(409, 'This line was already reversed.')
        throw e
      }
      if (l.kind === 'room') await t.query('update room_night set posted_line_id = null, released = true where posted_line_id = $1', [id])
      await appendAudit(t, { actor: who, action: 'folio.reverse', entity: { type: 'folio_line', id }, amount: -l.amount_paise, note: reason }, now())
      return { ok: true, reversalId: rid, balance: await folioBalance(t, l.folio_id) }
    })
  })

  app.post('/api/folios/:id/payments', async (req, reply) => {
    const who = await frontDesk(ctx, req)
    const { id } = req.params as { id: string }
    const b = req.body as { method?: string; amount?: number; reference?: string; refund?: boolean }
    const methods = ['cash', 'card', 'upi', 'bank', 'company', 'ota']
    if (!methods.includes(b?.method ?? '') || !(b.amount! > 0)) throw new HttpError(400, `Send method (${methods.join(', ')}) and amount (₹).`)
    if (b.method !== 'cash' && !b.reference?.trim() && b.method !== 'company') throw new HttpError(400, 'Card, UPI, bank and OTA payments need a reference.')
    const amount = rupees(b.amount!) * (b.refund ? -1 : 1)
    const result = await db.tx(async (t): Promise<{ blocked: string } | { lineId: string; balance: number; voucher: string | null }> => {
      const [f] = await t.query<{ status: string; reservation_id: string }>('select status, reservation_id from folio where id = $1 for update', [id])
      if (!f) throw new HttpError(404, 'No such bill.')
      if (f.status !== 'open') throw new HttpError(409, 'This bill is closed.')
      let shiftId: string | null = null
      if (b.method === 'cash') {
        const [s] = await t.query<{ id: string }>('select id from cashier_shift where user_id = $1 and closed_at is null', [who.userId])
        if (!s) throw new HttpError(409, 'Open your cashier shift before taking cash.')
        shiftId = s.id
        if (amount > 0) {
          const [{ cash }] = await t.query<{ cash: number }>(
            `select coalesce(sum(p.amount_paise), 0)::bigint as cash from payment p join folio fo on fo.id = p.folio_id
              join reservation r on r.id = fo.reservation_id join folio_line l on l.id = p.line_id
             where p.method = 'cash' and p.amount_paise > 0 and r.guest_id = (select guest_id from reservation where id = $1)
               and l.business_date = $2`, [f.reservation_id, await businessDate(t)])
          const check = cashReceiptCheck(ctx.tax, amount, Number(cash))
          if (!check.allowed) return { blocked: check.message! }
        }
      }
      const lineId = newId('L')
      await t.query(
        `insert into folio_line (id, folio_id, business_date, posted_at, kind, description, amount_paise, posted_by, ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [lineId, id, await businessDate(t), now(), amount > 0 ? 'payment' : 'refund',
          `${amount > 0 ? 'Payment' : 'Refund'} · ${b.method!.toUpperCase()}`, -amount, who.userId, b.reference ?? null])
      // Money before check-in is an advance: GST is due on it now, so it gets a receipt (or refund) voucher.
      const [res] = await t.query<{ status: string }>('select status from reservation where id = $1', [f.reservation_id])
      let voucher: { id: string; number: string } | null = null
      if (['confirmed', 'cancelled', 'no_show'].includes(res.status)) {
        if (amount > 0 && res.status === 'confirmed') voucher = await issueReceiptVoucher(ctx, t, who, f.reservation_id, amount)
        if (amount < 0) voucher = await issueRefundVoucher(ctx, t, who, f.reservation_id, -amount)
      }
      // On the company's account: within its credit limit, and into its city-ledger account.
      let debtorId: string | null = null
      if (b.method === 'company') {
        const [c] = await t.query<{ company: string | null; gstin: string | null; bill_to: string; folio_gstin: string | null }>(
          'select r.bill_to_company as company, r.bill_to_gstin as gstin, f.bill_to, f.gstin as folio_gstin from folio f join reservation r on r.id = f.reservation_id where f.id = $1', [id])
        debtorId = await debtorFor(t, c.company ?? c.bill_to, c.gstin ?? c.folio_gstin, now())
        await checkCredit(t, debtorId, amount)
      }
      // Paid to the OTA by the guest: the OTA owes it, and pays out later net of its commission and taxes.
      if (b.method === 'ota') {
        const [r] = await t.query<{ source: string }>('select source from reservation where id = $1', [f.reservation_id])
        debtorId = await otaDebtorFor(t, r.source, now())
        if (!debtorId) throw new HttpError(400, 'This booking was not made through an OTA: mark where it was booked first, or take the payment another way.')
      }
      await t.query('insert into payment (id, folio_id, line_id, method, amount_paise, reference, shift_id, received_by, at, voucher_id, debtor_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [newId('P'), id, lineId, b.method, amount, b.reference ?? null, shiftId, who.userId, now(), voucher?.id ?? null, debtorId])
      await appendAudit(t, { actor: who, action: amount > 0 ? 'payment.receive' : 'payment.refund', entity: { type: 'folio', id }, amount,
        after: { method: b.method, reference: b.reference ?? null } }, now())
      return { lineId, balance: await folioBalance(t, id), voucher: voucher?.number ?? null }
    })
    if ('blocked' in result) {
      // Logged outside the refused transaction, so God Mode sees the attempt.
      await appendAudit(db, { actor: who, action: 'payment.cash_blocked', entity: { type: 'folio', id }, amount, note: result.blocked }, now())
      throw new HttpError(403, result.blocked)
    }
    return reply.status(201).send(result)
  })
}
