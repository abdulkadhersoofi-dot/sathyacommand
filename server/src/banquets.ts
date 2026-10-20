import { financialYear, restaurantRate, taxInside } from '@sathya/tax'
import type { Caller, Ctx } from './context'
import type { Db } from './db'
import { appendAudit } from './audit-store'
import { businessDate } from './fo-core'
import { issue, type DocLine } from './invoicing'
import type { Party } from './einvoice'

// Banquets: prices an event from its functions, menus and extras; finds venue clashes; frames the GST on
// advances, the final bill and a cancellation; and builds the event order (BEO) each department works from.

export const STYLES = ['rounds', 'theatre', 'u_shape', 'classroom', 'cocktail', 'floating'] as const
export const VENUE_KINDS = ['hall', 'lawn', 'pavilion', 'ground']
/** Statuses that keep a venue: a second firm booking on the same slot is refused. */
export const FIRM = ['hold', 'definite', 'billed', 'closed']
/** Statuses still on the calendar (pencilled or firm). */
export const LIVE = ['enquiry', 'quoted', ...FIRM]

/** The departments a BEO goes to, and the roles that work from each sheet. */
export const BEO_DEPTS: Record<string, { name: string; roles: string[] }> = {
  kitchen: { name: 'Kitchen', roles: ['chef', 'fnb_manager'] },
  service: { name: 'F&B service', roles: ['fnb_manager', 'captain'] },
  housekeeping: { name: 'Housekeeping', roles: ['executive_housekeeper', 'hk_supervisor'] },
  engineering: { name: 'Engineering', roles: ['chief_engineer', 'engineering'] },
  security: { name: 'Security', roles: ['security_head', 'security'] },
  front_office: { name: 'Front office', roles: ['front_office_manager', 'reception'] },
}

/** Permissions every event is checked for; each can be marked not needed. */
export const CHECKS: Record<string, string> = {
  music_licence: 'Music licence (PPL / IPRS / Novex) for recorded or live music',
  police: 'Police permission (loudspeakers, crowd, late hours)',
  fire: 'Fire safety for a pandal, stage, lighting rig or fireworks',
  liquor: 'Liquor licence for the event, if a bar is served',
}

/** Kitchen cooks a little over the guarantee. */
export const PRODUCTION_MARGIN = 0.05

const n = (v: unknown) => Number(v ?? 0)
const IST = 330 * 60_000
export const istDate = (d: Date | string) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10)
export const istTime = (d: Date | string) => new Date(new Date(d).getTime() + IST).toISOString().slice(11, 16)
const dayLabel = (d: Date | string) => new Date(`${istDate(d)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** A function's start and end from its day and times; an end at or before the start is the next morning. */
export function functionTimes(date: string, from: string, to: string) {
  const starts = new Date(`${date}T${from}:00+05:30`)
  let ends = new Date(`${date}T${to}:00+05:30`)
  if (ends <= starts) ends = new Date(ends.getTime() + 86_400_000)
  return { starts, ends }
}

export interface Clash { functionId: string; name: string; eventId: string; number: string; title: string; status: string; startsAt: string; endsAt: string; firm: boolean }

/** Other events on the venue whose times, widened by its turnaround, overlap these. */
export async function clashes(t: Db, venueId: string, starts: Date, ends: Date, excludeEvent: string | null = null): Promise<Clash[]> {
  const rows = await t.query<{ id: string; name: string; event_id: string; number: string; title: string; status: string; starts_at: Date; ends_at: Date }>(
    `select f.id, f.name, e.id as event_id, e.number, e.title, e.status, f.starts_at, f.ends_at
       from event_function f join event e on e.id = f.event_id join space s on s.id = f.venue_id
      where f.venue_id = $1 and e.status = any($4) and e.id is distinct from $5
        and f.starts_at < $3::timestamptz + make_interval(mins => s.turnaround_minutes)
        and f.ends_at + make_interval(mins => s.turnaround_minutes) > $2::timestamptz
      order by f.starts_at`, [venueId, starts, ends, LIVE, excludeEvent])
  return rows.map((r) => ({ functionId: r.id, name: r.name, eventId: r.event_id, number: r.number, title: r.title, status: r.status,
    startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(), firm: FIRM.includes(r.status) }))
}

/** Firm clashes of any of an event's functions with other events' firm bookings. */
export async function firmClashes(t: Db, eventId: string) {
  const fns = await t.query<{ venue_id: string; starts_at: Date; ends_at: Date }>('select venue_id, starts_at, ends_at from event_function where event_id = $1', [eventId])
  const out: Clash[] = []
  for (const f of fns) out.push(...(await clashes(t, f.venue_id, new Date(f.starts_at), new Date(f.ends_at), eventId)).filter((c) => c.firm))
  return out
}

/** Holds past their date go back to the quote, freeing the venue. */
export async function sweepHolds(t: Db, now: Date) {
  const today = await businessDate(t)
  const gone = await t.query<{ id: string; number: string }>(
    `update event set status = case when exists (select 1 from event_quote q where q.event_id = event.id and q.status in ('issued','accepted')) then 'quoted' else 'enquiry' end,
            hold_until = null, updated_at = $2
      where status = 'hold' and hold_until < $1 returning id, number`, [today, now])
  for (const e of gone) await appendAudit(t, { actor: { userId: 'system', name: 'System', role: 'system' }, action: 'event.hold_expired', entity: { type: 'event', id: e.id }, note: e.number }, now)
  return gone.length
}

export type GstKind = 'hall' | 'catering' | 'other'
export interface PriceLine { kind: GstKind; description: string; functionId: string | null; qty: number; rate: number; amount: number; gstRate: number; sac: string | null }

/** GST rate and SAC for each kind of line: hall and lawn rental, food (the restaurant's rate), other services. CA check */
export function gstFor(ctx: Ctx, kind: GstKind, fy: string) {
  const b = ctx.tax.gst.banquets
  if (kind === 'hall') return { rate: b?.hall_and_lawn_rental.rate ?? 18, sac: b?.hall_and_lawn_rental.sac ?? null }
  if (kind === 'catering') return { rate: restaurantRate(ctx.tax, fy).rate, sac: b?.event_catering.sac ?? '996334' }
  return { rate: b?.event_services?.rate ?? 18, sac: b?.event_services?.sac ?? null }
}

/**
 * The event's lines at today's prices: each function's venue rental and menu (plates at the guarantee, or the
 * expected count until one is given, never under the menu's minimum), then the extras. For the bill, plates
 * actually served above the guarantee are charged as extra plates.
 */
export async function priceLines(ctx: Ctx, t: Db, eventId: string, opts: { bill?: boolean } = {}): Promise<PriceLine[]> {
  const fy = financialYear(await businessDate(t))
  const fns = await t.query<{ id: string; name: string; starts_at: Date; venue: string; rental_paise: string | null; venue_rental: string | null; expected_pax: number; guaranteed_pax: number | null; actual_pax: number | null; menu: string | null; price_paise: string | null; per: string | null; min_pax: number | null }>(
    `select f.id, f.name, f.starts_at, s.name as venue, f.rental_paise, s.rental_paise as venue_rental, f.expected_pax, f.guaranteed_pax, f.actual_pax,
            p.name as menu, p.price_paise, p.per, p.min_pax
       from event_function f join space s on s.id = f.venue_id left join banquet_package p on p.id = f.menu_id
      where f.event_id = $1 order by f.starts_at, f.id`, [eventId])
  const lines: Omit<PriceLine, 'gstRate' | 'sac'>[] = []
  for (const f of fns) {
    const when = `${f.name}, ${dayLabel(f.starts_at)}`
    const rental = f.rental_paise != null ? n(f.rental_paise) : n(f.venue_rental)
    if (rental > 0) lines.push({ kind: 'hall', description: `${f.venue} rental: ${when}`, functionId: f.id, qty: 1, rate: rental, amount: rental })
    if (f.menu) {
      const price = n(f.price_paise)
      if (f.per === 'event') { lines.push({ kind: 'catering', description: `${f.menu}: ${when}`, functionId: f.id, qty: 1, rate: price, amount: price }); continue }
      const guarantee = Math.max(f.guaranteed_pax ?? f.expected_pax, n(f.min_pax))
      lines.push({ kind: 'catering', description: `${f.menu}, ${guarantee} plates: ${when}`, functionId: f.id, qty: guarantee, rate: price, amount: guarantee * price })
      const extra = opts.bill && f.actual_pax != null ? f.actual_pax - guarantee : 0
      if (extra > 0) lines.push({ kind: 'catering', description: `Extra plates over the guarantee, ${extra}: ${when}`, functionId: f.id, qty: extra, rate: price, amount: extra * price })
    }
  }
  const items = await t.query<{ description: string; qty: string; rate_paise: string; gst_kind: GstKind; function_id: string | null }>(
    'select description, qty, rate_paise, gst_kind, function_id from event_item where event_id = $1 order by created_at, id', [eventId])
  for (const i of items) lines.push({ kind: i.gst_kind, description: i.description, functionId: i.function_id, qty: n(i.qty), rate: n(i.rate_paise), amount: Math.round(n(i.qty) * n(i.rate_paise)) })
  return lines.map((l) => ({ ...l, ...(({ rate, sac }) => ({ gstRate: rate, sac }))(gstFor(ctx, l.kind, fy)) }))
}

/** Lines with the discount taken off each and GST on what is left. */
export function taxLines(lines: PriceLine[], discountPercent: number): (DocLine & { kind: GstKind; functionId: string | null })[] {
  return lines.map((l, i) => {
    const taxable = Math.round(l.amount * (1 - discountPercent / 100))
    const cgst = Math.round((taxable * l.gstRate) / 200)
    return { slNo: i + 1, description: l.description, sac: l.sac, qty: l.qty, gstRate: l.gstRate, taxable, cgst, sgst: cgst, total: taxable + 2 * cgst, kind: l.kind, functionId: l.functionId }
  })
}
export const sumLines = (ls: { taxable: number; cgst: number; sgst: number; total: number }[]) =>
  ({ taxable: ls.reduce((a, l) => a + l.taxable, 0), gst: ls.reduce((a, l) => a + l.cgst + l.sgst, 0), total: ls.reduce((a, l) => a + l.total, 0) })

interface EventRow { id: string; number: string; title: string; client_name: string; company: string | null; gstin: string | null; billing_address: string | null }
export const recipientOf = (e: EventRow): Party =>
  ({ name: e.company ?? e.client_name, gstin: e.gstin, address: e.billing_address, city: null, pin: null, stateCode: e.gstin ? e.gstin.slice(0, 2) : null })

interface Bucket { kind: string; rate: number; sac: string | null; gross: number }

/** Spreads an amount over rates in the shares given, the last taking what rounding leaves. */
function apportion(amount: number, buckets: Bucket[], label: string): DocLine[] {
  const total = buckets.reduce((a, b) => a + b.gross, 0)
  let left = amount
  return buckets.map((b, i) => {
    const part = i === buckets.length - 1 ? left : Math.round((amount * b.gross) / total)
    left -= part
    const gst = taxInside(part, b.rate), cgst = Math.round(gst / 2)
    return { slNo: i + 1, description: `${label}${buckets.length > 1 ? ` (${b.kind === 'catering' ? 'food' : b.kind === 'hall' ? 'venue' : 'services'})` : ''}`, sac: b.sac, qty: 1,
      gstRate: b.rate, taxable: part - gst, cgst, sgst: gst - cgst, total: part, kind: b.kind }
  }).filter((l) => l.total !== 0)
}

/** Rates of the quote the client accepted (or the latest one sent), by their share of its value. */
async function quoteBuckets(t: Db, eventId: string): Promise<Bucket[]> {
  const [q] = await t.query<{ lines: (DocLine & { kind: string })[] }>(
    `select lines from event_quote where event_id = $1 and status in ('accepted','issued') order by (status = 'accepted') desc, version desc limit 1`, [eventId])
  const m = new Map<string, Bucket>()
  for (const l of q?.lines ?? []) {
    const k = `${l.kind}|${l.gstRate}|${l.sac}`
    const b = m.get(k) ?? { kind: l.kind, rate: Number(l.gstRate), sac: l.sac, gross: 0 }
    b.gross += l.total; m.set(k, b)
  }
  // Without a quote the rate cannot be known yet: GST at 18% (rule 50). CA check
  return [...m.values()].filter((b) => b.gross > 0).length ? [...m.values()].filter((b) => b.gross > 0) : [{ kind: 'other', rate: 18, sac: null, gross: 1 }]
}

/** Rates of the advances still held, net of refunds, by their share. */
async function advanceBuckets(t: Db, eventId: string): Promise<Bucket[]> {
  const docs = await t.query<{ doc_type: string; lines: (DocLine & { kind?: string })[] }>(
    `select doc_type, lines from tax_document where event_id = $1 and doc_type in ('receipt_voucher','refund_voucher')`, [eventId])
  const m = new Map<string, Bucket>()
  for (const d of docs) for (const l of d.lines) {
    const k = `${l.kind}|${l.gstRate}|${l.sac}`
    const b = m.get(k) ?? { kind: l.kind ?? 'other', rate: Number(l.gstRate), sac: l.sac, gross: 0 }
    b.gross += (d.doc_type === 'receipt_voucher' ? 1 : -1) * l.total; m.set(k, b)
  }
  return [...m.values()].filter((b) => b.gross > 0)
}

export async function eventRow(t: Db, eventId: string) {
  const [e] = await t.query<EventRow & { status: string; kind: string }>('select * from event where id = $1', [eventId])
  return e
}

/** Net advances held on GST vouchers (receipts less refunds). */
export async function advancesHeld(t: Db, eventId: string) {
  const [r] = await t.query<{ v: string | null }>(
    `select sum(case when doc_type = 'receipt_voucher' then total_paise else -total_paise end) as v from tax_document where event_id = $1 and doc_type in ('receipt_voucher','refund_voucher')`, [eventId])
  return n(r.v)
}

/** Receipt voucher for an advance: its GST spread over the rates of the accepted quote. */
export async function eventReceiptVoucher(ctx: Ctx, t: Db, who: Caller, eventId: string, amount: number) {
  const e = await eventRow(t, eventId)
  const lines = apportion(amount, await quoteBuckets(t, eventId), `Advance for ${e.title} (${e.number})`)
  return issue(ctx, t, who, { docType: 'receipt_voucher', reservationId: null, eventId, recipient: recipientOf(e), lines })
}

/** Refund voucher: reverses the GST on what is returned, at the rates the advances were taxed. */
export async function eventRefundVoucher(ctx: Ctx, t: Db, who: Caller, eventId: string, amount: number) {
  const e = await eventRow(t, eventId)
  const [rv] = await t.query<{ id: string }>(`select id from tax_document where event_id = $1 and doc_type = 'receipt_voucher' order by issued_at desc limit 1`, [eventId])
  const lines = apportion(amount, await advanceBuckets(t, eventId), `Refund of advance for ${e.title} (${e.number})`)
  return issue(ctx, t, who, { docType: 'refund_voucher', reservationId: null, eventId, originalId: rv?.id ?? null, recipient: recipientOf(e), lines })
}

/** The final bill, with the advances taken in. */
export async function eventInvoice(ctx: Ctx, t: Db, who: Caller, eventId: string, discountPercent: number) {
  const e = await eventRow(t, eventId)
  const lines = taxLines(await priceLines(ctx, t, eventId, { bill: true }), discountPercent).map(({ functionId: _f, ...l }) => l)
  return issue(ctx, t, who, { docType: 'invoice', reservationId: null, eventId, recipient: recipientOf(e), lines, advanceAdjusted: await advancesHeld(t, eventId) })
}

/** On cancellation, what is kept of the advances becomes the cancellation charge, at the rates already paid on it. CA check */
export async function cancellationInvoice(ctx: Ctx, t: Db, who: Caller, eventId: string, retained: number) {
  const e = await eventRow(t, eventId)
  const lines = apportion(retained, await advanceBuckets(t, eventId), `Cancellation charge, ${e.title} (${e.number})`)
  return issue(ctx, t, who, { docType: 'invoice', reservationId: null, eventId, recipient: recipientOf(e), lines, advanceAdjusted: retained, reason: 'Event cancelled' })
}

/** Tables and chairs a setup needs, as a starting point for housekeeping. */
export function seating(style: string, pax: number) {
  const c = Math.ceil
  switch (style) {
    case 'rounds': return { tables: c(pax / 10), chairs: pax, note: 'Round tables of 10' }
    case 'theatre': return { tables: 0, chairs: pax, note: 'Rows facing the stage' }
    case 'u_shape': return { tables: c(pax / 2), chairs: pax, note: 'Tables in a U, seats on the outside' }
    case 'classroom': return { tables: c(pax / 3), chairs: pax, note: 'Tables of 3 facing the front' }
    case 'cocktail': return { tables: c(pax / 8), chairs: c(pax * 0.2), note: 'High tables, a few chairs along the sides' }
    default: return { tables: 0, chairs: c(pax * 0.3), note: 'Buffet counters, seating for about a third' }
  }
}

/** The event order as it stands: what every department needs, per function. */
export async function buildBeo(t: Db, eventId: string) {
  const [e] = await t.query<{ number: string; title: string; kind: string; client_name: string; client_mobile: string | null; owner: string | null; instructions: Record<string, string> }>(
    'select e.number, e.title, e.kind, e.client_name, e.client_mobile, u.name as owner, e.instructions from event e left join app_user u on u.id = e.owner_id where e.id = $1', [eventId])
  const fns = await t.query<{ id: string; name: string; venue: string; venue_id: string; starts_at: Date; ends_at: Date; setup_style: string; expected_pax: number; guaranteed_pax: number | null; menu: string | null; veg: boolean | null; items: string[] | null }>(
    `select f.id, f.name, s.name as venue, f.venue_id, f.starts_at, f.ends_at, f.setup_style, f.expected_pax, f.guaranteed_pax, p.name as menu, p.veg, p.items
       from event_function f join space s on s.id = f.venue_id left join banquet_package p on p.id = f.menu_id where f.event_id = $1 order by f.starts_at, f.id`, [eventId])
  const extras = await t.query<{ description: string; qty: string; function_id: string | null }>('select description, qty, function_id from event_item where event_id = $1 order by created_at, id', [eventId])
  const checks = await t.query<{ item: string; status: string; ref: string | null }>('select item, status, ref from event_check where event_id = $1 order by item', [eventId])
  return {
    number: e.number, title: e.title, kind: e.kind, client: e.client_name, mobile: e.client_mobile, owner: e.owner,
    functions: fns.map((f) => {
      const pax = f.guaranteed_pax ?? f.expected_pax
      return { id: f.id, name: f.name, venue: f.venue, venueId: f.venue_id, date: istDate(f.starts_at), from: istTime(f.starts_at), to: istTime(f.ends_at), style: f.setup_style, pax,
        menu: f.menu ? { name: f.menu, veg: f.veg, items: f.items ?? [] } : null, plates: f.menu ? Math.ceil(pax * (1 + PRODUCTION_MARGIN)) : 0,
        seating: seating(f.setup_style, pax), parking: Math.ceil(pax / 3),
        extras: extras.filter((x) => x.function_id === f.id).map((x) => ({ description: x.description, qty: n(x.qty) })) }
    }),
    extras: extras.filter((x) => !x.function_id).map((x) => ({ description: x.description, qty: n(x.qty) })),
    instructions: Object.fromEntries(Object.keys(BEO_DEPTS).map((d) => [d, e.instructions?.[d] ?? ''])),
    checks: checks.map((c) => ({ item: c.item, label: CHECKS[c.item] ?? c.item, status: c.status, ref: c.ref })),
  }
}
export type Beo = Awaited<ReturnType<typeof buildBeo>>

/** JSON with keys in a fixed order: the database stores a BEO's keys in its own order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

/** Departments a person reads the BEO for, by their roles (God Mode and banquet sales: all). */
export function beoDeptsOf(who: Caller) {
  if (who.permissions.has('*') || who.permissions.has('events.manage')) return Object.keys(BEO_DEPTS)
  return Object.entries(BEO_DEPTS).filter(([, d]) => d.roles.some((r) => who.roles.includes(r))).map(([k]) => k)
}

/** Placeholder setups and rentals for the seeded venues, and a few packages, until the resort's own are entered. */
export async function ensureBanquets(db: Db, now = new Date()) {
  const [{ c }] = await db.query<{ c: number }>('select count(*)::int as c from venue_setup')
  if (c > 0) return
  const venues = await db.query<{ id: string; kind: string; capacity: number | null }>(`select id, kind, capacity from space where kind = any($1) and active`, [VENUE_KINDS])
  for (const v of venues) {
    const cap = v.capacity ?? 200
    const setups: [string, number][] = v.kind === 'hall' ? [['theatre', cap], ['rounds', Math.round(cap * 0.6)], ['classroom', Math.round(cap * 0.4)], ['u_shape', Math.min(80, Math.round(cap * 0.1))], ['floating', cap]]
      : [['rounds', Math.round(cap * 0.7)], ['floating', cap], ['cocktail', Math.round(cap * 0.8)], ['theatre', cap]]
    for (const [style, capacity] of setups) await db.query('insert into venue_setup (space_id, style, capacity) values ($1,$2,$3) on conflict do nothing', [v.id, style, capacity])
    const rental = { hall: 75_000, lawn: 60_000, pavilion: 25_000, ground: 40_000 }[v.kind] ?? 0
    await db.query('update space set rental_paise = coalesce(rental_paise, $2) where id = $1', [v.id, rental * 100])
  }
  const packages: [string, string, string, number, string, boolean | null, string[], number][] = [
    ['PKG-VEG-SILVER', 'Silver vegetarian', 'menu', 650, 'plate', true, ['Welcome drink', 'Two starters', 'Sambar, rasam, two poriyal, kootu', 'Biryani or pulao', 'Curd rice', 'Payasam and one sweet', 'Banana leaf service'], 100],
    ['PKG-VEG-GOLD', 'Gold vegetarian', 'menu', 900, 'plate', true, ['Welcome drink and live chaat', 'Four starters', 'Full South Indian meal', 'North Indian main course', 'Two sweets and ice cream'], 100],
    ['PKG-NV-GOLD', 'Gold non-vegetarian', 'menu', 1150, 'plate', false, ['Welcome drink', 'Chicken 65, fish fry, two veg starters', 'Mutton biryani', 'Chicken chettinad', 'Veg main course', 'Two sweets'], 100],
    ['PKG-DECOR-STD', 'Stage and entrance decor', 'decor', 45_000, 'event', null, ['Stage backdrop with flowers', 'Entrance arch', 'Aisle lights'], 0],
  ]
  for (const [id, name, kind, price, per, veg, items, min] of packages) {
    await db.query('insert into banquet_package (id, name, kind, price_paise, per, veg, items, min_pax, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing',
      [id, name, kind, price * 100, per, veg, items, min, now])
  }
}
