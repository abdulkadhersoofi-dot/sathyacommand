import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditBus, type LiveEvent } from '../src/audit-store'
import { testResort } from './helpers'

let R: Awaited<ReturnType<typeof testResort>>
let FD = ''

beforeAll(async () => {
  R = await testResort('2026-11-01')
  FD = await R.staff('Priya', '9840000002', ['reception'])
}, 30_000)
afterAll(() => R.close())

describe('3D dashboard feed', () => {
  it('returns rooms with their 3D ids and live reservations with balances', async () => {
    const id = (await R.post('/api/reservations', FD, { guest: { name: 'Arun', mobile: '9840011111' }, roomTypeId: 'deluxe', plan: 'EP',
      arrival: '2026-11-01', departure: '2026-11-03' })).json().id
    await R.post(`/api/reservations/${id}/check-in`, FD, { spaceId: 'RM-104', idType: 'aadhaar', idNumber: '1234 5678 9012' })
    const snap = (await R.get('/api/dashboard?from=2026-10-25&to=2026-11-30', FD)).json()
    expect(snap.businessDate).toBe('2026-11-01')
    expect(snap.spaces.find((s: { id: string }) => s.id === 'RM-104')).toMatchObject({ twin_id: 'MAIN-1-104', room_type: 'Deluxe Room' })
    const r = snap.reservations.find((x: { id: string }) => x.id === id)
    expect(r).toMatchObject({ status: 'in_house', twin_id: 'MAIN-1-104', room_no: '104', rate_paise: 420000, balance_paise: 0, pax: 1 })
    expect(r.mobile).toBe('+9198•••••111')                  // masked for non-God Mode users
  })

  it('announces each logged action for live screens', async () => {
    const seen: LiveEvent[] = []
    const on = (e: LiveEvent) => seen.push(e)
    auditBus.on('event', on)
    await R.post('/api/reservations', FD, { guest: { name: 'Bala' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-02', departure: '2026-11-03' })
    auditBus.off('event', on)
    expect(seen.map((e) => e.action)).toContain('reservation.create')
    expect(seen[0]).toMatchObject({ actor: 'Priya', entity: { type: 'reservation' } })
  })

  it('needs a signed-in user', async () => {
    expect((await R.app.inject({ url: '/api/dashboard?from=2026-11-01&to=2026-11-02' })).statusCode).toBe(401)
    expect((await R.app.inject({ url: '/api/stream' })).statusCode).toBe(401)
  })
})
