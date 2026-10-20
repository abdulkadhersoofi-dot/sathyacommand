import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { businessDate } from '../fo-core'
import { createApproval, registerApprovalKind, roleLimit } from './approvals'
import { requireCaller } from './auth'

// Bar stock in millilitres per brand. Pegs and bottles poured on a BOT come off the book stock at once;
// TASMAC purchases add to it; breakage needs a reason (and the GM above the role's limit); a physical
// count waits for the GM before the book is corrected, and a variance above the alert level is flagged.

const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Takes the liquor on these order items off the bar stock (called when their BOT is sent). */
export async function pourStock(t: Db, who: Caller, orderItemIds: string[], day: string, now: Date) {
  const rows = await t.query<{ id: string; qty: number; brand_id: string | null; pour_ml: number | null; name: string }>(
    `select i.id, i.qty, m.brand_id, m.pour_ml, i.name from order_item i join menu_item m on m.id = i.item_id
      where i.id = any($1) and m.brand_id is not null and m.pour_ml is not null`, [orderItemIds])
  for (const r of rows) {
    await t.query('insert into bar_stock_move (id, brand_id, business_date, kind, ml, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [newId('BM'), r.brand_id, day, 'sale', -r.pour_ml! * r.qty, r.id, `${r.qty} × ${r.name}`, who.userId, now])
  }
}

/** Puts back the liquor of a cancelled item (the count catches anything actually poured). */
export async function unpourStock(t: Db, who: Caller, orderItemId: string, day: string, now: Date) {
  const sales = await t.query<{ brand_id: string; ml: number; note: string }>(`select brand_id, ml, note from bar_stock_move where kind = 'sale' and ref = $1`, [orderItemId])
  for (const s of sales) {
    await t.query('insert into bar_stock_move (id, brand_id, business_date, kind, ml, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [newId('BM'), s.brand_id, day, 'sale_reversal', -s.ml, orderItemId, `Cancelled: ${s.note}`, who.userId, now])
  }
}

async function bookMl(t: Db, brandId: string) {
  const [{ ml }] = await t.query<{ ml: number }>('select coalesce(sum(ml), 0)::int as ml from bar_stock_move where brand_id = $1', [brandId])
  return Number(ml)
}

/** Cost of a millilitre from the latest TASMAC purchase of the brand (0 when never bought). */
async function costPerMl(t: Db, brandId: string, bottleMl: number) {
  const [p] = await t.query<{ cost: string }>(
    `select (l->>'costPaise') as cost from tasmac_purchase p, jsonb_array_elements(p.lines) l where l->>'brandId' = $1 order by p.received_at desc limit 1`, [brandId])
  return p ? Number(p.cost) / bottleMl : 0
}

async function applyCount(t: Db, countId: string, decider: Caller, now: Date) {
  const [c] = await t.query<{ status: string; business_date: string; lines: { brandId: string; countedMl: number }[] }>('select status, business_date::text, lines from bar_count where id = $1 for update', [countId])
  if (!c || c.status !== 'pending') throw new HttpError(409, 'This count was already decided.')
  for (const l of c.lines) {
    const diff = l.countedMl - await bookMl(t, l.brandId)
    if (diff) {
      await t.query('insert into bar_stock_move (id, brand_id, business_date, kind, ml, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [newId('BM'), l.brandId, c.business_date, 'count_adjust', diff, countId, 'Physical count', decider.userId, now])
    }
  }
  await t.query(`update bar_count set status = 'approved' where id = $1`, [countId])
}

registerApprovalKind('bar.count', {
  permission: 'bar.approve',
  apply: (t, p, decider, ctx) => applyCount(t, String(p.countId), decider, ctx.now()),
  async reject(t, p) { await t.query(`update bar_count set status = 'rejected' where id = $1 and status = 'pending'`, [p.countId]) },
})
registerApprovalKind('bar.breakage', {
  permission: 'bar.approve',
  async apply(t, p, decider, ctx) {
    await t.query('insert into bar_stock_move (id, brand_id, business_date, kind, ml, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [newId('BM'), p.brandId, p.day, 'breakage', -Number(p.ml), null, String(p.reason), String(p.requestedBy ?? decider.userId), ctx.now()])
  },
})

export function barRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }

  // ---------- brands ----------
  app.get('/api/bar/brands', async (req) => {
    await need(req, 'bar.stock', 'menu.edit', 'fnb.order')
    return db.query('select b.id, b.name, b.liquor_class, c.label as class_label, b.bottle_ml, b.placeholder, b.active from liquor_brand b join liquor_class c on c.id = b.liquor_class order by b.active desc, b.name')
  })

  app.post('/api/bar/brands', async (req, reply) => {
    const who = await need(req, 'bar.stock')
    const b = req.body as { name?: string; liquorClass?: string; bottleMl?: number }
    if (!b?.name?.trim() || b.name.length > 80) throw new HttpError(400, 'Brand name is required (up to 80 characters).')
    if (!(Number.isInteger(b.bottleMl) && b.bottleMl! >= 50 && b.bottleMl! <= 5000)) throw new HttpError(400, 'Bottle size in ml (50–5000), e.g. 180, 375, 650, 750, 1000.')
    return db.tx(async (t) => {
      const [c] = await t.query('select 1 from liquor_class where id = $1 and active', [b.liquorClass])
      if (!c) throw new HttpError(400, `No liquor class ${b.liquorClass}.`)
      const id = newId('BR')
      await t.query('insert into liquor_brand (id, name, liquor_class, bottle_ml, created_at) values ($1,$2,$3,$4,$5)', [id, b.name!.trim(), b.liquorClass, b.bottleMl, now()])
      await appendAudit(t, { actor: who, action: 'bar_brand.create', entity: { type: 'liquor_brand', id }, after: b }, now())
      return reply.status(201).send({ id })
    })
  })

  app.patch('/api/bar/brands/:id', async (req) => {
    const who = await need(req, 'bar.stock')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; active?: boolean }
    if (b.name !== undefined && (!b.name.trim() || b.name.length > 80)) throw new HttpError(400, 'Brand name is required (up to 80 characters).')
    return db.tx(async (t) => {
      const [before] = await t.query('select * from liquor_brand where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such brand.')
      await t.query('update liquor_brand set name = coalesce($2, name), active = coalesce($3, active), placeholder = false where id = $1', [id, b.name?.trim() ?? null, b.active ?? null])
      const [after] = await t.query('select * from liquor_brand where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'bar_brand.update', entity: { type: 'liquor_brand', id }, before, after }, now())
      return after
    })
  })

  // Which brand a liquor item pours, and how much (a 30 ml peg, a 650 ml bottle).
  app.post('/api/fnb/items/:id/pour', async (req) => {
    const who = await need(req, 'bar.stock', 'menu.edit')
    const { id } = req.params as { id: string }
    const b = req.body as { brandId?: string | null; pourMl?: number }
    return db.tx(async (t) => {
      const [item] = await t.query<{ liquor_class: string | null; name: string }>('select liquor_class, name from menu_item where id = $1', [id])
      if (!item) throw new HttpError(404, 'No such item.')
      if (b?.brandId) {
        const [br] = await t.query<{ liquor_class: string; bottle_ml: number }>('select liquor_class, bottle_ml from liquor_brand where id = $1 and active', [b.brandId])
        if (!br) throw new HttpError(400, 'No such brand.')
        if (br.liquor_class !== item.liquor_class) throw new HttpError(400, `${item.name} is not in the same liquor class as that brand.`)
        if (!(Number.isInteger(b.pourMl) && b.pourMl! >= 5 && b.pourMl! <= br.bottle_ml)) throw new HttpError(400, `Pour size in ml (5–${br.bottle_ml}), e.g. 30 or 60 for a peg.`)
      }
      await t.query('update menu_item set brand_id = $2, pour_ml = $3 where id = $1', [id, b?.brandId ?? null, b?.brandId ? b.pourMl : null])
      await appendAudit(t, { actor: who, action: 'menu_item.pour', entity: { type: 'menu_item', id }, after: { brandId: b?.brandId ?? null, pourMl: b?.pourMl ?? null } }, now())
      return { ok: true }
    })
  })

  // ---------- stock ----------
  app.get('/api/bar/stock', async (req) => {
    await need(req, 'bar.stock', 'fnb.order')
    const rows = await db.query<{ id: string; name: string; bottle_ml: number; ml: number }>(
      `select b.id, b.name, b.liquor_class, b.bottle_ml, coalesce(sum(m.ml), 0)::int as ml
         from liquor_brand b left join bar_stock_move m on m.brand_id = b.id where b.active group by b.id order by b.name`)
    return Promise.all(rows.map(async (r) => {
      const ml = Number(r.ml), cpm = await costPerMl(db, r.id, r.bottle_ml)
      return { ...r, ml, fullBottles: Math.floor(Math.max(0, ml) / r.bottle_ml), openMl: Math.max(0, ml) % r.bottle_ml, negative: ml < 0, valuePaise: Math.round(Math.max(0, ml) * cpm) }
    }))
  })

  // Daily stock register by brand: opening, received, sold, breakage, adjustments, closing (ml).
  app.get('/api/bar/register', async (req) => {
    await need(req, 'bar.stock', 'fnb.order')
    const q = req.query as { date?: string }
    const day = q.date ?? await businessDate(db)
    if (!DATE.test(day)) throw new HttpError(400, 'date as YYYY-MM-DD.')
    const rows = await db.query<{ id: string; name: string; bottle_ml: number; opening: number; received: number; sold: number; breakage: number; adjusted: number }>(
      `select b.id, b.name, b.bottle_ml,
              coalesce(sum(m.ml) filter (where m.business_date < $1), 0)::int as opening,
              coalesce(sum(m.ml) filter (where m.business_date = $1 and m.kind = 'purchase'), 0)::int as received,
              coalesce(-sum(m.ml) filter (where m.business_date = $1 and m.kind in ('sale', 'sale_reversal')), 0)::int as sold,
              coalesce(-sum(m.ml) filter (where m.business_date = $1 and m.kind = 'breakage'), 0)::int as breakage,
              coalesce(sum(m.ml) filter (where m.business_date = $1 and m.kind = 'count_adjust'), 0)::int as adjusted
         from liquor_brand b left join bar_stock_move m on m.brand_id = b.id
        group by b.id having b.active or coalesce(sum(m.ml), 0) <> 0 order by b.name`, [day])
    return { date: day, brands: rows.map((r) => ({ ...r, closing: r.opening + r.received - r.sold - r.breakage + r.adjusted })) }
  })

  // ---------- purchases (only from the licensed source) ----------
  app.post('/api/bar/purchases', async (req, reply) => {
    const who = await need(req, 'bar.stock')
    const b = req.body as { supplier?: string; invoiceNo?: string; invoiceDate?: string; vat?: number; lines?: { brandId: string; bottles: number; cost: number }[] }
    const allowed = ctx.tax.liquor_controls.purchase_only_from ?? ['TASMAC']
    if (!allowed.includes((b?.supplier ?? '').toUpperCase())) throw new HttpError(400, `Liquor can only be bought from ${allowed.join(' or ')}.`)
    if (!b.invoiceNo?.trim() || !DATE.test(b.invoiceDate ?? '')) throw new HttpError(400, 'Send the TASMAC invoice number and date.')
    if (!Array.isArray(b.lines) || !b.lines.length) throw new HttpError(400, 'Add at least one brand.')
    return db.tx(async (t) => {
      const lines = []
      for (const l of b.lines!) {
        const [br] = await t.query<{ name: string; bottle_ml: number }>('select name, bottle_ml from liquor_brand where id = $1 and active', [l.brandId])
        if (!br) throw new HttpError(400, `No brand ${l.brandId}.`)
        if (!(Number.isInteger(l.bottles) && l.bottles > 0 && l.bottles <= 10000)) throw new HttpError(400, `${br.name}: bottles must be a whole number.`)
        if (!(l.cost >= 0)) throw new HttpError(400, `${br.name}: cost per bottle (₹).`)
        lines.push({ brandId: l.brandId, name: br.name, bottleMl: br.bottle_ml, bottles: l.bottles, costPaise: rupees(l.cost) })
      }
      const value = lines.reduce((a, l) => a + l.bottles * l.costPaise, 0)
      const vat = rupees(b.vat ?? 0)
      const id = newId('TP'), day = await businessDate(t)
      try {
        await t.query(
          `insert into tasmac_purchase (id, supplier, invoice_no, invoice_date, lines, value_paise, vat_paise, total_paise, business_date, received_by, received_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, b.supplier!.toUpperCase(), b.invoiceNo!.trim(), b.invoiceDate, JSON.stringify(lines), value, vat, value + vat, day, who.userId, now()])
      } catch { throw new HttpError(409, `Invoice ${b.invoiceNo} from ${b.supplier} is already entered.`) }
      for (const l of lines) {
        await t.query('insert into bar_stock_move (id, brand_id, business_date, kind, ml, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [newId('BM'), l.brandId, day, 'purchase', l.bottles * l.bottleMl, id, `${l.bottles} × ${l.bottleMl} ml · ${b.supplier} ${b.invoiceNo}`, who.userId, now()])
      }
      await appendAudit(t, { actor: who, action: 'bar.purchase', entity: { type: 'tasmac_purchase', id }, amount: value + vat, after: { invoiceNo: b.invoiceNo, lines: lines.length } }, now())
      return reply.status(201).send({ id, valuePaise: value, totalPaise: value + vat })
    })
  })

  // Purchase register (for the monthly VAT return).
  app.get('/api/bar/purchases', async (req) => {
    await need(req, 'bar.stock', 'tax.vat')
    const q = req.query as { from?: string; to?: string }
    return db.query(
      `select p.id, p.supplier, p.invoice_no, p.invoice_date::text, p.lines, p.value_paise, p.vat_paise, p.total_paise, p.business_date::text, u.name as received_by
         from tasmac_purchase p join app_user u on u.id = p.received_by
        where ($1::date is null or p.invoice_date >= $1) and ($2::date is null or p.invoice_date <= $2) order by p.invoice_date desc, p.received_at desc`,
      [q.from ?? null, q.to ?? null])
  })

  // ---------- breakage ----------
  app.post('/api/bar/breakage', async (req, reply) => {
    const who = await need(req, 'bar.stock', 'kitchen')
    const b = req.body as { brandId?: string; ml?: number; reason?: string }
    if (!(Number.isInteger(b?.ml) && b.ml! > 0)) throw new HttpError(400, 'How many ml were lost?')
    if (!b.reason?.trim() || b.reason.length < 3) throw new HttpError(400, 'Give a reason (and keep the broken bottle for the manager).')
    return db.tx(async (t) => {
      const [br] = await t.query<{ name: string; bottle_ml: number }>('select name, bottle_ml from liquor_brand where id = $1', [b.brandId])
      if (!br) throw new HttpError(404, 'No such brand.')
      const value = Math.round((await costPerMl(t, b.brandId!, br.bottle_ml)) * b.ml!)
      const day = await businessDate(t)
      if (value > rupees(await roleLimit(t, who, 'breakage_per_entry')) || !can(who, 'bar.stock')) {
        const approvalId = await createApproval(ctx, t, 'bar.breakage', who.userId, { brandId: b.brandId, brand: br.name, ml: b.ml, value, reason: b.reason!.trim(), day, requestedBy: who.userId }, b.reason)
        await appendAudit(t, { actor: who, action: 'bar.breakage_requested', entity: { type: 'liquor_brand', id: b.brandId! }, amount: value, after: { ml: b.ml }, note: b.reason }, now())
        return reply.status(202).send({ pending: true, approvalId })
      }
      await t.query('insert into bar_stock_move (id, brand_id, business_date, kind, ml, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [newId('BM'), b.brandId, day, 'breakage', -b.ml!, null, b.reason!.trim(), who.userId, now()])
      await appendAudit(t, { actor: who, action: 'bar.breakage', entity: { type: 'liquor_brand', id: b.brandId! }, amount: value, after: { ml: b.ml, brand: br.name }, note: b.reason }, now())
      return reply.status(201).send({ ok: true })
    })
  })

  // ---------- physical count ----------
  app.post('/api/bar/counts', async (req, reply) => {
    const who = await need(req, 'bar.stock')
    const b = req.body as { lines?: { brandId: string; fullBottles: number; openMl?: number }[] }
    if (!Array.isArray(b?.lines) || !b.lines.length) throw new HttpError(400, 'Count at least one brand.')
    return db.tx(async (t) => {
      const lines = []
      for (const l of b.lines!) {
        const [br] = await t.query<{ name: string; bottle_ml: number }>('select name, bottle_ml from liquor_brand where id = $1', [l.brandId])
        if (!br) throw new HttpError(400, `No brand ${l.brandId}.`)
        const open = l.openMl ?? 0
        if (!(Number.isInteger(l.fullBottles) && l.fullBottles >= 0) || !(Number.isInteger(open) && open >= 0 && open < br.bottle_ml)) {
          throw new HttpError(400, `${br.name}: full bottles, and the open bottle in ml (less than ${br.bottle_ml}).`)
        }
        const book = await bookMl(t, l.brandId), counted = l.fullBottles * br.bottle_ml + open
        lines.push({ brandId: l.brandId, name: br.name, bookMl: book, countedMl: counted, varianceMl: counted - book })
      }
      const book = lines.reduce((a, l) => a + Math.max(0, l.bookMl), 0)
      const variancePercent = book ? Math.round((lines.reduce((a, l) => a + Math.abs(l.varianceMl), 0) / book) * 10000) / 100 : 0
      const id = newId('BC'), day = await businessDate(t)
      await t.query('insert into bar_count (id, business_date, lines, variance_percent, counted_by, counted_at) values ($1,$2,$3,$4,$5,$6)',
        [id, day, JSON.stringify(lines), variancePercent, who.userId, now()])
      const alert = variancePercent > (ctx.tax.liquor_controls.variance_alert_percent ?? 3)
      await appendAudit(t, { actor: who, action: alert ? 'bar.count_variance_alert' : 'bar.count', entity: { type: 'bar_count', id }, after: { variancePercent, lines: lines.length } }, now())
      const approvalId = await createApproval(ctx, t, 'bar.count', who.userId, { countId: id, variancePercent, brands: lines.length }, `Bar count: ${variancePercent}% variance`)
      return reply.status(201).send({ id, lines, variancePercent, alert, approvalId })
    })
  })

  app.get('/api/bar/counts', async (req) => {
    await need(req, 'bar.stock', 'bar.approve')
    return db.query(`select c.id, c.business_date::text, c.lines, c.variance_percent, c.status, u.name as counted_by, c.counted_at
                       from bar_count c join app_user u on u.id = c.counted_by order by c.counted_at desc limit 50`)
  })
}

/** Sample brands for the placeholder bar menu, linked to its items, so the register works from day one. */
export async function ensureBarStock(db: Db) {
  const [{ n }] = await db.query<{ n: number }>('select count(*)::int as n from liquor_brand')
  if (n > 0) return
  const brands = [
    { id: 'BR-BEER650', name: 'Beer (sample) 650 ml', cls: 'beer', ml: 650, items: [['BR01', 650]] },
    { id: 'BR-WHISKY750', name: 'Whisky (sample) 750 ml', cls: 'imfl_spirits', ml: 750, items: [['SP01', 30]] },
    { id: 'BR-RUM750', name: 'Rum (sample) 750 ml', cls: 'imfl_spirits', ml: 750, items: [['SP02', 30]] },
    { id: 'BR-REDWINE750', name: 'Red wine (sample) 750 ml', cls: 'wine', ml: 750, items: [['WN01', 150]] },
  ]
  const classes = new Set((await db.query<{ id: string }>('select id from liquor_class')).map((c) => c.id))
  for (const b of brands.filter((x) => classes.has(x.cls))) {
    await db.query('insert into liquor_brand (id, name, liquor_class, bottle_ml, placeholder, created_at) values ($1,$2,$3,$4,true,now())', [b.id, b.name, b.cls, b.ml])
    for (const [code, pour] of b.items) await db.query('update menu_item set brand_id = $1, pour_ml = $2 where code = $3 and liquor_class = $4', [b.id, pour, code, b.cls])
  }
}
