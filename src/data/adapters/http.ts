import type { HmsAdapter } from './HmsAdapter'
import type { DateRange, DomainEvent, HkStatus } from '../types'

// Talks to the Resort Gateway (Phase 2). The gateway owns the vendor
// credentials and translates eZee / IDS Next / OPERA / Petpooja etc. into the
// normalised model, so this adapter is plain REST + Server-Sent Events.
export class HttpAdapter implements HmsAdapter {
  readonly name = 'Resort Gateway'
  constructor(private base: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.base + path, { credentials: 'include' })
    if (!res.ok) throw new Error(`${path}: ${res.status}`)
    return res.json() as Promise<T>
  }

  private async post(path: string, body?: unknown): Promise<void> {
    const res = await fetch(this.base + path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`${path}: ${res.status}`)
  }

  getSpaces() { return this.get<any>('/spaces') }
  getReservations(r: DateRange) { return this.get<any>(`/reservations?from=${r.from}&to=${r.to}`) }
  getEvents(r: DateRange) { return this.get<any>(`/events?from=${r.from}&to=${r.to}`) }
  getOrders(date: string) { return this.get<any>(`/orders?date=${date}`) }
  getHousekeeping() { return this.get<Record<string, HkStatus>>('/housekeeping') }

  subscribe(onEvent: (e: DomainEvent) => void) {
    const es = new EventSource(this.base + '/stream', { withCredentials: true })
    es.onmessage = (m) => onEvent(JSON.parse(m.data))
    return () => es.close()
  }

  checkIn(id: string) { return this.post(`/reservations/${id}/check-in`) }
  checkOut(id: string) { return this.post(`/reservations/${id}/check-out`) }
  setHousekeeping(spaceId: string, status: HkStatus) { return this.post(`/housekeeping/${spaceId}`, { status }) }
  advanceOrder(id: string) { return this.post(`/orders/${id}/advance`) }
}
