import type { FastifyInstance, FastifyRequest } from 'fastify'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { addDays, newId } from '../eng-core'
import { businessDate } from '../fo-core'
import { createApproval, registerApprovalKind } from './approvals'
import { requireCaller } from './auth'
import { costPerMl } from './bar'
import { foodCost } from './kitchen-stock'

// Month close, store by store: the month valued from the book the store keeps (opening, receipts, issues,
// losses, count variance, closing), the closing count found, the variance held against the limit agreed
// for that store, theoretical against actual food cost for the kitchen, and the GM's sign-off. Once a
// month is closed (or waiting for the GM) nothing more can be dated in it.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
/** The closing count must be taken in the month's last days. */
export const CLOSE_COUNT_DAYS = 5
const READ = ['stores.view', 'stores.count', 'stock.approve', 'payables.view']

type Bucket = 'receipts' | 'issues' | 'losses' | 'variance'
export interface MonthFigures {
  openingPaise: number; receiptsPaise: number; issuesPaise: number; lossesPaise: number; variancePaise: number; closingPaise: number
  basePaise: number; variancePercent: number; moved: boolean
}
interface CloseRow {
  id: string; store_id: string; status: string; opening_paise: string; receipts_paise: string; issues_paise: string; losses_paise: string; variance_paise: string
  closing_paise: string; variance_percent: string; decided_by_name: string | null
}
interface StoreRow { id: string; name: string; kind: string; ledger: string; active: boolean; variance_limit_percent: string }

export function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number)
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }
}
export const nextMonth = (month: string) => addDays(monthBounds(month).to, 1).slice(0, 7)

/** Value of each movement in the store's book up to the month's end, split into before the month and in it. */
async function movements(t: Db, store: StoreRow, from: string, to: string): Promise<{ before: boolean; bucket: Bucket; v: number }[]> {
  const sql: Record<string, string> = {
    own: `select business_date < $2 as before, case kind when 'count_adjust' then 'variance' when 'issue' then 'issues' when 'transfer_out' then 'issues'
                 when 'breakage' then 'losses' when 'expired' then 'losses' else 'receipts' end as bucket, sum(value_paise) as v
            from stock_move where store_id = $1 and business_date <= $3 group by 1, 2`,
    kitchen: `select business_date < $2 as before, case kind when 'count_adjust' then 'variance' when 'consumption' then 'issues' when 'wastage' then 'losses' else 'receipts' end as bucket,
                     sum(cost_paise) as v from kitchen_stock_move where business_date <= $3 and $1::text is not null group by 1, 2`,
    spares: `select (at at time zone 'Asia/Kolkata')::date < $2 as before, case kind when 'adjust' then 'variance' when 'issue' then 'issues' else 'receipts' end as bucket,
                    sum(value_paise) as v from spare_move where (at at time zone 'Asia/Kolkata')::date <= $3 and $1::text is not null group by 1, 2`,
    // Linen owned (on the shelf, in the rooms or at the laundry), at the linked item's last cost; laundry trips move nothing.
    linen: `select m.business_date < $2 as before, case m.kind when 'count_adjust' then 'variance' when 'purchase' then 'receipts' else 'losses' end as bucket,
                   sum(case when m.kind in ('discard', 'laundry_loss') then -m.qty else m.qty end * coalesce((select max(i.last_cost_paise) from item i where i.linen_item_id = m.item_id), 0)) as v
              from linen_move m where m.kind in ('purchase', 'discard', 'laundry_loss', 'count_adjust') and m.business_date <= $3 and $1::text is not null group by 1, 2`,
  }
  if (store.ledger === 'bar') {
    // Bottles in ml, valued at each brand's latest TASMAC cost.
    const rows = await t.query<{ before: boolean; bucket: Bucket; brand_id: string; bottle_ml: number; ml: string }>(
      `select m.business_date < $1 as before, case m.kind when 'count_adjust' then 'variance' when 'purchase' then 'receipts' when 'breakage' then 'losses' else 'issues' end as bucket,
              m.brand_id, b.bottle_ml, sum(m.ml) as ml
         from bar_stock_move m join liquor_brand b on b.id = m.brand_id where m.business_date <= $2 group by 1, 2, 3, 4`, [from, to])
    const cpm = new Map<string, number>()
    for (const r of rows) if (!cpm.has(r.brand_id)) cpm.set(r.brand_id, await costPerMl(t, r.brand_id, r.bottle_ml))
    return rows.map((r) => ({ before: r.before, bucket: r.bucket, v: Number(r.ml) * cpm.get(r.brand_id)! }))
  }
  const rows = await t.query<{ before: boolean; bucket: Bucket; v: string | null }>(sql[store.ledger], [store.id, from, to])
  return rows.map((r) => ({ before: r.before, bucket: r.bucket, v: Number(r.v ?? 0) }))
}

export async function monthFigures(t: Db, store: StoreRow, month: string): Promise<MonthFigures> {
  const { from, to } = monthBounds(month)
  const rows = await movements(t, store, from, to)
  const sum = (f: (r: (typeof rows)[number]) => boolean) => Math.round(rows.filter(f).reduce((a, r) => a + r.v, 0))
  const opening = sum((r) => r.before)
  const by = (b: Bucket) => sum((r) => !r.before && r.bucket === b)
  const receipts = by('receipts'), issues = by('issues'), losses = by('losses'), variance = by('variance')
  // The variance is a share of what the store gave out in the month; a store that gave nothing out, of what it held.
  const used = -(issues + losses)
  const base = used > 0 ? used : Math.max(0, opening + receipts)
  return {
    openingPaise: opening, receiptsPaise: receipts, issuesPaise: issues, lossesPaise: losses, variancePaise: variance,
    closingPaise: opening + receipts + issues + losses + variance, basePaise: base,
    variancePercent: base ? Math.round((Math.abs(variance) / base) * 10000) / 100 : 0,
    moved: rows.some((r) => !r.before && Math.round(r.v) !== 0),
  }
}

/** The latest physical count of the store in the month's last days: a stores count, the kitchen's, or an approved bar count. */
export async function closingCount(t: Db, store: StoreRow, month: string): Promise<{ ref: string; date: string } | null> {
  const { to } = monthBounds(month), from = addDays(to, 1 - CLOSE_COUNT_DAYS)
  const [c] = await t.query<{ ref: string; date: string }>(
    `select number as ref, business_date::text as date from stock_count where store_id = $1 and status = 'applied' and business_date between $2 and $3 order by business_date desc, counted_at desc limit 1`, [store.id, from, to])
  if (c) return c
  if (store.ledger === 'kitchen') {
    const [k] = await t.query<{ ref: string; date: string }>(
      `select entity_id as ref, entry->'after'->>'day' as date from audit_log where action = 'kitchen.count' and entry->'after'->>'day' between $1 and $2 order by seq desc limit 1`, [from, to])
    if (k) return k
  }
  if (store.ledger === 'bar') {
    const [b] = await t.query<{ ref: string; date: string }>(
      `select id as ref, business_date::text as date from bar_count where status = 'approved' and business_date between $1 and $2 order by business_date desc, counted_at desc limit 1`, [from, to])
    if (b) return b
  }
  return null
}

async function closeMonth(t: Db, id: string, decider: Caller, at: Date) {
  const [c] = await t.query<{ status: string }>('select status from month_close where id = $1 for update', [id])
  if (c?.status !== 'pending_approval') throw new HttpError(409, 'This month close is no longer waiting for approval.')
  await t.query(`update month_close set status = 'closed', decided_by = $2, decided_at = $3 where id = $1`, [id, decider.userId, at])
}

registerApprovalKind('stock.month_close', {
  permission: 'stock.approve',
  async apply(t, p, decider, ctx) {
    await closeMonth(t, String(p.closeId), decider, ctx.now())
    await appendAudit(t, { actor: decider, action: 'stock.month_closed', entity: { type: 'month_close', id: String(p.closeId) }, after: { store: p.storeId, month: p.month } }, ctx.now())
  },
  async reject(t, p, decider, ctx) {
    await t.query(`update month_close set status = 'rejected', decided_by = $2, decided_at = $3 where id = $1 and status = 'pending_approval'`, [p.closeId, decider.userId, ctx.now()])
  },
})

export function monthCloseRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }
  async function monthOf(t: Db, m: string | undefined) {
    const today = await businessDate(t)
    const month = m ?? addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)     // the month just gone
    if (!MONTH.test(month)) throw new HttpError(400, 'The month as YYYY-MM.')
    return { month, today }
  }
  const stores = (t: Db, id?: string) => t.query<StoreRow>(`select id, name, kind, ledger, active, variance_limit_percent from store where ($1::text is null or id = $1) order by kind = 'main' desc, name`, [id ?? null])

  /** Every store's month: the figures, the closing count, the limit, and where its close stands. */
  async function overview(t: Db, month: string, today: string) {
    const { from, to } = monthBounds(month)
    const closes = await t.query<CloseRow>(
      `select c.*, c.count_date::text, p.name as prepared_by_name, d.name as decided_by_name from month_close c join app_user p on p.id = c.prepared_by left join app_user d on d.id = c.decided_by
        where c.month = $1 order by c.prepared_at desc`, [month])
    const out = []
    for (const s of await stores(t)) {
      const close = closes.find((c) => c.store_id === s.id && c.status !== 'rejected') ?? closes.find((c) => c.store_id === s.id) ?? null
      const figures = await monthFigures(t, s, month)
      if (!s.active && !figures.moved && !figures.openingPaise && !close) continue
      const count = await closingCount(t, s, month)
      const limit = Number(s.variance_limit_percent)
      out.push({
        storeId: s.id, name: s.name, ledger: s.ledger, limitPercent: limit, figures, count, close,
        countNeeded: figures.moved || figures.openingPaise !== 0, withinLimit: figures.variancePercent <= limit,
        food: s.ledger === 'kitchen' ? (await foodCost(t, from, to)).totals : null,
      })
    }
    return { month, from, to, over: to < today, countFrom: addDays(to, 1 - CLOSE_COUNT_DAYS), stores: out }
  }

  app.get('/api/month-close', async (req) => {
    await need(req, ...READ)
    const { month, today } = await monthOf(db, (req.query as { month?: string }).month)
    return overview(db, month, today)
  })

  app.post('/api/month-close', async (req, reply) => {
    const who = await need(req, 'stores.count', 'stock.approve')
    const b = (req.body ?? {}) as { storeId?: string; month?: string; note?: string }
    return db.tx(async (t) => {
      const { month, today } = await monthOf(t, b.month)
      const [s] = await stores(t, b.storeId ?? '')
      if (!s) throw new HttpError(404, 'No such store.')
      const { from, to } = monthBounds(month)
      if (to >= today) throw new HttpError(409, `${month} is not over yet: close it from ${addDays(to, 1)}.`)
      const [last] = await t.query<{ month: string; status: string }>(`select month, status from month_close where store_id = $1 and status <> 'rejected' order by month desc limit 1`, [s.id])
      if (last && last.month >= month) throw new HttpError(409, `${s.name}: ${last.month} is already ${last.status === 'closed' ? 'closed' : 'with the GM'}${last.month > month ? `, so ${month} is locked` : ''}.`)
      if (last && nextMonth(last.month) !== month) throw new HttpError(409, `${s.name}: close ${nextMonth(last.month)} first.`)
      const f = await monthFigures(t, s, month)
      const count = await closingCount(t, s, month)
      if (!count && (f.moved || f.openingPaise !== 0)) throw new HttpError(409, `${s.name}: count the store between ${addDays(to, 1 - CLOSE_COUNT_DAYS)} and ${to} first (the closing count).`)
      const limit = Number(s.variance_limit_percent), note = b.note?.trim() || null
      if (f.variancePercent > limit && (note?.length ?? 0) < 10) throw new HttpError(400, `${s.name}: the variance is ${f.variancePercent}%, over the ${limit}% agreed. Explain it for the GM.`)
      const food = s.ledger === 'kitchen' ? (await foodCost(t, from, to)).totals : null
      const id = newId('MC')
      await t.query(
        `insert into month_close (id, store_id, month, status, opening_paise, receipts_paise, issues_paise, losses_paise, variance_paise, closing_paise, base_paise, variance_percent, limit_percent,
           count_ref, count_date, food, note, prepared_by, prepared_at) values ($1,$2,$3,'pending_approval',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [id, s.id, month, f.openingPaise, f.receiptsPaise, f.issuesPaise, f.lossesPaise, f.variancePaise, f.closingPaise, f.basePaise, f.variancePercent, limit,
          count?.ref ?? null, count?.date ?? null, food ? JSON.stringify(food) : null, note, who.userId, now()])
      // The GM signs it off; a close the GM prepares is signed off by preparing it.
      let status = 'pending_approval', approvalId: string | null = null
      if (can(who, 'stock.approve')) {
        await closeMonth(t, id, who, now()); status = 'closed'
      } else {
        approvalId = await createApproval(ctx, t, 'stock.month_close', who.userId, { closeId: id, storeId: s.id, month },
          `${s.name} ${month}: variance ${f.variancePercent}% (limit ${limit}%)${note ? ` · ${note}` : ''}`)
        await t.query('update month_close set approval_id = $2 where id = $1', [id, approvalId])
      }
      await appendAudit(t, { actor: who, action: status === 'closed' ? 'stock.month_closed' : 'stock.month_close', entity: { type: 'month_close', id }, amount: f.variancePaise,
        after: { store: s.id, month, closing: f.closingPaise, variancePercent: f.variancePercent, limit, status } }, now())
      return reply.status(201).send({ id, status, approvalId, ...f, limitPercent: limit, withinLimit: f.variancePercent <= limit })
    })
  })

  // The variance limit is agreed with the GM, not set by the store that is held to it.
  app.post('/api/stores/:id/variance-limit', async (req) => {
    const who = await need(req, 'stock.approve')
    const { id } = req.params as { id: string }
    const pct = Number((req.body as { percent?: number } | null)?.percent)
    if (!(pct >= 0 && pct <= 100)) throw new HttpError(400, 'The limit as a percentage, 0 to 100.')
    return db.tx(async (t) => {
      const [before] = await t.query<{ variance_limit_percent: string }>('select variance_limit_percent from store where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such store.')
      await t.query('update store set variance_limit_percent = $2 where id = $1', [id, pct])
      await appendAudit(t, { actor: who, action: 'store.variance_limit', entity: { type: 'store', id }, before: { percent: Number(before.variance_limit_percent) }, after: { percent: pct } }, now())
      return { id, varianceLimitPercent: pct }
    })
  })

  // The month-end stock statement, every store on one page, for the accounts and the auditor.
  app.get('/api/month-close/print', async (req, reply) => {
    await need(req, ...READ)
    const { month, today } = await monthOf(db, (req.query as { month?: string }).month)
    const o = await overview(db, month, today)
    const [p] = await db.query<{ legal_name: string | null; name: string }>('select legal_name, name from property limit 1')
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
    const r = (paise: number) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const STATE: Record<string, string> = { closed: 'Closed', pending_approval: 'With the GM', rejected: 'Sent back' }
    const rows = o.stores.map((s) => {
      const f = s.close ? { openingPaise: +s.close.opening_paise, receiptsPaise: +s.close.receipts_paise, issuesPaise: +s.close.issues_paise, lossesPaise: +s.close.losses_paise, variancePaise: +s.close.variance_paise, closingPaise: +s.close.closing_paise, variancePercent: +s.close.variance_percent } : s.figures
      return `<tr><td>${esc(s.name)}</td><td class="n">${r(f.openingPaise)}</td><td class="n">${r(f.receiptsPaise)}</td><td class="n">${r(0 - f.issuesPaise)}</td><td class="n">${r(0 - f.lossesPaise)}</td>
        <td class="n">${r(f.variancePaise)}</td><td class="n">${r(f.closingPaise)}</td><td class="n">${f.variancePercent.toFixed(2)}% / ${s.limitPercent}%</td><td>${esc(s.count ? `${s.count.ref} (${s.count.date})` : '—')}</td>
        <td>${esc(s.close ? `${STATE[s.close.status]}${s.close.decided_by_name ? ` · ${s.close.decided_by_name}` : ''}` : 'Open')}</td></tr>`
    }).join('')
    const k = o.stores.find((s) => s.food)?.food
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Stock statement ${esc(month)}</title><style>
      body{font:12px system-ui;margin:20px;color:#111}h1{font-size:18px;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left}.n{text-align:right}
      .muted{color:#555}.sign{margin-top:40px;display:flex;justify-content:space-between}</style></head><body>
      <h1>Month-end stock statement · ${esc(month)}</h1><div>${esc(p?.legal_name ?? p?.name ?? '')}</div>
      <p class="muted">Values in ₹ at book cost. Variance: physical count against the book, as a share of what the store gave out in the month, against the limit agreed for that store.</p>
      <table><tr><th>Store</th><th class="n">Opening</th><th class="n">Received</th><th class="n">Issued / used</th><th class="n">Losses</th><th class="n">Count variance</th><th class="n">Closing</th><th class="n">Variance / limit</th><th>Closing count</th><th>Status</th></tr>${rows}</table>
      ${k ? `<p>Kitchen food cost: sales ₹${r(k.salesPaise)}; theoretical ₹${r(k.theoreticalCostPaise)} (${k.theoreticalPercent}%); actual with wastage ₹${r(k.wastagePaise)} and count loss ₹${r(k.countLossPaise)}: ₹${r(k.actualCostPaise)} (${k.actualPercent}%).</p>` : ''}
      <div class="sign"><div>Stores</div><div>Accounts</div><div>General manager</div></div><script>window.onload=()=>window.print()</script></body></html>`
    return reply.type('text/html; charset=utf-8').send(html)
  })
}
