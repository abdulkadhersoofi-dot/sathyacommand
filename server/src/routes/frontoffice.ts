import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { cashReceiptCheck, rupees, splitGst } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import {
  applyDiscount, businessDate, folioBalance, freeByNight, LODGING, nightsOf, PROPERTY, rateFor, reservationBalance,
} from '../fo-core'
import { createApproval } from './approvals'
import { issueReceiptVoucher, issueRefundVoucher, issueStayInvoice } from '../invoicing'
import { validateGstin } from '@sathya/tax'
import { checkCredit, debtorFor } from '../receivables'
import { requireCaller } from './auth'
import { onCheckIn, onCheckOut, onRoomMove } from '../hk-core'

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

export function frontOfficeRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  app.get('/api/business-date', async (req) => {
    await requireCaller(ctx, req)
    return { businessDate: await businessDate(db) }
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
    const b = req.body as {
      guest?: { name?: string; mobile?: string; email?: string; nationality?: string; company?: string; gstin?: string }
      roomTypeId?: string; plan?: string; arrival?: string; departure?: string; adults?: number; children?: number
      source?: string; eta?: string; billToCompany?: string; billToGstin?: string; requests?: string
      billToAddress?: string; billToCity?: string; billToPin?: string
    }
    if (!b?.guest?.name?.trim()) throw new HttpError(400, 'Give the guest\'s name.')
    if (!b.roomTypeId || !b.plan || !DATE.test(b.arrival ?? '') || !DATE.test(b.departure ?? '') || b.departure! <= b.arrival!) {
      throw new HttpError(400, 'Send roomTypeId, plan, arrival and departure (YYYY-MM-DD), departure after arrival.')
    }
    const nights = nightsOf(b.arrival!, b.departure!)
    if (nights.length > 60) throw new HttpError(400, 'A single reservation can be at most 60 nights.')
    const today = await businessDate(db)
    if (b.arrival! < today) throw new HttpError(400, `Arrival can't be before today's business date (${today}).`)
    if (b.billToGstin) {
      const v = validateGstin(b.billToGstin)
      if (!v.ok) throw new HttpError(400, `Company GSTIN: ${v.reason}`)
      b.billToGstin = v.gstin
      if (!b.billToCompany?.trim()) throw new HttpError(400, 'Give the company\'s legal name for a GST bill.')
    }

    const result = await db.tx(async (t) => {
      await t.query('select pg_advisory_xact_lock($1)', [RESERVATION_LOCK])     // one booking decision at a time
      const [rt] = await t.query<{ max_occupancy: number; active: boolean }>('select max_occupancy, active from room_type where id = $1', [b.roomTypeId])
      if (!rt?.active) throw new HttpError(400, `No active room type "${b.roomTypeId}".`)
      const adults = b.adults ?? 1, children = b.children ?? 0
      if (adults + children > rt.max_occupancy + 1) throw new HttpError(400, `At most ${rt.max_occupancy + 1} guests (with an extra bed) for this room type.`)
      const full = (await freeByNight(t, b.roomTypeId!, nights)).filter((n) => n.free <= 0)
      if (full.length) throw new HttpError(409, `No ${b.roomTypeId} rooms left on ${full.map((n) => n.night).join(', ')}.`, { fullNights: full.map((n) => n.night) })
      const amounts: number[] = []
      for (const n of nights) {
        const a = await rateFor(t, b.plan!, b.roomTypeId!, n)
        if (a == null) throw new HttpError(422, `No ${b.plan} rate for ${b.roomTypeId} on ${n}.`)
        amounts.push(a)
      }

      const g = b.guest!
      const mobile = g.mobile ? '+91' + g.mobile.replace(/\D/g, '').slice(-10) : null
      let [guest] = mobile ? await t.query<{ id: string }>('select id from guest where mobile = $1', [mobile]) : []
      if (!guest) {
        guest = { id: newId('G') }
        await t.query('insert into guest (id, name, mobile, email, nationality, company, gstin) values ($1, $2, $3, $4, $5, $6, $7)',
          [guest.id, g.name!.trim(), mobile, g.email ?? null, (g.nationality ?? 'IN').toUpperCase(), g.company ?? null, g.gstin ?? null])
      }
      const id = newId('R')
      await t.query(
        `insert into reservation (id, property_id, guest_id, status, room_type_id, rate_plan_code, arrival, departure, adults, children,
           source, eta, bill_to_company, bill_to_gstin, requests, created_by, created_at, bill_to_address, bill_to_city, bill_to_pin)
         values ($1, $2, $3, 'confirmed', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [id, PROPERTY, guest.id, b.roomTypeId, b.plan, b.arrival, b.departure, adults, children, b.source ?? 'direct', b.eta ?? null,
          b.billToCompany ?? null, b.billToGstin ?? null, b.requests ?? null, who.userId, now(),
          b.billToAddress ?? null, b.billToCity ?? null, b.billToPin ?? null])
      for (let i = 0; i < nights.length; i++) {
        await t.query('insert into room_night (reservation_id, night, room_type_id, amount_paise) values ($1, $2, $3, $4)',
          [id, nights[i], b.roomTypeId, amounts[i]])
      }
      await t.query('insert into folio (id, reservation_id, bill_to, gstin) values ($1, $2, $3, $4)',
        [newId('F'), id, b.billToCompany ?? g.name!.trim(), b.billToGstin ?? null])
      const total = amounts.reduce((a, x) => a + x, 0)
      await appendAudit(t, { actor: who, action: 'reservation.create', entity: { type: 'reservation', id }, amount: total,
        after: { guest: g.name, roomTypeId: b.roomTypeId, plan: b.plan, arrival: b.arrival, departure: b.departure, nights: nights.length } }, now())
      return { id, guestId: guest.id, nights: nights.length, roomTotal: total }
    })
    return reply.status(201).send(result)
  })

  app.get('/api/reservations', async (req) => {
    await frontDesk(ctx, req)
    const q = req.query as { status?: string; date?: string }
    const params: unknown[] = []
    const where: string[] = []
    if (q.status) { params.push(q.status); where.push(`r.status = $${params.length}`) }
    if (q.date) { params.push(q.date); where.push(`$${params.length}::date >= r.arrival and $${params.length}::date <= r.departure`) }
    return db.query(
      `select r.id, r.status, g.name as guest, r.room_type_id, s.room_no, r.arrival::text, r.departure::text, r.adults, r.children, r.source, r.eta
         from reservation r join guest g on g.id = r.guest_id left join space s on s.id = r.space_id
        ${where.length ? 'where ' + where.join(' and ') : ''} order by r.arrival, g.name limit 500`, params)
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
    return { ...r, guest, nights, folios, lines, balance: await reservationBalance(db, id), formC: formC ?? null }
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
    const b = req.body as { spaceId?: string; upgrade?: boolean; idType?: string; idNumber?: string }
    if (!b?.idType || !b.idNumber || b.idNumber.replace(/\s/g, '').length < 4) throw new HttpError(400, 'Record the guest\'s ID type and number.')
    return db.tx(async (t) => {
      const r = await loadReservation(t, id, true)
      if (r.status !== 'confirmed') throw new HttpError(409, `Reservation is ${r.status}.`)
      const today = await businessDate(t)
      if (r.arrival !== today) throw new HttpError(409, `Arrival is on ${r.arrival}; today's business date is ${today}.`)
      if (b.spaceId) await assignRoom(t, id, b.spaceId, r.room_type_id, !!b.upgrade)
      else if (!r.space_id) throw new HttpError(409, 'Assign a room first.')
      const last4 = b.idNumber!.replace(/\s/g, '').slice(-4)
      await t.query('update guest set id_type = $2, id_last4 = $3 where id = $1', [r.guest_id, b.idType, last4])
      await t.query(`update reservation set status = 'in_house', checked_in_at = $2 where id = $1`, [id, now()])
      const [{ space_id: roomId }] = await t.query<{ space_id: string }>('select space_id from reservation where id = $1', [id])
      const hk = await onCheckIn(t, roomId, who, now())
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
      const today = await businessDate(t)
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
