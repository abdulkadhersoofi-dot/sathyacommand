import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View } from '../ui/workspace'
import { CaptainView } from './captain'
import type { Outlet, Station, Ws } from './common'
import { KitchenView } from './kitchen'
import { MenuView } from './menu'
import { SettingsView } from './settings'
import { BarView } from './bar'
import { KitchenStockView } from './kitchen-stock'
import { foodPlaceForm } from './places'

// The restaurant workspace: Orders (captain tablet), Kitchen & bar screens, Menu, Bar stock, Kitchen
// stock and Licences & tax. Each tab shows only to roles that use it.

type Tab = 'orders' | 'kitchen' | 'menu' | 'bar' | 'kstock' | 'settings'

export class FnbWorkspace extends Workspace<Tab> implements Ws {
  outlets: Outlet[] = []
  stations: Station[] = []
  protected views: Record<Tab, View>
  private captain: CaptainView

  constructor(api: Api, me: Me, outbox: Outbox, public inHouse: Ws['inHouse'], onClose: () => void) {
    super(api, me, outbox, 'Restaurant', onClose)
    this.captain = new CaptainView(this)
    this.views = { orders: this.captain, kitchen: new KitchenView(this), menu: new MenuView(this), bar: new BarView(this), kstock: new KitchenStockView(this), settings: new SettingsView(this) }
    this.tab = this.tabs()[0]?.[0] ?? 'settings'
  }

  tabs(): [Tab, string][] {
    const t: [Tab, string][] = []
    if (this.can('fnb.order')) t.push(['orders', 'Orders'])
    if (this.can('kitchen', 'fnb.order')) t.push(['kitchen', 'Kitchen & bar'])
    if (this.can('menu.edit', 'menu.price')) t.push(['menu', 'Menu'])
    if (this.can('bar.stock', 'bar.approve') || this.me.roles.includes('bartender')) t.push(['bar', 'Bar stock'])
    if (this.can('kitchen.stock', 'kitchen', 'food_cost.view')) t.push(['kstock', 'Kitchen stock'])
    t.push(['settings', 'Licences & tax'])
    return t
  }

  protected async beforeLoad() { await this.refreshOutlets() }
  async refreshOutlets() {
    const r = await this.cached<{ outlets: Outlet[]; stations: Station[] }>('/api/fnb/outlets')
    this.outlets = r.outlets; this.stations = r.stations
    window.dispatchEvent(new CustomEvent('sathya:outlets-changed', { detail: r.outlets }))
  }

  /** The captain screen on one place's tables (from the map). */
  openPlace(id: string) { this.captain.showPlace(id); void this.show('orders') }

  /** From the map: a lawn, hall or the pool becomes a food place, then the captain screen opens on it. */
  newPlace(spaceId: string, name: string, kind: string) {
    void this.show('orders').then(() => foodPlaceForm(this, async (id) => { await this.refreshOutlets(); this.captain.showPlace(id); await this.show('orders') }, undefined, { spaceId, name, kind }))
  }

  protected canLeave() { return !this.captain.dirty || confirm('Leave without sending the new items?') }

  /** Opens a particular order on the captain screen (from the kitchen panel or the 3D map). */
  async openOrder(id: string) {
    await this.captain.openOrder(id)
    await this.show('orders')
  }
}
