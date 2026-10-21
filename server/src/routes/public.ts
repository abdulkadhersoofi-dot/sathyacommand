import type { FastifyInstance, FastifyRequest } from 'fastify'
import { appendAudit } from '../audit-store'
import { HttpError, type Ctx } from '../context'
import { addDays } from '../eng-core'
import { businessDate, nightsOf } from '../fo-core'
import { linkToken, ONLINE, quoteStay, recordGatewayPayment, sellingRuleBroken, sweepUnpaid, tokenOk } from '../channels'
import { bookStay } from './frontoffice'

// The resort's own booking page and online check-in, open to guests without a login. A booking is opened
// again only with its signed link. Deposits go through a payment link when a gateway is set up; otherwise
// the guest pays at the resort.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const str = (v: unknown, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null }
const PAY_MINUTES = 120

/** A few tries per address per hour, so the booking page cannot be used to fill the resort with junk. */
const tries = new Map<string, { n: number; reset: number }>()
function limit(req: FastifyRequest, key: string, max: number, nowMs: number) {
  const k = `${key}:${req.ip}`
  const t = tries.get(k)
  if (!t || t.reset < nowMs) { tries.set(k, { n: 1, reset: nowMs + 3_600_000 }); return }
  if (++t.n > max) throw new HttpError(429, 'Too many tries from here. Please call the resort.')
}

export function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()
  const base = (req: FastifyRequest) => process.env.PUBLIC_URL ?? `${req.protocol}://${req.headers.host ?? 'localhost'}`

  app.get('/book', async (_req, reply) => reply.redirect('/book.html'))

  app.get('/public/property', async () => {
    const [p] = await db.query<{ name: string; city: string | null; address: string | null }>('select name, city, address from property limit 1')
    const types = await db.query('select id, name, max_occupancy from room_type where active order by base_rate_paise')
    return { name: p.name, city: p.city, address: p.address, today: await businessDate(db), roomTypes: types, payOnline: !!ctx.payments }
  })

  app.get('/public/availability', async (req) => {
    limit(req, 'avail', 300, now().getTime())
    const q = req.query as { arrival?: string; departure?: string; adults?: string; children?: string }
    if (!DATE.test(q.arrival ?? '') || !DATE.test(q.departure ?? '') || q.departure! <= q.arrival!) throw new HttpError(400, 'Choose arrival and departure dates.')
    const today = await businessDate(db)
    if (q.arrival! < today) throw new HttpError(400, 'The arrival date has passed.')
    if (nightsOf(q.arrival!, q.departure!).length > 30) throw new HttpError(400, 'For more than 30 nights, please call the resort.')
    if (q.arrival! > addDays(today, 365)) throw new HttpError(400, 'Bookings open a year ahead.')
    await sweepUnpaid(db, now())
    const guests = Number(q.adults ?? 2) + Number(q.children ?? 0)
    const types = await db.query<{ id: string; name: string; max_occupancy: number }>('select id, name, max_occupancy from room_type where active order by base_rate_paise')
    const out = []
    for (const t of types) {
      const rule = await sellingRuleBroken(db, t.id, q.arrival!, q.departure!)
      const qs = await quoteStay(ctx, db, t.id, q.arrival!, q.departure!)
      out.push({ roomTypeId: t.id, name: t.name, maxOccupancy: t.max_occupancy, fits: guests <= t.max_occupancy,
        available: !rule && qs.free > 0 && guests <= t.max_occupancy, reason: rule ?? (qs.free > 0 ? (guests > t.max_occupancy ? `Up to ${t.max_occupancy} guests.` : null) : 'Sold out for these dates.'),
        roomsLeft: qs.free <= 3 ? qs.free : null, nights: qs.nights, prices: qs.prices })
    }
    return { arrival: q.arrival, departure: q.departure, roomTypes: out, payOnline: !!ctx.payments }
  })

  app.post('/public/bookings', async (req, reply) => {
    limit(req, 'book', 10, now().getTime())
    const b = (req.body ?? {}) as { roomTypeId?: string; plan?: string; arrival?: string; departure?: string; adults?: number; children?: number; name?: string; mobile?: string; email?: string; requests?: string; website?: string }
    // A form field people never see: only robots fill it in.
    if (b.website) throw new HttpError(400, 'Something went wrong. Please call the resort.')
    const name = str(b.name, 120), mobile = String(b.mobile ?? '').replace(/\D/g, '').slice(-10)
    if (!name) throw new HttpError(400, 'Your name, please.')
    if (!/^[6-9]\d{9}$/.test(mobile)) throw new HttpError(400, 'A 10-digit Indian mobile number, so the resort can reach you.')
    const email = str(b.email, 254)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email does not look right.')
    if (!DATE.test(b.arrival ?? '') || !DATE.test(b.departure ?? '') || b.departure! <= b.arrival!) throw new HttpError(400, 'Choose arrival and departure dates.')
    if (nightsOf(b.arrival!, b.departure!).length > 30) throw new HttpError(400, 'For more than 30 nights, please call the resort.')
    const rule = await sellingRuleBroken(db, b.roomTypeId ?? '', b.arrival!, b.departure!)
    if (rule) throw new HttpError(409, rule)
    await sweepUnpaid(db, now())
    const result = await db.tx(async (t) => {
      const r = await bookStay(ctx, t, ONLINE, { guest: { name, mobile, email: email ?? undefined }, roomTypeId: b.roomTypeId, plan: b.plan, arrival: b.arrival, departure: b.departure,
        adults: b.adults ?? 2, children: b.children ?? 0, source: 'website', requests: str(b.requests, 500) ?? undefined })
      const q = await quoteStay(ctx, t, b.roomTypeId!, b.arrival!, b.departure!)
      const price = q.prices.find((p) => p.plan === b.plan)!
      let payment: { url: string; amountPaise: number; payBy: string } | null = null
      if (ctx.payments) {
        // A deposit of the first night with its GST holds the booking; unpaid, it is cancelled after two hours.
        const payBy = new Date(now().getTime() + PAY_MINUTES * 60_000)
        const link = await ctx.payments.createLink({ amountPaise: price.firstNightPaise, reference: r.id, description: `Deposit for booking ${r.id}, ${b.arrival} to ${b.departure}`,
          customer: { name, mobile: `+91${mobile}`, email }, expireBy: payBy, callbackUrl: `${base(req)}/book.html?r=${r.id}&t=${await linkToken(t, r.id)}` })
        await t.query(`insert into payment_link (id, reservation_id, provider, provider_id, url, amount_paise, status, created_at) values ($1,$2,$3,$4,$5,$6,'created',$7)`,
          [`PL-${r.id}`, r.id, ctx.payments.name, link.id, link.url, price.firstNightPaise, now()])
        await t.query('update reservation set pay_by = $2 where id = $1', [r.id, payBy])
        payment = { url: link.url, amountPaise: price.firstNightPaise, payBy: payBy.toISOString() }
      }
      await appendAudit(t, { actor: ONLINE, action: 'website.booking', entity: { type: 'reservation', id: r.id }, amount: price.roomPaise + price.gstPaise, after: { plan: b.plan, deposit: payment?.amountPaise ?? null } }, now())
      return { reservationId: r.id, roomPaise: price.roomPaise, gstPaise: price.gstPaise, totalPaise: price.roomPaise + price.gstPaise, payment, token: await linkToken(t, r.id) }
    })
    return reply.status(201).send({ ...result, checkinUrl: `${base(req)}/checkin.html?r=${result.reservationId}&t=${result.token}` })
  })

  async function guarded(req: FastifyRequest) {
    const { id } = req.params as { id: string }
    const t = (req.query as { t?: string }).t ?? ''
    if (!(await tokenOk(db, id, t))) throw new HttpError(404, 'This link is not valid. Please call the resort.')
    return id
  }

  /** The booking as the guest sees it, from their signed link. */
  app.get('/public/bookings/:id', async (req) => {
    const id = await guarded(req)
    const [r] = await db.query<{ id: string; status: string; guest: string; arrival: string; departure: string; room_type: string; plan: string; adults: number; children: number; pay_by: Date | null; nationality: string }>(
      `select r.id, r.status, g.name as guest, r.arrival::text, r.departure::text, t.name as room_type, r.rate_plan_code as plan, r.adults, r.children, r.pay_by, g.nationality
         from reservation r join guest g on g.id = r.guest_id join room_type t on t.id = r.room_type_id where r.id = $1`, [id])
    const [p] = await db.query<{ name: string; address: string | null; city: string | null }>('select name, address, city from property limit 1')
    const [{ total }] = await db.query<{ total: string }>('select coalesce(sum(amount_paise), 0) as total from room_night where reservation_id = $1 and not released', [id])
    const [{ paid }] = await db.query<{ paid: string }>(`select coalesce(sum(-l.amount_paise), 0) as paid from folio_line l join folio f on f.id = l.folio_id where f.reservation_id = $1 and l.kind in ('payment','refund')`, [id])
    const [link] = await db.query<{ url: string; amount_paise: string; status: string }>(`select url, amount_paise, status from payment_link where reservation_id = $1 order by created_at desc limit 1`, [id])
    const [oc] = await db.query<{ submitted_at: Date }>('select submitted_at from online_checkin where reservation_id = $1', [id])
    return { ...r, resort: p, roomPaise: Number(total), paidPaise: Number(paid), payment: link && link.status === 'created' ? { url: link.url, amountPaise: Number(link.amount_paise), payBy: r.pay_by } : null,
      checkedInOnline: oc ? oc.submitted_at : null }
  })

  /** Pre-arrival check-in: arrival time, ID (type and last four only), address, purpose, preferences, a company for the bill. */
  app.post('/public/bookings/:id/checkin', async (req) => {
    const id = await guarded(req)
    limit(req, 'checkin', 20, now().getTime())
    const b = (req.body ?? {}) as { eta?: string; nationality?: string; idType?: string; idNumber?: string; address?: string; purpose?: string; preferences?: string; company?: string; gstin?: string; consent?: boolean }
    if (!b.consent) throw new HttpError(400, 'Please agree to the resort keeping these details for your stay.')
    if (b.eta && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.eta)) throw new HttpError(400, 'Arrival time as HH:MM.')
    const nationality = (str(b.nationality, 2) ?? 'IN').toUpperCase()
    const ID_TYPES = ['aadhaar', 'passport', 'driving_licence', 'voter_id', 'pan', 'other']
    if (b.idType && !ID_TYPES.includes(b.idType)) throw new HttpError(400, `ID: ${ID_TYPES.join(', ')}.`)
    if (nationality !== 'IN' && b.idType !== 'passport') throw new HttpError(400, 'Guests from outside India check in with their passport (Form C).')
    const last4 = String(b.idNumber ?? '').replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase() || null
    return db.tx(async (t) => {
      const [r] = await t.query<{ status: string; guest_id: string }>('select status, guest_id from reservation where id = $1 for update', [id])
      if (r.status !== 'confirmed') throw new HttpError(409, r.status === 'in_house' ? 'You are already checked in.' : 'This booking is not open for check-in.')
      await t.query(`insert into online_checkin (reservation_id, eta, nationality, id_type, id_last4, address, purpose, preferences, company, gstin, submitted_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        on conflict (reservation_id) do update set eta = excluded.eta, nationality = excluded.nationality, id_type = excluded.id_type, id_last4 = excluded.id_last4, address = excluded.address,
          purpose = excluded.purpose, preferences = excluded.preferences, company = excluded.company, gstin = excluded.gstin, submitted_at = excluded.submitted_at`,
        [id, b.eta ?? null, nationality, b.idType ?? null, last4, str(b.address, 300), str(b.purpose, 80), str(b.preferences, 500), str(b.company, 120), str(b.gstin, 15)?.toUpperCase() ?? null, now()])
      if (b.eta) await t.query('update reservation set eta = $2 where id = $1', [id, b.eta])
      await t.query('update guest set nationality = $2, id_type = coalesce($3, id_type), id_last4 = coalesce($4, id_last4) where id = $1', [r.guest_id, nationality, b.idType ?? null, last4])
      await appendAudit(t, { actor: ONLINE, action: 'reservation.online_checkin', entity: { type: 'reservation', id }, after: { eta: b.eta ?? null, idType: b.idType ?? null } }, now())
      return { ok: true }
    })
  })

  // The gateway's webhook, checked against its signature over the exact bytes sent.
  app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
    sub.post('/public/payments/webhook', async (req) => {
      const raw = req.body as Buffer
      const p = ctx.payments
      if (!p) throw new HttpError(404, 'No payment gateway is set up.')
      if (!p.verify(raw, String(req.headers['x-razorpay-signature'] ?? req.headers['x-signature'] ?? ''))) throw new HttpError(401, 'Bad signature.')
      let body: unknown
      try { body = JSON.parse(raw.toString('utf8')) } catch { throw new HttpError(400, 'Not JSON.') }
      const paid = p.paid(body)
      if (!paid) return { ok: true, ignored: true }
      return db.tx((t) => recordGatewayPayment(ctx, t, paid.linkId, paid.paymentId, paid.method, paid.amountPaise))
    })
  })
}
