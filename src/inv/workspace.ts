import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View } from '../ui/workspace'
import { ItemsView, StoresView, type Item, type Store } from './items'
import { IndentsView, MarketView, PosView } from './purchase'
import { RatesView, VendorsView } from './vendors'

// Stores and purchase: indents, purchase orders, the market list, items, vendors, rate contracts and the stores.

type Tab = 'indents' | 'pos' | 'market' | 'items' | 'vendors' | 'rates' | 'stores'

export class InventoryWorkspace extends Workspace<Tab> {
  protected views: Record<Tab, View>
  private storeList: Store[] | null = null

  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Stores & purchase', onClose)
    this.views = { indents: new IndentsView(this), pos: new PosView(this), market: new MarketView(this), items: new ItemsView(this), vendors: new VendorsView(this), rates: new RatesView(this), stores: new StoresView(this) }
    this.tab = this.tabs()[0][0]
  }

  static allowed(me: Me) {
    const p = me.permissions
    return ['*', 'stores.view', 'stores.manage', 'vendors.manage', 'purchase.indent', 'purchase.order', 'purchase.approve', 'indent.approve'].some((x) => p.includes(x))
  }

  tabs(): [Tab, string][] {
    const t: [Tab, string][] = []
    if (this.can('purchase.indent', 'indent.approve', 'purchase.order')) t.push(['indents', 'Indents'])
    if (this.can('purchase.order', 'purchase.approve', 'stores.view')) t.push(['pos', 'Purchase orders'])
    if (this.can('purchase.order')) t.push(['market', 'Market list'])
    if (this.can('stores.view', 'stores.manage', 'vendors.manage')) t.push(['items', 'Items'], ['vendors', 'Vendors'], ['rates', 'Rates'], ['stores', 'Stores'])
    return t
  }

  private itemList: Item[] | null = null
  async items() { return (this.itemList ??= await this.api.get<Item[]>('/api/items')) }

  async stores(fresh = false) { if (fresh || !this.storeList) this.storeList = await this.cached<Store[]>('/api/stores'); return this.storeList }
}
