import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { addDays } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { businessDate } from '../fo-core'
import { requireCaller } from './auth'

// Licences and permits (with the numbers printed on bills and their renewal dates), and the TN VAT
// rates for liquor. Both are edited in the app; old VAT rates are kept so earlier bills stay explainable.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const PRINT_ON = ['fnb_bill', 'vat_bill', 'room_invoice']

/** Number formats the law fixes; other licences accept any reference up to 40 characters. */
const FORMATS: Record<string, { re: RegExp; hint: string; printOn: string[] }> = {
  fssai: { re: /^\d{14}$/, hint: 'FSSAI licence number has 14 digits.', printOn: ['fnb_bill', 'vat_bill'] },
  tn_vat: { re: /^33\d{9}$/, hint: 'TN VAT registration (TIN) has 11 digits starting with 33.', printOn: ['vat_bill'] },
  fl3: { re: /^[A-Za-z0-9/ .-]{1,40}$/, hint: 'Bar licence number: up to 40 letters, digits, / . or -.', printOn: ['vat_bill'] },
}

const LABELS: Record<string, string> = { imfl_spirits: 'Spirits (IMFL)', beer: 'Beer', wine: 'Wine' }

/** Liquor classes from tax-config.yaml, so a fresh database starts with them (rates are set in the app). */
export async function ensureLiquorClasses(db: Db, ctx: Pick<Ctx, 'tax'>) {
  for (const r of ctx.tax.tn_vat.rate_table) {
    await db.query('insert into liquor_class (id, label) values ($1, $2) on conflict (id) do nothing', [r.class, LABELS[r.class] ?? r.class])
  }
}

/** VAT rate per liquor class on a date; classes without a rate yet are missing from the map. */
export async function vatRatesOn(db: Db, date: string): Promise<Record<string, number>> {
  const rows = await db.query<{ liquor_class: string; rate: string }>(
    `select distinct on (liquor_class) liquor_class, rate from vat_rate where effective_from <= $1 order by liquor_class, effective_from desc`, [date])
  return Object.fromEntries(rows.map((r) => [r.liquor_class, Number(r.rate)]))
}

/** Licence numbers to print on a given document. */
export async function licencesFor(db: Db, doc: string) {
  return db.query<{ kind: string; name: string; number: string }>(
    'select kind, name, number from licence where active and $1 = any(print_on) order by kind', [doc])
}

interface LicenceInput { kind?: string; name?: string; number?: string; authority?: string | null; validFrom?: string | null; validUntil?: string | null; printOn?: string[]; notes?: string | null; active?: boolean }

function checkLicence(b: LicenceInput, partial: boolean, kind: string) {
  if (!partial || b.kind !== undefined) if (!/^[a-z0-9_]{2,30}$/.test(b.kind ?? '')) throw new HttpError(400, 'Kind: 2–30 lower-case letters, digits or _ (e.g. fssai, fl3, fire_noc).')
  if (!partial || b.name !== undefined) if (!b.name?.trim() || b.name.length > 80) throw new HttpError(400, 'Give the licence a name (up to 80 characters).')
  if (!partial || b.number !== undefined) {
    const n = (b.number ?? '').trim()
    const f = FORMATS[kind]
    if (f ? !f.re.test(n) : !n || n.length > 40) throw new HttpError(400, f?.hint ?? 'Licence number: up to 40 characters.')
  }
  for (const d of [b.validFrom, b.validUntil]) if (d && !DATE.test(d)) throw new HttpError(400, 'Dates as YYYY-MM-DD.')
  if (b.validFrom && b.validUntil && b.validUntil < b.validFrom) throw new HttpError(400, 'Valid until must be after valid from.')
  if (b.printOn && !b.printOn.every((p) => PRINT_ON.includes(p))) throw new HttpError(400, `Print on: ${PRINT_ON.join(', ')}.`)
}

export function settingsRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  // ---------- licences ----------
  app.get('/api/licences', async (req) => {
    await requireCaller(ctx, req)
    const today = await businessDate(db)
    const rows = await db.query<{ valid_until: string | null; active: boolean }>(
      `select l.id, l.kind, l.name, l.number, l.authority, l.valid_from::text, l.valid_until::text, l.print_on, l.notes, l.active, u.name as updated_by, l.updated_at
         from licence l join app_user u on u.id = l.updated_by order by l.active desc, l.valid_until nulls last, l.name`)
    return rows.map((l) => ({
      ...l,
      state: !l.active ? 'archived' : !l.valid_until ? 'no_expiry' : l.valid_until < today ? 'expired' : l.valid_until <= addDays(today, 30) ? 'renew_soon' : 'valid',
    }))
  })

  app.post('/api/licences', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'licences.edit')) throw new HttpError(403, 'Only the MD, GM or accounts can change licences.')
    const b = req.body as LicenceInput
    checkLicence(b ?? {}, false, b?.kind ?? '')
    const id = `LIC-${randomUUID().slice(0, 8).toUpperCase()}`
    const printOn = b.printOn ?? FORMATS[b.kind!]?.printOn ?? []
    await db.tx(async (t) => {
      await t.query(
        `insert into licence (id, kind, name, number, authority, valid_from, valid_until, print_on, notes, updated_by, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, b.kind, b.name!.trim(), b.number!.trim(), b.authority ?? null, b.validFrom || null, b.validUntil || null, printOn, b.notes ?? null, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'licence.add', entity: { type: 'licence', id }, after: { ...b, printOn } }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/licences/:id', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'licences.edit')) throw new HttpError(403, 'Only the MD, GM or accounts can change licences.')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as LicenceInput
    return db.tx(async (t) => {
      const [before] = await t.query<{ kind: string; vf: string | null; vu: string | null }>('select *, valid_from::text as vf, valid_until::text as vu from licence where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such licence.')
      checkLicence(b, true, b.kind ?? before.kind)
      const vf = b.validFrom !== undefined ? b.validFrom : before.vf, vu = b.validUntil !== undefined ? b.validUntil : before.vu
      if (vf && vu && vu < vf) throw new HttpError(400, 'Valid until must be after valid from.')
      await t.query(
        `update licence set kind = coalesce($2, kind), name = coalesce($3, name), number = coalesce($4, number),
                authority = case when $5::boolean then $6 else authority end,
                valid_from = case when $7::boolean then $8::date else valid_from end,
                valid_until = case when $9::boolean then $10::date else valid_until end,
                reminded = case when $9::boolean then 0 else reminded end,    -- a renewed licence starts its reminders again
                print_on = coalesce($11, print_on), notes = case when $12::boolean then $13 else notes end,
                active = coalesce($14, active), updated_by = $15, updated_at = $16 where id = $1`,
        [id, b.kind ?? null, b.name?.trim() ?? null, b.number?.trim() ?? null, b.authority !== undefined, b.authority ?? null,
          b.validFrom !== undefined, b.validFrom || null, b.validUntil !== undefined, b.validUntil || null, b.printOn ?? null,
          b.notes !== undefined, b.notes ?? null, b.active ?? null, who.userId, now()])
      const [after] = await t.query('select * from licence where id = $1', [id])
      await appendAudit(t, { actor: who, action: b.active === false ? 'licence.archive' : 'licence.update', entity: { type: 'licence', id }, before, after }, now())
      return after
    })
  })

  // ---------- TN VAT on liquor ----------
  app.get('/api/vat-rates', async (req) => {
    await requireCaller(ctx, req)
    const today = await businessDate(db)
    const classes = await db.query<{ id: string; label: string; active: boolean }>('select id, label, active from liquor_class order by label')
    const history = await db.query<{ liquor_class: string; effective_from: string; rate: string; note: string | null; set_by: string; set_at: string }>(
      `select v.liquor_class, v.effective_from::text, v.rate, v.note, u.name as set_by, v.set_at
         from vat_rate v join app_user u on u.id = v.set_by order by v.effective_from desc`)
    const current = await vatRatesOn(db, today)
    return classes.map((c) => {
      const h = history.filter((v) => v.liquor_class === c.id).map((v) => ({ ...v, rate: Number(v.rate) }))
      return { ...c, rate: current[c.id] ?? null, upcoming: h.filter((v) => v.effective_from > today), history: h }
    })
  })

  app.post('/api/vat-classes', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'tax.vat')) throw new HttpError(403, 'Only the MD or accounts can change VAT settings.')
    const b = req.body as { id?: string; label?: string }
    if (!/^[a-z][a-z0-9_]{1,29}$/.test(b?.id ?? '')) throw new HttpError(400, 'Class code: 2–30 lower-case letters, digits or _ (e.g. brandy, ready_to_drink).')
    if (!b.label?.trim() || b.label.length > 40) throw new HttpError(400, 'Give the class a name (up to 40 characters).')
    await db.tx(async (t) => {
      const [dup] = await t.query('select 1 from liquor_class where id = $1', [b.id])
      if (dup) throw new HttpError(409, `${b.id} already exists.`)
      await t.query('insert into liquor_class (id, label) values ($1, $2)', [b.id, b.label!.trim()])
      await appendAudit(t, { actor: who, action: 'vat_class.add', entity: { type: 'liquor_class', id: b.id! }, after: b }, now())
    })
    return reply.status(201).send({ id: b.id })
  })

  app.patch('/api/vat-classes/:id', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'tax.vat')) throw new HttpError(403, 'Only the MD or accounts can change VAT settings.')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { label?: string; active?: boolean }
    if (b.label !== undefined && (!b.label.trim() || b.label.length > 40)) throw new HttpError(400, 'Give the class a name (up to 40 characters).')
    return db.tx(async (t) => {
      if (b.active === false) {
        const [used] = await t.query<{ name: string }>('select name from menu_item where liquor_class = $1 and active limit 1', [id])
        if (used) throw new HttpError(409, `${used.name} is still sold in this class. Move or retire those menu items first.`)
      }
      const [before] = await t.query('select * from liquor_class where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such class.')
      await t.query('update liquor_class set label = coalesce($2, label), active = coalesce($3, active) where id = $1', [id, b.label?.trim() ?? null, b.active ?? null])
      const [after] = await t.query('select * from liquor_class where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'vat_class.update', entity: { type: 'liquor_class', id }, before, after }, now())
      return after
    })
  })

  // Sets the rate for a class from a date (today by default). Only the MD may backdate a rate.
  app.put('/api/vat-rates/:class', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'tax.vat')) throw new HttpError(403, 'Only the MD or accounts can change VAT rates.')
    const { class: cls } = req.params as { class: string }
    const b = req.body as { rate?: number; effectiveFrom?: string; note?: string }
    if (!(typeof b?.rate === 'number' && b.rate >= 0 && b.rate <= 100)) throw new HttpError(400, 'Rate must be 0–100 (%).')
    if (Math.round(b.rate * 100) !== b.rate * 100) throw new HttpError(400, 'Rate can have at most 2 decimals.')
    const today = await businessDate(db)
    const from = b.effectiveFrom ?? today
    if (!DATE.test(from)) throw new HttpError(400, 'effectiveFrom as YYYY-MM-DD.')
    if (from < today && !who.permissions.has('*')) throw new HttpError(403, 'Only the MD can set a rate for a past date.')
    return db.tx(async (t) => {
      const [c] = await t.query<{ active: boolean }>('select active from liquor_class where id = $1', [cls])
      if (!c) throw new HttpError(404, `No liquor class ${cls}.`)
      const [before] = await t.query('select rate, note from vat_rate where liquor_class = $1 and effective_from = $2', [cls, from])
      await t.query(
        `insert into vat_rate (liquor_class, effective_from, rate, note, set_by, set_at) values ($1,$2,$3,$4,$5,$6)
         on conflict (liquor_class, effective_from) do update set rate = excluded.rate, note = excluded.note, set_by = excluded.set_by, set_at = excluded.set_at`,
        [cls, from, b.rate, b.note?.trim() || null, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'vat_rate.set', entity: { type: 'liquor_class', id: cls }, before: before ?? null,
        after: { rate: b.rate, effectiveFrom: from }, note: b.note }, now())
      return { liquorClass: cls, rate: b.rate, effectiveFrom: from }
    })
  })
}
