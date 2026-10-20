import type { FastifyInstance, FastifyRequest } from 'fastify'
import { IFSC_RE, PAN_RE, payeeTypeFromPan, validateGstin } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { istDay, newId } from '../eng-core'
import { requireCaller } from './auth'

// Stores, the item master (units and conversions, HSN, GST and input tax credit, links to the department
// books) and the vendor master (GSTIN, PAN, TDS category, MSME status, bank) with rate contracts.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const CATEGORIES = ['food', 'beverage', 'liquor', 'housekeeping', 'amenities', 'linen', 'engineering', 'crockery', 'stationery', 'cleaning', 'other']
const UNITS = ['g', 'ml', 'pcs', 'm', 'set', 'pair']
const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40]
const UDYAM_RE = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/

/** The stores every resort has; department stores keep stock in the books those departments already use. */
export async function ensureStores(db: Db) {
  const stores: [string, string, string, string][] = [
    ['ST-MAIN', 'Main store', 'main', 'own'], ['ST-KITCHEN', 'Kitchen store', 'kitchen', 'kitchen'], ['ST-BAR', 'Bar (liquor)', 'bar', 'bar'],
    ['ST-HK', 'Housekeeping store', 'housekeeping', 'own'], ['ST-ENG', 'Engineering store', 'engineering', 'spares'], ['ST-LINEN', 'Linen room', 'linen', 'linen'],
  ]
  for (const [id, name, kind, ledger] of stores) await db.query('insert into store (id, name, kind, ledger) values ($1,$2,$3,$4) on conflict do nothing', [id, name, kind, ledger])
}

export function storesRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const VIEW = ['stores.view', 'stores.manage', 'vendors.manage', 'purchase.indent', 'purchase.order', 'purchase.approve']

  // ---------- stores ----------
  app.get('/api/stores', async (req) => {
    await requireCaller(ctx, req)
    return db.query('select s.*, p.name as space from store s left join space p on p.id = s.space_id order by s.active desc, s.kind, s.name')
  })

  app.post('/api/stores', async (req, reply) => {
    const who = await need(req, 'stores.manage')
    const b = (req.body ?? {}) as { name?: string; kind?: string; spaceId?: string }
    if (!b.name?.trim()) throw new HttpError(400, 'Name the store.')
    if (!['main', 'housekeeping', 'other'].includes(b.kind ?? '')) throw new HttpError(400, 'A new store can be a main, housekeeping or other store (the department stores already exist).')
    const id = newId('ST')
    await db.tx(async (t) => {
      await t.query('insert into store (id, name, kind, space_id) values ($1,$2,$3,$4)', [id, b.name!.trim(), b.kind, b.spaceId || null])
      await appendAudit(t, { actor: who, action: 'store.add', entity: { type: 'store', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/stores/:id', async (req) => {
    const who = await need(req, 'stores.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; spaceId?: string | null; active?: boolean }
    return db.tx(async (t) => {
      const [before] = await t.query('select * from store where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such store.')
      await t.query('update store set name = coalesce($2, name), space_id = case when $3::boolean then $4 else space_id end, active = coalesce($5, active) where id = $1',
        [id, b.name?.trim() || null, b.spaceId !== undefined, b.spaceId || null, b.active ?? null])
      const [after] = await t.query('select * from store where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'store.update', entity: { type: 'store', id }, before, after }, now())
      return after
    })
  })

  // ---------- items ----------
  app.get('/api/items', async (req) => {
    await need(req, ...VIEW)
    const q = req.query as { q?: string; category?: string; all?: string }
    const rows = await db.query<{ best_rate_paise: string | number | null }>(
      `select i.*, s.name as default_store, g.name as ingredient, sp.name as spare, l.name as linen_item, b.name as brand,
              (select min(rc.rate_paise) from rate_contract rc join vendor v on v.id = rc.vendor_id where rc.item_id = i.id and v.active and $4::date between rc.valid_from and rc.valid_to) as best_rate_paise
         from item i left join store s on s.id = i.default_store_id left join ingredient g on g.id = i.ingredient_id left join spare sp on sp.id = i.spare_id
         left join linen_item l on l.id = i.linen_item_id left join liquor_brand b on b.id = i.brand_id
        where ($1::text is null or i.name ilike '%' || $1 || '%' or i.barcode = $1 or i.hsn = $1) and ($2::text is null or i.category = $2) and ($3 or i.active)
        order by i.active desc, i.category, i.name limit 1000`, [q.q?.trim() || null, q.category || null, q.all === '1', istDay(now())])
    return rows.map((r) => ({ ...r, best_rate_paise: r.best_rate_paise == null ? null : Number(r.best_rate_paise) }))
  })

  type ItemBody = { name?: string; category?: string; unit?: string; purchaseUnit?: string; purchaseFactor?: number; hsn?: string | null; gstRate?: number | null; itc?: string; perishable?: boolean
    shelfLifeDays?: number | null; ingredientId?: string | null; spareId?: string | null; linenItemId?: string | null; brandId?: string | null; defaultStoreId?: string | null
    parLevel?: number | null; reorderQty?: number | null; barcode?: string | null; active?: boolean }

  async function checkItem(t: Db, b: ItemBody, partial: boolean, current?: { unit: string }) {
    const must = (k: keyof ItemBody) => !partial || b[k] !== undefined
    if (must('name') && (!b.name?.trim() || b.name.length > 80)) throw new HttpError(400, 'Name the item (up to 80 characters).')
    if (must('category') && !CATEGORIES.includes(b.category ?? '')) throw new HttpError(400, `Category: ${CATEGORIES.join(', ')}.`)
    if (must('unit') && !UNITS.includes(b.unit ?? '')) throw new HttpError(400, `Stock unit: ${UNITS.join(', ')}.`)
    if (must('purchaseUnit') && !b.purchaseUnit?.trim()) throw new HttpError(400, 'How vendors sell it (kg, litre, case of 24, box…).')
    if (must('purchaseFactor') && !(Number(b.purchaseFactor) > 0)) throw new HttpError(400, 'How many stock units are in one purchase unit (e.g. 1000 g in a kg).')
    if (b.hsn && !/^\d{4,8}$/.test(b.hsn)) throw new HttpError(400, 'HSN: 4, 6 or 8 digits.')
    if (b.gstRate != null && !GST_RATES.includes(Number(b.gstRate))) throw new HttpError(400, `GST rate: ${GST_RATES.join(', ')}%.`)
    if (b.itc && !['full', 'none', 'blocked'].includes(b.itc)) throw new HttpError(400, 'Input tax credit: full, none or blocked.')
    if (b.shelfLifeDays != null && !(Number.isInteger(b.shelfLifeDays) && b.shelfLifeDays > 0)) throw new HttpError(400, 'Shelf life in whole days.')
    const unit = b.unit ?? current?.unit
    // A linked department item must be counted in the same unit as that department's book.
    if (b.ingredientId) {
      const [g] = await t.query<{ unit: string }>('select unit from ingredient where id = $1', [b.ingredientId])
      if (!g) throw new HttpError(404, 'No such kitchen ingredient.')
      if (g.unit !== unit) throw new HttpError(400, `The kitchen keeps this ingredient in ${g.unit}: use ${g.unit} as the stock unit.`)
    }
    if (b.brandId) {
      const [x] = await t.query('select 1 from liquor_brand where id = $1', [b.brandId]); if (!x) throw new HttpError(404, 'No such liquor brand.')
      if (unit !== 'ml') throw new HttpError(400, 'Liquor is kept in ml (the bar register counts ml).')
    }
    if (b.spareId) { const [x] = await t.query('select 1 from spare where id = $1', [b.spareId]); if (!x) throw new HttpError(404, 'No such spare part.'); if (unit !== 'pcs') throw new HttpError(400, 'Spares are counted in pieces (pcs).') }
    if (b.linenItemId) { const [x] = await t.query('select 1 from linen_item where id = $1', [b.linenItemId]); if (!x) throw new HttpError(404, 'No such linen item.'); if (unit !== 'pcs') throw new HttpError(400, 'Linen is counted in pieces (pcs).') }
    if (b.defaultStoreId) { const [x] = await t.query('select 1 from store where id = $1', [b.defaultStoreId]); if (!x) throw new HttpError(404, 'No such store.') }
  }
  const itemCols: [keyof ItemBody, string, (v: unknown) => unknown][] = [
    ['name', 'name', (v) => String(v).trim()], ['category', 'category', String], ['unit', 'unit', String], ['purchaseUnit', 'purchase_unit', (v) => String(v).trim()],
    ['purchaseFactor', 'purchase_factor', Number], ['hsn', 'hsn', (v) => v || null], ['gstRate', 'gst_rate', (v) => (v == null || v === '' ? null : Number(v))], ['itc', 'itc', String],
    ['perishable', 'perishable', Boolean], ['shelfLifeDays', 'shelf_life_days', (v) => v ?? null], ['ingredientId', 'ingredient_id', (v) => v || null], ['spareId', 'spare_id', (v) => v || null],
    ['linenItemId', 'linen_item_id', (v) => v || null], ['brandId', 'brand_id', (v) => v || null], ['defaultStoreId', 'default_store_id', (v) => v || null],
    ['parLevel', 'par_level', (v) => (v == null || v === '' ? null : Number(v))], ['reorderQty', 'reorder_qty', (v) => (v == null || v === '' ? null : Number(v))],
    ['barcode', 'barcode', (v) => (v ? String(v).trim() : null)], ['active', 'active', Boolean],
  ]
  const dup = (e: unknown, what: string) => {
    const m = String((e as Error).message)
    if (/unique|duplicate/i.test(m)) throw new HttpError(409, /barcode/.test(m) ? 'That barcode is already on another item.' : /name/.test(m) ? 'An item with that name already exists.' : `That ${what} is already linked to another item.`)
    throw e
  }

  app.post('/api/items', async (req, reply) => {
    const who = await need(req, 'stores.manage')
    const b = (req.body ?? {}) as ItemBody
    const id = newId('IT')
    await db.tx(async (t) => {
      await checkItem(t, b, false)
      const cols = itemCols.filter(([k]) => b[k] !== undefined)
      await t.query(`insert into item (id, created_at, ${cols.map((c) => c[1]).join(', ')}) values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})`,
        [id, now(), ...cols.map(([k, , f]) => f(b[k]))]).catch((e) => dup(e, 'department item'))
      await appendAudit(t, { actor: who, action: 'item.add', entity: { type: 'item', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/items/:id', async (req) => {
    const who = await need(req, 'stores.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as ItemBody
    return db.tx(async (t) => {
      const [before] = await t.query<{ unit: string }>('select * from item where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such item.')
      await checkItem(t, b, true, before)
      const cols = itemCols.filter(([k]) => b[k] !== undefined)
      if (cols.length) await t.query(`update item set ${cols.map((c, i) => `${c[1]} = $${i + 2}`).join(', ')} where id = $1`, [id, ...cols.map(([k, , f]) => f(b[k]))]).catch((e) => dup(e, 'department item'))
      const [after] = await t.query('select * from item where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'item.update', entity: { type: 'item', id }, before, after }, now())
      return after
    })
  })

  // One step to bring the kitchen ingredients, bar brands, spares and linen already in the system into the item master.
  app.post('/api/items/from-departments', async (req) => {
    const who = await need(req, 'stores.manage')
    return db.tx(async (t) => {
      let added = 0
      const add = async (name: string, category: string, unit: string, purchaseUnit: string, factor: number, store: string, link: Record<string, string>) => {
        const [taken] = await t.query('select 1 from item where name = $1', [name])
        const id = newId('IT')
        const [col, ref] = Object.entries(link)[0]
        await t.query(`insert into item (id, name, category, unit, purchase_unit, purchase_factor, default_store_id, ${col}, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, taken ? `${name} (${category})` : name, category, unit, purchaseUnit, factor, store, ref, now()])
        added++
      }
      for (const g of await t.query<{ id: string; name: string; unit: string }>('select id, name, unit from ingredient where active and id not in (select ingredient_id from item where ingredient_id is not null)'))
        await add(g.name, 'food', g.unit, g.unit === 'g' ? 'kg' : g.unit === 'ml' ? 'litre' : 'pcs', g.unit === 'pcs' ? 1 : 1000, 'ST-KITCHEN', { ingredient_id: g.id })
      for (const x of await t.query<{ id: string; name: string; bottle_ml: number }>('select id, name, bottle_ml from liquor_brand where active and id not in (select brand_id from item where brand_id is not null)'))
        await add(x.name, 'liquor', 'ml', `bottle of ${x.bottle_ml} ml`, x.bottle_ml, 'ST-BAR', { brand_id: x.id })
      for (const x of await t.query<{ id: string; name: string }>('select id, name from spare where active and id not in (select spare_id from item where spare_id is not null)'))
        await add(x.name, 'engineering', 'pcs', 'pcs', 1, 'ST-ENG', { spare_id: x.id })
      for (const x of await t.query<{ id: string; name: string }>('select id, name from linen_item where active and id not in (select linen_item_id from item where linen_item_id is not null)'))
        await add(x.name, 'linen', 'pcs', 'pcs', 1, 'ST-LINEN', { linen_item_id: x.id })
      await appendAudit(t, { actor: who, action: 'item.import_departments', entity: { type: 'item', id: 'all' }, after: { added } }, now())
      return { added }
    })
  })

  // ---------- vendors ----------
  app.get('/api/vendors/meta', async (req) => {
    await need(req, ...VIEW)
    return {
      tds: ctx.tax.income_tax.tds.filter((r) => r.rate !== 'slab' && r.applies_to_resort !== false).map((r) => ({ code: r.code, section: r.old_section, rate: r.rate, threshold: r.threshold ?? null })),
      msmeDays: ctx.tax.income_tax.controls.msme_payment_days,
    }
  })

  app.get('/api/vendors', async (req) => {
    const who = await need(req, ...VIEW)
    const q = req.query as { q?: string; all?: string }
    const bank = can(who, 'vendors.bank')
    const rows = await db.query<{ bank_account: string | null; upi: string | null }>(
      `select v.*, (select count(*)::int from rate_contract rc where rc.vendor_id = v.id and $3::date between rc.valid_from and rc.valid_to) as rates
         from vendor v where ($1::text is null or v.name ilike '%' || $1 || '%' or v.gstin = upper($1)) and ($2 or v.active) order by v.active desc, v.name`,
      [q.q?.trim() || null, q.all === '1', istDay(now())])
    // Bank details are for accounts: others see only the last digits.
    return rows.map((v) => bank ? v : { ...v, bank_account: v.bank_account ? `••••${v.bank_account.slice(-4)}` : null, upi: v.upi ? '••••' : null })
  })

  type VendorBody = { name?: string; legalName?: string; gstin?: string | null; pan?: string | null; payeeType?: string; tdsCode?: string | null; msme?: string; udyamNo?: string | null
    writtenAgreement?: boolean; paymentTermsDays?: number; categories?: string[]; phone?: string; email?: string; address?: string; bankName?: string; bankAccount?: string; ifsc?: string; upi?: string; notes?: string; active?: boolean }

  /** Normalises and checks a vendor; returns the columns to write. */
  function vendorFields(b: VendorBody, current: Record<string, unknown> | null) {
    const out: Record<string, unknown> = {}
    if (!current || b.name !== undefined) { if (!b.name?.trim()) throw new HttpError(400, 'Name the vendor.'); out.name = b.name.trim() }
    if (b.legalName !== undefined) out.legal_name = b.legalName?.trim() || null
    let gstinPan: string | null = (current?.gstin as string | null)?.slice(2, 12) ?? null
    if (b.gstin !== undefined) {
      if (b.gstin) {
        const g = validateGstin(b.gstin)
        if (!g.ok) throw new HttpError(400, g.reason)
        out.gstin = g.gstin; out.state_code = g.stateCode; gstinPan = g.gstin.slice(2, 12)
      } else { out.gstin = null; gstinPan = null }
    }
    if (b.pan !== undefined || (gstinPan && !current?.pan)) {
      const pan = (b.pan ?? gstinPan ?? '').trim().toUpperCase()
      if (pan && !PAN_RE.test(pan)) throw new HttpError(400, 'PAN: five letters, four digits, a letter (e.g. ABCDE1234F).')
      if (pan && gstinPan && pan !== gstinPan) throw new HttpError(400, `The PAN does not match the GSTIN (which has ${gstinPan}).`)
      out.pan = pan || null
    }
    const pan = (out.pan ?? current?.pan ?? null) as string | null
    if (b.payeeType !== undefined) {
      if (!['individual', 'huf', 'company', 'firm', 'other'].includes(b.payeeType)) throw new HttpError(400, 'Payee type: individual, huf, company, firm or other.')
      out.payee_type = b.payeeType
    } else if (!current || out.pan !== undefined) out.payee_type = pan ? payeeTypeFromPan(pan) : (current?.payee_type ?? 'other')
    if (b.tdsCode !== undefined) {
      if (b.tdsCode && !ctx.tax.income_tax.tds.some((r) => r.code === b.tdsCode && r.rate !== 'slab' && r.applies_to_resort !== false)) throw new HttpError(400, 'Unknown TDS category.')
      out.tds_code = b.tdsCode || null
    }
    if (b.msme !== undefined) {
      if (!['micro', 'small', 'medium', 'none'].includes(b.msme)) throw new HttpError(400, 'MSME: micro, small, medium or none.')
      out.msme = b.msme
    }
    if (b.udyamNo !== undefined) {
      const u = b.udyamNo?.trim().toUpperCase() || null
      if (u && !UDYAM_RE.test(u)) throw new HttpError(400, 'Udyam number like UDYAM-TN-02-0012345.')
      out.udyam_no = u
    }
    const msme = (out.msme ?? current?.msme ?? 'none') as string
    if (msme !== 'none' && !(out.udyam_no ?? current?.udyam_no)) throw new HttpError(400, 'An MSME vendor needs the Udyam registration number (it decides the 15/45-day payment rule).')
    if (b.writtenAgreement !== undefined) out.written_agreement = !!b.writtenAgreement
    if (b.paymentTermsDays !== undefined) {
      if (!(Number.isInteger(b.paymentTermsDays) && b.paymentTermsDays >= 0 && b.paymentTermsDays <= 180)) throw new HttpError(400, 'Payment terms: 0–180 days.')
      out.payment_terms_days = b.paymentTermsDays
    }
    if (b.categories !== undefined) out.categories = (b.categories ?? []).filter((c) => CATEGORIES.includes(c))
    if (b.email !== undefined) { if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) throw new HttpError(400, 'Email address is not valid.'); out.email = b.email?.trim() || null }
    if (b.phone !== undefined) out.phone = b.phone?.replace(/[^\d+]/g, '') || null
    for (const [k, c] of [['address', 'address'], ['bankName', 'bank_name'], ['notes', 'notes'], ['upi', 'upi']] as const) if (b[k] !== undefined) out[c] = (b[k] as string)?.trim() || null
    if (b.bankAccount !== undefined) { const a = b.bankAccount?.replace(/\s/g, '') || null; if (a && !/^\d{9,18}$/.test(a)) throw new HttpError(400, 'Bank account: 9–18 digits.'); out.bank_account = a }
    if (b.ifsc !== undefined) { const f = b.ifsc?.trim().toUpperCase() || null; if (f && !IFSC_RE.test(f)) throw new HttpError(400, 'IFSC like SBIN0001234.'); out.ifsc = f }
    if (b.active !== undefined) out.active = !!b.active
    return out
  }
  const BANK = ['bank_name', 'bank_account', 'ifsc', 'upi']

  app.post('/api/vendors', async (req, reply) => {
    const who = await need(req, 'vendors.manage')
    const b = (req.body ?? {}) as VendorBody
    const f = vendorFields(b, null)
    if (BANK.some((k) => f[k]) && !can(who, 'vendors.bank')) throw new HttpError(403, 'Bank details are entered by accounts.')
    const id = newId('VN')
    await db.tx(async (t) => {
      const cols = Object.keys(f)
      await t.query(`insert into vendor (id, created_at, updated_at, ${cols.join(', ')}) values ($1, $2, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})`, [id, now(), ...cols.map((c) => f[c])])
        .catch((e) => { if (/unique|duplicate/i.test(String((e as Error).message))) throw new HttpError(409, 'A vendor with that GSTIN already exists.'); throw e })
      await appendAudit(t, { actor: who, action: 'vendor.add', entity: { type: 'vendor', id }, after: { ...f, bank_account: f.bank_account ? 'set' : null } }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/vendors/:id', async (req) => {
    const who = await need(req, 'vendors.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as VendorBody
    return db.tx(async (t) => {
      const [before] = await t.query<Record<string, unknown>>('select * from vendor where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such vendor.')
      const f = vendorFields(b, before)
      const bankChange = BANK.filter((k) => f[k] !== undefined && f[k] !== before[k])
      if (bankChange.length && !can(who, 'vendors.bank')) throw new HttpError(403, 'Bank details are changed by accounts.')
      const cols = Object.keys(f)
      if (cols.length) await t.query(`update vendor set updated_at = $2, ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} where id = $1`, [id, now(), ...cols.map((c) => f[c])])
        .catch((e) => { if (/unique|duplicate/i.test(String((e as Error).message))) throw new HttpError(409, 'A vendor with that GSTIN already exists.'); throw e })
      const mask = (r: Record<string, unknown>) => ({ ...r, bank_account: r.bank_account ? `••••${String(r.bank_account).slice(-4)}` : null })
      const [after] = await t.query<Record<string, unknown>>('select * from vendor where id = $1', [id])
      // A changed bank account is the classic payment fraud: it gets its own line in the log for God Mode.
      if (bankChange.length) await appendAudit(t, { actor: who, action: 'vendor.bank_change', entity: { type: 'vendor', id }, before: mask(before), after: mask(after), note: `${String(before.name)}: ${bankChange.join(', ')} changed` }, now())
      else await appendAudit(t, { actor: who, action: 'vendor.update', entity: { type: 'vendor', id }, before: mask(before), after: mask(after) }, now())
      return mask(after)
    })
  })

  // ---------- rate contracts ----------
  app.get('/api/rate-contracts', async (req) => {
    await need(req, ...VIEW)
    const q = req.query as { itemId?: string; vendorId?: string; current?: string }
    return db.query(
      `select rc.id, rc.vendor_id, v.name as vendor, rc.item_id, i.name as item, i.purchase_unit, rc.rate_paise, rc.valid_from::text, rc.valid_to::text,
              ($4::date between rc.valid_from and rc.valid_to) as current
         from rate_contract rc join vendor v on v.id = rc.vendor_id join item i on i.id = rc.item_id
        where ($1::text is null or rc.item_id = $1) and ($2::text is null or rc.vendor_id = $2) and (not $3 or $4::date <= rc.valid_to)
        order by i.name, rc.rate_paise`, [q.itemId ?? null, q.vendorId ?? null, q.current === '1', istDay(now())])
  })

  app.post('/api/rate-contracts', async (req, reply) => {
    const who = await need(req, 'vendors.manage', 'stores.manage')
    const b = (req.body ?? {}) as { vendorId?: string; itemId?: string; rate?: number; validFrom?: string; validTo?: string }
    if (!(Number(b.rate) > 0)) throw new HttpError(400, 'Rate per purchase unit in rupees.')
    if (!DATE.test(b.validFrom ?? '') || !DATE.test(b.validTo ?? '') || b.validTo! < b.validFrom!) throw new HttpError(400, 'Valid from and to (YYYY-MM-DD), to after from.')
    const id = newId('RC')
    await db.tx(async (t) => {
      const [v] = await t.query<{ active: boolean }>('select active from vendor where id = $1', [b.vendorId])
      if (!v?.active) throw new HttpError(404, 'No such active vendor.')
      const [i] = await t.query('select 1 from item where id = $1', [b.itemId])
      if (!i) throw new HttpError(404, 'No such item.')
      const [clash] = await t.query('select 1 from rate_contract where vendor_id = $1 and item_id = $2 and valid_from <= $4 and valid_to >= $3', [b.vendorId, b.itemId, b.validFrom, b.validTo])
      if (clash) throw new HttpError(409, 'This vendor already has a rate for this item in those dates: end that one first.')
      await t.query('insert into rate_contract (id, vendor_id, item_id, rate_paise, valid_from, valid_to) values ($1,$2,$3,$4,$5,$6)', [id, b.vendorId, b.itemId, Math.round(Number(b.rate) * 100), b.validFrom, b.validTo])
      await appendAudit(t, { actor: who, action: 'rate_contract.add', entity: { type: 'rate_contract', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  // Ending a rate early (a new price was agreed); past rates stay for the record.
  app.post('/api/rate-contracts/:id/end', async (req) => {
    const who = await need(req, 'vendors.manage', 'stores.manage')
    const { id } = req.params as { id: string }
    const day = (req.body as { on?: string })?.on ?? istDay(now())
    if (!DATE.test(day)) throw new HttpError(400, 'End date as YYYY-MM-DD.')
    return db.tx(async (t) => {
      const [rc] = await t.query<{ valid_from: string }>('select valid_from::text from rate_contract where id = $1 for update', [id])
      if (!rc) throw new HttpError(404, 'No such rate.')
      if (day < rc.valid_from) throw new HttpError(400, 'It cannot end before it started.')
      await t.query('update rate_contract set valid_to = $2 where id = $1', [id, day])
      await appendAudit(t, { actor: who, action: 'rate_contract.end', entity: { type: 'rate_contract', id }, after: { validTo: day } }, now())
      return { ok: true }
    })
  })
}
