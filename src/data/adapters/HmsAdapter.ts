import type {
  DateRange, DomainEvent, EventBooking, HkStatus, Order, Reservation, Space,
} from '../types'

// The only contract the app depends on. Phase 1 ships the mock adapter;
// Phase 2 plugs the Resort Gateway (HttpAdapter) in behind the same interface.
export interface HmsAdapter {
  readonly name: string
  getSpaces(): Promise<Space[]>
  getReservations(range: DateRange): Promise<Reservation[]>
  getEvents(range: DateRange): Promise<EventBooking[]>
  getOrders(date: string): Promise<Order[]>
  getHousekeeping(): Promise<Record<string, HkStatus>>
  subscribe(onEvent: (e: DomainEvent) => void): () => void

  // God Mode write actions
  checkIn(reservationId: string): Promise<void>
  checkOut(reservationId: string): Promise<void>
  setHousekeeping(spaceId: string, status: HkStatus): Promise<void>
  advanceOrder(orderId: string): Promise<void>
}
