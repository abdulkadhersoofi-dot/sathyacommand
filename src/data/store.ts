import type { HmsAdapter } from './adapters/HmsAdapter'
import type { DomainEvent, EventBooking, HkStatus, Order, Reservation, Space } from './types'
import { addDays, todayKey } from './dates'

export type RoomStatus = 'vacant' | 'dirty' | 'arriving' | 'occupied' | 'departing' | 'ooo'

export interface SpaceState {
  space: Space
  status: RoomStatus
  stay?: Reservation        // guest occupying tonight (or arriving)
  departing?: Reservation   // guest leaving on the viewed date
  hk?: HkStatus
  events: EventBooking[]
  revenue: number
}

export type Layer = 'rooms' | 'fnb' | 'events' | 'housekeeping' | 'revenue'

export interface FeedItem { id: string; at: Date; kind: 'kot' | 'checkin' | 'checkout' | 'hk' | 'alert'; text: string; spaceId?: string }

type Listener = (why: string, payload?: unknown) => void

export const RANGE_BACK = 30
export const RANGE_FWD = 60

// Plain observable store: adapters push in, the scene and panels read derived state.
export class Store {
  spaces: Space[] = []
  spaceById = new Map<string, Space>()
  reservations: Reservation[] = []
  events: EventBooking[] = []
  orders: Order[] = []
  hk: Record<string, HkStatus> = {}
  feed: FeedItem[] = []

  date = todayKey()
  layers = new Set<Layer>(['rooms', 'fnb', 'events'])
  godMode = false
  live = false
  selectedId: string | null = null

  private listeners = new Set<Listener>()
  private stateCache = new Map<string, SpaceState>()

  constructor(public adapter: HmsAdapter) {}

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  emit(why: string, payload?: unknown) { this.listeners.forEach((l) => l(why, payload)) }

  get isToday() { return this.date === todayKey() }
  get rangeFrom() { return addDays(todayKey(), -RANGE_BACK) }
  get rangeTo() { return addDays(todayKey(), RANGE_FWD) }

  async load() {
    const range = { from: this.rangeFrom, to: this.rangeTo }
    const [spaces, res, ev, hk] = await Promise.all([
      this.adapter.getSpaces(), this.adapter.getReservations(range),
      this.adapter.getEvents(range), this.adapter.getHousekeeping(),
    ])
    this.spaces = spaces
    this.spaceById = new Map(spaces.map((s) => [s.id, s]))
    this.reservations = res
    this.events = ev
    this.hk = hk
    this.orders = await this.adapter.getOrders(this.date)
    this.seedFeed()
    this.adapter.subscribe((e) => this.onDomainEvent(e))
    this.invalidate('load')
  }

  async setDate(d: string) {
    if (d === this.date) return
    this.date = d
    this.orders = await this.adapter.getOrders(d)
    this.invalidate('date')
  }

  toggleLayer(l: Layer) {
    if (this.layers.has(l)) this.layers.delete(l)
    else {
      // housekeeping and revenue recolour the same meshes as rooms, so they are exclusive
      if (l === 'housekeeping' || l === 'revenue' || l === 'rooms') {
        this.layers.delete('rooms'); this.layers.delete('housekeeping'); this.layers.delete('revenue')
      }
      this.layers.add(l)
    }
    this.emit('layers')
  }

  setGodMode(on: boolean) {
    this.godMode = on
    if (!on && this.layers.has('revenue')) { this.layers.delete('revenue'); this.layers.add('rooms') }
    this.emit('god')
  }

  select(id: string | null) { this.selectedId = id; this.emit('select', id) }

  invalidate(why: string) { this.stateCache.clear(); this.emit(why) }

  // Owner actions are recorded here; Phase 4 persists this server-side.
  audit: { at: Date; text: string }[] = []
  logAudit(text: string) { this.audit.unshift({ at: new Date(), text }) }

  /** Fetch bookings again (live mode, after the server announces a change). */
  async reload() {
    this.reservations = await this.adapter.getReservations({ from: this.rangeFrom, to: this.rangeTo })
    this.invalidate('reload')
  }

  /** Fetch rooms and bookings again (a new layout was published, or rooms were relinked). */
  async reloadSpaces() {
    this.spaces = await this.adapter.getSpaces()
    this.spaceById = new Map(this.spaces.map((s) => [s.id, s]))
    await this.reload()
  }

  private async onSnapshotChanged(e: Extract<DomainEvent, { type: 'snapshot.changed' }>) {
    if (e.action === 'site.published' || e.action === 'site.restored' || e.action.startsWith('room.')) {
      await this.reloadSpaces()
      if (e.action.startsWith('site.')) {
        this.pushFeed({ id: `${e.action}-${e.entityId}`, at: new Date(), kind: 'alert', text: `Resort layout version ${e.entityId} published by ${e.actor}` })
        this.emit('site', e)
      }
      return
    }
    await this.reload()
    const r = this.reservations.find((x) => x.id === e.entityId)
    const room = r ? (r.roomNo ? `room ${r.roomNo}` : 'unassigned room') : ''
    const text: Record<string, string> = {
      'reservation.create': `New booking${r ? ` for ${r.guest}` : ''} (${e.actor})`,
      'reservation.check_in': `${r?.guest ?? 'Guest'} checked in to ${room}`,
      'reservation.check_out': `${r?.guest ?? 'Guest'} checked out of ${room}`,
      'reservation.cancel': `Booking cancelled${r ? ` for ${r.guest}` : ''}`,
      'reservation.assign_room': `${r?.guest ?? 'Guest'} assigned to ${room}`,
      'reservation.room_move': `${r?.guest ?? 'Guest'} moved to ${room}`,
      'payment.receive': `Payment received (${e.actor})`,
      'payment.cash_blocked': `Cash payment of ₹2 lakh or more blocked (${e.actor})`,
      'invoice.issue': 'Tax invoice issued',
      'night_audit.run': `Day closed by ${e.actor}`,
    }
    const msg = text[e.action]
    if (msg) {
      this.pushFeed({ id: `${e.action}-${e.entityId}-${Date.now()}`, at: new Date(), kind: e.action.includes('check_out') ? 'checkout' : e.action.startsWith('reservation') ? 'checkin' : 'alert', text: msg, spaceId: r?.spaceId || undefined })
    }
    this.emit('live', e)
  }

  private onDomainEvent(e: DomainEvent) {
    if (e.type === 'snapshot.changed') { void this.onSnapshotChanged(e); return }
    const now = new Date()
    if (e.type === 'order.created') {
      if (this.isToday && !this.orders.includes(e.order)) this.orders.push(e.order)
      this.pushFeed({ id: e.order.id + 'c', at: now, kind: 'kot', spaceId: e.order.origin, text: `New ${e.order.id} from ${e.order.originLabel}: ${e.order.items.map((i) => i.name).join(', ')}` })
    } else if (e.type === 'order.updated') {
      const verb = { placed: 'placed', cooking: 'is cooking', ready: 'is ready for pickup', served: 'served' }[e.order.status]
      this.pushFeed({ id: e.order.id + e.order.status, at: now, kind: 'kot', spaceId: e.order.origin, text: `${e.order.id} ${verb} (${e.order.originLabel})` })
    } else if (e.type === 'reservation.updated') {
      const sp = this.spaceById.get(e.reservation.spaceId)
      this.pushFeed({
        id: e.reservation.id + e.change, at: now, kind: e.change === 'check-in' ? 'checkin' : 'checkout', spaceId: sp?.id,
        text: e.change === 'check-in' ? `${e.reservation.guest} checked in to ${sp?.name}` : `${e.reservation.guest} checked out of ${sp?.name}`,
      })
    } else if (e.type === 'housekeeping.updated') {
      this.hk[e.spaceId] = e.status
      const sp = this.spaceById.get(e.spaceId)
      this.pushFeed({ id: e.spaceId + e.status + now.getTime(), at: now, kind: 'hk', spaceId: e.spaceId, text: `${sp?.name} marked ${e.status}` })
    }
    this.stateCache.clear()
    this.emit('live', e)
  }

  private pushFeed(f: FeedItem) {
    this.feed.unshift(f)
    if (this.feed.length > 60) this.feed.length = 60
  }

  private seedFeed() {
    const today = todayKey()
    for (const r of this.reservations.filter((x) => x.arrival === today && x.status === 'in-house')) {
      this.pushFeed({ id: r.id + 'ci', at: new Date(r.checkInAt!), kind: 'checkin', spaceId: r.spaceId, text: `${r.guest} checked in to ${this.spaceById.get(r.spaceId)?.name}` })
    }
    for (const o of this.orders.slice(-6)) {
      this.pushFeed({ id: o.id, at: new Date(o.placedAt), kind: 'kot', spaceId: o.origin, text: `${o.id} from ${o.originLabel}: ${o.items.map((i) => i.name).join(', ')}` })
    }
    this.feed.sort((a, b) => b.at.getTime() - a.at.getTime())
  }

  // ---- derived state ----

  state(id: string): SpaceState {
    const cached = this.stateCache.get(id)
    if (cached) return cached
    const space = this.spaceById.get(id)!
    const d = this.date
    const st: SpaceState = { space, status: 'vacant', events: [], revenue: 0, hk: this.hk[id] }
    if (space.type === 'room' || space.type === 'villa') {
      const live = this.reservations.filter((r) => r.spaceId === id && r.status !== 'cancelled')
      const stay = live.find((r) => r.arrival <= d && r.departure > d)
      const departing = live.find((r) => r.departure === d)
      st.stay = stay
      st.departing = departing
      if (stay) st.revenue = stay.rate
      if (this.hk[id] === 'out-of-order' && d >= todayKey()) st.status = 'ooo'
      else if (departing && (this.isToday ? departing.status === 'in-house' : true)) st.status = 'departing'
      else if (stay && stay.arrival === d && (this.isToday ? stay.status === 'confirmed' : true)) st.status = 'arriving'
      else if (stay) st.status = 'occupied'
      else st.status = this.isToday && this.hk[id] === 'dirty' ? 'dirty' : 'vacant'
    } else {
      st.events = this.events.filter((e) => e.spaceId === id && e.date === d)
      st.revenue = st.events.reduce((a, e) => a + e.value, 0)
      if (space.type === 'restaurant' || space.type === 'kitchen') {
        st.revenue = this.orders.filter((o) => o.kind === 'table').reduce((a, o) => a + orderTotal(o), 0)
      }
    }
    this.stateCache.set(id, st)
    return st
  }

  get lodging() { return this.spaces.filter((s) => s.type === 'room' || s.type === 'villa') }

  kpis() {
    const lodging = this.lodging
    const states = lodging.map((s) => this.state(s.id))
    const sellable = states.filter((s) => s.status !== 'ooo').length
    const occupied = states.filter((s) => s.stay).length
    const roomRev = states.reduce((a, s) => a + (s.stay?.rate ?? 0), 0)
    const fnb = this.orders.reduce((a, o) => a + orderTotal(o), 0)
    const events = this.events.filter((e) => e.date === this.date)
    return {
      occupancy: sellable ? occupied / sellable : 0,
      occupied, sellable,
      arrivals: this.reservations.filter((r) => r.arrival === this.date && r.status !== 'cancelled').length,
      departures: this.reservations.filter((r) => r.departure === this.date && r.status !== 'cancelled').length,
      guests: states.reduce((a, s) => a + (s.stay?.pax ?? 0), 0),
      adr: occupied ? roomRev / occupied : 0,
      roomRev, fnb,
      events: events.length,
      eventRev: events.reduce((a, e) => a + e.value, 0),
      openKots: this.orders.filter((o) => o.status !== 'served').length,
      lateKots: this.isToday ? this.orders.filter((o) => o.status !== 'served' && minutesOpen(o) > 20).length : 0,
      dirty: this.isToday ? lodging.filter((s) => this.hk[s.id] === 'dirty').length : 0,
    }
  }

  occupancySeries() {
    const out: { date: string; occ: number; events: number }[] = []
    const lodging = this.lodging.length
    for (let d = this.rangeFrom; d <= this.rangeTo; d = addDays(d, 1)) {
      const occ = this.reservations.filter((r) => r.arrival <= d && r.departure > d && r.status !== 'cancelled').length
      out.push({ date: d, occ: occ / lodging, events: this.events.filter((e) => e.date === d).length })
    }
    return out
  }

  ordersFor(spaceId: string) {
    return this.orders.filter((o) => o.origin === spaceId)
  }
}

export const orderTotal = (o: Order) => o.items.reduce((a, i) => a + i.qty * i.price, 0)
export const minutesOpen = (o: Order) => (Date.now() - new Date(o.placedAt).getTime()) / 60000
