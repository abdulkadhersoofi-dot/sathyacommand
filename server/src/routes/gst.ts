import type { FastifyInstance, FastifyRequest } from 'fastify'
import { appendAudit } from '../audit-store'
import { csvRows, statementAmount, statementDate } from '../bank-csv'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { claimableBills, gstr1, gstr1Json, gstr3b, match2b, monthEnd, parse2b } from '../gst-returns'
import { LedgerError, postPending, postVoucher } from '../ledger'
import { requireCaller } from './auth'

// GST returns month by month: GSTR-1 (tables and the upload file), GSTR-3B (tax, credit, reverse charge,
// reversal, cash to pay), GSTR-2B imported and matched to the bills, IMS actions on bills, and each return
// recorded as filed with its ARN: the figures are kept as filed, the set-off is posted, and the month's
// credit can no longer change.

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function gstRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const periodOf = (req: FastifyRequest) => {
    const p = (req.params as { period: string }).period
    if (!PERIOD.test(p)) throw new HttpError(400, 'The month as YYYY-MM.')
    return p
  }
  const filed = (t: Db, period: string) => t.query<{ form: string; arn: string; filed_on: string; filed_by_name: string; figures: unknown }>(
    `select g.form, g.arn, g.filed_on::text, u.name as filed_by_name, g.figures from gst_return g join app_user u on u.id = g.filed_by where g.period = $1`, [period])
  /** Whose credit a filed GSTR-3B has already claimed: it cannot be rejected or re-matched afterwards. */
  async function claimedIn(t: Db, billId: string) {
    const [r] = await t.query<{ period: string }>(
      `select g.period from gst_return g where g.form = 'GSTR3B' and (
          g.period in (select l.period from gstr2b_line l where l.bill_id = $1 and l.status = 'matched')
          or (not exists (select 1 from gstr2b_import i where i.period = g.period) and g.period = (select to_char(bill_date, 'YYYY-MM') from purchase_bill where id = $1))) limit 1`, [billId])
    return r?.period ?? null
  }

  app.get('/api/gst/:period', async (req) => {
    await need(req, 'gst.view', 'gst.file')
    await postPending(db, now())
    const period = periodOf(req)
    const g1 = await gstr1(db, period)
    const { sales: _s, notes: _n, ...gstr1Out } = g1
    void _s; void _n
    const returns = await filed(db, period)
    const f3b = returns.find((r) => r.form === 'GSTR3B')
    const g3b = f3b ? f3b.figures : await gstr3b(db, period)
    const twoB = await db.query(
      `select l.*, l.doc_date::text, b.bill_no, b.ims_action, v.name as vendor, p.number as ota_payout from gstr2b_line l left join purchase_bill b on b.id = l.bill_id left join vendor v on v.id = b.vendor_id
         left join ota_payout p on p.id = l.ota_payout_id where l.period = $1 order by l.status desc, l.supplier_name`, [period])
    // Bills with credit that no GSTR-2B has shown yet: claimed in the month they appear.
    const waiting = await db.query(
      `select b.id, b.bill_no, b.bill_date::text, b.ims_action, b.itc_paise - coalesce((select sum(l.gst_paise) from bill_line l where l.bill_id = b.id and l.rcm and l.itc = 'full'), 0) as itc_paise, v.name as vendor, v.gstin
         from purchase_bill b join vendor v on v.id = b.vendor_id
        where b.status in ('approved', 'partly_paid', 'paid') and b.bill_date <= $1 and b.itc_paise > b.rcm_paise
          and not exists (select 1 from gstr2b_line l where l.bill_id = b.id and l.status = 'matched') order by b.bill_date`, [monthEnd(period)])
    return { period, gstr1: gstr1Out, gstr3b: g3b, filed: returns.map(({ figures: _f, ...r }) => (void _f, r)), twoB: { imported: twoB.length > 0, lines: twoB, waiting } }
  })

  app.get('/api/gst/:period/gstr1.json', async (req, reply) => {
    await need(req, 'gst.view', 'gst.file')
    const period = periodOf(req)
    const [p] = await db.query<{ gstin: string | null }>('select gstin from property limit 1')
    if (!p?.gstin) throw new HttpError(409, 'Set the company\'s GSTIN first (property settings).')
    const json = gstr1Json(p.gstin, await gstr1(db, period), (req.query as { einvoiced?: string }).einvoiced === '1')
    return reply.header('content-disposition', `attachment; filename="GSTR1_${p.gstin}_${period.slice(5, 7)}${period.slice(0, 4)}.json"`).send(json)
  })

  app.post('/api/gst/2b/import', async (req, reply) => {
    const who = await need(req, 'gst.file')
    const b = (req.body ?? {}) as { period?: string; text?: string; fileName?: string }
    if (!PERIOD.test(b.period ?? '')) throw new HttpError(400, 'Which month\'s GSTR-2B is it (YYYY-MM)?')
    if (!b.text?.trim()) throw new HttpError(400, 'Choose the GSTR-2B file (JSON from the portal, or the Excel saved as CSV).')
    let lines
    try { lines = parse2b(b.text, csvRows, statementDate, statementAmount) } catch (e) { throw new HttpError(400, (e as Error).message) }
    if (!lines.length) throw new HttpError(400, 'No supplier documents found in the file.')
    return db.tx(async (t) => {
      if ((await filed(t, b.period!)).some((r) => r.form === 'GSTR3B')) throw new HttpError(409, `GSTR-3B for ${b.period} is filed: its GSTR-2B can no longer change.`)
      const id = newId('2B')
      await t.query('insert into gstr2b_import (id, period, file_name, lines, imported_by, imported_at) values ($1,$2,$3,$4,$5,$6)', [id, b.period, b.fileName ?? null, lines.length, who.userId, now()])
      for (const l of lines) {
        await t.query(`insert into gstr2b_line (id, import_id, period, doc_type, supplier_gstin, supplier_name, doc_no, doc_date, value_paise, taxable_paise, igst_paise, cgst_paise, sgst_paise, itc_available, reason)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            on conflict (period, supplier_gstin, doc_type, doc_no) do update set import_id = excluded.import_id, value_paise = excluded.value_paise, taxable_paise = excluded.taxable_paise,
              igst_paise = excluded.igst_paise, cgst_paise = excluded.cgst_paise, sgst_paise = excluded.sgst_paise, itc_available = excluded.itc_available, reason = excluded.reason`,
          [newId('2L'), id, b.period, l.docType, l.gstin, l.name, l.docNo, l.date, l.value, l.taxable, l.igst, l.cgst, l.sgst, l.itcAvailable, l.reason])
      }
      const matched = await match2b(t, b.period!)
      await appendAudit(t, { actor: who, action: 'gst.2b_import', entity: { type: 'gstr2b_import', id }, after: { period: b.period, file: b.fileName ?? null, lines: lines.length, matched } }, now())
      return reply.status(201).send({ id, lines: lines.length, matched })
    })
  })

  // IMS: accept or reject a supplier's invoice (a rejected one is not claimed, and the vendor must correct it).
  app.post('/api/bills/:id/ims', async (req) => {
    const who = await need(req, 'gst.file', 'purchase.bill')
    const b = (req.body ?? {}) as { action?: string; note?: string }
    if (!['accepted', 'rejected', 'pending'].includes(b.action ?? '')) throw new HttpError(400, 'Accept, reject or leave pending.')
    if (b.action === 'rejected' && !b.note?.trim()) throw new HttpError(400, 'Why is it rejected (wrong GSTIN, rate, amount, not received)?')
    const id = (req.params as { id: string }).id
    return db.tx(async (t) => {
      const [bill] = await t.query<{ ims_action: string }>('select ims_action from purchase_bill where id = $1 for update', [id])
      if (!bill) throw new HttpError(404, 'No such bill.')
      const p = await claimedIn(t, id)
      if (p) throw new HttpError(409, `Its credit was claimed in GSTR-3B for ${p}, already filed: put it right in the next return.`)
      await t.query('update purchase_bill set ims_action = $2, ims_note = $3, ims_by = $4, ims_at = $5 where id = $1', [id, b.action, b.note?.trim() || null, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'gst.ims', entity: { type: 'purchase_bill', id }, before: { action: bill.ims_action }, after: { action: b.action, note: b.note ?? null } }, now())
      return { id, action: b.action }
    })
  })

  /** Records a return as filed: its figures kept as filed; for GSTR-3B the set-off is posted to the books. */
  app.post('/api/gst/returns', async (req, reply) => {
    const who = await need(req, 'gst.file')
    const b = (req.body ?? {}) as { period?: string; form?: string; arn?: string; filedOn?: string }
    if (!PERIOD.test(b.period ?? '')) throw new HttpError(400, 'The month as YYYY-MM.')
    if (!['GSTR1', 'GSTR3B'].includes(b.form ?? '')) throw new HttpError(400, 'GSTR1 or GSTR3B.')
    const arn = b.arn?.trim().toUpperCase()
    if (!arn || !/^[A-Z0-9]{10,20}$/.test(arn)) throw new HttpError(400, 'The ARN the portal gave on filing.')
    await postPending(db, now())
    return db.tx(async (t) => {
      const today = await businessDate(t)
      const filedOn = b.filedOn ?? today
      if (!DATE.test(filedOn) || filedOn > today) throw new HttpError(400, 'The filing date: today or earlier.')
      if (monthEnd(b.period!) >= today) throw new HttpError(409, `${b.period} is not over yet.`)
      if ((await filed(t, b.period!)).some((r) => r.form === b.form)) throw new HttpError(409, `${b.form} for ${b.period} is already filed.`)
      const id = newId('GR')
      if (b.form === 'GSTR1') {
        const { sales: _s, notes: _n, ...g1 } = await gstr1(t, b.period!)
        void _s; void _n
        await t.query('insert into gst_return (id, period, form, arn, filed_on, figures, filed_by, filed_at) values ($1,$2,$3,$4,$5,$6,$7,$8)', [id, b.period, b.form, arn, filedOn, JSON.stringify(g1), who.userId, now()])
        await appendAudit(t, { actor: who, action: 'gst.filed', entity: { type: 'gst_return', id }, after: { period: b.period, form: b.form, arn } }, now())
        return reply.status(201).send({ id })
      }
      const g = await gstr3b(t, b.period!, filedOn)
      await t.query('insert into gst_return (id, period, form, arn, filed_on, figures, filed_by, filed_at) values ($1,$2,$3,$4,$5,$6,$7,$8)', [id, b.period, b.form, arn, filedOn, JSON.stringify(g), who.userId, now()])
      // The set-off: output tax and reverse charge against the credit used, the rest to pay in cash; the reversed credit to cost.
      const p = g.payment, r = g.itc.reversal
      let v: { id: string } | null = null
      try {
        v = await postVoucher(t, { kind: 'journal', date: filedOn, narration: `GSTR-3B ${b.period} filed (${arn}): set-off`, source: { type: 'gst_return', id }, userId: who.userId, now: now(), lines: [
          { code: '2200', amount: g.outward.cgst }, { code: '2201', amount: g.outward.sgst },
          { code: '2202', amount: g.rcm.cgst }, { code: '2203', amount: g.rcm.sgst }, { code: '2204', amount: g.rcm.igst },
          { code: '1500', amount: -(p.creditUsed.cgst + r.cgst) }, { code: '1501', amount: -(p.creditUsed.sgst + r.sgst) }, { code: '1502', amount: -(p.creditUsed.igst + r.igst) },
          { code: '6090', amount: r.cgst + r.sgst + r.igst }, { code: '2220', amount: -p.cashTotal, ref: arn }] })
      } catch (e) { if (e instanceof LedgerError) throw new HttpError(e.statusCode, e.message); throw e }
      if (v) await t.query('update gst_return set voucher_id = $2 where id = $1', [id, v.id])
      await appendAudit(t, { actor: who, action: 'gst.filed', entity: { type: 'gst_return', id }, amount: p.cashTotal, after: { period: b.period, form: b.form, arn, cash: p.cashTotal, lateFee: g.late.lateFeePaise } }, now())
      return reply.status(201).send({ id, cashPaise: p.cashTotal, lateFeePaise: g.late.lateFeePaise, interestPaise: g.late.interestPaise })
    })
  })

  app.get('/api/gst/returns', async (req) => {
    await need(req, 'gst.view', 'gst.file')
    return db.query(`select g.id, g.period, g.form, g.arn, g.filed_on::text, u.name as filed_by_name, v.number as voucher from gst_return g join app_user u on u.id = g.filed_by left join voucher v on v.id = g.voucher_id order by g.period desc, g.form`)
  })
  void claimableBills
}
