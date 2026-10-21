import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { financialYear, liquorSaleAllowed, restaurantRate, rupees, splitGst } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { businessDate } from '../fo-core'
import { createApproval, registerApprovalKind } from './approvals'
import { requireCaller } from './auth'
import { vatRatesOn } from './settings'
import { pourStock, unpourStock } from './bar'
import { consumeRecipes } from './kitchen-stock'
import { queueTickets, type TicketForPrint } from './printing'

// Restaurant, room service and bar: menus, tables, orders and the KOT / BOT tickets that send each item
// to its kitchen or bar station. Cancelling an item after its ticket went to the kitchen needs a manager,
// and every order, ticket, reprint and cancellation goes into the God Mode log.

const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DIETS = ['veg', 'egg', 'non_veg']

/** Local date and time at the resort ("YYYY-MM-DDTHH:MM", India Standard Time). */
export const istLocal = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16)

async function need(ctx: Ctx, req: FastifyRequest, ...permissions: string[]) {
  const who = await requireCaller(ctx, req)
  if (!permissions.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
  return who
}

async function nextCounter(t: Db, date: string, kind: string) {
  const [r] = await t.query<{ n: number }>(
    `insert into fnb_counter (business_date, kind, next) values ($1, $2, 2)
     on conflict (business_date, kind) do update set next = fnb_counter.next + 1 returning next - 1 as n`, [date, kind])
  return r.n
}

/** Refuses a liquor sale on a dry day, outside licensed hours, or before the hours are set. */
export async function checkLiquorAllowed(ctx: Ctx, t: Db) {
  const [p] = await t.query<{ bar_open: string | null; bar_close: string | null }>('select bar_open, bar_close from property limit 1')
  if (!p.bar_open || !p.bar_close) throw new HttpError(409, 'Set the licensed bar hours under Restaurant → Licences & tax → Bar licence hours before selling liquor.')
  const dry = (await t.query<{ day: string }>('select day::text from dry_day')).map((d) => d.day)
  const r = liquorSaleAllowed(ctx.tax, istLocal(ctx.now()), { open: p.bar_open, close: p.bar_close, dryDays: dry })
  if (!r.allowed) throw new HttpError(409, r.reason!)
}

interface OrderRow { id: string; number: number; outlet_id: string; kind: string; table_id: string | null; reservation_id: string | null; status: string; covers: number; business_date: string }

async function loadOrder(t: Db, id: string, lock = false) {
  const [o] = await t.query<OrderRow>(`select id, number, outlet_id, kind, table_id, reservation_id, status, covers, business_date::text from fnb_order where id = $1 ${lock ? 'for update' : ''}`, [id])
  if (!o) throw new HttpError(404, 'No such order.')
  return o
}

const openOnly = (o: OrderRow) => { if (o.status !== 'open') throw new HttpError(409, `Order ${o.number} is ${o.status}.`) }

/** The order with its items, tickets and a running total (GST on food; liquor is shown before VAT until the bill). */
export async function orderView(ctx: Ctx, db: Db, id: string) {
  const [o] = await db.query<{ business_date: string; number: number; outlet: string; table_label: string | null; room_no: string | null; covers: number; [k: string]: unknown }>(
    `select o.id, o.number, o.outlet_id, ot.name as outlet, o.kind, o.table_id, tb.label as table_label, o.reservation_id, s.room_no, g.name as guest,
            o.covers, o.status, o.business_date::text, o.opened_at, u.name as opened_by, o.note
       from fnb_order o join outlet ot on ot.id = o.outlet_id join app_user u on u.id = o.opened_by
       left join dining_table tb on tb.id = o.table_id
       left join reservation r on r.id = o.reservation_id left join space s on s.id = r.space_id left join guest g on g.id = r.guest_id
      where o.id = $1`, [id])
  if (!o) throw new HttpError(404, 'No such order.')
  const items = await db.query<{ status: string; price_paise: number; qty: number; liquor_class: string | null }>(
    `select i.id, i.item_id, i.name, i.price_paise, i.qty, i.liquor_class, i.station_id, i.seat, i.course, i.note, i.status, i.kot_id,
            k.number as kot_number, k.kind as kot_kind, k.status as kot_status, i.void_reason, i.added_at
       from order_item i left join kot k on k.id = i.kot_id where i.order_id = $1 order by i.added_at, i.seq`, [id])
  const kots = await db.query(
    `select id, number, kind, station_id, status, prints, created_at, ready_at, served_at from kot where order_id = $1 order by created_at`, [id])
  const live = items.filter((i) => i.status !== 'void')
  const food = live.filter((i) => !i.liquor_class).reduce((a, i) => a + i.price_paise * i.qty, 0)
  const liquor = live.filter((i) => i.liquor_class).reduce((a, i) => a + i.price_paise * i.qty, 0)
  const { rate } = restaurantRate(ctx.tax, financialYear(o.business_date))
  const gst = splitGst(food, rate)
  // VAT per liquor class at the rate in force on the order's business date; classes without a rate are flagged.
  const vatRates = await vatRatesOn(db, o.business_date)
  let vat = 0
  const vatMissing = new Set<string>()
  for (const i of live.filter((x) => x.liquor_class)) {
    const r = vatRates[i.liquor_class!]
    if (r == null) vatMissing.add(i.liquor_class!)
    else vat += Math.round((i.price_paise * i.qty * r) / 100)
  }
  return { ...o, items, kots, totals: { food, gstRate: rate, cgst: gst.cgst, sgst: gst.sgst, liquorBeforeVat: liquor, vat, vatMissing: [...vatMissing],
    beforeVat: gst.total + liquor, payable: gst.total + liquor + vat } }
}

function ticket(k: { id: string; number: number; kind: string; station_id: string; prints: number }, order: Record<string, unknown>, lines: TicketForPrint['lines']): TicketForPrint & { id: string; prints: number } {
  const o = order as { number: number; outlet: string; table_label: string | null; room_no: string | null; covers: number }
  return { ...k, copy: k.prints > 1, order: { number: o.number, outlet: o.outlet, table: o.table_label, room: o.room_no, covers: o.covers }, lines }
}

/** Applies a cancellation of an item that already went to the kitchen (directly by a manager, or once approved). */
async function voidSentItem(ctx: Ctx, t: Db, who: Caller, itemId: string, reason: string, requestedBy?: string) {
  const [i] = await t.query<{ id: string; order_id: string; status: string; name: string; qty: number; price_paise: number; kot_id: string }>(
    'select id, order_id, status, name, qty, price_paise, kot_id from order_item where id = $1 for update', [itemId])
  if (!i) throw new HttpError(404, 'No such item.')
  if (i.status === 'void') return
  await t.query('update order_item set status = $2, void_reason = $3, voided_by = $4, voided_at = $5 where id = $1', [itemId, 'void', reason, who.userId, ctx.now()])
  await unpourStock(t, who, itemId, await businessDate(t), ctx.now())
  await appendAudit(t, { actor: who, action: 'order_item.void_after_kot', entity: { type: 'fnb_order', id: i.order_id }, amount: i.price_paise * i.qty,
    after: { item: i.name, qty: i.qty, kot: i.kot_id, requestedBy: requestedBy ?? who.userId }, note: reason }, ctx.now())
}

const APPROVAL_KINDS = {
  'fnb.void_after_kot': {
    permission: 'fnb.void',
    async apply(t: Db, p: Record<string, unknown>, decider: Caller, ctx: Ctx) {
      // Once the bill is made the item is on it: the bill has to be cancelled first.
      const [o] = await t.query<{ status: string; number: number }>('select status, number from fnb_order where id = $1', [p.orderId])
      if (o && o.status !== 'open') throw new HttpError(409, `Order ${o.number} is already ${o.status}. Cancel its bill first, or reject this request.`)
      await voidSentItem(ctx, t, decider, String(p.itemId), String(p.reason), String(p.requestedBy))
    },
  },
  'menu.price': {
    permission: 'menu.price',
    async apply(t: Db, p: Record<string, unknown>, _decider: Caller, ctx: Ctx) {
      await t.query('update menu_item set price_paise = $2, placeholder = false, updated_at = $3 where id = $1', [p.itemId, p.price, ctx.now()])
    },
  },
}

interface ItemInput {
  outletId?: string; categoryId?: string | null; category?: string; code?: string; name?: string; nameTa?: string | null; price?: number
  liquorClass?: string | null; stationId?: string; diet?: string; jain?: boolean; allergens?: string[]; active?: boolean
}

async function checkItemInput(ctx: Ctx, t: Db, b: ItemInput, partial: boolean) {
  if (!partial || b.name !== undefined) if (!b.name?.trim() || b.name.length > 80) throw new HttpError(400, 'Item name is required (up to 80 characters).')
  if (!partial || b.code !== undefined) if (!/^[A-Za-z0-9-]{1,12}$/.test(b.code ?? '')) throw new HttpError(400, 'Item code: 1–12 letters, digits or dashes.')
  if (!partial || b.price !== undefined) if (!(typeof b.price === 'number' && b.price >= 0 && b.price <= 100000)) throw new HttpError(400, 'Price must be ₹0–1,00,000.')
  if (b.diet !== undefined && !DIETS.includes(b.diet)) throw new HttpError(400, 'Diet must be veg, egg or non_veg.')
  if (!partial || b.stationId !== undefined) {
    const [s] = await t.query<{ kind: string }>('select kind from station where id = $1 and active', [b.stationId])
    if (!s) throw new HttpError(400, `No kitchen or bar station ${b.stationId}.`)
    if (b.liquorClass && s.kind !== 'bar') throw new HttpError(400, 'Liquor must go to a bar station.')
  }
  if (b.liquorClass) {
    const classes = (await t.query<{ id: string }>('select id from liquor_class where active')).map((c) => c.id)
    if (!classes.includes(b.liquorClass)) throw new HttpError(400, `Unknown liquor class ${b.liquorClass}. Use one of: ${classes.join(', ')} (add classes under VAT rates).`)
  }
}

async function categoryFor(t: Db, outletId: string, b: ItemInput) {
  if (b.categoryId) return b.categoryId
  if (!b.category?.trim()) return null
  const name = b.category.trim()
  const [c] = await t.query<{ id: string }>('select id from menu_category where outlet_id = $1 and name = $2', [outletId, name])
  if (c) return c.id
  const id = newId(`${outletId}-CAT`)
  await t.query('insert into menu_category (id, outlet_id, name, sort) values ($1, $2, $3, (select coalesce(max(sort), 0) + 1 from menu_category where outlet_id = $2))', [id, outletId, name])
  return id
}

export function fnbRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  for (const [kind, k] of Object.entries(APPROVAL_KINDS)) registerApprovalKind(kind, k)
  const now = () => ctx.now()

  // ---------- outlets, stations, menu ----------
  app.get('/api/fnb/outlets', async (req) => {
    await requireCaller(ctx, req)
    const all = (req.query as { all?: string }).all === 'true'
    const outlets = await db.query(`select id, name, kind, space_id, serves_liquor, active from outlet ${all ? '' : 'where active'} order by active desc, name`)
    const stations = await db.query(`select id, name, kind, active from station ${all ? '' : 'where active'} order by active desc, kind, name`)
    return { outlets, stations }
  })

  const OUTLET_KINDS = ['restaurant', 'room_service', 'bar', 'poolside', 'banquet']
  app.post('/api/fnb/outlets', async (req, reply) => {
    const who = await need(ctx, req, 'menu.edit')
    const b = req.body as { id?: string; name?: string; kind?: string; spaceId?: string | null; servesLiquor?: boolean }
    if (!/^[A-Z0-9]{2,10}$/.test(b?.id ?? '')) throw new HttpError(400, 'Outlet code: 2–10 capital letters or digits (e.g. CAFE).')
    if (!b.name?.trim() || b.name.length > 60) throw new HttpError(400, 'Give the outlet a name (up to 60 characters).')
    if (!OUTLET_KINDS.includes(b.kind ?? '')) throw new HttpError(400, `Kind: ${OUTLET_KINDS.join(', ')}.`)
    return db.tx(async (t) => {
      const [dup] = await t.query('select 1 from outlet where id = $1', [b.id])
      if (dup) throw new HttpError(409, `Outlet ${b.id} already exists.`)
      if (b.spaceId) { const [sp] = await t.query('select 1 from space where id = $1', [b.spaceId]); if (!sp) throw new HttpError(400, `No place ${b.spaceId}.`) }
      await t.query('insert into outlet (id, name, kind, space_id, serves_liquor) values ($1, $2, $3, $4, $5)', [b.id, b.name!.trim(), b.kind, b.spaceId ?? null, !!b.servesLiquor])
      await appendAudit(t, { actor: who, action: 'outlet.create', entity: { type: 'outlet', id: b.id! }, after: b }, now())
      return reply.status(201).send({ id: b.id })
    })
  })

  app.patch('/api/fnb/outlets/:id', async (req) => {
    const who = await need(ctx, req, 'menu.edit')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; kind?: string; spaceId?: string | null; servesLiquor?: boolean; active?: boolean }
    if (b.name !== undefined && (!b.name.trim() || b.name.length > 60)) throw new HttpError(400, 'Give the outlet a name (up to 60 characters).')
    if (b.kind !== undefined && !OUTLET_KINDS.includes(b.kind)) throw new HttpError(400, `Kind: ${OUTLET_KINDS.join(', ')}.`)
    return db.tx(async (t) => {
      const [before] = await t.query('select * from outlet where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such outlet.')
      if (b.active === false) {
        const [open] = await t.query(`select number from fnb_order where outlet_id = $1 and status in ('open', 'billed') limit 1`, [id])
        if (open) throw new HttpError(409, 'Close this outlet\'s open orders first.')
      }
      await t.query(`update outlet set name = coalesce($2, name), kind = coalesce($3, kind), space_id = case when $4::boolean then $5 else space_id end,
                       serves_liquor = coalesce($6, serves_liquor), active = coalesce($7, active) where id = $1`,
        [id, b.name?.trim() ?? null, b.kind ?? null, b.spaceId !== undefined, b.spaceId ?? null, b.servesLiquor ?? null, b.active ?? null])
      const [after] = await t.query('select * from outlet where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'outlet.update', entity: { type: 'outlet', id }, before, after }, now())
      return after
    })
  })

  app.post('/api/fnb/stations', async (req, reply) => {
    const who = await need(ctx, req, 'menu.edit')
    const b = req.body as { id?: string; name?: string; kind?: string }
    if (!/^[A-Z0-9]{2,10}$/.test(b?.id ?? '')) throw new HttpError(400, 'Station code: 2–10 capital letters or digits (e.g. TANDOOR).')
    if (!b.name?.trim() || b.name.length > 40) throw new HttpError(400, 'Give the station a name (up to 40 characters).')
    if (!['kitchen', 'bar'].includes(b.kind ?? '')) throw new HttpError(400, 'Kind: kitchen or bar.')
    return db.tx(async (t) => {
      const [dup] = await t.query('select 1 from station where id = $1', [b.id])
      if (dup) throw new HttpError(409, `Station ${b.id} already exists.`)
      await t.query('insert into station (id, name, kind) values ($1, $2, $3)', [b.id, b.name!.trim(), b.kind])
      await appendAudit(t, { actor: who, action: 'station.create', entity: { type: 'station', id: b.id! }, after: b }, now())
      return reply.status(201).send({ id: b.id })
    })
  })

  app.patch('/api/fnb/stations/:id', async (req) => {
    const who = await need(ctx, req, 'menu.edit')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; active?: boolean }
    if (b.name !== undefined && (!b.name.trim() || b.name.length > 40)) throw new HttpError(400, 'Give the station a name (up to 40 characters).')
    return db.tx(async (t) => {
      const [before] = await t.query('select * from station where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such station.')
      if (b.active === false) {
        const [used] = await t.query<{ name: string }>('select name from menu_item where station_id = $1 and active limit 1', [id])
        if (used) throw new HttpError(409, `${used.name} is still made here. Move those menu items to another station first.`)
      }
      await t.query('update station set name = coalesce($2, name), active = coalesce($3, active) where id = $1', [id, b.name?.trim() ?? null, b.active ?? null])
      const [after] = await t.query('select * from station where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'station.update', entity: { type: 'station', id }, before, after }, now())
      return after
    })
  })

  app.post('/api/fnb/categories', async (req, reply) => {
    const who = await need(ctx, req, 'menu.edit')
    const b = req.body as { outletId?: string; name?: string }
    if (!b?.name?.trim() || b.name.length > 40) throw new HttpError(400, 'Give the section a name (up to 40 characters).')
    return db.tx(async (t) => {
      const [o] = await t.query('select 1 from outlet where id = $1', [b.outletId])
      if (!o) throw new HttpError(400, `No outlet ${b.outletId}.`)
      const [dup] = await t.query('select 1 from menu_category where outlet_id = $1 and name = $2', [b.outletId, b.name!.trim()])
      if (dup) throw new HttpError(409, `${b.name} already exists.`)
      const id = await categoryFor(t, b.outletId!, { category: b.name })
      await appendAudit(t, { actor: who, action: 'menu_category.create', entity: { type: 'menu_category', id: id! }, after: b }, now())
      return reply.status(201).send({ id })
    })
  })

  app.patch('/api/fnb/categories/:id', async (req) => {
    const who = await need(ctx, req, 'menu.edit')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; sort?: number }
    if (b.name !== undefined && (!b.name.trim() || b.name.length > 40)) throw new HttpError(400, 'Give the section a name (up to 40 characters).')
    if (b.sort !== undefined && !Number.isInteger(b.sort)) throw new HttpError(400, 'sort is a whole number.')
    return db.tx(async (t) => {
      const [before] = await t.query('select * from menu_category where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such section.')
      try { await t.query('update menu_category set name = coalesce($2, name), sort = coalesce($3, sort) where id = $1', [id, b.name?.trim() ?? null, b.sort ?? null]) }
      catch { throw new HttpError(409, `${b.name} already exists.`) }
      const [after] = await t.query('select * from menu_category where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'menu_category.update', entity: { type: 'menu_category', id }, before, after }, now())
      return after
    })
  })

  app.get('/api/fnb/menu', async (req) => {
    await requireCaller(ctx, req)
    const { outletId, all } = req.query as { outletId?: string; all?: string }
    if (!outletId) throw new HttpError(400, 'Send outletId.')
    const categories = await db.query('select id, name, sort from menu_category where outlet_id = $1 order by sort, name', [outletId])
    const items = await db.query(
      `select id, category_id, code, name, name_ta, price_paise, liquor_class, station_id, diet, jain, allergens, available, placeholder, active, brand_id, pour_ml
         from menu_item where outlet_id = $1 ${all === 'true' ? '' : 'and active'} order by active desc, code`, [outletId])
    return { categories, items }
  })

  app.post('/api/fnb/items', async (req, reply) => {
    const who = await need(ctx, req, 'menu.edit')
    const b = req.body as ItemInput
    return db.tx(async (t) => {
      const [o] = await t.query('select 1 from outlet where id = $1', [b?.outletId])
      if (!o) throw new HttpError(400, `No outlet ${b?.outletId}.`)
      await checkItemInput(ctx, t, b, false)
      const [dup] = await t.query('select 1 from menu_item where outlet_id = $1 and code = $2', [b.outletId, b.code])
      if (dup) throw new HttpError(409, `Item code ${b.code} is already used in this outlet.`)
      const id = `${b.outletId}-${b.code}`
      await t.query(
        `insert into menu_item (id, outlet_id, category_id, code, name, name_ta, price_paise, liquor_class, station_id, diet, jain, allergens, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, b.outletId, await categoryFor(t, b.outletId!, b), b.code, b.name!.trim(), b.nameTa ?? null, rupees(b.price!), b.liquorClass ?? null,
          b.stationId, b.diet ?? 'veg', !!b.jain, b.allergens ?? [], now()])
      await appendAudit(t, { actor: who, action: 'menu_item.create', entity: { type: 'menu_item', id }, after: b }, now())
      return reply.status(201).send({ id })
    })
  })

  // Price changes need the GM (menu.price); anyone else's price change waits in the approval inbox.
  app.patch('/api/fnb/items/:id', async (req, reply) => {
    const who = await need(ctx, req, 'menu.edit', 'menu.price')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as ItemInput
    return db.tx(async (t) => {
      const [before] = await t.query<Record<string, unknown> & { outlet_id: string; price_paise: number; name: string }>('select * from menu_item where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such item.')
      await checkItemInput(ctx, t, b, true)
      const priceChange = b.price !== undefined && rupees(b.price) !== Number(before.price_paise)
      const others = Object.keys(b).some((k) => k !== 'price')
      if (others && !can(who, 'menu.edit')) throw new HttpError(403, 'Your role can only change prices.')
      if (others) {
        await t.query(
          `update menu_item set name = coalesce($2, name), name_ta = coalesce($3, name_ta), liquor_class = case when $4::boolean then $5 else liquor_class end,
                  station_id = coalesce($6, station_id), diet = coalesce($7, diet), jain = coalesce($8, jain), allergens = coalesce($9, allergens),
                  active = coalesce($10, active), category_id = coalesce($11, category_id), updated_at = $12 where id = $1`,
          [id, b.name?.trim() ?? null, b.nameTa ?? null, b.liquorClass !== undefined, b.liquorClass ?? null, b.stationId ?? null, b.diet ?? null,
            b.jain ?? null, b.allergens ?? null, b.active ?? null, b.category || b.categoryId ? await categoryFor(t, before.outlet_id, b) : null, now()])
      }
      let pending: string | null = null
      if (priceChange) {
        if (can(who, 'menu.price')) {
          await t.query('update menu_item set price_paise = $2, placeholder = false, updated_at = $3 where id = $1', [id, rupees(b.price!), now()])
        } else {
          pending = await createApproval(ctx, t, 'menu.price', who.userId, { itemId: id, item: before.name, from: Number(before.price_paise), price: rupees(b.price!) }, `Price change for ${before.name}`)
        }
      }
      const [after] = await t.query('select * from menu_item where id = $1', [id])
      await appendAudit(t, { actor: who, action: pending ? 'menu_item.price_requested' : 'menu_item.update', entity: { type: 'menu_item', id }, before, after,
        amount: priceChange ? rupees(b.price!) : undefined }, now())
      return pending ? reply.status(202).send({ pending: true, approvalId: pending, item: after }) : after
    })
  })

  // Sold out ("86") or back on: every captain's tablet sees it at once through the live stream.
  app.post('/api/fnb/items/:id/availability', async (req) => {
    const who = await need(ctx, req, 'kitchen', 'menu.edit')
    const { id } = req.params as { id: string }
    const available = (req.body as { available?: boolean })?.available
    if (typeof available !== 'boolean') throw new HttpError(400, 'Send available: true or false.')
    return db.tx(async (t) => {
      const [i] = await t.query<{ name: string }>('update menu_item set available = $2, updated_at = $3 where id = $1 returning name', [id, available, now()])
      if (!i) throw new HttpError(404, 'No such item.')
      await appendAudit(t, { actor: who, action: available ? 'menu_item.available' : 'menu_item.sold_out', entity: { type: 'menu_item', id }, after: { name: i.name, available } }, now())
      return { id, available }
    })
  })

  // Load the real menu (e.g. exported from Champagne). With replacePlaceholders, placeholder items not in the list are retired.
  app.post('/api/fnb/menu/import', async (req) => {
    const who = await need(ctx, req, 'menu.price')
    const b = req.body as { outletId?: string; items?: ItemInput[]; replacePlaceholders?: boolean }
    if (!Array.isArray(b?.items) || !b.items.length || b.items.length > 2000) throw new HttpError(400, 'Send items: a list of 1–2000 menu items.')
    return db.tx(async (t) => {
      const [o] = await t.query('select 1 from outlet where id = $1', [b.outletId])
      if (!o) throw new HttpError(400, `No outlet ${b.outletId}.`)
      let created = 0, updated = 0
      for (const [n, raw] of b.items!.entries()) {
        const it = { ...raw, outletId: b.outletId }
        try { await checkItemInput(ctx, t, it, false) } catch (e) { throw new HttpError(400, `Row ${n + 1} (${it.code ?? '?'}): ${(e as Error).message}`) }
        const id = `${b.outletId}-${it.code}`
        const r = await t.query<{ inserted: boolean }>(
          `insert into menu_item (id, outlet_id, category_id, code, name, name_ta, price_paise, liquor_class, station_id, diet, jain, allergens, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict (outlet_id, code) do update set category_id = excluded.category_id, name = excluded.name, name_ta = excluded.name_ta,
             price_paise = excluded.price_paise, liquor_class = excluded.liquor_class, station_id = excluded.station_id, diet = excluded.diet,
             jain = excluded.jain, allergens = excluded.allergens, active = true, placeholder = false, updated_at = excluded.updated_at
           returning (xmax = 0) as inserted`,
          [id, b.outletId, await categoryFor(t, b.outletId!, it), it.code, it.name!.trim(), it.nameTa ?? null, rupees(it.price!), it.liquorClass ?? null,
            it.stationId, it.diet ?? 'veg', !!it.jain, it.allergens ?? [], now()])
        if (r[0].inserted) created++; else updated++
      }
      let retired = 0
      if (b.replacePlaceholders) {
        const codes = b.items!.map((i) => i.code)
        retired = (await t.query('update menu_item set active = false, updated_at = $3 where outlet_id = $1 and placeholder and not (code = any($2)) returning id', [b.outletId, codes, now()])).length
      }
      await appendAudit(t, { actor: who, action: 'menu.import', entity: { type: 'outlet', id: b.outletId! }, after: { created, updated, retired } }, now())
      return { created, updated, retired }
    })
  })

  // ---------- tables ----------
  app.get('/api/fnb/tables', async (req) => {
    await requireCaller(ctx, req)
    const { outletId } = req.query as { outletId?: string }
    return db.query(
      `select t.id, t.outlet_id, t.label, t.seats, t.section, o.id as order_id, o.number as order_number, o.covers, o.status as order_status, o.opened_at,
              (select count(*)::int from kot k where k.order_id = o.id and k.status = 'ready') as ready_tickets
         from dining_table t left join fnb_order o on o.table_id = t.id and o.status in ('open', 'billed')
        where t.active and ($1::text is null or t.outlet_id = $1)
        order by t.outlet_id, length(t.label), t.label`, [outletId ?? null])
  })

  app.post('/api/fnb/tables', async (req, reply) => {
    const who = await need(ctx, req, 'menu.edit')
    const b = req.body as { outletId?: string; label?: string; seats?: number; section?: string }
    if (!/^[A-Za-z0-9 -]{1,10}$/.test(b?.label ?? '')) throw new HttpError(400, 'Table label: up to 10 letters or digits.')
    return db.tx(async (t) => {
      const [o] = await t.query('select 1 from outlet where id = $1', [b.outletId])
      if (!o) throw new HttpError(400, `No outlet ${b.outletId}.`)
      const id = `${b.outletId}-${b.label!.replace(/\s+/g, '')}`
      try {
        await t.query('insert into dining_table (id, outlet_id, label, seats, section) values ($1, $2, $3, $4, $5)', [id, b.outletId, b.label, b.seats ?? 4, b.section ?? null])
      } catch { throw new HttpError(409, `Table ${b.label} already exists.`) }
      await appendAudit(t, { actor: who, action: 'table.create', entity: { type: 'dining_table', id }, after: b }, now())
      return reply.status(201).send({ id })
    })
  })

  app.patch('/api/fnb/tables/:id', async (req) => {
    const who = await need(ctx, req, 'menu.edit')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { label?: string; seats?: number; section?: string | null; active?: boolean }
    if (b.label !== undefined && !/^[A-Za-z0-9 -]{1,10}$/.test(b.label)) throw new HttpError(400, 'Table label: up to 10 letters or digits.')
    if (b.seats !== undefined && !(Number.isInteger(b.seats) && b.seats >= 1 && b.seats <= 40)) throw new HttpError(400, 'Seats: 1–40.')
    return db.tx(async (t) => {
      const [before] = await t.query('select * from dining_table where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such table.')
      if (b.active === false) {
        const [open] = await t.query(`select 1 from fnb_order where table_id = $1 and status in ('open', 'billed')`, [id])
        if (open) throw new HttpError(409, 'This table has an open order.')
      }
      try {
        await t.query(`update dining_table set label = coalesce($2, label), seats = coalesce($3, seats), section = case when $4::boolean then $5 else section end,
                         active = coalesce($6, active) where id = $1`, [id, b.label ?? null, b.seats ?? null, b.section !== undefined, b.section ?? null, b.active ?? null])
      } catch { throw new HttpError(409, `Table ${b.label} already exists.`) }
      const [after] = await t.query('select * from dining_table where id = $1', [id])
      await appendAudit(t, { actor: who, action: b.active === false ? 'table.archive' : 'table.update', entity: { type: 'dining_table', id }, before, after }, now())
      return after
    })
  })

  // ---------- bar licence settings ----------
  app.get('/api/fnb/bar-settings', async (req) => {
    await requireCaller(ctx, req)
    const [p] = await db.query<{ bar_open: string | null; bar_close: string | null }>('select bar_open, bar_close from property limit 1')
    const dryDays = await db.query('select day::text, reason from dry_day order by day')
    let liquorNow: { allowed: boolean; reason: string | null }
    try { await checkLiquorAllowed(ctx, db); liquorNow = { allowed: true, reason: null } } catch (e) { liquorNow = { allowed: false, reason: (e as Error).message } }
    return { open: p.bar_open, close: p.bar_close, dryDays, liquorNow, legalAge: ctx.tax.liquor_controls.legal_age }
  })

  app.put('/api/fnb/bar-settings', async (req) => {
    const who = await need(ctx, req, 'bar.settings')
    const b = req.body as { open?: string; close?: string }
    if (b.open !== undefined && !HHMM.test(b.open)) throw new HttpError(400, 'Opening time as HH:MM (24-hour).')
    if (b.close !== undefined && !HHMM.test(b.close)) throw new HttpError(400, 'Closing time as HH:MM (24-hour).')
    return db.tx(async (t) => {
      const [before] = await t.query('select bar_open, bar_close from property limit 1')
      await t.query('update property set bar_open = coalesce($1, bar_open), bar_close = coalesce($2, bar_close)', [b.open ?? null, b.close ?? null])
      const [after] = await t.query('select bar_open, bar_close from property limit 1')
      await appendAudit(t, { actor: who, action: 'bar.settings', entity: { type: 'property', id: 'sathya' }, before, after }, now())
      return after
    })
  })

  app.post('/api/fnb/dry-days', async (req, reply) => {
    const who = await need(ctx, req, 'bar.settings')
    const b = req.body as { day?: string; reason?: string }
    if (!DATE.test(b?.day ?? '') || !b.reason?.trim()) throw new HttpError(400, 'Send day (YYYY-MM-DD) and reason.')
    await db.tx(async (t) => {
      await t.query('insert into dry_day (day, reason, added_by, added_at) values ($1, $2, $3, $4) on conflict (day) do update set reason = excluded.reason', [b.day, b.reason!.trim(), who.userId, now()])
      await appendAudit(t, { actor: who, action: 'dry_day.add', entity: { type: 'dry_day', id: b.day! }, after: { reason: b.reason } }, now())
    })
    return reply.status(201).send({ day: b.day })
  })

  app.delete('/api/fnb/dry-days/:day', async (req) => {
    const who = await need(ctx, req, 'bar.settings')
    const { day } = req.params as { day: string }
    return db.tx(async (t) => {
      const [d] = await t.query('delete from dry_day where day = $1 returning reason', [day])
      if (!d) throw new HttpError(404, 'Not a dry day.')
      await appendAudit(t, { actor: who, action: 'dry_day.remove', entity: { type: 'dry_day', id: day }, before: d }, now())
      return { ok: true }
    })
  })

  // ---------- orders ----------
  app.post('/api/fnb/orders', async (req, reply) => {
    const who = await need(ctx, req, 'fnb.order')
    const b = req.body as { id?: string; outletId?: string; tableId?: string; reservationId?: string; covers?: number; note?: string; kind?: string }
    return db.tx(async (t) => {
      const [o] = await t.query<{ id: string; kind: string }>('select id, kind from outlet where id = $1 and active', [b?.outletId])
      if (!o) throw new HttpError(400, `No outlet ${b?.outletId}.`)
      const kind = b.kind ?? (o.kind === 'room_service' ? 'room_service' : b.tableId ? 'dine_in' : 'takeaway')
      if (!['dine_in', 'room_service', 'takeaway'].includes(kind)) throw new HttpError(400, 'kind is dine_in, room_service or takeaway.')
      if (kind === 'dine_in') {
        const [tb] = await t.query('select 1 from dining_table where id = $1 and outlet_id = $2 and active', [b.tableId, b.outletId])
        if (!tb) throw new HttpError(400, 'Choose a table in this outlet.')
      }
      if (kind === 'room_service') {
        const [r] = await t.query<{ status: string }>('select status from reservation where id = $1', [b.reservationId])
        if (!r) throw new HttpError(400, 'Room service needs the guest\'s reservation.')
        if (r.status !== 'in_house') throw new HttpError(409, 'Room service is for guests who are checked in.')
      }
      if (b.covers !== undefined && !(Number.isInteger(b.covers) && b.covers >= 1 && b.covers <= 200)) throw new HttpError(400, 'Covers: 1–200.')
      const date = await businessDate(t)
      // Tablets that lost their connection make up the order id themselves, so items queued offline can follow it.
      if (b.id !== undefined && !/^ORD-[A-Z0-9-]{6,24}$/.test(b.id)) throw new HttpError(400, 'Order id looks like ORD-XXXXXXXX.')
      const id = b.id ?? newId('ORD')
      if (b.id) { const [dup] = await t.query('select 1 from fnb_order where id = $1', [b.id]); if (dup) throw new HttpError(409, 'That order id is already used.') }
      const number = await nextCounter(t, date, 'order')
      try {
        await t.query(
          `insert into fnb_order (id, number, outlet_id, kind, table_id, reservation_id, covers, business_date, opened_by, opened_at, note)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, number, b.outletId, kind, kind === 'dine_in' ? b.tableId : null, b.reservationId ?? null, b.covers ?? 1, date, who.userId, now(), b.note ?? null])
      } catch (e) {
        if (String((e as Error).message).includes('fnb_order_one_per_table')) throw new HttpError(409, 'This table already has an open order.')
        throw e
      }
      await appendAudit(t, { actor: who, action: 'order.open', entity: { type: 'fnb_order', id }, after: { number, outlet: b.outletId, kind, table: b.tableId ?? null, reservation: b.reservationId ?? null, covers: b.covers ?? 1 } }, now())
      return reply.status(201).send(await orderView(ctx, t, id))
    })
  })

  app.get('/api/fnb/orders', async (req) => {
    await requireCaller(ctx, req)
    const q = req.query as { outletId?: string; status?: string; date?: string }
    const statuses = q.status ? q.status.split(',') : ['open', 'billed']
    return db.query(
      `select o.id, o.number, o.outlet_id, ot.name as outlet, os.twin_id as outlet_twin_id, o.kind, o.table_id, tb.label as table_label, o.reservation_id,
              s.room_no, s.twin_id, g.name as guest, o.covers, o.status, o.business_date::text, o.opened_at, u.name as opened_by,
              coalesce((select json_agg(json_build_object('name', i.name, 'qty', i.qty, 'price', i.price_paise, 'status', i.status) order by i.added_at, i.seq)
                          from order_item i where i.order_id = o.id and i.status <> 'void'), '[]') as items,
              coalesce((select sum(i.price_paise * i.qty) from order_item i where i.order_id = o.id and i.status <> 'void'), 0)::bigint as subtotal_paise,
              (select count(*)::int from order_item i where i.order_id = o.id and i.status = 'pending') as pending_items,
              (select (array['new', 'cooking', 'ready'])[min(case k.status when 'new' then 1 when 'cooking' then 2 else 3 end)]
                 from kot k where k.order_id = o.id and k.status <> 'served') as kitchen,
              (select max(k.created_at) from kot k where k.order_id = o.id) as last_kot_at
         from fnb_order o join app_user u on u.id = o.opened_by join outlet ot on ot.id = o.outlet_id left join space os on os.id = ot.space_id
         left join dining_table tb on tb.id = o.table_id
         left join reservation r on r.id = o.reservation_id left join space s on s.id = r.space_id left join guest g on g.id = r.guest_id
        where o.status = any($1) and ($2::text is null or o.outlet_id = $2) and ($3::date is null or o.business_date = $3)
        order by o.opened_at`, [statuses, q.outletId ?? null, q.date ?? null])
  })

  app.get('/api/fnb/orders/:id', async (req) => {
    await requireCaller(ctx, req)
    return orderView(ctx, db, (req.params as { id: string }).id)
  })

  // Add items (not yet sent). Sold-out items are refused; liquor is checked against the licence hours and dry days.
  app.post('/api/fnb/orders/:id/items', async (req) => {
    const who = await need(ctx, req, 'fnb.order')
    const { id } = req.params as { id: string }
    const b = req.body as { items?: { itemId: string; qty?: number; note?: string; seat?: number; course?: number }[] }
    if (!Array.isArray(b?.items) || !b.items.length || b.items.length > 60) throw new HttpError(400, 'Send items: 1–60 lines.')
    return db.tx(async (t) => {
      const o = await loadOrder(t, id, true)
      openOnly(o)
      const [outlet] = await t.query<{ serves_liquor: boolean }>('select serves_liquor from outlet where id = $1', [o.outlet_id])
      let liquorChecked = false
      for (const line of b.items!) {
        const qty = line.qty ?? 1
        if (!(Number.isInteger(qty) && qty >= 1 && qty <= 99)) throw new HttpError(400, 'Quantity: 1–99.')
        if (line.note && line.note.length > 120) throw new HttpError(400, 'Keep instructions under 120 characters.')
        const [m] = await t.query<{ id: string; name: string; price_paise: number; liquor_class: string | null; station_id: string; available: boolean; active: boolean }>(
          'select id, name, price_paise, liquor_class, station_id, available, active from menu_item where id = $1 and outlet_id = $2', [line.itemId, o.outlet_id])
        if (!m || !m.active) throw new HttpError(400, `${line.itemId} is not on this outlet's menu.`)
        if (!m.available) throw new HttpError(409, `${m.name} is sold out.`)
        if (m.liquor_class) {
          if (!outlet.serves_liquor) throw new HttpError(409, 'This outlet does not serve liquor.')
          if (!liquorChecked) { await checkLiquorAllowed(ctx, t); liquorChecked = true }
        }
        await t.query(
          `insert into order_item (id, order_id, item_id, name, price_paise, liquor_class, station_id, qty, seat, course, note, added_by, added_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [newId('OI'), id, m.id, m.name, m.price_paise, m.liquor_class, m.station_id, qty, line.seat ?? null, line.course ?? 1, line.note?.trim() || null, who.userId, now()])
      }
      return orderView(ctx, t, id)
    })
  })

  // Fire the pending items: one ticket per station, KOT for kitchens and BOT for the bar.
  app.post('/api/fnb/orders/:id/send', async (req) => {
    const who = await need(ctx, req, 'fnb.order')
    const { id } = req.params as { id: string }
    return db.tx(async (t) => {
      const o = await loadOrder(t, id, true)
      openOnly(o)
      const pending = await t.query<{ id: string; name: string; qty: number; note: string | null; seat: number | null; course: number; station_id: string; price_paise: number; liquor_class: string | null; item_id: string }>(
        `select id, name, qty, note, seat, course, station_id, price_paise, liquor_class, item_id from order_item where order_id = $1 and status = 'pending' order by course, added_at, seq`, [id])
      if (!pending.length) throw new HttpError(409, 'Nothing new to send.')
      if (pending.some((p) => p.liquor_class)) await checkLiquorAllowed(ctx, t)
      const view = await orderView(ctx, t, id)
      const allergens = new Map((await t.query<{ id: string; allergens: string[]; jain: boolean }>('select id, allergens, jain from menu_item where id = any($1)', [pending.map((p) => p.item_id)])).map((m) => [m.id, m]))
      const stations = await t.query<{ id: string; kind: string; name: string }>('select id, kind, name from station order by kind desc, id')
      const tickets = []
      for (const st of stations.filter((s) => pending.some((p) => p.station_id === s.id))) {
        const kind = st.kind === 'bar' ? 'BOT' : 'KOT'
        const number = await nextCounter(t, o.business_date, kind)
        const kid = newId(kind)
        await t.query('insert into kot (id, number, kind, order_id, station_id, business_date, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)',
          [kid, number, kind, id, st.id, o.business_date, who.userId, now()])
        const lines = pending.filter((p) => p.station_id === st.id)
        await t.query(`update order_item set status = 'sent', kot_id = $2 where id = any($1)`, [lines.map((l) => l.id), kid])
        await pourStock(t, who, lines.map((l) => l.id), o.business_date, now())
        await consumeRecipes(t, who, lines.map((l) => l.id), o.business_date, now())
        const amount = lines.reduce((a, l) => a + l.price_paise * l.qty, 0)
        await appendAudit(t, { actor: who, action: kind === 'BOT' ? 'bot.create' : 'kot.create', entity: { type: 'kot', id: kid }, amount,
          after: { number, order: o.number, orderId: id, station: st.id, table: view.table_label ?? null, room: view.room_no ?? null, items: lines.map((l) => `${l.qty} × ${l.name}`) } }, now())
        tickets.push(ticket({ id: kid, number, kind, station_id: st.id, prints: 1 }, view, lines.map((l) => ({
          qty: l.qty, name: l.name, note: l.note, seat: l.seat, course: l.course,
          alert: [...(allergens.get(l.item_id)?.allergens ?? []).map((a) => a.toUpperCase()), ...(allergens.get(l.item_id)?.jain ? ['JAIN'] : [])],
        }))))
      }
      await queueTickets(t, tickets, now())
      return { order: await orderView(ctx, t, id), tickets }
    })
  })

  app.post('/api/fnb/orders/:id/move', async (req) => {
    const who = await need(ctx, req, 'fnb.order')
    const { id } = req.params as { id: string }
    const { tableId } = req.body as { tableId?: string }
    return db.tx(async (t) => {
      const o = await loadOrder(t, id, true)
      if (o.kind !== 'dine_in') throw new HttpError(409, 'Only table orders can move tables.')
      if (!['open', 'billed'].includes(o.status)) throw new HttpError(409, `Order ${o.number} is ${o.status}.`)
      const [tb] = await t.query<{ label: string }>('select label from dining_table where id = $1 and outlet_id = $2 and active', [tableId, o.outlet_id])
      if (!tb) throw new HttpError(400, 'Choose a table in this outlet.')
      try { await t.query('update fnb_order set table_id = $2 where id = $1', [id, tableId]) } catch { throw new HttpError(409, `Table ${tb.label} already has an open order.`) }
      await appendAudit(t, { actor: who, action: 'order.move_table', entity: { type: 'fnb_order', id }, before: { table: o.table_id }, after: { table: tableId } }, now())
      return orderView(ctx, t, id)
    })
  })

  app.post('/api/fnb/orders/:id/cancel', async (req) => {
    const who = await need(ctx, req, 'fnb.order')
    const { id } = req.params as { id: string }
    const reason = ((req.body as { reason?: string })?.reason ?? '').trim()
    return db.tx(async (t) => {
      const o = await loadOrder(t, id, true)
      openOnly(o)
      const [sent] = await t.query(`select 1 from order_item where order_id = $1 and status = 'sent'`, [id])
      if (sent) throw new HttpError(409, 'Items have gone to the kitchen. Cancel them one by one (a manager must approve).')
      await t.query(`update order_item set status = 'void', void_reason = 'Order cancelled', voided_by = $2, voided_at = $3 where order_id = $1 and status = 'pending'`, [id, who.userId, now()])
      await t.query(`update fnb_order set status = 'cancelled', closed_at = $2 where id = $1`, [id, now()])
      await appendAudit(t, { actor: who, action: 'order.cancel', entity: { type: 'fnb_order', id }, after: { number: o.number }, note: reason || undefined }, now())
      return { ok: true }
    })
  })

  // Remove an item. Before its ticket is sent anyone taking orders may; afterwards it needs a reason and a manager,
  // either the caller (fnb.void) or through the approval inbox. Either way the MD sees it in God Mode.
  app.post('/api/fnb/order-items/:id/void', async (req, reply) => {
    const who = await need(ctx, req, 'fnb.order', 'fnb.void')
    const { id } = req.params as { id: string }
    const reason = ((req.body as { reason?: string })?.reason ?? '').trim()
    return db.tx(async (t) => {
      const [i] = await t.query<{ order_id: string; status: string; name: string; qty: number; price_paise: number }>('select order_id, status, name, qty, price_paise from order_item where id = $1 for update', [id])
      if (!i) throw new HttpError(404, 'No such item.')
      const o = await loadOrder(t, i.order_id)
      openOnly(o)
      if (i.status === 'void') throw new HttpError(409, 'Already cancelled.')
      if (i.status === 'pending') {
        await t.query(`update order_item set status = 'void', void_reason = $2, voided_by = $3, voided_at = $4 where id = $1`, [id, reason || 'Removed before sending', who.userId, now()])
        await appendAudit(t, { actor: who, action: 'order_item.remove', entity: { type: 'fnb_order', id: i.order_id }, after: { item: i.name, qty: i.qty } }, now())
        return { voided: true }
      }
      if (reason.length < 3) throw new HttpError(400, 'Give a reason for cancelling an item the kitchen already has.')
      if (can(who, 'fnb.void')) { await voidSentItem(ctx, t, who, id, reason); return { voided: true } }
      const approvalId = await createApproval(ctx, t, 'fnb.void_after_kot', who.userId,
        { itemId: id, orderId: i.order_id, order: o.number, item: i.name, qty: i.qty, amount: i.price_paise * i.qty, reason, requestedBy: who.userId }, reason)
      await appendAudit(t, { actor: who, action: 'order_item.void_requested', entity: { type: 'fnb_order', id: i.order_id }, amount: i.price_paise * i.qty, after: { item: i.name, qty: i.qty }, note: reason }, now())
      return reply.status(202).send({ pending: true, approvalId })
    })
  })

  // ---------- kitchen and bar screens ----------
  app.get('/api/fnb/kds', async (req) => {
    await need(ctx, req, 'kitchen', 'fnb.order')
    const { stationId } = req.query as { stationId?: string }
    const kots = await db.query<{ id: string; status: string; created_at: Date }>(
      `select k.id, k.number, k.kind, k.station_id, k.status, k.prints, k.created_at, k.ready_at, o.number as order_number, o.kind as order_kind,
              tb.label as table_label, s.room_no, ot.name as outlet, o.covers, o.status as order_status
         from kot k join fnb_order o on o.id = k.order_id join outlet ot on ot.id = o.outlet_id
         left join dining_table tb on tb.id = o.table_id left join reservation r on r.id = o.reservation_id left join space s on s.id = r.space_id
        where k.status <> 'served' and ($1::text is null or k.station_id = $1)
          -- a ticket with every item cancelled has nothing to make; a paid order's tickets leave the screen after 3 hours
          and exists (select 1 from order_item i where i.kot_id = k.id and i.status <> 'void')
          and (o.status in ('open', 'billed') or k.created_at > $2)
        order by k.created_at`, [stationId ?? null, new Date(now().getTime() - 3 * 3600_000)])
    const lines = kots.length ? await db.query<{ kot_id: string }>(
      `select i.kot_id, i.id, i.name, i.qty, i.note, i.seat, i.course, i.status, i.void_reason, m.allergens, m.jain
         from order_item i join menu_item m on m.id = i.item_id where i.kot_id = any($1) order by i.course, i.added_at, i.seq`, [kots.map((k) => k.id)]) : []
    const t = now().getTime()
    const tickets = kots.map((k) => ({ ...k, ageMinutes: Math.floor((t - new Date(k.created_at).getTime()) / 60_000), lines: lines.filter((l) => l.kot_id === k.id) }))
    // All-day counts: how many of each dish the station still has to make.
    const allDay = new Map<string, number>()
    for (const tk of tickets) if (tk.status !== 'ready') for (const l of tk.lines as unknown as { name: string; qty: number; status: string }[]) if (l.status !== 'void') allDay.set(l.name, (allDay.get(l.name) ?? 0) + l.qty)
    return { tickets, allDay: [...allDay].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty) }
  })

  app.post('/api/fnb/kots/:id/status', async (req) => {
    const { id } = req.params as { id: string }
    const status = (req.body as { status?: string })?.status
    if (!['cooking', 'ready', 'served'].includes(status ?? '')) throw new HttpError(400, 'status is cooking, ready or served.')
    // The kitchen cooks and bumps; the captain or room-service steward marks it served (delivered).
    const who = await need(ctx, req, ...(status === 'served' ? ['fnb.order', 'kitchen'] : ['kitchen']))
    return db.tx(async (t) => {
      const [k] = await t.query<{ status: string; number: number; kind: string; order_id: string }>('select status, number, kind, order_id from kot where id = $1 for update', [id])
      if (!k) throw new HttpError(404, 'No such ticket.')
      const order = ['new', 'cooking', 'ready', 'served']
      // Recall: the kitchen may take a bumped ticket back from ready to cooking.
      if (order.indexOf(status!) <= order.indexOf(k.status) && !(k.status === 'ready' && status === 'cooking')) throw new HttpError(409, `${k.kind} ${k.number} is already ${k.status}.`)
      await t.query(`update kot set status = $2, ready_at = case when $2 = 'ready' then $3 when $2 = 'cooking' then null else ready_at end,
                       served_at = case when $2 = 'served' then $3 else served_at end where id = $1`, [id, status, now()])
      await appendAudit(t, { actor: who, action: `kot.${status}`, entity: { type: 'kot', id }, after: { number: k.number, kind: k.kind, orderId: k.order_id } }, now())
      return { id, status }
    })
  })

  // Reprints are marked COPY and counted; the MD is alerted beyond the allowed count.
  app.post('/api/fnb/kots/:id/reprint', async (req) => {
    const who = await need(ctx, req, 'fnb.order', 'kitchen')
    const { id } = req.params as { id: string }
    return db.tx(async (t) => {
      const [k] = await t.query<{ id: string; number: number; kind: string; station_id: string; prints: number; order_id: string }>(
        'update kot set prints = prints + 1 where id = $1 returning id, number, kind, station_id, prints, order_id', [id])
      if (!k) throw new HttpError(404, 'No such ticket.')
      await appendAudit(t, { actor: who, action: 'kot.reprint', entity: { type: 'kot', id }, after: { number: k.number, kind: k.kind, prints: k.prints } }, now())
      const view = await orderView(ctx, t, k.order_id)
      const lines = (view.items as unknown as { kot_id: string; qty: number; name: string; note: string | null; seat: number | null; course: number; status: string }[])
        .filter((i) => i.kot_id === id).map((i) => ({ qty: i.qty, name: i.name, note: i.note, seat: i.seat, course: i.course, void: i.status === 'void' }))
      const tk = ticket(k, view, lines)
      await queueTickets(t, [tk], now())
      return tk
    })
  })
}

