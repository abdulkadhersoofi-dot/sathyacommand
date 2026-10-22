import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Check-out leaves nothing behind: a guest with a room-service order not yet on the bill, or laundry not yet
// delivered, cannot be checked out; the desk puts it all on the room bill in one go, then checks out with
// one invoice that carries everything.

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', CAP = '', HK = ''
let res = { id: '', folio: '' }

beforeAll(async () => {
  R = await testResort('2026-11-01', { taxDetails: true })
  FD = await R.staff('Priya', '9840009201', ['reception'])
  CAP = await R.staff('Ravi', '9840009202', ['captain'])
  HK = await R.staff('Mala', '9840009203', ['room_attendant'])
  const r = (await R.post('/api/reservations', FD, { guest: { name: 'Sundar', mobile: '9840011111' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-02' })).json()
  res.id = r.id
  await R.post(`/api/reservations/${r.id}/check-in`, FD, { spaceId: 'RM-106', idType: 'aadhaar', idNumber: '1234 5678 9012' })
  res.folio = (await R.get(`/api/reservations/${r.id}`, FD)).json().folios[0].id
}, 60_000)
afterAll(() => R.close())

describe('check-out waits for every bill', () => {
  it('lists the room-service order and the laundry the guest still has open', async () => {
    const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'IRD', reservationId: res.id })).json()
    await R.post(`/api/fnb/orders/${o.id}/items`, CAP, { items: [{ itemId: 'IRD-SI01', qty: 2 }] })
    await R.post(`/api/fnb/orders/${o.id}/send`, CAP)
    const empty = (await R.post('/api/fnb/orders', CAP, { outletId: 'IRD', reservationId: res.id })).json()   // opened, nothing sent
    const items = (await R.get('/api/laundry/items', HK)).json()
    await R.post('/api/laundry/orders', HK, { spaceId: 'RM-106', items: [{ itemId: items[0].id, qty: 2 }] })
    const d = (await R.get(`/api/reservations/${res.id}`, FD)).json()
    expect(d.openItems.orders.map((x: { id: string; sent_items: number }) => [x.id, x.sent_items])).toEqual([[o.id, 1], [empty.id, 0]])
    expect(d.openItems.laundry).toHaveLength(1)
  })

  it('refuses check-out and says why', async () => {
    const r = await R.post(`/api/reservations/${res.id}/check-out`, FD)
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/Room Service order 1 .* is not on the room bill; Room Service order 2 .* is not on the room bill; laundry \(2 items\) is not delivered/)
    expect(r.json().openItems.orders).toHaveLength(2)
  })

  it('puts everything on the room bill in one go: the order is charged, the empty one cancelled, the laundry delivered', async () => {
    const s = (await R.post(`/api/reservations/${res.id}/settle-items`, FD)).json()
    expect(s.done).toEqual([
      'Room Service order 1: charged to the room',
      'Room Service order 2: cancelled (nothing was sent to the kitchen)',
      expect.stringMatching(/^Laundry: delivered and ₹\d+ charged$/),
    ])
    expect(s.openItems).toEqual({ orders: [], laundry: [] })
    const d = (await R.get(`/api/reservations/${res.id}`, FD)).json()
    expect(d.lines.map((l: { kind: string }) => l.kind)).toEqual(expect.arrayContaining(['fnb', 'laundry']))
    expect((await R.get('/api/fnb/orders?status=open,billed', CAP)).json().filter((x: { reservation_id: string }) => x.reservation_id === res.id)).toHaveLength(0)
  })

  it('then checks out with one invoice carrying the room, the food and the laundry', async () => {
    // Day use: tonight's room is charged at check-out, so the first attempt says exactly what is due.
    const d = (await R.get(`/api/reservations/${res.id}`, FD)).json()
    await R.post(`/api/folios/${res.folio}/payments`, FD, { method: 'card', amount: d.balance / 100, reference: 'SLIP 1' })
    const first = await R.post(`/api/reservations/${res.id}/check-out`, FD)
    expect(first.statusCode).toBe(409)
    expect(first.json().balance).toBeGreaterThan(0)
    await R.post(`/api/folios/${res.folio}/payments`, FD, { method: 'card', amount: first.json().balance / 100, reference: 'SLIP 2' })
    const out = (await R.post(`/api/reservations/${res.id}/check-out`, FD)).json()
    expect(out.invoice).toBeTruthy()
    const inv = (await R.get(`/api/tax-documents/${out.invoice.id}`, R.md)).json()
    expect(inv.lines.length).toBeGreaterThanOrEqual(3)   // room, food, laundry
  })

  it('the front desk can charge an order to a room', async () => {
    const r2 = (await R.post('/api/reservations', FD, { guest: { name: 'Meena' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-02' })).json()
    await R.post(`/api/reservations/${r2.id}/check-in`, FD, { spaceId: 'RM-107', idType: 'aadhaar', idNumber: '1234 5678 9013' })
    const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'IRD', reservationId: r2.id })).json()
    await R.post(`/api/fnb/orders/${o.id}/items`, CAP, { items: [{ itemId: 'IRD-SI01' }] })
    await R.post(`/api/fnb/orders/${o.id}/send`, CAP)
    const [b] = (await R.post(`/api/fnb/orders/${o.id}/bill`, FD, {})).json().bills
    expect((await R.post(`/api/fnb/bills/${b.id}/settle`, FD, { payments: [{ method: 'room', amount: 1 }], reservationId: r2.id })).json().ok).toBe(true)
  })
})
