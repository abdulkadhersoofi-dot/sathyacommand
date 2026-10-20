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
