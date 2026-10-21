import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Booking a banquet event in one step, as sales do on the phone: the event, its functions, the quote, the
// contract and the advance together, with the usual rules: a booked venue is refused before anything is saved,
// a large discount waits for the GM, a hold keeps the dates.

let R: Awaited<ReturnType<typeof testResort>>
let SALES = ''
const wedding = { kind: 'wedding', clientName: 'S. Ravi', clientMobile: '98400 12345', functions: [
  { name: 'Muhurtham', venueId: 'CONV-HALL', date: '2026-12-12', from: '06:00', to: '11:00', style: 'theatre', expectedPax: 800, menuId: 'PKG-VEG-GOLD' },
  { name: 'Reception', venueId: 'LAWN-GRAND', date: '2026-12-12', from: '18:30', to: '23:30', style: 'rounds', expectedPax: 700, menuId: 'PKG-NV-GOLD' }] }

beforeAll(async () => {
  R = await testResort('2026-11-01')
  SALES = await R.staff('Divya', '9840011001', ['sales_banquets'])
}, 60_000)
afterAll(() => R.close())

describe('booking an event in one step', () => {
  it('books the wedding with its advance: quote accepted, contract signed, instalments set', async () => {
    const r = (await R.post('/api/banquets/book', SALES, { ...wedding, advance: { method: 'upi', amount: 200000, reference: 'UTR 55121' } })).json()
    expect(r).toMatchObject({ status: 'definite' })
    const e = (await R.get(`/api/banquets/events/${r.id}`, SALES)).json()
    expect(e.status).toBe('definite')
    expect(e.title).toBe('S. Ravi · wedding')
    expect(e.functions.length).toBe(2)
    expect(e.quotes[0].status).toBe('accepted')
    expect(e.milestones.length).toBe(3)
    expect(e.payments.map((p: { amount_paise: string | number }) => Number(p.amount_paise))).toEqual([20_000_000])
  })

  it('refuses a booked venue before saving anything, and holds or pencils the dates as asked', async () => {
    const before = (await R.db.query<{ n: number }>('select count(*)::int as n from event'))[0].n
    const clash = await R.post('/api/banquets/book', SALES, { clientName: 'Anand', kind: 'conference', functions: [{ name: 'Meeting', venueId: 'CONV-HALL', date: '2026-12-12', from: '09:00', to: '12:00', style: 'theatre', expectedPax: 100 }] })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error).toMatch(/already booked then for S\. Ravi/)
    expect((await R.db.query<{ n: number }>('select count(*)::int as n from event'))[0].n).toBe(before)
    const hold = (await R.post('/api/banquets/book', SALES, { clientName: 'Anand', kind: 'conference', action: 'hold', functions: [{ name: 'Meeting', venueId: 'CONV-HALL', date: '2026-12-14', from: '09:00', to: '12:00', style: 'theatre', expectedPax: 100 }] })).json()
    expect(hold.status).toBe('hold')
    const enq = (await R.post('/api/banquets/book', SALES, { clientName: 'Bala', kind: 'birthday', action: 'enquiry', functions: [{ name: 'Party', venueId: 'CONV-HALL', date: '2026-12-14', from: '10:00', to: '11:00', style: 'rounds', expectedPax: 50 }] })).json()
    expect(enq.status).toBe('enquiry')             // pencilled: may overlap the hold
  })

  it('keeps a large discount waiting for the GM, and a venue too small is refused before anything is saved', async () => {
    const big = (await R.post('/api/banquets/book', SALES, { clientName: 'Chitra', kind: 'wedding', discountPercent: 20, functions: [{ name: 'Reception', venueId: 'LAWN-GARDEN', date: '2026-12-20', from: '18:00', to: '22:00', style: 'rounds', expectedPax: 150, menuId: 'PKG-VEG-GOLD' }] })).json()
    expect(big).toMatchObject({ status: 'quoted' })
    expect(big.note).toMatch(/GM/)
    const tooBig = await R.post('/api/banquets/book', SALES, { clientName: 'Devi', kind: 'wedding', functions: [{ name: 'Reception', venueId: 'PAVILION', date: '2026-12-21', from: '18:00', to: '22:00', style: 'rounds', expectedPax: 900 }] })
    expect(tooBig.statusCode).toBe(400)
    expect(tooBig.json().error).toMatch(/Pavilion seats \d+ in this setup, not 900/)
    expect((await R.db.query<{ n: number }>(`select count(*)::int as n from event where client_name = 'Devi'`))[0].n).toBe(0)
  })
})
