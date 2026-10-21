import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// The front desk as reception uses it: finding a booking, the whole booking on one screen, a same-day
// (day use) stay, a room not yet cleaned, and plain messages for what used to be developer errors.

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', WAITER = '', SUP = ''
const book = (name: string, mobile: string, arrival = '2026-11-01', departure = '2026-11-02') =>
  R.post('/api/reservations', FD, { guest: { name, mobile }, roomTypeId: 'deluxe', plan: 'EP', arrival, departure })

beforeAll(async () => {
  R = await testResort('2026-11-01')
  FD = await R.staff('Priya', '9840009101', ['reception'])
  WAITER = await R.staff('Ravi', '9840009102', ['captain'])
  SUP = await R.staff('Revathi', '9840009103', ['hk_supervisor'])
}, 60_000)
afterAll(() => R.close())

describe('finding a booking', () => {
  it('finds by name, mobile, booking number and room, and lists what is coming up', async () => {
    const a = (await book('Karthik Raja', '98400 77123')).json().id
    const b = (await book('Lalitha', '9840077124', '2026-11-20', '2026-11-22')).json().id
    await R.post(`/api/reservations/${a}/check-in`, FD, { spaceId: 'RM-104', idType: 'aadhaar', idNumber: '1234 5678 9012' })
    const ids = async (q: string) => (await R.get(`/api/reservations?q=${encodeURIComponent(q)}`, FD)).json().map((r: { id: string }) => r.id)
    expect(await ids('karthik')).toEqual([a])
    expect(await ids('77124')).toEqual([b])
    expect(await ids(b.toLowerCase())).toEqual([b])
    expect(await ids('104')).toEqual([a])
    expect(await ids('nobody here')).toEqual([])
    expect((await R.get('/api/reservations?upcoming=true', FD)).json().map((r: { id: string }) => r.id)).toContain(b)
  })

  it('shows the stay, the room type name and its invoices in the booking', async () => {
    const id = (await R.get('/api/reservations?q=karthik', FD)).json()[0].id
    const d = (await R.get(`/api/reservations/${id}`, FD)).json()
    expect(d).toMatchObject({ room_no: '104', room_type: 'Deluxe Room', source: 'direct', documents: [] })
  })
})

describe('a stay of a few hours (day use)', () => {
  it('charges the night at check-out, then frees the room to sell again tonight', async () => {
    const id = (await book('Day Guest', '9840077125')).json().id
    await R.post(`/api/reservations/${id}/check-in`, FD, { spaceId: 'RM-106', idType: 'aadhaar', idNumber: '1234 5678 9012' })
    const first = await R.post(`/api/reservations/${id}/check-out`, FD)
    expect(first.statusCode).toBe(409)
    expect(first.json().balance).toBe(441000)   // ₹4,200 + 5% GST
    const folio = (await R.get(`/api/reservations/${id}`, FD)).json().folios[0].id
    await R.post(`/api/folios/${folio}/payments`, FD, { method: 'upi', amount: 4410, reference: 'UPI1' })
    const out = (await R.post(`/api/reservations/${id}/check-out`, FD)).json()
    expect(out.invoice.number).toBeTruthy()
    const d = (await R.get(`/api/reservations/${id}`, FD)).json()
    expect(d.documents.map((x: { doc_type: string }) => x.doc_type)).toContain('invoice')
    // The same room takes tonight's guest (once the desk accepts it is not cleaned yet).
    const next = (await book('Night Guest', '9840077126')).json().id
    const dirty = await R.post(`/api/reservations/${next}/check-in`, FD, { spaceId: 'RM-106', idType: 'aadhaar', idNumber: '1234 5678 9012' })
    expect(dirty.json()).toMatchObject({ notClean: true })
    expect((await R.post(`/api/reservations/${next}/check-in`, FD, { spaceId: 'RM-106', idType: 'aadhaar', idNumber: '1234 5678 9012', notClean: true })).statusCode).toBe(200)
  })
})

describe('plain checks and messages', () => {
  it('checks the guest\'s details before booking', async () => {
    const r = (body: object) => R.post('/api/reservations', FD, { roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-02', ...body })
    expect((await r({ guest: { name: 'A', mobile: '12345' } })).json().error).toMatch(/mobile/i)
    expect((await r({ guest: { name: 'A' }, adults: 0 })).json().error).toMatch(/adult/i)
    expect((await R.post('/api/reservations', FD, { guest: { name: 'A' }, roomTypeId: 'suite', plan: 'AP', arrival: '2026-11-01', departure: '2026-11-02' })).json().error).toMatch(/Settings → Rooms & rates/)
  })

  it('lets only the MD, GM or front office set room rates', async () => {
    const rate = { plan: 'EP', roomTypeId: 'deluxe', validFrom: '2027-04-01', validTo: '2028-03-31', amount: 4500 }
    expect((await R.app.inject({ method: 'PUT', url: '/api/rates', headers: { authorization: `Bearer ${WAITER}` }, payload: rate })).statusCode).toBe(403)
    expect((await R.app.inject({ method: 'PUT', url: '/api/rates', headers: { authorization: `Bearer ${R.md}` }, payload: rate })).json()).toMatchObject({ ok: true })
  })

  it('lets the housekeeping supervisor share out the day\'s rooms', async () => {
    const users = (await R.get('/api/hk/staff', SUP)).json()
    expect((await R.post('/api/hk/assign', SUP, { attendants: [users[0].id] })).statusCode).toBe(200)
  })

  it('answers a database rule the screen missed with a plain message, not "something went wrong"', async () => {
    const res = await R.post('/api/reservations', FD, { guest: { name: 'A' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-02', children: -1 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).not.toMatch(/Something went wrong/)
  })
})
