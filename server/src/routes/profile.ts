import type { FastifyInstance } from 'fastify'
import { PAN_RE, validateGstin } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { HttpError, type Ctx } from '../context'
import { PROPERTY } from '../fo-core'
import { requireCaller } from './auth'

// The resort's profile (names, tax IDs, contact details, invoice prefix, who signs TDS returns, when the day
// closes by itself), set by the MD; and the getting-started checklist shown until the basics are in place.

const COLS = `id, name, legal_name, entity_type, gstin, pan, tan, address, city, pin, phone, email, website, invoice_prefix, tds_responsible, tds_responsible_designation, auto_close, day_close_at, state_code`
const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/

export function profileRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db

  app.get('/api/property', async (req) => {
    await requireCaller(ctx, req)
    const [p] = await db.query<Record<string, unknown>>(`select ${COLS} from property where id = $1`, [PROPERTY])
    return p
  })

  app.patch('/api/property', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!who.permissions.has('*')) throw new HttpError(403, 'Only the MD changes the resort profile.')
    const b = (req.body ?? {}) as Record<string, unknown>
    const [before] = await db.query<Record<string, unknown>>(`select ${COLS} from property where id = $1`, [PROPERTY])
    const next: Record<string, unknown> = {}
    const text = (k: string, col: string, max: number, required = false) => {
      if (b[k] === undefined) return
      const v = String(b[k] ?? '').trim()
      if (required && !v) throw new HttpError(400, `${k === 'name' ? 'The resort\'s name' : 'The legal name'} cannot be empty.`)
      next[col] = v ? v.slice(0, max) : null
    }
    text('name', 'name', 120, true); text('legalName', 'legal_name', 160); text('address', 'address', 300); text('city', 'city', 80); text('website', 'website', 200)
    text('tdsResponsible', 'tds_responsible', 120); text('tdsDesignation', 'tds_responsible_designation', 80)
    if (b.gstin !== undefined) {
      const raw = String(b.gstin ?? '').trim().toUpperCase()
      if (raw) {
        const v = validateGstin(raw)
        if (!v.ok) throw new HttpError(400, `GSTIN: ${v.reason}`)
        if (v.stateCode !== '33') throw new HttpError(400, 'The resort is in Tamil Nadu, so its GSTIN must start with 33.')
        next.gstin = v.gstin
        next.pan = v.gstin.slice(2, 12)      // the PAN is inside the GSTIN
      } else next.gstin = null
    }
    if (b.pan !== undefined && next.pan === undefined) {
      const v = String(b.pan ?? '').trim().toUpperCase()
      if (v && !PAN_RE.test(v)) throw new HttpError(400, 'PAN: 5 letters, 4 digits, a letter.')
      next.pan = v || null
    }
    if (b.tan !== undefined) {
      const v = String(b.tan ?? '').trim().toUpperCase()
      if (v && !TAN_RE.test(v)) throw new HttpError(400, 'TAN: 4 letters, 5 digits, a letter (e.g. CHES12345A).')
      next.tan = v || null
    }
    if (b.pin !== undefined) {
      const v = String(b.pin ?? '').replace(/\s/g, '')
      if (v && !/^\d{6}$/.test(v)) throw new HttpError(400, 'PIN code: 6 digits.')
      next.pin = v || null
    }
    if (b.phone !== undefined) {
      const v = String(b.phone ?? '').replace(/[^\d+]/g, '')
      if (v && v.replace(/\D/g, '').length < 10) throw new HttpError(400, 'Phone: at least 10 digits.')
      next.phone = v || null
    }
    if (b.email !== undefined) {
      const v = String(b.email ?? '').trim().toLowerCase()
      if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new HttpError(400, 'Enter a valid email address.')
      next.email = v || null
    }
    if (b.invoicePrefix !== undefined) {
      const v = String(b.invoicePrefix ?? '').trim().toUpperCase()
      if (!/^[A-Z0-9]{1,5}$/.test(v)) throw new HttpError(400, 'Invoice prefix: up to 5 capital letters or digits.')
      next.invoice_prefix = v
    }
    if (b.autoClose !== undefined) next.auto_close = !!b.autoClose
    if (b.dayCloseAt !== undefined) {
      const v = String(b.dayCloseAt ?? '')
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new HttpError(400, 'Day close time as HH:MM.')
      if (v > '06:00' && v < '22:00') throw new HttpError(400, 'Close the day at night: between 22:00 and 06:00.')
      next.day_close_at = v
    }
    const keys = Object.keys(next)
    if (!keys.length) return before
    await db.query(`update property set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [PROPERTY, ...keys.map((k) => next[k])])
    await appendAudit(db, { actor: who, action: 'property.profile', entity: { type: 'property', id: PROPERTY }, before, after: next }, ctx.now())
    const [p] = await db.query<Record<string, unknown>>(`select ${COLS} from property where id = $1`, [PROPERTY])
    return p
  })

  /** What still needs setting up before the resort runs on the system. */
  app.get('/api/setup-status', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!who.permissions.has('*')) return { steps: [], done: true }
    const one = async (sql: string) => Number((await db.query<{ n: number }>(sql))[0]?.n ?? 0)
    const [p] = await db.query<{ legal_name: string | null; gstin: string | null; address: string | null; pin: string | null; tan: string | null }>('select legal_name, gstin, address, pin, tan from property where id = $1', [PROPERTY])
    const steps = [
      { key: 'profile', title: 'Resort profile: legal name, GSTIN and address', why: 'Every tax invoice (check-out, restaurant, banquet) prints them and is refused without them.', done: !!(p?.legal_name && p?.gstin && p?.address && p?.pin), open: 'settings:profile' },
      { key: 'rates', title: 'Room rates for the season ahead', why: 'Reception can book a room only on nights that have a rate. Check each room type and meal plan.',
        done: (await one(`select count(*)::int as n from room_type t where t.active and exists (select 1 from space s where s.room_type_id = t.id and s.active)
                            and not exists (select 1 from rate r join rate_plan p on p.id = r.rate_plan_id where p.code = 'EP' and r.room_type_id = t.id
                                            and r.valid_to >= (select business_date from property limit 1) + 60)`)) === 0, open: 'settings:rates' },
      { key: 'tan', title: 'TAN and who signs TDS returns', why: 'For TDS on vendor payments and salaries, the 26Q / 24Q and Form 16.', done: !!p?.tan, open: 'settings:profile' },
      { key: 'bank', title: 'The resort\'s bank account', why: 'Payments, receipts and the bank reconciliation use it.', done: (await one(`select count(*)::int as n from bank_account where active and account_no is not null`)) > 0, open: 'btn-acc' },
      { key: 'opening', title: 'Opening balances', why: 'Cash, bank, what is owed to and by the resort on the day the books start.', done: (await one(`select count(*)::int as n from voucher where source_type = 'opening' or narration ilike 'opening%'`)) > 0, open: 'btn-acc' },
      { key: 'logins', title: 'Logins for the staff', why: 'Each person signs in with their own email and password.', done: (await one(`select count(*)::int as n from app_user where id <> 'system' and active`)) > 1, open: 'btn-staff:logins' },
      { key: 'employees', title: 'Employees and their pay', why: 'For leave, payroll, PF and ESI.', done: (await one('select count(*)::int as n from employee')) > 0, open: 'btn-hr' },
    ]
    return { steps, done: steps.every((s) => s.done) }
  })
}
