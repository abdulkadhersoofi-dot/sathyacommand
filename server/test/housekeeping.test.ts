import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// The housekeeping cycle: check-out makes a room dirty, an attendant cleans it with a checklist and
// photo, the supervisor inspects it and reception sees it ready. Plus stay-overs from the night audit,
// fair assignment, out-of-order rooms leaving inventory, sleeper / skipper checks, minibar, lost & found.

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', NA = '', EH = '', SUP = '', A1 = '', A2 = '', A1id = '', A2id = ''
const ids: Record<string, string> = {}
const room = async (no: string) => (await R.get('/api/hk/rooms', EH)).json().rooms.find((r: { room_no: string }) => r.room_no === no)
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function stay(name: string, spaceId: string, nights = 2) {
  R.advance(1)
  const r = (await R.post('/api/reservations', FD, { roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: `2026-11-0${1 + nights}`, guest: { name } })).json()
  const ci = await R.post(`/api/reservations/${r.id}/check-in`, FD, { spaceId, idType: 'aadhaar', idNumber: '1234 5678 9012' })
  return { id: r.id as string, checkIn: ci.json() }
}

beforeAll(async () => {
  R = await testResort('2026-11-01')
  FD = await R.staff('Priya', '9840000071', ['reception'])
  NA = await R.staff('Senthil', '9840000072', ['night_auditor'])
  EH = await R.staff('Kavitha', '9840000073', ['executive_housekeeper'])
  SUP = await R.staff('Revathi', '9840000074', ['hk_supervisor'])
  A1 = await R.staff('Selvi', '9840000075', ['room_attendant'])
  A2 = await R.staff('Muthu', '9840000076', ['room_attendant'])
  const users = (await R.get('/api/users', R.md)).json()
  A1id = users.find((u: { name: string }) => u.name === 'Selvi').id
  A2id = users.find((u: { name: string }) => u.name === 'Muthu').id
}, 40_000)
afterAll(() => R.close())
// The MD's God Mode session lapses after 15 idle minutes of test clock; keep it in use.
beforeEach(async () => { await R.get('/api/business-date', R.md) })

describe('room status follows the front office', () => {
  it('starts every room inspected, in sections by building and floor', async () => {
    const r = (await R.get('/api/hk/rooms', FD)).json()
    expect(r.rooms).toHaveLength(47)
    expect(await room('101')).toMatchObject({ status: 'inspected', dnd: false, section: expect.stringContaining('floor 1') })
  })

  it('marks a room occupied at check-in and dirty with a check-out task at check-out', async () => {
    ids.A = (await stay('Arun', 'RM-101', 1)).id
    expect((await room('101')).status).toBe('occupied_clean')
    const bal = (await R.get(`/api/reservations/${ids.A}`, FD)).json()
    expect(bal.balance).toBe(0)
    await R.post(`/api/reservations/${ids.A}/check-out`, FD)
    const r = await room('101')
    expect(r).toMatchObject({ status: 'vacant_dirty', task: { kind: 'checkout', status: 'pending' } })
  })

  it('warns at check-in into a room not yet cleaned', async () => {
    const s = await stay('Bala', 'RM-101', 2)
    ids.B = s.id
    expect(s.checkIn.housekeeping).toMatch(/not been cleaned/)
    expect((await room('101')).task).toBeNull()
  })
})

describe('the day\'s work', () => {
  it('turns occupied rooms into stay-overs at the night audit', async () => {
    ids.C = (await stay('Chitra', 'RM-102', 2)).id
    ids.D = (await stay('Dinesh', 'RM-201', 2)).id
    await R.post('/api/hk/rooms/RM-102/dnd', FD, { on: true })
    await R.post('/api/night-audit', NA)
    const r = await room('102')
    expect(r).toMatchObject({ status: 'occupied_dirty', dnd: false, task: { kind: 'stayover', status: 'pending' } })
  })

  it('shares tasks between attendants by section and workload', async () => {
    await R.post(`/api/reservations/${ids.B}/check-out`, FD).then(async (x) => {
      if (x.statusCode !== 200) { const b = (await R.get(`/api/reservations/${ids.B}`, FD)).json(); await R.post('/api/cashier/open', FD, { openingFloat: 0 }); await R.post(`/api/folios/${b.folios[0].id}/payments`, FD, { method: 'cash', amount: b.balance / 100 }); await R.post(`/api/reservations/${ids.B}/check-out`, FD) }
    })
    expect((await R.post('/api/hk/assign', A1, { attendants: [A1id] })).statusCode).toBe(403)
    const r = (await R.post('/api/hk/assign', EH, { attendants: [A1id, A2id] })).json()
    expect(r.assigned).toBe(3)       // 101 check-out (Bala left), 102 and 201 stay-overs
    const credits = r.workload.map((w: { credits: number }) => w.credits).sort()
    expect(credits[1] - credits[0]).toBeLessThanOrEqual(2)
    const mine = (await R.get('/api/hk/tasks', A1)).json()
    expect(mine.every((t: { attendant: string }) => t.attendant === 'Selvi')).toBe(true)
  })
})

describe('cleaning and inspection', () => {
  it('respects do-not-disturb, needs the checklist or a note, and takes photos', async () => {
    const tasks = (await R.get('/api/hk/tasks', EH)).json()
    const t102 = tasks.find((t: { room_no: string }) => t.room_no === '102')
    const who102 = t102.assigned_to === A1id ? A1 : A2
    await R.post('/api/hk/rooms/RM-102/dnd', FD, { on: true })
    expect((await R.post(`/api/hk/tasks/${t102.id}/start`, who102)).json().error).toMatch(/Do Not Disturb/)
    await R.post('/api/hk/rooms/RM-102/dnd', FD, { on: false })

    const t101 = tasks.find((t: { room_no: string; kind: string }) => t.room_no === '101' && t.kind === 'checkout')
    const who = t101.assigned_to === A1id ? A1 : A2
    const other = who === A1 ? A2 : A1
    ids.T101 = t101.id; ids.W101 = who
    expect((await R.post(`/api/hk/tasks/${t101.id}/start`, other)).statusCode).toBe(403)
    expect((await R.post(`/api/hk/tasks/${t101.id}/finish`, who, {})).json().error).toMatch(/Start the room first/)
    await R.post(`/api/hk/tasks/${t101.id}/start`, who)
    R.advance(12)
    expect((await R.post(`/api/hk/tasks/${t101.id}/finish`, who, {})).json().error).toMatch(/Not ticked/)
    const photo = (await R.post('/api/uploads', who, { kind: 'hk', dataUrl: PNG })).json()
    expect((await R.app.inject({ url: photo.url, headers: { authorization: `Bearer ${who}` } })).headers['content-type']).toBe('image/png')
    const checklist = t101.checklist.map((c: { item: string }) => ({ item: c.item, done: true }))
    const f = (await R.post(`/api/hk/tasks/${t101.id}/finish`, who, { checklist, photos: [photo.id] })).json()
    expect(f).toEqual({ ok: true, minutes: 12 })
    expect((await room('101')).status).toBe('vacant_clean')
  })

  it('sends a failed inspection back for re-cleaning; a pass makes the room ready for reception', async () => {
    expect((await R.post(`/api/hk/tasks/${ids.T101}/inspect`, ids.W101, { score: 95 })).statusCode).toBe(403)
    expect((await R.post(`/api/hk/tasks/${ids.T101}/inspect`, SUP, { score: 60 })).json().error).toMatch(/what needs re-cleaning/)
    expect((await R.post(`/api/hk/tasks/${ids.T101}/inspect`, SUP, { score: 60, notes: 'Hair in the shower' })).json()).toEqual({ ok: true, pass: false })
    expect(await room('101')).toMatchObject({ status: 'vacant_dirty', task: { status: 'reclean' } })
    await R.post(`/api/hk/tasks/${ids.T101}/start`, ids.W101)
    const t = (await R.get('/api/hk/tasks', EH)).json().find((x: { id: string }) => x.id === ids.T101)
    await R.post(`/api/hk/tasks/${ids.T101}/finish`, ids.W101, { checklist: t.checklist.map((c: { item: string }) => ({ item: c.item, done: true })) })
    expect((await R.post(`/api/hk/tasks/${ids.T101}/inspect`, SUP, { score: 92 })).json().pass).toBe(true)
    expect((await room('101')).status).toBe('inspected')
    const audit = (await R.get('/api/audit?limit=6', R.md)).json()
    expect(audit.find((a: { action: string }) => a.action === 'hk.room_ready')).toBeTruthy()
  })
})

describe('out of order', () => {
  it('refuses while the room is booked, then takes it out of inventory', async () => {
    const before = (await R.post('/api/availability', FD, { from: '2026-11-02', to: '2026-11-04' })).json().find((t: { roomTypeId: string }) => t.roomTypeId === 'deluxe').nights
    const busy = await R.post('/api/hk/rooms/RM-102/out-of-order', EH, { reason: 'AC compressor' })
    expect(busy.json().error).toMatch(/A guest is in room 102/)
    expect((await R.post('/api/hk/rooms/RM-103/out-of-order', EH, {})).statusCode).toBe(400)
    expect((await R.post('/api/hk/rooms/RM-103/out-of-order', EH, { reason: 'Bathroom leak', to: '2026-11-03' })).json()).toEqual({ ok: true })
    const after = (await R.post('/api/availability', FD, { from: '2026-11-02', to: '2026-11-04' })).json().find((t: { roomTypeId: string }) => t.roomTypeId === 'deluxe').nights
    expect(after[0].free).toBe(before[0].free - 1)
    expect(after[1].free).toBe(before[1].free - 1)
    const r = (await R.post('/api/reservations', FD, { roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-02', departure: '2026-11-03', guest: { name: 'Eswar' } })).json()
    expect((await R.post(`/api/reservations/${r.id}/assign-room`, FD, { spaceId: 'RM-103' })).json().error).toMatch(/out of order/)
    expect((await R.post('/api/hk/rooms/RM-103/return-to-service', EH)).json()).toEqual({ ok: true })
    expect(await room('103')).toMatchObject({ status: 'vacant_dirty', task: { kind: 'checkout' } })
  })
})

describe('sleeper / skipper, minibar, lost & found', () => {
  it('flags a skipper when housekeeping finds a checked-in room empty', async () => {
    const r = (await R.post('/api/hk/rooms/RM-201/observed', A2, { occupancy: 'vacant' })).json()
    expect(r.discrepancy).toBe('skipper')
    expect((await room('201')).discrepancy).toBe('skipper')
    expect((await R.post('/api/hk/rooms/RM-104/observed', A2, { occupancy: 'occupied' })).json().discrepancy).toBe('sleeper')
    const audit = (await R.get('/api/audit?limit=3', R.md)).json()
    expect(audit.filter((a: { action: string }) => a.action === 'hk.discrepancy')).toHaveLength(2)
  })

  it('posts minibar use to the guest\'s bill with GST', async () => {
    const item = (await R.post('/api/hk/minibar-items', EH, { name: 'Mineral water 1 L', price: 50, gstRate: 18 })).json()
    expect((await R.post('/api/hk/rooms/RM-103/minibar', A1, { items: [{ itemId: item.id, qty: 1 }] })).json().error).toMatch(/No guest/)
    const r = (await R.post('/api/hk/rooms/RM-102/minibar', A1, { items: [{ itemId: item.id, qty: 2 }] })).json()
    expect(r.total).toBe(11800)
    const line = (await R.get(`/api/reservations/${ids.C}`, FD)).json().lines.find((l: { ref: string }) => l.ref === 'minibar')
    expect(line).toMatchObject({ description: 'Minibar · 2 × Mineral water 1 L', taxable_paise: 10000, cgst_paise: 900 })
  })

  it('logs found items against the last guest and records who collected them', async () => {
    const f = (await R.post('/api/hk/lost-found', A1, { description: 'Black phone charger', spaceId: 'RM-101' })).json()
    expect(f.reservationId).toBe(ids.B)
    const list = (await R.get('/api/hk/lost-found', FD)).json()
    expect(list[0]).toMatchObject({ description: 'Black phone charger', room_no: '101', guest: 'Bala', status: 'held' })
    expect((await R.post(`/api/hk/lost-found/${f.id}/close`, FD, { outcome: 'returned' })).statusCode).toBe(400)
    expect((await R.post(`/api/hk/lost-found/${f.id}/close`, FD, { outcome: 'disposed' })).statusCode).toBe(403)
    expect((await R.post(`/api/hk/lost-found/${f.id}/close`, FD, { outcome: 'returned', handedTo: 'Bala (Aadhaar seen)' })).json()).toEqual({ ok: true })
  })
})
