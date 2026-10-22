import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View } from '../ui/workspace'
import { ItemsView, StoresView, type Item, type Store } from './items'
import { IndentsView, MarketView, PosView } from './purchase'
import { BillsView, PaymentsView, ReceiptsView } from './payables'
import { CountsView, StockView } from './stock'
import { MonthCloseView } from './close'
import { RatesView, VendorsView } from './vendors'
import { BarView } from '../fnb/bar'
import { KitchenStockView } from '../fnb/kitchen-stock'

// Stores and purchase: indents, purchase orders, the market list, goods received, vendor bills and payments,
// items, vendors, rate contracts and the stores, plus the kitchen's and the bar's own stock.

type Tab = 'indents' | 'pos' | 'market' | 'receipts' | 'stock' | 'kstock' | 'bar' | 'counts' | 'close' | 'bills' | 'payments' | 'items' | 'vendors' | 'rates' | 'stores'

export class InventoryWorkspace extends Workspace<Tab> {
  protected views: Record<Tab, View>
  private storeList: Store[] | null = null

  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Stores & purchase', onClose)
    this.views = { indents: new IndentsView(this), pos: new PosView(this), market: new MarketView(this), receipts: new ReceiptsView(this), stock: new StockView(this), counts: new CountsView(this), close: new MonthCloseView(this), bills: new BillsView(this), payments: new PaymentsView(this), items: new ItemsView(this), vendors: new VendorsView(this), rates: new RatesView(this), stores: new StoresView(this), kstock: new KitchenStockView(this), bar: new BarView(this) }
    this.tab = this.tabs()[0]?.[0] ?? 'items'
  }

  static allowed(me: Me) {
    const p = me.permissions
    return ['*', 'stores.view', 'stores.manage', 'vendors.manage', 'purchase.indent', 'purchase.order', 'purchase.approve', 'indent.approve', 'stores.receive', 'purchase.bill', 'purchase.pay', 'payables.view', 'stores.issue', 'stores.count', 'stores.breakage', 'stock.approve',
      'kitchen.stock', 'kitchen', 'food_cost.view', 'bar.stock', 'bar.approve'].some((x) => p.includes(x)) || me.roles.includes('bartender')
  }

  tabs(): [Tab, string][] {
    const t: [Tab, string][] = []
    if (this.can('purchase.indent', 'indent.approve', 'purchase.order')) t.push(['indents', 'Indents'])
    if (this.can('purchase.order', 'purchase.approve', 'stores.view')) t.push(['pos', 'Purchase orders'])
    if (this.can('purchase.order')) t.push(['market', 'Market list'])
    if (this.can('stores.receive', 'purchase.order', 'stores.view')) t.push(['receipts', 'Goods received'])
    if (this.can('stores.view', 'stores.issue', 'stores.count')) t.push(['stock', 'Stock'])
    if (this.can('kitchen.stock', 'kitchen', 'food_cost.view')) t.push(['kstock', 'Kitchen stock'])
    if (this.can('bar.stock', 'bar.approve') || this.me.roles.includes('bartender')) t.push(['bar', 'Bar stock'])
    if (this.can('stores.count', 'stores.breakage', 'stock.approve')) t.push(['counts', 'Counts & breakage'])
    if (this.can('stores.view', 'stores.count', 'stock.approve', 'payables.view')) t.push(['close', 'Month close'])
    if (this.can('purchase.bill', 'purchase.approve', 'payables.view')) t.push(['bills', 'Bills'])
    if (this.can('purchase.pay', 'payables.view')) t.push(['payments', 'Payments'])
    if (this.can('stores.view', 'stores.manage', 'vendors.manage')) t.push(['items', 'Items'], ['vendors', 'Vendors'], ['rates', 'Rates'], ['stores', 'Stores'])
    return t
  }

  private itemList: Item[] | null = null
  async items() { return (this.itemList ??= await this.api.get<Item[]>('/api/items')) }

  /** Stores, the main store first (the usual one to issue from and count). */
  async stores(fresh = false) {
    if (fresh || !this.storeList) this.storeList = (await this.cached<Store[]>('/api/stores')).sort((a, b) => Number(b.kind === 'main') - Number(a.kind === 'main'))
    return this.storeList
  }
}
