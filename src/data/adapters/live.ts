import type { HmsAdapter } from './HmsAdapter'
import type { DateRange, DomainEvent, EventBooking, HkStatus, Order, Reservation, ResStatus, Space, SpaceType } from '../types'
import type { Api } from '../../live/api'
import { todayKey } from '../dates'

// The live HMS behind the same interface as the sample data. Rooms are matched to the 3D model
// through their twin id; rooms not drawn yet still appear in lists and on the front desk.

interface ServerSpace {
  id: string; twin_id: string | null; kind: string; name: string; room_no: string | null; room_type_id: string | null
  room_type: string | null; base_rate_paise: number | null; max_occupancy: number | null; floor: number | null; capacity: number | null
}
interface ServerReservation {
  id: string; status: string; guest: string; mobile: string | null; nationality: string; vip: boolean; pax: number
  arrival: string; departure: string; eta: string | null; checked_in_at: string | null; checked_out_at: string | null; source: string
  requests: string | null; room_type_id: string; space_id: string | null; twin_id: string | null; room_no: string | null
  bill_to_company: string | null; rate_paise: number; balance_paise: number; folio_id: string
}
interface ServerOrder {
  id: string; number: number; outlet_id: string; outlet: string; outlet_twin_id: string | null; kind: string; table_label: string | null
  room_no: string | null; twin_id: string | null; guest: string | null; status: string; opened_at: string; kitchen: 'new' | 'cooking' | 'ready' | null
  last_kot_at: string | null; items: { name: string; qty: number; price: number; status: string }[]
}
interface Snapshot { businessDate: string; lodgingKinds: string[]; spaces: ServerSpace[]; reservations: ServerReservation[] }

const KIND_TO_TYPE: Record<string, SpaceType> = {
  room: 'room', villa: 'villa', suite: 'villa', cottage: 'villa', tent: 'villa', dormitory: 'villa',
  hall: 'hall', lawn: 'lawn', pavilion: 'pavilion', ground: 'ground', restaurant: 'restaurant', bar: 'restaurant',
  kitchen: 'kitchen', reception: 'reception', pool: 'pool', store: 'service', service: 'service', office: 'office',
}
const STATUS: Record<string, ResStatus> = { confirmed: 'confirmed', in_house: 'in-house', checked_out: 'checked-out', cancelled: 'cancelled', no_show: 'cancelled' }

export class LiveAdapter implements HmsAdapter {
  readonly name = 'Live HMS'
  /** App space id (3D twin id where drawn) → server space id. */
  readonly serverIdOf = new Map<string, string>()
  readonly appIdOf = new Map<string, string>()
  businessDate = todayKey()

  constructor(public api: Api) {}

  private snapshot(from: string, to: string) {
    return this.api.get<Snapshot>(`/api/dashboard?from=${from}&to=${to}`)
  }

  async getSpaces(): Promise<Space[]> {
    const snap = await this.snapshot(todayKey(), todayKey())
    this.businessDate = snap.businessDate
    return snap.spaces.map((s) => {
      const id = s.twin_id ?? s.id
      this.serverIdOf.set(id, s.id)
      this.appIdOf.set(s.id, id)
      const lodging = snap.lodgingKinds.includes(s.kind)
      return {
        id, type: KIND_TO_TYPE[s.kind] ?? 'service',
        name: lodging && s.kind === 'room' ? `Room ${s.room_no}` : s.name,
        hmsRoomNo: s.room_no ?? undefined, category: s.room_type ?? undefined, floor: s.floor ?? undefined,
        baseRate: s.base_rate_paise != null ? s.base_rate_paise / 100 : undefined, capacity: s.capacity ?? s.max_occupancy ?? undefined,
      }
    })
  }

  async getReservations(range: DateRange): Promise<Reservation[]> {
    const snap = await this.snapshot(range.from, range.to)
    this.businessDate = snap.businessDate
    return snap.reservations.map((r) => ({
      id: r.id, spaceId: r.space_id ? this.appIdOf.get(r.space_id) ?? r.space_id : '',
      guest: r.guest, phone: r.mobile ?? '', pax: r.pax, arrival: r.arrival, departure: r.departure, eta: r.eta ?? undefined,
      checkInAt: r.checked_in_at ?? undefined, checkOutAt: r.checked_out_at ?? undefined, status: STATUS[r.status] ?? 'confirmed',
      source: r.source, rate: r.rate_paise / 100, balance: r.balance_paise / 100, vip: r.vip, notes: r.requests ?? undefined,
      folioId: r.folio_id, roomNo: r.room_no, roomTypeId: r.room_type_id, serverSpaceId: r.space_id, company: r.bill_to_company,
    }))
  }

  // Phases 3, 4 and 7 bring the restaurant, housekeeping and events into the live HMS.
  async getEvents(): Promise<EventBooking[]> { return [] }
  // Restaurant, bar and room-service orders that reached the kitchen, for the 3D map and the kitchen panel.
  async getOrders(date: string): Promise<Order[]> {
    const rows = await this.api.get<ServerOrder[]>(`/api/fnb/orders?date=${date}&status=open,billed,closed`)
    return rows.filter((o) => o.last_kot_at).map((o) => ({
      id: `Order ${o.number}`, serverId: o.id, outletId: o.outlet_id,
      origin: o.kind === 'room_service' ? (o.twin_id ?? 'KITCHEN') : (o.outlet_twin_id ?? 'RESTAURANT'),
      originLabel: o.kind === 'room_service' ? `Room ${o.room_no ?? '?'}` : `${o.outlet}${o.table_label ? ` · ${o.table_label}` : ''}`,
      kind: o.kind === 'room_service' ? 'room' : 'table',
      items: o.items.map((i) => ({ name: i.name, qty: i.qty, price: Number(i.price) / 100 })),
      status: o.kitchen === 'new' ? 'placed' : o.kitchen ?? 'served',
      placedAt: o.opened_at, updatedAt: o.last_kot_at!,
    }))
  }
  async getHousekeeping(): Promise<Record<string, HkStatus>> { return {} }

  subscribe(onEvent: (e: DomainEvent) => void) {
    let timer = 0
    let last: DomainEvent | null = null
    return this.api.stream((e) => {
      last = { type: 'snapshot.changed', action: e.action, entityId: e.entity.id, actor: e.actor, amount: e.amount }
      clearTimeout(timer)
      timer = window.setTimeout(() => last && onEvent(last), 400)   // a burst of entries from one action becomes one refresh
    })
  }

  private notHere(): never { throw new Error('Use the front desk screens for this in live mode.') }
  async checkIn() { this.notHere() }
  async checkOut() { this.notHere() }
  async setHousekeeping() { this.notHere() }
  async advanceOrder() { this.notHere() }
}
