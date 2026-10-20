import type { FastifyInstance, FastifyRequest } from 'fastify'
import { financialYear, inWords } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { istDay, newId } from '../eng-core'
import { nextSeriesNumber } from '../invoicing'
import { stockOf } from '../stock'
import { createApproval, registerApprovalKind, roleLimit } from './approvals'
import { requireCaller } from './auth'

// Indents (a department asks for goods), purchase orders (numbered per financial year, per vendor, GST
// worked out line by line) approved within each role's limit, the printed PO, and the market list:
// what is below its reorder level, at the best current rate, turned into POs in one step.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const HOME_STATE = '33'

interface ItemRow { id: string; name: string; category: string; unit: string; purchase_unit: string; purchase_factor: string; gst_rate: string | null; default_store_id: string | null
  par_level: string | null; reorder_qty: string | null; perishable: boolean; ingredient_id: string | null; brand_id: string | null; spare_id: string | null; linen_item_id: string | null }

async function approvePo(t: Db, poId: string, who: Caller, now: Date) {
  await t.query(`update purchase_order set status = 'approved', approved_by = $2, approved_at = $3 where id = $1`, [poId, who.userId, now])
}

registerApprovalKind('purchase.po', {
  permission: 'purchase.approve',
  async apply(t, p, decider, ctx) {
    const [po] = await t.query<{ status: string; total_paise: string; number: string }>('select status, total_paise, number from purchase_order where id = $1 for update', [p.poId])
    if (!po || po.status !== 'pending_approval') throw new HttpError(409, 'This purchase order is no longer waiting for approval.')
    if (Number(po.total_paise) > (await roleLimit(t, decider, 'purchase_order')) * 100) throw new HttpError(403, `${po.number} is above your own purchase limit: the MD approves it.`)
    await approvePo(t, String(p.poId), decider, ctx.now())
  },
  async reject(t, p) {
    await t.query(`update purchase_order set status = 'draft', approval_id = null where id = $1 and status = 'pending_approval'`, [p.poId])
  },
})

export function purchaseRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const item = async (t: Db, id: string) => {
    const [i] = await t.query<ItemRow>('select * from item where id = $1 and active', [id])
    if (!i) throw new HttpError(404, 'No such item (or it is no longer in use).')
    return i
  }
  /** The vendor's rate for an item today, else null. */
  const rateOf = async (t: Db, vendorId: string, itemId: string) =>
    (await t.query<{ rate_paise: string }>('select rate_paise from rate_contract where vendor_id = $1 and item_id = $2 and $3::date between valid_from and valid_to', [vendorId, itemId, istDay(now())]))[0]?.rate_paise ?? null
  /** The cheapest current rate for an item, with its vendor. */
  const bestRate = async (t: Db, itemId: string) =>
    (await t.query<{ vendor_id: string; vendor: string; rate_paise: string }>(
      `select rc.vendor_id, v.name as vendor, rc.rate_paise from rate_contract rc join vendor v on v.id = rc.vendor_id
        where rc.item_id = $1 and v.active and $2::date between rc.valid_from and rc.valid_to order by rc.rate_paise limit 1`, [itemId, istDay(now())]))[0] ?? null

  // ---------- indents ----------
  app.get('/api/indents', async (req) => {
    const who = await need(req, 'purchase.indent', 'indent.approve', 'purchase.order')
    const status = (req.query as { status?: string }).status ?? 'open'
    const all = can(who, 'indent.approve') || can(who, 'purchase.order')
    const rows = await db.query<{ id: string }>(
      `select n.id, n.number, n.store_id, s.name as store, n.needed_by::text, n.note, n.status, r.name as requested_by, n.requested_by as requester_id, n.requested_at,
              d.name as decided_by, n.decided_at, n.decision_note
         from indent n join store s on s.id = n.store_id join app_user r on r.id = n.requested_by left join app_user d on d.id = n.decided_by
        where ($1 = 'all' or ($1 = 'open' and n.status in ('submitted', 'approved')) or n.status = $1) and ($2 or n.requested_by = $3)
        order by n.requested_at desc limit 200`, [status, all, who.userId])
    const lines = rows.length ? await db.query<{ indent_id: string; qty: string; purchase_factor: string; item_id: string; best_rate_paise: string | null }>(
      `select l.indent_id, l.line, l.item_id, i.name as item, i.unit, i.purchase_unit, i.purchase_factor, l.qty, l.note, l.po_id, p.number as po_number,
              (select min(rc.rate_paise) from rate_contract rc where rc.item_id = l.item_id and $2::date between rc.valid_from and rc.valid_to) as best_rate_paise
         from indent_line l join item i on i.id = l.item_id left join purchase_order p on p.id = l.po_id where l.indent_id = any($1) order by l.line`, [rows.map((r) => r.id), istDay(now())]) : []
    return rows.map((r) => {
      const ls = lines.filter((l) => l.indent_id === r.id).map((l) => ({ ...l, purchaseQty: Number(l.qty) / Number(l.purchase_factor) }))
      const estimatePaise = ls.reduce((a, l) => a + (l.best_rate_paise != null ? Math.round(l.purchaseQty * Number(l.best_rate_paise)) : 0), 0)
      return { ...r, lines: ls, estimatePaise }
    })
  })

  app.post('/api/indents', async (req, reply) => {
    const who = await need(req, 'purchase.indent')
    const b = (req.body ?? {}) as { storeId?: string; neededBy?: string; note?: string; lines?: { itemId: string; qty: number; note?: string }[] }
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) throw new HttpError(400, 'Add the items wanted.')
    if (b.neededBy && !DATE.test(b.neededBy)) throw new HttpError(400, 'Needed by as YYYY-MM-DD.')
    return db.tx(async (t) => {
      const [s] = await t.query('select 1 from store where id = $1 and active', [b.storeId])
      if (!s) throw new HttpError(404, 'Choose the store the goods are for.')
      const id = newId('IN'), number = await nextSeriesNumber(t, 'indent', financialYear(istDay(now())), 'IND')
      await t.query('insert into indent (id, number, store_id, needed_by, note, requested_by, requested_at) values ($1,$2,$3,$4,$5,$6,$7)',
        [id, number, b.storeId, b.neededBy || null, b.note?.trim() || null, who.userId, now()])
      let n = 0
      for (const l of b.lines!) {
        const i = await item(t, l.itemId)
        if (!(Number(l.qty) > 0)) throw new HttpError(400, `How much ${i.name}?`)
        await t.query('insert into indent_line (indent_id, line, item_id, qty, note) values ($1,$2,$3,$4,$5)', [id, ++n, i.id, Number(l.qty) * Number(i.purchase_factor), l.note?.trim() || null])
      }
      await appendAudit(t, { actor: who, action: 'indent.add', entity: { type: 'indent', id }, after: { number, lines: n } }, now())
      return reply.status(201).send({ id, number })
    })
  })

  app.post('/api/indents/:id/:action', async (req) => {
    const who = await requireCaller(ctx, req)
    const { id, action } = req.params as { id: string; action: string }
    const note = (req.body as { note?: string })?.note?.trim() || null
    return db.tx(async (t) => {
      const [n] = await t.query<{ status: string; requested_by: string; number: string }>('select status, requested_by, number from indent where id = $1 for update', [id])
      if (!n) throw new HttpError(404, 'No such indent.')
      if (action === 'approve' || action === 'reject') {
        if (!can(who, 'indent.approve')) throw new HttpError(403, 'Indents are approved by the GM or operations manager.')
        if (n.requested_by === who.userId && !who.permissions.has('*')) throw new HttpError(403, 'You cannot approve your own indent.')
        if (n.status !== 'submitted') throw new HttpError(409, `Already ${n.status}.`)
        if (action === 'reject' && !note) throw new HttpError(400, 'Say why it is turned down.')
        await t.query('update indent set status = $2, decided_by = $3, decided_at = $4, decision_note = $5 where id = $1', [id, action === 'approve' ? 'approved' : 'rejected', who.userId, now(), note])
      } else if (action === 'cancel') {
        if (n.requested_by !== who.userId && !can(who, 'purchase.order')) throw new HttpError(403, 'Only the person who raised it, or stores, can cancel it.')
        if (!['submitted', 'approved'].includes(n.status)) throw new HttpError(409, `Already ${n.status}.`)
        const [ordered] = await t.query('select 1 from indent_line where indent_id = $1 and po_id is not null', [id])
        if (ordered) throw new HttpError(409, 'Part of it is already on a purchase order.')
        await t.query(`update indent set status = 'cancelled', decision_note = coalesce($2, decision_note) where id = $1`, [id, note])
      } else throw new HttpError(404, 'Use approve, reject or cancel.')
      await appendAudit(t, { actor: who, action: `indent.${action}`, entity: { type: 'indent', id }, after: { number: n.number }, note: note ?? undefined }, now())
      return { ok: true }
    })
  })

  // ---------- purchase orders ----------
  interface LineIn { itemId: string; qty: number; rate?: number }

  /** Writes a PO's lines (rate from the vendor's rate contract unless given) and its totals. */
  async function writeLines(t: Db, poId: string, vendorId: string, lines: LineIn[]) {
    if (!Array.isArray(lines) || !lines.length || lines.length > 200) throw new HttpError(400, 'Add the items to order.')
    await t.query('delete from po_line where po_id = $1', [poId])
    let n = 0, sub = 0, gst = 0
    for (const l of lines) {
      const i = await item(t, l.itemId)
      if (!(Number(l.qty) > 0)) throw new HttpError(400, `How many ${i.purchase_unit} of ${i.name}?`)
      if (i.brand_id || i.category === 'liquor') throw new HttpError(400, `${i.name}: liquor is bought only from TASMAC, entered under Restaurant → Bar stock → TASMAC purchases.`)
      if (i.gst_rate == null) throw new HttpError(400, `Set the GST rate for ${i.name} first (Items).`)
      const contract = await rateOf(t, vendorId, i.id)
      const rate = l.rate != null ? Math.round(Number(l.rate) * 100) : contract != null ? Number(contract) : null
      if (rate == null || rate < 0) throw new HttpError(400, `No rate agreed with this vendor for ${i.name}: enter the price.`)
      const amount = Math.round(Number(l.qty) * rate), tax = Math.round((amount * Number(i.gst_rate)) / 100)
      await t.query('insert into po_line (po_id, line, item_id, qty, rate_paise, gst_rate, amount_paise, gst_paise) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [poId, ++n, i.id, Number(l.qty), rate, Number(i.gst_rate), amount, tax])
      sub += amount; gst += tax
    }
    await t.query('update purchase_order set subtotal_paise = $2, gst_paise = $3, total_paise = $4 where id = $1', [poId, sub, gst, sub + gst])
    return { subtotal: sub, gst, total: sub + gst }
  }

  async function createPo(t: Db, who: Caller, b: { vendorId: string; storeId: string; expectedDate?: string | null; terms?: string | null; lines: LineIn[]; marketList?: boolean }) {
    const [v] = await t.query<{ state_code: string; active: boolean; name: string }>('select state_code, active, name from vendor where id = $1', [b.vendorId])
    if (!v?.active) throw new HttpError(404, 'Choose an active vendor.')
    const [s] = await t.query('select 1 from store where id = $1 and active', [b.storeId])
    if (!s) throw new HttpError(404, 'Choose the store to deliver to.')
    if (b.expectedDate && !DATE.test(b.expectedDate)) throw new HttpError(400, 'Expected date as YYYY-MM-DD.')
    const id = newId('PO'), number = await nextSeriesNumber(t, 'purchase_order', financialYear(istDay(now())), 'PO')
    await t.query(`insert into purchase_order (id, number, vendor_id, store_id, order_date, expected_date, igst, terms, market_list, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, number, b.vendorId, b.storeId, istDay(now()), b.expectedDate || null, v.state_code !== HOME_STATE, b.terms?.trim() || null, !!b.marketList, who.userId, now()])
    const totals = await writeLines(t, id, b.vendorId, b.lines)
    await appendAudit(t, { actor: who, action: 'po.add', entity: { type: 'purchase_order', id }, amount: totals.total, after: { number, vendor: v.name, lines: b.lines.length } }, now())
    return { id, number, ...totals }
  }

  app.get('/api/pos', async (req) => {
    await need(req, 'purchase.order', 'purchase.approve', 'stores.view')
    const status = (req.query as { status?: string }).status ?? 'open'
    return db.query(
      `select p.id, p.number, p.vendor_id, v.name as vendor, p.store_id, s.name as store, p.status, p.order_date::text, p.expected_date::text, p.subtotal_paise, p.gst_paise, p.total_paise,
              p.market_list, c.name as created_by, a.name as approved_by, p.approval_id, (select count(*)::int from po_line l where l.po_id = p.id) as lines
         from purchase_order p join vendor v on v.id = p.vendor_id join store s on s.id = p.store_id join app_user c on c.id = p.created_by left join app_user a on a.id = p.approved_by
        where ($1 = 'all' or ($1 = 'open' and p.status in ('draft', 'pending_approval', 'approved', 'sent', 'partly_received')) or p.status = $1)
        order by p.created_at desc limit 300`, [status])
  })

  app.get('/api/pos/:id', async (req) => {
    await need(req, 'purchase.order', 'purchase.approve', 'stores.view')
    const { id } = req.params as { id: string }
    const [po] = await db.query(
      `select p.*, p.order_date::text, p.expected_date::text, v.name as vendor, v.gstin as vendor_gstin, s.name as store from purchase_order p join vendor v on v.id = p.vendor_id join store s on s.id = p.store_id where p.id = $1`, [id])
    if (!po) throw new HttpError(404, 'No such purchase order.')
    const lines = await db.query(`select l.*, i.name as item, i.purchase_unit, i.hsn from po_line l join item i on i.id = l.item_id where l.po_id = $1 order by l.line`, [id])
    return { ...po, lines }
  })

  app.post('/api/pos', async (req, reply) => {
    const who = await need(req, 'purchase.order')
    const b = (req.body ?? {}) as { vendorId?: string; storeId?: string; expectedDate?: string; terms?: string; lines?: LineIn[] }
    return db.tx(async (t) => reply.status(201).send(await createPo(t, who, { vendorId: b.vendorId!, storeId: b.storeId!, expectedDate: b.expectedDate, terms: b.terms, lines: b.lines ?? [] })))
  })

  app.patch('/api/pos/:id', async (req) => {
    const who = await need(req, 'purchase.order')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { expectedDate?: string | null; terms?: string | null; lines?: LineIn[] }
    return db.tx(async (t) => {
      const [po] = await t.query<{ status: string; vendor_id: string; number: string }>('select status, vendor_id, number from purchase_order where id = $1 for update', [id])
      if (!po) throw new HttpError(404, 'No such purchase order.')
      if (po.status !== 'draft') throw new HttpError(409, 'Only a draft can be changed: cancel it and raise a new one.')
      if (b.expectedDate && !DATE.test(b.expectedDate)) throw new HttpError(400, 'Expected date as YYYY-MM-DD.')
      await t.query('update purchase_order set expected_date = case when $2::boolean then $3::date else expected_date end, terms = case when $4::boolean then $5 else terms end where id = $1',
        [id, b.expectedDate !== undefined, b.expectedDate || null, b.terms !== undefined, b.terms?.trim() || null])
      const totals = b.lines ? await writeLines(t, id, po.vendor_id, b.lines) : null
      await appendAudit(t, { actor: who, action: 'po.update', entity: { type: 'purchase_order', id }, amount: totals?.total, after: { number: po.number } }, now())
      return { ok: true, ...totals }
    })
  })

  app.post('/api/pos/:id/:action', async (req) => {
    const who = await requireCaller(ctx, req)
    const { id, action } = req.params as { id: string; action: string }
    const reason = (req.body as { reason?: string })?.reason?.trim()
    return db.tx(async (t) => {
      const [po] = await t.query<{ status: string; total_paise: string; number: string; created_by: string }>('select status, total_paise, number, created_by from purchase_order where id = $1 for update', [id])
      if (!po) throw new HttpError(404, 'No such purchase order.')
      let result: Record<string, unknown> = { ok: true }
      if (action === 'submit') {
        if (!can(who, 'purchase.order')) throw new HttpError(403, 'Stores raise purchase orders.')
        if (po.status !== 'draft') throw new HttpError(409, `Already ${po.status.replace('_', ' ')}.`)
        const total = Number(po.total_paise)
        // Within the raiser's limit it is approved at once; above it, it waits for someone whose limit covers it.
        if (total <= (await roleLimit(t, who, 'purchase_order')) * 100) {
          await approvePo(t, id, who, now())
          result = { ok: true, status: 'approved' }
        } else {
          const approvalId = await createApproval(ctx, t, 'purchase.po', who.userId, { poId: id, number: po.number, total }, `${po.number}: ₹${(total / 100).toLocaleString('en-IN')}`)
          await t.query(`update purchase_order set status = 'pending_approval', approval_id = $2 where id = $1`, [id, approvalId])
          result = { ok: true, status: 'pending_approval', approvalId }
        }
      } else if (action === 'send') {
        if (!can(who, 'purchase.order')) throw new HttpError(403, 'Stores send purchase orders.')
        if (po.status !== 'approved') throw new HttpError(409, po.status === 'pending_approval' ? 'It is still waiting for approval.' : `It is ${po.status.replace('_', ' ')}.`)
        await t.query(`update purchase_order set status = 'sent', sent_at = $2 where id = $1`, [id, now()])
      } else if (action === 'cancel') {
        if (!can(who, 'purchase.order') && !can(who, 'purchase.approve')) throw new HttpError(403, 'Your role cannot cancel purchase orders.')
        if (['partly_received', 'received', 'closed', 'cancelled'].includes(po.status)) throw new HttpError(409, `It is ${po.status.replace('_', ' ')}: goods have been received or it is closed.`)
        if (!reason) throw new HttpError(400, 'Say why it is cancelled.')
        await t.query(`update purchase_order set status = 'cancelled', cancel_reason = $2 where id = $1`, [id, reason])
        await t.query(`update approval set status = 'rejected' where id = (select approval_id from purchase_order where id = $1) and status = 'pending'`, [id])
        // Indent lines on it can be ordered again.
        await t.query(`update indent_line set po_id = null where po_id = $1`, [id])
        await t.query(`update indent set status = 'approved' where status = 'ordered' and id in (select indent_id from indent_line where po_id is null)`)
      } else throw new HttpError(404, 'Use submit, send or cancel.')
      await appendAudit(t, { actor: who, action: `po.${action}`, entity: { type: 'purchase_order', id }, amount: Number(po.total_paise), after: { number: po.number, ...result }, note: reason }, now())
      return result
    })
  })

  // Approved indents become draft POs: each line goes to the vendor with the best current rate.
  app.post('/api/indents/order', async (req, reply) => {
    const who = await need(req, 'purchase.order')
    const ids = (req.body as { indentIds?: string[] })?.indentIds ?? []
    if (!ids.length) throw new HttpError(400, 'Choose the approved indents to order.')
    return db.tx(async (t) => {
      const lines = await t.query<{ indent_id: string; line: number; item_id: string; qty: string; store_id: string; purchase_factor: string; name: string; status: string }>(
        `select l.indent_id, l.line, l.item_id, l.qty, n.store_id, i.purchase_factor, i.name, n.status from indent_line l join indent n on n.id = l.indent_id join item i on i.id = l.item_id
          where l.indent_id = any($1) and l.po_id is null for update of l`, [ids])
      if (lines.some((l) => l.status !== 'approved')) throw new HttpError(409, 'Only approved indents can be ordered.')
      if (!lines.length) throw new HttpError(409, 'Everything on these indents is already ordered.')
      const groups = new Map<string, { vendorId: string; storeId: string; lines: (LineIn & { ref: [string, number] })[] }>()
      const missing: string[] = []
      for (const l of lines) {
        const best = await bestRate(t, l.item_id)
        if (!best) { missing.push(l.name); continue }
        const key = `${best.vendor_id}|${l.store_id}`
        if (!groups.has(key)) groups.set(key, { vendorId: best.vendor_id, storeId: l.store_id, lines: [] })
        groups.get(key)!.lines.push({ itemId: l.item_id, qty: Number(l.qty) / Number(l.purchase_factor), ref: [l.indent_id, l.line] })
      }
      if (missing.length) throw new HttpError(409, `No current rate for ${[...new Set(missing)].join(', ')}: add a rate, or raise a PO by hand.`)
      const made: { id: string; number: string; total: number }[] = []
      for (const g of groups.values()) {
        const po = await createPo(t, who, { vendorId: g.vendorId, storeId: g.storeId, lines: g.lines })
        for (const l of g.lines) await t.query('update indent_line set po_id = $3 where indent_id = $1 and line = $2', [l.ref[0], l.ref[1], po.id])
        made.push({ id: po.id, number: po.number, total: po.total })
      }
      await t.query(`update indent set status = 'ordered' where id = any($1) and not exists (select 1 from indent_line l where l.indent_id = indent.id and l.po_id is null)`, [ids])
      return reply.status(201).send({ pos: made })
    })
  })

  // ---------- market list and reorder suggestions ----------
  app.get('/api/purchase/suggestions', async (req) => {
    await need(req, 'purchase.order', 'purchase.indent')
    const perishable = (req.query as { perishable?: string }).perishable === '1'
    const items = await db.query<ItemRow>(`select * from item where active and par_level is not null and default_store_id is not null and ($1 = false or perishable) order by category, name`, [perishable])
    const out = []
    for (const i of items) {
      const stock = await stockOf(db, i, i.default_store_id!)
      const par = Number(i.par_level)
      if (stock >= par) continue
      // Already on order and not yet received counts towards the need.
      const [{ onOrder }] = await db.query<{ onOrder: string | null }>(
        `select sum((l.qty - l.received_qty) * $2::numeric) as "onOrder" from po_line l join purchase_order p on p.id = l.po_id where l.item_id = $1 and p.status in ('draft', 'pending_approval', 'approved', 'sent', 'partly_received')`,
        [i.id, i.purchase_factor])
      const short = par - stock - Number(onOrder ?? 0)
      if (short <= 0) continue
      const want = Math.max(short, Number(i.reorder_qty ?? 0))
      const qty = Math.ceil(want / Number(i.purchase_factor) * 100) / 100
      const best = await bestRate(db, i.id)
      out.push({ itemId: i.id, item: i.name, unit: i.unit, purchaseUnit: i.purchase_unit, storeId: i.default_store_id, stock, par, onOrder: Number(onOrder ?? 0), qty,
        vendorId: best?.vendor_id ?? null, vendor: best?.vendor ?? null, ratePaise: best ? Number(best.rate_paise) : null, amountPaise: best ? Math.round(qty * Number(best.rate_paise)) : null })
    }
    return out
  })

  app.post('/api/purchase/suggestions/order', async (req, reply) => {
    const who = await need(req, 'purchase.order')
    const b = (req.body ?? {}) as { lines?: { itemId: string; qty: number; vendorId?: string; storeId?: string }[]; marketList?: boolean; expectedDate?: string }
    if (!b.lines?.length) throw new HttpError(400, 'Choose what to order.')
    return db.tx(async (t) => {
      const groups = new Map<string, { vendorId: string; storeId: string; lines: LineIn[] }>()
      for (const l of b.lines!) {
        const i = await item(t, l.itemId)
        const vendorId = l.vendorId ?? (await bestRate(t, i.id))?.vendor_id
        const storeId = l.storeId ?? i.default_store_id
        if (!vendorId) throw new HttpError(409, `No current rate for ${i.name}: choose the vendor and price.`)
        if (!storeId) throw new HttpError(409, `${i.name} has no store set.`)
        const key = `${vendorId}|${storeId}`
        if (!groups.has(key)) groups.set(key, { vendorId, storeId, lines: [] })
        groups.get(key)!.lines.push({ itemId: i.id, qty: Number(l.qty) })
      }
      const made = []
      for (const g of groups.values()) made.push(await createPo(t, who, { ...g, expectedDate: b.expectedDate, marketList: !!b.marketList }))
      return reply.status(201).send({ pos: made.map((p) => ({ id: p.id, number: p.number, total: p.total })) })
    })
  })

  // ---------- the printed purchase order ----------
  app.get('/api/pos/:id/print', async (req, reply) => {
    await need(req, 'purchase.order', 'purchase.approve', 'stores.view')
    const { id } = req.params as { id: string }
    const [po] = await db.query<Record<string, string | null> & { igst: boolean; subtotal_paise: string; gst_paise: string; total_paise: string }>(
      `select p.*, p.order_date::text, p.expected_date::text, v.name as vendor, v.legal_name, v.gstin as vgstin, v.address as vaddress, v.phone as vphone, s.name as store, a.name as approver
         from purchase_order p join vendor v on v.id = p.vendor_id join store s on s.id = p.store_id left join app_user a on a.id = p.approved_by where p.id = $1`, [id])
    if (!po) throw new HttpError(404, 'No such purchase order.')
    const lines = await db.query<{ item: string; hsn: string | null; purchase_unit: string; qty: string; rate_paise: string; gst_rate: string; amount_paise: string; gst_paise: string }>(
      'select i.name as item, i.hsn, i.purchase_unit, l.qty, l.rate_paise, l.gst_rate, l.amount_paise, l.gst_paise from po_line l join item i on i.id = l.item_id where l.po_id = $1 order by l.line', [id])
    const [p] = await db.query<{ legal_name: string | null; name: string; gstin: string | null; address: string | null; city: string | null; pin: string | null }>('select legal_name, name, gstin, address, city, pin from property limit 1')
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
    const r = (paise: number | string) => (Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const gst = Number(po.gst_paise)
    const draft = ['draft', 'pending_approval'].includes(String(po.status))
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(po.number)}</title><style>
      body{font:13px system-ui;margin:24px;color:#111}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{border:1px solid #bbb;padding:6px;text-align:left}td.n,th.n{text-align:right}
      .head{display:flex;justify-content:space-between;gap:24px}.muted{color:#555}.draft{color:#b00;font-weight:700;font-size:16px}.sign{margin-top:48px;display:flex;justify-content:space-between}</style></head><body>
      <div class="head"><div><h1>${esc(p.legal_name ?? p.name)}</h1><div class="muted">${esc([p.address, p.city, p.pin].filter(Boolean).join(', '))}</div><div>GSTIN ${esc(p.gstin ?? '—')}</div></div>
        <div><h1>Purchase order</h1><div><b>${esc(po.number)}</b></div><div>Date ${esc(po.order_date)}</div>${po.expected_date ? `<div>Deliver by ${esc(po.expected_date)}</div>` : ''}${draft ? '<div class="draft">NOT APPROVED: DRAFT</div>' : ''}</div></div>
      <p><b>To:</b> ${esc(po.legal_name ?? po.vendor)}${po.vgstin ? ` · GSTIN ${esc(po.vgstin)}` : ''}<br>${esc(po.vaddress ?? '')}${po.vphone ? ` · ${esc(po.vphone)}` : ''}<br><b>Deliver to:</b> ${esc(po.store)}, ${esc(p.legal_name ?? p.name)}</p>
      <table><tr><th>#</th><th>Item</th><th>HSN</th><th class="n">Qty</th><th>Unit</th><th class="n">Rate</th><th class="n">Amount</th><th class="n">GST %</th><th class="n">GST</th></tr>
      ${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item)}</td><td>${esc(l.hsn ?? '')}</td><td class="n">${Number(l.qty)}</td><td>${esc(l.purchase_unit)}</td><td class="n">${r(l.rate_paise)}</td><td class="n">${r(l.amount_paise)}</td><td class="n">${Number(l.gst_rate)}</td><td class="n">${r(l.gst_paise)}</td></tr>`).join('')}
      <tr><td colspan="6" class="n">Taxable value</td><td class="n">${r(po.subtotal_paise)}</td><td></td><td></td></tr>
      ${po.igst ? `<tr><td colspan="8" class="n">IGST</td><td class="n">${r(gst)}</td></tr>` : `<tr><td colspan="8" class="n">CGST</td><td class="n">${r(Math.floor(gst / 2))}</td></tr><tr><td colspan="8" class="n">SGST</td><td class="n">${r(gst - Math.floor(gst / 2))}</td></tr>`}
      <tr><th colspan="8" class="n">Total</th><th class="n">${r(po.total_paise)}</th></tr></table>
      <p>Amount in words: ${esc(inWords(Math.round(Number(po.total_paise) / 100)))} rupees only</p>
      ${po.terms ? `<p><b>Terms:</b> ${esc(po.terms)}</p>` : ''}
      <p class="muted">Please quote the PO number on your invoice and delivery challan. Goods are accepted after the quality check at the store.</p>
      <div class="sign"><div>Prepared by stores</div><div>${po.approver ? `Approved by ${esc(po.approver)}` : 'Approval pending'}</div></div>
      <script>window.onload=()=>window.print()</script></body></html>`
    return reply.type('text/html; charset=utf-8').send(html)
  })
}
