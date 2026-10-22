// Normalised domain model. Every adapter (mock, HTTP gateway, future vendor
// adapters) produces these shapes, so the UI never knows which HMS is behind it.

export type SpaceType =
  | 'room' | 'villa' | 'hall' | 'lawn' | 'pavilion' | 'restaurant'
  | 'kitchen' | 'reception' | 'pool' | 'service' | 'ground' | 'office'

export interface Space {
  id: string            // stable twin id, e.g. "MAIN-2-204"
  name: string
  type: SpaceType
  hmsRoomNo?: string    // what the HMS calls it
  category?: string
  capacity?: number
  baseRate?: number     // INR per night / per event
  floor?: number
  verify?: boolean      // use guessed from satellite image, confirm on site
}

export type ResStatus = 'confirmed' | 'in-house' | 'checked-out' | 'cancelled'

export interface Reservation {
  id: string
  spaceId: string
  guest: string
  phone: string
  pax: number
  arrival: string       // YYYY-MM-DD
  departure: string     // YYYY-MM-DD (checkout day)
  eta?: string          // HH:MM expected arrival on arrival day
  checkInAt?: string    // ISO, set when checked in
  checkOutAt?: string
  status: ResStatus
  source: string
  rate: number          // per night
  balance: number
  vip?: boolean
  notes?: string
  // Live HMS only
  folioId?: string
  roomNo?: string | null
  roomTypeId?: string
  serverSpaceId?: string | null
  company?: string | null
  /** Filled in by the guest before arrival (Phase 7). */
  onlineCheckin?: boolean
  /** A website booking waiting for its deposit until then. */
  payBy?: string | null
  otaRef?: string | null
  /** Earlier stays of the same guest. */
  pastStays?: number
}

export type OrderStatus = 'placed' | 'cooking' | 'ready' | 'served'

export interface OrderItem { name: string; qty: number; price: number }

export interface Order {
  id: string            // KOT number
  origin: string        // spaceId or table id ("T4")
  originLabel: string
  kind: 'room' | 'table' | 'event'
  items: OrderItem[]
  status: OrderStatus
  placedAt: string      // ISO
  updatedAt: string
  // Live HMS only
  serverId?: string
  outletId?: string
  outletName?: string
}

export interface EventBooking {
  id: string
  spaceId: string
  date: string
  title: string
  client: string
  kind: string
  pax: number
  slot: string          // "18:00–23:00"
  setup: 'pending' | 'in-progress' | 'ready' | 'live' | 'done'
  value: number
  advance: number
}

export type HkStatus = 'clean' | 'dirty' | 'inspected' | 'out-of-order'

export type DomainEvent =
  | { type: 'order.created'; order: Order }
  | { type: 'order.updated'; order: Order }
  | { type: 'reservation.updated'; reservation: Reservation; change: 'check-in' | 'check-out' }
  | { type: 'housekeeping.updated'; spaceId: string; status: HkStatus }
  | { type: 'snapshot.changed'; action: string; entityId: string; actor: string; amount?: number }

export interface DateRange { from: string; to: string }
