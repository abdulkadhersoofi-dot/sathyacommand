import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultLayout, type SiteLayout } from '@sathya/twin'
import { testResort } from './helpers'

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', OPS = ''

beforeAll(async () => {
  R = await testResort('2026-11-01')
  FD = await R.staff('Priya', '9840000002', ['reception'])
  OPS = await R.staff('Mani', '9840000005', ['operations_manager'])
}, 30_000)
afterAll(() => R.close())

const lakeWing = (l: SiteLayout) => {
  l.blocks.push({ id: 'lake-wing', label: 'Lake Wing', idPrefix: 'LAKE', numberPrefix: 'L', rect: [60, -80, 90, -50], floors: 2, floorHeight: 3.2, depth: 9, ring: [3, 1, 3, 1] })
  return l
}

describe('Twin Studio layouts', () => {
  it('starts with the traced resort published as version 1', async () => {
    const r = (await R.get('/api/site', FD)).json()
    expect(r.version).toBe(1)
    expect(r.layout.blocks[0].label).toBe('Park Wing')
  })

  it('lets the Operations Manager save a draft but not publish it', async () => {
    const d = await R.post('/api/site/drafts', OPS, { layout: lakeWing(defaultLayout()), note: 'Lake Wing proposal' })
    expect(d.statusCode).toBe(201)
    expect(d.json()).toMatchObject({ added: ['lake-wing'], removed: [] })
    expect((await R.post(`/api/site/versions/${d.json().id}/publish`, OPS)).statusCode).toBe(403)
    expect((await R.post('/api/site/drafts', FD, { layout: defaultLayout() })).statusCode).toBe(403)
  })

  it('refuses a layout with problems and lists them', async () => {
    const bad = defaultLayout()
    bad.buildings[0].height = 120
    const r = await R.post('/api/site/drafts', OPS, { layout: bad })
    expect(r.statusCode).toBe(400)
    expect(r.json().problems).toContain('Building "Reception": height must be 2–40 m.')
  })

  it('publishes, and lists drawn rooms that have no HMS room yet', async () => {
    const id = (await R.post('/api/site/drafts', OPS, { layout: lakeWing(defaultLayout()) })).json().id
    const p = (await R.post(`/api/site/versions/${id}/publish`, R.md)).json()
    expect(p.version).toBe(id)
    expect(p.unlinkedObjects.filter((o: { id: string }) => o.id.startsWith('LAKE-'))).toHaveLength(16)
    expect((await R.get('/api/site', FD)).json().version).toBe(id)
  })

  it('creates the HMS rooms for a new block in one step', async () => {
    await R.post('/api/room-types', R.md, { name: 'Lake View', baseRate: 6200, maxOccupancy: 3 })
    const rooms = Array.from({ length: 8 }, (_, i) => ({ roomNo: `L1${String(i + 1).padStart(2, '0')}`, kind: 'room', roomTypeId: 'lake-view', building: 'Lake Wing', floor: 1, twinId: `LAKE-1-L1${String(i + 1).padStart(2, '0')}` }))
    const r = (await R.post('/api/rooms/import', R.md, { rooms })).json()
    expect(r.created).toBe(8)
    const snap = (await R.get('/api/dashboard?from=2026-11-01&to=2026-11-02', FD)).json()
    expect(snap.spaces.find((s: { room_no: string }) => s.room_no === 'L101').twin_id).toBe('LAKE-1-L101')
  })

  it('will not remove the drawing of a room with a guest booked', async () => {
    await R.db.query(`insert into rate (rate_plan_id, room_type_id, valid_from, valid_to, amount_paise) values ('sathya-EP', 'lake-view', '2026-11-01', '2027-03-31', 620000) on conflict do nothing`)
    const booked = await R.post('/api/reservations', FD, { guest: { name: 'Kavya' }, roomTypeId: 'lake-view', plan: 'EP', arrival: '2026-11-03', departure: '2026-11-04' })
    expect(booked.statusCode).toBe(201)
    await R.post(`/api/reservations/${booked.json().id}/assign-room`, FD, { spaceId: (await R.db.query<{ id: string }>(`select id from space where room_no = 'L101'`))[0].id })
    const id = (await R.post('/api/site/drafts', OPS, { layout: defaultLayout() })).json().id   // no Lake Wing
    const r = await R.post(`/api/site/versions/${id}/publish`, R.md)
    expect(r.statusCode).toBe(409)
    expect(r.json().busyRooms).toEqual(['L101'])
  })

  it('restores an earlier version as a new version, and logs every step', async () => {
    const before = (await R.get('/api/site', FD)).json().version
    const r = await R.post('/api/site/versions/1/restore', R.md)
    expect(r.statusCode).toBe(409)                         // version 1 has no Lake Wing and L101 is booked
    const versions = (await R.get('/api/site/versions', OPS)).json()
    expect(versions.find((v: { status: string }) => v.status === 'published').id).toBe(before)
    const actions = (await R.get('/api/audit?limit=500', R.md)).json().map((e: { action: string }) => e.action)
    for (const a of ['site.draft_saved', 'site.published']) expect(actions).toContain(a)
    expect((await R.get('/api/audit/verify', R.md)).json()).toMatchObject({ ok: true })
  })
})
