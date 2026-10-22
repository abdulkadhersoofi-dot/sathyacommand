import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View } from '../ui/workspace'
import { CaptainView } from './captain'
import type { Outlet, Station, Ws } from './common'
import { KitchenView } from './kitchen'
import { MenuView } from './menu'
import { foodPlaceForm } from './places'

// The restaurant workspace: Orders (captain tablet), Kitchen & bar screens and Menu. Each tab shows only to
// roles that use it. Bar stock and kitchen stock live under Stores; licences & tax under Settings.

type Tab = 'orders' | 'kitchen' | 'menu'

export class FnbWorkspace extends Workspace<Tab> implements Ws {
  outlets: Outlet[] = []
  stations: Station[] = []
  protected views: Record<Tab, View>
  private captain: CaptainView

  constructor(api: Api, me: Me, outbox: Outbox, public inHouse: Ws['inHouse'], onClose: () => void) {
    super(api, me, outbox, 'Restaurant', onClose)
    this.captain = new CaptainView(this)
    this.views = { orders: this.captain, kitchen: new KitchenView(this), menu: new MenuView(this) }
    this.tab = this.tabs()[0]?.[0] ?? 'orders'
  }

  tabs(): [Tab, string][] {
    const t: [Tab, string][] = []
    if (this.can('fnb.order')) t.push(['orders', 'Orders'])
    if (this.can('kitchen', 'fnb.order')) t.push(['kitchen', 'Kitchen & bar'])
    if (this.can('menu.edit', 'menu.price')) t.push(['menu', 'Menu'])
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

  /** A room-service order for a checked-in guest, from the map. */
  async roomOrder(reservationId: string) { await this.show('orders'); await this.captain.startRoomOrder(reservationId); this.render() }

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
