import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PaymentProvider } from '../src/channels'
import { testResort } from './helpers'

// Guest channels: the public booking page with selling rules, online check-in from the signed link, a
// deposit by payment link (paid by webhook, or the booking cancelled when unpaid), and the channel manager:
// availability and rates out, OTA bookings in (new, duplicate, changed, cancelled, refused and kept).

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', FD = ''
const pub = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) => R.app.inject({ method, url, payload: payload as object, headers })
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })

beforeAll(async () => {
  R = await testResort('2026-11-01', { channelKey: 'ck-test-123' })
  GM = await R.staff('Karthik', '9840004001', ['general_manager'])
  FD = await R.staff('Priya', '9840004002', ['reception'])
}, 60_000)
afterAll(() => R.close())

describe('the booking page', () => {
  it('shows rooms and prices to anyone, within the selling rules', async () => {
    const a = (await pub('GET', '/public/availability?arrival=2026-11-10&departure=2026-11-12&adults=2')).json()
    const dlx = a.roomTypes.find((x: { roomTypeId: string }) => x.roomTypeId === 'deluxe')
    expect(dlx).toMatchObject({ available: true, nights: 2 })
    expect(dlx.prices.find((p: { plan: string }) => p.plan === 'CP')).toMatchObject({ roomPaise: 2 * 480_000, gstPaise: 2 * 24_000, firstNightPaise: 504_000 })
    expect((await put('/api/channels/restrictions', FD, { roomTypeIds: ['deluxe'], from: '2026-11-11', to: '2026-11-11', stopSell: true })).statusCode).toBe(403)
    await put('/api/channels/restrictions', GM, { roomTypeIds: ['deluxe'], from: '2026-11-11', to: '2026-11-11', stopSell: true })
    await put('/api/channels/restrictions', GM, { roomTypeIds: ['villa'], from: '2026-11-01', to: '2026-11-30', weekdays: [2], minStay: 3 })   // Tuesdays (10th)
    const b = (await pub('GET', '/public/availability?arrival=2026-11-10&departure=2026-11-12&adults=2')).json()
    expect(b.roomTypes.find((x: { roomTypeId: string }) => x.roomTypeId === 'deluxe')).toMatchObject({ available: false, reason: 'Not available on 2026-11-11.' })
    expect(b.roomTypes.find((x: { roomTypeId: string }) => x.roomTypeId === 'villa').reason).toMatch(/at least 3 nights/)
    expect((await pub('POST', '/public/bookings', { roomTypeId: 'deluxe', plan: 'CP', arrival: '2026-11-10', departure: '2026-11-12', name: 'A', mobile: '9840099999' })).statusCode).toBe(409)
    await put('/api/channels/restrictions', GM, { roomTypeIds: ['deluxe'], from: '2026-11-11', to: '2026-11-11' })   // cleared
    expect((await R.get('/api/channels/restrictions?from=2026-11-01&to=2026-11-30', FD)).json().restrictions.length).toBe(4)
  })

  let BK = '', TOKEN = ''
  it('books a room for a guest without a login; the guest pays at the resort when no gateway is set up', async () => {
    expect((await pub('POST', '/public/bookings', { roomTypeId: 'deluxe', plan: 'CP', arrival: '2026-11-10', departure: '2026-11-12', name: 'Bot', mobile: '9840099999', website: 'spam.example' })).statusCode).toBe(400)
    expect((await pub('POST', '/public/bookings', { roomTypeId: 'deluxe', plan: 'CP', arrival: '2026-11-10', departure: '2026-11-12', name: 'Anitha', mobile: '12345' })).json().error).toMatch(/mobile/)
    const r = await pub('POST', '/public/bookings', { roomTypeId: 'deluxe', plan: 'CP', arrival: '2026-11-10', departure: '2026-11-12', adults: 2, name: 'Anitha R', mobile: '98400 77777', email: 'anitha@example.com', requests: 'Late arrival' })
    expect(r.statusCode).toBe(201)
    const b = r.json()
    expect(b).toMatchObject({ totalPaise: 2 * 504_000, payment: null })
    BK = b.reservationId; TOKEN = b.token
    expect(b.checkinUrl).toContain(`/checkin.html?r=${BK}&t=${TOKEN}`)
    const [res] = await R.db.query<{ source: string; created_by: string; pay_by: Date | null }>('select source, created_by, pay_by from reservation where id = $1', [BK])
    expect(res).toEqual({ source: 'website', created_by: 'system', pay_by: null })
    expect((await pub('GET', `/public/bookings/${BK}?t=wrong-token-xxxxxxxxxx`)).statusCode).toBe(404)
    expect((await pub('GET', `/public/bookings/${BK}?t=${TOKEN}`)).json()).toMatchObject({ guest: 'Anitha R', room_type: 'Deluxe Room', roomPaise: 960_000, paidPaise: 0, checkedInOnline: null })
    expect((await R.get('/api/users', GM)).json().some((u: { id: string }) => u.id === 'system')).toBe(false)
  })

  it('takes the online check-in, keeping only the last four of the ID', async () => {
    const url = `/public/bookings/${BK}/checkin?t=${TOKEN}`
    expect((await pub('POST', url, { eta: '21:30' })).json().error).toMatch(/agree/)
    expect((await pub('POST', url, { consent: true, nationality: 'GB', idType: 'aadhaar', idNumber: '1234 5678 9012' })).json().error).toMatch(/passport/)
    expect((await pub('POST', url, { consent: true, eta: '21:30', idType: 'aadhaar', idNumber: '4521 8890 1234', address: '12 Race Course Road, Coimbatore', purpose: 'Leisure', preferences: 'Twin beds, high floor' })).json()).toEqual({ ok: true })
    const d = (await R.get(`/api/reservations/${BK}`, FD)).json()
    expect(d.onlineCheckin).toMatchObject({ eta: '21:30', id_type: 'aadhaar', id_last4: '1234', preferences: 'Twin beds, high floor' })
    expect((await R.db.query<{ eta: string }>('select eta from reservation where id = $1', [BK]))[0].eta).toBe('21:30')
    const rows = JSON.stringify(await R.db.query('select * from online_checkin')) + JSON.stringify(await R.db.query('select * from guest'))
    expect(rows).not.toContain('88901234')
    const snap = (await R.get('/api/dashboard?from=2026-11-01&to=2026-11-30', FD)).json()
    expect(snap.reservations.find((x: { id: string }) => x.id === BK).online_checkin).toBe(true)
  })
})

describe('deposits by payment link', () => {
  let P: Awaited<ReturnType<typeof testResort>>
  const links: { amountPaise: number; reference: string }[] = []
  const gateway: PaymentProvider = {
    name: 'test',
    async createLink(i) { links.push(i); return { id: `plink_${links.length}`, url: `https://pay.example/${links.length}` } },
    verify: (_raw, sig) => sig === 'good-signature',
    paid: (b) => { const x = b as { event: string; link: string; pay: string; amount: number }; return x.event === 'paid' ? { linkId: x.link, paymentId: x.pay, method: 'upi', amountPaise: x.amount } : null },
  }
  beforeAll(async () => { P = await testResort('2026-11-01', { payments: gateway }) }, 60_000)
  afterAll(() => P.close())
  const book = (name: string) => P.app.inject({ method: 'POST', url: '/public/bookings', payload: { roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-20', departure: '2026-11-21', name, mobile: '9840088888' } })

  it('holds the booking for two hours against a deposit of the first night', async () => {
    const b = (await book('Ravi K')).json()
    expect(b.payment).toMatchObject({ url: 'https://pay.example/1', amountPaise: 441_000 })
    expect(links[0]).toMatchObject({ amountPaise: 441_000, reference: b.reservationId })
    const hook = (body: unknown, sig: string) => P.app.inject({ method: 'POST', url: '/public/payments/webhook', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: JSON.stringify(body) })
    expect((await hook({ event: 'paid', link: 'plink_1', pay: 'pay_9', amount: 441_000 }, 'forged')).statusCode).toBe(401)
    expect((await hook({ event: 'paid', link: 'plink_1', pay: 'pay_9', amount: 441_000 }, 'good-signature')).json()).toEqual({ ok: true })
    expect((await hook({ event: 'paid', link: 'plink_1', pay: 'pay_9', amount: 441_000 }, 'good-signature')).json()).toEqual({ ok: true, duplicate: true })
    const [r] = await P.db.query<{ pay_by: Date | null; status: string }>('select pay_by, status from reservation where id = $1', [b.reservationId])
    expect(r).toEqual({ pay_by: null, status: 'confirmed' })
    const [v] = await P.db.query<{ total_paise: string }>(`select total_paise from tax_document where reservation_id = $1 and doc_type = 'receipt_voucher'`, [b.reservationId])
    expect(Number(v.total_paise)).toBe(441_000)
    const [p] = await P.db.query<{ method: string; received_by: string; reference: string }>('select method, received_by, reference from payment where reference = $1', ['pay_9'])
    expect(p).toEqual({ method: 'upi', received_by: 'system', reference: 'pay_9' })
  })

  it('cancels a booking whose deposit is not paid in time, freeing the room', async () => {
    const b = (await book('No Show')).json()
    P.advance(121)
    await P.app.inject({ url: '/public/availability?arrival=2026-11-20&departure=2026-11-21' })
    const [r] = await P.db.query<{ status: string; cancel_reason: string }>('select status, cancel_reason from reservation where id = $1', [b.reservationId])
    expect(r).toEqual({ status: 'cancelled', cancel_reason: 'Deposit not paid in time (website booking)' })
    const [l] = await P.db.query<{ status: string }>('select status from payment_link where reservation_id = $1', [b.reservationId])
    expect(l.status).toBe('expired')
  })
})

describe('the channel manager', () => {
  const cm = (method: 'GET' | 'POST', url: string, payload?: unknown, key = 'ck-test-123') => pub(method, url, payload, { 'x-channel-key': key })
  const order = { channel: 'booking_com', otaRef: 'BDC-55120', roomCode: 'DLX-BB', arrival: '2026-11-15', departure: '2026-11-17', adults: 2, guest: { name: 'Hans Meyer', email: 'hans@example.de' }, nightly: [520_000, 520_000] }

  it('needs its key, and gets availability and rates with the room codes', async () => {
    expect((await cm('GET', '/channel/ari', undefined, 'wrong')).statusCode).toBe(401)
    expect((await put('/api/channels/maps', GM, { channel: 'booking_com', code: 'DLX-BB', roomTypeId: 'deluxe', plan: 'CP' })).statusCode).toBe(200)
    const ari = (await cm('GET', '/channel/ari?from=2026-11-10&days=3')).json()
    const dlx = ari.roomTypes.find((x: { roomTypeId: string }) => x.roomTypeId === 'deluxe')
    expect(dlx.codes).toEqual([{ channel: 'booking_com', code: 'DLX-BB', plan: 'CP' }])
    expect(dlx.nights.map((x: { date: string; available: number; rates: Record<string, number> }) => [x.date, x.rates.CP])).toEqual([['2026-11-10', 480_000], ['2026-11-11', 480_000], ['2026-11-12', 480_000]])
    expect(dlx.nights[0].available).toBe(23)   // one room went to the website booking
  })

  let first = ''
  it('places OTA bookings at the OTA\'s price, once, and follows changes and cancellations', async () => {
    const a = (await cm('POST', '/channel/bookings', order)).json()
    expect(a.accepted).toBe(true)
    first = a.reservationId
    const [r] = await R.db.query<{ source: string; ota_ref: string; rate_plan_code: string }>('select source, ota_ref, rate_plan_code from reservation where id = $1', [first])
    expect(r).toEqual({ source: 'booking_com', ota_ref: 'BDC-55120', rate_plan_code: 'CP' })
    const nights = await R.db.query<{ amount_paise: string }>('select amount_paise from room_night where reservation_id = $1', [first])
    expect(nights.map((x) => Number(x.amount_paise))).toEqual([520_000, 520_000])
    expect((await cm('POST', '/channel/bookings', order)).json()).toMatchObject({ accepted: true, reservationId: first, duplicate: true })
    const m = (await cm('POST', '/channel/bookings', { ...order, action: 'modify', departure: '2026-11-18', nightly: [520_000, 520_000, 520_000] })).json()
    expect(m).toMatchObject({ accepted: true, replaces: first })
    const [old] = await R.db.query<{ status: string }>('select status from reservation where id = $1', [first])
    expect(old.status).toBe('cancelled')
    expect((await cm('POST', '/channel/bookings', { ...order, action: 'cancel' })).json()).toMatchObject({ accepted: true, reservationId: m.reservationId, cancelled: true })
  })

  it('keeps and flags a booking it cannot place, and an OTA price above ₹7,500', async () => {
    const f = (await cm('POST', '/channel/bookings', { ...order, otaRef: 'BDC-99', roomCode: 'SUITE-XX' })).json()
    expect(f).toMatchObject({ accepted: false })
    expect(f.reason).toMatch(/not mapped/)
    const failed = (await R.get('/api/channels/bookings?status=failed', FD)).json()
    expect(failed.map((x: { ota_ref: string }) => x.ota_ref)).toEqual(['BDC-99'])
    const [al] = await R.db.query<{ action: string }>(`select action from audit_log where action like 'channel.%' order by seq desc limit 1`)
    expect(al.action).toBe('channel.booking_failed')
    expect((await R.post(`/api/channels/bookings/${failed[0].id}/resolve`, FD, { note: 'Booked by hand in a suite' })).statusCode).toBe(200)
    expect((await R.get('/api/channels/bookings?status=failed', FD)).json()).toEqual([])
    await cm('POST', '/channel/bookings', { ...order, otaRef: 'BDC-100', nightly: [800_000, 800_000] })
    const [hi] = await R.db.query<{ action: string }>(`select action from audit_log where action = 'rate.above_limit_from_channel'`)
    expect(hi).toBeTruthy()
  })
})
