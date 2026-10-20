import type { HmsAdapter } from './HmsAdapter'
import type { DateRange, DomainEvent, EventBooking, HkStatus, Order, Reservation, ResStatus, Space, SpaceType } from '../types'
import type { Api } from '../../live/api'
import { todayKey } from '../dates'

// The live HMS behind the same interface as the sample data. Rooms are matched to the 3D model
// through their twin id; rooms not drawn yet still appear in lists and on the front desk.

interface ServerSpace {
  id: string; twin_id: string | null; kind: string; name: string; room_no: string | null; room_type_id: string | null
  room_type: string | null; base_rate_paise: number | null; max_occupancy: number | null; floor: number | null; capacity: number | null
  hk_status: string | null; dnd: boolean | null
}
interface ServerReservation {
  id: string; status: string; guest: string; mobile: string | null; nationality: string; vip: boolean; pax: number
  arrival: string; departure: string; eta: string | null; checked_in_at: string | null; checked_out_at: string | null; source: string
  requests: string | null; room_type_id: string; space_id: string | null; twin_id: string | null; room_no: string | null
  bill_to_company: string | null; rate_paise: number; balance_paise: number; folio_id: string
}
interface ServerBooking { name: string; venueId: string; date: string; from: string; to: string; startsAt: string; endsAt: string; pax: number; number: string; title: string; status: string; kind: string; firm: boolean
  client: string; turnaroundMinutes: number; valuePaise: number; paidPaise: number }
const addDaysIso = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
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

  // Banquet functions on their venues (Phase 7): pencilled ones are left off the map. Roles without the
  // banquets screens see none.
  async getEvents(range: DateRange): Promise<EventBooking[]> {
    const to = range.to < addDaysIso(range.from, 92) ? range.to : addDaysIso(range.from, 92)
    let r: { bookings: ServerBooking[] }
    try { r = await this.api.get(`/api/banquets/calendar?from=${range.from}&to=${to}`) } catch { return [] }
    const now = Date.now()
    return r.bookings.filter((b) => b.firm).map((b) => {
      const start = Date.parse(b.startsAt), end = Date.parse(b.endsAt), setupFrom = start - b.turnaroundMinutes * 60_000
      const setup: EventBooking['setup'] = now >= end ? 'done' : now >= start ? 'live' : now >= setupFrom ? 'in-progress' : b.status === 'hold' ? 'pending' : 'ready'
      return { id: `${b.number} · ${b.name}`, spaceId: this.appIdOf.get(b.venueId) ?? b.venueId, date: b.date, title: `${b.title}: ${b.name}`, client: b.client, kind: b.kind,
        pax: b.pax, slot: `${b.from}–${b.to}`, setup, value: b.valuePaise / 100, advance: b.paidPaise / 100 }
    })
  }
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
  /** Housekeeping status for the 3D colours, plus the detail (occupied, do-not-disturb) for the room panel. */
  readonly hkDetail = new Map<string, { status: string; dnd: boolean }>()
  async getHousekeeping(): Promise<Record<string, HkStatus>> {
    const snap = await this.snapshot(todayKey(), todayKey())
    const MAP: Record<string, HkStatus> = {
      vacant_clean: 'clean', occupied_clean: 'clean', inspected: 'inspected', vacant_dirty: 'dirty', occupied_dirty: 'dirty', out_of_order: 'out-of-order', out_of_service: 'out-of-order',
    }
    const out: Record<string, HkStatus> = {}
    this.hkDetail.clear()
    for (const s of snap.spaces) {
      if (!s.hk_status) continue
      const id = s.twin_id ?? s.id
      out[id] = MAP[s.hk_status] ?? 'clean'
      this.hkDetail.set(id, { status: s.hk_status, dnd: !!s.dnd })
    }
    return out
  }

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
