import type { FastifyInstance, FastifyRequest } from 'fastify'
import { financialYear } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, daysBetween, istDay, newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { requireCaller } from './auth'

// Excise: the liquor stock register by brand and bottle size (opening, received, sold, broken, adjusted,
// closing) in bottles and bulk litres, for a day or a period, printed in the licence's format; the TCS
// that TASMAC collects on each purchase (a tax credit); and the peg measures and scales with their
// legal-metrology stamping dates (on the compliance calendar).

const DATE = /^\d{4}-\d{2}-\d{2}$/
const KINDS = ['peg_measure', 'scale', 'dispenser', 'other']
const quarterOf = (day: string) => { const m = Number(day.slice(5, 7)); return m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4 }

interface RegisterRow { id: string; name: string; liquor_class: string; label: string; bottle_ml: number; opening: number; received: number; sold: number; breakage: number; adjusted: number }

/** Stock movements by brand between two days (inclusive), in ml, with the bottles and bulk litres. */
export async function register(db: Db, from: string, to: string) {
  const rows = await db.query<RegisterRow>(
    `select b.id, b.name, b.liquor_class, c.label, b.bottle_ml,
            coalesce(sum(m.ml) filter (where m.business_date < $1), 0)::int as opening,
            coalesce(sum(m.ml) filter (where m.business_date between $1 and $2 and m.kind = 'purchase'), 0)::int as received,
            coalesce(-sum(m.ml) filter (where m.business_date between $1 and $2 and m.kind in ('sale', 'sale_reversal')), 0)::int as sold,
            coalesce(-sum(m.ml) filter (where m.business_date between $1 and $2 and m.kind = 'breakage'), 0)::int as breakage,
            coalesce(sum(m.ml) filter (where m.business_date between $1 and $2 and m.kind = 'count_adjust'), 0)::int as adjusted
       from liquor_brand b join liquor_class c on c.id = b.liquor_class left join bar_stock_move m on m.brand_id = b.id and m.business_date <= $2
      group by b.id, c.label having b.active or coalesce(sum(m.ml), 0) <> 0 order by c.label, b.name, b.bottle_ml`, [from, to])
  const bottles = (ml: number, size: number) => Math.round((ml / size) * 100) / 100
  return rows.map((r) => {
    const closing = r.opening + r.received - r.sold - r.breakage + r.adjusted
    return { ...r, closing, bottles: { opening: bottles(r.opening, r.bottle_ml), received: bottles(r.received, r.bottle_ml), sold: bottles(r.sold, r.bottle_ml), breakage: bottles(r.breakage, r.bottle_ml), adjusted: bottles(r.adjusted, r.bottle_ml), closing: bottles(closing, r.bottle_ml) },
      bulkLitres: { received: r.received / 1000, sold: r.sold / 1000, closing: closing / 1000 } }
  })
}

export function exciseRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  const READ = ['bar.stock', 'bar.approve', 'tax.vat', 'licences.edit', 'compliance.view']

  async function period(req: FastifyRequest) {
    const q = req.query as { from?: string; to?: string }
    const today = await businessDate(db)
    const to = q.to ?? today, from = q.from ?? to
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw new HttpError(400, 'from and to as YYYY-MM-DD.')
    if (daysBetween(from, to) > 92) throw new HttpError(400, 'Up to three months at a time.')
    return { from, to }
  }

  app.get('/api/excise/register', async (req) => {
    await need(req, ...READ)
    const { from, to } = await period(req)
    const rows = await register(db, from, to)
    const totals = rows.reduce((a, r) => ({ received: a.received + r.received, sold: a.sold + r.sold, breakage: a.breakage + r.breakage, closing: a.closing + r.closing }), { received: 0, sold: 0, breakage: 0, closing: 0 })
    return { from, to, brands: rows, totalsMl: totals }
  })

  // The register as the licence asks for it: one page per day, or the statement for the period.
  app.get('/api/excise/register/print', async (req, reply) => {
    await need(req, ...READ)
    const { from, to } = await period(req)
    const daily = (req.query as { daily?: string }).daily === '1'
    const [p] = await db.query<{ legal_name: string | null; name: string; address: string | null; city: string | null }>('select legal_name, name, address, city from property limit 1')
    const [lic] = await db.query<{ number: string; valid_until: string | null }>(`select number, valid_until::text from licence where kind = 'fl3' and active order by valid_until desc nulls last limit 1`)
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
    const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
    const table = (rows: Awaited<ReturnType<typeof register>>) => `<table><tr><th>Class</th><th>Brand</th><th>Size (ml)</th><th class="n">Opening</th><th class="n">Received</th><th class="n">Sold</th><th class="n">Breakage</th><th class="n">Adjusted</th><th class="n">Closing</th><th class="n">Closing (bulk litres)</th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.name)}</td><td>${r.bottle_ml}</td><td class="n">${fmt(r.bottles.opening)}</td><td class="n">${fmt(r.bottles.received)}</td><td class="n">${fmt(r.bottles.sold)}</td><td class="n">${fmt(r.bottles.breakage)}</td><td class="n">${fmt(r.bottles.adjusted)}</td><td class="n">${fmt(r.bottles.closing)}</td><td class="n">${fmt(r.bulkLitres.closing)}</td></tr>`).join('')}</table>`
    const pages: string[] = []
    if (daily) for (let d = from; d <= to; d = addDays(d, 1)) pages.push(`<section><h2>${esc(d)}</h2>${table(await register(db, d, d))}</section>`)
    else pages.push(`<section><h2>${esc(from)} to ${esc(to)}</h2>${table(await register(db, from, to))}</section>`)
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Liquor stock register ${esc(from)}${from !== to ? ` to ${esc(to)}` : ''}</title><style>
      body{font:12px system-ui;margin:20px;color:#111}h1{font-size:18px;margin:0}h2{font-size:14px;margin:18px 0 6px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left}.n{text-align:right}
      section{break-after:page}.muted{color:#555}.sign{margin-top:40px;display:flex;justify-content:space-between}</style></head><body>
      <h1>Liquor stock register (in bottles)</h1><div>${esc([p.legal_name ?? p.name, p.address, p.city].filter(Boolean).join(', '))}</div>
      <div>FL-3 licence ${esc(lic?.number ?? '— not entered —')}${lic?.valid_until ? ` · valid until ${esc(lic.valid_until)}` : ''}</div>
      <p class="muted">Sold: pegs and bottles billed, converted at the bottle size. Adjusted: physical counts approved by the GM.</p>
      ${pages.join('')}<div class="sign"><div>Bar manager</div><div>Licensee / authorised signatory</div></div><script>window.onload=()=>window.print()</script></body></html>`
    return reply.type('text/html; charset=utf-8').send(html)
  })

  // TCS collected by TASMAC on purchases, by quarter: claimed against the income tax, matched with Form 26AS.
  app.get('/api/excise/tcs', async (req) => {
    await need(req, 'bar.stock', 'tax.vat', 'payables.view')
    const fy = (req.query as { fy?: string }).fy ?? financialYear(istDay(now()))
    const start = `${fy.slice(0, 4)}-04-01`, end = `${Number(fy.slice(0, 4)) + 1}-03-31`
    const rows = await db.query<{ invoice_date: string; tcs_paise: string; total_paise: string }>(
      `select id, supplier, invoice_no, invoice_date::text, permit_no, value_paise, vat_paise, tcs_paise, total_paise from tasmac_purchase where invoice_date between $1 and $2 order by invoice_date`, [start, end])
    const quarters = [1, 2, 3, 4].map((q) => {
      const r = rows.filter((x) => quarterOf(x.invoice_date) === q)
      return { quarter: q, purchases: r.length, tcsPaise: r.reduce((a, x) => a + Number(x.tcs_paise), 0) }
    })
    return { fy, section: ctx.tax.income_tax.tcs_paid_by_resort.find((x) => x.on === 'liquor_purchases_from_tasmac')?.old_section ?? '206C(1)', quarters, purchases: rows }
  })

  // ---------- peg measures and scales ----------
  app.get('/api/excise/measures', async (req) => {
    await need(req, 'bar.stock', 'bar.settings', 'licences.edit', 'compliance.view')
    return db.query(`select id, name, kind, capacity, location, stamp_no, stamped_on::text, due_on::text, reminded, active from measure order by active desc, due_on nulls first, name`)
  })

  type MeasureBody = { name?: string; kind?: string; capacity?: string; location?: string; stampNo?: string; stampedOn?: string | null; dueOn?: string | null; active?: boolean }
  function check(b: MeasureBody, partial: boolean) {
    if (!partial || b.name !== undefined) if (!b.name?.trim()) throw new HttpError(400, 'Name the measure (e.g. "Bar peg measure 30 ml #1").')
    if (!partial || b.kind !== undefined) if (!KINDS.includes(b.kind ?? '')) throw new HttpError(400, `Kind: ${KINDS.join(', ')}.`)
    for (const d of [b.stampedOn, b.dueOn]) if (d && !DATE.test(d)) throw new HttpError(400, 'Dates as YYYY-MM-DD.')
    if (b.stampedOn && b.dueOn && b.dueOn <= b.stampedOn) throw new HttpError(400, 'The next stamping is after the last one.')
  }

  app.post('/api/excise/measures', async (req, reply) => {
    const who = await need(req, 'bar.settings', 'licences.edit')
    const b = (req.body ?? {}) as MeasureBody
    check(b, false)
    const id = newId('MS')
    // Legal metrology: re-verified every year unless the stamp says otherwise.
    const due = b.dueOn ?? (b.stampedOn ? addDays(b.stampedOn, 365) : null)
    await db.tx(async (t) => {
      await t.query('insert into measure (id, name, kind, capacity, location, stamp_no, stamped_on, due_on, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, b.name!.trim(), b.kind, b.capacity?.trim() || null, b.location?.trim() || null, b.stampNo?.trim() || null, b.stampedOn || null, due, now()])
      await appendAudit(t, { actor: who, action: 'measure.add', entity: { type: 'measure', id }, after: { ...b, dueOn: due } }, now())
    })
    return reply.status(201).send({ id, dueOn: due })
  })

  app.patch('/api/excise/measures/:id', async (req) => {
    const who = await need(req, 'bar.settings', 'licences.edit')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as MeasureBody
    check(b, true)
    return db.tx(async (t) => {
      const [before] = await t.query('select * from measure where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such measure.')
      const due = b.dueOn !== undefined ? b.dueOn : b.stampedOn ? addDays(b.stampedOn, 365) : undefined
      await t.query(`update measure set name = coalesce($2, name), kind = coalesce($3, kind), capacity = coalesce($4, capacity), location = coalesce($5, location), stamp_no = coalesce($6, stamp_no),
                       stamped_on = coalesce($7, stamped_on), due_on = case when $8::boolean then $9::date else due_on end, active = coalesce($10, active),
                       reminded = case when $8::boolean then 0 else reminded end where id = $1`,
        [id, b.name?.trim() || null, b.kind ?? null, b.capacity?.trim() ?? null, b.location?.trim() ?? null, b.stampNo?.trim() ?? null, b.stampedOn || null, due !== undefined, due || null, b.active ?? null])
      const [after] = await t.query('select * from measure where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'measure.update', entity: { type: 'measure', id }, before, after }, now())
      return after
    })
  })
}
