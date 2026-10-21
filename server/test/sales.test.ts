import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Sales: a company account with a contact and a contracted rate the desk books at; follow-ups; a wedding's
// room block held off general sale, filled from a rooming list and released at its cut-off; an event's
// decorator billed to the event; an event's bill moved to a company's credit account; the pipeline.

let R: Awaited<ReturnType<typeof testResort>>
let SALES = '', GM = '', FD = '', ACC = ''
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const free = async (from: string, to: string, type = 'deluxe') =>
  ((await R.post('/api/availability', FD, { from, to })).json() as { roomTypeId: string; nights: { night: string; free: number }[] }[]).find((x) => x.roomTypeId === type)!.nights.map((x) => x.free)

beforeAll(async () => {
  R = await testResort('2026-11-01')
  SALES = await R.staff('Divya', '9840003001', ['sales_banquets'])
  GM = await R.staff('Karthik', '9840003002', ['general_manager'])
  FD = await R.staff('Priya', '9840003003', ['reception'])
  ACC = await R.staff('Meena', '9840003004', ['accounts'])
}, 90_000)
afterAll(() => R.close())

let KOVAI = ''
describe('company accounts', () => {
  it('opens an account with a contact; only the GM sets contracted rates, within ₹7,500', async () => {
    const r = await R.post('/api/debtors', SALES, { name: 'Kovai Pumps Ltd', gstin: '33AABCK1234L1ZT', city: 'Coimbatore', ownerId: null, notes: 'Annual sales meet in December' })
    expect(r.statusCode).toBe(201)
    KOVAI = r.json().id
    expect((await R.post(`/api/sales/accounts/${KOVAI}/contacts`, SALES, { name: 'R. Lakshmi', role: 'Admin manager', mobile: '9840011111' })).statusCode).toBe(201)
    const rate = { roomTypeId: 'deluxe', plan: 'CP', validFrom: '2026-11-01', validTo: '2027-03-31', rate: 3900 }
    expect((await R.post(`/api/sales/accounts/${KOVAI}/rates`, SALES, rate)).statusCode).toBe(403)
    expect((await R.post(`/api/sales/accounts/${KOVAI}/rates`, GM, { ...rate, rate: 7800 })).json().error).toMatch(/7,500/)
    expect((await R.post(`/api/sales/accounts/${KOVAI}/rates`, GM, rate)).statusCode).toBe(201)
    expect((await R.post(`/api/sales/accounts/${KOVAI}/rates`, GM, { ...rate, validFrom: '2027-01-01', rate: 4000 })).statusCode).toBe(409)
    expect((await R.post('/api/debtors', SALES, { name: 'Kovai Pumps Ltd' })).statusCode).toBe(409)
    expect((await patch(`/api/debtors/${KOVAI}`, SALES, { creditLimit: 500000 })).statusCode).toBe(403)
  })

  it('books the company\'s guests at the contracted rate and bills the company', async () => {
    const r = (await R.post('/api/reservations', FD, { guest: { name: 'Suresh (Kovai Pumps)', mobile: '9840022222' }, roomTypeId: 'deluxe', plan: 'CP', arrival: '2026-11-10', departure: '2026-11-12', debtorId: KOVAI })).json()
    expect(r.roomTotal).toBe(2 * 390_000)
    const [res] = await R.db.query<{ bill_to_company: string; bill_to_gstin: string; debtor_id: string }>('select bill_to_company, bill_to_gstin, debtor_id from reservation where id = $1', [r.id])
    expect(res).toEqual({ bill_to_company: 'Kovai Pumps Ltd', bill_to_gstin: '33AABCK1234L1ZT', debtor_id: KOVAI })
    // Outside the contract's plan: the rate table.
    expect((await R.post('/api/reservations', FD, { guest: { name: 'Guest 2' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-10', departure: '2026-11-11', debtorId: KOVAI })).json().roomTotal).toBe(420_000)
    const acc = (await R.get(`/api/sales/accounts/${KOVAI}`, SALES)).json()
    expect(acc.contacts.map((c: { name: string }) => c.name)).toEqual(['R. Lakshmi'])
    expect(acc.rates[0]).toMatchObject({ plan_code: 'CP', rate_paise: 390_000, current: true })
    expect(acc.stays.length).toBe(2)
    const list = (await R.get('/api/sales/accounts', SALES)).json()
    expect(list.accounts.find((a: { id: string }) => a.id === KOVAI)).toMatchObject({ nights: 3, roomRevenuePaise: 2 * 390_000 + 420_000, rates: 1 })
  })

  it('keeps follow-ups, and books the next one when one is done', async () => {
    const a = (await R.post('/api/sales/activities', SALES, { debtorId: KOVAI, kind: 'call', subject: 'Confirm December meet dates', dueOn: '2026-11-01' })).json()
    expect((await R.post('/api/sales/activities', SALES, { kind: 'call', subject: 'Nobody' })).statusCode).toBe(400)
    let mine = (await R.get('/api/sales/activities', SALES)).json()
    expect(mine.activities.map((x: { subject: string }) => x.subject)).toEqual(['Confirm December meet dates'])
    expect((await R.get('/api/sales/activities', GM)).json().activities).toEqual([])
    await R.post(`/api/sales/activities/${a.id}/done`, SALES, { outcome: '18–19 Dec, 120 people', next: { kind: 'visit', subject: 'Site visit with the admin team', dueOn: '2026-11-05' } })
    mine = (await R.get('/api/sales/activities', SALES)).json()
    expect(mine.activities.map((x: { subject: string; account: string }) => [x.subject, x.account])).toEqual([['Site visit with the admin team', 'Kovai Pumps Ltd']])
  })
})

describe('a wedding room block', () => {
  let EV = '', BLK = ''
  it('holds rooms off general sale, only when they are free', async () => {
    EV = (await R.post('/api/banquets/events', SALES, { kind: 'wedding', title: 'Ravi and Priya wedding', clientName: 'S. Ravi' })).json().id
    const before = await free('2026-12-11', '2026-12-13')
    expect((await R.post('/api/sales/blocks', SALES, { name: 'Wedding guests', eventId: EV, arrival: '2026-12-11', departure: '2026-12-13', plan: 'CP', lines: [{ roomTypeId: 'deluxe', rooms: 30, rate: 3800 }] })).statusCode).toBe(409)
    const b = (await R.post('/api/sales/blocks', SALES, { name: 'Wedding guests', eventId: EV, arrival: '2026-12-11', departure: '2026-12-13', cutoff: '2026-11-27', plan: 'CP', lines: [{ roomTypeId: 'deluxe', rooms: before[0] - 1, rate: 3800 }] })).json()
    BLK = b.id
    expect(b.number).toMatch(/^BLK\//)
    expect(await free('2026-12-11', '2026-12-13')).toEqual([1, 1])
    expect((await R.post('/api/reservations', FD, { guest: { name: 'Walk-in' }, roomTypeId: 'deluxe', plan: 'CP', arrival: '2026-12-11', departure: '2026-12-12' })).statusCode).toBe(201)
    expect((await R.post('/api/reservations', FD, { guest: { name: 'Another' }, roomTypeId: 'deluxe', plan: 'CP', arrival: '2026-12-11', departure: '2026-12-12' })).statusCode).toBe(409)
  })

  it('books the rooming list at the block rate, line by line', async () => {
    const csv = 'Name,Mobile,Room type,Arrival,Departure,Adults,Requests\nUncle Raman,9840033333,Deluxe Room,,,2,Ground floor\n"Kumar, Meena",9840044444,deluxe,2026-12-12,2026-12-13,2,\nCousin Arun,9840055555,suite,,,2,'
    const r = (await R.post(`/api/sales/blocks/${BLK}/rooming-list`, FD, { csv })).json()
    expect(r.booked.map((x: { name: string }) => x.name)).toEqual(['Uncle Raman', 'Kumar, Meena'])
    expect(r.errors).toMatchObject([{ line: 3, name: 'Cousin Arun' }])
    expect(r.errors[0].error).toMatch(/no suite rooms/)
    const nights = await R.db.query<{ amount_paise: string }>('select rn.amount_paise from room_night rn join reservation r on r.id = rn.reservation_id where r.block_id = $1', [BLK])
    expect(nights.map((x) => Number(x.amount_paise))).toEqual([380_000, 380_000, 380_000])
    const d = (await R.get(`/api/sales/blocks/${BLK}`, SALES)).json()
    expect(d.lines[0].nights.map((x: { picked: number }) => x.picked)).toEqual([1, 2])
    expect(d.stays.length).toBe(2)
    // Picking up from the block leaves general sale as it was.
    expect(await free('2026-12-11', '2026-12-13')).toEqual([0, 1])
    expect((await put(`/api/sales/blocks/${BLK}/lines`, SALES, { lines: [{ roomTypeId: 'deluxe', rooms: 1 }] })).statusCode).toBe(409)
    expect((await put(`/api/sales/blocks/${BLK}/lines`, SALES, { lines: [{ roomTypeId: 'deluxe', rooms: 10 }] })).statusCode).toBe(200)
    expect((await R.get(`/api/banquets/events/${EV}`, SALES)).json().blocks.map((x: { id: string }) => x.id)).toEqual([BLK])
  })

  it('gives back the rooms not picked up once the cut-off passes', async () => {
    const held = await free('2026-12-11', '2026-12-13')
    await R.db.query(`update property set business_date = '2026-11-28'`)
    const list = (await R.get('/api/sales/blocks', SALES)).json()
    expect(list.blocks.find((b: { id: string }) => b.id === BLK).status).toBe('released')
    const after = await free('2026-12-11', '2026-12-13')
    expect(after[0] - held[0]).toBe(9)
    expect((await R.post(`/api/sales/blocks/${BLK}/book`, FD, { name: 'Late guest', roomTypeId: 'deluxe' })).json().error).toMatch(/released/)
    await R.db.query(`update property set business_date = '2026-11-01'`)
  })
})

describe('event suppliers and company billing', () => {
  it('ties a decorator\'s bill to the event and bills the event to the company\'s account within its limit', async () => {
    const ev = (await R.post('/api/banquets/events', SALES, { kind: 'corporate', title: 'Kovai Pumps annual meet', clientName: 'R. Lakshmi', debtorId: KOVAI })).json().id
    let d = (await R.get(`/api/banquets/events/${ev}`, SALES)).json()
    expect(d.client).toMatchObject({ company: 'Kovai Pumps Ltd', gstin: '33AABCK1234L1ZT' })
    expect(d.account.name).toBe('Kovai Pumps Ltd')
    await R.post(`/api/banquets/events/${ev}/functions`, SALES, { name: 'Conference', venueId: 'HALL-JSH', date: '2026-12-18', from: '09:00', to: '17:00', style: 'theatre', expectedPax: 120, menuId: 'PKG-VEG-SILVER' })
    const dec = (await R.post('/api/vendors', ACC, { name: 'Bloom Decorators', pan: 'ABCPB1234D', tdsCode: 'contractor' })).json().id
    expect((await R.post(`/api/banquets/events/${ev}/vendors`, SALES, { vendorId: dec, service: 'Stage and backdrop', agreed: 20000 })).statusCode).toBe(201)
    const q = (await R.post(`/api/banquets/events/${ev}/quote`, SALES, {})).json()
    await R.post(`/api/banquets/quotes/${q.id}/accept`, SALES)
    await R.post(`/api/banquets/events/${ev}/contract`, SALES, {})
    await R.post(`/api/banquets/events/${ev}/payments`, SALES, { method: 'bank', amount: 20000, reference: 'NEFT-KP1' })
    expect((await R.post(`/api/banquets/events/${ev}/payments`, SALES, { method: 'company', amount: 1000 })).json().error).toMatch(/once it is billed/)
    expect((await R.post('/api/bills', ACC, { vendorId: dec, billNo: 'BD-77', billDate: '2026-11-01', eventId: ev, lines: [{ description: 'Stage and backdrop', qty: 1, rate: 20000, gstRate: 18 }] })).statusCode).toBe(201)
    d = (await R.get(`/api/banquets/events/${ev}`, SALES)).json()
    expect(d.vendors[0]).toMatchObject({ vendor: 'Bloom Decorators', agreedPaise: 2_000_000, billedPaise: 2_360_000 })
    expect(d.vendorCostPaise).toBe(2_000_000)

    // The conference is over: guests served and the final bill come after it.
    await R.db.query(`update property set business_date = '2026-12-19'`)
    await R.app.inject({ method: 'PATCH', url: `/api/banquets/functions/${d.functions[0].id}`, headers: { authorization: `Bearer ${SALES}` }, payload: { actualPax: 120 } })
    const bill = (await R.post(`/api/banquets/events/${ev}/bill`, SALES)).json()
    await patch(`/api/debtors/${KOVAI}`, GM, { creditLimit: 50000 })
    expect((await R.post(`/api/banquets/events/${ev}/payments`, SALES, { method: 'company', amount: bill.balancePaise / 100 })).json().error).toMatch(/credit limit/)
    await patch(`/api/debtors/${KOVAI}`, GM, { creditLimit: 500000 })
    expect((await R.post(`/api/banquets/events/${ev}/payments`, SALES, { method: 'company', amount: bill.balancePaise / 100 + 1 })).json().error).toMatch(/is due/)
    expect((await R.post(`/api/banquets/events/${ev}/payments`, SALES, { method: 'company', amount: bill.balancePaise / 100 })).statusCode).toBe(201)
    const st = (await R.get(`/api/debtors/${KOVAI}/statement?from=2026-11-01&to=2026-12-31`, ACC)).json()
    expect(st.lines.map((l: { narration: string; debitPaise: number }) => [l.narration, l.debitPaise])).toContainEqual([`Bill ${bill.number}`, bill.balancePaise])
    const tb = (await R.get('/api/accounts/trial-balance?from=2026-04-01&to=2026-12-31', ACC)).json()
    expect(tb.rows.find((r: { code: string }) => r.code === '1340').closingPaise).toBe(0)
    await R.db.query(`update property set business_date = '2026-11-01'`)
  })

  it('shows the pipeline by stage and why events were lost', async () => {
    const lost = (await R.post('/api/banquets/events', SALES, { kind: 'birthday', title: 'Aadhya turns one', clientName: 'Suresh' })).json().id
    await R.post(`/api/banquets/events/${lost}/lost`, SALES, { reason: 'Price' })
    const p = (await R.get('/api/sales/pipeline', GM)).json()
    expect(p.stages.find((s: { status: string }) => s.status === 'enquiry').count).toBe(1)   // the wedding, not yet quoted
    expect(p).toMatchObject({ wonCount: 1, lostCount: 1, conversion: 50 })
    expect(p.lost).toEqual([{ reason: 'Price', count: 1, valuePaise: 0 }])
    expect(p.followUpsDue).toBe(0)
  })
})
