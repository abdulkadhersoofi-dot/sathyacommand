import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// The staff app: attendance inside the resort boundary, late arrivals against the roster, location only
// while on duty, the live staff view for managers, SOS, broadcasts by role.

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', ATT = '', ATT2 = '', EH = '', FD = '', ATTid = '', ATT2id = ''
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const C = { lat: 11.0168, lng: 76.9558 }
const north = (m: number) => ({ lat: C.lat + m / 110574, lng: C.lng, accuracy: 8 })

beforeAll(async () => {
  R = await testResort('2026-11-01')            // 09:00 IST
  GM = await R.staff('Karthik', '9840000101', ['general_manager'])
  ATT = await R.staff('Selvi', '9840000102', ['room_attendant'])
  ATT2 = await R.staff('Muthu', '9840000103', ['room_attendant'])
  EH = await R.staff('Kavitha', '9840000104', ['executive_housekeeper'])
  FD = await R.staff('Priya', '9840000105', ['reception'])
  const users = (await R.get('/api/users', R.md)).json()
  ATTid = users.find((u: { name: string }) => u.name === 'Selvi').id
  ATT2id = users.find((u: { name: string }) => u.name === 'Muthu').id
}, 40_000)
afterAll(() => R.close())
beforeEach(async () => { await R.get('/api/business-date', R.md); await R.get('/api/business-date', GM) })

describe('set-up', () => {
  it('lets the GM set the resort boundary and map position', async () => {
    expect((await put('/api/staff/settings', ATT, { ...C })).statusCode).toBe(403)
    const s = (await put('/api/staff/settings', GM, { ...C, radiusM: 400, mapX: 10, mapZ: 20, rotation: 0 })).json()
    expect(s).toMatchObject({ lat: 11.0168, lng: 76.9558, radiusM: 400, mapX: 10, mapZ: 20, selfieRequired: false })
  })

  it('keeps shifts and a roster', async () => {
    const morning = (await R.post('/api/staff/shifts', EH, { name: 'Morning', starts: '07:00', ends: '15:00' })).json().id
    await R.post('/api/staff/shifts', EH, { name: 'Evening', starts: '15:00', ends: '23:00' })
    expect((await R.post('/api/staff/shifts', ATT, { name: 'X', starts: '01:00', ends: '02:00' })).statusCode).toBe(403)
    await put('/api/staff/roster', EH, { entries: [{ userId: ATTid, day: '2026-11-01', shiftId: morning }, { userId: ATT2id, day: '2026-11-01', shiftId: morning }] })
    expect((await R.get('/api/staff/people', EH)).json().map((p: { name: string }) => p.name)).toContain('Muthu')
    expect((await R.get('/api/staff/roster', ATT)).json()).toEqual([expect.objectContaining({ name: 'Selvi', shift: 'Morning', starts: '07:00' })])
  })
})

describe('attendance', () => {
  it('needs the location policy accepted, and the phone inside the resort', async () => {
    expect((await R.post('/api/staff/clock-in', ATT, north(50))).json().stage).toBe('consent')
    await R.post('/api/staff/consent', ATT, { accept: true })
    const far = await R.post('/api/staff/clock-in', ATT, north(2000))
    expect(far.statusCode).toBe(403)
    expect(far.json().error).toMatch(/about 16\d\d m outside the resort/)
    expect((await R.post('/api/staff/clock-in', ATT, {})).json().error).toMatch(/Turn on location/)
  })

  it('records the clock-in and how late it was against the roster', async () => {
    const r = (await R.post('/api/staff/clock-in', ATT, north(50))).json()
    expect(r.lateMinutes).toBe(115)            // 09:00 against a 07:00 start, 5 minutes' grace
    expect((await R.post('/api/staff/clock-in', ATT, north(50))).json().error).toMatch(/already clocked in/)
    const me = (await R.get('/api/staff/me', ATT)).json()
    expect(me).toMatchObject({ consent: true, onDuty: true, shift: { name: 'Morning' } })
    expect((await R.get('/api/staff/absent', EH)).json().map((a: { name: string }) => a.name)).toEqual(['Muthu'])
    expect((await R.get('/api/audit?limit=3', R.md)).json()[0]).toMatchObject({ action: 'staff.clock_in_late' })
  })
})

describe('location', () => {
  it('records nothing while off duty', async () => {
    const r = await R.post('/api/staff/location', ATT2, north(10))
    expect(r.statusCode).toBe(409)
    expect(r.json().offDuty).toBe(true)
  })

  it('places a GPS fix on the 3D map in metres', async () => {
    const r = (await R.post('/api/staff/location', ATT, north(100))).json()
    expect(r.inside).toBe(true)
    expect(r.x).toBeCloseTo(10, 1)
    expect(r.z).toBeCloseTo(20 - 100, 0)
  })

  it('alerts once when someone on duty is outside the resort for more than 15 minutes', async () => {
    expect((await R.post('/api/staff/location', ATT, north(900))).json()).toMatchObject({ inside: false, alert: false })
    R.advance(8); await R.get('/api/business-date', R.md); await R.get('/api/business-date', GM); R.advance(8)
    expect((await R.post('/api/staff/location', ATT, north(900))).json().alert).toBe(true)
    expect((await R.post('/api/staff/location', ATT, north(900))).json().alert).toBe(false)
    expect((await R.get('/api/audit?limit=5', R.md)).json().some((a: { action: string }) => a.action === 'staff.outside_zone')).toBe(true)
    await R.post('/api/staff/location', ATT, north(20))
  })

  it('places a phone indoors by the Bluetooth beacon it hears', async () => {
    expect((await R.post('/api/staff/beacons', ATT, { id: 'B1', name: 'x' })).statusCode).toBe(403)
    await R.post('/api/staff/beacons', GM, { id: 'f7826da6:1:7', name: 'Sathya Dine', spaceId: 'RESTAURANT' })
    R.advance(1)
    const r = (await R.post('/api/staff/location', ATT, { beaconId: 'f7826da6:1:7' })).json()
    expect(r.inside).toBe(true)
    expect(typeof r.x).toBe('number')
  })

  it('shows managers who is on duty and where; staff see only their own trail', async () => {
    expect((await R.get('/api/staff/live', ATT)).statusCode).toBe(403)
    const live = (await R.get('/api/staff/live', GM)).json()
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ name: 'Selvi', source: 'beacon', place: 'Sathya Dine', sos: false })
    const mine = (await R.get('/api/staff/my-locations?day=2026-11-01', ATT)).json()
    expect(mine.length).toBeGreaterThanOrEqual(6)
  })
})

describe('SOS and messages', () => {
  it('raises an SOS that managers see on the map and in their inbox', async () => {
    const s = (await R.post('/api/staff/sos', ATT, north(30))).json()
    expect(s.located).toBe(true)
    expect((await R.get('/api/staff/live', GM)).json()[0].sos).toBe(true)
    expect((await R.get('/api/staff/inbox', GM)).json()[0]).toMatchObject({ kind: 'sos', title: 'SOS · Selvi' })
    await R.post(`/api/staff/sos/${s.id}/ack`, GM)
    expect((await R.post(`/api/staff/sos/${s.id}/resolve`, GM, {})).statusCode).toBe(400)
    await R.post(`/api/staff/sos/${s.id}/resolve`, GM, { note: 'Slipped on wet floor, first aid given' })
    expect((await R.get('/api/staff/sos', GM)).json()).toHaveLength(0)
  })

  it('shows a clock-in selfie only to the person and to attendance managers', async () => {
    const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const id = (await R.post('/api/uploads', ATT, { kind: 'selfie', dataUrl: px })).json().id
    expect((await R.get(`/api/uploads/${id}`, ATT)).statusCode).toBe(200)
    expect((await R.get(`/api/uploads/${id}`, GM)).statusCode).toBe(200)
    expect((await R.get(`/api/uploads/${id}`, FD)).statusCode).toBe(403)
  })

  it('sends broadcasts to chosen roles and tracks who has read them', async () => {
    expect((await R.post('/api/staff/broadcasts', ATT, { text: 'hi' })).statusCode).toBe(403)
    await R.post('/api/staff/broadcasts', EH, { text: 'Wedding at the Grand Lawn tonight: all public areas cleaned by 5 pm.', roles: ['room_attendant'], urgent: true })
    expect((await R.get('/api/staff/me', ATT)).json().unread).toBe(1)
    expect((await R.get('/api/staff/broadcasts', FD)).json()).toHaveLength(0)
    const [m] = (await R.get('/api/staff/broadcasts', ATT)).json()
    expect(m).toMatchObject({ from_name: 'Kavitha', urgent: true, read: false })
    await R.post(`/api/staff/broadcasts/${m.id}/read`, ATT)
    expect((await R.get('/api/staff/me', ATT)).json().unread).toBe(0)
  })

  it('collects the person\'s work in an inbox and clocks out with the hours worked', async () => {
    await R.post('/api/hk/tasks', EH, { spaceId: 'RM-101', kind: 'deep_clean', assignedTo: ATTid })
    const inbox = (await R.get('/api/staff/inbox', ATT)).json()
    expect(inbox).toEqual([expect.objectContaining({ kind: 'housekeeping', title: 'Room 101' })])
    // Starting the room places her there on the map.
    R.advance(1)
    await R.post(`/api/hk/tasks/${inbox[0].ref}/start`, ATT)
    expect((await R.get('/api/staff/live', GM)).json()[0]).toMatchObject({ source: 'qr', inside: true })
    R.advance(14); await R.get('/api/business-date', R.md)
    const out = (await R.post('/api/staff/clock-out', ATT, north(10))).json()
    expect(out.minutes).toBe(32)
    expect((await R.post('/api/staff/location', ATT, north(10))).statusCode).toBe(409)
    const att = (await R.get('/api/staff/attendance?day=2026-11-01', EH)).json()
    expect(att[0]).toMatchObject({ name: 'Selvi', late_minutes: 115, minutes: 32 })
  })
})
