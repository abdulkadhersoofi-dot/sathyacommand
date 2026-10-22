import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import qrcode from 'qrcode-generator'
import { amountInWords, cashReceiptCheck, financialYear, formatInr, pct, restaurantRate, rupees, splitGst, validateGstin } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import type { Party } from '../einvoice'
import { businessDate, folioBalance } from '../fo-core'
import { issue, nextSeriesNumber, stateName, supplier, type DocLine } from '../invoicing'
import { createApproval, registerApprovalKind } from './approvals'
import { checkCredit, debtorFor } from '../receivables'
import { requireCaller } from './auth'
import { licencesFor, vatRatesOn } from './settings'
import { billDoc, queueDoc } from './printing'

// Restaurant and bar bills. One order can be split (equally, or item by item) into several bills; each
// bill carries food and soft drinks on a GST tax invoice (RST series) and liquor on a TN VAT invoice
// (VAT series). The guest pays both together, or the bill is charged to their room.

const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
const METHODS = ['cash', 'card', 'upi', 'company', 'room'] as const

/** Splits an amount into n parts that add back exactly; part k (1-based) of n. */
const alloc = (v: number, k: number, n: number) => Math.round((v * k) / n) - Math.round((v * (k - 1)) / n)

interface Item { id: string; name: string; qty: number; price_paise: number; liquor_class: string | null }
interface BillTo { company: string; gstin?: string | null; address?: string | null; city?: string | null; pin?: string | null }

export interface BillAmounts {
  food: { itemId: string | null; description: string; gross: number; discount: number; taxable: number; cgst: number; sgst: number; total: number }[]
  liquor: { itemId: string; description: string; liquorClass: string; gross: number; discount: number; taxable: number; vatRate: number | null; vat: number; total: number }[]
  gstRate: number
  foodGross: number; foodDiscount: number; service: number; foodTaxable: number; cgst: number; sgst: number
  liquorGross: number; liquorDiscount: number; liquorTaxable: number; vat: number
  total: number; roundOff: number; payable: number
  vatMissing: string[]
}

/** The money on one bill: discounts, optional service charge (food only, taxed with it), GST and VAT per line. */
export async function computeBill(ctx: Ctx, t: Db, o: { business_date: string }, items: Item[], share: [number, number], discountPercent: number, servicePercent: number): Promise<BillAmounts> {
  const { rate } = restaurantRate(ctx.tax, financialYear(o.business_date))
  const vatRates = await vatRatesOn(t, o.business_date)
  const [k, n] = share
  const portion = n > 1 ? ` (share ${k} of ${n})` : ''
  const food: BillAmounts['food'] = [], liquor: BillAmounts['liquor'] = []
  const vatMissing = new Set<string>()
  for (const i of items) {
    const gross = alloc(i.price_paise * i.qty, k, n)
    const discount = pct(gross, discountPercent)
    const taxable = gross - discount
    const description = `${i.qty} × ${i.name}${portion}`
    if (i.liquor_class) {
      const vr = vatRates[i.liquor_class] ?? null
      if (vr == null) vatMissing.add(i.liquor_class)
      const vat = vr == null ? 0 : pct(taxable, vr)
      liquor.push({ itemId: i.id, description, liquorClass: i.liquor_class, gross, discount, taxable, vatRate: vr, vat, total: taxable + vat })
    } else {
      const g = splitGst(taxable, rate)
      food.push({ itemId: i.id, description, gross, discount, taxable, cgst: g.cgst, sgst: g.sgst, total: g.total })
    }
  }
  const foodNet = food.reduce((a, l) => a + l.taxable, 0)
  const service = pct(foodNet, servicePercent)
  if (service) {
    const g = splitGst(service, rate)
    food.push({ itemId: null, description: `Service charge ${servicePercent}% (optional)`, gross: service, discount: 0, taxable: service, cgst: g.cgst, sgst: g.sgst, total: g.total })
  }
  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0)
  const total = sum(food, (l) => l.total) + sum(liquor, (l) => l.total)
  const payable = Math.round(total / 100) * 100
  return {
    food, liquor, gstRate: rate,
    foodGross: sum(food.filter((l) => l.itemId), (l) => l.gross), foodDiscount: sum(food, (l) => l.discount), service,
    foodTaxable: sum(food, (l) => l.taxable), cgst: sum(food, (l) => l.cgst), sgst: sum(food, (l) => l.sgst),
    liquorGross: sum(liquor, (l) => l.gross), liquorDiscount: sum(liquor, (l) => l.discount), liquorTaxable: sum(liquor, (l) => l.taxable), vat: sum(liquor, (l) => l.vat),
    total, roundOff: payable - total, payable, vatMissing: [...vatMissing],
  }
}

async function discountLimit(t: Db, who: Caller) {
  if (who.permissions.has('*')) return 100
  const rows = await t.query<{ limits: Record<string, unknown> }>('select limits from role where id = any($1)', [who.roles])
  return Math.max(0, ...rows.map((r) => Number(r.limits?.discount_percent ?? 0)))
}

interface BillRow { id: string; order_id: string; part: number; parts: number; status: string; item_ids: string[] | null; share_num: number; share_den: number; discount_percent: string; discount_reason: string | null; service_percent: string; bill_to: BillTo | null; amounts: BillAmounts; total_paise: number; prints: number; gst_document_id: string | null; vat_invoice_id: string | null; reservation_id: string | null }

/** Recomputes the amounts of an order's open bills (after a discount is approved). */
async function recomputeOpenBills(ctx: Ctx, t: Db, orderId: string, discountPercent?: number, reason?: string) {
  const [o] = await t.query<{ business_date: string }>('select business_date::text from fnb_order where id = $1', [orderId])
  const items = await liveItems(t, orderId)
  for (const b of await t.query<BillRow>(`select * from fnb_bill where order_id = $1 and status = 'open'`, [orderId])) {
    const d = discountPercent ?? Number(b.discount_percent)
    const its = b.item_ids ? items.filter((i) => b.item_ids!.includes(i.id)) : items
    const a = await computeBill(ctx, t, o, its, [b.share_num, b.share_den], d, Number(b.service_percent))
    await t.query('update fnb_bill set amounts = $2, total_paise = $3, discount_percent = $4, discount_reason = coalesce($5, discount_reason) where id = $1',
      [b.id, JSON.stringify(a), a.payable, d, reason ?? null])
  }
}

const liveItems = (t: Db, orderId: string) => t.query<Item & { status: string }>(
  `select id, name, qty, price_paise, liquor_class, status from order_item where order_id = $1 and status <> 'void' order by added_at, seq`, [orderId])

registerApprovalKind('fnb.discount', {
  permission: 'fnb.discount',
  async apply(t, p, decider, ctx) {
    const percent = Number(p.percent)
    if (percent > await discountLimit(t, decider)) throw new HttpError(403, `Your limit is below ${percent}%. Ask the GM or MD.`)
    const [o] = await t.query<{ status: string }>('select status from fnb_order where id = $1', [p.orderId])
    if (o?.status !== 'billed') throw new HttpError(409, 'That bill has already been settled or cancelled.')
    await recomputeOpenBills(ctx, t, String(p.orderId), percent, String(p.reason ?? ''))
  },
})

/** UPI deep link for a QR code on the bill (the guest scans it with any UPI app). */
export const upiLink = (vpa: string, payee: string, paise: number, note: string) =>
  `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(payee)}&am=${(paise / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`

export function fnbBillingRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function biller(req: FastifyRequest) {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'fnb.bill')) throw new HttpError(403, 'Your role cannot bill restaurant orders.')
    return who
  }

  async function orderFor(t: Db, id: string) {
    const [o] = await t.query<{ id: string; number: number; status: string; outlet_id: string; outlet: string; table_label: string | null; reservation_id: string | null; business_date: string; covers: number; kind: string }>(
      `select o.id, o.number, o.status, o.outlet_id, ot.name as outlet, tb.label as table_label, o.reservation_id, o.business_date::text, o.covers, o.kind
         from fnb_order o join outlet ot on ot.id = o.outlet_id left join dining_table tb on tb.id = o.table_id where o.id = $1 for update of o`, [id])
    if (!o) throw new HttpError(404, 'No such order.')
    return o
  }

  // ---------- settings ----------
  app.get('/api/fnb/billing-settings', async (req) => {
    await requireCaller(ctx, req)
    const [p] = await db.query<{ upi_vpa: string | null; upi_payee: string | null; service_charge_percent: string }>('select upi_vpa, upi_payee, service_charge_percent from property limit 1')
    return { upiVpa: p.upi_vpa, upiPayee: p.upi_payee, serviceChargePercent: Number(p.service_charge_percent) }
  })

  app.put('/api/fnb/billing-settings', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'menu.price')) throw new HttpError(403, 'Only the GM or MD can change billing settings.')
    const b = req.body as { upiVpa?: string | null; upiPayee?: string | null; serviceChargePercent?: number }
    if (b.upiVpa && !/^[A-Za-z0-9.\-_]{2,256}@[A-Za-z]{2,64}$/.test(b.upiVpa)) throw new HttpError(400, 'UPI ID looks like name@bank.')
    if (b.serviceChargePercent !== undefined && !(b.serviceChargePercent >= 0 && b.serviceChargePercent <= 20)) throw new HttpError(400, 'Service charge: 0–20%.')
    return db.tx(async (t) => {
      const [before] = await t.query('select upi_vpa, upi_payee, service_charge_percent from property limit 1')
      await t.query(`update property set upi_vpa = case when $1::boolean then $2 else upi_vpa end, upi_payee = case when $3::boolean then $4 else upi_payee end,
                       service_charge_percent = coalesce($5, service_charge_percent)`,
        [b.upiVpa !== undefined, b.upiVpa || null, b.upiPayee !== undefined, b.upiPayee?.trim() || null, b.serviceChargePercent ?? null])
      const [after] = await t.query('select upi_vpa, upi_payee, service_charge_percent from property limit 1')
      await appendAudit(t, { actor: who, action: 'billing.settings', entity: { type: 'property', id: 'sathya' }, before, after }, now())
      return { ok: true }
    })
  })

  // ---------- bills ----------
  /** A cancellation or discount on the order that still waits for a manager: no bill or payment until it is decided. */
  const waiting = async (t: Db, orderId: string, kinds: string[]) => {
    const [a] = await t.query<{ kind: string }>(`select kind from approval where status = 'pending' and kind = any($1) and payload->>'orderId' = $2 limit 1`, [kinds, orderId])
    if (a) throw new HttpError(409, a.kind === 'fnb.void_after_kot'
      ? 'An item cancelled on this order waits for the F&B manager. Ask them to approve or reject it under Approvals first.'
      : 'The discount on this bill waits for a manager. Ask them to approve or reject it under Approvals before taking payment.')
  }

  app.post('/api/fnb/orders/:id/bill', async (req, reply) => {
    const who = await biller(req)
    const { id } = req.params as { id: string }
    await waiting(db, id, ['fnb.void_after_kot'])
    const b = (req.body ?? {}) as { parts?: number; groups?: string[][]; discountPercent?: number; discountReason?: string; serviceCharge?: boolean; billTo?: BillTo }
    const discount = b.discountPercent ?? 0
    if (!(discount >= 0 && discount <= 100)) throw new HttpError(400, 'Discount: 0–100%.')
    if (discount > 0 && !b.discountReason?.trim()) throw new HttpError(400, 'Give a reason for the discount.')
    if (b.billTo) {
      if (!b.billTo.company?.trim()) throw new HttpError(400, 'Company name is required for a company bill.')
      if (b.billTo.gstin) {
        const v = validateGstin(b.billTo.gstin)
        if (!v.ok) throw new HttpError(400, v.reason)
        b.billTo.gstin = v.gstin
      }
    }
    return db.tx(async (t) => {
      const o = await orderFor(t, id)
      if (o.status === 'billed') {
        const [settled] = await t.query(`select 1 from fnb_bill where order_id = $1 and status = 'settled'`, [id])
        if (settled) throw new HttpError(409, 'Part of this order is already paid. Settle the remaining bills.')
        await t.query(`update fnb_bill set status = 'void' where order_id = $1 and status = 'open'`, [id])
      } else if (o.status !== 'open') throw new HttpError(409, `Order ${o.number} is ${o.status}.`)
      const items = await liveItems(t, id)
      if (!items.length) throw new HttpError(409, 'Nothing to bill.')
      if (items.some((i) => i.status === 'pending')) throw new HttpError(409, 'Send or remove the items not yet sent to the kitchen first.')

      let plan: { itemIds: string[] | null; share: [number, number] }[]
      if (b.groups) {
        const all = b.groups.flat()
        if (b.groups.some((g) => !g.length) || new Set(all).size !== all.length || all.length !== items.length || !items.every((i) => all.includes(i.id))) {
          throw new HttpError(400, 'Put every item on exactly one bill.')
        }
        plan = b.groups.map((g) => ({ itemIds: g, share: [1, 1] }))
      } else {
        const parts = b.parts ?? 1
        if (!(Number.isInteger(parts) && parts >= 1 && parts <= 20)) throw new HttpError(400, 'Split into 1–20 bills.')
        plan = Array.from({ length: parts }, (_, i) => ({ itemIds: null, share: [i + 1, parts] }))
      }
      const [p] = await t.query<{ service_charge_percent: string }>('select service_charge_percent from property limit 1')
      const service = b.serviceCharge === false ? 0 : Number(p.service_charge_percent)
      const limit = await discountLimit(t, who)
      const applied = discount <= limit ? discount : 0
      const bills = []
      for (const [n, part] of plan.entries()) {
        const its = part.itemIds ? items.filter((i) => part.itemIds!.includes(i.id)) : items
        const a = await computeBill(ctx, t, o, its, part.share, applied, service)
        const billId = newId('BILL')
        await t.query(
          `insert into fnb_bill (id, order_id, part, parts, item_ids, share_num, share_den, discount_percent, discount_reason, service_percent, bill_to, amounts, total_paise, created_by, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [billId, id, n + 1, plan.length, part.itemIds, part.share[0], part.share[1], applied, applied ? b.discountReason!.trim() : null, service,
            b.billTo ? JSON.stringify(b.billTo) : null, JSON.stringify(a), a.payable, who.userId, now()])
        bills.push({ id: billId, part: n + 1, amounts: a })
      }
      await t.query(`update fnb_order set status = 'billed' where id = $1`, [id])
      await appendAudit(t, { actor: who, action: 'fnb_bill.create', entity: { type: 'fnb_order', id }, amount: bills.reduce((a, x) => a + x.amounts.payable, 0),
        after: { order: o.number, bills: bills.length, discountPercent: applied, servicePercent: service, company: b.billTo?.company ?? null } }, now())
      if (discount > applied) {
        const approvalId = await createApproval(ctx, t, 'fnb.discount', who.userId, { orderId: id, order: o.number, outlet: o.outlet, percent: discount, reason: b.discountReason }, b.discountReason)
        await appendAudit(t, { actor: who, action: 'fnb_bill.discount_requested', entity: { type: 'fnb_order', id }, after: { percent: discount, limit }, note: b.discountReason }, now())
        return reply.status(202).send({ bills, pending: true, approvalId, message: `A ${discount}% discount is above your ${limit}% limit and waits for a manager. The bill shows no discount until then.` })
      }
      // A bill with liquor is not made (or printed with a UPI QR) until the VAT set-up lets it be paid.
      const missing = [...new Set(bills.flatMap((x) => x.amounts.vatMissing))]
      if (missing.length) throw new HttpError(409, `Set the TN VAT rate for ${missing.join(', ')} under Settings → Licences & tax first, then make the bill.`)
      if (bills.some((x) => x.amounts.liquor.length)) {
        const tin = (await licencesFor(t, 'vat_bill')).find((l) => l.kind === 'tn_vat')
        if (!tin) throw new HttpError(409, 'Add the TN VAT registration (TIN) under Settings → Licences & tax first: every liquor bill prints it.')
      }
      return reply.status(201).send({ bills })
    })
  })

  app.post('/api/fnb/orders/:id/unbill', async (req) => {
    const who = await biller(req)
    const { id } = req.params as { id: string }
    return db.tx(async (t) => {
      const o = await orderFor(t, id)
      if (o.status !== 'billed') throw new HttpError(409, 'This order has no open bill.')
      const [settled] = await t.query(`select 1 from fnb_bill where order_id = $1 and status = 'settled'`, [id])
      if (settled) throw new HttpError(409, 'Part of this order is already paid.')
      await t.query(`update fnb_bill set status = 'void' where order_id = $1 and status = 'open'`, [id])
      await t.query(`update fnb_order set status = 'open' where id = $1`, [id])
      await appendAudit(t, { actor: who, action: 'fnb_bill.cancel', entity: { type: 'fnb_order', id }, after: { order: o.number } }, now())
      return { ok: true }
    })
  })

  app.get('/api/fnb/orders/:id/bills', async (req) => {
    await requireCaller(ctx, req)
    return db.query(
      `select b.id, b.part, b.parts, b.status, b.discount_percent, b.discount_reason, b.service_percent, b.bill_to, b.amounts, b.total_paise, b.prints,
              g.number as gst_number, v.number as vat_number, b.reservation_id, b.settled_at,
              coalesce((select json_agg(json_build_object('method', p.method, 'amount', p.amount_paise, 'reference', p.reference)) from fnb_payment p where p.bill_id = b.id), '[]') as payments
         from fnb_bill b left join tax_document g on g.id = b.gst_document_id left join vat_invoice v on v.id = b.vat_invoice_id
        where b.order_id = $1 and b.status <> 'void' order by b.part`, [(req.params as { id: string }).id])
  })

  // Settle a bill: payments that add up to the bill, or the whole bill to a checked-in guest's room.
  app.post('/api/fnb/bills/:id/settle', async (req) => {
    const who = await biller(req)
    const { id } = req.params as { id: string }
    const b = req.body as { payments?: { method: string; amount: number; reference?: string }[]; reservationId?: string }
    if (!Array.isArray(b?.payments) || !b.payments.length) throw new HttpError(400, 'Send payments: method and amount (₹).')
    for (const p of b.payments) {
      if (!METHODS.includes(p.method as typeof METHODS[number]) || !(p.amount > 0)) throw new HttpError(400, `Each payment needs a method (${METHODS.join(', ')}) and an amount.`)
      if ((p.method === 'card' || p.method === 'upi') && !p.reference?.trim()) throw new HttpError(400, 'Card and UPI payments need a reference (slip or UTR number).')
    }
    const toRoom = b.payments.some((p) => p.method === 'room')
    if (toRoom && b.payments.length > 1) throw new HttpError(400, 'Charge the whole bill to the room, or take payment for all of it.')

    const result = await db.tx(async (t): Promise<{ blocked: string } | Record<string, unknown>> => {
      const [bill] = await t.query<BillRow>('select * from fnb_bill where id = $1 for update', [id])
      if (!bill) throw new HttpError(404, 'No such bill.')
      if (bill.status !== 'open') throw new HttpError(409, `This bill is ${bill.status}.`)
      await waiting(t, bill.order_id, ['fnb.void_after_kot', 'fnb.discount'])
      const o = await orderFor(t, bill.order_id)
      const a = bill.amounts
      if (a.vatMissing.length) throw new HttpError(409, `Set the TN VAT rate for ${a.vatMissing.join(', ')} (Licences & tax) before billing liquor.`)
      const day = await businessDate(t)
      const fy = financialYear(day)
      const sup = await supplier(t)
      const { prefix: _prefix, ...supplierSnap } = sup

      let reservation: { id: string; guest: string; room_no: string | null; folio_id: string } | null = null
      if (toRoom) {
        const resId = b.reservationId ?? o.reservation_id
        const [r] = await t.query<{ id: string; status: string; guest: string; room_no: string | null; folio_id: string }>(
          `select r.id, r.status, g.name as guest, s.room_no, (select f.id from folio f where f.reservation_id = r.id and f.status = 'open' order by f.created_at limit 1) as folio_id
             from reservation r join guest g on g.id = r.guest_id left join space s on s.id = r.space_id where r.id = $1`, [resId])
        if (!r) throw new HttpError(400, 'Choose the guest whose room this goes to.')
        if (r.status !== 'in_house' || !r.folio_id) throw new HttpError(409, 'Only checked-in guests can charge to their room.')
        reservation = r
      } else {
        const paid = b.payments!.reduce((s, p) => s + rupees(p.amount), 0)
        if (paid !== a.payable) throw new HttpError(400, `Payments add up to ${formatInr(paid)}; the bill is ${formatInr(a.payable)}.`)
        if (b.payments!.some((p) => p.method === 'company') && !bill.bill_to) throw new HttpError(400, 'A company credit bill needs the company\'s name on the bill.')
      }

      let shiftId: string | null = null
      const cash = b.payments!.filter((p) => p.method === 'cash').reduce((s, p) => s + rupees(p.amount), 0)
      if (cash) {
        const [s] = await t.query<{ id: string }>('select id from cashier_shift where user_id = $1 and closed_at is null', [who.userId])
        if (!s) throw new HttpError(409, 'Open your cashier shift before taking cash.')
        shiftId = s.id
        const check = cashReceiptCheck(ctx.tax, cash, 0)
        if (!check.allowed) return { blocked: check.message! }
      }

      const label = `${o.outlet} · Order ${o.number}${bill.parts > 1 ? ` · bill ${bill.part}/${bill.parts}` : ''}`
      const recipient: Party = bill.bill_to
        ? { name: bill.bill_to.company, gstin: bill.bill_to.gstin ?? null, address: bill.bill_to.address ?? null, city: bill.bill_to.city ?? null, pin: bill.bill_to.pin ?? null, stateCode: bill.bill_to.gstin ? bill.bill_to.gstin.slice(0, 2) : null }
        : { name: reservation ? reservation.guest : 'Walk-in guest', gstin: null, address: null, city: null, pin: null, stateCode: null }

      // Food: a GST invoice now, or (charged to the room) lines on the room bill that the stay invoice includes.
      let gst: { id: string; number: string } | null = null
      const foodLines = a.food.filter((l) => l.taxable > 0)
      if (foodLines.length && !reservation) {
        const lines: DocLine[] = foodLines.map((l, i) => ({ slNo: i + 1, description: l.description, sac: ctx.tax.gst.restaurant.sac, qty: 1, gstRate: a.gstRate, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, total: l.total }))
        gst = await issue(ctx, t, who, { docType: 'fnb_invoice', reservationId: null, recipient, lines })
      }
      if (foodLines.length && reservation) {
        for (const l of foodLines) {
          await t.query(
            `insert into folio_line (id, folio_id, business_date, posted_at, kind, description, sac, gst_rate, taxable_paise, cgst_paise, sgst_paise, amount_paise, posted_by, ref)
             values ($1,$2,$3,$4,'fnb',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [newId('L'), reservation.folio_id, day, now(), `${label} · ${l.description}`, ctx.tax.gst.restaurant.sac, a.gstRate, l.taxable, l.cgst, l.sgst, l.total, who.userId, bill.id])
        }
      }

      // Liquor: always its own TN VAT invoice, which needs the resort's VAT registration.
      let vat: { id: string; number: string } | null = null
      if (a.liquor.length) {
        const [tin] = await licencesFor(t, 'vat_bill').then((ls) => ls.filter((l) => l.kind === 'tn_vat'))
        if (!tin) throw new HttpError(409, 'Add the TN VAT registration (TIN) under Licences & tax before billing liquor.')
        const fl3 = (await licencesFor(t, 'vat_bill')).find((l) => l.kind === 'fl3')
        const number = await nextSeriesNumber(t, 'vat_invoice', fy, 'VAT')
        const vid = randomUUID()
        await t.query(
          `insert into vat_invoice (id, number, fy, issue_date, seller, buyer, lines, taxable_paise, vat_paise, total_paise, amount_in_words, issued_by, issued_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [vid, number, fy, day, JSON.stringify({ ...supplierSnap, tin: tin.number, barLicence: fl3?.number ?? null }), JSON.stringify({ name: recipient.name }),
            JSON.stringify(a.liquor), a.liquorTaxable, a.vat, a.liquorTaxable + a.vat, amountInWords(a.liquorTaxable + a.vat), who.userId, now()])
        vat = { id: vid, number }
        await appendAudit(t, { actor: who, action: 'vat_invoice.issue', entity: { type: 'vat_invoice', id: vid }, amount: a.liquorTaxable + a.vat, after: { number, vat: a.vat } }, now())
        if (reservation) {
          await t.query(
            `insert into folio_line (id, folio_id, business_date, posted_at, kind, description, amount_paise, posted_by, ref)
             values ($1,$2,$3,$4,'liquor',$5,$6,$7,$8)`,
            [newId('L'), reservation.folio_id, day, now(), `${label} · liquor (VAT invoice ${number})`, a.liquorTaxable + a.vat, who.userId, number])
        }
      }

      const payments = reservation ? [{ method: 'room', amount: (a.total) / 100, reference: `Room ${reservation.room_no ?? ''}`.trim() }] : b.payments!
      // Credit to a company: within its limit, on its city-ledger account.
      const credit = payments.filter((p) => p.method === 'company').reduce((a, p) => a + rupees(p.amount), 0)
      const debtorId = credit && bill.bill_to ? await debtorFor(t, bill.bill_to.company, bill.bill_to.gstin, now()) : null
      if (debtorId) await checkCredit(t, debtorId, credit)
      for (const p of payments) {
        await t.query('insert into fnb_payment (id, bill_id, method, amount_paise, reference, shift_id, received_by, business_date, at, debtor_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [newId('FP'), id, p.method, rupees(p.amount), p.reference?.trim() || null, p.method === 'cash' ? shiftId : null, who.userId, day, now(), p.method === 'company' ? debtorId : null])
      }
      await t.query(`update fnb_bill set status = 'settled', gst_document_id = $2, vat_invoice_id = $3, reservation_id = $4, settled_by = $5, settled_at = $6 where id = $1`,
        [id, gst?.id ?? null, vat?.id ?? null, reservation?.id ?? null, who.userId, now()])
      const [{ open }] = await t.query<{ open: number }>(`select count(*)::int as open from fnb_bill where order_id = $1 and status = 'open'`, [o.id])
      if (!open) await t.query(`update fnb_order set status = 'closed', closed_at = $2 where id = $1`, [o.id, now()])
      await appendAudit(t, { actor: who, action: reservation ? 'fnb_bill.charge_to_room' : 'fnb_bill.settle', entity: { type: 'fnb_bill', id }, amount: reservation ? a.total : a.payable,
        after: { order: o.number, gstInvoice: gst?.number ?? null, vatInvoice: vat?.number ?? null, methods: payments.map((p) => p.method), room: reservation?.room_no ?? null } }, now())
      return { ok: true, gstInvoice: gst?.number ?? null, vatInvoice: vat?.number ?? null, orderClosed: !open, roomBalance: reservation ? await folioBalance(t, reservation.folio_id) : null }
    })
    if ('blocked' in result) {
      await appendAudit(db, { actor: who, action: 'payment.cash_blocked', entity: { type: 'fnb_bill', id }, note: String(result.blocked) }, now())
      throw new HttpError(403, String(result.blocked))
    }
    return result
  })

  // Merge another open order of the same outlet into this one (guests joining tables).
  app.post('/api/fnb/orders/:id/merge', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'fnb.order')) throw new HttpError(403, 'Your role cannot do this.')
    const { id } = req.params as { id: string }
    const from = (req.body as { fromOrderId?: string })?.fromOrderId
    if (!from || from === id) throw new HttpError(400, 'Choose the other order to merge.')
    return db.tx(async (t) => {
      const target = await orderFor(t, id), source = await orderFor(t, from)
      if (target.status !== 'open' || source.status !== 'open') throw new HttpError(409, 'Both orders must be open (not billed).')
      if (target.outlet_id !== source.outlet_id) throw new HttpError(409, 'Only orders of the same outlet can be merged.')
      await t.query('update order_item set order_id = $1 where order_id = $2', [id, from])
      await t.query('update kot set order_id = $1 where order_id = $2', [id, from])
      await t.query('update fnb_order set covers = covers + $2 where id = $1', [id, source.covers])
      await t.query(`update fnb_order set status = 'cancelled', closed_at = $2, note = $3 where id = $1`, [from, now(), `Merged into order ${target.number}`])
      await appendAudit(t, { actor: who, action: 'order.merge', entity: { type: 'fnb_order', id }, after: { into: target.number, from: source.number } }, now())
      return { ok: true }
    })
  })

  // One print of a bill: counted, and logged as a duplicate from the second time.
  async function loadForPrint(t: Db, id: string, who: Caller) {
    const [bill] = await t.query<BillRow & { prints: number }>('update fnb_bill set prints = prints + 1 where id = $1 returning *', [id])
    if (!bill) throw new HttpError(404, 'No such bill.')
    const [o] = await t.query<{ number: number; outlet: string; outlet_id: string; bill_printer_id: string | null; table_label: string | null; covers: number; captain: string }>(
      `select o.number, ot.name as outlet, ot.id as outlet_id, ot.bill_printer_id, tb.label as table_label, o.covers, u.name as captain from fnb_order o join outlet ot on ot.id = o.outlet_id
         join app_user u on u.id = o.opened_by left join dining_table tb on tb.id = o.table_id where o.id = $1`, [bill.order_id])
    const [p] = await t.query<{ legal_name: string | null; name: string; gstin: string | null; address: string | null; city: string | null; pin: string | null; upi_vpa: string | null; upi_payee: string | null }>(
      'select legal_name, name, gstin, address, city, pin, upi_vpa, upi_payee from property limit 1')
    const lic = [...await licencesFor(t, 'fnb_bill'), ...(bill.amounts.liquor.length ? await licencesFor(t, 'vat_bill') : [])]
      .filter((l, i, all) => all.findIndex((x) => x.kind === l.kind) === i)
    const [g] = bill.gst_document_id ? await t.query<{ number: string }>('select number from tax_document where id = $1', [bill.gst_document_id]) : []
    const [v] = bill.vat_invoice_id ? await t.query<{ number: string }>('select number from vat_invoice where id = $1', [bill.vat_invoice_id]) : []
    if (bill.prints > 1) await appendAudit(t, { actor: who, action: 'fnb_bill.reprint', entity: { type: 'fnb_bill', id }, after: { prints: bill.prints, order: o.number } }, now())
    return { bill, o, p, lic, gstNo: g?.number ?? null, vatNo: v?.number ?? null }
  }

  // Printable bill: the guest check with a UPI QR before payment; the tax invoice and VAT invoice after.
  app.post('/api/fnb/bills/:id/print', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'fnb.bill') && !can(who, 'fnb.order')) throw new HttpError(403, 'Your role cannot print bills.')
    const html = await db.tx(async (t) => {
      const x = await loadForPrint(t, (req.params as { id: string }).id, who)
      return billHtml(x.bill, x.o, x.p, x.lic, x.gstNo, x.vatNo)
    })
    return reply.type('text/html; charset=utf-8').send(html)
  })

  // The same bill on the outlet's thermal printer, through the print agent.
  app.post('/api/fnb/bills/:id/print-job', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'fnb.bill') && !can(who, 'fnb.order')) throw new HttpError(403, 'Your role cannot print bills.')
    return db.tx(async (t) => {
      const { bill, o, p, lic, gstNo, vatNo } = await loadForPrint(t, (req.params as { id: string }).id, who)
      if (!o.bill_printer_id) throw new HttpError(409, `${o.outlet} has no bill printer. Choose one under Menu → Printers.`)
      const [pr] = await t.query<{ width: number }>('select width from printer where id = $1', [o.bill_printer_id])
      const a = bill.amounts
      const doc = billDoc({
        heading: [p.legal_name ?? p.name, o.outlet, [p.address, p.city, p.pin].filter(Boolean).join(', '), ...(p.gstin ? [`GSTIN ${p.gstin}`] : []),
          ...lic.map((l) => `${l.kind === 'fssai' ? 'FSSAI Lic. No.' : l.kind === 'tn_vat' ? 'TN VAT TIN' : l.kind === 'fl3' ? 'FL-3 Licence' : l.name} ${l.number}`)],
        duplicate: bill.prints > 1, title: gstNo ? `Tax Invoice ${gstNo}` : 'Food & beverages (SAC 996331)',
        meta: `Order ${o.number}${o.table_label ? ` - Table ${o.table_label}` : ''} - ${o.covers} pax - ${o.captain}${bill.parts > 1 ? ` - Bill ${bill.part}/${bill.parts}` : ''}`,
        food: a.food.map((l) => ({ description: l.description, amount: l.gross })),
        foodTotals: a.food.length ? [...(a.foodDiscount ? [[`Discount ${Number(bill.discount_percent)}%`, -a.foodDiscount] as [string, number]] : []), ['Taxable value', a.foodTaxable], [`CGST ${a.gstRate / 2}%`, a.cgst], [`SGST ${a.gstRate / 2}%`, a.sgst]] : [],
        liquor: a.liquor.map((l) => ({ description: l.description, amount: l.gross })),
        liquorTotals: a.liquor.length ? [['Value', a.liquorTaxable], ['TN VAT', a.vat]] : [],
        total: a.total, roundOff: a.roundOff, payable: a.payable, words: amountInWords(a.payable),
        footer: [...(vatNo ? [`VAT Invoice ${vatNo}`] : []), ...(a.service ? ['Service charge is optional.'] : []), bill.status === 'settled' ? 'Paid - thank you' : 'Thank you'],
      }, pr.width)
      const jobId = await queueDoc(t, o.bill_printer_id, 'bill', `Bill order ${o.number}`, doc, now())
      return reply.status(201).send({ jobId })
    })
  })
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const money = (p: number) => formatInr(p).replace('₹', '')

function billHtml(bill: BillRow, o: { number: number; outlet: string; table_label: string | null; covers: number; captain: string },
  p: { legal_name: string | null; name: string; gstin: string | null; address: string | null; city: string | null; pin: string | null; upi_vpa: string | null; upi_payee: string | null },
  lic: { kind: string; name: string; number: string }[], gstNo: string | null, vatNo: string | null) {
  const a = bill.amounts
  const settled = bill.status === 'settled'
  let qr = ''
  if (!settled && p.upi_vpa) {
    const q = qrcode(0, 'M')
    q.addData(upiLink(p.upi_vpa, p.upi_payee ?? p.name, a.payable, `${o.outlet} order ${o.number}`))
    q.make()
    qr = `<div class="qr">${q.createSvgTag({ cellSize: 3, margin: 2, scalable: true })}<div>Scan to pay ₹${money(a.payable)} by UPI</div></div>`
  }
  const row = (l: string, r: string, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="n">${r}</td></tr>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(o.outlet)} bill · order ${o.number}</title><style>
  @page { size: 80mm auto; margin: 4mm; }
  body { font: 12.5px/1.4 ui-monospace, Menlo, monospace; width: 72mm; margin: 0 auto; color: #000; }
  h1 { font-size: 15px; text-align: center; margin: 0; } .c { text-align: center; } .s { font-size: 11px; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0; } td { padding: 1px 0; vertical-align: top; } td.n { text-align: right; white-space: nowrap; padding-left: 6px; }
  .rule td { border-top: 1px dashed #000; } .big td { font-size: 15px; font-weight: 700; } h2 { font-size: 13px; margin: 8px 0 2px; border-top: 1px dashed #000; padding-top: 6px; }
  .qr { text-align: center; margin: 8px 0; } .qr svg { width: 40mm; height: 40mm; } .copy { text-align: center; font-weight: 700; }
</style></head><body>
<h1>${esc(p.legal_name ?? p.name)}</h1>
<div class="c s">${esc(o.outlet)}<br>${[p.address, p.city, p.pin].filter(Boolean).map(esc).join(', ')}${p.gstin ? `<br>GSTIN ${esc(p.gstin)}` : ''}
${lic.map((l) => `<br>${esc(l.kind === 'fssai' ? 'FSSAI Lic. No.' : l.kind === 'tn_vat' ? 'TN VAT TIN' : l.kind === 'fl3' ? 'FL-3 Licence' : l.name)} ${esc(l.number)}`).join('')}</div>
${bill.prints > 1 ? '<div class="copy">DUPLICATE COPY</div>' : ''}
<div class="s">Order ${o.number}${o.table_label ? ` · Table ${esc(o.table_label)}` : ''} · ${o.covers} pax · ${esc(o.captain)}${bill.parts > 1 ? ` · Bill ${bill.part} of ${bill.parts}` : ''}</div>
${bill.bill_to ? `<div class="s">Billed to: ${esc(bill.bill_to.company)}${bill.bill_to.gstin ? ` · GSTIN ${esc(bill.bill_to.gstin)}` : ''}</div>` : ''}
${a.food.length ? `<h2>${gstNo ? `Tax Invoice ${esc(gstNo)}` : 'Food &amp; beverages'}</h2><div class="s">SAC 996331 · Restaurant service</div><table>
${a.food.map((l) => row(esc(l.description), money(l.gross))).join('')}
${a.foodDiscount ? row(`Discount ${Number(bill.discount_percent)}%${bill.discount_reason ? ` (${esc(bill.discount_reason)})` : ''}`, '-' + money(a.foodDiscount)) : ''}
${row('Taxable value', money(a.foodTaxable), 'rule')}${row(`CGST ${a.gstRate / 2}%`, money(a.cgst))}${row(`SGST ${a.gstRate / 2}%`, money(a.sgst))}</table>` : ''}
${a.liquor.length ? `<h2>${vatNo ? `VAT Invoice ${esc(vatNo)}` : 'Liquor'} (TN VAT)</h2><table>
${a.liquor.map((l) => row(esc(l.description), money(l.gross))).join('')}
${a.liquorDiscount ? row(`Discount ${Number(bill.discount_percent)}%`, '-' + money(a.liquorDiscount)) : ''}
${row('Value', money(a.liquorTaxable), 'rule')}${[...new Set(a.liquor.map((l) => l.vatRate))].map((r) => row(`VAT ${r ?? '—'}%`, money(a.liquor.filter((l) => l.vatRate === r).reduce((s, l) => s + l.vat, 0)))).join('')}</table>` : ''}
<table>${row('Total', money(a.total), 'rule')}${a.roundOff ? row('Round off', money(a.roundOff)) : ''}${row('Amount payable', '₹' + money(a.payable), 'big')}</table>
<div class="s">${esc(amountInWords(a.payable))}</div>
${a.service ? '<div class="s">Service charge is optional. Ask us and we will remove it.</div>' : ''}
${settled ? `<div class="c s">Paid · thank you</div>` : qr}
<div class="c s">Place of supply: ${esc(stateName('33'))}</div>
<script>window.onload = () => window.print()</script></body></html>`
}
