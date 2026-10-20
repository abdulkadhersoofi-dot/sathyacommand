import type { FastifyInstance, FastifyRequest } from 'fastify'
import { financialYear } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import { addDays, istDay, newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { nextSeriesNumber } from '../invoicing'
import { moveStock, storeLedger, type StockItem } from '../stock'
import { requireCaller } from './auth'

// Goods received at the store: counted against the PO, checked for quality (rejected quantity with the
// reason), batch and expiry noted, and the accepted goods posted into the book the store keeps.

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** A delivery may run this much over the ordered quantity (loose goods by weight). */
const OVER_RECEIPT = 0.05

type ItemRow = StockItem & { name: string; purchase_factor: string; gst_rate: string | null; itc: string; perishable: boolean; shelf_life_days: number | null }

export function receiptRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }

  app.post('/api/grns', async (req, reply) => {
    const who = await need(req, 'stores.receive')
    const b = (req.body ?? {}) as {
      poId?: string; vendorId?: string; storeId?: string; challanNo?: string; note?: string; photoIds?: string[]
      lines?: { poLine?: number; itemId?: string; qtyReceived: number; qtyAccepted?: number; rejectReason?: string; rate?: number; batchNo?: string; expiry?: string }[]
    }
    if (!Array.isArray(b.lines) || !b.lines.length) throw new HttpError(400, 'Count what arrived.')
    return db.tx(async (t) => {
      const day = await businessDate(t)
      let vendorId = b.vendorId, storeId = b.storeId
      let poLines: { line: number; item_id: string; qty: string; received_qty: string; rate_paise: string }[] = []
      let poNumber: string | null = null
      if (b.poId) {
        const [po] = await t.query<{ status: string; vendor_id: string; store_id: string; number: string }>('select status, vendor_id, store_id, number from purchase_order where id = $1 for update', [b.poId])
        if (!po) throw new HttpError(404, 'No such purchase order.')
        if (!['approved', 'sent', 'partly_received'].includes(po.status)) throw new HttpError(409, po.status === 'received' ? 'Everything on this PO has already been received.' : `This PO is ${po.status.replace('_', ' ')}: it cannot be received against.`)
        vendorId = po.vendor_id; storeId = storeId ?? po.store_id; poNumber = po.number
        poLines = await t.query('select line, item_id, qty, received_qty, rate_paise from po_line where po_id = $1 for update', [b.poId])
      } else {
        // Without a PO (cash purchase at the market): allowed to those who can order, with the reason.
        if (!can(who, 'purchase.order')) throw new HttpError(403, 'Receive against a purchase order. Goods without a PO are taken in by the purchase manager.')
        if (!b.note?.trim()) throw new HttpError(400, 'Say why there is no purchase order.')
        const [v] = await t.query('select 1 from vendor where id = $1 and active', [vendorId]); if (!v) throw new HttpError(404, 'Choose the vendor.')
      }
      const [s] = await t.query('select 1 from store where id = $1 and active', [storeId]); if (!s) throw new HttpError(404, 'Choose the store.')
      const ledger = await storeLedger(t, storeId!)
      const id = newId('GR'), number = await nextSeriesNumber(t, 'grn', financialYear(istDay(now())), 'GRN')
      await t.query('insert into grn (id, number, po_id, vendor_id, store_id, challan_no, business_date, photo_ids, note, received_by, received_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [id, number, b.poId ?? null, vendorId, storeId, b.challanNo?.trim() || null, day, (b.photoIds ?? []).slice(0, 6), b.note?.trim() || null, who.userId, now()])
      let n = 0, value = 0, rejected = 0
      for (const l of b.lines!) {
        const pl = b.poId ? poLines.find((x) => x.line === l.poLine) : null
        if (b.poId && !pl) throw new HttpError(400, 'Each line must be a line of the PO.')
        const itemId = pl?.item_id ?? l.itemId
        const [i] = await t.query<ItemRow>('select * from item where id = $1', [itemId])
        if (!i) throw new HttpError(404, 'No such item.')
        if (i.brand_id) throw new HttpError(400, `${i.name}: liquor comes in only through a TASMAC purchase (with its transport permit), not a goods receipt.`)
        const got = Number(l.qtyReceived), ok = l.qtyAccepted == null ? got : Number(l.qtyAccepted)
        if (!(got >= 0) || !(ok >= 0) || ok > got) throw new HttpError(400, `${i.name}: accepted cannot be more than received.`)
        if (got === 0) continue
        if (ok < got && !l.rejectReason?.trim()) throw new HttpError(400, `${i.name}: say why ${got - ok} was rejected (quality, damaged, short shelf life…).`)
        if (pl && Number(pl.received_qty) + ok > Number(pl.qty) * (1 + OVER_RECEIPT)) throw new HttpError(409, `${i.name}: ${Number(pl.received_qty) + ok} would be more than the ${Number(pl.qty)} ordered.`)
        const rate = pl ? Number(pl.rate_paise) : Math.round(Number(l.rate) * 100)
        if (!pl && !(rate >= 0 && Number.isFinite(rate))) throw new HttpError(400, `${i.name}: enter the price paid.`)
        if (l.expiry && !DATE.test(l.expiry)) throw new HttpError(400, 'Expiry as YYYY-MM-DD.')
        const expiry = l.expiry || (i.perishable && i.shelf_life_days ? addDays(day, i.shelf_life_days) : null)
        if (expiry && expiry < day && ok > 0) throw new HttpError(400, `${i.name} has already expired: reject it.`)
        await t.query(`insert into grn_line (grn_id, line, item_id, po_line, qty_received, qty_accepted, reject_reason, rate_paise, batch_no, expiry) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, ++n, i.id, pl?.line ?? null, got, ok, l.rejectReason?.trim() || null, rate, l.batchNo?.trim() || null, expiry])
        if (pl) await t.query('update po_line set received_qty = received_qty + $3 where po_id = $1 and line = $2', [b.poId, pl.line, ok])
        rejected += got - ok
        if (ok <= 0) continue
        // GST that cannot be claimed back is part of what the goods cost.
        const taxable = Math.round(ok * rate)
        const cost = taxable + (i.itc === 'full' ? 0 : Math.round((taxable * Number(i.gst_rate ?? 0)) / 100))
        value += taxable
        const qty = ok * Number(i.purchase_factor)
        await moveStock(t, { item: i, storeId: storeId!, kind: 'receipt', qty, value: cost, ref: number, note: poNumber ? `${poNumber}${b.challanNo ? ` · challan ${b.challanNo}` : ''}` : b.note, userId: who.userId, at: now(), day })
        if (ledger === 'own' && (i.perishable || l.batchNo || expiry)) {
          await t.query('insert into stock_batch (id, item_id, store_id, grn_id, batch_no, expiry, qty_in, qty_left, created_at) values ($1,$2,$3,$4,$5,$6,$7,$7,$8)',
            [newId('BT'), i.id, storeId, id, l.batchNo?.trim() || null, expiry, qty, now()])
        }
      }
      if (!n) throw new HttpError(400, 'Nothing was received.')
      await t.query('update grn set value_paise = $2 where id = $1', [id, value])
      if (b.poId) {
        const [left] = await t.query<{ n: number }>('select count(*)::int as n from po_line where po_id = $1 and received_qty < qty', [b.poId])
        await t.query('update purchase_order set status = $2 where id = $1', [b.poId, left.n ? 'partly_received' : 'received'])
      }
      await appendAudit(t, { actor: who, action: b.poId ? 'grn.add' : 'grn.without_po', entity: { type: 'grn', id }, amount: value,
        after: { number, po: poNumber, lines: n, rejected: rejected || undefined }, note: b.poId ? undefined : b.note }, now())
      return reply.status(201).send({ id, number, valuePaise: value })
    })
  })

  app.get('/api/grns', async (req) => {
    await need(req, 'stores.receive', 'purchase.bill', 'stores.view', 'purchase.order')
    const q = req.query as { poId?: string; vendorId?: string; unbilled?: string; days?: string }
    const since = istDay(new Date(now().getTime() - Math.min(366, Number(q.days ?? 60)) * 86_400_000))
    const rows = await db.query<{ id: string }>(
      `select g.id, g.number, g.po_id, p.number as po_number, g.vendor_id, v.name as vendor, g.store_id, s.name as store, g.challan_no, g.business_date::text, g.photo_ids, g.note, g.value_paise,
              u.name as received_by, g.received_at
         from grn g join vendor v on v.id = g.vendor_id join store s on s.id = g.store_id join app_user u on u.id = g.received_by left join purchase_order p on p.id = g.po_id
        where ($1::text is null or g.po_id = $1) and ($2::text is null or g.vendor_id = $2) and g.business_date >= $3
          and (not $4 or exists (select 1 from grn_line l where l.grn_id = g.id and l.billed_qty < l.qty_accepted))
        order by g.received_at desc limit 200`, [q.poId ?? null, q.vendorId ?? null, since, q.unbilled === '1'])
    const lines = rows.length ? await db.query<{ grn_id: string }>(
      `select l.*, l.expiry::text, i.name as item, i.purchase_unit from grn_line l join item i on i.id = l.item_id where l.grn_id = any($1) order by l.line`, [rows.map((r) => r.id)]) : []
    return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.grn_id === r.id) }))
  })

  // Perishables close to expiry in the stores (own ledger): use first, or write off.
  app.get('/api/stock/expiring', async (req) => {
    await need(req, 'stores.receive', 'stores.view')
    const days = Math.min(60, Number((req.query as { days?: string }).days ?? 3))
    return db.query(
      `select b.id, b.item_id, i.name as item, i.unit, b.store_id, s.name as store, b.batch_no, b.expiry::text, b.qty_left, (b.expiry - $1::date) as days_left
         from stock_batch b join item i on i.id = b.item_id join store s on s.id = b.store_id
        where b.qty_left > 0 and b.expiry is not null and b.expiry <= $1::date + $2::int order by b.expiry, i.name`, [istDay(now()), days])
  })
}

