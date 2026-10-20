import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'
import { windowStart } from '../src/routes/security'

// Security: the gate register with guest vehicle tags, patrols by QR checkpoint with missed-checkpoint
// alerts, incidents, CCTV cameras, the key register, and emergency roll-call.

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', HEAD = '', GUARD = '', ATT = '', FD = '', ATTid = ''
const audit = async (action: string) => (await R.get('/api/audit?limit=300', R.md)).json().filter((a: { action: string }) => a.action === action)
const everyone = () => [R.md, GM, HEAD, GUARD, ATT, FD]
async function pass(minutes: number) {
  for (let left = minutes; left > 0; left -= 14) { R.advance(Math.min(14, left)); for (const t of everyone()) await R.get('/api/business-date', t) }
}

beforeAll(async () => {
  R = await testResort('2026-11-01')            // 09:00 IST
  GM = await R.staff('Karthik', '9840000301', ['general_manager'])
  HEAD = await R.staff('Raja', '9840000302', ['security_head'])
  GUARD = await R.staff('Velu', '9840000303', ['security'])
  ATT = await R.staff('Selvi', '9840000304', ['room_attendant'])
  FD = await R.staff('Priya', '9840000305', ['reception'])
  ATTid = (await R.get('/api/users', R.md)).json().find((u: { name: string }) => u.name === 'Selvi').id
}, 40_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of everyone()) await R.get('/api/business-date', t) })

describe('gate register', () => {
  it('tags a guest vehicle and logs visitors in and out', async () => {
    const r = (await R.post('/api/reservations', FD, { roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-03', guest: { name: 'Arun' } })).json()
    expect((await R.post('/api/security/gate', ATT, { kind: 'visitor', name: 'x' })).statusCode).toBe(403)
    expect((await R.get('/api/security/gate/guests', GUARD)).json().map((g: { name: string }) => g.name)).toContain('Arun')
    expect((await R.post('/api/security/gate', GUARD, { kind: 'guest_vehicle', vehicleNo: 'TN 38 AB 1234' })).json().error).toMatch(/guest/)
    const car = (await R.post('/api/security/gate', GUARD, { kind: 'guest_vehicle', vehicleNo: 'tn 38 ab 1234', reservationId: r.id, tagNo: 'G-07', parking: 'P1', x: 40, z: 80 })).json().id
    expect((await R.post('/api/security/gate', GUARD, { kind: 'guest_vehicle', vehicleNo: 'TN01X1', reservationId: r.id, tagNo: 'G-07' })).statusCode).toBe(409)
    await R.post('/api/security/gate', GUARD, { kind: 'vendor', name: 'Fresh Farms', vehicleNo: 'TN37 C 999', purpose: 'Vegetables', host: 'Kitchen' })
    const inside = (await R.get('/api/security/gate?inside=1', HEAD)).json()
    expect(inside.find((e: { id: string }) => e.id === car)).toMatchObject({ vehicle_no: 'TN38AB1234', guest: 'Arun', tag_no: 'G-07' })
    expect((await R.get('/api/security/map', GUARD)).json()).toMatchObject({ vehiclesInside: 2, vehicles: [expect.objectContaining({ label: 'TN38AB1234', pos: { x: 40, z: 80 } })] })
    await R.post(`/api/security/gate/${car}/out`, GUARD)
    expect((await R.post(`/api/security/gate/${car}/out`, GUARD)).statusCode).toBe(409)
    expect((await R.get('/api/security/gate?inside=1', HEAD)).json()).toHaveLength(1)
    expect((await R.get('/api/security/gate', HEAD)).json()).toHaveLength(2)   // today's register
  })
})

describe('patrols', () => {
  let A = '', B = '', codeA = ''
  it('works out when a patrol round is running, including past midnight', () => {
    const at = (iso: string) => new Date(iso)
    expect(windowStart({ starts: '22:00', ends: '06:00' }, at('2026-11-01T18:00:00Z'))?.toISOString()).toBe('2026-11-01T16:30:00.000Z')   // 23:30 IST
    expect(windowStart({ starts: '22:00', ends: '06:00' }, at('2026-11-01T22:00:00Z'))?.toISOString()).toBe('2026-11-01T16:30:00.000Z')   // 03:30 IST next day
    expect(windowStart({ starts: '22:00', ends: '06:00' }, at('2026-11-01T06:30:00Z'))).toBeNull()                                         // noon
    expect(windowStart({ starts: '08:00', ends: '20:00' }, at('2026-11-01T06:30:00Z'))?.toISOString()).toBe('2026-11-01T02:30:00.000Z')
  })

  it('records scans at QR checkpoints and alerts once when one is missed', async () => {
    expect((await R.post('/api/security/checkpoints', GUARD, { name: 'x' })).statusCode).toBe(403)
    const a = (await R.post('/api/security/checkpoints', HEAD, { name: 'Back gate', x: -120, z: 60 })).json()
    A = a.id; codeA = a.code
    B = (await R.post('/api/security/checkpoints', HEAD, { name: 'DG room', spaceId: 'RM-101' })).json().id
    expect((await R.get('/api/security/checkpoints/labels', HEAD)).body).toContain('Back gate')
    await R.post('/api/security/routes', HEAD, { name: 'Day round', checkpointIds: [A, B], everyMinutes: 60, starts: '08:00', ends: '20:00' })
    await R.post('/api/staff/consent', GUARD, { accept: true })
    await R.post('/api/staff/clock-in', GUARD, {})
    expect((await R.post('/api/security/scan', GUARD, { code: 'NOPE' })).statusCode).toBe(404)
    expect((await R.post('/api/security/scan', GUARD, { code: codeA })).json().checkpoint).toBe('Back gate')
    expect((await R.get('/api/staff/live', HEAD)).json()[0]).toMatchObject({ source: 'qr', place: 'Back gate' })
    // DG room has not been scanned since the round began at 08:00: 60 minutes plus 10 of grace later it is overdue.
    await pass(15)
    const cps = (await R.get('/api/security/checkpoints', GUARD)).json()
    expect(cps.find((c: { id: string }) => c.id === B)).toMatchObject({ overdue: true })
    expect(cps.find((c: { id: string }) => c.id === A)).toMatchObject({ overdue: false, last_by: 'Velu' })
    expect(await audit('security.patrol_missed')).toHaveLength(1)
    await R.get('/api/security/checkpoints', GUARD)
    expect(await audit('security.patrol_missed')).toHaveLength(1)        // once per gap
    expect((await R.get('/api/staff/inbox', GUARD)).json()[0]).toMatchObject({ kind: 'patrol', title: 'Patrol due: DG room' })
    await pass(60)
    await R.get('/api/security/checkpoints', GUARD)
    expect((await audit('security.patrol_missed')).map((x: { after: { checkpoint: string } }) => x.after.checkpoint).sort()).toEqual(['Back gate', 'DG room'])
  })
})

describe('incidents and cameras', () => {
  it('lets anyone report an incident; security sees and closes them', async () => {
    expect((await R.post('/api/security/incidents', ATT, { kind: 'theft', severity: 'urgent', title: 'x' })).statusCode).toBe(400)
    const id = (await R.post('/api/security/incidents', ATT, { kind: 'theft', severity: 'high', title: 'Guest phone missing from poolside', spaceId: 'RM-101' })).json().id
    expect((await R.get('/api/security/incidents', ATT)).json()).toHaveLength(1)
    expect((await R.get('/api/security/incidents', FD)).json()).toHaveLength(0)
    expect((await R.get('/api/security/map', GUARD)).json().incidents[0]).toMatchObject({ title: 'Guest phone missing from poolside', severity: 'high' })
    expect((await R.post(`/api/security/incidents/${id}/close`, GUARD, { actionTaken: 'x' })).statusCode).toBe(403)
    expect((await R.post(`/api/security/incidents/${id}/close`, HEAD, {})).statusCode).toBe(400)
    await R.post(`/api/security/incidents/${id}/close`, HEAD, { actionTaken: 'Found under a sunbed, returned to guest' })
    expect((await R.get('/api/security/incidents?status=closed', GM)).json()[0]).toMatchObject({ closed_by_name: 'Raja', status: 'closed' })
  })

  it('keeps camera pins with the NVR live view, without passwords in the address', async () => {
    expect((await R.post('/api/security/cameras', HEAD, { name: 'Main gate', viewUrl: 'http://admin:1234@10.0.0.20/ch1' })).json().error).toMatch(/password/)
    expect((await R.post('/api/security/cameras', HEAD, { name: 'Main gate', viewUrl: 'rtsp://10.0.0.20/ch1' })).statusCode).toBe(400)
    await R.post('/api/security/cameras', HEAD, { name: 'Main gate', viewUrl: 'http://10.0.0.20/view?ch=1', channel: '1', x: 5, z: 150 })
    expect((await R.get('/api/security/cameras', ATT)).statusCode).toBe(403)
    expect((await R.get('/api/security/map', GM)).json().cameras[0]).toMatchObject({ name: 'Main gate', hasView: true, pos: { x: 5, z: 150 } })
  })
})

describe('keys', () => {
  it('issues and takes back keys, alerting when one is not back on time', async () => {
    const k = (await R.post('/api/security/keys', HEAD, { label: 'Master key A', kind: 'master' })).json().id
    await R.post(`/api/security/keys/${k}/issue`, GUARD, { userId: ATTid, hours: 1, note: 'Deep clean, block A' })
    expect((await R.post(`/api/security/keys/${k}/issue`, GUARD, { issuedTo: 'Someone' })).json().error).toMatch(/out with Selvi/)
    await pass(70)
    expect((await R.get('/api/security/keys', GUARD)).json()[0]).toMatchObject({ label: 'Master key A', issued_to: 'Selvi', overdue: true })
    expect((await audit('security.key_overdue'))[0].after).toMatchObject({ key: 'Master key A', with: 'Selvi' })
    await R.post(`/api/security/keys/${k}/return`, GUARD)
    expect((await R.get('/api/security/keys', GUARD)).json()[0]).toMatchObject({ log_id: null })
    expect((await R.get('/api/security/keys/log', HEAD)).json()[0]).toMatchObject({ issued_to: 'Selvi', back_by_name: 'Velu' })
  })
})

describe('emergency', () => {
  it('runs a roll-call of everyone on duty, with assembly points', async () => {
    await R.post('/api/staff/consent', ATT, { accept: true })
    await R.post('/api/staff/clock-in', ATT, {})
    const ap = (await R.post('/api/security/assembly-points', HEAD, { name: 'Grand Lawn gate', x: 30, z: 120 })).json().id
    expect((await R.post('/api/security/emergency', ATT, { kind: 'fire' })).statusCode).toBe(403)
    await R.post('/api/security/emergency', GUARD, { kind: 'fire', note: 'Smoke in the kitchen' })
    expect((await R.post('/api/security/emergency', GM, { kind: 'fire' })).statusCode).toBe(409)
    const mine = (await R.get('/api/security/emergency', ATT)).json()
    expect(mine).toMatchObject({ active: { kind: 'fire', started_by: 'Velu' }, mine: { status: null }, points: [expect.objectContaining({ name: 'Grand Lawn gate' })] })
    expect(mine.people).toBeUndefined()
    let roll = (await R.get('/api/security/emergency', HEAD)).json()
    expect(roll.counts).toEqual({ total: 2, safe: 0, needHelp: 0, missing: 2 })
    await R.post('/api/security/emergency/check', ATT, { status: 'safe', pointId: ap })
    expect((await R.post('/api/security/emergency/check', ATT, { status: 'safe', userId: 'u-md' })).statusCode).toBe(403)
    await R.post('/api/security/emergency/check', HEAD, { status: 'safe' })          // off duty but on site: added to the list
    roll = (await R.get('/api/security/emergency', HEAD)).json()
    expect(roll.counts).toEqual({ total: 3, safe: 2, needHelp: 0, missing: 1 })
    expect(roll.people[0]).toMatchObject({ name: 'Velu', status: null })
    expect(roll.people.find((p: { name: string }) => p.name === 'Selvi')).toMatchObject({ point: 'Grand Lawn gate' })
    expect((await R.post('/api/security/emergency/end', GUARD, {})).statusCode).toBe(400)
    expect((await R.post('/api/security/emergency/end', GUARD, { summary: 'Kitchen exhaust smoke, cleared. All accounted for.' })).json()).toMatchObject({ unaccounted: 1 })
    expect((await R.get('/api/security/emergency', ATT)).json().active).toBeNull()
    expect((await R.get('/api/security/emergency/history', GM)).json()[0]).toMatchObject({ kind: 'fire', people: 3, safe: 2 })
  })
})

