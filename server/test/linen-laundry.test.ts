import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Linen stock against par, guest laundry charged to the room, public-area rounds proved by QR scans.

let R: Awaited<ReturnType<typeof testResort>>
let EH = '', A1 = '', FD = ''
const linen = async (name: string) => (await R.get('/api/linen', EH)).json().find((l: { name: string }) => l.name === name)

beforeAll(async () => {
  R = await testResort('2026-11-01')
  EH = await R.staff('Kavitha', '9840000081', ['executive_housekeeper'])
  A1 = await R.staff('Selvi', '9840000082', ['room_attendant'])
  FD = await R.staff('Priya', '9840000083', ['reception'])
}, 40_000)
afterAll(() => R.close())
beforeEach(async () => { await R.get('/api/business-date', R.md) })

describe('linen', () => {
  it('works out the par for every sellable room and what is short', async () => {
    const towel = await linen('Bath towel')
    // 47 rooms × 2 towels × 3 sets
    expect(towel).toMatchObject({ parPerRoom: 2, parSets: 3, inRooms: 94, needed: 282, owned: 94, short: 188 })
  })

  it('tracks the shelf, the laundry and losses', async () => {
    const id = (await linen('Bath towel')).id
    await R.post('/api/linen/moves', EH, { itemId: id, kind: 'purchase', qty: 200, vendor: 'Kovai Textiles' })
    await R.post('/api/linen/moves', EH, { itemId: id, kind: 'send_laundry', qty: 60, vendor: 'Sri Laundry' })
    expect((await R.post('/api/linen/moves', EH, { itemId: id, kind: 'laundry_loss', qty: 2 })).json().error).toMatch(/reason/)
    await R.post('/api/linen/moves', EH, { itemId: id, kind: 'receive_laundry', qty: 57 })
    await R.post('/api/linen/moves', EH, { itemId: id, kind: 'laundry_loss', qty: 2, note: 'Not returned by Sri Laundry' })
    await R.post('/api/linen/moves', EH, { itemId: id, kind: 'discard', qty: 3, note: 'Stained' })
    expect(await linen('Bath towel')).toMatchObject({ shelf: 200 - 60 + 57 - 3, laundry: 1, lost: 5, owned: 194 + 1 + 94, short: 0 })
    expect((await R.post('/api/linen/moves', A1, { itemId: id, kind: 'purchase', qty: 1 })).statusCode).toBe(403)
  })
})

describe('guest laundry', () => {
  it('collects from the room and charges the guest with GST on delivery', async () => {
    const res = (await R.post('/api/reservations', FD, { roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-03', guest: { name: 'Arun' } })).json()
    await R.post(`/api/reservations/${res.id}/check-in`, FD, { spaceId: 'RM-101', idType: 'aadhaar', idNumber: '1234 5678 9012' })
    const items = (await R.get('/api/laundry/items', A1)).json()
    const shirt = items.find((i: { name: string; service: string }) => i.name === 'Shirt' && i.service === 'wash_iron')
    const suit = items.find((i: { name: string }) => i.name === 'Suit (2 piece)')
    const o = (await R.post('/api/laundry/orders', A1, { spaceId: 'RM-101', express: true, items: [{ itemId: shirt.id, qty: 3 }, { itemId: suit.id, qty: 1 }] })).json()
    expect(o.totalPaise).toBe(Math.round((3 * 6000 + 45000) * 1.5))
    expect((await R.get('/api/laundry/orders', FD)).json()[0]).toMatchObject({ room_no: '101', guest: 'Arun', status: 'picked_up' })
    const d = (await R.post(`/api/laundry/orders/${o.id}/deliver`, A1)).json()
    expect(d.chargedPaise).toBe(94500 + 17010)
    const line = (await R.get(`/api/reservations/${res.id}`, FD)).json().lines.find((l: { kind: string }) => l.kind === 'laundry')
    expect(line).toMatchObject({ description: 'Laundry (express) · 3 × Shirt, 1 × Suit (2 piece)', gst_rate: '18.00', taxable_paise: 94500 })
    expect((await R.post(`/api/laundry/orders/${o.id}/deliver`, A1)).statusCode).toBe(409)
    expect((await R.post('/api/laundry/orders', A1, { spaceId: 'RM-102', items: [{ itemId: shirt.id, qty: 1 }] })).json().error).toMatch(/No guest/)
  })
})

describe('public areas', () => {
  it('records a round only from the QR code in the area, and shows what is overdue', async () => {
    const areas = (await R.get('/api/hk/areas', A1)).json()
    const lobby = areas.find((a: { name: string }) => a.name === 'Lobby washrooms')
    expect(lobby).toMatchObject({ rounds_per_day: 6, done: 0, overdue: true, space_id: 'RECEPTION' })
    expect((await R.post('/api/hk/rounds', A1, { code: 'SPR-NOT-A-CODE' })).statusCode).toBe(404)
    expect((await R.post('/api/hk/rounds', A1, { code: lobby.code })).json()).toMatchObject({ area: 'Lobby washrooms' })
    const after = (await R.get('/api/hk/areas', A1)).json().find((a: { name: string }) => a.name === 'Lobby washrooms')
    expect(after).toMatchObject({ done: 1, overdue: false, last_by: 'Selvi' })
    R.advance(200)
    await R.get('/api/business-date', R.md)
    expect((await R.get('/api/hk/areas', A1)).json().find((a: { name: string }) => a.name === 'Lobby washrooms').overdue).toBe(true)
    const labels = await R.app.inject({ url: '/api/hk/areas/labels', headers: { authorization: `Bearer ${EH}` } })
    expect(labels.body).toContain(lobby.code)
    expect(labels.body).toContain('<svg')
  })

  it('shows housekeeping status in the 3D dashboard feed', async () => {
    const d = (await R.get('/api/dashboard?from=2026-11-01&to=2026-11-01', FD)).json()
    expect(d.spaces.find((s: { room_no: string }) => s.room_no === '101')).toMatchObject({ hk_status: 'occupied_clean', dnd: false })
  })
})
