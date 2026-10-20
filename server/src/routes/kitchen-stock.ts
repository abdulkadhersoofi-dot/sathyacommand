import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { businessDate } from '../fo-core'
import { createApproval, registerApprovalKind, roleLimit } from './approvals'
import { requireCaller } from './auth'

// Kitchen ingredients, recipes per dish, automatic stock deduction when a KOT is sent, receipts,
// wastage, counts, and the food cost of what was sold (with a simple menu-engineering view).

const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
const DATE = /^\d{4}-\d{2}-\d{2}$/
const UNITS = ['g', 'ml', 'pcs'] as const
/** Ingredients are counted in g / ml / pieces; prices are quoted per kg / litre / piece. */
const PACK = { g: 1000, ml: 1000, pcs: 1 } as const
const PACK_NAME = { g: 'kg', ml: 'litre', pcs: 'piece' } as const

/** Takes each sent dish's recipe off the kitchen stock (a cancelled dish was usually already cooked, so it stays consumed). */
export async function consumeRecipes(t: Db, who: Caller, orderItemIds: string[], day: string, now: Date) {
  const rows = await t.query<{ order_item_id: string; qty: number; name: string; ingredient_id: string; per: string; cost_per_unit: string }>(
    `select i.id as order_item_id, i.qty, i.name, r.ingredient_id, r.qty as per, g.cost_per_unit
       from order_item i join menu_item m on m.id = i.item_id join recipe_line r on r.dish_code = m.code join ingredient g on g.id = r.ingredient_id
      where i.id = any($1)`, [orderItemIds])
  for (const r of rows) {
    const qty = Number(r.per) * r.qty
    await t.query('insert into kitchen_stock_move (id, ingredient_id, business_date, kind, qty, cost_paise, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [newId('KM'), r.ingredient_id, day, 'consumption', -qty, -Math.round(qty * Number(r.cost_per_unit)), r.order_item_id, `${r.qty} × ${r.name}`, who.userId, now])
  }
}

async function stockOf(t: Db, id: string) {
  const [{ q }] = await t.query<{ q: string }>('select coalesce(sum(qty), 0) as q from kitchen_stock_move where ingredient_id = $1', [id])
  return Number(q)
}

async function recordWastage(t: Db, p: { ingredientId: string; qty: number; value: number; reason: string; day: string }, userId: string, now: Date) {
  await t.query('insert into kitchen_stock_move (id, ingredient_id, business_date, kind, qty, cost_paise, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [newId('KM'), p.ingredientId, p.day, 'wastage', -p.qty, -p.value, p.reason, userId, now])
}

registerApprovalKind('kitchen.wastage', {
  permission: 'kitchen.approve',
  apply: (t, p, _decider, ctx) => recordWastage(t, p as never, String(p.requestedBy), ctx.now()),
})

export function kitchenStockRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }

  // ---------- ingredients ----------
  app.get('/api/kitchen/ingredients', async (req) => {
    await need(req, 'kitchen.stock', 'kitchen', 'food_cost.view')
    const rows = await db.query<{ id: string; unit: keyof typeof PACK; cost_per_unit: string; par_level: string | null; stock: string }>(
      `select g.id, g.name, g.unit, g.cost_per_unit, g.par_level, g.placeholder, g.active, coalesce(sum(m.qty), 0) as stock
         from ingredient g left join kitchen_stock_move m on m.ingredient_id = g.id group by g.id order by g.active desc, g.name`)
    return rows.map((r) => {
      const stock = Number(r.stock), cpu = Number(r.cost_per_unit), par = r.par_level == null ? null : Number(r.par_level)
      return { ...r, stock, parLevel: par, costPerPack: Math.round(cpu * PACK[r.unit]) / 100, pack: PACK_NAME[r.unit], valuePaise: Math.round(Math.max(0, stock) * cpu), belowPar: par != null && stock < par }
    })
  })

  app.post('/api/kitchen/ingredients', async (req, reply) => {
    const who = await need(req, 'kitchen.stock')
    const b = req.body as { name?: string; unit?: string; costPerPack?: number; parLevel?: number | null }
    if (!b?.name?.trim() || b.name.length > 60) throw new HttpError(400, 'Ingredient name is required (up to 60 characters).')
    if (!UNITS.includes(b.unit as typeof UNITS[number])) throw new HttpError(400, 'Unit: g, ml or pcs.')
    if (b.costPerPack !== undefined && !(b.costPerPack >= 0)) throw new HttpError(400, 'Cost must be ₹0 or more.')
    const unit = b.unit as keyof typeof PACK
    return db.tx(async (t) => {
      const [dup] = await t.query('select 1 from ingredient where lower(name) = lower($1)', [b.name!.trim()])
      if (dup) throw new HttpError(409, `${b.name} already exists.`)
      const id = newId('ING')
      await t.query('insert into ingredient (id, name, unit, cost_per_unit, par_level, created_at) values ($1,$2,$3,$4,$5,$6)',
        [id, b.name!.trim(), unit, (rupees(b.costPerPack ?? 0)) / PACK[unit], b.parLevel ?? null, now()])
      await appendAudit(t, { actor: who, action: 'ingredient.create', entity: { type: 'ingredient', id }, after: b }, now())
      return reply.status(201).send({ id })
    })
  })

  app.patch('/api/kitchen/ingredients/:id', async (req) => {
    const who = await need(req, 'kitchen.stock')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; costPerPack?: number; parLevel?: number | null; active?: boolean }
    return db.tx(async (t) => {
      const [before] = await t.query<{ unit: keyof typeof PACK }>('select * from ingredient where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such ingredient.')
      if (b.active === false) {
        const [used] = await t.query<{ dish_code: string }>('select dish_code from recipe_line where ingredient_id = $1 limit 1', [id])
        if (used) throw new HttpError(409, `Recipe ${used.dish_code} still uses it. Change the recipe first.`)
      }
      await t.query(`update ingredient set name = coalesce($2, name), cost_per_unit = coalesce($3, cost_per_unit),
                       par_level = case when $4::boolean then $5 else par_level end, active = coalesce($6, active), placeholder = false where id = $1`,
        [id, b.name?.trim() ?? null, b.costPerPack !== undefined ? rupees(b.costPerPack) / PACK[before.unit] : null, b.parLevel !== undefined, b.parLevel ?? null, b.active ?? null])
      const [after] = await t.query('select * from ingredient where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'ingredient.update', entity: { type: 'ingredient', id }, before, after }, now())
      return after
    })
  })

  // ---------- recipes ----------
  app.get('/api/kitchen/recipes', async (req) => {
    await need(req, 'kitchen.stock', 'kitchen', 'food_cost.view')
    const dishes = await db.query<{ code: string; name: string; price_paise: number; outlets: string[] }>(
      `select code, min(name) as name, min(price_paise)::bigint as price_paise, array_agg(distinct outlet_id) as outlets
         from menu_item where active and liquor_class is null group by code order by code`)
    const lines = await db.query<{ dish_code: string; ingredient_id: string; name: string; unit: string; qty: string; cost_per_unit: string }>(
      `select r.dish_code, r.ingredient_id, g.name, g.unit, r.qty, g.cost_per_unit from recipe_line r join ingredient g on g.id = r.ingredient_id order by g.name`)
    return dishes.map((d) => {
      const ls = lines.filter((l) => l.dish_code === d.code).map((l) => ({ ingredientId: l.ingredient_id, name: l.name, unit: l.unit, qty: Number(l.qty), costPaise: Math.round(Number(l.qty) * Number(l.cost_per_unit)) }))
      const cost = ls.reduce((a, l) => a + l.costPaise, 0)
      return { ...d, price_paise: Number(d.price_paise), lines: ls, costPaise: cost, costPercent: ls.length && d.price_paise ? Math.round((cost / Number(d.price_paise)) * 1000) / 10 : null }
    })
  })

  app.put('/api/kitchen/recipes/:code', async (req) => {
    const who = await need(req, 'kitchen.stock')
    const { code } = req.params as { code: string }
    const b = req.body as { lines?: { ingredientId: string; qty: number }[] }
    if (!Array.isArray(b?.lines) || b.lines.length > 40) throw new HttpError(400, 'Send lines: ingredient and quantity per portion (up to 40).')
    return db.tx(async (t) => {
      const [dish] = await t.query('select 1 from menu_item where code = $1 and liquor_class is null', [code])
      if (!dish) throw new HttpError(404, `No dish ${code}.`)
      const seen = new Set<string>()
      for (const l of b.lines!) {
        if (seen.has(l.ingredientId)) throw new HttpError(400, 'Each ingredient once per recipe.')
        seen.add(l.ingredientId)
        if (!(l.qty > 0 && l.qty <= 100000)) throw new HttpError(400, 'Quantities per portion must be more than 0.')
        const [g] = await t.query('select 1 from ingredient where id = $1 and active', [l.ingredientId])
        if (!g) throw new HttpError(400, `No ingredient ${l.ingredientId}.`)
      }
      const before = await t.query('select ingredient_id, qty from recipe_line where dish_code = $1', [code])
      await t.query('delete from recipe_line where dish_code = $1', [code])
      for (const l of b.lines!) await t.query('insert into recipe_line (dish_code, ingredient_id, qty) values ($1,$2,$3)', [code, l.ingredientId, l.qty])
      await appendAudit(t, { actor: who, action: 'recipe.update', entity: { type: 'recipe', id: code }, before, after: b.lines }, now())
      return { ok: true }
    })
  })

  // ---------- movements ----------
  app.post('/api/kitchen/receipts', async (req, reply) => {
    const who = await need(req, 'kitchen.stock')
    const b = req.body as { lines?: { ingredientId: string; qty: number; cost: number }[]; note?: string }
    if (!Array.isArray(b?.lines) || !b.lines.length) throw new HttpError(400, 'Add at least one ingredient.')
    return db.tx(async (t) => {
      const day = await businessDate(t), ref = newId('KR')
      let value = 0
      for (const l of b.lines!) {
        const [g] = await t.query<{ name: string }>('select name from ingredient where id = $1 and active', [l.ingredientId])
        if (!g) throw new HttpError(400, `No ingredient ${l.ingredientId}.`)
        if (!(l.qty > 0) || !(l.cost >= 0)) throw new HttpError(400, `${g.name}: quantity and cost (₹ for the whole line).`)
        const cost = rupees(l.cost)
        value += cost
        await t.query('insert into kitchen_stock_move (id, ingredient_id, business_date, kind, qty, cost_paise, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [newId('KM'), l.ingredientId, day, 'receipt', l.qty, cost, ref, b.note?.trim() || null, who.userId, now()])
        if (cost) await t.query('update ingredient set cost_per_unit = $2, placeholder = false where id = $1', [l.ingredientId, cost / l.qty])
      }
      await appendAudit(t, { actor: who, action: 'kitchen.receipt', entity: { type: 'kitchen_receipt', id: ref }, amount: value, after: { lines: b.lines!.length }, note: b.note }, now())
      return reply.status(201).send({ id: ref, valuePaise: value })
    })
  })

  app.post('/api/kitchen/wastage', async (req, reply) => {
    const who = await need(req, 'kitchen.stock', 'kitchen')
    const b = req.body as { ingredientId?: string; qty?: number; reason?: string }
    if (!(b?.qty! > 0)) throw new HttpError(400, 'How much was wasted?')
    if (!b.reason?.trim() || b.reason.length < 3) throw new HttpError(400, 'Give a reason (spoiled, burnt, dropped…).')
    return db.tx(async (t) => {
      const [g] = await t.query<{ name: string; cost_per_unit: string }>('select name, cost_per_unit from ingredient where id = $1', [b.ingredientId])
      if (!g) throw new HttpError(404, 'No such ingredient.')
      const value = Math.round(b.qty! * Number(g.cost_per_unit))
      const p = { ingredientId: b.ingredientId!, qty: b.qty!, value, reason: b.reason!.trim(), day: await businessDate(t) }
      if (value > rupees(await roleLimit(t, who, 'wastage_per_entry')) && !can(who, 'kitchen.approve')) {
        const approvalId = await createApproval(ctx, t, 'kitchen.wastage', who.userId, { ...p, ingredient: g.name, requestedBy: who.userId }, b.reason)
        await appendAudit(t, { actor: who, action: 'kitchen.wastage_requested', entity: { type: 'ingredient', id: b.ingredientId! }, amount: value, note: b.reason }, now())
        return reply.status(202).send({ pending: true, approvalId })
      }
      await recordWastage(t, p, who.userId, now())
      await appendAudit(t, { actor: who, action: 'kitchen.wastage', entity: { type: 'ingredient', id: b.ingredientId! }, amount: value, after: { qty: b.qty, ingredient: g.name }, note: b.reason }, now())
      return reply.status(201).send({ ok: true, valuePaise: value })
    })
  })

  // A count sets the book stock to what is on the shelf; the difference is logged with its value.
  app.post('/api/kitchen/counts', async (req) => {
    const who = await need(req, 'kitchen.stock')
    const b = req.body as { lines?: { ingredientId: string; qty: number }[] }
    if (!Array.isArray(b?.lines) || !b.lines.length) throw new HttpError(400, 'Count at least one ingredient.')
    return db.tx(async (t) => {
      const day = await businessDate(t), ref = newId('KC')
      const out = []
      for (const l of b.lines!) {
        const [g] = await t.query<{ name: string; cost_per_unit: string }>('select name, cost_per_unit from ingredient where id = $1', [l.ingredientId])
        if (!g || !(l.qty >= 0)) throw new HttpError(400, `Check the count for ${l.ingredientId}.`)
        const diff = l.qty - await stockOf(t, l.ingredientId)
        const value = Math.round(diff * Number(g.cost_per_unit))
        if (diff) {
          await t.query('insert into kitchen_stock_move (id, ingredient_id, business_date, kind, qty, cost_paise, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [newId('KM'), l.ingredientId, day, 'count_adjust', diff, value, ref, 'Physical count', who.userId, now()])
        }
        out.push({ ingredientId: l.ingredientId, name: g.name, difference: diff, valuePaise: value })
      }
      const shortfall = out.reduce((a, l) => a + Math.min(0, l.valuePaise), 0)
      await appendAudit(t, { actor: who, action: 'kitchen.count', entity: { type: 'kitchen_count', id: ref }, amount: shortfall, after: { lines: out.length, day } }, now())
      return { id: ref, lines: out, shortfallPaise: -shortfall }
    })
  })

  // ---------- food cost ----------
  app.get('/api/kitchen/food-cost', async (req) => {
    await need(req, 'food_cost.view')
    const q = req.query as { from?: string; to?: string; outletId?: string }
    const today = await businessDate(db)
    const from = q.from ?? today, to = q.to ?? today
    if (!DATE.test(from) || !DATE.test(to) || to < from) throw new HttpError(400, 'from and to as YYYY-MM-DD.')
    return foodCost(db, from, to, q.outletId ?? null)
  })
}

/** Food cost of what was sold between two days: theoretical from the recipes, actual with wastage and count losses added. */
export async function foodCost(t: Db, from: string, to: string, outletId: string | null = null) {
  const rows = await t.query<{ code: string; name: string; qty: number; sales: string; cost: string; has_recipe: boolean }>(
    `with sold as (
       select i.id, i.qty, i.price_paise, i.name, m.code from order_item i join menu_item m on m.id = i.item_id join fnb_order o on o.id = i.order_id
        where i.status = 'sent' and i.liquor_class is null and o.business_date between $1 and $2 and ($3::text is null or o.outlet_id = $3)),
     used as (select k.ref, -sum(k.cost_paise) as cost from kitchen_stock_move k where k.kind = 'consumption' and k.ref in (select id from sold) group by k.ref)
     select s.code, min(s.name) as name, sum(s.qty)::int as qty, sum(s.price_paise * s.qty) as sales, coalesce(sum(u.cost), 0) as cost,
            exists (select 1 from recipe_line r where r.dish_code = s.code) as has_recipe
       from sold s left join used u on u.ref = s.id group by s.code order by sum(s.price_paise * s.qty) desc`, [from, to, outletId])
  const dishes = rows.map((r) => ({ code: r.code, name: r.name, qty: r.qty, salesPaise: Number(r.sales), costPaise: Number(r.cost), hasRecipe: r.has_recipe,
    costPercent: Number(r.sales) ? Math.round((Number(r.cost) / Number(r.sales)) * 1000) / 10 : 0, marginPaise: Number(r.sales) - Number(r.cost) }))
  // Menu engineering: popularity against 70% of the average share, margin against the average margin per portion.
  const withRecipe = dishes.filter((d) => d.hasRecipe && d.qty)
  const totalQty = withRecipe.reduce((a, d) => a + d.qty, 0)
  const avgMargin = totalQty ? withRecipe.reduce((a, d) => a + d.marginPaise, 0) / totalQty : 0
  const popular = withRecipe.length ? (totalQty / withRecipe.length) * 0.7 : 0
  for (const d of dishes as (typeof dishes[number] & { class?: string })[]) {
    if (!d.hasRecipe || !d.qty) continue
    const hiPop = d.qty >= popular, hiMargin = d.marginPaise / d.qty >= avgMargin
    d.class = hiPop && hiMargin ? 'star' : hiPop ? 'plowhorse' : hiMargin ? 'puzzle' : 'dog'
  }
  const [mv] = await t.query<{ wastage: string; adjust: string }>(
    `select coalesce(-sum(cost_paise) filter (where kind = 'wastage'), 0) as wastage, coalesce(-sum(cost_paise) filter (where kind = 'count_adjust'), 0) as adjust
       from kitchen_stock_move where business_date between $1 and $2`, [from, to])
  const sales = dishes.reduce((a, d) => a + d.salesPaise, 0), theoretical = dishes.reduce((a, d) => a + d.costPaise, 0)
  const wastage = Number(mv.wastage), countLoss = Number(mv.adjust)
  return {
    from, to, dishes,
    totals: {
      salesPaise: sales, theoreticalCostPaise: theoretical, theoreticalPercent: sales ? Math.round((theoretical / sales) * 1000) / 10 : 0,
      wastagePaise: wastage, countLossPaise: countLoss, actualCostPaise: theoretical + wastage + countLoss,
      actualPercent: sales ? Math.round(((theoretical + wastage + countLoss) / sales) * 1000) / 10 : 0,
      dishesWithoutRecipe: dishes.filter((d) => !d.hasRecipe).map((d) => d.code),
    },
  }
}

/** Sample ingredients and recipes for the placeholder menu, so food cost works before the real recipes are entered. */
export async function ensureRecipes(db: Db) {
  const [{ n }] = await db.query<{ n: number }>('select count(*)::int as n from ingredient')
  if (n > 0) return
  // name, unit, ₹ per kg / litre / piece
  const ING: [string, string, number][] = [
    ['Idli batter', 'g', 50], ['Dosa batter', 'g', 60], ['Potato masala', 'g', 80], ['Coconut chutney', 'g', 120], ['Sambar', 'ml', 70],
    ['Cooking oil', 'ml', 150], ['Coffee decoction', 'ml', 400], ['Milk', 'ml', 56], ['Sugar', 'g', 45], ['Paneer', 'g', 400], ['Butter', 'g', 500],
    ['Fresh cream', 'ml', 300], ['Chicken', 'g', 260], ['Basmati rice', 'g', 120], ['Raw rice', 'g', 55], ['Curd', 'g', 70], ['Maida', 'g', 40],
    ['Onion', 'g', 35], ['Tomato', 'g', 30], ['Cauliflower', 'g', 50], ['Lime', 'pcs', 4], ['Soda', 'ml', 40],
  ]
  const id = (name: string) => 'ING-' + name.toUpperCase().replace(/[^A-Z]+/g, '-').replace(/-$/, '')
  for (const [name, unit, price] of ING) {
    await db.query('insert into ingredient (id, name, unit, cost_per_unit, placeholder, created_at) values ($1,$2,$3,$4,true,now())', [id(name), name, unit, (price * 100) / PACK[unit as keyof typeof PACK]])
  }
  const R: Record<string, [string, number][]> = {
    BF01: [['Idli batter', 160], ['Coconut chutney', 40], ['Sambar', 120]],
    BF02: [['Dosa batter', 150], ['Potato masala', 100], ['Cooking oil', 15], ['Coconut chutney', 40], ['Sambar', 120]],
    BV01: [['Coffee decoction', 30], ['Milk', 120], ['Sugar', 10]],
    NI01: [['Paneer', 150], ['Butter', 20], ['Fresh cream', 30], ['Onion', 60], ['Tomato', 100], ['Cooking oil', 15]],
    NI02: [['Maida', 90], ['Butter', 10]],
    NI03: [['Chicken', 200], ['Basmati rice', 150], ['Onion', 60], ['Cooking oil', 25], ['Curd', 30]],
    SI01: [['Chicken', 250], ['Onion', 80], ['Tomato', 60], ['Cooking oil', 30]],
    SI03: [['Raw rice', 120], ['Curd', 150], ['Milk', 30]],
    CH01: [['Cauliflower', 200], ['Maida', 30], ['Cooking oil', 40]],
    BV02: [['Lime', 1], ['Soda', 250], ['Sugar', 20]],
  }
  const codes = new Set((await db.query<{ code: string }>('select distinct code from menu_item').then((r) => r.map((x) => x.code))))
  for (const [code, lines] of Object.entries(R)) {
    if (!codes.has(code)) continue
    for (const [name, qty] of lines) await db.query('insert into recipe_line (dish_code, ingredient_id, qty) values ($1,$2,$3)', [code, id(name), qty])
  }
}
