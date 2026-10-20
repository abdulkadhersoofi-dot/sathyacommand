import type { FastifyInstance, FastifyRequest } from 'fastify'
import { cashExpenseCheck, financialYear, msmePaymentDue, tdsOnPayment, type PayeeType } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, daysBetween, istDay, newId } from '../eng-core'
import { nextSeriesNumber } from '../invoicing'
import { createApproval, registerApprovalKind, roleLimit } from './approvals'
import { requireCaller } from './auth'

// Vendor bills matched three ways (the PO's rate, the quantity received and accepted, what is already
// billed), approved for payment, and paid with TDS deducted by the vendor's category. Micro and small
// suppliers must be paid within 15 days (45 with a written agreement) or the expense is not deductible:
// their due dates are tracked and alerted ten days ahead.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const HOME_STATE = '33'
const SYSTEM: Caller = { userId: 'system', name: 'System', role: 'system', roles: [], godMode: false, permissions: new Set(), sessionId: '', scope: 'full' }
const quarterOf = (day: string) => { const m = Number(day.slice(5, 7)); return m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 && m <= 12 ? 3 : 4 }

registerApprovalKind('purchase.payment', {
  permission: 'purchase.approve',
  async apply(t, p, decider, ctx) {
    const [x] = await t.query<{ status: string }>('select status from vendor_payment where id = $1 for update', [p.paymentId])
    if (x?.status !== 'pending_approval') throw new HttpError(409, 'This payment is no longer waiting for approval.')
    await t.query(`update vendor_payment set status = 'approved' where id = $1`, [p.paymentId])
    await appendAudit(t, { actor: decider, action: 'payment.approved', entity: { type: 'vendor_payment', id: String(p.paymentId) } }, ctx.now())
  },
  async reject(t, p) { await t.query(`update vendor_payment set status = 'cancelled' where id = $1 and status = 'pending_approval'`, [p.paymentId]) },
})

/** MSME payments falling due within ten days, alerted once per bill. */
export async function sweepPayables(db: Db, now: Date) {
  const today = istDay(now)
  await db.tx(async (t) => {
    const due = await t.query<{ id: string; bill_no: string; vendor: string; msme_due_date: string; balance: string }>(
      `select b.id, b.bill_no, v.name as vendor, b.msme_due_date::text, (b.total_paise - b.paid_paise) as balance from purchase_bill b join vendor v on v.id = b.vendor_id
        where b.msme_due_date is not null and not b.msme_alerted and b.status in ('entered', 'approved', 'partly_paid') and b.msme_due_date <= $1::date + 10`, [today])
    for (const b of due) {
      await t.query('update purchase_bill set msme_alerted = true where id = $1', [b.id])
      await appendAudit(t, { actor: SYSTEM, action: 'msme.payment_due', entity: { type: 'purchase_bill', id: b.id }, amount: Number(b.balance),
        after: { vendor: b.vendor, bill: b.bill_no, due: b.msme_due_date, daysLeft: daysBetween(today, b.msme_due_date) } }, now)
    }
  })
}

export function payablesRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }

  // ---------- bills ----------
  interface BillLineIn { itemId?: string; description?: string; sac?: string; qty: number; rate: number; gstRate?: number; rcm?: boolean; accountCode?: string }

  app.post('/api/bills', async (req, reply) => {
    const who = await need(req, 'purchase.bill')
    const b = (req.body ?? {}) as { vendorId?: string; billNo?: string; billDate?: string; poId?: string; grnIds?: string[]; lines?: BillLineIn[]; roundOff?: number; photoId?: string; eventId?: string }
    if (!b.billNo?.trim()) throw new HttpError(400, 'Enter the vendor\'s bill number.')
    if (!DATE.test(b.billDate ?? '') || b.billDate! > istDay(now())) throw new HttpError(400, 'Bill date (not in the future).')
    if (!Array.isArray(b.lines) || !b.lines.length) throw new HttpError(400, 'Enter the lines of the bill.')
    if (b.roundOff != null && Math.abs(b.roundOff) > 1) throw new HttpError(400, 'Round-off is at most ₹1.')
    return db.tx(async (t) => {
      const [v] = await t.query<{ name: string; state_code: string; msme: string; written_agreement: boolean; payment_terms_days: number }>('select * from vendor where id = $1', [b.vendorId])
      if (!v) throw new HttpError(404, 'No such vendor.')
      // A supplier's bill for a banquet event (decor, DJ…) is tied to the event, for its cost (Phase 7).
      if (b.eventId) { const [ev] = await t.query('select 1 from event where id = $1', [b.eventId]); if (!ev) throw new HttpError(404, 'No such event.') }
      const [dup] = await t.query('select 1 from purchase_bill where vendor_id = $1 and upper(bill_no) = upper($2)', [b.vendorId, b.billNo!.trim()])
      if (dup) throw new HttpError(409, `Bill ${b.billNo} from ${v.name} is already entered.`)
      let grnIds = b.grnIds ?? []
      let poId = b.poId ?? null
      if (poId && !grnIds.length) grnIds = (await t.query<{ id: string }>('select id from grn where po_id = $1', [poId])).map((g) => g.id)
      const grns = grnIds.length ? await t.query<{ id: string; vendor_id: string; po_id: string | null; number: string }>('select id, vendor_id, po_id, number from grn where id = any($1)', [grnIds]) : []
      if (grns.length !== grnIds.length || grns.some((g) => g.vendor_id !== b.vendorId)) throw new HttpError(400, 'The goods receipts must be from this vendor.')
      poId ??= grns.find((g) => g.po_id)?.po_id ?? null
      const igst = v.state_code !== HOME_STATE
      const id = newId('PB')
      // The bill first, so its lines can refer to it; totals and the match are filled in below.
      await t.query(`insert into purchase_bill (id, vendor_id, bill_no, bill_date, po_id, grn_ids, taxable_paise, total_paise, due_date, match, entered_by, entered_at)
                     values ($1,$2,$3,$4,$5,$6,0,0,$4,'matched',$7,$8)`, [id, b.vendorId, b.billNo!.trim(), b.billDate, poId, grnIds, who.userId, now()])
      if (b.eventId) await t.query('update purchase_bill set event_id = $2 where id = $1', [id, b.eventId])
      let n = 0, taxable = 0, gst = 0, itc = 0, rcm = 0
      const differences: string[] = []
      const lines: { line: number; item_id: string | null; description: string | null; qty: number; rate: number; amount: number; tax: number }[] = []
      for (const l of b.lines!) {
        const qty = Number(l.qty), rate = Math.round(Number(l.rate) * 100)
        if (!(qty > 0) || !(rate >= 0)) throw new HttpError(400, 'Each line needs a quantity and a rate.')
        let item: { id: string; name: string; gst_rate: string | null; itc: string } | null = null
        if (l.itemId) {
          [item] = await t.query('select id, name, gst_rate, itc from item where id = $1', [l.itemId])
          if (!item) throw new HttpError(404, 'No such item.')
        } else if (!l.description?.trim()) throw new HttpError(400, 'A line is either an item or a described service.')
        const gstRate = l.gstRate ?? (item?.gst_rate != null ? Number(item.gst_rate) : null)
        if (gstRate == null || ![0, 0.25, 3, 5, 12, 18, 28, 40].includes(gstRate)) throw new HttpError(400, `${item?.name ?? l.description}: the GST rate on the bill.`)
        if (item && item.gst_rate != null && Number(item.gst_rate) !== gstRate) differences.push(`${item.name}: billed at ${gstRate}% GST, the item is ${Number(item.gst_rate)}%`)
        const amount = Math.round(qty * rate), tax = Math.round((amount * gstRate) / 100)
        const lineItc = item?.itc ?? 'full'
        // Reverse charge (security agency, goods transport, advocate, rent from an unregistered landlord, sponsorship):
        // the vendor charges no GST; the resort pays it to the government, and claims it back where allowed.
        if (l.rcm && item) throw new HttpError(400, `${item.name}: reverse charge applies to the services the law lists, not to goods.`)
        if (l.rcm && !gstRate) throw new HttpError(400, `${l.description}: the GST rate the resort pays under reverse charge.`)
        // A service line can be charged to a chosen account: a fixed asset bought (capitalised), or a particular expense.
        if (l.accountCode) {
          if (item) throw new HttpError(400, `${item.name}: stock items go to purchases; choose an account only for other lines.`)
          const [a] = await t.query<{ type: string }>('select type from account where code = $1 and active', [l.accountCode])
          if (!a || !['asset', 'expense'].includes(a.type)) throw new HttpError(400, `${l.description}: choose an expense or asset account.`)
        }
        await t.query('insert into bill_line (bill_id, line, item_id, description, sac, qty, rate_paise, gst_rate, amount_paise, gst_paise, itc, rcm, account_code) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
          [id, ++n, item?.id ?? null, l.description?.trim() || null, l.sac?.trim() || null, qty, rate, gstRate, amount, tax, lineItc, !!l.rcm, l.accountCode || null])
        taxable += amount
        if (l.rcm) rcm += tax; else gst += tax
        if (lineItc === 'full') itc += tax
        lines.push({ line: n, item_id: item?.id ?? null, description: item?.name ?? l.description!, qty, rate, amount, tax })
      }
      // Three-way match: each item against the PO's rate and against what was received and not yet billed.
      for (const l of lines.filter((x) => x.item_id)) {
        if (poId) {
          const [pl] = await t.query<{ rate_paise: string }>('select rate_paise from po_line where po_id = $1 and item_id = $2 order by line limit 1', [poId, l.item_id])
          if (!pl) differences.push(`${l.description}: not on the purchase order`)
          else if (l.rate > Number(pl.rate_paise)) differences.push(`${l.description}: billed at ₹${(l.rate / 100).toFixed(2)}, ordered at ₹${(Number(pl.rate_paise) / 100).toFixed(2)}`)
        }
        if (grnIds.length) {
          const gl = await t.query<{ grn_id: string; line: number; open: string }>(
            `select grn_id, line, (qty_accepted - billed_qty) as open from grn_line where grn_id = any($1) and item_id = $2 and qty_accepted > billed_qty order by grn_id, line for update`, [grnIds, l.item_id])
          let left = l.qty
          for (const g of gl) {
            const take = Math.min(left, Number(g.open))
            if (take <= 0) break
            await t.query('update grn_line set billed_qty = billed_qty + $3 where grn_id = $1 and line = $2', [g.grn_id, g.line, take])
            left -= take
          }
          if (left > 0.0005) differences.push(`${l.description}: billed ${l.qty}, received and not yet billed ${Number((l.qty - left).toFixed(3))}`)
        }
      }
      const roundOff = Math.round(Number(b.roundOff ?? 0) * 100)
      const total = taxable + gst + roundOff
      const cgst = igst ? 0 : Math.floor(gst / 2), sgst = igst ? 0 : gst - cgst
      let due = addDays(b.billDate!, v.payment_terms_days)
      let msmeDue: string | null = null
      if (v.msme === 'micro' || v.msme === 'small') {
        msmeDue = msmePaymentDue(ctx.tax, b.billDate!, v.written_agreement).dueDate
        if (msmeDue < due) due = msmeDue
      }
      const match = !poId && !grnIds.length ? 'no_po' : differences.length ? 'difference' : 'matched'
      await t.query(
        `update purchase_bill set taxable_paise = $2, cgst_paise = $3, sgst_paise = $4, igst_paise = $5, round_off_paise = $6, total_paise = $7, itc_paise = $8, due_date = $9,
                msme_due_date = $10, match = $11, differences = $12, photo_id = $13, rcm_paise = $14 where id = $1`,
        [id, taxable, cgst, sgst, igst ? gst : 0, roundOff, total, itc, due, msmeDue, match, JSON.stringify(differences), b.photoId ?? null, rcm])
      await appendAudit(t, { actor: who, action: 'bill.add', entity: { type: 'purchase_bill', id }, amount: total, after: { vendor: v.name, bill: b.billNo, match, differences } }, now())
      return reply.status(201).send({ id, totalPaise: total, rcmPaise: rcm, match, differences, dueDate: due, msmeDueDate: msmeDue })
    })
  })

  app.get('/api/bills', async (req) => {
    await need(req, 'purchase.bill', 'purchase.pay', 'purchase.approve', 'payables.view')
    await sweepPayables(db, now())
    const q = req.query as { status?: string; vendorId?: string }
    const status = q.status ?? 'open'
    const today = istDay(now())
    const rows = await db.query<{ id: string; msme_due_date: string | null; due_date: string; status: string }>(
      `select b.*, b.bill_date::text, b.due_date::text, b.msme_due_date::text, v.name as vendor, v.msme, v.tds_code, e.name as entered_by_name, a.name as approved_by_name,
              (b.total_paise - b.paid_paise) as balance_paise, (select string_agg(g.number, ', ') from grn g where g.id = any(b.grn_ids)) as grns, p.number as po_number
         from purchase_bill b join vendor v on v.id = b.vendor_id join app_user e on e.id = b.entered_by left join app_user a on a.id = b.approved_by left join purchase_order p on p.id = b.po_id
        where ($1 = 'all' or ($1 = 'open' and b.status in ('entered', 'approved', 'partly_paid')) or b.status = $1) and ($2::text is null or b.vendor_id = $2)
        order by coalesce(b.msme_due_date, b.due_date), b.bill_date limit 500`, [status, q.vendorId ?? null])
    const lines = rows.length ? await db.query<{ bill_id: string }>('select l.*, i.name as item from bill_line l left join item i on i.id = l.item_id where l.bill_id = any($1) order by l.line', [rows.map((r) => r.id)]) : []
    return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.bill_id === r.id), daysToDue: daysBetween(today, r.msme_due_date ?? r.due_date),
      msmeLate: !!r.msme_due_date && r.msme_due_date < today && ['entered', 'approved', 'partly_paid'].includes(r.status) }))
  })

  app.post('/api/bills/:id/:action', async (req) => {
    const who = await requireCaller(ctx, req)
    const { id, action } = req.params as { id: string; action: string }
    const reason = (req.body as { reason?: string })?.reason?.trim()
    return db.tx(async (t) => {
      const [bill] = await t.query<{ status: string; match: string; entered_by: string; bill_no: string; total_paise: string; paid_paise: string; grn_ids: string[] }>('select * from purchase_bill where id = $1 for update', [id])
      if (!bill) throw new HttpError(404, 'No such bill.')
      if (action === 'approve') {
        if (bill.status !== 'entered') throw new HttpError(409, `Already ${bill.status.replace('_', ' ')}.`)
        // A matched bill is passed by accounts (not the person who entered it); a difference, or a bill with no PO, needs the GM.
        if (bill.match === 'matched') {
          if (!can(who, 'purchase.bill') && !can(who, 'purchase.approve')) throw new HttpError(403, 'Accounts pass bills for payment.')
          if (bill.entered_by === who.userId && !who.permissions.has('*')) throw new HttpError(403, 'Someone other than the person who entered it passes the bill.')
        } else {
          if (!can(who, 'purchase.approve')) throw new HttpError(403, bill.match === 'no_po' ? 'A bill without a purchase order is passed by the GM.' : 'The bill does not match the PO and the goods received: the GM decides.')
          if (!reason && bill.match === 'difference') throw new HttpError(400, 'Say why the difference is accepted.')
        }
        await t.query(`update purchase_bill set status = 'approved', approved_by = $2, approved_at = $3 where id = $1`, [id, who.userId, now()])
      } else if (action === 'cancel') {
        if (!can(who, 'purchase.bill')) throw new HttpError(403, 'Accounts cancel bills.')
        if (Number(bill.paid_paise) > 0 || !['entered', 'approved'].includes(bill.status)) throw new HttpError(409, 'Part of it is paid: issue a debit note instead (Phase 6).')
        if (!reason) throw new HttpError(400, 'Say why (entered twice, wrong vendor…).')
        await t.query(`update purchase_bill set status = 'cancelled' where id = $1`, [id])
        // Free the received quantities it had used.
        const lines = await t.query<{ item_id: string | null; qty: string }>('select item_id, qty from bill_line where bill_id = $1 and item_id is not null', [id])
        for (const l of lines) {
          let left = Number(l.qty)
          const gl = await t.query<{ grn_id: string; line: number; billed_qty: string }>('select grn_id, line, billed_qty from grn_line where grn_id = any($1) and item_id = $2 and billed_qty > 0 order by grn_id desc, line desc', [bill.grn_ids, l.item_id])
          for (const g of gl) {
            const back = Math.min(left, Number(g.billed_qty)); if (back <= 0) break
            await t.query('update grn_line set billed_qty = billed_qty - $3 where grn_id = $1 and line = $2', [g.grn_id, g.line, back]); left -= back
          }
        }
      } else throw new HttpError(404, 'Use approve or cancel.')
      await appendAudit(t, { actor: who, action: `bill.${action}`, entity: { type: 'purchase_bill', id }, amount: Number(bill.total_paise), after: { bill: bill.bill_no, match: bill.match }, note: reason }, now())
      return { ok: true }
    })
  })

  // ---------- payments ----------
  /** What a payment of these bills comes to: gross, TDS on the taxable part, net. */
  async function workOut(t: Db, vendorId: string, billIds: string[], payDate: string) {
    const [v] = await t.query<{ name: string; pan: string | null; payee_type: PayeeType; tds_code: string | null }>('select name, pan, payee_type, tds_code from vendor where id = $1', [vendorId])
    if (!v) throw new HttpError(404, 'No such vendor.')
    if (!billIds.length) throw new HttpError(400, 'Choose the bills to pay.')
    const bills = await t.query<{ id: string; status: string; vendor_id: string; taxable_paise: string; total_paise: string; paid_paise: string; bill_no: string }>(
      'select id, status, vendor_id, taxable_paise, total_paise, paid_paise, bill_no from purchase_bill where id = any($1) for update', [billIds])
    if (bills.length !== billIds.length || bills.some((b) => b.vendor_id !== vendorId)) throw new HttpError(400, 'All bills must be this vendor\'s.')
    const notReady = bills.find((b) => !['approved', 'partly_paid'].includes(b.status))
    if (notReady) throw new HttpError(409, `Bill ${notReady.bill_no} is ${notReady.status === 'entered' ? 'not yet passed for payment' : notReady.status}.`)
    // Bills already on a payment that has not gone out yet cannot be paid twice.
    const [pending] = await t.query<{ number: string }>(`select p.number from payment_alloc a join vendor_payment p on p.id = a.payment_id where a.bill_id = any($1) and p.status in ('pending_approval', 'approved') limit 1`, [billIds])
    if (pending) throw new HttpError(409, `These bills are already on payment ${pending.number}.`)
    let gross = 0, base = 0
    const allocs = bills.map((b) => {
      const balance = Number(b.total_paise) - Number(b.paid_paise)
      gross += balance
      base += Math.round((Number(b.taxable_paise) * balance) / Number(b.total_paise))   // TDS is on the value without GST
      return { billId: b.id, amount: balance }
    })
    let tds = { deduct: false, rate: 0, base: 0, tds: 0, section: '', reason: 'No TDS category for this vendor' }
    if (v.tds_code) {
      const fy = financialYear(payDate)
      const [y] = await t.query<{ paid: string | null; taxed: string | null }>(
        `select (select sum(b.taxable_paise * a.amount_paise / b.total_paise) from payment_alloc a join vendor_payment p on p.id = a.payment_id join purchase_bill b on b.id = a.bill_id
                  where p.vendor_id = $1 and p.status = 'paid' and p.tds_code = $2 and p.pay_date between $3 and $4) as paid,
                (select sum(base_paise) from tds_entry where vendor_id = $1 and code = $2 and fy = $5) as taxed`,
        [vendorId, v.tds_code, `${fy.slice(0, 4)}-04-01`, `${Number(fy.slice(0, 4)) + 1}-03-31`, fy])
      tds = tdsOnPayment(ctx.tax, { code: v.tds_code, payeeType: v.payee_type, hasPan: !!v.pan, amount: base, paidEarlierThisYear: Math.round(Number(y.paid ?? 0)), alreadyTaxedEarlier: Number(y.taxed ?? 0) })
    }
    // A lower-deduction certificate (section 197): its rate, up to its limit, while it is valid.
    let ldcId: string | null = null, reasonCode: 'A' | 'C' | null = !v.pan && tds.deduct ? 'C' : null
    if (tds.deduct && v.pan) {
      const [l] = await t.query<{ id: string; cert_no: string; rate: string; limit_paise: string; used: string }>(
        `select l.id, l.cert_no, l.rate, l.limit_paise, coalesce((select sum(e.base_paise) from tds_entry e where e.ldc_id = l.id), 0) as used
           from ldc l where l.vendor_id = $1 and replace(l.section, '-', '') = replace($2, '-', '') and $3 between l.valid_from and l.valid_to order by l.valid_from desc limit 1`, [vendorId, tds.section, payDate])
      const room = l ? Number(l.limit_paise) - Number(l.used) : 0
      if (l && room > 0) {
        const within = Math.min(tds.base, room)
        const amount = Math.round((within * Number(l.rate)) / 100) + Math.round(((tds.base - within) * tds.rate) / 100)
        tds = { ...tds, tds: amount, rate: within === tds.base ? Number(l.rate) : Number(((amount * 100) / tds.base).toFixed(2)), reason: `Lower deduction certificate ${l.cert_no} at ${Number(l.rate)}%${within < tds.base ? ' up to its limit' : ''}` }
        ldcId = l.id; reasonCode = 'A'
      }
    }
    return { vendor: v, allocs, gross, tdsBase: tds.base, tds: tds.tds, rate: tds.rate, section: tds.section, code: tds.deduct ? v.tds_code : null, reason: tds.reason, net: gross - tds.tds, ldcId, reasonCode }
  }

  app.post('/api/payments/preview', async (req) => {
    await need(req, 'purchase.pay', 'payables.view')
    const b = (req.body ?? {}) as { vendorId?: string; billIds?: string[]; payDate?: string }
    return db.tx(async (t) => {
      const w = await workOut(t, b.vendorId!, b.billIds ?? [], b.payDate ?? istDay(now()))
      return { gross: w.gross, tdsBase: w.tdsBase, tds: w.tds, rate: w.rate, section: w.section, reason: w.reason, net: w.net, lowerDeduction: !!w.ldcId }
    })
  })

  app.post('/api/payments', async (req, reply) => {
    const who = await need(req, 'purchase.pay')
    const b = (req.body ?? {}) as { vendorId?: string; billIds?: string[]; payDate?: string; mode?: string; reference?: string; acceptCashWarning?: boolean }
    const payDate = b.payDate ?? istDay(now())
    if (!DATE.test(payDate)) throw new HttpError(400, 'Payment date as YYYY-MM-DD.')
    if (!['bank', 'upi', 'cheque', 'cash'].includes(b.mode ?? '')) throw new HttpError(400, 'Mode: bank, upi, cheque or cash.')
    return db.tx(async (t) => {
      const w = await workOut(t, b.vendorId!, b.billIds ?? [], payDate)
      if (b.mode === 'cash') {
        const [{ today }] = await t.query<{ today: string | null }>(`select sum(net_paise) as today from vendor_payment where vendor_id = $1 and mode = 'cash' and pay_date = $2 and status <> 'cancelled'`, [b.vendorId, payDate])
        const c = cashExpenseCheck(ctx.tax, w.net, Number(today ?? 0))
        if (c.warn && !b.acceptCashWarning) throw new HttpError(409, c.message!, { cashWarning: true })
      }
      const id = newId('VP'), number = await nextSeriesNumber(t, 'vendor_payment', financialYear(payDate), 'PAY')
      const needsApproval = !can(who, 'purchase.approve') && w.net > (await roleLimit(t, who, 'vendor_payment_needs_approval_above')) * 100
      await t.query(`insert into vendor_payment (id, number, vendor_id, pay_date, mode, reference, gross_paise, tds_paise, tds_code, tds_section, tds_base_paise, tds_rate, net_paise, status, created_by, created_at, ldc_id)
                     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, number, b.vendorId, payDate, b.mode, b.reference?.trim() || null, w.gross, w.tds, w.code, w.code ? w.section : null, w.tdsBase, w.code ? w.rate : null, w.net, needsApproval ? 'pending_approval' : 'approved', who.userId, now(), w.ldcId])
      for (const a of w.allocs) await t.query('insert into payment_alloc (payment_id, bill_id, amount_paise) values ($1,$2,$3)', [id, a.billId, a.amount])
      let approvalId: string | null = null
      if (needsApproval) {
        approvalId = await createApproval(ctx, t, 'purchase.payment', who.userId, { paymentId: id, number, vendor: w.vendor.name, net: w.net }, `${number}: ₹${(w.net / 100).toLocaleString('en-IN')} to ${w.vendor.name}`)
        await t.query('update vendor_payment set approval_id = $2 where id = $1', [id, approvalId])
      }
      await appendAudit(t, { actor: who, action: 'payment.add', entity: { type: 'vendor_payment', id }, amount: w.net, after: { number, vendor: w.vendor.name, gross: w.gross, tds: w.tds, section: w.section || null } }, now())
      return reply.status(201).send({ id, number, status: needsApproval ? 'pending_approval' : 'approved', approvalId, gross: w.gross, tds: w.tds, net: w.net, section: w.section })
    })
  })

  app.post('/api/payments/:id/:action', async (req) => {
    const who = await need(req, 'purchase.pay')
    const { id, action } = req.params as { id: string; action: string }
    const b = (req.body ?? {}) as { reference?: string }
    return db.tx(async (t) => {
      const [p] = await t.query<{ status: string; number: string; vendor_id: string; pay_date: string; mode: string; tds_paise: string; tds_code: string | null; tds_section: string | null; tds_base_paise: string; tds_rate: string | null; net_paise: string; reference: string | null; ldc_id: string | null }>(
        'select *, pay_date::text from vendor_payment where id = $1 for update', [id])
      if (!p) throw new HttpError(404, 'No such payment.')
      if (action === 'paid') {
        if (p.status !== 'approved') throw new HttpError(409, p.status === 'pending_approval' ? 'It is waiting for the GM\'s approval.' : `It is ${p.status}.`)
        const ref = b.reference?.trim() || p.reference
        if (p.mode !== 'cash' && !ref) throw new HttpError(400, 'Enter the UTR or cheque number.')
        await t.query(`update vendor_payment set status = 'paid', reference = $2, paid_by = $3, paid_at = $4 where id = $1`, [id, ref, who.userId, now()])
        const allocs = await t.query<{ bill_id: string; amount_paise: string }>('select bill_id, amount_paise from payment_alloc where payment_id = $1', [id])
        const today = istDay(now())
        for (const a of allocs) {
          const [bill] = await t.query<{ total_paise: string; paid_paise: string; msme_due_date: string | null; bill_no: string }>('select total_paise, paid_paise, msme_due_date::text, bill_no from purchase_bill where id = $1 for update', [a.bill_id])
          const paid = Number(bill.paid_paise) + Number(a.amount_paise)
          await t.query('update purchase_bill set paid_paise = $2, status = $3 where id = $1', [a.bill_id, paid, paid >= Number(bill.total_paise) ? 'paid' : 'partly_paid'])
          if (bill.msme_due_date && today > bill.msme_due_date) {
            await appendAudit(t, { actor: who, action: 'msme.paid_late', entity: { type: 'purchase_bill', id: a.bill_id }, amount: Number(a.amount_paise), after: { bill: bill.bill_no, due: bill.msme_due_date, paid: today } }, now())
          }
        }
        if (Number(p.tds_paise) > 0) {
          const [v] = await t.query<{ pan: string | null }>('select pan from vendor where id = $1', [p.vendor_id])
          await t.query('insert into tds_entry (id, vendor_id, payment_id, code, section, fy, quarter, base_paise, rate, tds_paise, deducted_on, pan, ldc_id, reason_code) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
            [newId('TD'), p.vendor_id, id, p.tds_code, p.tds_section, financialYear(p.pay_date), quarterOf(p.pay_date), p.tds_base_paise, p.tds_rate, p.tds_paise, p.pay_date, v.pan, p.ldc_id, p.ldc_id ? 'A' : v.pan ? null : 'C'])
        }
      } else if (action === 'cancel') {
        if (!['pending_approval', 'approved'].includes(p.status)) throw new HttpError(409, `It is ${p.status}: a paid payment is reversed in accounts.`)
        await t.query(`update vendor_payment set status = 'cancelled' where id = $1`, [id])
        await t.query(`update approval set status = 'rejected' where id = (select approval_id from vendor_payment where id = $1) and status = 'pending'`, [id])
      } else throw new HttpError(404, 'Use paid or cancel.')
      await appendAudit(t, { actor: who, action: `payment.${action}`, entity: { type: 'vendor_payment', id }, amount: Number(p.net_paise), after: { number: p.number } }, now())
      return { ok: true }
    })
  })

  app.get('/api/payments', async (req) => {
    await need(req, 'purchase.pay', 'payables.view')
    return db.query(
      `select p.*, p.pay_date::text, v.name as vendor, c.name as created_by_name, (select string_agg(b.bill_no, ', ') from payment_alloc a join purchase_bill b on b.id = a.bill_id where a.payment_id = p.id) as bills
         from vendor_payment p join vendor v on v.id = p.vendor_id join app_user c on c.id = p.created_by order by p.created_at desc limit 300`)
  })

  // TDS deducted, by section and quarter: what is owed to the government (deposit by the 7th of the next month).
  app.get('/api/tds', async (req) => {
    await need(req, 'purchase.pay', 'payables.view')
    const fy = (req.query as { fy?: string }).fy ?? financialYear(istDay(now()))
    const entries = await db.query(
      `select e.*, e.deducted_on::text, v.name as vendor, p.number as payment from tds_entry e join vendor v on v.id = e.vendor_id join vendor_payment p on p.id = e.payment_id where e.fy = $1 order by e.deducted_on, v.name`, [fy])
    const summary = await db.query(`select section, quarter, count(*)::int as entries, sum(base_paise) as base_paise, sum(tds_paise) as tds_paise from tds_entry where fy = $1 group by section, quarter order by quarter, section`, [fy])
    return { fy, entries, summary }
  })
}
