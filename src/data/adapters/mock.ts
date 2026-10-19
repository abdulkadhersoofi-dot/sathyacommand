import type { HmsAdapter } from './HmsAdapter'
import type {
  DateRange, DomainEvent, EventBooking, HkStatus, Order, OrderItem, Reservation, Space,
} from '../types'
import { buildSpaces, VENUE_IDS } from '../registry'
import { addDays, todayKey } from '../dates'

// Deterministic sample data so every device shows the same "resort", plus a
// live simulator that emits the same events a real HMS webhook would.

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7)
const pick = <T,>(r: () => number, a: T[]) => a[Math.floor(r() * a.length)]

const FIRST = ['Arjun', 'Priya', 'Karthik', 'Divya', 'Rahul', 'Meera', 'Vikram', 'Ananya', 'Suresh', 'Lakshmi', 'Naveen', 'Kavya', 'Rohan', 'Deepa', 'Aditya', 'Sneha', 'Ganesh', 'Revathi', 'Imran', 'Fathima', 'Joseph', 'Mary', 'Harish', 'Nithya', 'Sanjay', 'Pooja', 'Prakash', 'Keerthana', 'Ravi', 'Swathi']
const LAST = ['Kumar', 'Iyer', 'Raman', 'Nair', 'Reddy', 'Menon', 'Krishnan', 'Subramanian', 'Pillai', 'Sharma', 'Rao', 'Venkatesh', 'Thomas', 'Khan', 'Mehta', 'Balaji', 'Natarajan', 'Joseph', 'Chandran', 'Varghese']
const SOURCES = ['Direct', 'Direct', 'MakeMyTrip', 'Booking.com', 'Goibibo', 'Agoda', 'Corporate', 'Walk-in']
const NOTES = ['Late check-in, keep room ready', 'Anniversary, cake at 9 pm', 'Extra bed requested', 'Vegetarian (Jain) meals', 'Ground floor preferred', 'Early check-in requested', 'Airport drop at 6 am', '', '', '', '']
const MENU: OrderItem[] = [
  { name: 'Masala Dosa', qty: 1, price: 140 }, { name: 'Idli Vada', qty: 1, price: 110 },
  { name: 'Chettinad Chicken', qty: 1, price: 380 }, { name: 'Paneer Butter Masala', qty: 1, price: 310 },
  { name: 'Veg Biryani', qty: 1, price: 260 }, { name: 'Mutton Biryani', qty: 1, price: 420 },
  { name: 'Parotta (2)', qty: 1, price: 90 }, { name: 'Fish Fry', qty: 1, price: 360 },
  { name: 'Filter Coffee', qty: 1, price: 60 }, { name: 'Fresh Lime Soda', qty: 1, price: 80 },
  { name: 'Curd Rice', qty: 1, price: 150 }, { name: 'Gobi 65', qty: 1, price: 220 },
]
const EVENT_KINDS = [
  { kind: 'Wedding', titles: ['Wedding: {a} weds {b}'], pax: [300, 900], slot: '07:00–13:00' },
  { kind: 'Reception', titles: ['Reception: {a} & {b}'], pax: [250, 800], slot: '18:30–23:00' },
  { kind: 'Corporate', titles: ['Offsite: Zoho Corp', 'Townhall: TVS Motors', 'Dealer meet: Sakthi Agencies', 'Training: Cognizant'], pax: [60, 300], slot: '09:00–18:00' },
  { kind: 'Birthday', titles: ["{a}'s 1st birthday", "{a}'s 60th (Shashtiabdapoorthi)"], pax: [80, 250], slot: '18:00–22:30' },
  { kind: 'Sports', titles: ['Corporate cricket league', 'School sports day'], pax: [100, 400], slot: '07:00–17:00' },
]

const iso = (d: Date) => d.toISOString()

export class MockAdapter implements HmsAdapter {
  readonly name = 'Sample data (mock HMS)'
  private spaces = buildSpaces()
  private reservations: Reservation[] = []
  private events: EventBooking[] = []
  private ordersByDay = new Map<string, Order[]>()
  private hk: Record<string, HkStatus> = {}
  private listeners = new Set<(e: DomainEvent) => void>()
  private kotSeq = 1240
  private timer?: number

  constructor() {
    this.generate()
  }

  private generate() {
    const today = todayKey()
    const start = addDays(today, -45)
    const end = addDays(today, 75)
    const r = rng(20261019)
    let seq = 52000

    for (const s of this.spaces.filter((s) => s.type === 'room' || s.type === 'villa')) {
      let cursor = addDays(start, Math.floor(r() * 3))
      const weekendBias = s.type === 'villa' ? 0.62 : 0.74
      while (cursor < end) {
        if (r() > weekendBias) { cursor = addDays(cursor, 1 + Math.floor(r() * 2)); continue }
        const nights = 1 + Math.floor(r() * r() * 5)
        const arrival = cursor
        const departure = addDays(arrival, nights)
        const rate = Math.round((s.baseRate! * (0.85 + r() * 0.35)) / 50) * 50
        const total = rate * nights
        const past = departure < today
        const inHouse = arrival < today && departure >= today
        const arrivingToday = arrival === today
        const res: Reservation = {
          id: `R${seq++}`, spaceId: s.id,
          guest: `${pick(r, FIRST)} ${pick(r, LAST)}`,
          phone: `+91 9${Math.floor(r() * 1e9).toString().padStart(9, '0')}`,
          pax: 1 + Math.floor(r() * (s.capacity ?? 2)),
          arrival, departure,
          eta: `${String(11 + Math.floor(r() * 10)).padStart(2, '0')}:${pick(r, ['00', '15', '30', '45'])}`,
          status: past ? 'checked-out' : inHouse ? 'in-house' : 'confirmed',
          source: pick(r, SOURCES), rate,
          balance: past ? 0 : Math.round(total * (r() < 0.4 ? 1 : r() < 0.6 ? 0.5 : 0)),
          vip: r() < 0.08, notes: pick(r, NOTES),
        }
        if (res.status !== 'confirmed') res.checkInAt = `${arrival}T${res.eta}:00`
        if (past) res.checkOutAt = `${departure}T${pick(r, ['09:40', '10:55', '11:20', '11:50'])}:00`
        // A couple of today's arrivals have already checked in
        const nowH = new Date().getHours()
        if (arrivingToday && nowH >= 10 && r() < 0.35) {
          res.status = 'in-house'
          res.checkInAt = new Date(Date.now() - (5 + r() * (nowH - 9.5) * 60) * 60000).toISOString()
        }
        this.reservations.push(res)
        cursor = addDays(departure, r() < 0.55 ? 0 : 1 + Math.floor(r() * 2))
      }
      this.hk[s.id] = r() < 0.18 ? 'dirty' : r() < 0.5 ? 'inspected' : 'clean'
    }
    this.hk['MAIN-2-206'] = 'out-of-order'
    this.reservations = this.reservations.filter((x) => !(x.spaceId === 'MAIN-2-206' && x.arrival <= addDays(today, 3) && x.departure >= today))

    let ev = 900
    for (let d = start; d < end; d = addDays(d, 1)) {
      const dow = new Date(d + 'T00:00:00').getDay()
      const busy = dow === 0 || dow === 5 || dow === 6 ? 0.45 : 0.18
      for (const venue of VENUE_IDS) {
        const vr = rng(hash(d + venue))
        if (vr() > busy) continue
        let k = pick(vr, EVENT_KINDS)
        if (venue === 'GROUND-CRICKET') k = EVENT_KINDS[4]
        else if (k.kind === 'Sports') k = EVENT_KINDS[1]
        const sp = this.spaces.find((s) => s.id === venue)!
        const a = pick(vr, FIRST), b = pick(vr, FIRST)
        const pax = Math.min(sp.capacity ?? 200, Math.round(k.pax[0] + vr() * (k.pax[1] - k.pax[0])))
        const value = Math.round((sp.baseRate! * (0.8 + vr() * 0.6)) / 1000) * 1000
        this.events.push({
          id: `E${ev++}`, spaceId: venue, date: d,
          title: pick(vr, k.titles).replace('{a}', a).replace('{b}', b),
          client: `${a} ${pick(vr, LAST)}`, kind: k.kind, pax, slot: k.slot,
          setup: d < today ? 'done' : d === today ? 'in-progress' : 'pending',
          value, advance: d < today ? value : Math.round(value * (vr() < 0.5 ? 0.5 : 0.25)),
        })
      }
    }
    this.refreshEventSetup()
  }

  private refreshEventSetup() {
    const now = new Date()
    const today = todayKey()
    for (const e of this.events.filter((x) => x.date === today)) {
      const [s, en] = e.slot.split('–').map((t) => +t.slice(0, 2) + +t.slice(3) / 60)
      const h = now.getHours() + now.getMinutes() / 60
      e.setup = h >= en ? 'done' : h >= s ? 'live' : h >= s - 3 ? 'ready' : 'in-progress'
    }
  }

  private makeOrders(day: string): Order[] {
    if (this.ordersByDay.has(day)) return this.ordersByDay.get(day)!
    const today = todayKey()
    if (day > today) return []
    const r = rng(hash('kot' + day))
    const orders: Order[] = []
    const inHouse = this.reservations.filter((x) => x.arrival <= day && x.departure > day && x.status !== 'cancelled')
    const nowH = day === today ? new Date().getHours() + new Date().getMinutes() / 60 : 23
    const count = Math.round((30 + r() * 25) * Math.min(1, Math.max(0.1, (nowH - 6) / 16)))
    for (let i = 0; i < count; i++) {
      const roomOrder = r() < 0.4 && inHouse.length
      const h = 7 + r() * Math.max(0.5, Math.min(nowH, 23) - 7)
      const placed = new Date(`${day}T00:00:00`)
      placed.setMinutes(Math.floor(h * 60))
      const res = roomOrder ? pick(r, inHouse) : null
      const sp = res ? this.spaces.find((s) => s.id === res.spaceId)! : null
      const table = `T${1 + Math.floor(r() * 14)}`
      const items = Array.from({ length: 1 + Math.floor(r() * 4) }, () => ({ ...pick(r, MENU), qty: 1 + Math.floor(r() * r() * 3) }))
      const ageMin = day === today ? (Date.now() - placed.getTime()) / 60000 : 999
      const status: Order['status'] = ageMin > 45 ? 'served' : ageMin > 25 ? 'ready' : ageMin > 6 ? 'cooking' : 'placed'
      orders.push({
        id: `KOT-${day.slice(5).replace('-', '')}-${100 + i}`,
        origin: sp ? sp.id : table, originLabel: sp ? sp.name : `Sathya Dine · ${table}`,
        kind: sp ? 'room' : 'table', items, status,
        placedAt: iso(placed), updatedAt: iso(placed),
      })
    }
    // Two orders running late today so the delay alert has something to show.
    if (day === today) {
      orders.filter((o) => o.status === 'served').slice(-2).forEach((o, i) => {
        o.status = 'cooking'
        o.placedAt = iso(new Date(Date.now() - (24 + i * 9) * 60000))
      })
    }
    orders.sort((a, b) => a.placedAt.localeCompare(b.placedAt))
    this.ordersByDay.set(day, orders)
    return orders
  }

  // ---- HmsAdapter ----
  async getSpaces(): Promise<Space[]> { return this.spaces }
  async getReservations(range: DateRange) {
    return this.reservations.filter((x) => x.departure >= range.from && x.arrival <= range.to)
  }
  async getEvents(range: DateRange) {
    this.refreshEventSetup()
    return this.events.filter((e) => e.date >= range.from && e.date <= range.to)
  }
  async getOrders(day: string) { return this.makeOrders(day) }
  async getHousekeeping() { return { ...this.hk } }

  subscribe(fn: (e: DomainEvent) => void) {
    this.listeners.add(fn)
    if (!this.timer) this.timer = window.setInterval(() => this.tick(), 7000)
    return () => { this.listeners.delete(fn) }
  }

  private emit(e: DomainEvent) { this.listeners.forEach((l) => l(e)) }

  async checkIn(id: string) {
    const res = this.reservations.find((x) => x.id === id)
    if (!res || res.status !== 'confirmed') return
    res.status = 'in-house'; res.checkInAt = iso(new Date())
    this.emit({ type: 'reservation.updated', reservation: res, change: 'check-in' })
  }
  async checkOut(id: string) {
    const res = this.reservations.find((x) => x.id === id)
    if (!res || res.status !== 'in-house') return
    res.status = 'checked-out'; res.checkOutAt = iso(new Date()); res.balance = 0
    this.emit({ type: 'reservation.updated', reservation: res, change: 'check-out' })
    await this.setHousekeeping(res.spaceId, 'dirty')
  }
  async setHousekeeping(spaceId: string, status: HkStatus) {
    this.hk[spaceId] = status
    this.emit({ type: 'housekeeping.updated', spaceId, status })
  }
  async advanceOrder(id: string) {
    const o = this.makeOrders(todayKey()).find((x) => x.id === id)
    if (!o || o.status === 'served') return
    o.status = o.status === 'placed' ? 'cooking' : o.status === 'cooking' ? 'ready' : 'served'
    o.updatedAt = iso(new Date())
    this.emit({ type: 'order.updated', order: o })
  }

  // ---- live simulator ----
  private tick() {
    const today = todayKey()
    const r = Math.random
    const orders = this.makeOrders(today)
    const roll = r()
    if (roll < 0.42) {
      const inHouse = this.reservations.filter((x) => x.status === 'in-house')
      const toRoom = r() < 0.5 && inHouse.length
      const res = toRoom ? inHouse[Math.floor(r() * inHouse.length)] : null
      const sp = res ? this.spaces.find((s) => s.id === res.spaceId)! : null
      const table = `T${1 + Math.floor(r() * 14)}`
      const o: Order = {
        id: `KOT-${today.slice(5).replace('-', '')}-${this.kotSeq++}`,
        origin: sp ? sp.id : table, originLabel: sp ? sp.name : `Sathya Dine · ${table}`,
        kind: sp ? 'room' : 'table',
        items: Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ ...MENU[Math.floor(r() * MENU.length)] })),
        status: 'placed', placedAt: iso(new Date()), updatedAt: iso(new Date()),
      }
      orders.push(o)
      this.emit({ type: 'order.created', order: o })
    } else if (roll < 0.8) {
      const open = orders.filter((o) => o.status !== 'served')
      if (open.length) this.advanceOrder(open[Math.floor(r() * open.length)].id)
    } else if (roll < 0.92) {
      const arriving = this.reservations.filter((x) => x.arrival === today && x.status === 'confirmed')
      if (arriving.length) this.checkIn(arriving[0].id)
    } else {
      const leaving = this.reservations.filter((x) => x.departure === today && x.status === 'in-house')
      if (leaving.length) this.checkOut(leaving[0].id)
    }
  }
}

