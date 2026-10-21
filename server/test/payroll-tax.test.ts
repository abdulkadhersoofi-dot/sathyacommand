import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Salary tax, advances, settlements and the parallel run, worked by hand for September 2026 (the system
// taking over mid-year: April–August paid outside it). A manager on ₹1,20,000 a month pays tax under the new
// regime; a room attendant takes a salary advance, then leaves and is settled.

let R: Awaited<ReturnType<typeof testResort>>
let HR = '', GM = '', ACC = '', MGR_LOGIN = '', RUN = '', ADV = '', FNF = ''
const E: Record<string, string> = {}
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const line = async (code: string) => (await R.get(`/api/payroll/runs/${RUN}`, HR)).json().lines.find((l: { code: string }) => l.code === code)

beforeAll(async () => {
  R = await testResort('2026-10-02')
  HR = await R.staff('Revathi', '9840008001', ['hr_payroll'])
  GM = await R.staff('Karthik', '9840008002', ['general_manager'])
  ACC = await R.staff('Meena', '9840008003', ['accounts'])
  MGR_LOGIN = await R.staff('Arun', '9840008004', ['front_office_manager'])
  const add = async (key: string, b: Record<string, unknown>, pay: Record<string, unknown>) => {
    E[key] = (await R.post('/api/hr/employees', HR, b)).json().id
    expect((await put(`/api/hr/employees/${E[key]}/salary`, HR, { effectiveFrom: b.joinedOn, ...pay })).statusCode).toBe(200)
  }
  await add('M', { name: 'Arun K', department: 'front_office', designation: 'Front office manager', joinedOn: '2024-01-01', pan: 'ABCPK1234L', uan: '100200300500', bankAccount: '423456789012', ifsc: 'SBIN0001234' }, { basic: 60000, hra: 30000, special: 30000 })
  await add('A', { name: 'Lakshmi M', department: 'housekeeping', designation: 'Room attendant', joinedOn: '2025-06-10', pan: 'ABCPL1234K', uan: '100200300400', esicIp: '3100123456', bankAccount: '123456789012', ifsc: 'SBIN0001234' }, { basic: 9000, hra: 4000, special: 3000 })
  await patch(`/api/hr/employees/${E.M}`, HR, { userId: (await R.get('/auth/me', MGR_LOGIN)).json().id })
}, 120_000)
afterAll(() => R.close())

describe('income tax on salaries', () => {
  it('takes the pay before the system and declarations, and deducts the rest of the year\'s tax over the months left', async () => {
    // April to August paid outside the system: ₹6,00,000 with ₹36,725 deducted.
    expect((await put(`/api/payroll/declarations/${E.M}`, MGR_LOGIN, { fy: '2026-27', regime: 'new', previousIncome: 600000, previousTds: 36725, proofsChecked: true })).statusCode).toBe(200)
    const [d] = await R.db.query<{ proofs_checked: boolean }>('select proofs_checked from tax_declaration where employee_id = $1', [E.M])
    expect(d.proofs_checked).toBe(false)                          // only HR marks the proofs checked
    RUN = (await R.post('/api/payroll/runs', HR, { month: '2026-09' })).json().id
    const m = await line('E0001')
    // ₹14,40,000 for the year less ₹75,000 = ₹13,65,000: ₹20,000 + ₹40,000 + ₹24,750 = ₹84,750, plus 4% cess = ₹88,140.
    expect(m.tds_detail).toMatchObject({ regime: 'new', gross: 144_000_000, taxable: 136_500_000, tax: 8_475_000, rebate: 0, cess: 339_000, annualTax: 8_814_000, tdsSoFar: 3_672_500, monthsLeft: 7 })
    expect(m).toMatchObject({ tds_paise: 734_500, pf_employee_paise: 180_000, pt_paise: 125_000, net_paise: 12_000_000 - 180_000 - 125_000 - 734_500 })
    expect((await line('E0002')).tds_paise).toBe(0)               // within the new regime's rebate
  })

  it('shows what the old regime would cost with rent and investments, and lets HR check the proofs', async () => {
    expect((await put(`/api/payroll/declarations/${E.M}`, HR, { fy: '2026-27', regime: 'new', rent: 20000, sec80c: 200000, sec80d: 25000, previousIncome: 600000, previousTds: 36725, proofsChecked: true })).statusCode).toBe(200)
    expect((await put(`/api/payroll/declarations/${E.M}`, MGR_LOGIN, { fy: '2026-27', regime: 'old' })).json().error).toMatch(/HR has checked/)
    const d = (await R.get(`/api/payroll/declarations/${E.M}`, MGR_LOGIN)).json()
    // Old: ₹14,40,000 − ₹50,000 − HRA ₹98,000 (rent ₹1,40,000 less a tenth of ₹4,20,000) − PT ₹2,500 − 80C ₹1,50,000 − 80D ₹25,000 = ₹11,14,500:
    // ₹12,500 + ₹1,00,000 + ₹34,350 = ₹1,46,850, plus cess ₹5,874.
    expect(d.compare).toEqual({ new: 8_814_000, old: 15_272_400 })
  })
})

describe('salary advances', () => {
  it('needs the GM above HR\'s limit, is paid by accounts and recovered in instalments', async () => {
    expect((await R.post('/api/payroll/advances', HR, { employeeId: E.A, kind: 'advance', amount: 15000, instalment: 9000, reason: 'Child\'s school fees' })).json().error).toMatch(/half the monthly pay/)
    const a = (await R.post('/api/payroll/advances', HR, { employeeId: E.A, kind: 'advance', amount: 15000, instalment: 5000, reason: 'Child\'s school fees' })).json()
    expect(a.status).toBe('pending')                               // above HR's ₹10,000
    ADV = a.id
    expect((await R.post(`/api/payroll/advances/${ADV}/issue`, ACC, { issuedOn: '2026-09-05' })).json().error).toMatch(/waiting for the GM/)
    expect((await R.post(`/api/payroll/advances/${ADV}/decide`, GM, { decision: 'approve' })).statusCode).toBe(200)
    expect((await R.post(`/api/payroll/advances/${ADV}/issue`, ACC, { issuedOn: '2026-09-05', reference: 'NEFT 991' })).statusCode).toBe(200)
    expect((await R.post(`/api/payroll/runs/${RUN}/recalculate`, HR)).statusCode).toBe(200)
    expect(await line('E0002')).toMatchObject({ advance_recovery_paise: 500_000, other_deductions_paise: 500_000, net_paise: 1_355_000 - 500_000 })
  })

  it('posts the advance and its recovery, and the salary tax paid by challan', async () => {
    await R.post(`/api/payroll/runs/${RUN}/submit`, HR)
    await R.post(`/api/payroll/runs/${RUN}/check`, GM)
    expect((await R.post(`/api/payroll/runs/${RUN}/approve`, R.md)).statusCode).toBe(200)
    const bal = async (code: string) => Number((await R.db.query<{ b: string | null }>('select sum(debit_paise - credit_paise) as b from voucher_line where account_code = $1', [code]))[0].b ?? 0)
    expect(await bal('1550')).toBe(1_000_000)                      // ₹15,000 paid, ₹5,000 recovered
    expect(await bal('2300')).toBe(-734_500)
    const run = (await R.get(`/api/payroll/runs/${RUN}`, ACC)).json()
    expect(run.dues.find((d: { kind: string }) => d.kind === 'tds')).toMatchObject({ amount: 734_500, due: '2026-10-07' })
    expect((await R.post('/api/payroll/statutory', ACC, { month: '2026-09', kind: 'tds', amount: 7345, paidOn: '2026-10-06', reference: '0510001/06-10-2026/00042' })).statusCode).toBe(201)
    expect(await bal('2300')).toBe(0)
  })
})

describe('the year\'s statements and the staff app', () => {
  it('gives the 24Q figures for the quarter and Form 16 Part B for the year so far', async () => {
    const q = (await R.get('/api/payroll/24q?fy=2026-27&quarter=2', ACC)).json()
    expect(q.deductees.map((d: { code: string; tdsPaise: number; challan: string | null }) => [d.code, d.tdsPaise, !!d.challan])).toEqual([['E0001', 734_500, true], ['E0002', 0, true]])
    const csv = (await R.get('/api/payroll/24q?fy=2026-27&quarter=2&format=csv', ACC)).body
    expect(csv).toContain('"E0001","ABCPK1234L","Arun K","192","30/09/2026","120000.00","7345.00","7345.00"')
    const f = (await R.get(`/api/payroll/form16/${E.M}?fy=2026-27`, MGR_LOGIN)).json()
    expect(f.months).toEqual([{ month: '2026-09', grossPaise: 12_000_000, tdsPaise: 734_500, paidOn: null }])
    expect(f.year).toMatchObject({ gross: 72_000_000, tdsSoFar: 3_672_500 + 734_500 })
    expect((await R.get(`/api/payroll/form16/${E.A}?fy=2026-27`, MGR_LOGIN)).statusCode).toBe(403)
  })

  it('shows a person their own payslips and the year\'s tax', async () => {
    const me = (await R.get('/api/payroll/me', MGR_LOGIN)).json()
    expect(me.employee.code).toBe('E0001')
    expect(me.payslips.map((p: { month: string; net_paise: number }) => [p.month, p.net_paise])).toEqual([['2026-09', 12_000_000 - 180_000 - 125_000 - 734_500]])
    expect(me.payslips[0].bank_account).toBe('••••9012')
    expect(me.tax.compare.new).toBe(8_814_000)
    expect((await R.get('/api/payroll/me', GM)).json().employee).toBeNull()
  })
})

describe('leaving', () => {
  it('settles earned leave, the bonus provided and the advance still owed', async () => {
    expect((await R.post('/api/payroll/settlements/preview', HR, { employeeId: E.A })).json().error).toMatch(/last day/)
    await R.post(`/api/hr/employees/${E.A}/exit`, HR, { lastDay: '2026-10-31', reason: 'Resigned' })
    const p = (await R.post('/api/payroll/settlements/preview', HR, { employeeId: E.A })).json()
    // Earned leave from June 2026 (a year after joining) to October: 5 days × ₹9,000 ÷ 26 = ₹1,731; bonus ₹583; advance ₹10,000 owed.
    expect(p.items.map((i: { key: string; amount_paise: number }) => [i.key, i.amount_paise])).toEqual([['leave', 173_100], ['bonus', 58_300], ['advance', -1_000_000]])
    FNF = (await R.post('/api/payroll/settlements', HR, { employeeId: E.A, other: [{ label: 'Uniform not returned', amount: -500 }] })).json().id
    expect((await R.post(`/api/payroll/settlements/${FNF}/approve`, HR)).statusCode).toBe(403)
    expect((await R.post(`/api/payroll/settlements/${FNF}/approve`, GM)).statusCode).toBe(200)
    const [adv] = await R.db.query<{ status: string }>('select status from salary_advance where id = $1', [ADV])
    expect(adv.status).toBe('closed')
    expect((await R.post(`/api/payroll/settlements/${FNF}/pay`, ACC, { paidOn: '2026-11-05' })).json().error).toMatch(/Nothing is owed/)
    const bal = async (code: string) => Number((await R.db.query<{ b: string | null }>('select sum(debit_paise - credit_paise) as b from voucher_line where account_code = $1', [code]))[0].b ?? 0)
    expect(await bal('1550')).toBe(0)
  })
})

describe('the parallel run', () => {
  it('compares the system\'s month with the current payroll, figure by figure, within a rupee', async () => {
    const head = 'Emp Code,Gross,PF,ESI,PT,LWF,TDS,Net'
    const first = (await R.post(`/api/payroll/runs/${RUN}/compare`, HR, { csv: `${head}\nE0001,"1,20,000",1800,0,1250,0,7345,109605\nE0002,16000,1080,120,1250,0,0,8500\nE0099,9000,0,0,0,0,0,9000` })).json()
    expect(first).toMatchObject({ matched: 1, total: 3, allMatch: false })
    expect(first.people.find((p: { code: string }) => p.code === 'E0002').diffs.find((d: { field: string }) => d.field === 'net')).toMatchObject({ system: 855_000, theirs: 850_000, diff: 5_000 })
    expect(first.people.find((p: { code: string }) => p.code === 'E0099').missing).toMatch(/not in the system/)
    const second = (await R.post(`/api/payroll/runs/${RUN}/compare`, HR, { csv: `${head}\nE0001,120000,1800,0,1250,0,7345,109605.4\nE0002,16000,1080,120,1250,0,0,8550` })).json()
    expect(second).toMatchObject({ matched: 2, total: 2, allMatch: true })
    expect((await R.get('/api/payroll/parallel', GM)).json()).toMatchObject({ monthsMatched: 1, needed: 2 })
  })
})
