import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { accommodationNight } from '@sathya/tax'
import { appendAudit } from './audit-store'
import type { Caller, Ctx } from './context'
import type { Db } from './db'
import { businessDate, freeByNight, nightsOf, rateFor } from './fo-core'
import { issueReceiptVoucher } from './invoicing'

// Guest channels: the links guests get (signed, so a booking cannot be opened by guessing its number), the
// selling rules (stop-sell, minimum stay, closed to arrival or departure), availability and rates for a
// channel manager, payment links, and payments that arrive from the gateway.

/** Bookings, payments and messages that arrive by themselves are made by this login, which cannot sign in. */
export const ONLINE: Caller = { userId: 'system', name: 'Online', role: 'system', roles: [], godMode: false, permissions: new Set(), sessionId: '', scope: 'full' }

let secret: string | null = null
/** The server's own key for signing guests' links, made once and kept in the database. */
export async function linkSecret(db: Db, now = new Date()) {
  if (secret) return secret
  if (process.env.PUBLIC_LINK_SECRET) return (secret = process.env.PUBLIC_LINK_SECRET)
  await db.query('insert into app_secret (name, value, created_at) values ($1, $2, $3) on conflict (name) do nothing', ['guest_links', randomBytes(32).toString('hex'), now])
  const [r] = await db.query<{ value: string }>('select value from app_secret where name = $1', ['guest_links'])
  return (secret = r.value)
}
export const signFor = (key: string, reservationId: string) => createHmac('sha256', key).update(`booking:${reservationId}`).digest('base64url').slice(0, 22)
export async function linkToken(db: Db, reservationId: string) { return signFor(await linkSecret(db), reservationId) }
export async function tokenOk(db: Db, reservationId: string, token: string) {
  const want = Buffer.from(await linkToken(db, reservationId)), got = Buffer.from(String(token ?? ''))
  return want.length === got.length && timingSafeEqual(want, got)
}

export interface Restriction { day: string; stop_sell: boolean; min_stay: number | null; cta: boolean; ctd: boolean }

export async function restrictionsFor(db: Db, roomTypeId: string, from: string, to: string) {
  return db.query<Restriction>('select day::text, stop_sell, min_stay, cta, ctd from rate_restriction where room_type_id = $1 and day between $2 and $3 order by day', [roomTypeId, from, to])
}

/** Why a stay cannot be sold online, or null: stop-sell, minimum stay, closed to arrival or departure. */
export async function sellingRuleBroken(db: Db, roomTypeId: string, arrival: string, departure: string) {
  const nights = nightsOf(arrival, departure)
  const rs = await restrictionsFor(db, roomTypeId, arrival, departure)
  const on = (d: string) => rs.find((r) => r.day === d)
  for (const n of nights) if (on(n)?.stop_sell) return `Not available on ${n}.`
  const a = on(arrival)
  if (a?.cta) return `No arrivals on ${arrival}.`
  if (on(departure)?.ctd) return `No departures on ${departure}.`
  if (a?.min_stay && nights.length < a.min_stay) return `A stay from ${arrival} is at least ${a.min_stay} nights.`
  return null
}

/** Rooms free and the price of each meal plan for a room type over the nights (with GST night by night). */
export async function quoteStay(ctx: Ctx, db: Db, roomTypeId: string, arrival: string, departure: string) {
  const nights = nightsOf(arrival, departure)
  const free = Math.min(...(await freeByNight(db, roomTypeId, nights)).map((x) => x.free))
  const plans = await db.query<{ code: string; name: string; meal_plan: string }>('select code, name, meal_plan from rate_plan where active order by code')
  const prices = []
  for (const p of plans) {
    const amounts: number[] = []
    for (const n of nights) { const a = await rateFor(db, p.code, roomTypeId, n); if (a == null) break; amounts.push(a) }
    if (amounts.length !== nights.length) continue
    const tax = nights.map((n, i) => accommodationNight(ctx.tax, { date: n, charged: amounts[i], extras: 0 }))
    prices.push({ plan: p.code, name: p.name, nightly: amounts, roomPaise: amounts.reduce((x, y) => x + y, 0), gstPaise: tax.reduce((x, t) => x + t.cgst + t.sgst, 0),
      firstNightPaise: amounts[0] + tax[0].cgst + tax[0].sgst })
  }
  return { free: Math.max(0, free), nights: nights.length, prices: prices.sort((a, b) => a.roomPaise - b.roomPaise) }
}

/** Availability, rates and selling rules for a channel manager, room type by room type, night by night. */
export async function buildAri(db: Db, from: string, days: number) {
  const nights = nightsOf(from, new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10))
  const to = nights[nights.length - 1]
  const types = await db.query<{ id: string; name: string; max_occupancy: number }>('select id, name, max_occupancy from room_type where active order by base_rate_paise')
  const plans = await db.query<{ code: string }>('select code from rate_plan where active order by code')
  const maps = await db.query<{ channel: string; code: string; room_type_id: string; plan_code: string }>('select * from channel_map order by channel, code')
  const out = []
  for (const t of types) {
    const free = await freeByNight(db, t.id, nights)
    const rs = await restrictionsFor(db, t.id, from, to)
    const rates: Record<string, (number | null)[]> = {}
    for (const p of plans) { rates[p.code] = []; for (const n of nights) rates[p.code].push(await rateFor(db, p.code, t.id, n)) }
    out.push({ roomTypeId: t.id, name: t.name, maxOccupancy: t.max_occupancy, codes: maps.filter((m) => m.room_type_id === t.id).map((m) => ({ channel: m.channel, code: m.code, plan: m.plan_code })),
      nights: nights.map((n, i) => { const r = rs.find((x) => x.day === n)
        return { date: n, available: Math.max(0, free[i].free), stopSell: !!r?.stop_sell, minStay: r?.min_stay ?? null, cta: !!r?.cta, ctd: !!r?.ctd,
          rates: Object.fromEntries(plans.map((p) => [p.code, rates[p.code][i]])) } }) })
  }
  return { from, to, currency: 'INR', amountsIn: 'paise, before GST', roomTypes: out }
}

// ---------- payment links ----------

export interface PaymentProvider {
  name: string
  createLink(i: { amountPaise: number; reference: string; description: string; customer: { name: string; mobile?: string | null; email?: string | null }; expireBy: Date; callbackUrl?: string }): Promise<{ id: string; url: string }>
  /** Checks a webhook's signature over its exact bytes. */
  verify(raw: Buffer, signature: string): boolean
  /** A paid link from a webhook body, or null for other events. */
  paid(body: unknown): { linkId: string; paymentId: string; method: string; amountPaise: number } | null
}

/** Razorpay payment links (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET). To be tried on the resort's account first. */
export function razorpay(keyId: string, keySecret: string, webhookSecret: string): PaymentProvider {
  return {
    name: 'razorpay',
    async createLink(i) {
      const r = await fetch('https://api.razorpay.com/v1/payment_links', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` },
        body: JSON.stringify({ amount: i.amountPaise, currency: 'INR', accept_partial: false, reference_id: i.reference, description: i.description.slice(0, 2048),
          expire_by: Math.floor(i.expireBy.getTime() / 1000), customer: { name: i.customer.name, contact: i.customer.mobile ?? undefined, email: i.customer.email ?? undefined },
          notify: { sms: !!i.customer.mobile, email: !!i.customer.email }, reminder_enable: false, callback_url: i.callbackUrl, callback_method: i.callbackUrl ? 'get' : undefined }),
      })
      const j = await r.json() as { id?: string; short_url?: string; error?: { description?: string } }
      if (!r.ok || !j.id || !j.short_url) throw new Error(`Razorpay: ${j.error?.description ?? r.status}`)
      return { id: j.id, url: j.short_url }
    },
    verify(raw, signature) {
      const want = Buffer.from(createHmac('sha256', webhookSecret).update(raw).digest('hex')), got = Buffer.from(String(signature ?? ''))
      return want.length === got.length && timingSafeEqual(want, got)
    },
    paid(body) {
      const b = body as { event?: string; payload?: { payment_link?: { entity?: { id?: string } }; payment?: { entity?: { id?: string; method?: string; amount?: number } } } }
      if (b?.event !== 'payment_link.paid') return null
      const link = b.payload?.payment_link?.entity, pay = b.payload?.payment?.entity
      if (!link?.id || !pay?.id) return null
      return { linkId: link.id, paymentId: pay.id, method: pay.method ?? 'upi', amountPaise: Number(pay.amount ?? 0) }
    },
  }
}

export function paymentProviderFromEnv(): PaymentProvider | undefined {
  const { RAZORPAY_KEY_ID: id, RAZORPAY_KEY_SECRET: key, RAZORPAY_WEBHOOK_SECRET: hook } = process.env
  return id && key && hook ? razorpay(id, key, hook) : undefined
}

const METHOD: Record<string, string> = { card: 'card', upi: 'upi', netbanking: 'bank', wallet: 'upi', emi: 'card' }

/** A payment that came through the gateway: onto the guest's bill, with a receipt voucher before the stay. */
export async function recordGatewayPayment(ctx: Ctx, t: Db, linkId: string, paymentId: string, method: string, amountPaise: number) {
  const [l] = await t.query<{ id: string; reservation_id: string; status: string; amount_paise: string }>('select * from payment_link where provider_id = $1 for update', [linkId])
  if (!l) return { ok: false, reason: 'unknown link' }
  if (l.status === 'paid') return { ok: true, duplicate: true }
  const [f] = await t.query<{ id: string }>('select id from folio where reservation_id = $1 order by created_at limit 1', [l.reservation_id])
  const [res] = await t.query<{ status: string }>('select status from reservation where id = $1', [l.reservation_id])
  const how = METHOD[method] ?? 'upi'
  const lineId = `L-${randomBytes(4).toString('hex').toUpperCase()}`
  const now = ctx.now()
  await t.query(`insert into folio_line (id, folio_id, business_date, posted_at, kind, description, amount_paise, posted_by, ref) values ($1,$2,$3,$4,'payment',$5,$6,'system',$7)`,
    [lineId, f.id, await businessDate(t), now, `Payment · ${how.toUpperCase()} (online)`, -amountPaise, paymentId])
  const voucher = res.status === 'confirmed' ? await issueReceiptVoucher(ctx, t, ONLINE, l.reservation_id, amountPaise) : null
  await t.query(`insert into payment (id, folio_id, line_id, method, amount_paise, reference, received_by, at, voucher_id) values ($1,$2,$3,$4,$5,$6,'system',$7,$8)`,
    [`P-${randomBytes(4).toString('hex').toUpperCase()}`, f.id, lineId, how, amountPaise, paymentId, now, voucher?.id ?? null])
  await t.query(`update payment_link set status = 'paid', paid_at = $2, payment_ref = $3 where id = $1`, [l.id, now, paymentId])
  await t.query('update reservation set pay_by = null where id = $1', [l.reservation_id])
  await appendAudit(t, { actor: ONLINE, action: 'payment.online', entity: { type: 'reservation', id: l.reservation_id }, amount: amountPaise, after: { method: how, reference: paymentId, voucher: voucher?.number ?? null } }, now)
  return { ok: true }
}

/** Website bookings whose deposit was not paid in time are cancelled, freeing the rooms. */
export async function sweepUnpaid(db: Db, now: Date) {
  return db.tx(async (t) => {
    const gone = await t.query<{ id: string }>(`update reservation set status = 'cancelled', cancel_reason = 'Deposit not paid in time (website booking)', pay_by = null
      where status = 'confirmed' and pay_by is not null and pay_by < $1 returning id`, [now])
    for (const r of gone) {
      await t.query('update room_night set released = true where reservation_id = $1', [r.id])
      await t.query(`update payment_link set status = 'expired' where reservation_id = $1 and status = 'created'`, [r.id])
      await appendAudit(t, { actor: ONLINE, action: 'reservation.cancel_unpaid', entity: { type: 'reservation', id: r.id } }, now)
    }
    return gone.length
  })
}
