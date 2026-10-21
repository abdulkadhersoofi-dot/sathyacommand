import type { FastifyInstance, FastifyRequest } from 'fastify'
import { financialYear, rupees } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { monthEnd } from '../gst-returns'
import { DEPTS, LedgerError, postPending, postVoucher, type PostLine } from '../ledger'
import { requireCaller } from './auth'

// TN VAT on liquor (the month's return data and registers), the fixed-asset register with depreciation
// (straight line over the Companies Act lives in the books; income-tax blocks for the return), department
// budgets against actuals, and the books for Tally.

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const n = (v: unknown) => Number(v ?? 0)
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!))
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`

/** Asset classes: the ledger account, the Companies Act life (Schedule II; hotel furniture 8 years), the income-tax block rate. CA check */
export const CLASSES: Record<string, { account: string; life: number; itRate: number; label: string }> = {
  building: { account: '1600', life: 60, itRate: 10, label: 'Buildings' },
  plant: { account: '1601', life: 15, itRate: 15, label: 'Plant and machinery' },
  furniture: { account: '1602', life: 8, itRate: 10, label: 'Furniture and fittings' },
  vehicle: { account: '1603', life: 8, itRate: 15, label: 'Vehicles' },
  computer: { account: '1604', life: 3, itRate: 40, label: 'Computers' },
  intangible: { account: '1605', life: 5, itRate: 25, label: 'Software and other intangibles' },
}

interface AssetRow { id: string; code: string; name: string; category: string; account_code: string; dept: string | null; put_to_use: string; cost_paise: string; residual_percent: string; life_years: string; opening_dep_paise: string; disposed_on: string | null; sale_paise: string | null; posted: string }

/** The day the books begin: the opening balances' date, else 1 April of the current financial year. */
async function booksStart(t: Db) {
  const [o] = await t.query<{ d: string | null }>(`select min(date)::text as d from voucher where source_type = 'opening'`)
  if (o?.d) return o.d
  const day = await businessDate(t)
  const y = Number(day.slice(0, 4)) - (day.slice(5, 7) < '04' ? 1 : 0)
  return `${y}-04-01`
}
/** The month depreciation is next due: after the last one posted, or the month the books begin. */
async function nextDepMonth(t: Db) {
  const [last] = await t.query<{ month: string | null }>('select max(month) as month from depreciation_run')
  return last?.month ? addDays(monthEnd(last.month), 1).slice(0, 7) : (await booksStart(t)).slice(0, 7)
}

/** Straight-line depreciation for the days of a month the asset was in use, never beyond its cost less residual value. */
function monthDep(a: AssetRow, month: string) {
  const start = `${month}-01`, end = monthEnd(month)
  const from = a.put_to_use > start ? a.put_to_use : start
  const to = a.disposed_on && a.disposed_on <= end ? addDays(a.disposed_on, -1) : end
  if (to < from) return 0
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
  const base = n(a.cost_paise) * (1 - n(a.residual_percent) / 100)
  const amount = Math.round(((base / n(a.life_years)) * days) / 365)
  const left = Math.max(0, Math.round(base) - n(a.opening_dep_paise) - n(a.posted))
  return Math.min(amount, left)
}

export function vatAssetRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const post = async (t: Db, v: Parameters<typeof postVoucher>[1]) => {
    try { return await postVoucher(t, v) } catch (e) { if (e instanceof LedgerError) throw new HttpError(e.statusCode, e.message); throw e }
  }

  // ---------- TN VAT ----------
  async function vatMonth(t: Db, period: string) {
    const from = `${period}-01`, to = monthEnd(period)
    const invoices = await t.query<{ number: string; issue_date: string; buyer: { name: string }; lines: { description: string; liquorClass: string; vatRate: number; taxable: number; vat: number }[]; taxable_paise: string; vat_paise: string; total_paise: string }>(
      'select number, issue_date::text, buyer, lines, taxable_paise, vat_paise, total_paise from vat_invoice where issue_date between $1 and $2 order by number', [from, to])
    const byRate = new Map<string, { liquorClass: string; rate: number; taxable: number; vat: number }>()
    for (const i of invoices) for (const l of i.lines) {
      const k = `${l.liquorClass}|${l.vatRate}`
      const x = byRate.get(k) ?? { liquorClass: l.liquorClass, rate: Number(l.vatRate), taxable: 0, vat: 0 }
      x.taxable += n(l.taxable); x.vat += n(l.vat); byRate.set(k, x)
    }
    const purchases = await t.query<{ invoice_no: string; invoice_date: string; supplier: string; permit_no: string | null; value_paise: string; vat_paise: string; tcs_paise: string | null; total_paise: string }>(
      'select invoice_no, invoice_date::text, supplier, permit_no, value_paise, vat_paise, tcs_paise, total_paise from tasmac_purchase where business_date between $1 and $2 order by invoice_date, invoice_no', [from, to])
    const output = invoices.reduce((a, i) => a + n(i.vat_paise), 0), input = purchases.reduce((a, p) => a + n(p.vat_paise), 0)
    // CA check: whether VAT paid to TASMAC can be set off against VAT on the bar's sales. Not set off until confirmed.
    const creditAllowed = false
    const [f] = await t.query<{ ack_no: string; filed_on: string }>('select ack_no, filed_on::text from vat_return where period = $1', [period])
    return {
      period, invoices: invoices.map((i) => ({ number: i.number, date: i.issue_date, buyer: i.buyer?.name ?? '', taxable: n(i.taxable_paise), vat: n(i.vat_paise), total: n(i.total_paise) })),
      byRate: [...byRate.values()].sort((a, b) => a.liquorClass.localeCompare(b.liquorClass) || a.rate - b.rate),
      purchases: purchases.map((p) => ({ invoice: p.invoice_no, date: p.invoice_date, supplier: p.supplier, permit: p.permit_no, value: n(p.value_paise), vat: n(p.vat_paise), tcs: n(p.tcs_paise), total: n(p.total_paise) })),
      totals: { salesPaise: invoices.reduce((a, i) => a + n(i.taxable_paise), 0), outputVatPaise: output, purchasesPaise: purchases.reduce((a, p) => a + n(p.value_paise), 0), inputVatPaise: input, creditAllowed, payablePaise: output - (creditAllowed ? input : 0) },
      due: `${addDays(to, 1).slice(0, 7)}-20`, filed: f ?? null,
    }
  }
  const periodOf = (req: FastifyRequest) => { const p = (req.params as { period: string }).period; if (!PERIOD.test(p)) throw new HttpError(400, 'Enter the month as YYYY-MM.'); return p }

  app.get('/api/vat/:period', async (req) => {
    await need(req, 'vat.file', 'accounts.view', 'tax.vat')
    return vatMonth(db, periodOf(req))
  })

  app.get('/api/vat/:period/:register', async (req, reply) => {
    await need(req, 'vat.file', 'accounts.view', 'tax.vat')
    const { register } = req.params as { register: string }
    const v = await vatMonth(db, periodOf(req))
    const r = (p: number) => (p / 100).toFixed(2)
    let rows: unknown[][]
    if (register === 'sales.csv') rows = [['Invoice', 'Date', 'Buyer', 'Value', 'VAT', 'Total'], ...v.invoices.map((i) => [i.number, i.date, i.buyer, r(i.taxable), r(i.vat), r(i.total)])]
    else if (register === 'purchases.csv') rows = [['TASMAC invoice', 'Date', 'Supplier', 'Transport permit', 'Value', 'VAT', 'TCS', 'Total'], ...v.purchases.map((p) => [p.invoice, p.date, p.supplier, p.permit ?? '', r(p.value), r(p.vat), r(p.tcs), r(p.total)])]
    else throw new HttpError(404, 'sales.csv or purchases.csv')
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="VAT_${register.replace('.csv', '')}_${v.period}.csv"`).send(rows.map((x) => x.map(csvCell).join(',')).join('\r\n'))
  })

  app.post('/api/vat/returns', async (req, reply) => {
    const who = await need(req, 'vat.file')
    const b = (req.body ?? {}) as { period?: string; ackNo?: string; filedOn?: string }
    if (!PERIOD.test(b.period ?? '')) throw new HttpError(400, 'Enter the month as YYYY-MM.')
    if (!b.ackNo?.trim()) throw new HttpError(400, 'Enter the acknowledgement number from the TN VAT portal.')
    return db.tx(async (t) => {
      const today = await businessDate(t)
      const filedOn = b.filedOn ?? today
      if (!DATE.test(filedOn) || filedOn > today) throw new HttpError(400, 'Enter the filing date: today or earlier.')
      if (monthEnd(b.period!) >= today) throw new HttpError(409, `${b.period} is not over yet.`)
      const v = await vatMonth(t, b.period!)
      if (v.filed) throw new HttpError(409, `The VAT return for ${b.period} is already filed.`)
      const id = newId('VR')
      await t.query('insert into vat_return (id, period, ack_no, filed_on, figures, filed_by, filed_at) values ($1,$2,$3,$4,$5,$6,$7)', [id, b.period, b.ackNo!.trim(), filedOn, JSON.stringify(v), who.userId, now()])
      await appendAudit(t, { actor: who, action: 'vat.filed', entity: { type: 'vat_return', id }, amount: v.totals.payablePaise, after: { period: b.period, ack: b.ackNo } }, now())
      return reply.status(201).send({ id, payablePaise: v.totals.payablePaise })
    })
  })

  // ---------- fixed assets ----------
  const assets = (t: Db) => t.query<AssetRow>(
    `select a.*, a.put_to_use::text, a.disposed_on::text, coalesce((select sum(l.amount_paise) from depreciation_line l where l.asset_id = a.id), 0) as posted from fixed_asset a order by a.code`)

  app.get('/api/assets/register', async (req) => {
    await need(req, 'assets.manage', 'accounts.view')
    const rows = await assets(db)
    return {
      classes: CLASSES, departments: DEPTS,
      assets: rows.map((a) => {
        const acc = n(a.opening_dep_paise) + n(a.posted)
        return { ...a, cost_paise: n(a.cost_paise), accumulatedPaise: acc, bookValuePaise: a.disposed_on ? 0 : n(a.cost_paise) - acc, posted: n(a.posted) }
      }),
      runs: await db.query('select r.month, r.amount_paise, v.number as voucher, r.run_at from depreciation_run r left join voucher v on v.id = r.voucher_id order by r.month desc limit 24'),
      nextMonth: await nextDepMonth(db), businessDate: await businessDate(db),
    }
  })

  app.post('/api/assets/register', async (req, reply) => {
    const who = await need(req, 'assets.manage')
    const b = (req.body ?? {}) as { name?: string; category?: string; cost?: number; putToUse?: string; lifeYears?: number; residualPercent?: number; dept?: string; billId?: string; engAssetId?: string; openingDep?: number; postOpening?: boolean }
    const cls = CLASSES[b.category ?? '']
    if (!b.name?.trim()) throw new HttpError(400, 'Name the asset.')
    if (!cls) throw new HttpError(400, `Class: ${Object.keys(CLASSES).join(', ')}.`)
    if (!(Number(b.cost) > 0)) throw new HttpError(400, 'Its cost (₹, before GST that is claimed back).')
    if (!DATE.test(b.putToUse ?? '')) throw new HttpError(400, 'The date it was put to use.')
    if (b.dept && !DEPTS[b.dept]) throw new HttpError(400, 'No such department.')
    const life = Number(b.lifeYears ?? cls.life), residual = Number(b.residualPercent ?? 5)
    if (!(life > 0 && life <= 100) || !(residual >= 0 && residual <= 50)) throw new HttpError(400, 'Useful life in years, residual value 0–50%.')
    const cost = rupees(Number(b.cost)), openingDep = rupees(Number(b.openingDep ?? 0))
    if (openingDep >= cost) throw new HttpError(400, 'Depreciation already taken must be less than the cost.')
    return db.tx(async (t) => {
      const [{ c }] = await t.query<{ c: number }>('select count(*)::int as c from fixed_asset')
      const id = newId('FA'), code = `FA-${String(c + 1).padStart(4, '0')}`
      await t.query(`insert into fixed_asset (id, code, name, category, account_code, dept, put_to_use, cost_paise, residual_percent, life_years, opening_dep_paise, bill_id, eng_asset_id, created_by, created_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, code, b.name!.trim(), b.category, cls.account, b.dept || null, b.putToUse, cost, residual, life, openingDep, b.billId || null, b.engAssetId || null, who.userId, now()])
      // An asset held before the books began comes in at its cost, less the depreciation already taken, against opening balances.
      // One bought on a vendor bill is already in the books (the bill line was charged to the asset account).
      // If the opening balances already carry this asset account, the asset is in the books through them: the
      // register entry only adds it for depreciation. Otherwise it goes in dated the day the books begin.
      let note: string | null = null
      if (b.postOpening) {
        const [inOpening] = await t.query(`select 1 from voucher v join voucher_line l on l.voucher_id = v.id where v.source_type = 'opening' and l.account_code = $1 and l.debit_paise > 0 limit 1`, [cls.account])
        if (inOpening) note = `Already in the opening balances (account ${cls.account}), so nothing new was posted; it is in the register for depreciation.`
        else {
          await post(t, { kind: 'journal', date: await booksStart(t), narration: `${code} ${b.name!.trim()}: asset held before the books began`, source: { type: 'fixed_asset', id }, userId: who.userId, now: now(),
            lines: [{ code: cls.account, amount: cost }, { code: '1690', amount: -openingDep }, { code: '3200', amount: -(cost - openingDep) }] })
        }
      }
      await appendAudit(t, { actor: who, action: 'asset.add', entity: { type: 'fixed_asset', id }, amount: cost, after: { code, name: b.name, category: b.category, life, putToUse: b.putToUse } }, now())
      return reply.status(201).send({ id, code, note })
    })
  })

  /** One month's depreciation for every asset, posted as one voucher; months run in order. */
  app.post('/api/assets/depreciation', async (req, reply) => {
    const who = await need(req, 'assets.manage')
    const month = (req.body as { month?: string } | null)?.month ?? ''
    if (!PERIOD.test(month)) throw new HttpError(400, 'Enter the month as YYYY-MM.')
    await postPending(db, now())
    return db.tx(async (t) => {
      if (monthEnd(month) >= await businessDate(t)) throw new HttpError(409, `${month} is not over yet.`)
      const [done] = await t.query('select 1 from depreciation_run where month = $1', [month])
      if (done) throw new HttpError(409, `Depreciation for ${month} is already posted.`)
      // Months run in order from the month the books begin (earlier years are in each asset's depreciation already taken).
      const expected = await nextDepMonth(t)
      if (month !== expected) throw new HttpError(409, month < expected ? `${month} is before ${expected}, the next month to post.` : `Post ${expected} first: months are depreciated in order.`)
      const rows = await assets(t)
      const lines = rows.map((a) => ({ a, amount: monthDep(a, month) })).filter((x) => x.amount > 0)
      if (!lines.length) throw new HttpError(409, `Nothing to depreciate in ${month}.`)
      const total = lines.reduce((s, x) => s + x.amount, 0)
      await t.query('insert into depreciation_run (month, amount_paise, run_by, run_at) values ($1,$2,$3,$4)', [month, total, who.userId, now()])
      for (const x of lines) await t.query('insert into depreciation_line (month, asset_id, amount_paise) values ($1,$2,$3)', [month, x.a.id, x.amount])
      const vl: PostLine[] = [...lines.map((x) => ({ code: '6200', amount: x.amount, dept: x.a.dept })), { code: '1690', amount: -total }]
      const v = await post(t, { kind: 'journal', date: monthEnd(month), narration: `Depreciation for ${month} (straight line, Companies Act lives)`, source: { type: 'depreciation', id: month }, userId: who.userId, now: now(), lines: vl })
      if (v) await t.query('update depreciation_run set voucher_id = $2 where month = $1', [month, v.id])
      await appendAudit(t, { actor: who, action: 'asset.depreciation', entity: { type: 'depreciation_run', id: month }, amount: total, after: { assets: lines.length } }, now())
      return reply.status(201).send({ month, amountPaise: total, assets: lines.length })
    })
  })

  app.post('/api/assets/register/:id/dispose', async (req) => {
    const who = await need(req, 'assets.manage')
    const b = (req.body ?? {}) as { date?: string; sale?: number; bankAccountId?: string }
    if (!DATE.test(b.date ?? '')) throw new HttpError(400, 'The date it was sold or scrapped.')
    const sale = rupees(Number(b.sale ?? 0))
    return db.tx(async (t) => {
      const [a] = (await assets(t)).filter((x) => x.id === (req.params as { id: string }).id)
      if (!a) throw new HttpError(404, 'No such asset.')
      if (a.disposed_on) throw new HttpError(409, 'Already disposed of.')
      const acc = n(a.opening_dep_paise) + n(a.posted), cost = n(a.cost_paise)
      const [ba] = b.bankAccountId ? await t.query<{ account_code: string }>('select account_code from bank_account where id = $1', [b.bankAccountId]) : await t.query<{ account_code: string }>('select account_code from bank_account where is_default')
      await t.query('update fixed_asset set disposed_on = $2, sale_paise = $3 where id = $1', [a.id, b.date, sale])
      // Off the books at cost, its depreciation with it; what it fetched against what was left of it is a profit or loss.
      await post(t, { kind: 'journal', date: b.date!, narration: `${a.code} ${a.name} sold / scrapped`, source: { type: 'asset_disposal', id: a.id }, userId: who.userId, now: now(), lines: [
        { code: ba?.account_code ?? '1200', amount: sale }, { code: '1690', amount: acc }, { code: a.account_code, amount: -cost }, { code: '4910', amount: cost - acc - sale }] })
      await appendAudit(t, { actor: who, action: 'asset.dispose', entity: { type: 'fixed_asset', id: a.id }, amount: sale, after: { code: a.code, bookValue: cost - acc } }, now())
      return { id: a.id, profitPaise: sale - (cost - acc) }
    })
  })

  /** Income-tax depreciation for the return: written-down value of each block, half the rate on what was used under 180 days. CA check */
  app.get('/api/assets/it-depreciation', async (req) => {
    await need(req, 'assets.manage', 'accounts.view')
    const fy = (req.query as { fy?: string }).fy ?? financialYear(await businessDate(db))
    if (!/^\d{4}-\d{2}$/.test(fy)) throw new HttpError(400, 'Enter the year as 2026-27.')
    const rows = await assets(db)
    const fyStart = (y: number) => `${y}-04-01`
    const startYear = Math.min(Number(fy.slice(0, 4)), ...rows.map((a) => Number(financialYear(a.put_to_use).slice(0, 4))))
    const blocks = new Map<string, { wdv: number }>()
    let result: { block: string; label: string; rate: number; openingPaise: number; additionsFullPaise: number; additionsHalfPaise: number; salesPaise: number; depreciationPaise: number; closingPaise: number }[] = []
    for (let y = startYear; y <= Number(fy.slice(0, 4)); y++) {
      const from = fyStart(y), to = `${y + 1}-03-31`
      result = Object.entries(CLASSES).map(([k, c]) => {
        const opening = blocks.get(k)?.wdv ?? 0
        const added = rows.filter((a) => a.category === k && a.put_to_use >= from && a.put_to_use <= to)
        // Worked year by year from the year each asset was put to use, at cost. CA check: existing assets' written-down values from the last return.
        const val = (a: AssetRow) => n(a.cost_paise)
        const full = added.filter((a) => Math.round((Date.parse(to) - Date.parse(a.put_to_use)) / 86_400_000) + 1 >= 180).reduce((s, a) => s + val(a), 0)
        const half = added.reduce((s, a) => s + val(a), 0) - full
        const sales = rows.filter((a) => a.category === k && a.disposed_on && a.disposed_on >= from && a.disposed_on <= to).reduce((s, a) => s + n(a.sale_paise), 0)
        // Sale proceeds come off the block first; what remains of the recent additions takes half the rate.
        const total = opening + full + half - sales
        const halfPart = Math.max(0, Math.min(half, total)), fullPart = Math.max(0, total - halfPart)
        const dep = total > 0 ? Math.round((fullPart * c.itRate) / 100 + (halfPart * c.itRate) / 200) : 0
        const closing = Math.max(0, total) - dep
        blocks.set(k, { wdv: closing })
        return { block: k, label: c.label, rate: c.itRate, openingPaise: opening, additionsFullPaise: full, additionsHalfPaise: half, salesPaise: sales, depreciationPaise: dep, closingPaise: closing }
      })
    }
    return { fy, blocks: result.filter((b) => b.openingPaise || b.additionsFullPaise || b.additionsHalfPaise || b.salesPaise) }
  })

  // ---------- budgets ----------
  app.put('/api/budgets', async (req) => {
    const who = await need(req, 'budget.manage')
    const b = (req.body ?? {}) as { fy?: string; dept?: string; kind?: string; annual?: number; months?: Record<string, number> }
    if (!/^\d{4}-\d{2}$/.test(b.fy ?? '')) throw new HttpError(400, 'Enter the year as 2026-27.')
    if (!DEPTS[b.dept ?? '']) throw new HttpError(400, 'Which department?')
    if (!['revenue', 'cost'].includes(b.kind ?? '')) throw new HttpError(400, 'Say whether it is revenue or a cost.')
    const y = Number(b.fy!.slice(0, 4))
    const months = Array.from({ length: 12 }, (_, i) => { const m = ((i + 3) % 12) + 1; return `${m <= 3 ? y + 1 : y}-${String(m).padStart(2, '0')}` })
    let amounts: Record<string, number>
    if (b.months) {
      amounts = {}
      for (const [m, v] of Object.entries(b.months)) { if (!months.includes(m) || !(Number(v) >= 0)) throw new HttpError(400, `${m}: a month of ${b.fy} and an amount.`); amounts[m] = rupees(Number(v)) }
    } else {
      if (!(Number(b.annual) >= 0)) throw new HttpError(400, 'Enter the amount for the year (₹), or month by month.')
      const total = rupees(Number(b.annual)), each = Math.floor(total / 12)
      amounts = Object.fromEntries(months.map((m, i) => [m, i === 11 ? total - each * 11 : each]))
    }
    await db.tx(async (t) => {
      for (const [m, v] of Object.entries(amounts)) {
        await t.query(`insert into budget (fy, month, dept, kind, amount_paise) values ($1,$2,$3,$4,$5) on conflict (month, dept, kind) do update set amount_paise = excluded.amount_paise`, [b.fy, m, b.dept, b.kind, v])
      }
      await appendAudit(t, { actor: who, action: 'budget.set', entity: { type: 'budget', id: `${b.fy}:${b.dept}:${b.kind}` }, amount: Object.values(amounts).reduce((a, x) => a + x, 0), after: { months: Object.keys(amounts).length } }, now())
    })
    return { ok: true }
  })

  /** Each department's revenue and costs against its budget for the months of the period. */
  app.get('/api/budgets/vs-actual', async (req) => {
    await need(req, 'budget.manage', 'accounts.view')
    await postPending(db, now())
    const q = req.query as { from?: string; to?: string }
    const today = await businessDate(db)
    const to = q.to ?? monthEnd(today.slice(0, 7)), from = q.from ?? `${financialYear(to).slice(0, 4)}-04-01`
    if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, 'from and to as YYYY-MM-DD.')
    const actual = await db.query<{ dept: string; kind: string; amt: string }>(
      `select coalesce(l.dept, a.dept, 'admin') as dept, case a.type when 'income' then 'revenue' else 'cost' end as kind,
              sum(case a.type when 'income' then l.credit_paise - l.debit_paise else l.debit_paise - l.credit_paise end) as amt
         from voucher_line l join voucher v on v.id = l.voucher_id join account a on a.code = l.account_code
        where a.type in ('income', 'expense') and v.date between $1 and $2 group by 1, 2`, [from, to])
    const budget = await db.query<{ dept: string; kind: string; amt: string }>(
      'select dept, kind, sum(amount_paise) as amt from budget where month between $1 and $2 group by 1, 2', [from.slice(0, 7), to.slice(0, 7)])
    const get = (rows: { dept: string; kind: string; amt: string }[], d: string, k: string) => n(rows.find((r) => r.dept === d && r.kind === k)?.amt)
    const rows = Object.entries(DEPTS).map(([d, name]) => {
      const ar = get(actual, d, 'revenue'), ac = get(actual, d, 'cost'), br = get(budget, d, 'revenue'), bc = get(budget, d, 'cost')
      return { dept: d, name, revenue: { actualPaise: ar, budgetPaise: br, variancePaise: ar - br }, cost: { actualPaise: ac, budgetPaise: bc, variancePaise: bc - ac }, profit: { actualPaise: ar - ac, budgetPaise: br - bc, variancePaise: (ar - ac) - (br - bc) } }
    }).filter((r) => r.revenue.actualPaise || r.cost.actualPaise || r.revenue.budgetPaise || r.cost.budgetPaise)
    return { from, to, rows }
  })

  // ---------- Tally ----------
  /** Tally group for each of our headings, so the ledgers land in the right place in the CA's Tally. */
  const TALLY_GROUP = (grp: string, type: string, code: string) => {
    if (code === '1100' || code === '1110') return 'Cash-in-Hand'
    if (/^12/.test(code) && !['1210', '1220'].includes(code)) return 'Bank Accounts'
    const g: Record<string, string> = {
      'Trade receivables': 'Sundry Debtors', 'Trade payables': 'Sundry Creditors', 'Duties and taxes': 'Duties & Taxes', 'Taxes recoverable': 'Duties & Taxes', Inventories: 'Stock-in-Hand',
      'Property, plant and equipment': 'Fixed Assets', Equity: 'Capital Account', 'Revenue from operations': 'Sales Accounts', 'Other income': 'Indirect Incomes',
      'Cost of materials consumed': 'Purchase Accounts', 'Changes in inventories': 'Direct Expenses',
    }
    return g[grp] ?? (type === 'expense' ? 'Indirect Expenses' : type === 'income' ? 'Indirect Incomes' : type === 'asset' ? 'Current Assets' : type === 'liability' ? 'Current Liabilities' : 'Capital Account')
  }
  const VCH: Record<string, string> = { sales: 'Sales', receipt: 'Receipt', purchase: 'Purchase', payment: 'Payment', contra: 'Contra', stock: 'Journal', journal: 'Journal', reversal: 'Journal' }

  app.get('/api/accounts/tally.xml', async (req, reply) => {
    await need(req, 'accounts.view')
    await postPending(db, now())
    const q = req.query as { from?: string; to?: string; masters?: string }
    const today = await businessDate(db)
    const to = q.to ?? today, from = q.from ?? `${today.slice(0, 7)}-01`
    if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, 'from and to as YYYY-MM-DD.')
    const [p] = await db.query<{ legal_name: string | null; name: string }>('select legal_name, name from property limit 1')
    const company = p.legal_name ?? p.name
    const vs = await db.query<{ id: string; number: string; kind: string; date: string; narration: string }>('select id, number, kind, date::text, narration from voucher where date between $1 and $2 order by date, created_at', [from, to])
    const lines = vs.length ? await db.query<{ voucher_id: string; account_code: string; account: string; debit_paise: string; credit_paise: string; party_type: string | null; party_name: string | null }>(
      'select l.voucher_id, l.account_code, a.name as account, l.debit_paise, l.credit_paise, l.party_type, l.party_name from voucher_line l join account a on a.code = l.account_code where l.voucher_id = any($1) order by l.voucher_id, l.line', [vs.map((v) => v.id)]) : []
    // A line with a vendor or company on it goes to that party's own ledger in Tally (under creditors or debtors).
    const ledgerOf = (l: (typeof lines)[number]) => (l.party_name && ['vendor', 'company', 'ota'].includes(l.party_type ?? '') && ['2100', '1310', '1320'].includes(l.account_code) ? l.party_name : l.account)
    const amt = (paise: number) => (paise / 100).toFixed(2)
    let masters = ''
    if (q.masters === '1') {
      const accounts = await db.query<{ code: string; name: string; type: string; grp: string }>('select code, name, type, grp from account where active order by code')
      const parties = [...new Map(lines.filter((l) => ledgerOf(l) !== l.account).map((l) => [ledgerOf(l), l.account_code === '2100' ? 'Sundry Creditors' : 'Sundry Debtors'])).entries()]
      masters = [...accounts.map((a) => [a.name, TALLY_GROUP(a.grp, a.type, a.code)]), ...parties].map(([name, parent]) =>
        `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(name)}" ACTION="Create"><NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST><PARENT>${esc(parent)}</PARENT></LEDGER></TALLYMESSAGE>`).join('\n')
    }
    const vouchers = vs.map((v) => {
      const ls = lines.filter((l) => l.voucher_id === v.id)
      return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${VCH[v.kind] ?? 'Journal'}" ACTION="Create"><DATE>${v.date.replace(/-/g, '')}</DATE><VOUCHERTYPENAME>${VCH[v.kind] ?? 'Journal'}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER><NARRATION>${esc(v.narration)}</NARRATION>
${ls.map((l) => { const d = n(l.debit_paise), c = n(l.credit_paise); return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ledgerOf(l))}</LEDGERNAME><ISDEEMEDPOSITIVE>${d ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${d ? `-${amt(d)}` : amt(c)}</AMOUNT></ALLLEDGERENTRIES.LIST>` }).join('\n')}
</VOUCHER></TALLYMESSAGE>`
    }).join('\n')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>
${masters}
${vouchers}
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
    return reply.type('application/xml; charset=utf-8').header('content-disposition', `attachment; filename="Tally_${from}_${to}.xml"`).send(xml)
  })
}
