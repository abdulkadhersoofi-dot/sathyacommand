import type { FastifyInstance, FastifyRequest } from 'fastify'
import { financialYear, priceGuard, rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, newId } from '../eng-core'
import { businessDate, freeByNight, nightsOf } from '../fo-core'
import { nextSeriesNumber } from '../invoicing'
import { debtorOutstanding } from '../receivables'
import { blockPickup, sweepBlocks } from '../sales'
import { requireCaller } from './auth'
import { bookStay } from './frontoffice'

// Sales: company accounts with their contacts, account manager and contracted room rates; follow-ups; the
// pipeline of events by stage and why events were lost; and room blocks for weddings and groups (held until
// the cut-off, picked up from a rooming list, the rest released).

const DATE = /^\d{4}-\d{2}-\d{2}$/
const KINDS = ['call', 'visit', 'meeting', 'email', 'whatsapp', 'note']
const n = (v: unknown) => Number(v ?? 0)
const str = (v: unknown, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null }
const fyStart = (d: string) => `${Number(d.slice(5, 7)) >= 4 ? d.slice(0, 4) : Number(d.slice(0, 4)) - 1}-04-01`

/** Reads a CSV line, with quoted fields. */
function csvCells(line: string) {
  const out: string[] = []
  let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false; else cur += c }
    else if (c === '"') q = true
    else if (c === ',') { out.push(cur.trim()); cur = '' }
    else cur += c
  }
  out.push(cur.trim())
  return out
}

export function salesRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const VIEW = ['sales.manage', 'rates.contract', 'events.view', 'events.manage']
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id

  // ---------- accounts ----------
  app.get('/api/sales/accounts', async (req) => {
    await need(req, ...VIEW, 'front_desk')
    const today = await businessDate(db), from = fyStart(today)
    const rows = await db.query<{ id: string; name: string; kind: string; gstin: string | null; city: string | null; contact_name: string | null; phone: string | null; active: boolean; owner: string | null; owner_id: string | null
      nights: string | null; room_rev: string | null; event_rev: string | null; rates: number; next_due: string | null; credit_limit_paise: string | null }>(
      `select d.id, d.name, d.kind, d.gstin, d.city, d.contact_name, d.phone, d.active, u.name as owner, d.owner_id, d.credit_limit_paise,
              (select count(*) from room_night rn join reservation r on r.id = rn.reservation_id where r.debtor_id = d.id and not rn.released and rn.night >= $1 and r.status <> 'cancelled') as nights,
              (select sum(rn.amount_paise) from room_night rn join reservation r on r.id = rn.reservation_id where r.debtor_id = d.id and not rn.released and rn.night >= $1 and r.status <> 'cancelled') as room_rev,
              (select sum(x.total_paise) from tax_document x join event e on e.id = x.event_id where e.debtor_id = d.id and x.doc_type = 'invoice' and x.issue_date >= $1) as event_rev,
              (select count(*)::int from contract_rate c where c.debtor_id = d.id and c.valid_to >= $2) as rates,
              (select min(a.due_on)::text from sales_activity a where a.debtor_id = d.id and a.done_at is null) as next_due
         from debtor d left join app_user u on u.id = d.owner_id where d.kind <> 'ota' order by d.active desc, d.name`, [from, today])
    return { from, accounts: rows.map((r) => ({ ...r, nights: n(r.nights), roomRevenuePaise: n(r.room_rev), eventRevenuePaise: n(r.event_rev), creditLimitPaise: r.credit_limit_paise == null ? null : n(r.credit_limit_paise) })) }
  })

  // Who can look after a company account: the selling roles, for the "Handled by" choice.
  app.get('/api/sales/people', async (req) => {
    await need(req, ...VIEW, 'front_desk')
    return db.query(`select distinct u.id, u.name from app_user u join user_role ur on ur.user_id = u.id
                      where u.active and u.id <> 'system' and ur.role_id = any($1) order by u.name`, [['sales_banquets', 'general_manager', 'front_office_manager', 'managing_director']])
  })

  app.get('/api/sales/accounts/:id', async (req) => {
    await need(req, ...VIEW, 'front_desk')
    const [d] = await db.query<Record<string, unknown> & { id: string; owner_id: string | null }>(
      'select d.*, u.name as owner from debtor d left join app_user u on u.id = d.owner_id where d.id = $1', [idOf(req)])
    if (!d) throw new HttpError(404, 'No such account.')
    const today = await businessDate(db)
    const contacts = await db.query('select id, name, role, mobile, email from account_contact where debtor_id = $1 order by created_at', [d.id])
    const rates = (await db.query<{ id: string; room_type_id: string; room_type: string; plan_code: string; valid_from: string; valid_to: string; rate_paise: string; by: string }>(
      `select c.id, c.room_type_id, t.name as room_type, c.plan_code, c.valid_from::text, c.valid_to::text, c.rate_paise, u.name as by from contract_rate c join room_type t on t.id = c.room_type_id join app_user u on u.id = c.set_by
        where c.debtor_id = $1 order by c.valid_to < $2, c.room_type_id, c.plan_code, c.valid_from`, [d.id, today])).map((r) => ({ ...r, rate_paise: n(r.rate_paise), current: r.valid_to >= today }))
    const activities = await db.query(
      `select a.id, a.kind, a.subject, a.due_on::text, a.done_at, a.outcome, u.name as owner from sales_activity a join app_user u on u.id = a.owner_id where a.debtor_id = $1 order by a.done_at is not null, a.due_on nulls last, a.created_at desc limit 50`, [d.id])
    const stays = await db.query(
      `select r.id, g.name as guest, r.arrival::text, r.departure::text, r.status, r.room_type_id, (select sum(amount_paise) from room_night where reservation_id = r.id and not released) as amount_paise
         from reservation r join guest g on g.id = r.guest_id where r.debtor_id = $1 order by r.arrival desc limit 30`, [d.id])
    const events = await db.query(`select id, number, title, status from event where debtor_id = $1 order by created_at desc limit 30`, [d.id])
    return { account: { ...d, credit_limit_paise: d.credit_limit_paise == null ? null : n(d.credit_limit_paise) }, contacts, rates, activities, stays, events, outstandingPaise: await debtorOutstanding(db, d.id), today }
  })

  app.post('/api/sales/accounts/:id/contacts', async (req, reply) => {
    const who = await need(req, 'sales.manage')
    const b = (req.body ?? {}) as { name?: string; role?: string; mobile?: string; email?: string }
    const name = str(b.name, 120)
    if (!name) throw new HttpError(400, 'Enter the contact\'s name.')
    return db.tx(async (t) => {
      const [d] = await t.query<{ name: string }>('select name from debtor where id = $1', [idOf(req)])
      if (!d) throw new HttpError(404, 'No such account.')
      const id = newId('CT')
      await t.query('insert into account_contact (id, debtor_id, name, role, mobile, email, created_at) values ($1,$2,$3,$4,$5,$6,$7)', [id, idOf(req), name, str(b.role, 80), str(b.mobile, 20), str(b.email, 254), now()])
      await appendAudit(t, { actor: who, action: 'account.contact_add', entity: { type: 'debtor', id: idOf(req) }, note: `${d.name}: ${name}` }, now())
      return reply.status(201).send({ id })
    })
  })

  app.delete('/api/sales/contacts/:id', async (req) => {
    const who = await need(req, 'sales.manage')
    const [c] = await db.query<{ debtor_id: string; name: string }>('select debtor_id, name from account_contact where id = $1', [idOf(req)])
    if (!c) throw new HttpError(404, 'No such contact.')
    await db.tx(async (t) => {
      await t.query('delete from account_contact where id = $1', [idOf(req)])
      await appendAudit(t, { actor: who, action: 'account.contact_remove', entity: { type: 'debtor', id: c.debtor_id }, note: c.name }, now())
    })
    return { ok: true }
  })

  // ---------- contracted rates ----------
  app.post('/api/sales/accounts/:id/rates', async (req, reply) => {
    const who = await need(req, 'rates.contract')
    const b = (req.body ?? {}) as { roomTypeId?: string; plan?: string; validFrom?: string; validTo?: string; rate?: number }
    if (!DATE.test(b.validFrom ?? '') || !DATE.test(b.validTo ?? '') || b.validTo! < b.validFrom!) throw new HttpError(400, 'Valid from and to (YYYY-MM-DD).')
    if (!(n(b.rate) > 0)) throw new HttpError(400, 'Enter the rate per night (₹).')
    const amount = rupees(n(b.rate))
    // A contracted rate above ₹7,500 would move the restaurant to 18% next year, as any other rate would.
    const guard = priceGuard(ctx.tax, amount)
    if (!guard.allowed && !who.permissions.has('*')) throw new HttpError(403, guard.message ?? 'Needs the MD.', { requires: guard.requires })
    return db.tx(async (t) => {
      const [d] = await t.query<{ name: string }>('select name from debtor where id = $1', [idOf(req)])
      if (!d) throw new HttpError(404, 'No such account.')
      const [rt] = await t.query('select 1 from room_type where id = $1 and active', [b.roomTypeId])
      if (!rt) throw new HttpError(400, 'Pick a room type.')
      const [plan] = await t.query('select 1 from rate_plan where code = $1 and active', [b.plan])
      if (!plan) throw new HttpError(400, 'Pick a meal plan.')
      const [clash] = await t.query<{ valid_from: string; valid_to: string }>(
        `select valid_from::text, valid_to::text from contract_rate where debtor_id = $1 and room_type_id = $2 and plan_code = $3 and valid_from <= $5 and valid_to >= $4`, [idOf(req), b.roomTypeId, b.plan, b.validFrom, b.validTo])
      if (clash) throw new HttpError(409, `${d.name} already has this rate from ${clash.valid_from} to ${clash.valid_to}.`)
      const id = newId('CR')
      await t.query('insert into contract_rate (id, debtor_id, room_type_id, plan_code, valid_from, valid_to, rate_paise, set_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, idOf(req), b.roomTypeId, b.plan, b.validFrom, b.validTo, amount, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'contract_rate.set', entity: { type: 'debtor', id: idOf(req) }, amount, after: { roomTypeId: b.roomTypeId, plan: b.plan, from: b.validFrom, to: b.validTo }, note: d.name }, now())
      return reply.status(201).send({ id })
    })
  })

  app.delete('/api/sales/rates/:id', async (req) => {
    const who = await need(req, 'rates.contract')
    const [r] = await db.query<{ debtor_id: string; rate_paise: string }>('select debtor_id, rate_paise from contract_rate where id = $1', [idOf(req)])
    if (!r) throw new HttpError(404, 'No such rate.')
    await db.tx(async (t) => {
      await t.query('delete from contract_rate where id = $1', [idOf(req)])
      await appendAudit(t, { actor: who, action: 'contract_rate.remove', entity: { type: 'debtor', id: r.debtor_id }, amount: n(r.rate_paise) }, now())
    })
    return { ok: true }
  })

  // ---------- follow-ups ----------
  app.get('/api/sales/activities', async (req) => {
    const who = await need(req, ...VIEW)
    const q = req.query as { all?: string }
    const rows = await db.query(
      `select a.id, a.kind, a.subject, a.due_on::text, a.done_at, a.outcome, a.debtor_id, d.name as account, a.event_id, e.number as event_number, e.title as event, u.name as owner, a.owner_id
         from sales_activity a join app_user u on u.id = a.owner_id left join debtor d on d.id = a.debtor_id left join event e on e.id = a.event_id
        where a.done_at is null and ($1 or a.owner_id = $2) order by a.due_on nulls last, a.created_at`, [q.all === '1', who.userId])
    return { today: await businessDate(db), activities: rows }
  })

  app.post('/api/sales/activities', async (req, reply) => {
    const who = await need(req, 'sales.manage', 'events.manage')
    const b = (req.body ?? {}) as { debtorId?: string; eventId?: string; kind?: string; subject?: string; dueOn?: string; ownerId?: string; done?: boolean; outcome?: string }
    if (!KINDS.includes(b.kind ?? '')) throw new HttpError(400, `Kind: ${KINDS.join(', ')}.`)
    const subject = str(b.subject, 200)
    if (!subject) throw new HttpError(400, 'What is it about?')
    if (!b.debtorId && !b.eventId) throw new HttpError(400, 'For an account or an event.')
    if (b.dueOn && !DATE.test(b.dueOn)) throw new HttpError(400, 'Due: a date.')
    return db.tx(async (t) => {
      if (b.debtorId) { const [d] = await t.query('select 1 from debtor where id = $1', [b.debtorId]); if (!d) throw new HttpError(404, 'No such account.') }
      if (b.eventId) { const [e] = await t.query('select 1 from event where id = $1', [b.eventId]); if (!e) throw new HttpError(404, 'No such event.') }
      const owner = b.ownerId || who.userId
      const [u] = await t.query('select 1 from app_user where id = $1 and active', [owner])
      if (!u) throw new HttpError(400, 'No such person.')
      const id = newId('SA')
      await t.query('insert into sales_activity (id, debtor_id, event_id, kind, subject, due_on, done_at, outcome, owner_id, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [id, b.debtorId ?? null, b.eventId ?? null, b.kind, subject, b.dueOn || null, b.done ? now() : null, str(b.outcome, 1000), owner, who.userId, now()])
      await appendAudit(t, { actor: who, action: b.done ? 'sales.activity_logged' : 'sales.follow_up', entity: { type: b.eventId ? 'event' : 'debtor', id: (b.eventId ?? b.debtorId)! }, note: subject }, now())
      return reply.status(201).send({ id })
    })
  })

  app.post('/api/sales/activities/:id/done', async (req) => {
    const who = await need(req, 'sales.manage', 'events.manage')
    const b = (req.body ?? {}) as { outcome?: string; next?: { kind?: string; subject?: string; dueOn?: string } }
    return db.tx(async (t) => {
      const [a] = await t.query<{ id: string; debtor_id: string | null; event_id: string | null; done_at: Date | null; subject: string }>('select * from sales_activity where id = $1 for update', [idOf(req)])
      if (!a) throw new HttpError(404, 'No such follow-up.')
      if (a.done_at) throw new HttpError(409, 'Already done.')
      await t.query('update sales_activity set done_at = $2, outcome = $3 where id = $1', [a.id, now(), str(b.outcome, 1000)])
      // The next step, booked straight away.
      if (b.next?.subject && KINDS.includes(b.next.kind ?? '') && DATE.test(b.next.dueOn ?? '')) {
        await t.query('insert into sales_activity (id, debtor_id, event_id, kind, subject, due_on, owner_id, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$7,$8)',
          [newId('SA'), a.debtor_id, a.event_id, b.next.kind, str(b.next.subject, 200), b.next.dueOn, who.userId, now()])
      }
      await appendAudit(t, { actor: who, action: 'sales.activity_done', entity: { type: a.event_id ? 'event' : 'debtor', id: (a.event_id ?? a.debtor_id)! }, note: `${a.subject}: ${str(b.outcome, 120) ?? ''}` }, now())
      return { ok: true }
    })
  })

  // ---------- pipeline ----------
  app.get('/api/sales/pipeline', async (req) => {
    await need(req, ...VIEW)
    const today = await businessDate(db), from = fyStart(today)
    const value = `coalesce((select x.total_paise from tax_document x where x.event_id = e.id and x.doc_type = 'invoice' order by x.issued_at desc limit 1),
                            (select q.total_paise from event_quote q where q.event_id = e.id and q.status <> 'rejected' order by (q.status = 'accepted') desc, q.version desc limit 1), 0)`
    const stages = await db.query<{ status: string; c: number; v: string }>(
      `select e.status, count(*)::int as c, sum(${value}) as v from event e where e.status in ('enquiry','quoted','hold','definite') group by e.status`)
    const year = await db.query<{ status: string; c: number; v: string }>(
      `select e.status, count(*)::int as c, sum(${value}) as v from event e where e.created_at >= $1::date group by e.status`, [from])
    const lost = await db.query<{ reason: string; c: number; v: string }>(
      `select coalesce(e.lost_reason, 'Not given') as reason, count(*)::int as c, sum(${value}) as v from event e where e.status = 'lost' and e.created_at >= $1::date group by 1 order by 2 desc`, [from])
    const owners = await db.query<{ owner: string; open: number; open_v: string; won: number; won_v: string }>(
      `select coalesce(u.name, 'Nobody') as owner, count(*) filter (where e.status in ('enquiry','quoted','hold'))::int as open, sum(${value}) filter (where e.status in ('enquiry','quoted','hold')) as open_v,
              count(*) filter (where e.status in ('definite','billed','closed'))::int as won, sum(${value}) filter (where e.status in ('definite','billed','closed')) as won_v
         from event e left join app_user u on u.id = e.owner_id where e.created_at >= $1::date group by 1 order by 1`, [from])
    const sources = await db.query<{ source: string; c: number; won: number }>(
      `select e.source, count(*)::int as c, count(*) filter (where e.status in ('definite','billed','closed'))::int as won from event e where e.created_at >= $1::date group by 1 order by 2 desc`, [from])
    const won = year.filter((y) => ['definite', 'billed', 'closed'].includes(y.status)), lostN = year.find((y) => y.status === 'lost')?.c ?? 0
    const wonN = won.reduce((a, y) => a + y.c, 0)
    const [due] = await db.query<{ c: number }>('select count(*)::int as c from sales_activity where done_at is null and due_on <= $1', [today])
    return {
      from, today,
      stages: ['enquiry', 'quoted', 'hold', 'definite'].map((s) => { const r = stages.find((x) => x.status === s); return { status: s, count: r?.c ?? 0, valuePaise: n(r?.v) } }),
      wonCount: wonN, wonPaise: won.reduce((a, y) => a + n(y.v), 0), lostCount: lostN, conversion: wonN + lostN ? Math.round((wonN * 100) / (wonN + lostN)) : null,
      lost: lost.map((l) => ({ reason: l.reason, count: l.c, valuePaise: n(l.v) })),
      owners: owners.map((o) => ({ owner: o.owner, open: o.open, openPaise: n(o.open_v), won: o.won, wonPaise: n(o.won_v) })),
      sources, followUpsDue: due.c,
    }
  })

  // ---------- room blocks ----------
  async function blockDetail(t: Db, id: string) {
    const [k] = await t.query<{ id: string; number: string; name: string; event_id: string | null; event: string | null; debtor_id: string | null; account: string | null; arrival: string; departure: string; cutoff: string; plan_code: string; status: string }>(
      `select k.id, k.number, k.name, k.event_id, e.title as event, k.debtor_id, d.name as account, k.arrival::text, k.departure::text, k.cutoff::text, k.plan_code, k.status
         from room_block k left join event e on e.id = k.event_id left join debtor d on d.id = k.debtor_id where k.id = $1`, [id])
    if (!k) throw new HttpError(404, 'No such room block.')
    const nights = nightsOf(k.arrival, k.departure)
    const lines = []
    for (const l of await t.query<{ room_type_id: string; name: string; rooms: number; rate_paise: string }>(
      'select l.room_type_id, t.name, l.rooms, l.rate_paise from room_block_line l join room_type t on t.id = l.room_type_id where l.block_id = $1 order by t.base_rate_paise', [id])) {
      const pick = await blockPickup(t, id, l.room_type_id, nights)
      lines.push({ roomTypeId: l.room_type_id, name: l.name, rooms: l.rooms, ratePaise: n(l.rate_paise), nights: pick.map((p) => ({ night: p.night, picked: p.picked })) })
    }
    const stays = await t.query(
      `select r.id, g.name as guest, g.mobile, r.room_type_id, r.arrival::text, r.departure::text, r.status, s.room_no from reservation r join guest g on g.id = r.guest_id left join space s on s.id = r.space_id
        where r.block_id = $1 order by g.name`, [id])
    const held = lines.reduce((a, l) => a + l.nights.reduce((x, p) => x + Math.max(0, l.rooms - p.picked), 0), 0)
    const allotted = lines.reduce((a, l) => a + l.rooms * nights.length, 0)
    return { ...k, nights, lines, stays, roomNights: { allotted, picked: allotted - held, held } }
  }

  app.get('/api/sales/blocks', async (req) => {
    await need(req, ...VIEW, 'front_desk')
    const today = await businessDate(db)
    await db.tx((t) => sweepBlocks(t, today, null, now()))
    const ids = await db.query<{ id: string }>(`select id from room_block where departure >= $1 or status = 'open' order by arrival`, [addDays(today, -30)])
    const out = []
    for (const { id } of ids) { const d = await blockDetail(db, id); out.push({ ...d, stays: undefined, stayCount: d.stays.length }) }
    return { today, blocks: out }
  })

  app.get('/api/sales/blocks/:id', async (req) => {
    await need(req, ...VIEW, 'front_desk')
    return blockDetail(db, idOf(req))
  })

  app.post('/api/sales/blocks', async (req, reply) => {
    const who = await need(req, 'sales.manage')
    const b = (req.body ?? {}) as { name?: string; eventId?: string; debtorId?: string; arrival?: string; departure?: string; cutoff?: string; plan?: string; lines?: { roomTypeId?: string; rooms?: number; rate?: number }[] }
    const name = str(b.name, 120)
    if (!name) throw new HttpError(400, 'Name the block, e.g. "Ravi and Priya wedding guests".')
    if (!DATE.test(b.arrival ?? '') || !DATE.test(b.departure ?? '') || b.departure! <= b.arrival!) throw new HttpError(400, 'Arrival and departure (departure after arrival).')
    const nights = nightsOf(b.arrival!, b.departure!)
    if (nights.length > 30) throw new HttpError(400, 'A block can be at most 30 nights.')
    if (!b.lines?.length) throw new HttpError(400, 'How many rooms of which type?')
    return db.tx(async (t) => {
      const today = await businessDate(t)
      if (b.arrival! < today) throw new HttpError(400, 'Arrival is in the past.')
      const cutoff = b.cutoff ?? addDays(b.arrival!, -14)
      if (!DATE.test(cutoff) || cutoff > b.arrival!) throw new HttpError(400, 'The cut-off is on or before arrival.')
      const [plan] = await t.query('select 1 from rate_plan where code = $1 and active', [b.plan ?? 'CP'])
      if (!plan) throw new HttpError(400, 'Pick a meal plan.')
      if (b.eventId) { const [e] = await t.query('select 1 from event where id = $1', [b.eventId]); if (!e) throw new HttpError(404, 'No such event.') }
      if (b.debtorId) { const [d] = await t.query('select 1 from debtor where id = $1', [b.debtorId]); if (!d) throw new HttpError(404, 'No such account.') }
      await t.query('select pg_advisory_xact_lock($1)', [7_301_002])     // with reservations: one booking decision at a time
      for (const l of b.lines!) {
        if (!(Number.isInteger(l.rooms) && l.rooms! > 0) || !(n(l.rate) > 0)) throw new HttpError(400, 'Each line: a room type, a number of rooms and a rate per night.')
        const guard = priceGuard(ctx.tax, rupees(n(l.rate)))
        if (!guard.allowed && !who.permissions.has('*')) throw new HttpError(403, guard.message ?? 'Needs the MD.', { requires: guard.requires })
        const short = (await freeByNight(t, l.roomTypeId!, nights)).filter((x) => x.free < l.rooms!)
        if (short.length) throw new HttpError(409, `Only ${Math.min(...short.map((x) => x.free))} ${l.roomTypeId} rooms are free on ${short.map((x) => x.night).join(', ')}.`, { short })
      }
      const id = newId('BLK'), number = await nextSeriesNumber(t, 'room_block', financialYear(today), 'BLK')
      await t.query('insert into room_block (id, number, name, event_id, debtor_id, arrival, departure, cutoff, plan_code, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [id, number, name, b.eventId ?? null, b.debtorId ?? null, b.arrival, b.departure, cutoff, b.plan ?? 'CP', who.userId, now()])
      for (const l of b.lines!) await t.query('insert into room_block_line (block_id, room_type_id, rooms, rate_paise) values ($1,$2,$3,$4)', [id, l.roomTypeId, l.rooms, rupees(n(l.rate))])
      await appendAudit(t, { actor: who, action: 'room_block.create', entity: { type: 'room_block', id }, after: { name, arrival: b.arrival, departure: b.departure, cutoff, lines: b.lines }, note: number }, now())
      return reply.status(201).send({ id, number, cutoff })
    })
  })

  /** Change the rooms held per type: never below what is already picked up; more only if free. */
  app.put('/api/sales/blocks/:id/lines', async (req) => {
    const who = await need(req, 'sales.manage')
    const b = (req.body ?? {}) as { lines?: { roomTypeId?: string; rooms?: number }[] }
    return db.tx(async (t) => {
      const k = await blockDetail(t, idOf(req))
      if (k.status !== 'open') throw new HttpError(409, `This block is ${k.status}.`)
      await t.query('select pg_advisory_xact_lock($1)', [7_301_002])
      for (const l of b.lines ?? []) {
        const cur = k.lines.find((x) => x.roomTypeId === l.roomTypeId)
        if (!cur) throw new HttpError(400, `The block has no ${l.roomTypeId} rooms.`)
        const rooms = Number(l.rooms)
        if (!(Number.isInteger(rooms) && rooms >= 0)) throw new HttpError(400, 'Rooms: a whole number.')
        const picked = Math.max(0, ...cur.nights.map((x) => x.picked))
        if (rooms < picked) throw new HttpError(409, `${picked} ${cur.name} rooms are already booked in the block.`)
        if (rooms > cur.rooms) {
          const short = (await freeByNight(t, cur.roomTypeId, k.nights, undefined, k.id)).filter((x, i) => x.free - (cur.rooms - cur.nights[i].picked) < rooms - cur.rooms)
          if (short.length) throw new HttpError(409, `Not enough ${cur.name} rooms free on ${short.map((x) => x.night).join(', ')}.`)
        }
        if (rooms === 0) await t.query('delete from room_block_line where block_id = $1 and room_type_id = $2', [k.id, cur.roomTypeId])
        else await t.query('update room_block_line set rooms = $3 where block_id = $1 and room_type_id = $2', [k.id, cur.roomTypeId, rooms])
      }
      await appendAudit(t, { actor: who, action: 'room_block.change', entity: { type: 'room_block', id: k.id }, after: b.lines, note: k.number }, now())
      return { ok: true }
    })
  })

  app.post('/api/sales/blocks/:id/release', async (req) => {
    const who = await need(req, 'sales.manage')
    return db.tx(async (t) => {
      const [k] = await t.query<{ status: string; number: string }>('select status, number from room_block where id = $1 for update', [idOf(req)])
      if (!k) throw new HttpError(404, 'No such room block.')
      if (k.status !== 'open') throw new HttpError(409, `This block is ${k.status}.`)
      await t.query(`update room_block set status = 'released', released_at = $2 where id = $1`, [idOf(req), now()])
      await appendAudit(t, { actor: who, action: 'room_block.release', entity: { type: 'room_block', id: idOf(req) }, note: k.number }, now())
      return { ok: true }
    })
  })

  const pickers = ['sales.manage', 'front_desk']
  const asBooking = (who: Caller, k: { id: string; debtor_id: string | null; arrival: string; departure: string }, g: { name?: string; mobile?: string; roomTypeId?: string; arrival?: string; departure?: string; adults?: number; requests?: string }) => ({
    guest: { name: g.name, mobile: g.mobile }, roomTypeId: g.roomTypeId, plan: 'EP', arrival: g.arrival || k.arrival, departure: g.departure || k.departure, adults: g.adults ?? 2,
    requests: g.requests, blockId: k.id, debtorId: k.debtor_id ?? undefined, source: 'direct' as const, _who: who,
  })

  app.post('/api/sales/blocks/:id/book', async (req, reply) => {
    const who = await need(req, ...pickers)
    const b = (req.body ?? {}) as { name?: string; mobile?: string; roomTypeId?: string; arrival?: string; departure?: string; adults?: number; requests?: string }
    const k = await blockDetail(db, idOf(req))
    const { _who: _w, ...input } = asBooking(who, k, b)
    const r = await db.tx((t) => bookStay(ctx, t, who, input))
    return reply.status(201).send(r)
  })

  /**
   * The rooming list: one guest per line (name, mobile, room type, arrival, departure, adults, requests); the
   * dates default to the block's. Each line is booked on its own, so one bad line does not stop the rest.
   */
  app.post('/api/sales/blocks/:id/rooming-list', async (req) => {
    const who = await need(req, ...pickers)
    const text = String(((req.body ?? {}) as { csv?: string }).csv ?? '')
    const k = await blockDetail(db, idOf(req))
    const types = await db.query<{ id: string; name: string }>('select id, name from room_type')
    const typeOf = (v: string) => types.find((x) => x.id.toLowerCase() === v.toLowerCase() || x.name.toLowerCase() === v.toLowerCase())?.id ?? (k.lines.length === 1 && !v ? k.lines[0].roomTypeId : v)
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length && /name/i.test(lines[0]) && /mobile|phone|room/i.test(lines[0])) lines.shift()
    if (!lines.length) throw new HttpError(400, 'Paste the rooming list: name, mobile, room type, arrival, departure, adults, requests.')
    if (lines.length > 300) throw new HttpError(400, 'At most 300 guests at a time.')
    const booked: { line: number; name: string; reservationId: string }[] = [], errors: { line: number; name: string; error: string }[] = []
    for (const [i, line] of lines.entries()) {
      const [name, mobile, type, arrival, departure, adults, requests] = csvCells(line)
      try {
        const { _who: _w, ...input } = asBooking(who, k, { name, mobile, roomTypeId: typeOf(type ?? ''), arrival, departure, adults: adults ? Number(adults) : undefined, requests })
        const r = await db.tx((t) => bookStay(ctx, t, who, input))
        booked.push({ line: i + 1, name, reservationId: r.id })
      } catch (e) { errors.push({ line: i + 1, name: name ?? '', error: (e as Error).message }) }
    }
    await appendAudit(db, { actor: who, action: 'room_block.rooming_list', entity: { type: 'room_block', id: k.id }, after: { booked: booked.length, errors: errors.length }, note: k.number }, now())
    return { booked, errors }
  })
}
