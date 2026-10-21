import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { accommodationNight, addDays, rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { businessDate, LODGING, PROPERTY } from '../fo-core'
import { requireCaller } from './auth'
import { onNightAudit } from '../hk-core'

// Cashier shifts and the night audit that closes each business day.

const newId = (p: string) => `${p}-${randomUUID().slice(0, 8).toUpperCase()}`

/** Cash taken in a cashier shift: front-desk payments and restaurant / bar payments. */
async function shiftCash(db: Db, shiftId: string) {
  const [{ cash }] = await db.query<{ cash: number }>(
    `select (select coalesce(sum(amount_paise), 0) from payment where shift_id = $1)
          + (select coalesce(sum(amount_paise), 0) from fnb_payment where shift_id = $1 and method = 'cash') as cash`, [shiftId])
  return Number(cash)
}

export function nightAuditRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()
  const varianceAlert = rupees(Number(ctx.roles.god_mode_alerts?.find((a) => a.id === 'cashier_variance_above')?.value ?? 500))

  // ---------- cashier shifts ----------
  app.post('/api/cashier/open', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'front_desk') && !can(who, 'fnb.bill')) throw new HttpError(403, 'This needs front desk or restaurant cashier access.')
    const float = (req.body as { openingFloat?: number })?.openingFloat
    if (!(float! >= 0)) throw new HttpError(400, 'Send openingFloat (₹ counted in the drawer).')
    const id = newId('SH')
    try {
      await db.query('insert into cashier_shift (id, user_id, business_date, opened_at, opening_float) values ($1, $2, $3, $4, $5)',
        [id, who.userId, await businessDate(db), now(), rupees(float!)])
    } catch (e) {
      if (String((e as Error).message).includes('cashier_one_open_shift')) throw new HttpError(409, 'You already have an open shift.')
      throw e
    }
    await appendAudit(db, { actor: who, action: 'cashier.open', entity: { type: 'cashier_shift', id }, amount: rupees(float!) }, now())
    return reply.status(201).send({ shiftId: id })
  })

  app.get('/api/cashier/current', async (req) => {
    const who = await requireCaller(ctx, req)
    const [s] = await db.query<{ id: string; opening_float: number }>(
      'select id, opening_float, opened_at, business_date::text from cashier_shift where user_id = $1 and closed_at is null', [who.userId])
    if (!s) return { open: false }
    const cash = await shiftCash(db, s.id)
    return { open: true, ...s, cashTaken: Number(cash), expectedInDrawer: s.opening_float + Number(cash) }
  })

  app.post('/api/cashier/close', async (req) => {
    const who = await requireCaller(ctx, req)
    const b = req.body as { countedCash?: number; denominations?: Record<string, number> }
    if (!(b?.countedCash! >= 0)) throw new HttpError(400, 'Send countedCash (₹ counted in the drawer).')
    return db.tx(async (t) => {
      const [s] = await t.query<{ id: string; opening_float: number }>(
        'select id, opening_float from cashier_shift where user_id = $1 and closed_at is null for update', [who.userId])
      if (!s) throw new HttpError(409, 'You have no open shift.')
      const cash = await shiftCash(t, s.id)
      const expected = s.opening_float + Number(cash)
      const counted = rupees(b.countedCash!)
      const variance = counted - expected
      if (b.denominations) {
        const sum = Object.entries(b.denominations).reduce((a, [note, n]) => a + Number(note) * Number(n), 0)
        if (rupees(sum) !== counted) throw new HttpError(400, `The notes add up to ₹${sum}, not ₹${b.countedCash}.`)
      }
      await t.query('update cashier_shift set closed_at = $2, counted_cash = $3, expected_cash = $4, variance = $5, denominations = $6 where id = $1',
        [s.id, now(), counted, expected, variance, b.denominations ? JSON.stringify(b.denominations) : null])
      const flagged = Math.abs(variance) > varianceAlert
      await appendAudit(t, { actor: who, action: flagged ? 'cashier.close_with_variance' : 'cashier.close', entity: { type: 'cashier_shift', id: s.id },
        amount: variance, after: { expected, counted, variance } }, now())
      return { shiftId: s.id, expected, counted, variance, flagged }
    })
  })

  // ---------- night audit ----------
  app.post('/api/night-audit', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'night_audit')) throw new HttpError(403, 'Only the night auditor or a manager can close the day.')
    return closeDay(ctx, who)
  })

  app.get('/api/night-audit/:date', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'night_audit') && !who.godMode) throw new HttpError(403, 'You cannot see night audit reports.')
    const [r] = await db.query('select business_date::text, run_by, run_at, summary from night_audit where business_date = $1', [(req.params as { date: string }).date])
    if (!r) throw new HttpError(404, 'No night audit for that date.')
    return r
  })
}

/**
 * Closes the business day: no-shows, tonight's room charges, the day's figures kept with the audit, and the
 * hotel moves to the next day. Run by the night auditor, or by itself at the day-close time.
 */
export async function closeDay(ctx: Ctx, who: Caller, action = 'night_audit.run') {
  const db = ctx.db
  const now = () => ctx.now()
  return db.tx(async (t) => {
    await t.query('select 1 from property where id = $1 for update', [PROPERTY])
    const day = await businessDate(t)
    const audited = await t.query('select 1 from night_audit where business_date = $1', [day])
    if (audited.length) throw new HttpError(409, `${day} is already closed.`)

    // 1. Guests who never arrived become no-shows and their nights go back on sale.
    const noShows = await t.query<{ id: string }>(
      `update reservation set status = 'no_show' where status = 'confirmed' and arrival <= $1 returning id`, [day])
    if (noShows.length) await t.query('update room_night set released = true where reservation_id = any($1)', [noShows.map((r) => r.id)])

    // 2. Post tonight's room charge, with GST chosen from tonight's actual value, to every in-house guest's bill.
    const toPost = await t.query<{ reservation_id: string; amount_paise: number; extras_paise: number; room_no: string | null; folio_id: string }>(
      `select rn.reservation_id, rn.amount_paise, rn.extras_paise, s.room_no,
              (select id from folio f where f.reservation_id = rn.reservation_id order by created_at limit 1) as folio_id
         from room_night rn join reservation r on r.id = rn.reservation_id left join space s on s.id = rn.space_id
        where rn.night = $1 and not rn.released and rn.posted_line_id is null and r.status = 'in_house'`, [day])
    let roomRevenue = 0, roomGst = 0
    for (const n of toPost) {
      const tax = await postNight(ctx, t, n.reservation_id, day, who)
      if (!tax) continue
      roomRevenue += tax.taxable
      roomGst += tax.cgst + tax.sgst
    }

    // 3. The day's figures, kept with the audit and in the God Mode log.
    const [{ sellable }] = await t.query<{ sellable: number }>('select count(*)::int as sellable from space where active and sellable and kind = any($1)', [LODGING])
    const payments = await t.query<{ method: string; total: number }>(
      `select p.method, sum(p.amount_paise)::bigint as total from payment p join folio_line l on l.id = p.line_id
        where l.business_date = $1 group by p.method order by p.method`, [day])
    const [{ arrivals }] = await t.query<{ arrivals: number }>(`select count(*)::int arrivals from reservation where arrival = $1 and status in ('in_house','checked_out')`, [day])
    const [{ departures }] = await t.query<{ departures: number }>(`select count(*)::int departures from reservation where status = 'checked_out' and checked_out_at::date = $1::date`, [day])
    const overstays = await t.query<{ id: string }>(`select id from reservation where status = 'in_house' and departure <= $1`, [day])
    const openShifts = await t.query<{ id: string }>('select id from cashier_shift where closed_at is null')
    // Restaurant and bar: what was settled today, and orders still open.
    const fnbBills = await t.query<{ amounts: { foodTaxable: number; cgst: number; sgst: number; liquorTaxable: number; vat: number; total: number; payable: number }; to_room: boolean }>(
      `select b.amounts, b.reservation_id is not null as to_room from fnb_bill b where b.status = 'settled'
          and exists (select 1 from fnb_payment p where p.bill_id = b.id and p.business_date = $1)`, [day])
    const fnbPay = await t.query<{ method: string; total: number }>('select method, sum(amount_paise)::bigint as total from fnb_payment where business_date = $1 group by method order by method', [day])
    const fnbOpen = await t.query<{ number: number }>(`select number from fnb_order where status in ('open', 'billed') order by number`)
    const fsum = (k: 'foodTaxable' | 'cgst' | 'sgst' | 'liquorTaxable' | 'vat') => fnbBills.reduce((a, b) => a + b.amounts[k], 0)
    const formCOverdue = await t.query<{ reservation_id: string }>('select reservation_id from form_c where submitted_at is null and due_at < $1', [now()])
    const irnDue = await t.query<{ number: string; irn_deadline: string }>(
      `select number, irn_deadline::text from tax_document where irn_status in ('pending','failed') and irn_deadline <= $1::date + 5 order by irn_deadline`, [day])
    const summary = {
      businessDate: day,
      roomsSold: toPost.length, sellableRooms: sellable,
      occupancy: sellable ? Math.round((toPost.length / sellable) * 1000) / 10 : 0,
      roomRevenue, roomGst, adr: toPost.length ? Math.round(roomRevenue / toPost.length) : 0,
      payments: Object.fromEntries(payments.map((p) => [p.method, Number(p.total)])),
      arrivals, departures, noShows: noShows.map((r) => r.id),
      overstays: overstays.map((r) => r.id), openCashierShifts: openShifts.map((s) => s.id),
      formCOverdue: formCOverdue.map((r) => r.reservation_id),
      eInvoicesDueWithin5Days: irnDue.map((r) => ({ number: r.number, deadline: r.irn_deadline })),
      fnb: {
        bills: fnbBills.length, foodSales: fsum('foodTaxable'), foodGst: fsum('cgst') + fsum('sgst'), liquorSales: fsum('liquorTaxable'), liquorVat: fsum('vat'),
        chargedToRooms: fnbBills.filter((b) => b.to_room).length,
        payments: Object.fromEntries(fnbPay.map((p) => [p.method, Number(p.total)])), openOrders: fnbOpen.map((o) => o.number),
      },
    }
    await t.query('insert into night_audit (business_date, run_by, run_at, summary) values ($1, $2, $3, $4)', [day, who.userId, now(), JSON.stringify(summary)])
    const next = addDays(day, 1)
    await t.query('update property set business_date = $2 where id = $1', [PROPERTY, next])
    await onNightAudit(t, next, now())
    await appendAudit(t, { actor: who, action, entity: { type: 'business_date', id: day }, amount: roomRevenue, after: summary }, now())
    return { ...summary, nextBusinessDate: next }
  })
}

/** Posts one night's room charge to a stay's bill, with GST chosen from that night's value (the night audit, or a day use at check-out). */
export async function postNight(ctx: Ctx, t: Db, reservationId: string, day: string, who: Caller) {
  const [n] = await t.query<{ amount_paise: number; extras_paise: number; room_no: string | null; folio_id: string }>(
    `select rn.amount_paise, rn.extras_paise, s.room_no, (select id from folio f where f.reservation_id = rn.reservation_id order by created_at limit 1) as folio_id
       from room_night rn join reservation r on r.id = rn.reservation_id left join space s on s.id = coalesce(rn.space_id, r.space_id)
      where rn.reservation_id = $1 and rn.night = $2 and not rn.released and rn.posted_line_id is null`, [reservationId, day])
  if (!n) return null
  const tax = accommodationNight(ctx.tax, { date: day, charged: n.amount_paise, extras: n.extras_paise })
  const lineId = newId('L')
  await t.query(
    `insert into folio_line (id, folio_id, business_date, posted_at, kind, description, sac, gst_rate, taxable_paise, cgst_paise, sgst_paise, amount_paise, posted_by, ref)
     values ($1, $2, $3, $4, 'room', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [lineId, n.folio_id, day, ctx.now(), `Room ${n.room_no ?? ''} · night of ${new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}${n.extras_paise ? ' (incl. extra bed)' : ''}`.trim(),
      ctx.tax.gst.accommodation.sac, tax.rate, tax.taxable, tax.cgst, tax.sgst, tax.total, who.userId, day])
  await t.query('update room_night set posted_line_id = $3 where reservation_id = $1 and night = $2', [reservationId, day, lineId])
  return tax
}

/** The Indian date and time of an instant: 'YYYY-MM-DD' and 'HH:MM'. */
export function istOf(d: Date) {
  const s = new Date(d.getTime() + 330 * 60_000).toISOString()
  return { date: s.slice(0, 10), time: s.slice(11, 16) }
}

/** When a business day closes by itself: at the close time that night, or the next morning for times after midnight. */
export function closesAt(day: string, at: string) {
  const d = at >= '12:00' ? day : addDays(day, 1)
  return new Date(`${d}T${at}:00+05:30`)
}

export const DAY_CLOSER: Caller = { userId: 'system', name: 'Automatic day close', role: 'system', roles: [], godMode: false, permissions: new Set(), sessionId: '', scope: 'full' }

/** Closes every business day whose close time has passed and nobody closed (catching up days missed). */
export async function autoCloseDays(ctx: Ctx) {
  let closed = 0
  for (let i = 0; i < 62; i++) {
    const [p] = await ctx.db.query<{ auto_close: boolean; day_close_at: string; d: string }>('select auto_close, day_close_at, business_date::text as d from property where id = $1', [PROPERTY])
    if (!p?.auto_close || ctx.now() < closesAt(p.d, p.day_close_at)) break
    await closeDay(ctx, DAY_CLOSER, 'night_audit.auto')
    closed++
  }
  return closed
}
