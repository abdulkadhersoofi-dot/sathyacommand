import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// OTAs and tax credits: bookings through MakeMyTrip paid to the OTA, its payout checked booking by booking
// (commission, GST on it, GST TCS, 194-O TDS) and booked; then every credit to claim matched with Form 26AS.

let R: Awaited<ReturnType<typeof testResort>>
let FD = '', NA = '', AC = '', GM = '', BM = ''
let MMT = '', KOVAI = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const bal = async (code: string, party?: string) => (await R.get(`/api/accounts/ledger?code=${code}&from=2026-04-01${party ? `&party=${party}` : ''}`, AC)).json().closingPaise as number

async function otaStay(ref: string, guest: string, room: string) {
  const res = (await R.post('/api/reservations', FD, { guest: { name: guest }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-02', departure: '2026-11-03', source: 'makemytrip', otaRef: ref })).json()
  await R.post(`/api/reservations/${res.id}/check-in`, FD, { spaceId: room, idType: 'aadhaar', idNumber: '1111 2222 3333' })
  return res.id as string
}

beforeAll(async () => {
  R = await testResort('2026-11-02')
  FD = await R.staff('Priya', '9840001101', ['reception'])
  NA = await R.staff('Senthil', '9840001102', ['night_auditor'])
  AC = await R.staff('Meena', '9840001103', ['accounts'])
  GM = await R.staff('Karthik', '9840001104', ['general_manager'])
  BM = await R.staff('Joseph', '9840001105', ['bar_manager'])
  await R.post('/api/cashier/open', FD, { openingFloat: 0 })
}, 60_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM, AC]) await R.get('/api/business-date', t) })

describe('bookings through an OTA', () => {
  const stays: string[] = []
  it('needs the OTA\'s booking ID, and takes "paid to the OTA" only for OTA bookings', async () => {
    expect((await R.post('/api/reservations', FD, { guest: { name: 'X' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-02', departure: '2026-11-03', source: 'makemytrip' })).json().error).toMatch(/MakeMyTrip booking ID/)
    expect((await R.post('/api/reservations', FD, { guest: { name: 'X' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-02', departure: '2026-11-03', source: 'tripadvisor' })).statusCode).toBe(400)
    const direct = (await R.post('/api/reservations', FD, { guest: { name: 'Walk' }, roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-02', departure: '2026-11-03' })).json().id
    const df = (await R.get(`/api/reservations/${direct}`, FD)).json().folios[0].id
    expect((await R.post(`/api/folios/${df}/payments`, FD, { method: 'ota', amount: 100, reference: 'X' })).json().error).toMatch(/not made through an OTA/)
    stays.push(await otaStay('NH7701234', 'Ravi', 'RM-101'), await otaStay('NH7705678', 'Anand', 'RM-102'))
    await R.post('/api/night-audit', NA)
    for (const id of stays) {
      const d = (await R.get(`/api/reservations/${id}`, FD)).json()
      await R.post(`/api/folios/${d.folios[0].id}/payments`, FD, { method: 'ota', amount: d.balance / 100, reference: 'MMT prepaid' })
      await R.post(`/api/reservations/${id}/check-out`, FD)
    }
    await R.post('/api/night-audit', NA)
    const ota = (await R.get('/api/ota', AC)).json().otas
    expect(ota).toEqual([expect.objectContaining({ name: 'MakeMyTrip', owedPaise: 882000, unsettledBookings: 2 })])
    MMT = ota[0].id
    expect(await bal('1320', MMT)).toBe(882000)
  })
})

describe('the OTA\'s payout', () => {
  const report = `MakeMyTrip settlement report,,,,,,,,
Booking ID,Guest Name,Check-in,Booking Amount,Commission,GST on Commission,TCS,TDS,Net Payable
NH7701234,Ravi,02-Nov-2026,"4,410.00",661.50,119.07,21.00,4.20,3604.23
NH7705678,Anand,02-Nov-2026,"4,410.00",700.00,126.00,21.00,4.20,3558.80
,,,,,,,,
Total,,,"8,820.00",,,,,7163.03`

  it('checks each booking against what the guest paid and the agreed rates, and books it', async () => {
    await patch(`/api/ota/${MMT}`, AC, { commissionPercent: 15, tan: 'MUMM12345A' })
    expect((await R.post('/api/ota/payouts', AC, { debtorId: MMT, csv: report, reference: 'UTR55501', net: 7000 })).json().error).toMatch(/come to ₹7,163.03 net/)
    const r = (await R.post('/api/ota/payouts', AC, { debtorId: MMT, csv: report, reference: 'UTR55501', commissionInvoice: 'MMT/INV/889', net: 7163.03 })).json()
    expect(r).toMatchObject({ number: 'OTP/26-27/000001', grossPaise: 882000, netPaise: 716303 })
    expect(r.checks).toEqual(['NH7705678: commission ₹700, 15% agreed is ₹661.5.'])
    expect(await bal('1320', MMT)).toBe(0)
    expect(await bal('6040')).toBe(136150)
    expect(await bal('1500') + await bal('1501')).toBe(24507)
    expect(await bal('1522')).toBe(4200)
    expect(await bal('1520')).toBe(840)
    expect(await bal('1200')).toBe(716303)
    expect((await R.get('/api/ota', AC)).json().otas[0]).toMatchObject({ owedPaise: 0, unsettledBookings: 0 })
  })

  it('flags a booking settled twice or not found', async () => {
    const r = (await R.post('/api/ota/payouts', AC, { debtorId: MMT, reference: 'UTR55502', lines: [{ otaRef: 'NH7701234', gross: 100 }, { otaRef: 'NH0000000', gross: 50 }] })).json()
    expect(r.checks).toEqual(['NH7701234: already settled by an earlier payout.', 'NH0000000: no booking through MakeMyTrip with this ID was paid by the OTA.'])
  })
})

describe('tax credits', () => {
  it('lists every credit to claim and matches Form 26AS by TAN or name, quarter by quarter', async () => {
    KOVAI = (await R.post('/api/debtors', AC, { name: 'Kovai Textiles Pvt Ltd', tan: 'CHEK12345B' })).json().id
    await R.post('/api/ar-receipts', AC, { debtorId: KOVAI, amount: 5000, tds: 500, tdsSection: '194C', mode: 'bank', reference: 'UTR1' })
    await R.post('/api/bar/purchases', BM, { supplier: 'TASMAC', invoiceNo: 'TSM/1', invoiceDate: '2026-11-02', vat: 0, permitNo: 'TP/1', lines: [{ brandId: 'BR-BEER650', bottles: 24, cost: 150 }] })
    const tds = `Name of Deductor,TAN of Deductor,Section,Transaction Date,Amount Paid / Credited,Tax Deducted
MAKEMYTRIP (INDIA) PVT. LTD.,MUMM12345A,194O,15-Nov-2026,8820.00,8.40
KOVAI TEXTILES PRIVATE LIMITED,CHEK12345B,194C,10-Nov-2026,5000.00,3.00
SOME OTHER CO LTD,ABCD12345E,194J,12-Nov-2026,1000.00,100.00`
    const tcs = `Name of Collector^TAN of Collector^Section^Transaction Date^Amount Paid/Debited^Tax Collected
TAMIL NADU STATE MARKETING CORPN LTD^CHET00001A^206C^03-Nov-2026^3600.00^36.00`
    expect((await R.post('/api/form26as/import', AC, { csv: tds, fy: '2026-27', fileName: '26AS-partA.csv' })).json()).toMatchObject({ added: 3 })
    expect((await R.post('/api/form26as/import', AC, { csv: tcs, fy: '2026-27' })).json()).toMatchObject({ added: 1 })
    expect((await R.post('/api/form26as/import', AC, { csv: tds, fy: '2026-27' })).json()).toMatchObject({ added: 0, duplicates: 3 })
    const c = (await R.get('/api/tax-credits?fy=2026-27', AC)).json()
    const by = (p: string) => c.rows.find((r: { party: string }) => r.party === p)
    expect(by('MakeMyTrip')).toMatchObject({ kind: 'tds', quarter: 3, expectedPaise: 840, in26asPaise: 840, status: 'matched' })
    expect(by('Kovai Textiles Pvt Ltd')).toMatchObject({ expectedPaise: 50000, in26asPaise: 300, status: 'short', followUp: false })
    expect(by('TASMAC')).toMatchObject({ kind: 'tcs', expectedPaise: 3600, in26asPaise: 3600, status: 'matched' })
    expect(c.notInBooks.map((l: { deductor: string }) => l.deductor)).toEqual(['SOME OTHER CO LTD'])
    expect(c.gstTcs).toEqual([expect.objectContaining({ party: 'MakeMyTrip', tax: 4200 })])
    // Once the deductors' returns are due, a credit still short is to be followed up.
    await R.db.query(`update property set business_date = '2027-03-01'`)
    expect((await R.get('/api/tax-credits?fy=2026-27', AC)).json().rows.find((r: { party: string }) => r.party === 'Kovai Textiles Pvt Ltd').followUp).toBe(true)
  })
})
