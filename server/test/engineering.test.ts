import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Engineering: assets on the map, fault tickets from anyone with response timers and escalation,
// planned maintenance, spares with an approval limit, meter readings and cost per occupied room,
// pool / STP / fire checks that raise faults, and the compliance calendar.

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', CE = '', ENG = '', ATT = '', FD = '', ENGid = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const audit = async (action: string) => (await R.get('/api/audit?limit=200', R.md)).json().filter((a: { action: string }) => a.action === action)
let AC = '', FIRE = ''
const everyone = () => [R.md, GM, CE, ENG, ATT, FD]
/** Moves the clock on in short steps so nobody's session times out. */
async function pass(minutes: number) {
  for (let left = minutes; left > 0; left -= 14) { R.advance(Math.min(14, left)); for (const t of everyone()) await R.get('/api/business-date', t) }
}

beforeAll(async () => {
  R = await testResort('2026-11-01')            // 09:00 IST
  GM = await R.staff('Karthik', '9840000201', ['general_manager'])
  CE = await R.staff('Ravi', '9840000202', ['chief_engineer'])
  ENG = await R.staff('Murugan', '9840000203', ['engineering'])
  ATT = await R.staff('Selvi', '9840000204', ['room_attendant'])
  FD = await R.staff('Priya', '9840000205', ['reception'])
  ENGid = (await R.get('/api/users', R.md)).json().find((u: { name: string }) => u.name === 'Murugan').id
}, 40_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of everyone()) await R.get('/api/business-date', t) })

describe('assets and planned maintenance', () => {
  it('keeps the asset register, pinned to rooms or to a spot on the map', async () => {
    expect((await R.post('/api/eng/assets', ENG, { name: 'x', category: 'ac' })).statusCode).toBe(403)
    expect((await R.post('/api/eng/assets', CE, { name: 'Boiler', category: 'steam' })).statusCode).toBe(400)
    AC = (await R.post('/api/eng/assets', CE, { name: 'Room 101 split AC', category: 'ac', spaceId: 'RM-101', make: 'Daikin', amcVendor: 'Cool Services', amcUntil: '2026-10-25', amcCost: 12000 })).json().id
    FIRE = (await R.post('/api/eng/assets', CE, { name: 'Extinguisher K-1 (kitchen)', category: 'fire', x: 12, z: -40 })).json().id
    const map = (await R.get('/api/eng/map', ENG)).json()
    expect(map.assets.find((a: { id: string }) => a.id === FIRE).pos).toEqual({ x: 12, z: -40 })
    expect((await R.get('/api/eng/map', ATT)).json().assets).toHaveLength(0)
    const meta = (await R.get('/api/eng/meta', ATT)).json()
    expect(meta.templates.ac.checklist.length).toBeGreaterThan(3)
  })

  it('raises a maintenance ticket when a plan falls due, and moves the plan on when done', async () => {
    const tpl = (await R.get('/api/eng/meta', CE)).json().templates.ac
    await R.post('/api/eng/plans', CE, { assetId: AC, title: tpl.title, everyDays: 90, checklist: tpl.checklist, nextDue: '2026-11-01' })
    const tickets = (await R.get('/api/eng/tickets', ENG)).json()
    const pm = tickets.filter((k: { kind: string }) => k.kind === 'pm')
    expect(pm).toHaveLength(1)
    expect(pm[0]).toMatchObject({ title: 'AC service: Room 101 split AC', asset: 'Room 101 split AC', space: expect.any(String) })
    expect((await R.get('/api/eng/tickets', ENG)).json().filter((k: { kind: string }) => k.kind === 'pm')).toHaveLength(1)   // not raised twice
    await R.post(`/api/eng/tickets/${pm[0].id}/start`, ENG)
    expect((await R.post(`/api/eng/tickets/${pm[0].id}/done`, ENG, { resolution: 'Serviced' })).json().error).toMatch(/Not ticked/)
    const list = pm[0].checklist.map((c: { item: string }) => ({ item: c.item, done: true }))
    expect((await R.post(`/api/eng/tickets/${pm[0].id}/done`, ENG, { resolution: 'Filters washed, gas topped up', checklist: list })).statusCode).toBe(200)
    const plan = (await R.get('/api/eng/plans', CE)).json()[0]
    expect(plan).toMatchObject({ last_done: '2026-11-01', next_due: '2027-01-30' })
  })
})

describe('fault tickets', () => {
  let T = ''
  it('lets anyone report a fault with a photo and a place', async () => {
    const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const photo = (await R.post('/api/uploads', ATT, { kind: 'fault', dataUrl: px })).json().id
    const r = (await R.post('/api/eng/tickets', ATT, { title: 'AC not cooling', detail: 'Guest complained', spaceId: 'RM-101', assetId: AC, priority: 'urgent', photoIds: [photo] })).json()
    expect(r.located).toBe(true)
    T = r.id
    expect((await R.get('/api/eng/tickets', ATT)).json()).toEqual([expect.objectContaining({ id: T, reported_by: 'Selvi', photos: [photo] })])
    expect((await R.get('/api/eng/tickets', FD)).json()).toHaveLength(0)
    const map = (await R.get('/api/eng/map', ENG)).json()
    expect(map.tickets.find((k: { id: string }) => k.id === T).pos).not.toBeNull()
    expect((await audit('eng.ticket'))[0]).toMatchObject({ entity: { id: T } })
  })

  it('escalates when nobody answers in time, and again when it is not fixed in time', async () => {
    await pass(14)
    await R.get('/api/eng/tickets', ENG)
    expect(await audit('eng.escalated')).toHaveLength(0)
    await pass(2)
    const k = (await R.get('/api/eng/tickets', ENG)).json().find((x: { id: string }) => x.id === T)
    expect(k).toMatchObject({ escalation: 1, responseLate: true })
    expect((await audit('eng.escalated'))[0].after).toMatchObject({ level: 1, reason: 'nobody has taken it' })
    await R.post(`/api/eng/tickets/${T}/take`, ENG)
    expect((await R.get('/api/eng/tickets', ENG)).json().find((x: { id: string }) => x.id === T)).toMatchObject({ assignee: 'Murugan', responseLate: false })
    await pass(17 * 14)
    await R.get('/api/eng/tickets', ENG)
    expect((await audit('eng.escalated'))[0].after).toMatchObject({ level: 2, reason: 'not fixed in time' })
  })

  it('goes on hold, gets fixed, and is closed by the person who reported it', async () => {
    expect((await R.post(`/api/eng/tickets/${T}/hold`, ENG, {})).statusCode).toBe(400)
    await R.post(`/api/eng/tickets/${T}/hold`, ENG, { reason: 'Waiting for compressor' })
    expect((await R.post(`/api/eng/tickets/${T}/done`, ENG, {})).json().error).toMatch(/what was done/)
    expect((await R.post(`/api/eng/tickets/${T}/done`, ATT, { resolution: 'x' })).statusCode).toBe(403)
    await R.post(`/api/eng/tickets/${T}/done`, ENG, { resolution: 'Compressor replaced' })
    expect((await R.post(`/api/eng/tickets/${T}/close`, FD)).statusCode).toBe(403)
    await R.post(`/api/eng/tickets/${T}/reopen`, ATT, { reason: 'Still warm at night' })
    expect((await R.get('/api/eng/tickets', ATT)).json()[0]).toMatchObject({ status: 'open', escalation: 0 })
    await R.post(`/api/eng/tickets/${T}/done`, ENG, { resolution: 'Gas recharged' })
    await R.post(`/api/eng/tickets/${T}/close`, ATT)
    expect((await R.get('/api/eng/tickets?status=closed', ATT)).json()[0]).toMatchObject({ status: 'closed', resolution: 'Gas recharged' })
  })

  it('lets the chief engineer assign work to someone on the team', async () => {
    const id = (await R.post('/api/eng/tickets', FD, { title: 'Lobby light flickering' })).json().id
    expect((await R.post(`/api/eng/tickets/${id}/assign`, ENG, { userId: ENGid })).statusCode).toBe(403)
    expect((await R.get('/api/eng/people', CE)).json().map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['Murugan', 'Ravi']))
    await R.post(`/api/eng/tickets/${id}/assign`, CE, { userId: ENGid })
    expect((await R.get('/api/staff/inbox', ENG)).json()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'engineering', title: 'Lobby light flickering' })]))
  })
})

describe('spares', () => {
  it('issues spares at average cost, with approval above the role limit', async () => {
    const fuse = (await R.post('/api/eng/spares', CE, { name: 'Fuse 32A', unit: 'nos', reorderLevel: 5 })).json().id
    await R.post(`/api/eng/spares/${fuse}/receive`, CE, { qty: 10, cost: 1000, vendor: 'Sri Electricals' })
    await R.post(`/api/eng/spares/${fuse}/receive`, CE, { qty: 10, cost: 2000 })
    expect((await R.post(`/api/eng/spares/${fuse}/issue`, ENG, { qty: 6 })).json()).toMatchObject({ ok: true, valuePaise: 90000 })   // ₹150 average
    expect((await R.post(`/api/eng/spares/${fuse}/issue`, ENG, { qty: 50 })).json().error).toMatch(/Only 14 nos/)
    const comp = (await R.post('/api/eng/spares', CE, { name: 'AC compressor 1.5 T' })).json().id
    await R.post(`/api/eng/spares/${comp}/receive`, CE, { qty: 1, cost: 18000 })
    const big = await R.post(`/api/eng/spares/${comp}/issue`, ENG, { qty: 1, note: 'Room 101' })
    expect(big.statusCode).toBe(202)
    expect((await R.get('/api/eng/spares', ENG)).json().find((s: { id: string }) => s.id === comp).stock).toBe(1)
    expect((await R.post(`/api/approvals/${big.json().approvalId}/decide`, CE, { decision: 'approve' })).statusCode).toBe(403)
    await R.post(`/api/approvals/${big.json().approvalId}/decide`, GM, { decision: 'approve' })
    const spares = (await R.get('/api/eng/spares', ENG)).json()
    expect(spares.find((s: { id: string }) => s.id === comp).stock).toBe(0)
    expect(spares.find((s: { id: string }) => s.id === fuse)).toMatchObject({ stock: 14, low: false })
  })
})

describe('utilities', () => {
  it('turns daily meter readings into use and cost per occupied room', async () => {
    expect((await R.post('/api/eng/readings', ATT, { readings: [] })).statusCode).toBe(403)
    await R.post('/api/eng/readings', ENG, { day: '2026-11-01', readings: [{ meterId: 'MT-EB', reading: 10000 }, { meterId: 'MT-DGH', reading: 500 }] })
    const r = (await R.post('/api/reservations', FD, { roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-03', guest: { name: 'Arun' } })).json()
    await R.post(`/api/reservations/${r.id}/check-in`, FD, { spaceId: 'RM-102', idType: 'aadhaar', idNumber: '1234 5678 9012' })
    const sheet = (await R.get('/api/eng/readings?day=2026-11-02', ENG)).json()
    expect((await R.post('/api/eng/readings', ENG, { day: '2026-11-03', readings: [{ meterId: 'MT-EB', reading: 1 }] })).statusCode).toBe(400)   // future
    expect(sheet.find((m: { id: string }) => m.id === 'MT-EB')).toMatchObject({ previous: '10000.00', previous_day: '2026-11-01' })
    // the business day has not been closed, so the clock decides "today": readings for the 2nd need tomorrow
  })

  it('refuses a reading below the last one unless the meter was reset, and corrects the next day', async () => {
    await pass(24 * 60)
    expect((await R.post('/api/eng/readings', ENG, { day: '2026-11-02', readings: [{ meterId: 'MT-EB', reading: 9000 }] })).json().error).toMatch(/below the 2026-11-01 reading/)
    await R.post('/api/eng/readings', ENG, { day: '2026-11-02', readings: [{ meterId: 'MT-EB', reading: 10450 }, { meterId: 'MT-DGH', reading: 504 }, { meterId: 'MT-DSL', reading: 60 }] })
    const u = (await R.get('/api/eng/utilities?from=2026-11-01&to=2026-11-02', CE)).json()
    expect(u.totals['MT-EB']).toEqual({ qty: 450, costPaise: 382500 })        // ₹8.50 a unit
    expect(u.dieselPerDgHour).toBe(15)
    expect(u.occupiedRoomNights).toBe(2)
    expect(u.costPerOccupiedRoomPaise).toBe(Math.round((382500 + 60 * 9200) / 2))
    await R.post('/api/eng/readings', ENG, { day: '2026-11-01', readings: [{ meterId: 'MT-EB', reading: 10050 }] })
    expect((await R.get('/api/eng/utilities?from=2026-11-01&to=2026-11-02', CE)).json().totals['MT-EB'].qty).toBe(400)
    expect(await audit('meter.correct')).toHaveLength(1)
    await R.post('/api/eng/readings', ENG, { day: '2026-11-02', readings: [{ meterId: 'MT-DGH', reading: 3, reset: true, note: 'Hour meter replaced' }] })
    expect((await R.get('/api/eng/utilities?from=2026-11-01&to=2026-11-02', CE)).json().totals['MT-DGH'].qty).toBe(3)
  }, 20_000)
})

describe('safety checks', () => {
  it('raises a fault when the pool water is out of range', async () => {
    const ok = (await R.post('/api/eng/logs', ENG, { kind: 'pool', data: { ph: 7.4, chlorine: 2 } })).json()
    expect(ok).toMatchObject({ ok: true, ticketId: null })
    const bad = (await R.post('/api/eng/logs', ENG, { kind: 'pool', data: { ph: 8.2, chlorine: 0.4 } })).json()
    expect(bad.ok).toBe(false)
    expect(bad.issues).toEqual(['pH 8.2 (keep 7.2–7.8)', 'chlorine 0.4 ppm (keep 1–3)'])
    const k = (await R.get('/api/eng/tickets', ENG)).json().find((x: { id: string }) => x.id === bad.ticketId)
    expect(k).toMatchObject({ priority: 'high', title: expect.stringMatching(/^Pool water check failed/) })
  })

  it('checks fire extinguishers one by one', async () => {
    expect((await R.post('/api/eng/logs', ENG, { kind: 'fire', assetId: AC, data: { pressureOk: true, sealOk: true, accessible: true, signage: true } })).json().error).toMatch(/fire extinguisher/)
    expect((await R.post('/api/eng/logs', ENG, { kind: 'fire', assetId: FIRE, data: { pressureOk: true } })).statusCode).toBe(400)
    const r = (await R.post('/api/eng/logs', ENG, { kind: 'fire', assetId: FIRE, data: { pressureOk: false, sealOk: true, accessible: false, signage: true } })).json()
    expect(r.issues).toEqual(['pressure not in the green', 'blocked or hard to reach'])
    expect((await R.get('/api/eng/logs?kind=fire', CE)).json()[0]).toMatchObject({ asset: 'Extinguisher K-1 (kitchen)', ok: false })
  })
})

describe('compliance calendar', () => {
  it('lists licences, contracts and statutory checks with reminders 60, 30 and 7 days ahead', async () => {
    const id = (await R.post('/api/licences', GM, { kind: 'fire_noc', name: 'Fire NOC', number: 'FNOC/2025/118', validUntil: '2026-11-28' })).json().id
    await patch(`/api/compliance/licences/${id}`, GM, { ownerId: ENGid })
    await R.post('/api/eng/plans', CE, { assetId: FIRE, title: 'Refill', everyDays: 365, checklist: ['Refilled'], nextDue: '2027-01-15' })
    expect((await R.get('/api/compliance', ENG)).statusCode).toBe(403)
    const c = (await R.get('/api/compliance', CE)).json()
    expect(c.items.find((i: { id: string }) => i.id === id)).toMatchObject({ type: 'licence', daysLeft: 26, tier: 30, owner: 'Murugan' })
    expect(c.items.find((i: { type: string }) => i.type === 'amc')).toMatchObject({ name: 'AMC: Room 101 split AC', tier: -1 })
    expect(c.items.find((i: { type: string; name: string }) => i.type === 'maintenance' && i.name.startsWith('Refill'))).toMatchObject({ due: '2027-01-15' })
    const reminders = await audit('compliance.reminder')
    expect(reminders.map((r: { after: { name: string } }) => r.after.name).sort()).toEqual(['AMC: Room 101 split AC', 'Fire NOC'])
    await R.get('/api/compliance', CE)
    expect(await audit('compliance.reminder')).toHaveLength(2)                 // once per tier
    await patch(`/api/licences/${id}`, GM, { validUntil: '2027-11-28' })       // renewed
    const after = (await R.get('/api/compliance', CE)).json().items.find((i: { id: string }) => i.id === id)
    expect(after.tier).toBe(0)
  })
})
