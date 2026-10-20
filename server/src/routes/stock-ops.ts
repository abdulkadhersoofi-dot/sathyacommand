import type { FastifyInstance, FastifyRequest } from 'fastify'
import { financialYear, splitGst } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { istDay, newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { nextSeriesNumber } from '../invoicing'
import { qrLabelsPage } from '../qr-labels'
import { avgCost, moveStock, stockOf, storeLedger, takeFromBatches, type StockItem } from '../stock'
import { createApproval, registerApprovalKind, roleLimit } from './approvals'
import { requireCaller } from './auth'

// Store operations: what is in each store and what it is worth (weighted average), opening stock, issues
// to departments and transfers between stores (first to expire, first out), physical counts whose
// variance is approved before the book changes, the breakage register, expired write-offs and labels.

export const DEPARTMENTS = ['rooms', 'kitchen', 'restaurant', 'bar', 'banquets', 'front_office', 'engineering', 'garden', 'staff_canteen', 'admin', 'other']
type ItemRow = StockItem & { name: string; unit: string; purchase_unit: string; purchase_factor: string; par_level: string | null; category: string; last_cost_paise: string | null }

async function item(t: Db, id: string) {
  const [i] = await t.query<ItemRow>('select * from item where id = $1', [id])
  if (!i) throw new HttpError(404, 'No such item.')
  return i
}
async function ownStore(t: Db, id: string | undefined) {
  if (!id) throw new HttpError(400, 'Choose the store.')
  const ledger = await storeLedger(t, id)
  if (!ledger) throw new HttpError(404, 'No such store.')
  if (ledger !== 'own') throw new HttpError(409, 'This store keeps its stock in its department\'s book: count and issue it there.')
}

interface CountLine { itemId: string; book: number; counted: number; avg: number; variance: number; item: ItemRow }

/** Writes a count's differences into the book. */
async function applyCount(t: Db, countId: string, who: Caller, now: Date) {
  const [c] = await t.query<{ store_id: string; number: string; business_date: string }>('select store_id, number, business_date::text from stock_count where id = $1', [countId])
  const lines = await t.query<{ item_id: string; book_qty: string; counted_qty: string; avg_cost_paise: string; variance_paise: string }>('select * from stock_count_line where count_id = $1', [countId])
  for (const l of lines) {
    // The book may have moved since the count: adjust to what was counted, from the book as it is now.
    const i = await item(t, l.item_id)
    const diff = Number(l.counted_qty) - (await stockOf(t, i, c.store_id))
    if (Math.abs(diff) < 0.0005) continue
    await moveStock(t, { item: i, storeId: c.store_id, kind: 'count_adjust', qty: diff, value: Math.round(diff * Number(l.avg_cost_paise)), ref: c.number, note: 'Physical count', userId: who.userId, at: now, day: c.business_date })
    if (diff < 0) await takeFromBatches(t, i.id, c.store_id, -diff)
  }
  await t.query(`update stock_count set status = 'applied', decided_by = coalesce(decided_by, $2), decided_at = coalesce(decided_at, $3) where id = $1`, [countId, who.userId, now])
}

registerApprovalKind('stock.count', {
  permission: 'stock.approve',
  async apply(t, p, decider, ctx) {
    const [c] = await t.query<{ status: string }>('select status from stock_count where id = $1 for update', [p.countId])
    if (c?.status !== 'pending_approval') throw new HttpError(409, 'This count is no longer waiting for approval.')
    await t.query('update stock_count set decided_by = $2, decided_at = $3 where id = $1', [p.countId, decider.userId, ctx.now()])
    await applyCount(t, String(p.countId), decider, ctx.now())
  },
  async reject(t, p, decider, ctx) {
    await t.query(`update stock_count set status = 'rejected', decided_by = $2, decided_at = $3 where id = $1 and status = 'pending_approval'`, [p.countId, decider.userId, ctx.now()])
  },
})

export function stockOpsRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }

  // ---------- what is in a store ----------
  app.get('/api/stock', async (req) => {
    await need(req, 'stores.view', 'stores.issue', 'stores.count', 'stores.receive')
    const storeId = (req.query as { storeId?: string }).storeId ?? 'ST-MAIN'
    const ledger = await storeLedger(db, storeId)
    if (!ledger) throw new HttpError(404, 'No such store.')
    const items = await db.query<ItemRow & { barcode: string | null }>(
      `select * from item i where i.active and (i.default_store_id = $1 or ($2 and exists (select 1 from stock_move m where m.item_id = i.id and m.store_id = $1))) order by i.category, i.name`, [storeId, ledger === 'own'])
    const out = []
    for (const i of items) {
      const stock = await stockOf(db, i, storeId)
      const avg = await avgCost(db, i, storeId)
      const [exp] = ledger === 'own' ? await db.query<{ e: string | null }>('select min(expiry)::text as e from stock_batch where item_id = $1 and store_id = $2 and qty_left > 0', [i.id, storeId]) : [{ e: null }]
      out.push({ itemId: i.id, item: i.name, category: i.category, unit: i.unit, purchaseUnit: i.purchase_unit, factor: Number(i.purchase_factor), barcode: i.barcode, stock, avgCostPaise: avg,
        valuePaise: Math.round(Math.max(0, stock) * avg), par: i.par_level == null ? null : Number(i.par_level), low: i.par_level != null && stock < Number(i.par_level), nextExpiry: exp.e })
    }
    return { storeId, ledger, items: out, valuePaise: out.reduce((a, x) => a + x.valuePaise, 0) }
  })

  app.get('/api/stock/moves', async (req) => {
    await need(req, 'stores.view', 'stores.issue', 'stores.count')
    const q = req.query as { storeId?: string; itemId?: string }
    return db.query(`select m.*, m.business_date::text, i.name as item, i.unit, u.name as by from stock_move m join item i on i.id = m.item_id join app_user u on u.id = m.by_user
                      where ($1::text is null or m.store_id = $1) and ($2::text is null or m.item_id = $2) order by m.at desc limit 300`, [q.storeId ?? null, q.itemId ?? null])
  })

  // ---------- opening stock ----------
  app.post('/api/stock/opening', async (req, reply) => {
    const who = await need(req, 'stores.manage')
    const b = (req.body ?? {}) as { storeId?: string; lines?: { itemId: string; qty: number; rate: number }[] }
    if (!b.lines?.length) throw new HttpError(400, 'Enter the opening quantities.')
    return db.tx(async (t) => {
      await ownStore(t, b.storeId)
      const day = await businessDate(t)
      let value = 0
      for (const l of b.lines!) {
        const i = await item(t, l.itemId)
        const [moved] = await t.query('select 1 from stock_move where item_id = $1 and store_id = $2 limit 1', [i.id, b.storeId])
        if (moved) throw new HttpError(409, `${i.name} already has stock movements here: use a count to correct it.`)
        if (!(Number(l.qty) >= 0) || !(Number(l.rate) >= 0)) throw new HttpError(400, `${i.name}: quantity and rate per ${i.purchase_unit}.`)
        const v = Math.round(Number(l.qty) * Number(l.rate) * 100)
        await moveStock(t, { item: i, storeId: b.storeId!, kind: 'opening', qty: Number(l.qty) * Number(i.purchase_factor), value: v, ref: 'Opening', userId: who.userId, at: now(), day })
        await t.query('update item set last_cost_paise = coalesce(last_cost_paise, $2) where id = $1', [i.id, (Number(l.rate) * 100) / Number(i.purchase_factor)])
        value += v
      }
      await appendAudit(t, { actor: who, action: 'stock.opening', entity: { type: 'store', id: b.storeId! }, amount: value, after: { lines: b.lines!.length } }, now())
      return reply.status(201).send({ ok: true, valuePaise: value })
    })
  })

  // ---------- issues and transfers ----------
  app.post('/api/stock/issue', async (req, reply) => {
    const who = await need(req, 'stores.issue')
    const b = (req.body ?? {}) as { fromStoreId?: string; toStoreId?: string; department?: string; indentId?: string; note?: string; lines?: { itemId: string; qty: number }[] }
    if (!b.lines?.length) throw new HttpError(400, 'What is being issued?')
    if (!b.toStoreId && !DEPARTMENTS.includes(b.department ?? '')) throw new HttpError(400, 'Issue to a store, or to a department that uses it up.')
    if (b.toStoreId && b.toStoreId === b.fromStoreId) throw new HttpError(400, 'Choose a different store to transfer to.')
    return db.tx(async (t) => {
      await ownStore(t, b.fromStoreId)
      if (b.toStoreId && !(await storeLedger(t, b.toStoreId))) throw new HttpError(404, 'No such store to transfer to.')
      let indentLines: { line: number; item_id: string; qty: string; issued_qty: string; po_id: string | null }[] = []
      if (b.indentId) {
        const [n] = await t.query<{ status: string; store_id: string }>('select status, store_id from indent where id = $1 for update', [b.indentId])
        if (!n || !['approved', 'ordered'].includes(n.status)) throw new HttpError(409, 'Issue only against an approved indent.')
        if (b.toStoreId && b.toStoreId !== n.store_id) throw new HttpError(400, 'The indent asks for goods in a different store.')
        indentLines = await t.query('select line, item_id, qty, issued_qty, po_id from indent_line where indent_id = $1 for update', [b.indentId])
      }
      const day = await businessDate(t)
      const id = newId('IS'), number = await nextSeriesNumber(t, 'stock_issue', financialYear(istDay(now())), 'ISS')
      await t.query('insert into stock_issue (id, number, from_store_id, to_store_id, department, indent_id, note, business_date, issued_by, issued_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, number, b.fromStoreId, b.toStoreId ?? null, b.toStoreId ? null : b.department, b.indentId ?? null, b.note?.trim() || null, day, who.userId, now()])
      let n = 0, total = 0
      for (const l of b.lines!) {
        const i = await item(t, l.itemId)
        const qty = Number(l.qty) * Number(i.purchase_factor)
        if (!(qty > 0)) throw new HttpError(400, `How much ${i.name}?`)
        const stock = await stockOf(t, i, b.fromStoreId!)
        if (stock + 0.0005 < qty) throw new HttpError(409, `Only ${Number((stock / Number(i.purchase_factor)).toFixed(3))} ${i.purchase_unit} of ${i.name} in the store.`)
        const value = Math.round(qty * (await avgCost(t, i, b.fromStoreId!)))
        await moveStock(t, { item: i, storeId: b.fromStoreId!, kind: b.toStoreId ? 'transfer_out' : 'issue', qty: -qty, value: -value, ref: number, note: b.toStoreId ? null : b.department, userId: who.userId, at: now(), day })
        await takeFromBatches(t, i.id, b.fromStoreId!, qty)
        if (b.toStoreId) await moveStock(t, { item: i, storeId: b.toStoreId, kind: 'transfer_in', qty, value, ref: number, note: `From store ${number}`, userId: who.userId, at: now(), day })
        await t.query('insert into stock_issue_line (issue_id, line, item_id, qty, value_paise) values ($1,$2,$3,$4,$5)', [id, ++n, i.id, qty, value])
        total += value
        // Count it against the indent's lines for this item.
        let left = qty
        for (const il of indentLines.filter((x) => x.item_id === i.id)) {
          const open = Number(il.qty) - Number(il.issued_qty)
          const take = Math.min(left, open); if (take <= 0) continue
          await t.query('update indent_line set issued_qty = issued_qty + $3 where indent_id = $1 and line = $2', [b.indentId, il.line, take])
          il.issued_qty = String(Number(il.issued_qty) + take); left -= take
        }
      }
      await t.query('update stock_issue set value_paise = $2 where id = $1', [id, total])
      if (b.indentId && indentLines.every((il) => il.po_id || Number(il.issued_qty) >= Number(il.qty) - 0.0005)) await t.query(`update indent set status = 'issued' where id = $1`, [b.indentId])
      await appendAudit(t, { actor: who, action: b.toStoreId ? 'stock.transfer' : 'stock.issue', entity: { type: 'stock_issue', id }, amount: total,
        after: { number, from: b.fromStoreId, to: b.toStoreId ?? b.department, lines: n } }, now())
      return reply.status(201).send({ id, number, valuePaise: total })
    })
  })

  app.get('/api/stock/issues', async (req) => {
    await need(req, 'stores.view', 'stores.issue')
    const rows = await db.query<{ id: string }>(
      `select s.*, s.business_date::text, f.name as from_store, t.name as to_store, n.number as indent, u.name as issued_by_name
         from stock_issue s join store f on f.id = s.from_store_id left join store t on t.id = s.to_store_id left join indent n on n.id = s.indent_id join app_user u on u.id = s.issued_by
        order by s.issued_at desc, s.number desc limit 200`)
    const lines = rows.length ? await db.query<{ issue_id: string }>('select l.*, i.name as item, i.unit, i.purchase_unit, i.purchase_factor from stock_issue_line l join item i on i.id = l.item_id where l.issue_id = any($1) order by l.line', [rows.map((r) => r.id)]) : []
    return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.issue_id === r.id) }))
  })

  // ---------- physical counts ----------
  app.post('/api/stock/counts', async (req, reply) => {
    const who = await need(req, 'stores.count')
    const b = (req.body ?? {}) as { storeId?: string; note?: string; lines?: { itemId: string; counted: number }[] }
    if (!b.lines?.length) throw new HttpError(400, 'Enter what was counted.')
    return db.tx(async (t) => {
      await ownStore(t, b.storeId)
      const day = await businessDate(t)
      const lines: CountLine[] = []
      for (const l of b.lines!) {
        const i = await item(t, l.itemId)
        if (!(Number(l.counted) >= 0)) throw new HttpError(400, `${i.name}: the quantity counted.`)
        if (lines.some((x) => x.itemId === i.id)) throw new HttpError(400, `${i.name} is counted twice.`)
        const book = await stockOf(t, i, b.storeId!), avg = await avgCost(t, i, b.storeId!)
        lines.push({ itemId: i.id, item: i, book, counted: Number(l.counted), avg, variance: Math.round((Number(l.counted) - book) * avg) })
      }
      const net = lines.reduce((a, l) => a + l.variance, 0), abs = lines.reduce((a, l) => a + Math.abs(l.variance), 0)
      const bookValue = Math.round(lines.reduce((a, l) => a + Math.max(0, l.book) * l.avg, 0))
      const id = newId('CT'), number = await nextSeriesNumber(t, 'stock_count', financialYear(istDay(now())), 'CNT')
      await t.query('insert into stock_count (id, number, store_id, business_date, status, variance_value_paise, variance_abs_paise, book_value_paise, note, counted_by, counted_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [id, number, b.storeId, day, 'pending_approval', net, abs, bookValue, b.note?.trim() || null, who.userId, now()])
      for (const l of lines) await t.query('insert into stock_count_line (count_id, item_id, book_qty, counted_qty, avg_cost_paise, variance_paise) values ($1,$2,$3,$4,$5,$6)', [id, l.itemId, l.book, l.counted, l.avg.toFixed(4), l.variance])
      // Within the counter's own adjustment limit (stores: none) the book is corrected at once; otherwise the GM approves.
      let status = 'applied', approvalId: string | null = null
      if (abs === 0 || can(who, 'stock.approve') || abs <= (await roleLimit(t, who, 'stock_adjustment')) * 100) await applyCount(t, id, who, now())
      else {
        status = 'pending_approval'
        approvalId = await createApproval(ctx, t, 'stock.count', who.userId, { countId: id, number, net, abs }, `${number}: variance ₹${(net / 100).toLocaleString('en-IN')}`)
        await t.query('update stock_count set approval_id = $2 where id = $1', [id, approvalId])
      }
      await appendAudit(t, { actor: who, action: 'stock.count', entity: { type: 'stock_count', id }, amount: net, after: { number, store: b.storeId, lines: lines.length, abs, status } }, now())
      return reply.status(201).send({ id, number, status, approvalId, varianceValuePaise: net, varianceAbsPaise: abs })
    })
  })

  app.get('/api/stock/counts', async (req) => {
    await need(req, 'stores.view', 'stores.count', 'stock.approve')
    const rows = await db.query<{ id: string }>(
      `select c.*, c.business_date::text, s.name as store, u.name as counted_by_name, d.name as decided_by_name from stock_count c join store s on s.id = c.store_id join app_user u on u.id = c.counted_by
         left join app_user d on d.id = c.decided_by order by c.counted_at desc, c.number desc limit 100`)
    const lines = rows.length ? await db.query<{ count_id: string }>('select l.*, i.name as item, i.unit, i.purchase_unit, i.purchase_factor from stock_count_line l join item i on i.id = l.item_id where l.count_id = any($1) order by l.variance_paise', [rows.map((r) => r.id)]) : []
    return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.count_id === r.id) }))
  })

  // ---------- breakage ----------
  app.post('/api/stock/breakage', async (req, reply) => {
    const who = await need(req, 'stores.breakage')
    const b = (req.body ?? {}) as { storeId?: string; itemId?: string; qty?: number; department?: string; chargeTo?: string; reservationId?: string; staffName?: string; charge?: number; note?: string; photoId?: string }
    if (!DEPARTMENTS.includes(b.department ?? '')) throw new HttpError(400, 'Which department was it in?')
    if (!['house', 'guest', 'staff'].includes(b.chargeTo ?? '')) throw new HttpError(400, 'Who bears it: the house, the guest or a member of staff.')
    if (b.chargeTo === 'staff' && !b.staffName?.trim()) throw new HttpError(400, 'Name the member of staff.')
    return db.tx(async (t) => {
      await ownStore(t, b.storeId)
      const i = await item(t, b.itemId!)
      const qty = Number(b.qty)
      if (!(qty > 0)) throw new HttpError(400, 'How many broke?')
      const stock = await stockOf(t, i, b.storeId!)
      if (stock + 0.0005 < qty) throw new HttpError(409, `Only ${stock} ${i.unit} of ${i.name} in the book.`)
      const day = await businessDate(t)
      const value = Math.round(qty * (await avgCost(t, i, b.storeId!)))
      const id = newId('BK')
      let charged = 0
      if (b.chargeTo === 'guest') {
        const [r] = await t.query<{ folio_id: string | null; room_no: string | null }>(
          `select (select f.id from folio f where f.reservation_id = r.id and f.status = 'open' order by f.created_at limit 1) as folio_id, s.room_no from reservation r left join space s on s.id = r.space_id where r.id = $1 and r.status = 'in_house'`, [b.reservationId])
        if (!r?.folio_id) throw new HttpError(409, 'Choose a guest who is staying (their bill is open).')
        if (!(Number(b.charge) > 0)) throw new HttpError(400, 'How much to charge the guest (before GST)?')
        const svc = (ctx.tax.gst.other_services as Record<string, { rate: number | null; sac?: string | null }> | undefined)?.damage_recovery
        const g = splitGst(Math.round(Number(b.charge) * 100), svc?.rate ?? 18)
        await t.query(
          `insert into folio_line (id, folio_id, business_date, posted_at, kind, description, sac, gst_rate, taxable_paise, cgst_paise, sgst_paise, amount_paise, posted_by, ref)
           values ($1,$2,$3,$4,'misc',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [newId('L'), r.folio_id, day, now(), `Breakage · ${qty} × ${i.name}`, svc?.sac ?? '999794', svc?.rate ?? 18, g.taxable, g.cgst, g.sgst, g.total, who.userId, id])
        charged = g.total
      }
      await moveStock(t, { item: i, storeId: b.storeId!, kind: 'breakage', qty: -qty, value: -value, ref: id, note: `${b.department}: ${b.note ?? ''}`.trim(), userId: who.userId, at: now(), day })
      await takeFromBatches(t, i.id, b.storeId!, qty)
      await t.query(`insert into breakage (id, store_id, item_id, qty, value_paise, department, charge_to, reservation_id, staff_name, charged_paise, note, photo_id, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, b.storeId, i.id, qty, value, b.department, b.chargeTo, b.chargeTo === 'guest' ? b.reservationId : null, b.chargeTo === 'staff' ? b.staffName!.trim() : null, charged, b.note?.trim() || null, b.photoId ?? null, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'stock.breakage', entity: { type: 'breakage', id }, amount: value, after: { item: i.name, qty, department: b.department, chargeTo: b.chargeTo, charged } }, now())
      return reply.status(201).send({ id, valuePaise: value, chargedPaise: charged })
    })
  })

  // Guests staying now, to charge a breakage to their bill.
  app.get('/api/stock/in-house', async (req) => {
    await need(req, 'stores.breakage')
    return db.query(`select r.id, g.name, s.room_no, r.status from reservation r join guest g on g.id = r.guest_id left join space s on s.id = r.space_id where r.status = 'in_house' order by s.room_no`)
  })

  app.get('/api/stock/breakage', async (req) => {
    await need(req, 'stores.view', 'stores.breakage')
    const days = Math.min(366, Number((req.query as { days?: string }).days ?? 30))
    return db.query(
      `select b.*, i.name as item, i.unit, s.name as store, u.name as by, g.name as guest from breakage b join item i on i.id = b.item_id join store s on s.id = b.store_id join app_user u on u.id = b.by_user
         left join reservation r on r.id = b.reservation_id left join guest g on g.id = r.guest_id where b.at >= $1 order by b.at desc`, [new Date(now().getTime() - days * 86_400_000)])
  })

  // ---------- expired stock ----------
  app.post('/api/stock/batches/:id/expire', async (req) => {
    const who = await need(req, 'stores.issue')
    const { id } = req.params as { id: string }
    return db.tx(async (t) => {
      const [bt] = await t.query<{ item_id: string; store_id: string; qty_left: string; expiry: string | null; batch_no: string | null }>('select item_id, store_id, qty_left, expiry::text, batch_no from stock_batch where id = $1 for update', [id])
      if (!bt || Number(bt.qty_left) <= 0) throw new HttpError(404, 'Nothing left in that batch.')
      const i = await item(t, bt.item_id)
      const qty = Math.min(Number(bt.qty_left), await stockOf(t, i, bt.store_id))
      const value = Math.round(qty * (await avgCost(t, i, bt.store_id)))
      if (qty > 0) await moveStock(t, { item: i, storeId: bt.store_id, kind: 'expired', qty: -qty, value: -value, ref: id, note: `Expired ${bt.expiry ?? ''}${bt.batch_no ? ` batch ${bt.batch_no}` : ''}`, userId: who.userId, at: now(), day: await businessDate(t) })
      await t.query('update stock_batch set qty_left = 0 where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'stock.expired', entity: { type: 'stock_batch', id }, amount: value, after: { item: i.name, qty } }, now())
      return { ok: true, valuePaise: value }
    })
  })

  // ---------- labels and scanning ----------
  app.get('/api/items/labels', async (req, reply) => {
    await need(req, 'stores.manage', 'stores.issue', 'stores.count')
    const q = req.query as { storeId?: string; ids?: string }
    const ids = q.ids ? q.ids.split(',') : null
    const items = await db.query<{ id: string; name: string; barcode: string | null; purchase_unit: string }>(
      `select id, name, barcode, purchase_unit from item where active and ($1::text[] is null or id = any($1)) and ($2::text is null or default_store_id = $2) order by name`, [ids, q.storeId ?? null])
    return reply.type('text/html; charset=utf-8').send(qrLabelsPage('Item labels', 'Scan to count or issue', items.map((i) => ({ name: `${i.name} (${i.purchase_unit})`, code: i.barcode ?? i.id }))))
  })

  app.get('/api/items/by-code/:code', async (req) => {
    await need(req, 'stores.view', 'stores.issue', 'stores.count', 'stores.receive')
    const code = (req.params as { code: string }).code.trim()
    const [i] = await db.query('select * from item where barcode = $1 or id = $1', [code])
    if (!i) throw new HttpError(404, 'No item with that code.')
    return i
  })
}
