import type { FastifyInstance, FastifyRequest } from 'fastify'
import { cashReceiptCheck, financialYear, rupees, validateGstin } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, newId } from '../eng-core'
import { businessDate } from '../fo-core'

/** The day in India a function starts on. */
const istDay = (d: Date | string) => new Date(new Date(d).getTime() + 330 * 60_000).toISOString().slice(0, 10)
import { nextSeriesNumber } from '../invoicing'
import { checkCredit, CreditError } from '../receivables'
import {
  advancesHeld, BEO_DEPTS, beoDeptsOf, buildBeo, cancellationInvoice, canonical, CHECKS, clashes, eventInvoice, eventReceiptVoucher, eventRefundVoucher,
  FIRM, firmClashes, functionTimes, istDate, istTime, priceLines, STYLES, sumLines, sweepHolds, taxLines, VENUE_KINDS, type Beo, type GstKind,
} from '../banquets'
import { createApproval, registerApprovalKind, roleLimit } from './approvals'
import { normaliseMobile, requireCaller } from './auth'

// Banquets and events: the venue calendar, enquiries to contracts, advances on GST receipt vouchers, the event
// order (BEO) every department acknowledges, the final bill and the client's feedback.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const KINDS = ['wedding', 'reception', 'engagement', 'birthday', 'corporate', 'conference', 'social', 'other']
const SOURCES = ['walk_in', 'phone', 'website', 'referral', 'planner', 'repeat', 'corporate']
const METHODS = ['cash', 'card', 'upi', 'bank', 'cheque']
/** After the bill, the balance can also go to a company's credit account. */
const SETTLE = [...METHODS, 'company']
const GST_KINDS: GstKind[] = ['hall', 'catering', 'other']
const n = (v: unknown) => Number(v ?? 0)
const str = (v: unknown, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

interface EventRow {
  id: string; number: string; kind: string; title: string; client_name: string; client_mobile: string | null; client_email: string | null; company: string | null; gstin: string | null
  billing_address: string | null; source: string; owner_id: string | null; expected_pax: number | null; status: string; hold_until: string | null; site_visit_on: string | null; notes: string | null
  instructions: Record<string, string>; contract_signed_on: string | null; lost_reason: string | null; lost_to: string | null; cancel_reason: string | null; feedback_score: number | null; feedback_note: string | null
  created_at: Date; updated_at: Date
}

/** Dates as YYYY-MM-DD text, not timestamps. */
const EVENT_COLS = `event.*, event.hold_until::text as hold_until, event.site_visit_on::text as site_visit_on, event.contract_signed_on::text as contract_signed_on`

registerApprovalKind('event.discount', {
  permission: 'discount.approve',
  async apply(t, p) {
    await t.query(`update event_quote set status = 'issued' where id = $1 and status = 'awaiting_approval'`, [p.quoteId])
    await t.query(`update event set status = case when status = 'enquiry' then 'quoted' else status end where id = $1`, [p.eventId])
  },
  async reject(t, p) { await t.query(`update event_quote set status = 'rejected' where id = $1 and status = 'awaiting_approval'`, [p.quoteId]) },
})

export function banquetRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const VIEW = ['events.view', 'events.manage', 'events.payment', 'events.bill', 'venues.manage']
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id

  async function loadEvent(t: Db, id: string, lock = false) {
    const [e] = await t.query<EventRow>(`select ${EVENT_COLS} from event where id = $1${lock ? ' for update' : ''}`, [id])
    if (!e) throw new HttpError(404, 'No such event.')
    return e
  }
  const audit = (t: Db, who: Caller, action: string, e: { id: string; number: string }, extra: { amount?: number; after?: unknown; note?: string } = {}) =>
    appendAudit(t, { actor: who, action, entity: { type: 'event', id: e.id }, amount: extra.amount, after: extra.after as Record<string, unknown> | undefined, note: extra.note ?? e.number }, now())
  const touch = (t: Db, id: string) => t.query('update event set updated_at = $2 where id = $1', [id, now()])
  const open = (e: EventRow) => { if (!['enquiry', 'quoted', 'hold', 'definite'].includes(e.status)) throw new HttpError(409, `This event is ${e.status}.`) }

  // ---------- venues and packages ----------
  app.get('/api/banquets/venues', async (req) => {
    await need(req, ...VIEW, 'beo.view')
    const venues = await db.query<{ id: string; kind: string; name: string; capacity: number | null; rental_paise: string | null; turnaround_minutes: number }>(
      `select id, kind, name, capacity, rental_paise, turnaround_minutes from space where kind = any($1) and active order by capacity desc nulls last, name`, [VENUE_KINDS])
    const setups = await db.query<{ space_id: string; style: string; capacity: number }>('select space_id, style, capacity from venue_setup')
    return venues.map((v) => ({ ...v, rental_paise: n(v.rental_paise), setups: Object.fromEntries(setups.filter((s) => s.space_id === v.id).map((s) => [s.style, s.capacity])) }))
  })

  app.put('/api/banquets/venues/:id', async (req) => {
    const who = await need(req, 'venues.manage')
    const b = (req.body ?? {}) as { rental?: number; turnaroundMinutes?: number; setups?: Record<string, number> }
    return db.tx(async (t) => {
      const [v] = await t.query<{ id: string; name: string }>('select id, name from space where id = $1 and kind = any($2)', [idOf(req), VENUE_KINDS])
      if (!v) throw new HttpError(404, 'No such venue.')
      if (b.rental != null) { if (!(b.rental >= 0)) throw new HttpError(400, 'Rental: ₹0 or more.'); await t.query('update space set rental_paise = $2 where id = $1', [v.id, rupees(b.rental)]) }
      if (b.turnaroundMinutes != null) {
        if (!Number.isInteger(b.turnaroundMinutes) || b.turnaroundMinutes < 0 || b.turnaroundMinutes > 1440) throw new HttpError(400, 'Turnaround: 0 to 1440 minutes.')
        await t.query('update space set turnaround_minutes = $2 where id = $1', [v.id, b.turnaroundMinutes])
      }
      for (const [style, cap] of Object.entries(b.setups ?? {})) {
        if (!STYLES.includes(style as never)) throw new HttpError(400, `Setup styles: ${STYLES.join(', ')}.`)
        if (!cap) await t.query('delete from venue_setup where space_id = $1 and style = $2', [v.id, style])
        else if (!(Number.isInteger(cap) && cap > 0)) throw new HttpError(400, 'Capacity: a whole number of guests.')
        else await t.query('insert into venue_setup (space_id, style, capacity) values ($1,$2,$3) on conflict (space_id, style) do update set capacity = excluded.capacity', [v.id, style, cap])
      }
      await appendAudit(t, { actor: who, action: 'venue.update', entity: { type: 'space', id: v.id }, after: b as Record<string, unknown>, note: v.name }, now())
      return { ok: true }
    })
  })

  app.get('/api/banquets/packages', async (req) => {
    await need(req, ...VIEW)
    return (await db.query<{ price_paise: string }>('select * from banquet_package order by active desc, kind, price_paise')).map((p) => ({ ...p, price_paise: n(p.price_paise) }))
  })

  function packageFields(b: Record<string, unknown>, partial: boolean) {
    const out: Record<string, unknown> = {}
    if (!partial || b.name !== undefined) { const name = str(b.name, 80); if (!name) throw new HttpError(400, 'A name for the package.'); out.name = name }
    if (!partial || b.kind !== undefined) { if (!['menu', 'decor', 'service'].includes(String(b.kind))) throw new HttpError(400, 'Kind: menu, decor or service.'); out.kind = b.kind }
    if (!partial || b.price !== undefined) { if (!(n(b.price) >= 0)) throw new HttpError(400, 'Price: ₹0 or more.'); out.price_paise = rupees(n(b.price)) }
    if (!partial || b.per !== undefined) { const per = b.per ?? (out.kind === 'menu' ? 'plate' : 'event'); if (!['plate', 'event'].includes(String(per))) throw new HttpError(400, 'Per plate or per event.'); out.per = per }
    if (b.veg !== undefined) out.veg = b.veg == null ? null : !!b.veg
    if (b.items !== undefined) out.items = (Array.isArray(b.items) ? b.items : String(b.items ?? '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 60)
    if (b.minPax !== undefined) { if (!(Number.isInteger(n(b.minPax)) && n(b.minPax) >= 0)) throw new HttpError(400, 'Minimum plates: a whole number.'); out.min_pax = n(b.minPax) }
    if (b.active !== undefined) out.active = !!b.active
    return out
  }

  app.post('/api/banquets/packages', async (req, reply) => {
    const who = await need(req, 'venues.manage')
    const f = packageFields((req.body ?? {}) as Record<string, unknown>, false)
    const id = newId('PKG')
    await db.tx(async (t) => {
      await t.query('insert into banquet_package (id, name, kind, price_paise, per, veg, items, min_pax, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, f.name, f.kind, f.price_paise, f.per, f.veg ?? null, f.items ?? [], f.min_pax ?? 0, now()])
      await appendAudit(t, { actor: who, action: 'banquet_package.add', entity: { type: 'banquet_package', id }, amount: f.price_paise as number, after: f }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/banquets/packages/:id', async (req) => {
    const who = await need(req, 'venues.manage')
    const f = packageFields((req.body ?? {}) as Record<string, unknown>, true)
    const keys = Object.keys(f)
    if (!keys.length) return { ok: true }
    return db.tx(async (t) => {
      const [p] = await t.query<{ price_paise: string }>('select price_paise from banquet_package where id = $1', [idOf(req)])
      if (!p) throw new HttpError(404, 'No such package.')
      await t.query(`update banquet_package set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [idOf(req), ...keys.map((k) => f[k])])
      await appendAudit(t, { actor: who, action: 'banquet_package.update', entity: { type: 'banquet_package', id: idOf(req) }, before: { price_paise: n(p.price_paise) }, after: f }, now())
      return { ok: true }
    })
  })

  // ---------- the calendar ----------
  app.get('/api/banquets/calendar', async (req) => {
    await need(req, ...VIEW, 'beo.view')
    const q = req.query as { from?: string; to?: string }
    const from = DATE.test(q.from ?? '') ? q.from! : await businessDate(db)
    const to = DATE.test(q.to ?? '') ? q.to! : addDays(from, 13)
    if (to < from || addDays(from, 92) < to) throw new HttpError(400, 'Up to three months at a time.')
    await db.tx((t) => sweepHolds(t, now()))
    const rows = await db.query<{ id: string; name: string; venue_id: string; starts_at: Date; ends_at: Date; expected_pax: number; guaranteed_pax: number | null; setup_style: string; event_id: string; number: string; title: string; status: string; hold_until: string | null; kind: string; client: string; value: string | null; paid: string | null; fns: number; turnaround: number }>(
      `select f.id, f.name, f.venue_id, f.starts_at, f.ends_at, f.expected_pax, f.guaranteed_pax, f.setup_style, e.id as event_id, e.number, e.title, e.status, e.hold_until::text, e.kind,
              coalesce(e.company, e.client_name) as client, s.turnaround_minutes as turnaround,
              coalesce((select d.total_paise from tax_document d where d.event_id = e.id and d.doc_type = 'invoice' order by d.issued_at desc limit 1),
                       (select q.total_paise from event_quote q where q.event_id = e.id and q.status in ('accepted','issued') order by (q.status = 'accepted') desc, q.version desc limit 1)) as value,
              (select sum(p.amount_paise) from event_payment p where p.event_id = e.id) as paid,
              (select count(*)::int from event_function x where x.event_id = e.id) as fns
         from event_function f join event e on e.id = f.event_id join space s on s.id = f.venue_id
        where e.status = any($3) and f.ends_at > $1::timestamptz and f.starts_at < $2::timestamptz order by f.starts_at`,
      [`${from}T00:00:00+05:30`, `${addDays(to, 1)}T00:00:00+05:30`, ['enquiry', 'quoted', ...FIRM]])
    return {
      from, to,
      bookings: rows.map((r) => ({ functionId: r.id, name: r.name, venueId: r.venue_id, date: istDate(r.starts_at), from: istTime(r.starts_at), to: istTime(r.ends_at), startsAt: r.starts_at, endsAt: r.ends_at,
        pax: r.guaranteed_pax ?? r.expected_pax, style: r.setup_style, eventId: r.event_id, number: r.number, title: r.title, status: r.status, holdUntil: r.hold_until, kind: r.kind, firm: FIRM.includes(r.status),
        client: r.client, turnaroundMinutes: r.turnaround, valuePaise: Math.round(n(r.value) / r.fns), paidPaise: Math.round(n(r.paid) / r.fns) })),
    }
  })

  app.post('/api/banquets/check', async (req) => {
    await need(req, ...VIEW)
    const b = (req.body ?? {}) as { venueId?: string; date?: string; from?: string; to?: string; eventId?: string }
    if (!b.venueId || !DATE.test(b.date ?? '') || !TIME.test(b.from ?? '') || !TIME.test(b.to ?? '')) throw new HttpError(400, 'Send venueId, date, from and to (HH:MM).')
    const { starts, ends } = functionTimes(b.date!, b.from!, b.to!)
    return { clashes: await clashes(db, b.venueId, starts, ends, b.eventId ?? null) }
  })

  // ---------- events ----------
  app.get('/api/banquets/events', async (req) => {
    await need(req, ...VIEW)
    await db.tx((t) => sweepHolds(t, now()))
    const status = (req.query as { status?: string }).status
    const rows = await db.query<EventRow & { owner: string | null; first_at: Date | null; last_at: Date | null; venues: string[] | null; pax: number | null; quote_total: string | null; quote_status: string | null; paid: string | null; billed: string | null; overdue: string | null; beo_rev: number | null; checks_open: number }>(
      `select e.*, e.hold_until::text as hold_until, u.name as owner,
              (select min(f.starts_at) from event_function f where f.event_id = e.id) as first_at,
              (select max(f.ends_at) from event_function f where f.event_id = e.id) as last_at,
              (select array_agg(distinct s.name) from event_function f join space s on s.id = f.venue_id where f.event_id = e.id) as venues,
              (select max(coalesce(f.guaranteed_pax, f.expected_pax)) from event_function f where f.event_id = e.id) as pax,
              (select q.total_paise from event_quote q where q.event_id = e.id and q.status in ('accepted','issued','awaiting_approval') order by (q.status = 'accepted') desc, q.version desc limit 1) as quote_total,
              (select q.status from event_quote q where q.event_id = e.id and q.status <> 'superseded' order by q.version desc limit 1) as quote_status,
              (select sum(p.amount_paise) from event_payment p where p.event_id = e.id) as paid,
              (select d.total_paise from tax_document d where d.event_id = e.id and d.doc_type = 'invoice' order by d.issued_at desc limit 1) as billed,
              (select count(*) from event_milestone m where m.event_id = e.id and m.due_on < $2
                  and (select coalesce(sum(m2.amount_paise), 0) from event_milestone m2 where m2.event_id = e.id and m2.seq <= m.seq)
                      > (select coalesce(sum(p.amount_paise), 0) from event_payment p where p.event_id = e.id)) as overdue,
              (select max(revision) from event_beo b where b.event_id = e.id) as beo_rev,
              (select count(*)::int from event_check c where c.event_id = e.id and c.status in ('pending','applied')) as checks_open
         from event e left join app_user u on u.id = e.owner_id
        where ($1::text is null or e.status = $1) order by coalesce((select min(f.starts_at) from event_function f where f.event_id = e.id), e.created_at)`,
      [status ?? null, await businessDate(db)])
    return rows.map((r) => ({ id: r.id, number: r.number, kind: r.kind, title: r.title, client: r.client_name, company: r.company, status: r.status, holdUntil: r.hold_until, owner: r.owner,
      date: r.first_at ? istDate(r.first_at) : null, lastDate: r.last_at ? istDate(r.last_at) : null, venues: r.venues ?? [], pax: r.pax ?? r.expected_pax, source: r.source,
      quotePaise: n(r.quote_total), quoteStatus: r.quote_status, paidPaise: n(r.paid), billedPaise: r.billed == null ? null : n(r.billed), overdue: n(r.overdue), beoRevision: r.beo_rev, checksOpen: r.checks_open, lostReason: r.lost_reason }))
  })

  function clientFields(b: Record<string, unknown>, partial: boolean) {
    const out: Record<string, unknown> = {}
    const set = (k: string, col: string, max = 120) => { if (b[k] !== undefined) out[col] = str(b[k], max) }
    if (!partial || b.title !== undefined) { const t = str(b.title, 120); if (!t) throw new HttpError(400, 'A name for the event, e.g. "Ravi and Priya wedding".'); out.title = t }
    if (!partial || b.clientName !== undefined) { const c = str(b.clientName, 120); if (!c) throw new HttpError(400, 'The client\'s name.'); out.client_name = c }
    if (!partial || b.kind !== undefined) { const k = b.kind ?? 'wedding'; if (!KINDS.includes(String(k))) throw new HttpError(400, `Kind: ${KINDS.join(', ')}.`); out.kind = k }
    if (b.source !== undefined) { if (!SOURCES.includes(String(b.source))) throw new HttpError(400, `Source: ${SOURCES.join(', ')}.`); out.source = b.source }
    if (b.clientMobile !== undefined) {
      const m = str(b.clientMobile, 20)
      if (m) { const nm = normaliseMobile(m); if (!/^\+91[6-9]\d{9}$/.test(nm)) throw new HttpError(400, 'Mobile: a 10-digit Indian number.'); out.client_mobile = nm } else out.client_mobile = null
    }
    if (b.clientEmail !== undefined) { const e = str(b.clientEmail, 254)?.toLowerCase() ?? null; if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'That email does not look right.'); out.client_email = e }
    set('company', 'company'); set('billingAddress', 'billing_address', 300); set('notes', 'notes', 2000)
    if (b.gstin !== undefined) { if (!b.gstin) out.gstin = null; else { const g = validateGstin(String(b.gstin)); if (!g.ok) throw new HttpError(400, g.reason); out.gstin = g.gstin } }
    if (b.expectedPax !== undefined) { if (b.expectedPax != null && !(Number.isInteger(n(b.expectedPax)) && n(b.expectedPax) > 0)) throw new HttpError(400, 'Guests: a whole number.'); out.expected_pax = b.expectedPax == null ? null : n(b.expectedPax) }
    if (b.siteVisitOn !== undefined) { if (b.siteVisitOn && !DATE.test(String(b.siteVisitOn))) throw new HttpError(400, 'Site visit: a date.'); out.site_visit_on = b.siteVisitOn || null }
    if (b.ownerId !== undefined) out.owner_id = b.ownerId || null
    if (b.debtorId !== undefined) out.debtor_id = b.debtorId || null
    return out
  }
  /** An event for a company account takes the account's name, GSTIN and address for the bill unless given. */
  async function withAccount(t: Db, f: Record<string, unknown>) {
    if (!f.debtor_id) return f
    const [d] = await t.query<{ name: string; gstin: string | null; address: string | null; city: string | null }>('select name, gstin, address, city from debtor where id = $1', [f.debtor_id])
    if (!d) throw new HttpError(404, 'No such company account.')
    return { company: d.name, gstin: d.gstin, billing_address: [d.address, d.city].filter(Boolean).join(', ') || null, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v != null)) }
  }

  app.post('/api/banquets/events', async (req, reply) => {
    const who = await need(req, 'events.manage')
    const b = (req.body ?? {}) as Record<string, unknown>
    let f = clientFields(b, false)
    return db.tx(async (t) => {
      f = await withAccount(t, f)
      const id = newId('EV')
      const number = await nextSeriesNumber(t, 'event', financialYear(await businessDate(t)), 'EV')
      const cols = ['id', 'number', 'owner_id', 'created_by', 'created_at', 'updated_at', ...Object.keys(f).filter((k) => k !== 'owner_id')]
      const vals = [id, number, f.owner_id ?? who.userId, who.userId, now(), now(), ...Object.keys(f).filter((k) => k !== 'owner_id').map((k) => f[k])]
      await t.query(`insert into event (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals)
      for (const item of Object.keys(CHECKS)) await t.query('insert into event_check (event_id, item) values ($1, $2)', [id, item])
      await audit(t, who, 'event.enquiry', { id, number }, { after: { title: f.title, kind: f.kind, client: f.client_name } })
      return reply.status(201).send({ id, number })
    })
  })

  /**
   * Book an event in one go, as the sales desk would on the phone: the client, the functions (venue, day,
   * times, guests, menu), and whether to book it, hold the dates or keep it as an enquiry, with any advance
   * taken now. It runs the usual steps (enquiry, quote, acceptance, contract, payment), so every rule and
   * approval still applies; the venue is checked before anything is saved.
   */
  app.post('/api/banquets/book', async (req, reply) => {
    await need(req, 'events.manage')
    const b = (req.body ?? {}) as { title?: string; kind?: string; clientName?: string; clientMobile?: string; clientEmail?: string; company?: string; gstin?: string; billingAddress?: string; source?: string; notes?: string
      functions?: { name?: string; venueId?: string; date?: string; from?: string; to?: string; style?: string; expectedPax?: number; menuId?: string | null; rental?: number | null }[]
      action?: 'book' | 'hold' | 'enquiry'; discountPercent?: number; advance?: { method?: string; amount?: number; reference?: string } }
    const action = b.action ?? 'book'
    if (!['book', 'hold', 'enquiry'].includes(action)) throw new HttpError(400, 'Book it, hold the dates, or keep it as an enquiry.')
    if (!str(b.clientName)) throw new HttpError(400, 'The client\'s name.')
    if (!b.functions?.length) throw new HttpError(400, 'At least one function: the venue, day and times.')
    // The venue first (free, and big enough), so nothing is saved for a booking that cannot be made.
    for (const f of b.functions) {
      const label = f.name || 'The function'
      if (!f.venueId || !DATE.test(f.date ?? '') || !TIME.test(f.from ?? '') || !TIME.test(f.to ?? '')) throw new HttpError(400, `${label}: pick the venue, the day and the times.`)
      if (!(Number.isInteger(Number(f.expectedPax)) && Number(f.expectedPax) > 0)) throw new HttpError(400, `${label}: how many guests.`)
      const [cap] = await db.query<{ capacity: number; name: string }>('select v.capacity, s.name from venue_setup v join space s on s.id = v.space_id where v.space_id = $1 and v.style = $2', [f.venueId, f.style ?? 'rounds'])
      if (cap && Number(f.expectedPax) > cap.capacity) throw new HttpError(400, `${label}: ${cap.name} seats ${cap.capacity} in this setup, not ${f.expectedPax}.`)
      if (action === 'enquiry') continue
      const { starts, ends } = functionTimes(f.date!, f.from!, f.to!)
      const firm = (await clashes(db, f.venueId, starts, ends, null)).find((c) => c.firm)
      if (firm) throw new HttpError(409, `${label}: the venue is already ${firm.status === 'hold' ? 'held' : 'booked'} then for ${firm.title} (${firm.number}). Pick another time or venue.`)
    }
    const headers = { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' }
    const call = async (url: string, payload: unknown = {}) => {
      const r = await app.inject({ method: 'POST', url, headers, payload: payload as object })
      const body = r.json() as Record<string, unknown>
      return r.statusCode < 300 ? { ok: true as const, body } : { ok: false as const, body, status: r.statusCode }
    }
    const kind = b.kind ?? 'wedding'
    const ev = await call('/api/banquets/events', { title: str(b.title, 120) ?? `${str(b.clientName, 80)} · ${kind}`, kind, clientName: b.clientName, clientMobile: b.clientMobile, clientEmail: b.clientEmail,
      company: b.company, gstin: b.gstin, billingAddress: b.billingAddress, source: b.source, notes: b.notes, expectedPax: Math.max(...b.functions.map((f) => Number(f.expectedPax) || 0)) || undefined })
    if (!ev.ok) throw new HttpError(ev.status, String(ev.body.error ?? 'Could not save the event.'))
    const id = String(ev.body.id), number = String(ev.body.number)
    // Saved so far: an enquiry the desk can open and finish.
    const stop = (status: number, msg: string) => reply.status(status).send({ error: `${msg} The event is saved as ${number}: open it to finish.`, id, number })
    for (const f of b.functions) {
      const r = await call(`/api/banquets/events/${id}/functions`, { name: f.name || 'Function', venueId: f.venueId, date: f.date, from: f.from, to: f.to, style: f.style ?? 'rounds', expectedPax: Number(f.expectedPax), menuId: f.menuId || null, rental: f.rental ?? null })
      if (!r.ok) return stop(r.status, String(r.body.error))
    }
    let status = 'enquiry'
    if (action !== 'enquiry') {
      const q = await call(`/api/banquets/events/${id}/quote`, { discountPercent: Number(b.discountPercent ?? 0) })
      if (!q.ok) return stop(q.status, String(q.body.error))
      if (q.body.status === 'awaiting_approval') return reply.status(201).send({ id, number, status: 'quoted', note: 'The discount is above your limit: the quote waits for the GM, then the contract can be signed.' })
      status = 'quoted'
      if (action === 'hold') {
        const h = await call(`/api/banquets/events/${id}/hold`, {})
        if (!h.ok) return stop(h.status, String(h.body.error))
        status = 'hold'
      } else {
        const a = await call(`/api/banquets/quotes/${q.body.id}/accept`)
        if (!a.ok) return stop(a.status, String(a.body.error))
        const c = await call(`/api/banquets/events/${id}/contract`, {})
        if (!c.ok) return stop(c.status, String(c.body.error))
        status = 'definite'
      }
    }
    if (b.advance && Number(b.advance.amount) > 0) {
      const p = await call(`/api/banquets/events/${id}/payments`, { method: b.advance.method, amount: Number(b.advance.amount), reference: b.advance.reference })
      if (!p.ok) return reply.status(p.status).send({ error: `${String(p.body.error)} The event is ${status === 'definite' ? 'booked' : status === 'hold' ? 'on hold' : 'saved'} as ${number}; take the advance from it.`, id, number })
    }
    return reply.status(201).send({ id, number, status })
  })

  app.patch('/api/banquets/events/:id', async (req) => {
    const who = await need(req, 'events.manage')
    const b = (req.body ?? {}) as Record<string, unknown>
    let f = clientFields(b, true)
    if (b.instructions !== undefined) {
      const ins = (b.instructions ?? {}) as Record<string, unknown>
      for (const k of Object.keys(ins)) if (!BEO_DEPTS[k]) throw new HttpError(400, `Instructions for: ${Object.keys(BEO_DEPTS).join(', ')}.`)
      f.instructions = Object.fromEntries(Object.entries(ins).map(([k, v]) => [k, String(v ?? '').slice(0, 2000)]))
    }
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (['closed', 'lost', 'cancelled'].includes(e.status)) throw new HttpError(409, `This event is ${e.status}.`)
      if (f.debtor_id && f.debtor_id !== (e as EventRow & { debtor_id: string | null }).debtor_id) f = await withAccount(t, f)
      if (f.instructions) f.instructions = { ...e.instructions, ...(f.instructions as object) }
      const keys = Object.keys(f)
      if (keys.length) await t.query(`update event set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = $${keys.length + 2} where id = $1`, [e.id, ...keys.map((k) => k === 'instructions' ? JSON.stringify(f[k]) : f[k]), now()])
      await audit(t, who, 'event.update', e, { after: f })
      return { ok: true }
    })
  })

  app.get('/api/banquets/events/:id', async (req) => {
    const who = await need(req, ...VIEW)
    await db.tx((t) => sweepHolds(t, now()))
    const e = await loadEvent(db, idOf(req))
    const [owner] = e.owner_id ? await db.query<{ name: string }>('select name from app_user where id = $1', [e.owner_id]) : []
    const fns = await db.query<{ id: string; name: string; venue_id: string; venue: string; starts_at: Date; ends_at: Date; setup_style: string; expected_pax: number; guaranteed_pax: number | null; actual_pax: number | null; menu_id: string | null; menu: string | null; rental_paise: string | null; venue_rental: string | null; capacity: number | null }>(
      `select f.*, s.name as venue, s.rental_paise as venue_rental, vs.capacity, p.name as menu from event_function f join space s on s.id = f.venue_id
         left join venue_setup vs on vs.space_id = f.venue_id and vs.style = f.setup_style left join banquet_package p on p.id = f.menu_id
        where f.event_id = $1 order by f.starts_at, f.id`, [e.id])
    const functions = []
    for (const f of fns) {
      const cl = (await clashes(db, f.venue_id, new Date(f.starts_at), new Date(f.ends_at), e.id))
      functions.push({ id: f.id, name: f.name, venueId: f.venue_id, venue: f.venue, date: istDate(f.starts_at), from: istTime(f.starts_at), to: istTime(f.ends_at), style: f.setup_style,
        expectedPax: f.expected_pax, guaranteedPax: f.guaranteed_pax, actualPax: f.actual_pax, menuId: f.menu_id, menu: f.menu, capacity: f.capacity,
        rentalPaise: f.rental_paise != null ? n(f.rental_paise) : n(f.venue_rental), rentalOverride: f.rental_paise != null, clashes: cl })
    }
    const items = (await db.query<{ id: string; function_id: string | null; description: string; qty: string; rate_paise: string; gst_kind: string; package_id: string | null }>(
      'select id, function_id, description, qty, rate_paise, gst_kind, package_id from event_item where event_id = $1 order by created_at, id', [e.id]))
      .map((i) => ({ id: i.id, functionId: i.function_id, description: i.description, qty: n(i.qty), ratePaise: n(i.rate_paise), gstKind: i.gst_kind, packageId: i.package_id }))
    const quotes = (await db.query<{ id: string; version: number; status: string; discount_percent: string; taxable_paise: string; gst_paise: string; total_paise: string; valid_until: string; created_at: Date; accepted_at: Date | null; lines: unknown }>(
      'select id, version, status, discount_percent, taxable_paise, gst_paise, total_paise, valid_until::text, created_at, accepted_at, lines from event_quote where event_id = $1 order by version desc', [e.id]))
      .map((q) => ({ id: q.id, version: q.version, status: q.status, discountPercent: n(q.discount_percent), taxablePaise: n(q.taxable_paise), gstPaise: n(q.gst_paise), totalPaise: n(q.total_paise), validUntil: q.valid_until, createdAt: q.created_at, acceptedAt: q.accepted_at, lines: q.lines }))
    const accepted = quotes.find((q) => q.status === 'accepted')
    // Plates served above the guarantee show once they are entered, as the bill will charge them.
    const lines = taxLines(await priceLines(ctx, db, e.id, { bill: true }), accepted?.discountPercent ?? 0)
    const payments = (await db.query<{ id: string; kind: string; method: string; amount_paise: string; reference: string | null; business_date: string; received_at: Date; by: string; voucher: string | null; voucher_id: string | null }>(
      `select p.id, p.kind, p.method, p.amount_paise, p.reference, p.business_date::text, p.received_at, u.name as by, d.number as voucher, p.voucher_id
         from event_payment p join app_user u on u.id = p.received_by left join tax_document d on d.id = p.voucher_id where p.event_id = $1 order by p.received_at`, [e.id]))
      .map((p) => ({ ...p, amount_paise: n(p.amount_paise) }))
    const paid = payments.reduce((a, p) => a + p.amount_paise, 0)
    const today = await businessDate(db)
    let cum = 0
    const milestones = (await db.query<{ id: string; label: string; due_on: string; amount_paise: string }>('select id, label, due_on::text, amount_paise from event_milestone where event_id = $1 order by seq', [e.id]))
      .map((m) => { cum += n(m.amount_paise); const st = paid >= cum ? 'paid' : m.due_on < today ? 'overdue' : paid > cum - n(m.amount_paise) ? 'part' : 'due'; return { id: m.id, label: m.label, dueOn: m.due_on, amountPaise: n(m.amount_paise), status: st } })
    const checks = (await db.query<{ item: string; status: string; ref: string | null; updated_at: Date | null; by: string | null }>(
      'select c.item, c.status, c.ref, c.updated_at, u.name as by from event_check c left join app_user u on u.id = c.updated_by where c.event_id = $1 order by c.item', [e.id]))
      .map((c) => ({ ...c, label: CHECKS[c.item] ?? c.item }))
    const beos = await db.query<{ revision: number; issued_at: Date; by: string; content: Beo }>(
      'select b.revision, b.issued_at, u.name as by, b.content from event_beo b join app_user u on u.id = b.issued_by where b.event_id = $1 order by b.revision desc', [e.id])
    const acks = await db.query<{ revision: number; dept: string; by: string; acked_at: Date }>(
      'select a.revision, a.dept, u.name as by, a.acked_at from beo_ack a join app_user u on u.id = a.acked_by where a.event_id = $1', [e.id])
    const current = await buildBeo(db, e.id)
    const docs = await db.query<{ id: string; doc_type: string; number: string; issue_date: string; total_paise: string }>(
      `select id, doc_type, number, issue_date::text, total_paise from tax_document where event_id = $1 order by issued_at`, [e.id])
    const invoice = docs.filter((d) => d.doc_type === 'invoice').at(-1)
    const vendors = (await db.query<{ id: string; vendor_id: string; vendor: string; service: string; agreed_paise: string; notes: string | null; billed: string | null; paid: string | null }>(
      `select ev.id, ev.vendor_id, v.name as vendor, ev.service, ev.agreed_paise, ev.notes,
              (select sum(b.total_paise) from purchase_bill b where b.event_id = ev.event_id and b.vendor_id = ev.vendor_id and b.status <> 'cancelled') as billed,
              (select sum(b.paid_paise) from purchase_bill b where b.event_id = ev.event_id and b.vendor_id = ev.vendor_id and b.status <> 'cancelled') as paid
         from event_vendor ev join vendor v on v.id = ev.vendor_id where ev.event_id = $1 order by ev.created_at`, [e.id]))
      .map((v) => ({ id: v.id, vendorId: v.vendor_id, vendor: v.vendor, service: v.service, agreedPaise: n(v.agreed_paise), notes: v.notes, billedPaise: n(v.billed), paidPaise: n(v.paid) }))
    const [cost] = await db.query<{ c: string | null }>(`select sum(taxable_paise) as c from purchase_bill where event_id = $1 and status <> 'cancelled'`, [e.id])
    const ev2 = e as EventRow & { debtor_id: string | null }
    const [account] = ev2.debtor_id ? await db.query<{ id: string; name: string }>('select id, name from debtor where id = $1', [ev2.debtor_id]) : []
    const blocks = await db.query<{ id: string; number: string; name: string; status: string; arrival: string; departure: string }>(
      'select id, number, name, status, arrival::text, departure::text from room_block where event_id = $1 order by arrival', [e.id])
    return {
      account: account ?? null, vendors, vendorCostPaise: n(cost?.c), blocks,
      id: e.id, number: e.number, kind: e.kind, title: e.title, status: e.status, holdUntil: e.hold_until, source: e.source, owner: owner?.name ?? null, ownerId: e.owner_id,
      client: { name: e.client_name, mobile: e.client_mobile, email: e.client_email, company: e.company, gstin: e.gstin, address: e.billing_address },
      expectedPax: e.expected_pax, siteVisitOn: e.site_visit_on, notes: e.notes, instructions: current.instructions, contractSignedOn: e.contract_signed_on,
      lostReason: e.lost_reason, lostTo: e.lost_to, cancelReason: e.cancel_reason, feedback: e.feedback_score ? { score: e.feedback_score, note: e.feedback_note } : null,
      functions, items, quotes, priced: { lines, ...sumLines(lines) }, milestones, payments, paidPaise: paid, advancesHeldPaise: await advancesHeld(db, e.id),
      invoice: invoice ? { id: invoice.id, number: invoice.number, date: invoice.issue_date, totalPaise: n(invoice.total_paise), balancePaise: n(invoice.total_paise) - paid } : null,
      documents: docs.map((d) => ({ id: d.id, type: d.doc_type, number: d.number, date: d.issue_date, totalPaise: n(d.total_paise) })),
      checks, beo: { revisions: beos.map((b) => ({ revision: b.revision, issuedAt: b.issued_at, by: b.by, acks: acks.filter((a) => a.revision === b.revision) })), changed: !!beos[0] && canonical(beos[0].content) !== canonical(current), depts: BEO_DEPTS },
      // No limit (God Mode) is sent as null: JSON has no Infinity.
      limits: Object.fromEntries(Object.entries({ discountPercent: await roleLimit(db, who, 'package_discount_percent'), holdDays: await roleLimit(db, who, 'hold_dates_days') }).map(([k, v]) => [k, Number.isFinite(v) ? v : null])),
      today,
    }
  })

  // ---------- functions and extras ----------
  async function functionFields(t: Db, b: Record<string, unknown>, cur?: { venue_id: string; starts_at: Date; ends_at: Date }) {
    const out: Record<string, unknown> = {}
    if (b.name !== undefined || !cur) { const nm = str(b.name, 60); if (!nm) throw new HttpError(400, 'Name the function, e.g. "Muhurtham" or "Reception".'); out.name = nm }
    if (b.venueId !== undefined || !cur) {
      const [v] = await t.query('select 1 from space where id = $1 and kind = any($2) and active', [b.venueId, VENUE_KINDS])
      if (!v) throw new HttpError(400, 'Pick a venue.'); out.venue_id = b.venueId
    }
    if (b.date !== undefined || b.from !== undefined || b.to !== undefined || !cur) {
      const date = (b.date ?? (cur && istDate(cur.starts_at))) as string, from = (b.from ?? (cur && istTime(cur.starts_at))) as string, to = (b.to ?? (cur && istTime(cur.ends_at))) as string
      if (!DATE.test(date ?? '') || !TIME.test(from ?? '') || !TIME.test(to ?? '')) throw new HttpError(400, 'The day, and from and to as HH:MM.')
      const { starts, ends } = functionTimes(date, from, to)
      out.starts_at = starts; out.ends_at = ends
    }
    if (b.style !== undefined) { if (!STYLES.includes(b.style as never)) throw new HttpError(400, `Setup: ${STYLES.join(', ')}.`); out.setup_style = b.style }
    if (b.expectedPax !== undefined || !cur) { if (!(Number.isInteger(n(b.expectedPax)) && n(b.expectedPax) > 0)) throw new HttpError(400, 'Expected guests: a whole number.'); out.expected_pax = n(b.expectedPax) }
    if (b.guaranteedPax !== undefined) { if (b.guaranteedPax != null && b.guaranteedPax !== '' && !(Number.isInteger(n(b.guaranteedPax)) && n(b.guaranteedPax) > 0)) throw new HttpError(400, 'Guaranteed guests: a whole number.'); out.guaranteed_pax = b.guaranteedPax == null || b.guaranteedPax === '' ? null : n(b.guaranteedPax) }
    if (b.menuId !== undefined) {
      if (b.menuId) { const [p] = await t.query('select 1 from banquet_package where id = $1 and kind = $2 and active', [b.menuId, 'menu']); if (!p) throw new HttpError(400, 'Pick a menu package.') }
      out.menu_id = b.menuId || null
    }
    if (b.rental !== undefined) { if (b.rental != null && b.rental !== '' && !(n(b.rental) >= 0)) throw new HttpError(400, 'Rental: ₹0 or more.'); out.rental_paise = b.rental == null || b.rental === '' ? null : rupees(n(b.rental)) }
    return out
  }

  /** A change to a firm event's venue or time may not land on another firm booking. */
  async function guardFunction(t: Db, e: EventRow, venueId: string, starts: Date, ends: Date, style: string, pax: number) {
    const [cap] = await t.query<{ capacity: number }>('select capacity from venue_setup where space_id = $1 and style = $2', [venueId, style])
    if (cap && pax > cap.capacity) throw new HttpError(400, `This venue seats ${cap.capacity} in this setup.`)
    const cl = await clashes(t, venueId, starts, ends, e.id)
    if (FIRM.includes(e.status) && cl.some((c) => c.firm)) {
      const c = cl.find((x) => x.firm)!
      throw new HttpError(409, `The venue is taken: ${c.title} (${c.number}), ${istDate(c.startsAt)} ${istTime(c.startsAt)}–${istTime(c.endsAt)}, with the turnaround.`, { clashes: cl })
    }
    return cl
  }

  app.post('/api/banquets/events/:id/functions', async (req, reply) => {
    const who = await need(req, 'events.manage')
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      open(e)
      const f = await functionFields(t, (req.body ?? {}) as Record<string, unknown>)
      const cl = await guardFunction(t, e, f.venue_id as string, f.starts_at as Date, f.ends_at as Date, (f.setup_style as string) ?? 'rounds', (f.guaranteed_pax ?? f.expected_pax) as number)
      const id = newId('FN')
      const cols = ['id', 'event_id', 'created_at', ...Object.keys(f)]
      await t.query(`insert into event_function (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, [id, e.id, now(), ...Object.values(f)])
      await touch(t, e.id)
      await audit(t, who, 'event.function_add', e, { after: { name: f.name, venue: f.venue_id, starts: f.starts_at } })
      return reply.status(201).send({ id, clashes: cl })
    })
  })

  app.patch('/api/banquets/functions/:id', async (req) => {
    const who = await need(req, 'events.manage', 'events.bill')
    const b = (req.body ?? {}) as Record<string, unknown>
    return db.tx(async (t) => {
      const [cur] = await t.query<{ id: string; event_id: string; venue_id: string; starts_at: Date; ends_at: Date; setup_style: string; expected_pax: number; guaranteed_pax: number | null }>('select * from event_function where id = $1 for update', [idOf(req)])
      if (!cur) throw new HttpError(404, 'No such function.')
      const e = await loadEvent(t, cur.event_id, true)
      // Guests actually served are entered on the day, for the bill.
      if (b.actualPax !== undefined) {
        if (!can(who, 'events.bill') && !can(who, 'events.manage')) throw new HttpError(403, 'Your role cannot do this.')
        if (!['definite'].includes(e.status)) throw new HttpError(409, 'Guests served are entered once the event is definite, before the bill.')
        const fnDay = istDay(cur.starts_at)
        if (fnDay > await businessDate(t)) throw new HttpError(409, `This function is on ${fnDay.split('-').reverse().join('/')}. Enter the guests served on or after that day.`)
        if (!(Number.isInteger(n(b.actualPax)) && n(b.actualPax) >= 0)) throw new HttpError(400, 'Guests served: a whole number.')
        await t.query('update event_function set actual_pax = $2 where id = $1', [cur.id, n(b.actualPax)])
        await audit(t, who, 'event.actual_pax', e, { after: { function: cur.id, pax: n(b.actualPax) } })
        delete b.actualPax
        if (!Object.keys(b).length) return { ok: true }
      }
      if (!can(who, 'events.manage')) throw new HttpError(403, 'Your role cannot do this.')
      open(e)
      const f = await functionFields(t, b, cur)
      const venue = (f.venue_id ?? cur.venue_id) as string, starts = (f.starts_at ?? cur.starts_at) as Date, ends = (f.ends_at ?? cur.ends_at) as Date
      const pax = ((f.guaranteed_pax !== undefined ? f.guaranteed_pax : cur.guaranteed_pax) ?? f.expected_pax ?? cur.expected_pax) as number
      const cl = await guardFunction(t, e, venue, new Date(starts), new Date(ends), (f.setup_style ?? cur.setup_style) as string, pax)
      const keys = Object.keys(f)
      if (keys.length) await t.query(`update event_function set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [cur.id, ...keys.map((k) => f[k])])
      await touch(t, e.id)
      await audit(t, who, 'event.function_update', e, { after: f })
      return { ok: true, clashes: cl }
    })
  })

  app.delete('/api/banquets/functions/:id', async (req) => {
    const who = await need(req, 'events.manage')
    return db.tx(async (t) => {
      const [cur] = await t.query<{ id: string; event_id: string; name: string }>('select id, event_id, name from event_function where id = $1', [idOf(req)])
      if (!cur) throw new HttpError(404, 'No such function.')
      const e = await loadEvent(t, cur.event_id, true)
      open(e)
      await t.query('delete from event_item where function_id = $1', [cur.id])
      await t.query('delete from event_function where id = $1', [cur.id])
      await touch(t, e.id)
      await audit(t, who, 'event.function_remove', e, { note: `${e.number}: ${cur.name}` })
      return { ok: true }
    })
  })

  app.post('/api/banquets/events/:id/items', async (req, reply) => {
    const who = await need(req, 'events.manage')
    const b = (req.body ?? {}) as { description?: string; qty?: number; rate?: number; gstKind?: GstKind; functionId?: string; packageId?: string }
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      open(e)
      let description = str(b.description, 160), rate = b.rate, kind = b.gstKind
      if (b.packageId) {
        const [p] = await t.query<{ name: string; price_paise: string; kind: string }>('select name, price_paise, kind from banquet_package where id = $1 and active', [b.packageId])
        if (!p) throw new HttpError(400, 'No such package.')
        description ??= p.name; rate ??= n(p.price_paise) / 100; kind ??= p.kind === 'menu' ? 'catering' : 'other'
      }
      if (!description) throw new HttpError(400, 'Describe the item.')
      if (!(n(b.qty ?? 1) > 0) || !(n(rate) >= 0)) throw new HttpError(400, 'Quantity above 0 and a rate of ₹0 or more.')
      if (!GST_KINDS.includes(kind as GstKind)) throw new HttpError(400, 'GST kind: hall, catering or other.')
      if (b.functionId) { const [f] = await t.query('select 1 from event_function where id = $1 and event_id = $2', [b.functionId, e.id]); if (!f) throw new HttpError(400, 'No such function in this event.') }
      const id = newId('EI')
      await t.query('insert into event_item (id, event_id, function_id, package_id, description, qty, rate_paise, gst_kind, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, e.id, b.functionId ?? null, b.packageId ?? null, description, n(b.qty ?? 1), rupees(n(rate)), kind, now()])
      await touch(t, e.id)
      await audit(t, who, 'event.item_add', e, { amount: Math.round(n(b.qty ?? 1) * rupees(n(rate))), after: { description, qty: n(b.qty ?? 1) } })
      return reply.status(201).send({ id })
    })
  })

  app.delete('/api/banquets/items/:id', async (req) => {
    const who = await need(req, 'events.manage')
    return db.tx(async (t) => {
      const [i] = await t.query<{ event_id: string; description: string }>('select event_id, description from event_item where id = $1', [idOf(req)])
      if (!i) throw new HttpError(404, 'No such item.')
      const e = await loadEvent(t, i.event_id, true)
      open(e)
      await t.query('delete from event_item where id = $1', [idOf(req)])
      await audit(t, who, 'event.item_remove', e, { note: `${e.number}: ${i.description}` })
      return { ok: true }
    })
  })

  // ---------- quotes ----------
  app.post('/api/banquets/events/:id/quote', async (req) => {
    const who = await need(req, 'events.manage')
    const b = (req.body ?? {}) as { discountPercent?: number; validDays?: number }
    const discount = n(b.discountPercent)
    if (!(discount >= 0 && discount <= 50)) throw new HttpError(400, 'Discount: 0 to 50%.')
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (!['enquiry', 'quoted', 'hold'].includes(e.status)) throw new HttpError(409, e.status === 'definite' ? 'The contract is signed: add items to the event; they are billed at the end.' : `This event is ${e.status}.`)
      const lines = taxLines(await priceLines(ctx, t, e.id), discount)
      if (!lines.length) throw new HttpError(400, 'Add a function (venue and menu) or an item first.')
      const tot = sumLines(lines)
      const over = discount > await roleLimit(t, who, 'package_discount_percent')
      const [{ v }] = await t.query<{ v: number | null }>('select max(version) as v from event_quote where event_id = $1', [e.id])
      await t.query(`update event_quote set status = 'superseded' where event_id = $1 and status in ('issued','awaiting_approval','accepted')`, [e.id])
      const id = newId('QT'), version = (v ?? 0) + 1, today = await businessDate(t)
      await t.query(`insert into event_quote (id, event_id, version, lines, discount_percent, taxable_paise, gst_paise, total_paise, status, valid_until, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, e.id, version, JSON.stringify(lines), discount, tot.taxable, tot.gst, tot.total, over ? 'awaiting_approval' : 'issued', addDays(today, Math.min(60, Math.max(1, b.validDays ?? 15))), who.userId, now()])
      let approvalId: string | null = null
      if (over) approvalId = await createApproval(ctx, t, 'event.discount', who.userId, { quoteId: id, eventId: e.id, number: e.number, title: e.title, percent: discount, totalPaise: tot.total }, `${discount}% off ${e.title}`)
      else if (e.status === 'enquiry') await t.query(`update event set status = 'quoted' where id = $1`, [e.id])
      await touch(t, e.id)
      await audit(t, who, over ? 'event.quote_needs_approval' : 'event.quote', e, { amount: tot.total, after: { version, discount } })
      return { id, version, totalPaise: tot.total, status: over ? 'awaiting_approval' : 'issued', approvalId }
    })
  })

  app.post('/api/banquets/quotes/:id/accept', async (req) => {
    const who = await need(req, 'events.manage')
    return db.tx(async (t) => {
      const [q] = await t.query<{ id: string; event_id: string; status: string; valid_until: string; version: number; total_paise: string }>('select id, event_id, status, valid_until::text, version, total_paise from event_quote where id = $1 for update', [idOf(req)])
      if (!q) throw new HttpError(404, 'No such quote.')
      if (q.status !== 'issued') throw new HttpError(409, q.status === 'awaiting_approval' ? 'The discount on this quote awaits the GM\'s approval.' : `This quote is ${q.status}.`)
      if (q.valid_until < await businessDate(t)) throw new HttpError(409, 'This quote has expired: issue a new one.')
      const e = await loadEvent(t, q.event_id, true)
      await t.query(`update event_quote set status = 'accepted', accepted_at = $2 where id = $1`, [q.id, now()])
      await touch(t, e.id)
      await audit(t, who, 'event.quote_accepted', e, { amount: n(q.total_paise), after: { version: q.version } })
      return { ok: true }
    })
  })

  app.get('/api/banquets/quotes/:id/print', async (req, reply) => {
    await need(req, ...VIEW)
    const [q] = await db.query<{ event_id: string; version: number; lines: (ReturnType<typeof taxLines>[number])[]; discount_percent: string; taxable_paise: string; gst_paise: string; total_paise: string; valid_until: string; created_at: Date }>(
      'select event_id, version, lines, discount_percent, taxable_paise, gst_paise, total_paise, valid_until::text, created_at from event_quote where id = $1', [idOf(req)])
    if (!q) throw new HttpError(404, 'No such quote.')
    const e = await loadEvent(db, q.event_id)
    const [p] = await db.query<{ name: string; legal_name: string | null; gstin: string | null; address: string | null; city: string | null }>('select name, legal_name, gstin, address, city from property limit 1')
    const beo = await buildBeo(db, e.id)
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quote ${esc(e.number)} v${q.version}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px/1.45 system-ui,sans-serif;color:#1d1a16;background:#fff;max-width:820px;margin:24px auto;padding:0 16px}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin:12px 0}td,th{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left;vertical-align:top}.n{text-align:right;white-space:nowrap}.muted{color:#6b645a}.tot td{font-weight:700;border-top:2px solid #1d1a16}@media print{body{margin:0}}</style></head><body>
<header><h1>${esc(p.legal_name ?? p.name)}</h1><div class="muted">${esc([p.address, p.city].filter(Boolean).join(', '))}${p.gstin ? ` · GSTIN ${esc(p.gstin)}` : ''}</div></header>
<h2>Quotation ${esc(e.number)} · version ${q.version}</h2>
<p><b>${esc(e.title)}</b><br>For ${esc(e.company ?? e.client_name)}${e.gstin ? ` (GSTIN ${esc(e.gstin)})` : ''}<br>Dated ${esc(istDate(q.created_at))} · valid until ${esc(q.valid_until)}</p>
<table><thead><tr><th>Function</th><th>Venue</th><th>When</th><th>Setup</th><th class="n">Guests</th><th>Menu</th></tr></thead><tbody>
${beo.functions.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.venue)}</td><td>${esc(f.date)} ${esc(f.from)}–${esc(f.to)}</td><td>${esc(f.style.replace('_', ' '))}</td><td class="n">${f.pax}</td><td>${esc(f.menu?.name ?? '—')}</td></tr>`).join('')}
</tbody></table>
<table><thead><tr><th>#</th><th>Description</th><th class="n">Qty</th><th class="n">Amount</th><th class="n">GST</th><th class="n">Total</th></tr></thead><tbody>
${q.lines.map((l) => `<tr><td>${l.slNo}</td><td>${esc(l.description)}</td><td class="n">${l.qty}</td><td class="n">${inr(l.taxable)}</td><td class="n">${l.gstRate}%</td><td class="n">${inr(l.total)}</td></tr>`).join('')}
<tr class="tot"><td colspan="3">Total${n(q.discount_percent) ? ` (after ${n(q.discount_percent)}% discount)` : ''}</td><td class="n">${inr(n(q.taxable_paise))}</td><td class="n">${inr(n(q.gst_paise))}</td><td class="n">${inr(n(q.total_paise))}</td></tr></tbody></table>
${beo.functions.filter((f) => f.menu).map((f) => `<p><b>${esc(f.menu!.name)}</b> (${esc(f.name)}): ${esc(f.menu!.items.join(' · '))}</p>`).join('')}
<p class="muted">Plates are charged at the guaranteed number given 7 days before the event, or the number served if more. Advances are acknowledged on GST receipt vouchers. Cash of ₹2 lakh or more in all for one event cannot be accepted (section 269ST); please pay by bank transfer, UPI or card.</p>
</body></html>`
    return reply.header('content-type', 'text/html; charset=utf-8').send(html)
  })

  // ---------- holds, contract, lost ----------
  app.post('/api/banquets/events/:id/hold', async (req) => {
    const who = await need(req, 'events.manage')
    const b = (req.body ?? {}) as { days?: number }
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (!['enquiry', 'quoted', 'hold'].includes(e.status)) throw new HttpError(409, `This event is ${e.status}.`)
      const [{ c }] = await t.query<{ c: number }>('select count(*)::int as c from event_function where event_id = $1', [e.id])
      if (!c) throw new HttpError(400, 'Add the functions (venue, day and time) before holding dates.')
      const limit = await roleLimit(t, who, 'hold_dates_days')
      const days = Math.max(1, Math.round(n(b.days ?? Math.min(7, limit))))
      if (days > limit) throw new HttpError(403, `You can hold dates for up to ${limit} days.`)
      const cl = await firmClashes(t, e.id)
      if (cl.length) throw new HttpError(409, `The venue is already held or booked: ${cl[0].title} (${cl[0].number}) on ${istDate(cl[0].startsAt)}.`, { clashes: cl })
      const until = addDays(await businessDate(t), days)
      await t.query(`update event set status = 'hold', hold_until = $2, updated_at = $3 where id = $1`, [e.id, until, now()])
      await audit(t, who, 'event.hold', e, { after: { until } })
      return { ok: true, holdUntil: until }
    })
  })

  app.post('/api/banquets/events/:id/release', async (req) => {
    const who = await need(req, 'events.manage')
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (e.status !== 'hold') throw new HttpError(409, 'Only a hold can be released.')
      const [q] = await t.query(`select 1 from event_quote where event_id = $1 and status in ('issued','accepted')`, [e.id])
      await t.query(`update event set status = $2, hold_until = null, updated_at = $3 where id = $1`, [e.id, q ? 'quoted' : 'enquiry', now()])
      await audit(t, who, 'event.release', e)
      return { ok: true }
    })
  })

  /** The advance schedule a contract starts with: a quarter now, half a month before, the rest a week before. */
  function defaultMilestones(total: number, today: string, first: string) {
    const a = Math.round(total * 0.25), b2 = Math.round(total * 0.5)
    const mid = addDays(first, -30) > today ? addDays(first, -30) : today, late = addDays(first, -7) > today ? addDays(first, -7) : today
    return [{ label: 'On signing', dueOn: today, amount: a }, { label: '30 days before', dueOn: mid, amount: b2 }, { label: '7 days before', dueOn: late, amount: total - a - b2 }]
  }

  app.post('/api/banquets/events/:id/contract', async (req) => {
    const who = await need(req, 'events.manage')
    const b = (req.body ?? {}) as { signedOn?: string; milestones?: { label?: string; dueOn?: string; amount?: number }[] }
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (!['quoted', 'hold'].includes(e.status)) throw new HttpError(409, e.status === 'enquiry' ? 'Issue a quote first.' : `This event is ${e.status}.`)
      const [q] = await t.query<{ total_paise: string }>(`select total_paise from event_quote where event_id = $1 and status = 'accepted'`, [e.id])
      if (!q) throw new HttpError(409, 'The client has to accept a quote first.')
      const cl = await firmClashes(t, e.id)
      if (cl.length) throw new HttpError(409, `The venue is already held or booked: ${cl[0].title} (${cl[0].number}) on ${istDate(cl[0].startsAt)}.`, { clashes: cl })
      const today = await businessDate(t)
      const [{ first }] = await t.query<{ first: Date }>('select min(starts_at) as first from event_function where event_id = $1', [e.id])
      const total = n(q.total_paise)
      const ms = b.milestones?.length
        ? b.milestones.map((m) => ({ label: str(m.label, 60) ?? 'Advance', dueOn: m.dueOn ?? '', amount: rupees(n(m.amount)) }))
        : defaultMilestones(total, today, istDate(first))
      if (ms.some((m) => !DATE.test(m.dueOn) || !(m.amount > 0))) throw new HttpError(400, 'Each instalment needs a date and an amount above 0.')
      if (ms.reduce((a, m) => a + m.amount, 0) !== total) throw new HttpError(400, `The instalments must add up to the quote, ${inr(total)}.`)
      await t.query('delete from event_milestone where event_id = $1', [e.id])
      for (const [i, m] of ms.entries()) await t.query('insert into event_milestone (id, event_id, seq, label, due_on, amount_paise) values ($1,$2,$3,$4,$5,$6)', [newId('MS'), e.id, i, m.label, m.dueOn, m.amount])
      const signedOn = DATE.test(b.signedOn ?? '') && b.signedOn! <= today ? b.signedOn! : today
      await t.query(`update event set status = 'definite', hold_until = null, contract_signed_on = $2, updated_at = $3 where id = $1`, [e.id, signedOn, now()])
      await audit(t, who, 'event.contract', e, { amount: total, after: { signedOn, milestones: ms } })
      return { ok: true }
    })
  })

  app.put('/api/banquets/events/:id/milestones', async (req) => {
    const who = await need(req, 'events.manage')
    const b = (req.body ?? {}) as { milestones?: { label?: string; dueOn?: string; amount?: number }[] }
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (e.status !== 'definite') throw new HttpError(409, 'The advance schedule is set with the contract.')
      const ms = (b.milestones ?? []).map((m) => ({ label: str(m.label, 60) ?? 'Advance', dueOn: m.dueOn ?? '', amount: rupees(n(m.amount)) }))
      if (!ms.length || ms.some((m) => !DATE.test(m.dueOn) || !(m.amount > 0))) throw new HttpError(400, 'Each instalment needs a date and an amount above 0.')
      await t.query('delete from event_milestone where event_id = $1', [e.id])
      for (const [i, m] of ms.entries()) await t.query('insert into event_milestone (id, event_id, seq, label, due_on, amount_paise) values ($1,$2,$3,$4,$5,$6)', [newId('MS'), e.id, i, m.label, m.dueOn, m.amount])
      await audit(t, who, 'event.milestones', e, { after: ms })
      return { ok: true }
    })
  })

  app.post('/api/banquets/events/:id/lost', async (req) => {
    const who = await need(req, 'events.manage')
    const b = (req.body ?? {}) as { reason?: string; lostTo?: string }
    const reason = str(b.reason, 200)
    if (!reason) throw new HttpError(400, 'Why was it lost? (price, date taken, chose another venue…)')
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (!['enquiry', 'quoted', 'hold'].includes(e.status)) throw new HttpError(409, e.status === 'definite' ? 'A signed event is cancelled, not lost.' : `This event is ${e.status}.`)
      if (await advancesHeld(t, e.id) > 0) throw new HttpError(409, 'Advances are held: cancel the event and refund or keep them.')
      await t.query(`update event set status = 'lost', lost_reason = $2, lost_to = $3, hold_until = null, updated_at = $4 where id = $1`, [e.id, reason, str(b.lostTo, 120), now()])
      await t.query(`update event_quote set status = 'superseded' where event_id = $1 and status in ('issued','awaiting_approval')`, [e.id])
      await audit(t, who, 'event.lost', e, { after: { reason, lostTo: b.lostTo ?? null } })
      return { ok: true }
    })
  })

  // ---------- money ----------
  app.post('/api/banquets/events/:id/payments', async (req, reply) => {
    const who = await need(req, 'events.payment')
    const b = (req.body ?? {}) as { method?: string; amount?: number; reference?: string; refund?: boolean; debtorId?: string }
    if (!SETTLE.includes(b.method ?? '') || !(n(b.amount) > 0)) throw new HttpError(400, `Send method (${SETTLE.join(', ')}) and amount (₹).`)
    if (!['cash', 'company'].includes(b.method!) && !str(b.reference)) throw new HttpError(400, 'Card, UPI, bank and cheque payments need a reference (UTR, cheque or approval number).')
    const amount = rupees(n(b.amount))
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (!['enquiry', 'quoted', 'hold', 'definite', 'billed', 'cancelled'].includes(e.status) || (e.status === 'cancelled' && !b.refund)) throw new HttpError(409, `This event is ${e.status}.`)
      const [inv] = await t.query('select 1 from tax_document where event_id = $1 and doc_type = $2', [e.id, 'invoice'])
      const [{ paid }] = await t.query<{ paid: string | null }>('select sum(amount_paise) as paid from event_payment where event_id = $1', [e.id])
      let kind: 'advance' | 'settlement' | 'refund', voucher: { id: string; number: string } | null = null
      let debtorId: string | null = null
      if (b.method === 'company') {
        // The bill's balance moves to the company's credit account, within its limit; the company pays it there.
        if (b.refund) throw new HttpError(400, 'A refund goes back by bank, UPI, card, cheque or cash.')
        if (!inv) throw new HttpError(409, 'An event goes to a company\'s account once it is billed; advances are paid.')
        debtorId = b.debtorId ?? (e as EventRow & { debtor_id: string | null }).debtor_id
        if (!debtorId) throw new HttpError(400, 'Which company account? Link the event to one first.')
        const [{ total }] = await t.query<{ total: string }>(`select sum(total_paise) as total from tax_document where event_id = $1 and doc_type = 'invoice'`, [e.id])
        if (amount > n(total) - n(paid)) throw new HttpError(400, `Only ${inr(n(total) - n(paid))} is due on the bill.`)
        try { await checkCredit(t, debtorId, amount) } catch (x) { if (x instanceof CreditError) throw new HttpError(409, x.message); throw x }
      }
      if (b.refund) {
        if (amount > n(paid)) throw new HttpError(400, `Only ${inr(n(paid))} has been received.`)
        kind = 'refund'
        if (!inv) {
          if (!['cancelled', 'enquiry', 'quoted', 'hold', 'definite'].includes(e.status)) throw new HttpError(409, `This event is ${e.status}.`)
          voucher = await eventRefundVoucher(ctx, t, who, e.id, amount)
        } else {
          const [{ total }] = await t.query<{ total: string }>(`select sum(total_paise) as total from tax_document where event_id = $1 and doc_type = 'invoice'`, [e.id])
          if (n(paid) - amount < n(total)) throw new HttpError(400, `Only what was paid over the bill can be refunded: ${inr(Math.max(0, n(paid) - n(total)))}.`)
        }
      } else {
        if (b.method === 'cash') {
          // Cash of ₹2 lakh or more for one event or occasion is barred in all, not per day (section 269ST).
          const [{ cash }] = await t.query<{ cash: string | null }>(`select sum(amount_paise) as cash from event_payment where event_id = $1 and method = 'cash' and amount_paise > 0`, [e.id])
          const c = cashReceiptCheck(ctx.tax, amount, n(cash))
          if (!c.allowed) throw new HttpError(403, 'Cash of ₹2 lakh or more in all for one event is not allowed. Take UPI, card or a bank transfer.')
        }
        kind = inv ? 'settlement' : 'advance'
        if (kind === 'advance') voucher = await eventReceiptVoucher(ctx, t, who, e.id, amount)
      }
      const id = newId('EP')
      await t.query(`insert into event_payment (id, event_id, kind, method, amount_paise, reference, voucher_id, business_date, received_by, received_at, debtor_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, e.id, kind, b.method, b.refund ? -amount : amount, str(b.reference, 80), voucher?.id ?? null, await businessDate(t), who.userId, now(), debtorId])
      await touch(t, e.id)
      await audit(t, who, `event.${kind}`, e, { amount: b.refund ? -amount : amount, after: { method: b.method, voucher: voucher?.number ?? null } })
      return reply.status(201).send({ id, kind, voucher })
    })
  })

  // ---------- outside suppliers ----------
  /** The vendor master's names, for sales to pick an event's suppliers from. */
  app.get('/api/banquets/vendor-list', async (req) => {
    await need(req, 'events.manage')
    return db.query('select id, name from vendor where active order by name')
  })

  app.post('/api/banquets/events/:id/vendors', async (req, reply) => {
    const who = await need(req, 'events.manage')
    const b = (req.body ?? {}) as { vendorId?: string; service?: string; agreed?: number; notes?: string }
    const service = str(b.service, 120)
    if (!service) throw new HttpError(400, 'What do they supply? (decor, DJ, photography…)')
    if (!(n(b.agreed ?? 0) >= 0)) throw new HttpError(400, 'The agreed amount: ₹0 or more.')
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      open(e)
      const [v] = await t.query<{ name: string }>('select name from vendor where id = $1', [b.vendorId])
      if (!v) throw new HttpError(400, 'Pick the vendor (add them under Stores → Vendors first, with PAN and TDS category).')
      const id = newId('EVV')
      await t.query('insert into event_vendor (id, event_id, vendor_id, service, agreed_paise, notes, created_at) values ($1,$2,$3,$4,$5,$6,$7)', [id, e.id, b.vendorId, service, rupees(n(b.agreed ?? 0)), str(b.notes, 500), now()])
      await audit(t, who, 'event.vendor_add', e, { amount: rupees(n(b.agreed ?? 0)), after: { vendor: v.name, service } })
      return reply.status(201).send({ id })
    })
  })

  app.delete('/api/banquets/vendors/:id', async (req) => {
    const who = await need(req, 'events.manage')
    return db.tx(async (t) => {
      const [v] = await t.query<{ event_id: string; vendor_id: string; service: string }>('select event_id, vendor_id, service from event_vendor where id = $1', [idOf(req)])
      if (!v) throw new HttpError(404, 'No such vendor on the event.')
      const [billed] = await t.query(`select 1 from purchase_bill where event_id = $1 and vendor_id = $2 and status <> 'cancelled'`, [v.event_id, v.vendor_id])
      if (billed) throw new HttpError(409, 'Their bill for this event is already entered.')
      const e = await loadEvent(t, v.event_id, true)
      await t.query('delete from event_vendor where id = $1', [idOf(req)])
      await audit(t, who, 'event.vendor_remove', e, { note: `${e.number}: ${v.service}` })
      return { ok: true }
    })
  })

  // ---------- permissions checklist ----------
  app.put('/api/banquets/events/:id/checks/:item', async (req) => {
    const who = await need(req, 'events.manage')
    const { item } = req.params as { item: string }
    const b = (req.body ?? {}) as { status?: string; ref?: string }
    if (!['pending', 'applied', 'received', 'not_needed'].includes(b.status ?? '')) throw new HttpError(400, 'Status: pending, applied, received or not_needed.')
    if (b.status === 'received' && !str(b.ref)) throw new HttpError(400, 'The permission\'s number or reference.')
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      const r = await t.query(`update event_check set status = $3, ref = $4, updated_by = $5, updated_at = $6 where event_id = $1 and item = $2 returning item`, [e.id, item, b.status, str(b.ref, 80), who.userId, now()])
      if (!r.length) throw new HttpError(404, 'No such check.')
      await audit(t, who, 'event.check', e, { after: { item, status: b.status, ref: b.ref ?? null } })
      return { ok: true }
    })
  })

  // ---------- the event order (BEO) ----------
  app.post('/api/banquets/events/:id/beo', async (req) => {
    const who = await need(req, 'events.manage')
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (e.status !== 'definite') throw new HttpError(409, 'The event order goes out once the contract is signed.')
      const content = await buildBeo(t, e.id)
      if (!content.functions.length) throw new HttpError(400, 'The event has no functions.')
      const [last] = await t.query<{ revision: number; content: Beo }>('select revision, content from event_beo where event_id = $1 order by revision desc limit 1', [e.id])
      if (last && canonical(last.content) === canonical(content)) throw new HttpError(409, `Nothing has changed since revision ${last.revision}.`)
      const revision = (last?.revision ?? 0) + 1
      await t.query('insert into event_beo (event_id, revision, content, issued_by, issued_at) values ($1,$2,$3,$4,$5)', [e.id, revision, JSON.stringify(content), who.userId, now()])
      const first = content.functions[0]
      const text = `Event order ${e.number}${revision > 1 ? ` revision ${revision}` : ''}: ${e.title}, ${first.date} ${first.from} at ${first.venue}${content.functions.length > 1 ? ` (+${content.functions.length - 1} more)` : ''}. Open Banquets → Event orders and acknowledge.`
      const roles = [...new Set(Object.values(BEO_DEPTS).flatMap((d) => d.roles))]
      await t.query('insert into broadcast (id, from_user, at, text, roles, urgent) values ($1,$2,$3,$4,$5,false)', [newId('BC'), who.userId, now(), text, roles])
      const pending = content.checks.filter((c) => c.status === 'pending' || c.status === 'applied')
      await audit(t, who, 'beo.issue', e, { after: { revision, functions: content.functions.length, permissionsOpen: pending.map((c) => c.item) } })
      return { revision, permissionsOpen: pending.map((c) => c.label) }
    })
  })

  /** Event orders for the departments this person works in: from today on, latest revision each. */
  app.get('/api/banquets/beo', async (req) => {
    const who = await need(req, 'beo.view', 'events.manage', 'events.view')
    const depts = beoDeptsOf(who)
    const today = await businessDate(db)
    const rows = await db.query<{ event_id: string; revision: number; content: Beo; issued_at: Date; by: string; status: string }>(
      `select b.event_id, b.revision, b.content, b.issued_at, u.name as by, e.status from event_beo b join event e on e.id = b.event_id join app_user u on u.id = b.issued_by
        where b.revision = (select max(revision) from event_beo x where x.event_id = b.event_id) and e.status in ('definite','billed')
          and exists (select 1 from event_function f where f.event_id = e.id and f.ends_at >= $1::timestamptz)`, [`${today}T00:00:00+05:30`])
    const acks = await db.query<{ event_id: string; revision: number; dept: string; by: string; acked_at: Date }>('select a.event_id, a.revision, a.dept, u.name as by, a.acked_at from beo_ack a join app_user u on u.id = a.acked_by')
    return {
      depts: depts.map((d) => ({ id: d, name: BEO_DEPTS[d].name })),
      orders: rows.map((r) => ({ eventId: r.event_id, revision: r.revision, issuedAt: r.issued_at, by: r.by, beo: r.content,
        acks: Object.fromEntries(acks.filter((a) => a.event_id === r.event_id && a.revision === r.revision).map((a) => [a.dept, { by: a.by, at: a.acked_at }])) }))
        .sort((a, b) => `${a.beo.functions[0]?.date}${a.beo.functions[0]?.from}`.localeCompare(`${b.beo.functions[0]?.date}${b.beo.functions[0]?.from}`)),
    }
  })

  app.post('/api/banquets/events/:id/beo/:rev/ack', async (req) => {
    const who = await need(req, 'beo.view', 'events.manage')
    const rev = Number((req.params as { rev: string }).rev)
    const dept = String(((req.body ?? {}) as { dept?: string }).dept ?? '')
    if (!BEO_DEPTS[dept]) throw new HttpError(400, `Department: ${Object.keys(BEO_DEPTS).join(', ')}.`)
    if (!beoDeptsOf(who).includes(dept)) throw new HttpError(403, `Only ${BEO_DEPTS[dept].name} acknowledges its sheet.`)
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req))
      const [last] = await t.query<{ revision: number }>('select max(revision) as revision from event_beo where event_id = $1', [e.id])
      if (!last?.revision) throw new HttpError(404, 'No event order yet.')
      if (rev !== last.revision) throw new HttpError(409, `Revision ${last.revision} replaced this one: read it and acknowledge that.`)
      await t.query('insert into beo_ack (event_id, revision, dept, acked_by, acked_at) values ($1,$2,$3,$4,$5) on conflict do nothing', [e.id, rev, dept, who.userId, now()])
      await audit(t, who, 'beo.ack', e, { after: { revision: rev, dept } })
      return { ok: true }
    })
  })

  // ---------- the bill, cancellation, feedback ----------
  app.post('/api/banquets/events/:id/bill', async (req) => {
    const who = await need(req, 'events.bill')
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (e.status !== 'definite') throw new HttpError(409, e.status === 'billed' ? 'Already billed.' : 'Only a definite event is billed.')
      const fns = await t.query<{ name: string; actual_pax: number | null; menu_id: string | null; starts_at: Date }>('select name, actual_pax, menu_id, starts_at from event_function where event_id = $1', [e.id])
      const today = await businessDate(t)
      const ahead = fns.filter((f) => istDay(f.starts_at) > today)
      if (ahead.length) throw new HttpError(409, `${ahead.map((f) => f.name).join(', ')} has not happened yet (${istDay(ahead[0].starts_at).split('-').reverse().join('/')}). The final bill is made after the event; take an advance until then.`)
      const missing = fns.filter((f) => f.menu_id && f.actual_pax == null)
      if (missing.length) throw new HttpError(409, `Enter the guests served for ${missing.map((f) => f.name).join(', ')} first.`)
      const [q] = await t.query<{ discount_percent: string }>(`select discount_percent from event_quote where event_id = $1 and status = 'accepted'`, [e.id])
      const doc = await eventInvoice(ctx, t, who, e.id, n(q?.discount_percent))
      await t.query(`update event set status = 'billed', updated_at = $2 where id = $1`, [e.id, now()])
      const [{ paid }] = await t.query<{ paid: string | null }>('select sum(amount_paise) as paid from event_payment where event_id = $1', [e.id])
      await audit(t, who, 'event.bill', e, { amount: doc.total, after: { invoice: doc.number, paid: n(paid) } })
      return { ...doc, balancePaise: doc.total - n(paid) }
    })
  })

  app.post('/api/banquets/events/:id/cancel', async (req) => {
    const who = await need(req, 'events.manage')
    const b = (req.body ?? {}) as { reason?: string; refund?: number; method?: string; reference?: string }
    const reason = str(b.reason, 200)
    if (!reason) throw new HttpError(400, 'Why is it cancelled?')
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (!['hold', 'definite', 'quoted', 'enquiry'].includes(e.status)) throw new HttpError(409, `This event is ${e.status}.`)
      const held = await advancesHeld(t, e.id)
      const refund = rupees(n(b.refund))
      if (refund < 0 || refund > held) throw new HttpError(400, `Refund up to the ${inr(held)} held.`)
      if (refund > 0) {
        if (!METHODS.includes(b.method ?? '')) throw new HttpError(400, `How is it refunded? (${METHODS.join(', ')})`)
        if (b.method !== 'cash' && !str(b.reference)) throw new HttpError(400, 'The refund\'s reference (UTR or cheque number).')
        const v = await eventRefundVoucher(ctx, t, who, e.id, refund)
        await t.query(`insert into event_payment (id, event_id, kind, method, amount_paise, reference, voucher_id, business_date, received_by, received_at) values ($1,$2,'refund',$3,$4,$5,$6,$7,$8,$9)`,
          [newId('EP'), e.id, b.method, -refund, str(b.reference, 80), v?.id ?? null, await businessDate(t), who.userId, now()])
      }
      const retained = held - refund
      const inv = retained > 0 ? await cancellationInvoice(ctx, t, who, e.id, retained) : null
      await t.query(`update event set status = 'cancelled', cancel_reason = $2, hold_until = null, updated_at = $3 where id = $1`, [e.id, reason, now()])
      await t.query(`update event_quote set status = 'superseded' where event_id = $1 and status in ('issued','awaiting_approval')`, [e.id])
      await audit(t, who, 'event.cancel', e, { amount: retained, after: { reason, refundPaise: refund, retainedPaise: retained, invoice: inv?.number ?? null } })
      return { ok: true, refundPaise: refund, retainedPaise: retained, invoice: inv }
    })
  })

  app.post('/api/banquets/events/:id/feedback', async (req) => {
    const who = await need(req, 'events.manage', 'events.bill')
    const b = (req.body ?? {}) as { score?: number; note?: string }
    if (!(Number.isInteger(b.score) && b.score! >= 1 && b.score! <= 5)) throw new HttpError(400, 'Score: 1 to 5.')
    return db.tx(async (t) => {
      const e = await loadEvent(t, idOf(req), true)
      if (e.status !== 'billed') throw new HttpError(409, 'Feedback is taken once the event is billed.')
      const [{ paid }] = await t.query<{ paid: string | null }>('select sum(amount_paise) as paid from event_payment where event_id = $1', [e.id])
      const [{ total }] = await t.query<{ total: string | null }>(`select sum(total_paise) as total from tax_document where event_id = $1 and doc_type = 'invoice'`, [e.id])
      if (n(paid) < n(total)) throw new HttpError(409, `${inr(n(total) - n(paid))} is still due on the bill.`)
      await t.query(`update event set status = 'closed', feedback_score = $2, feedback_note = $3, updated_at = $4 where id = $1`, [e.id, b.score, str(b.note, 1000), now()])
      // A low score reaches the MD's feed at once, before it reaches Google.
      await audit(t, who, b.score! <= 2 ? 'event.feedback_low' : 'event.feedback', e, { after: { score: b.score }, note: `${e.number}: ${str(b.note, 120) ?? ''}` })
      return { ok: true }
    })
  })
}
