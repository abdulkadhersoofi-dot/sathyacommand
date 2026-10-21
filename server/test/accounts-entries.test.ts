import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// The everyday entries accounts make by hand: opening balances on the day the books start, an expense paid
// from the bank, money received, cash deposited, each reversible but never edited.

let R: Awaited<ReturnType<typeof testResort>>
let ACC = ''
const bal = async (code: string) => Number((await R.db.query<{ b: string | null }>('select sum(debit_paise - credit_paise) as b from voucher_line where account_code = $1', [code]))[0].b ?? 0)

beforeAll(async () => {
  R = await testResort('2026-11-01')
  ACC = await R.staff('Meena', '9840010001', ['accounts'])
}, 60_000)
afterAll(() => R.close())

describe('opening balances', () => {
  it('posts what the resort held, the difference to the owners\' opening balance, once per date', async () => {
    expect((await R.post('/api/accounts/opening', ACC, { date: '2026-10-01', lines: [{ code: '6100', debit: 100 }] })).json().error).toMatch(/income or expense/)
    const v = (await R.post('/api/accounts/opening', ACC, { date: '2026-10-01', lines: [{ code: '1100', debit: 25000 }, { code: '1200', debit: 1500000 }, { code: '2100', credit: 300000 }] })).json()
    expect(v.number).toMatch(/^JV\//)
    expect([await bal('1100'), await bal('1200'), await bal('2100'), await bal('3200')]).toEqual([2_500_000, 150_000_000, -30_000_000, -122_500_000])
    expect((await R.post('/api/accounts/opening', ACC, { date: '2026-10-01', lines: [{ code: '1100', debit: 1 }] })).json().error).toMatch(/already posted/)
    expect((await R.post(`/api/accounts/vouchers/${v.id}/reverse`, ACC, { reason: 'Bank figure was wrong' })).statusCode).toBe(201)
    expect((await R.post('/api/accounts/opening', ACC, { date: '2026-10-01', lines: [{ code: '1100', debit: 25000 }, { code: '1200', debit: 1450000 }] })).statusCode).toBe(201)
    expect(await bal('1200')).toBe(145_000_000)
    expect((await R.get('/api/setup-status', R.md)).json().steps.find((s: { key: string }) => s.key === 'opening').done).toBe(true)
  })
})

describe('payments, receipts and cash to bank', () => {
  it('pays an expense from the bank into a department, takes money in, and deposits cash', async () => {
    expect((await R.post('/api/accounts/entries', ACC, { kind: 'payment', money: '6100', account: '6000', amount: 100, narration: 'x' })).json().error).toMatch(/cash or bank/)
    expect((await R.post('/api/accounts/entries', ACC, { kind: 'payment', money: '1200', account: '6000', amount: 100 })).json().error).toMatch(/What was paid for/)
    const p = (await R.post('/api/accounts/entries', ACC, { kind: 'payment', money: '1200', account: '6000', amount: 8500, dept: 'maintenance', partyName: 'Kumar Electricals', reference: 'NEFT 7712', narration: 'Generator service' })).json()
    expect(p.number).toMatch(/^PY\//)
    const [line] = await R.db.query<{ dept: string }>(`select l.dept from voucher_line l where l.voucher_id = $1 and l.account_code = '6000'`, [p.id])
    expect(line.dept).toBe('maintenance')
    expect((await R.post('/api/accounts/entries', ACC, { kind: 'receipt', money: '1100', account: '4900', amount: 2000, narration: 'Scrap sold' })).json().number).toMatch(/^RC\//)
    expect((await R.post('/api/accounts/entries', ACC, { kind: 'contra', money: '1100', to: '6000', amount: 1000, narration: 'Deposit' })).json().error).toMatch(/one cash or bank account to another/)
    expect((await R.post('/api/accounts/entries', ACC, { kind: 'contra', money: '1100', to: '1200', amount: 20000, narration: 'Cash deposited' })).json().number).toMatch(/^CO\//)
    expect([await bal('1100'), await bal('1200'), await bal('6000'), await bal('4900')]).toEqual([2_500_000 + 200_000 - 2_000_000, 145_000_000 - 850_000 + 2_000_000, 850_000, -200_000])
    expect((await R.post(`/api/accounts/vouchers/${p.id}/reverse`, ACC, { reason: 'Paid twice' })).statusCode).toBe(201)
    expect(await bal('6000')).toBe(0)
  })
})
