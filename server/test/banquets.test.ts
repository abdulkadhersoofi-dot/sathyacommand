import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// A wedding end to end: enquiry, a clash with another event, a quote with a discount the GM approves, a hold,
// the contract, advances (cash capped at ₹2 lakh for the event), the event order to every department, guests
// served above the guarantee, the final bill, the balance and feedback; then a cancellation and a lost enquiry.

let R: Awaited<ReturnType<typeof testResort>>
let SALES = '', GM = '', CHEF = '', GUARD = '', ACC = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })

beforeAll(async () => {
  R = await testResort('2026-11-01')
  SALES = await R.staff('Divya', '9840002001', ['sales_banquets'])
  GM = await R.staff('Karthik', '9840002002', ['general_manager'])
  CHEF = await R.staff('Murugan', '9840002003', ['chef'])
  GUARD = await R.staff('Selvam', '9840002004', ['security'])
  ACC = await R.staff('Meena', '9840002005', ['accounts'])
}, 90_000)
afterAll(() => R.close())

describe('a wedding from enquiry to final bill', () => {
  let EV = '', OTHER = '', MUH = '', REC = '', quote = '', total = 0

  it('lists venues with setups, rentals and packages', async () => {
    const v = (await R.get('/api/banquets/venues', SALES)).json()
    const hall = v.find((x: { id: string }) => x.id === 'CONV-HALL')
    expect(hall).toMatchObject({ kind: 'hall', rental_paise: 7_500_000, turnaround_minutes: 180 })
    expect(hall.setups.theatre).toBe(1000)
    const p = (await R.get('/api/banquets/packages', SALES)).json()
    expect(p.map((x: { id: string }) => x.id)).toContain('PKG-VEG-GOLD')
    expect((await R.get('/api/banquets/venues', CHEF)).statusCode).toBe(200)
    expect((await R.get('/api/banquets/events', CHEF)).statusCode).toBe(403)
  })

  it('takes an enquiry with two functions and a decor package', async () => {
    const r = await R.post('/api/banquets/events', SALES, { kind: 'wedding', title: 'Ravi and Priya wedding', clientName: 'S. Ravi', clientMobile: '98400 12345', source: 'referral', expectedPax: 800 })
    expect(r.statusCode).toBe(201)
    EV = r.json().id
    expect(r.json().number).toMatch(/^EV\/26-27\/0+1$/)
    const m = await R.post(`/api/banquets/events/${EV}/functions`, SALES, { name: 'Muhurtham', venueId: 'CONV-HALL', date: '2026-12-12', from: '06:00', to: '11:00', style: 'theatre', expectedPax: 800, menuId: 'PKG-VEG-GOLD' })
    expect(m.statusCode).toBe(201)
    MUH = m.json().id
    const rec = await R.post(`/api/banquets/events/${EV}/functions`, SALES, { name: 'Reception', venueId: 'LAWN-GRAND', date: '2026-12-12', from: '18:30', to: '23:30', style: 'rounds', expectedPax: 700, menuId: 'PKG-NV-GOLD' })
    REC = rec.json().id
    expect((await R.post(`/api/banquets/events/${EV}/functions`, SALES, { name: 'Too big', venueId: 'PAVILION', date: '2026-12-13', from: '10:00', to: '12:00', style: 'rounds', expectedPax: 500 })).json().error).toMatch(/seats/)
    expect((await R.post(`/api/banquets/events/${EV}/items`, SALES, { packageId: 'PKG-DECOR-STD', functionId: REC })).statusCode).toBe(201)
    expect((await R.post(`/api/banquets/events/${EV}/items`, SALES, { description: 'Nadaswaram troupe', qty: 1, rate: 18000, gstKind: 'other', functionId: MUH })).statusCode).toBe(201)
    const d = (await R.get(`/api/banquets/events/${EV}`, SALES)).json()
    expect(d.status).toBe('enquiry')
    expect(d.checks.map((c: { item: string }) => c.item).sort()).toEqual(['fire', 'liquor', 'music_licence', 'police'])
    // Hall 75,000 + lawn 60,000 at 18%; 800 × 900 and 700 × 1,150 at 5%; decor 45,000 and nadaswaram 18,000 at 18%.
    const byRate = (r: number) => d.priced.lines.filter((l: { gstRate: number }) => l.gstRate === r).reduce((a: number, l: { taxable: number }) => a + l.taxable, 0)
    expect(byRate(18)).toBe((75_000 + 60_000 + 45_000 + 18_000) * 100)
    expect(byRate(5)).toBe((800 * 900 + 700 * 1150) * 100)
  })

  it('shows another enquiry for the same hall as pencilled, and only one can hold it', async () => {
    const o = await R.post('/api/banquets/events', SALES, { kind: 'corporate', title: 'Annual sales meet', clientName: 'K. Anand', company: 'Kovai Pumps Ltd' })
    OTHER = o.json().id
    // Ends at 08:00, within the hall's three-hour turnaround of the muhurtham.
    const f = await R.post(`/api/banquets/events/${OTHER}/functions`, SALES, { name: 'Conference', venueId: 'CONV-HALL', date: '2026-12-12', from: '13:00', to: '18:00', style: 'theatre', expectedPax: 300 })
    expect(f.json().clashes).toMatchObject([{ eventId: EV, firm: false }])
    const check = (await R.post('/api/banquets/check', SALES, { venueId: 'CONV-HALL', date: '2026-12-12', from: '13:30', to: '14:00' })).json()
    expect(check.clashes.length).toBe(2)
    const cal = (await R.get('/api/banquets/calendar?from=2026-12-10&to=2026-12-14', CHEF)).json()
    expect(cal.bookings.filter((b: { venueId: string }) => b.venueId === 'CONV-HALL').length).toBe(2)
    await R.post(`/api/banquets/events/${OTHER}/quote`, SALES, {})
    expect((await R.post(`/api/banquets/events/${OTHER}/hold`, SALES, {})).json().holdUntil).toBe('2026-11-08')
    expect((await R.post(`/api/banquets/events/${OTHER}/hold`, SALES, { days: 10 })).statusCode).toBe(403)   // sales hold up to 7 days
  })

  it('sends a discount above the sales limit to the GM, then the client accepts', async () => {
    const q = (await R.post(`/api/banquets/events/${EV}/quote`, SALES, { discountPercent: 12 })).json()
    expect(q.status).toBe('awaiting_approval')
    expect((await R.post(`/api/banquets/quotes/${q.id}/accept`, SALES)).json().error).toMatch(/approval/)
    expect((await R.post(`/api/approvals/${q.approvalId}/decide`, GM, { decision: 'approve' })).statusCode).toBe(200)
    expect((await R.post(`/api/banquets/quotes/${q.id}/accept`, SALES)).statusCode).toBe(200)
    quote = q.id; total = q.totalPaise
    const print = await R.get(`/api/banquets/quotes/${quote}/print`, SALES)
    expect(print.body).toContain('Ravi and Priya wedding')
    expect(print.body).toContain('after 12% discount')
  })

  it('cannot hold or sign while another event holds the hall; signs once it is released', async () => {
    expect((await R.post(`/api/banquets/events/${EV}/hold`, SALES, {})).statusCode).toBe(409)
    expect((await R.post(`/api/banquets/events/${EV}/contract`, SALES, {})).statusCode).toBe(409)
    expect((await R.post(`/api/banquets/events/${OTHER}/release`, SALES)).statusCode).toBe(200)
    expect((await R.post(`/api/banquets/events/${EV}/contract`, SALES, { milestones: [{ label: 'On signing', dueOn: '2026-11-01', amount: 1 }] })).json().error).toMatch(/add up/)
    expect((await R.post(`/api/banquets/events/${EV}/contract`, SALES, {})).statusCode).toBe(200)
    const d = (await R.get(`/api/banquets/events/${EV}`, SALES)).json()
    expect(d.status).toBe('definite')
    expect(d.contractSignedOn).toBe('2026-11-01')
    expect(d.milestones.map((m: { label: string }) => m.label)).toEqual(['On signing', '30 days before', '7 days before'])
    expect(d.milestones.map((m: { dueOn: string }) => m.dueOn)).toEqual(['2026-11-01', '2026-11-12', '2026-12-05'])
    expect(d.milestones.reduce((a: number, m: { amountPaise: number }) => a + m.amountPaise, 0)).toBe(total)
    // The other event cannot now hold the hall.
    expect((await R.post(`/api/banquets/events/${OTHER}/hold`, SALES, {})).statusCode).toBe(409)
  })

  it('takes advances on GST receipt vouchers, with cash under ₹2 lakh for the whole event', async () => {
    expect((await R.post(`/api/banquets/events/${EV}/payments`, SALES, { method: 'cash', amount: 200000 })).statusCode).toBe(403)
    const cash = (await R.post(`/api/banquets/events/${EV}/payments`, SALES, { method: 'cash', amount: 150000 })).json()
    expect(cash.kind).toBe('advance')
    expect((await R.post(`/api/banquets/events/${EV}/payments`, SALES, { method: 'cash', amount: 60000 })).statusCode).toBe(403)
    expect((await R.post(`/api/banquets/events/${EV}/payments`, SALES, { method: 'upi', amount: 500000 })).json().error).toMatch(/reference/)
    expect((await R.post(`/api/banquets/events/${EV}/payments`, SALES, { method: 'upi', amount: 500000, reference: 'UTR6123' })).statusCode).toBe(201)
    const [v] = await R.db.query<{ lines: { gstRate: number; total: number; taxable: number; cgst: number; sgst: number }[]; total_paise: string; event_id: string }>(
      `select lines, total_paise, event_id from tax_document where id = $1`, [cash.voucher.id])
    expect(v.event_id).toBe(EV)
    expect(v.lines.map((l) => l.gstRate).sort()).toEqual([18, 18, 5])   // venue, services, food
    expect(v.lines.reduce((a, l) => a + l.total, 0)).toBe(15_000_000)
    for (const l of v.lines) expect(l.taxable + l.cgst + l.sgst).toBe(l.total)
  })

  it('sends the event order to every department; each acknowledges its own sheet, and a change makes a new revision', async () => {
    const r = (await R.post(`/api/banquets/events/${EV}/beo`, SALES)).json()
    expect(r.revision).toBe(1)
    expect(r.permissionsOpen.length).toBe(4)
    expect((await R.post(`/api/banquets/events/${EV}/beo`, SALES)).json().error).toMatch(/Nothing has changed/)
    const k = (await R.get('/api/banquets/beo', CHEF)).json()
    expect(k.depts.map((d: { id: string }) => d.id)).toEqual(['kitchen'])
    const muh = k.orders[0].beo.functions[0]
    expect(muh).toMatchObject({ name: 'Muhurtham', pax: 800, plates: 840, seating: { chairs: 800, tables: 0 } })
    expect((await R.post(`/api/banquets/events/${EV}/beo/1/ack`, CHEF, { dept: 'security' })).statusCode).toBe(403)
    expect((await R.post(`/api/banquets/events/${EV}/beo/1/ack`, CHEF, { dept: 'kitchen' })).statusCode).toBe(200)
    expect((await R.post(`/api/banquets/events/${EV}/beo/1/ack`, GUARD, { dept: 'security' })).statusCode).toBe(200)
    const [b] = await R.db.query<{ text: string; roles: string[] }>(`select text, roles from broadcast order by at desc limit 1`)
    expect(b.text).toMatch(/Event order EV/)
    expect(b.roles).toContain('chef')

    await patch(`/api/banquets/functions/${MUH}`, SALES, { guaranteedPax: 750 })
    await patch(`/api/banquets/events/${EV}`, SALES, { instructions: { engineering: 'DG on standby from 05:00; two extra spot lights on the mandap' } })
    expect((await R.get(`/api/banquets/events/${EV}`, SALES)).json().beo.changed).toBe(true)
    expect((await R.post(`/api/banquets/events/${EV}/beo`, SALES)).json().revision).toBe(2)
    expect((await R.post(`/api/banquets/events/${EV}/beo/1/ack`, CHEF, { dept: 'kitchen' })).statusCode).toBe(409)
    const k2 = (await R.get('/api/banquets/beo', CHEF)).json()
    expect(k2.orders[0]).toMatchObject({ revision: 2, acks: {} })
    expect(k2.orders[0].beo.instructions.engineering).toMatch(/DG on standby/)
  })

  it('records permissions as they come in', async () => {
    expect((await put(`/api/banquets/events/${EV}/checks/police`, SALES, { status: 'received' })).statusCode).toBe(400)
    expect((await put(`/api/banquets/events/${EV}/checks/police`, SALES, { status: 'received', ref: 'CBE/PS/2211' })).statusCode).toBe(200)
    expect((await put(`/api/banquets/events/${EV}/checks/liquor`, SALES, { status: 'not_needed' })).statusCode).toBe(200)
  })

  it('bills plates served above the guarantee, takes in the advances, then the balance and feedback close it', async () => {
    expect((await R.post(`/api/banquets/events/${EV}/bill`, ACC)).json().error).toMatch(/guests served/)
    await patch(`/api/banquets/functions/${MUH}`, ACC, { actualPax: 780 })
    await patch(`/api/banquets/functions/${REC}`, ACC, { actualPax: 690 })
    const bill = (await R.post(`/api/banquets/events/${EV}/bill`, ACC)).json()
    const [inv] = await R.db.query<{ lines: { description: string; qty: number; taxable: number; gstRate: number; kind: string }[]; advance_adjusted_paise: string; total_paise: string }>(
      'select lines, advance_adjusted_paise, total_paise from tax_document where id = $1', [bill.id])
    const extra = inv.lines.find((l) => l.description.startsWith('Extra plates'))!
    expect(extra).toMatchObject({ qty: 30, gstRate: 5, kind: 'catering', taxable: Math.round(30 * 90_000 * 0.88) })
    // The reception served under its guarantee: billed at the guarantee.
    expect(inv.lines.find((l) => l.description.startsWith('Gold non-vegetarian'))!.qty).toBe(700)
    expect(Number(inv.advance_adjusted_paise)).toBe(65_000_000)
    expect(bill.balancePaise).toBe(Number(inv.total_paise) - 65_000_000)

    expect((await R.post(`/api/banquets/events/${EV}/feedback`, SALES, { score: 2 })).json().error).toMatch(/still due/)
    expect((await R.post(`/api/banquets/events/${EV}/payments`, ACC, { method: 'bank', amount: bill.balancePaise / 100, reference: 'NEFT-99812' })).json().kind).toBe('settlement')
    expect((await R.post(`/api/banquets/events/${EV}/feedback`, SALES, { score: 2, note: 'Reception food ran late' })).statusCode).toBe(200)
    const [a] = await R.db.query<{ action: string }>(`select action from audit_log where entity_id = $1 order by seq desc limit 1`, [EV])
    expect(a.action).toBe('event.feedback_low')
  })

  it('books it all: banquet revenue by kind, GST on advances taken back, the event ledger at nil', async () => {
    const tbr = await R.get('/api/accounts/trial-balance?from=2026-04-01&to=2026-11-30', ACC)
    const tb = tbr.json()
    const row = (code: string) => tb.rows.find((r: { code: string }) => r.code === code)
    expect(row('1340').closingPaise).toBe(0)
    expect(row('1510')?.closingPaise ?? 0).toBe(0)
    expect(-row('4300').closingPaise).toBe(Math.round(135_000_00 * 0.88))
    expect(row('4310').closingPaise).toBeLessThan(0)
    expect(row('4320').closingPaise).toBeLessThan(0)
    expect(tb.totals.debitPaise).toBe(tb.totals.creditPaise)
    const g = (await R.get('/api/gst/2026-11', ACC)).json()
    expect(g.gstr1.b2cs.map((r: { rate: number }) => r.rate)).toEqual([5, 18])
  })
})

describe('cancellations and lost enquiries', () => {
  it('refunds part of the advance on a refund voucher and invoices what is kept', async () => {
    const id = (await R.post('/api/banquets/events', SALES, { kind: 'engagement', title: 'Arun and Kavya engagement', clientName: 'Arun' })).json().id
    await R.post(`/api/banquets/events/${id}/functions`, SALES, { name: 'Engagement', venueId: 'HALL-JSH', date: '2026-12-20', from: '10:00', to: '14:00', style: 'rounds', expectedPax: 300, menuId: 'PKG-VEG-SILVER' })
    const q = (await R.post(`/api/banquets/events/${id}/quote`, SALES, {})).json()
    await R.post(`/api/banquets/quotes/${q.id}/accept`, SALES)
    await R.post(`/api/banquets/events/${id}/contract`, SALES, {})
    await R.post(`/api/banquets/events/${id}/payments`, SALES, { method: 'upi', amount: 100000, reference: 'UTR777' })
    expect((await R.post(`/api/banquets/events/${id}/lost`, SALES, { reason: 'Changed plans' })).statusCode).toBe(409)
    const c = (await R.post(`/api/banquets/events/${id}/cancel`, SALES, { reason: 'Family bereavement', refund: 60000, method: 'bank', reference: 'NEFT-1' })).json()
    expect(c).toMatchObject({ refundPaise: 6_000_000, retainedPaise: 4_000_000 })
    const docs = await R.db.query<{ doc_type: string; total_paise: string; advance_adjusted_paise: string }>(`select doc_type, total_paise, advance_adjusted_paise from tax_document where event_id = $1 order by issued_at`, [id])
    expect(docs.map((d) => [d.doc_type, Number(d.total_paise)])).toEqual([['receipt_voucher', 10_000_000], ['refund_voucher', 6_000_000], ['invoice', 4_000_000]])
    const d = (await R.get(`/api/banquets/events/${id}`, SALES)).json()
    expect(d.status).toBe('cancelled')
    expect(d.invoice.balancePaise).toBe(0)
    // The hall is free again.
    expect((await R.get('/api/banquets/calendar?from=2026-12-20&to=2026-12-20', SALES)).json().bookings).toEqual([])
  })

  it('marks an enquiry lost with the reason', async () => {
    const id = (await R.post('/api/banquets/events', SALES, { kind: 'birthday', title: 'Aadhya turns one', clientName: 'Suresh' })).json().id
    expect((await R.post(`/api/banquets/events/${id}/lost`, SALES, {})).statusCode).toBe(400)
    expect((await R.post(`/api/banquets/events/${id}/lost`, SALES, { reason: 'Price', lostTo: 'Residency Towers' })).statusCode).toBe(200)
    const list = (await R.get('/api/banquets/events?status=lost', GM)).json()
    expect(list.map((e: { id: string; lostReason: string }) => [e.id, e.lostReason])).toEqual([[id, 'Price']])
  })
})
