import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { planMessages, sendDue, type WhatsAppSender } from '../src/guest'
import { testResort } from './helpers'

// The guest journey: each room's QR page (only with its signed link, only for the guest staying), requests
// to housekeeping, the kitchen and engineering; messages at each step of the stay; activities on the bill;
// feedback with low scores flagged and replied to.

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', GM = '', HK = ''
let RES = '', ROOM = '', TOKEN = ''
const pub = (method: 'GET' | 'POST', url: string, payload?: unknown) => R.app.inject({ method, url, payload: payload as object })

beforeAll(async () => {
  R = await testResort('2026-11-01')
  FD = await R.staff('Priya', '9840005001', ['reception'])
  GM = await R.staff('Karthik', '9840005002', ['general_manager'])
  HK = await R.staff('Lakshmi', '9840005003', ['hk_supervisor'])
  RES = (await R.post('/api/reservations', FD, { guest: { name: 'Anitha Raman', mobile: '9840077777' }, roomTypeId: 'deluxe', plan: 'CP', arrival: '2026-11-01', departure: '2026-11-03' })).json().id
}, 60_000)
afterAll(() => R.close())

describe('the room\'s QR page', () => {
  it('opens only with the room\'s signed link, and takes requests only while a guest is staying', async () => {
    const cards = (await R.get('/api/guest/room-qr', FD)).json()
    expect(cards.length).toBe(47)
    const c = cards.find((x: { room_no: string }) => x.room_no === '101')
    const u = new URL(c.url)
    ROOM = u.searchParams.get('s')!; TOKEN = u.searchParams.get('t')!
    expect((await pub('GET', `/public/room/${ROOM}?t=forged`)).statusCode).toBe(404)
    expect((await pub('GET', `/public/room/${ROOM}?t=${TOKEN}`)).json()).toMatchObject({ room: '101', occupied: false, guest: null })
    expect((await pub('POST', `/public/room/${ROOM}/requests?t=${TOKEN}`, { kind: 'housekeeping', items: [{ name: 'Fresh towels' }] })).statusCode).toBe(409)
    await R.post(`/api/reservations/${RES}/check-in`, FD, { spaceId: ROOM, idType: 'aadhaar', idNumber: '1234 5678 9012' })
    const page = (await pub('GET', `/public/room/${ROOM}?t=${TOKEN}`)).json()
    expect(page).toMatchObject({ occupied: true, guest: 'Anitha', departure: '2026-11-03' })
    expect(page.housekeeping).toContain('Fresh towels')
    expect(page.menu.length).toBeGreaterThan(0)
    expect(page.activities.map((a: { name: string }) => a.name)).toContain('Swimming pool')
  })

  it('sends housekeeping, food and faults to the right people', async () => {
    const url = `/public/room/${ROOM}/requests?t=${TOKEN}`
    expect((await pub('POST', url, { kind: 'housekeeping', items: [{ name: 'A pony' }] })).statusCode).toBe(400)
    expect((await pub('POST', url, { kind: 'housekeeping', items: [{ name: 'Fresh towels', qty: 2 }, { name: 'Extra pillow' }] })).statusCode).toBe(201)
    const menu = (await pub('GET', `/public/room/${ROOM}?t=${TOKEN}`)).json().menu
    expect((await pub('POST', url, { kind: 'food', items: [{ id: menu[0].id, qty: 2 }], note: 'Less spicy' })).statusCode).toBe(201)
    expect((await pub('POST', url, { kind: 'maintenance', note: 'AC is not cooling' })).statusCode).toBe(201)
    const list = (await R.get('/api/guest/requests', HK)).json()
    expect(list.map((q: { kind: string }) => q.kind).sort()).toEqual(['food', 'housekeeping', 'maintenance'])
    const fault = list.find((q: { kind: string }) => q.kind === 'maintenance')
    const [tk] = await R.db.query<{ title: string; priority: string; space_id: string }>('select title, priority, space_id from ticket where id = $1', [fault.ticket_id])
    expect(tk).toEqual({ title: 'Room 101: AC is not cooling', priority: 'high', space_id: ROOM })
    const food = list.find((q: { kind: string }) => q.kind === 'food')
    expect(food.items[0]).toMatchObject({ qty: 2, name: menu[0].name })
    const hk = list.find((q: { kind: string }) => q.kind === 'housekeeping')
    expect((await R.post(`/api/guest/requests/${hk.id}/accept`, HK)).statusCode).toBe(200)
    expect((await R.post(`/api/guest/requests/${hk.id}/done`, HK)).statusCode).toBe(200)
    expect((await R.post(`/api/guest/requests/${hk.id}/done`, HK)).statusCode).toBe(409)
    expect((await pub('GET', `/public/room/${ROOM}?t=${TOKEN}`)).json().open.length).toBe(2)
  })
})

describe('messages at each step of the stay', () => {
  it('queues each message once, skips them for a cancelled stay, and sends them when a provider is set up', async () => {
    const later = (await R.post('/api/reservations', FD, { guest: { name: 'Ravi Kumar', mobile: '9840066666' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-02', departure: '2026-11-04' })).json().id
    const gone = (await R.post('/api/reservations', FD, { guest: { name: 'Gone Guest', mobile: '9840055555' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-20', departure: '2026-11-21' })).json().id
    const m = (await R.get('/api/guest/messages', FD)).json()
    expect(m.provider).toBeNull()
    const of = (id: string) => m.messages.filter((x: { reservation_id: string }) => x.reservation_id === id).map((x: { template: string }) => x.template).sort()
    expect(of(RES)).toEqual(['welcome'])   // already staying: no confirmation or pre-arrival any more
    expect(of(later)).toEqual(['confirmation', 'pre_arrival'])
    const welcome = m.messages.find((x: { reservation_id: string; template: string }) => x.reservation_id === RES && x.template === 'welcome')
    expect(welcome.body).toContain('/room.html?s=')
    expect(welcome.mobile).toBe('+919840077777')
    await R.post(`/api/reservations/${gone}/cancel`, FD, { reason: 'Plans changed' })
    expect(await planMessages(R.db, new Date(R.now()))).toBe(0)
    const [skipped] = await R.db.query<{ status: string }>('select status from guest_message where reservation_id = $1', [gone])
    expect(skipped.status).toBe('skipped')
    expect((await R.post(`/api/guest/messages/${welcome.id}/sent`, FD)).statusCode).toBe(200)
    const sent: string[] = []
    const wa: WhatsAppSender = { name: 'test', async send(mobile, _body, template) { sent.push(`${mobile}:${template}`); return { ref: `wamid.${sent.length}` } } }
    expect(await sendDue(R.db, wa, new Date(R.now()))).toBe(2)
    expect(sent).toContain('+919840066666:pre_arrival')
    const [{ c }] = await R.db.query<{ c: number }>(`select count(*)::int as c from guest_message where status = 'queued'`)
    expect(c).toBe(0)
  })
})

describe('activities', () => {
  it('books an activity onto the guest\'s bill with GST, within its hours and slots', async () => {
    const a = (await R.get('/api/guest/activities?day=2026-11-01', FD)).json()
    const cricket = a.activities.find((x: { id: string }) => x.id === 'ACT-CRICKET')
    expect(cricket).toMatchObject({ price_paise: 150_000, per: 'hour', capacity: 1 })
    expect(a.inHouse.map((x: { id: string }) => x.id)).toEqual([RES])
    expect((await R.post('/api/guest/activities/ACT-CRICKET/book', FD, { reservationId: RES, at: '05:00', qty: 2 })).json().error).toMatch(/open 06:00/)
    const b = (await R.post('/api/guest/activities/ACT-CRICKET/book', FD, { reservationId: RES, at: '16:00', qty: 2 })).json()
    expect(b).toMatchObject({ amountPaise: 300_000, chargedPaise: 354_000 })
    expect((await R.post('/api/guest/activities/ACT-CRICKET/book', FD, { guestName: 'Walk-in team', at: '16:00', qty: 1 })).statusCode).toBe(409)
    expect((await R.post('/api/guest/activities/ACT-POOL/book', FD, { guestName: 'Day visitor', at: '10:00', qty: 3 })).json()).toMatchObject({ amountPaise: 0, chargedPaise: 0 })
    const lines = await R.db.query<{ description: string; gst_rate: string; amount_paise: string }>(`select l.description, l.gst_rate, l.amount_paise from folio_line l join folio f on f.id = l.folio_id where f.reservation_id = $1 and l.kind = 'misc'`, [RES])
    expect(lines.map((l) => [l.description, Number(l.gst_rate), Number(l.amount_paise)])).toEqual([['Cricket ground (nets and pitch), 2 hours on 2026-11-01 at 16:00', 18, 354_000]])
    expect((await R.post('/api/guest/activities', FD, { name: 'Spa', per: 'session', price: 2500 })).statusCode).toBe(403)
    expect((await R.post('/api/guest/activities', GM, { name: 'Bullock-cart ride', per: 'person', price: 300, capacity: 6, opens: '16:00', closes: '18:30' })).statusCode).toBe(201)
  })
})

describe('feedback', () => {
  it('flags a poor score to God Mode at once, takes one per stay, and the manager replies', async () => {
    expect((await pub('POST', `/public/room/${ROOM}/feedback?t=${TOKEN}`, { comment: 'meh' })).statusCode).toBe(400)
    expect((await pub('POST', `/public/room/${ROOM}/feedback?t=${TOKEN}`, { overall: 2, cleanliness: 1, comment: 'Bathroom was not clean' })).json()).toMatchObject({ ok: true, review: null })
    expect((await pub('POST', `/public/room/${ROOM}/feedback?t=${TOKEN}`, { overall: 5 })).statusCode).toBe(409)
    const [al] = await R.db.query<{ action: string }>(`select action from audit_log where action like 'guest.feedback%' order by seq desc limit 1`)
    expect(al.action).toBe('guest.feedback_low')
    const f = (await R.get('/api/guest/feedback', GM)).json()
    expect(f).toMatchObject({ count: 1, low: 1, averages: { overall: 2, cleanliness: 1 } })
    expect((await R.post(`/api/guest/feedback/${f.feedback[0].id}/reply`, FD, { reply: 'Sorry' })).statusCode).toBe(403)
    expect((await R.post(`/api/guest/feedback/${f.feedback[0].id}/reply`, GM, { reply: 'We are sorry; housekeeping has redone the bathroom and the supervisor will check it.' })).statusCode).toBe(200)
    expect((await R.get('/api/guest/feedback', GM)).json().feedback[0].replied_by).toBe('Karthik')
  })

  it('knows a returning guest', async () => {
    await R.db.query(`insert into reservation (id, property_id, guest_id, status, room_type_id, rate_plan_code, arrival, departure, created_by, created_at)
                      select 'R-PAST1', property_id, guest_id, 'checked_out', room_type_id, 'EP', '2026-01-10', '2026-01-12', created_by, created_at from reservation where id = $1`, [RES])
    const snap = (await R.get('/api/dashboard?from=2026-11-01&to=2026-11-30', FD)).json()
    expect(snap.reservations.find((x: { id: string }) => x.id === RES).past_stays).toBe(1)
  })
})
