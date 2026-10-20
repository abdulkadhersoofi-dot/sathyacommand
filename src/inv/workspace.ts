import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View } from '../ui/workspace'
import { ItemsView, StoresView, type Store } from './items'
import { RatesView, VendorsView } from './vendors'

// Stores and purchase: items, vendors, rate contracts and the stores themselves.

type Tab = 'items' | 'vendors' | 'rates' | 'stores'

export class InventoryWorkspace extends Workspace<Tab> {
  protected views: Record<Tab, View>
  private storeList: Store[] | null = null

  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Stores & purchase', onClose)
    this.views = { items: new ItemsView(this), vendors: new VendorsView(this), rates: new RatesView(this), stores: new StoresView(this) }
    this.tab = 'items'
  }

  static allowed(me: Me) {
    const p = me.permissions
    return ['*', 'stores.view', 'stores.manage', 'vendors.manage'].some((x) => p.includes(x))
  }

  tabs(): [Tab, string][] { return [['items', 'Items'], ['vendors', 'Vendors'], ['rates', 'Rates'], ['stores', 'Stores']] }

  async stores(fresh = false) { if (fresh || !this.storeList) this.storeList = await this.cached<Store[]>('/api/stores'); return this.storeList }
}
