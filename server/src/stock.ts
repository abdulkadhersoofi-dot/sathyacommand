import type { Db } from './db'

// Stock of an item in a store, read from the book that store keeps: the kitchen ingredient book, the bar
// register (ml), the engineering spares book, the linen shelf, or the store's own ledger.

export interface StockItem { id: string; ingredient_id: string | null; brand_id: string | null; spare_id: string | null; linen_item_id: string | null }

export async function storeLedger(t: Db, storeId: string) {
  const [s] = await t.query<{ ledger: string }>('select ledger from store where id = $1', [storeId])
  return s?.ledger ?? null
}

export async function stockOf(t: Db, item: StockItem, storeId: string): Promise<number> {
  const ledger = await storeLedger(t, storeId)
  const one = async (sql: string, arg: unknown) => Number((await t.query<{ q: string | null }>(sql, [arg]))[0]?.q ?? 0)
  if (ledger === 'kitchen' && item.ingredient_id) return one('select sum(qty) as q from kitchen_stock_move where ingredient_id = $1', item.ingredient_id)
  if (ledger === 'bar' && item.brand_id) return one('select sum(ml) as q from bar_stock_move where brand_id = $1', item.brand_id)
  if (ledger === 'spares' && item.spare_id) return one('select sum(qty) as q from spare_move where spare_id = $1', item.spare_id)
  if (ledger === 'linen' && item.linen_item_id) {
    return one(`select sum(case kind when 'purchase' then qty when 'send_laundry' then -qty when 'receive_laundry' then qty when 'discard' then -qty when 'count_adjust' then qty else 0 end) as q
                  from linen_move where item_id = $1`, item.linen_item_id)
  }
  if (ledger === 'own') return Number((await t.query<{ q: string | null }>('select sum(qty) as q from stock_move where item_id = $1 and store_id = $2', [item.id, storeId]))[0]?.q ?? 0)
  return 0
}

export type MoveKind = 'opening' | 'receipt' | 'issue' | 'transfer_in' | 'transfer_out' | 'return' | 'count_adjust' | 'breakage' | 'expired'
export interface Move {
  item: StockItem & { name: string }; storeId: string; kind: MoveKind
  qty: number                 // stock units: in +, out -
  value: number               // paise, signed like qty
  ref: string | null; note?: string | null; vendor?: string | null; userId: string; at: Date; day: string
}

/** A store's month, once closed (or sent to the GM to close), takes no more movements dated in it. */
export async function assertMonthOpen(t: Db, storeId: string, day: string) {
  const [c] = await t.query<{ month: string }>(`select month from month_close where store_id = $1 and status <> 'rejected' and month >= substr($2, 1, 7) order by month desc limit 1`, [storeId, day])
  if (c) {
    const err = new Error(`The stock month ${c.month} is closed for this store: nothing can be dated ${day}.`) as Error & { statusCode: number }
    err.statusCode = 409
    throw err
  }
}

const BOOK_NAME: Record<string, string> = { kitchen: 'kitchen ingredient', bar: 'bar brand', spares: 'spare part', linen: 'linen item' }
let seq = 0
const moveId = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}${(seq++ % 1296).toString(36).toUpperCase().padStart(2, '0')}${Math.random().toString(36).slice(2, 5).toUpperCase()}`

/**
 * Posts a movement into the book the store keeps: its own ledger, or the kitchen, bar, spares or linen
 * book (so a receipt into the kitchen store is a kitchen receipt, with the ingredient's cost updated).
 */
export async function moveStock(t: Db, m: Move) {
  const ledger = await storeLedger(t, m.storeId)
  if (m.kind === 'receipt' && m.qty > 0 && m.value > 0) await t.query('update item set last_cost_paise = $2 where id = $1', [m.item.id, m.value / m.qty])
  if (!ledger) throw new Error(`Unknown store ${m.storeId}`)
  await assertMonthOpen(t, m.storeId, m.day)
  const inward = m.qty > 0
  const link = { kitchen: m.item.ingredient_id, bar: m.item.brand_id, spares: m.item.spare_id, linen: m.item.linen_item_id }[ledger as 'kitchen']
  if (ledger !== 'own' && !link) {
    const err = new Error(`${m.item.name} is not linked to a ${BOOK_NAME[ledger]}: link it on the item, or use the main store.`) as Error & { statusCode: number }
    err.statusCode = 409
    throw err
  }
  if (ledger === 'own') {
    await t.query('insert into stock_move (id, item_id, store_id, business_date, kind, qty, value_paise, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [moveId('SM'), m.item.id, m.storeId, m.day, m.kind, m.qty, Math.round(m.value), m.ref, m.note ?? null, m.userId, m.at])
  } else if (ledger === 'kitchen') {
    const kind = m.kind === 'count_adjust' ? 'count_adjust' : inward ? 'receipt' : m.kind === 'issue' || m.kind === 'transfer_out' ? 'consumption' : 'wastage'
    await t.query('insert into kitchen_stock_move (id, ingredient_id, business_date, kind, qty, cost_paise, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [moveId('KM'), link, m.day, kind, m.qty, Math.round(m.value), m.ref, m.note ?? null, m.userId, m.at])
    if (inward && m.value > 0 && (m.kind === 'receipt' || m.kind === 'transfer_in')) await t.query('update ingredient set cost_per_unit = $2, placeholder = false where id = $1', [link, m.value / m.qty])
  } else if (ledger === 'bar') {
    const kind = m.kind === 'breakage' ? 'breakage' : inward && m.kind !== 'count_adjust' ? 'purchase' : 'count_adjust'
    await t.query('insert into bar_stock_move (id, brand_id, business_date, kind, ml, ref, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [moveId('BM'), link, m.day, kind, Math.round(m.qty), m.ref, m.note ?? null, m.userId, m.at])
  } else if (ledger === 'spares') {
    if (inward && (m.kind === 'receipt' || m.kind === 'transfer_in')) {
      const [s] = await t.query<{ cost_paise: string; stock: string }>('select s.cost_paise, coalesce((select sum(qty) from spare_move x where x.spare_id = s.id), 0) as stock from spare s where s.id = $1 for update', [link])
      const stock = Math.max(0, Number(s.stock))
      await t.query('update spare set cost_paise = $2 where id = $1', [link, ((stock * Number(s.cost_paise) + m.value) / (stock + m.qty)).toFixed(2)])
    }
    const kind = m.kind === 'count_adjust' || m.kind === 'breakage' || m.kind === 'expired' ? 'adjust' : inward ? 'receive' : 'issue'
    await t.query('insert into spare_move (id, spare_id, kind, qty, value_paise, vendor, note, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [moveId('SM'), link, kind, m.qty, Math.round(m.value), m.vendor ?? null, m.note ?? (m.ref ? `Ref ${m.ref}` : null), m.userId, m.at])
  } else if (ledger === 'linen') {
    if (!Number.isInteger(m.qty)) { const err = new Error(`${m.item.name}: linen is counted in whole pieces.`) as Error & { statusCode: number }; err.statusCode = 400; throw err }
    const kind = m.kind === 'count_adjust' ? 'count_adjust' : inward ? 'purchase' : 'discard'
    await t.query('insert into linen_move (id, item_id, kind, qty, vendor, note, business_date, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [moveId('LM'), link, kind, Math.abs(m.qty) * (kind === 'count_adjust' ? Math.sign(m.qty) : 1), m.vendor ?? null, m.note ?? (m.ref ? `Ref ${m.ref}` : null), m.day, m.userId, m.at])
  }
}

/** Weighted average cost per stock unit of an item in a store, in paise. */
export async function avgCost(t: Db, item: StockItem, storeId: string): Promise<number> {
  const ledger = await storeLedger(t, storeId)
  const num = (v: string | number | null | undefined) => (v == null ? 0 : Number(v))
  if (ledger === 'own') {
    const [r] = await t.query<{ q: string | null; v: string | null }>('select sum(qty) as q, sum(value_paise) as v from stock_move where item_id = $1 and store_id = $2', [item.id, storeId])
    if (num(r.q) > 0 && num(r.v) > 0) return num(r.v) / num(r.q)
  }
  if (ledger === 'kitchen' && item.ingredient_id) return num((await t.query<{ c: string }>('select cost_per_unit as c from ingredient where id = $1', [item.ingredient_id]))[0]?.c)
  if (ledger === 'spares' && item.spare_id) return num((await t.query<{ c: string }>('select cost_paise as c from spare where id = $1', [item.spare_id]))[0]?.c)
  return num((await t.query<{ c: string | null }>('select last_cost_paise as c from item where id = $1', [item.id]))[0]?.c)
}

/** Takes stock out of an own-ledger store's batches, first to expire first (undated batches last). */
export async function takeFromBatches(t: Db, itemId: string, storeId: string, qty: number) {
  let left = qty
  const batches = await t.query<{ id: string; qty_left: string }>(
    'select id, qty_left from stock_batch where item_id = $1 and store_id = $2 and qty_left > 0 order by expiry nulls last, created_at for update', [itemId, storeId])
  for (const b of batches) {
    if (left <= 0) break
    const take = Math.min(left, Number(b.qty_left))
    await t.query('update stock_batch set qty_left = qty_left - $2 where id = $1', [b.id, take])
    left -= take
  }
}
