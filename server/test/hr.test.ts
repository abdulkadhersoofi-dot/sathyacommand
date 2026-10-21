import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// HR records: an employee with statutory IDs (only Aadhaar's last four kept), a pay structure checked against
// the Code on Wages, onboarding, leave credited and taken with approval, holidays, training and an exit.

let R: Awaited<ReturnType<typeof testResort>>
let HR = '', GM = '', EHK = '', FOM = '', RA = '', EMP = '', RA_USER = ''
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })

beforeAll(async () => {
  R = await testResort('2026-11-01')
  HR = await R.staff('Revathi', '9840006001', ['hr_payroll'])
  GM = await R.staff('Karthik', '9840006002', ['general_manager'])
  EHK = await R.staff('Selvi', '9840006003', ['executive_housekeeper'])
  RA = await R.staff('Lakshmi', '9840006004', ['room_attendant'])
  FOM = await R.staff('Arun', '9840006005', ['front_office_manager'])
  RA_USER = (await R.get('/auth/me', RA)).json().id
}, 90_000)
afterAll(() => R.close())

describe('employee records', () => {
  it('adds an employee with checked IDs, keeping only the last four of Aadhaar', async () => {
    const base = { name: 'Lakshmi M', department: 'housekeeping', designation: 'Room attendant', joinedOn: '2025-06-10', mobile: '98400 06004' }
    expect((await R.post('/api/hr/employees', GM, base)).statusCode).toBe(403)
    expect((await R.post('/api/hr/employees', HR, { ...base, pan: 'ABC123' })).json().error).toMatch(/PAN/)
    expect((await R.post('/api/hr/employees', HR, { ...base, department: 'spa' })).json().error).toMatch(/Department/)
    const r = (await R.post('/api/hr/employees', HR, { ...base, pan: 'ABCPL1234K', aadhaar: '4521 8890 1234', uan: '100200300400', bankAccount: '123456789012', ifsc: 'SBIN0001234', gender: 'female' })).json()
    expect(r.code).toBe('E0001')
    EMP = r.id
    const [row] = await R.db.query<Record<string, unknown>>('select * from employee where id = $1', [EMP])
    expect(row.aadhaar_last4).toBe('1234')
    expect(JSON.stringify(row)).not.toContain('88901234')
    const d = (await R.get(`/api/hr/employees/${EMP}`, HR)).json()
    expect(d.onboarding.length).toBe(10)
    expect(d.bank_account).toBe('123456789012')
    expect((await R.get(`/api/hr/employees/${EMP}`, GM)).json()).toMatchObject({ bank_account: '••••9012', structures: [] })   // the GM sees pay (payroll), not bank accounts
    expect((await R.get(`/api/hr/employees/${EMP}`, EHK)).json()).toMatchObject({ bank_account: '••••9012', structures: null })   // a department head sees neither
    expect((await R.get(`/api/hr/employees/${EMP}`, RA)).statusCode).toBe(403)   // not yet her own record
  })

  it('keeps pay structures over time and counts allowances above half the pay as wages', async () => {
    expect((await put(`/api/hr/employees/${EMP}/salary`, HR, { effectiveFrom: '2025-06-01', basic: 9000 })).json().error).toMatch(/joining/)
    const a = (await put(`/api/hr/employees/${EMP}/salary`, HR, { effectiveFrom: '2025-06-10', basic: 9000, hra: 4000, special: 3000 })).json()
    expect(a).toMatchObject({ grossPaise: 1_600_000, wagesPaise: 900_000, note: null })
    const b = (await put(`/api/hr/employees/${EMP}/salary`, HR, { effectiveFrom: '2026-04-01', basic: 5000, special: 12000 })).json()
    expect(b).toMatchObject({ grossPaise: 1_700_000, wagesPaise: 850_000 })
    expect(b.note).toMatch(/Code on Wages/)
    const d = (await R.get(`/api/hr/employees/${EMP}`, HR)).json()
    expect(d.structures.map((s: { from: string }) => s.from)).toEqual(['2026-04-01', '2025-06-10'])
    expect(d.current.grossPaise).toBe(1_700_000)
    expect((await R.post(`/api/hr/employees/${EMP}/onboarding`, HR, { item: 'PAN collected', done: true })).statusCode).toBe(200)
    const [bank] = await R.db.query<{ action: string }>(`select action from audit_log where entity_id = $1 order by seq desc limit 1`, [EMP])
    expect(bank.action).toBe('hr.salary_set')
    await patch(`/api/hr/employees/${EMP}`, HR, { bankAccount: '999988887777' })
    const [al] = await R.db.query<{ action: string }>(`select action from audit_log where entity_id = $1 order by seq desc limit 1`, [EMP])
    expect(al.action).toBe('hr.bank_account_changed')
  })
})

describe('leave', () => {
  it('credits casual and sick leave for the year and earned leave month by month after a year\'s service', async () => {
    expect((await patch(`/api/hr/employees/${EMP}`, HR, { loginEmail: 'nobody@sathya.test' })).json().error).toMatch(/No app login/)
    expect((await patch(`/api/hr/employees/${EMP}`, HR, { loginEmail: ' 9840006004@Sathya.test ' })).statusCode).toBe(200)
    expect((await R.get(`/api/hr/employees/${EMP}`, HR)).json()).toMatchObject({ user_id: RA_USER, login: '9840006004@sathya.test' })
    const me = (await R.get('/api/hr/me', RA)).json()
    expect(me.employee.code).toBe('E0001')
    const bal = Object.fromEntries(me.balances.map((b: { type: string; balance: number }) => [b.type, b.balance]))
    expect(bal).toMatchObject({ CL: 12, SL: 12, EL: 5 })   // earned leave from June 2026, five months finished
  })

  let LV = ''
  it('takes leave with approval, never one\'s own, skipping holidays', async () => {
    expect((await put('/api/hr/holidays', HR, { day: '2026-11-08', name: 'Deepavali', kind: 'festival' })).statusCode).toBe(200)
    expect((await put('/api/hr/holidays', HR, { day: '2026-10-02', remove: true })).statusCode).toBe(409)
    const r = (await R.post('/api/hr/leave/applications', RA, { leaveType: 'CL', from: '2026-11-07', to: '2026-11-09', reason: 'Family function' })).json()
    expect(r.days).toBe(2)
    LV = r.id
    expect((await R.post('/api/hr/leave/applications', RA, { leaveType: 'SL', from: '2026-11-09', to: '2026-11-09' })).statusCode).toBe(409)
    expect((await R.post('/api/hr/leave/applications', RA, { leaveType: 'CL', from: '2026-12-01', to: '2026-12-11' })).json().error).toMatch(/Only 10 days/)
    expect((await R.post('/api/hr/leave/applications', RA, { leaveType: 'SL', from: '2026-12-01', to: '2026-12-04' })).json().error).toMatch(/medical/)
    expect((await R.post(`/api/hr/leave/applications/${LV}/decide`, RA, { decision: 'approve' })).statusCode).toBe(403)
    // A department head decides only their own department's leave, once linked to their own record.
    expect((await R.post(`/api/hr/leave/applications/${LV}/decide`, EHK, { decision: 'approve' })).json().error).toMatch(/not linked/)
    expect((await R.get('/api/hr/leave/applications?status=pending', EHK)).json()).toEqual([])
    for (const [name, dept, token] of [['Selvi R', 'housekeeping', EHK], ['Arun K', 'front_office', FOM]]) {
      const id = (await R.post('/api/hr/employees', HR, { name, department: dept, designation: 'Head', joinedOn: '2024-01-01' })).json().id
      await patch(`/api/hr/employees/${id}`, HR, { userId: (await R.get('/auth/me', token)).json().id })
    }
    expect((await R.post(`/api/hr/leave/applications/${LV}/decide`, FOM, { decision: 'approve' })).statusCode).toBe(403)
    expect((await R.get('/api/hr/leave/applications?status=pending', FOM)).json()).toEqual([])
    expect((await R.post(`/api/hr/leave/applications/${LV}/decide`, EHK, { decision: 'reject' })).json().error).toMatch(/why/)
    expect((await R.get('/api/hr/leave/applications?status=pending', EHK)).json().map((a: { id: string }) => a.id)).toEqual([LV])
    expect((await R.post(`/api/hr/leave/applications/${LV}/decide`, EHK, { decision: 'approve' })).statusCode).toBe(200)
    expect((await R.get('/api/hr/me', RA)).json().balances.find((b: { type: string }) => b.type === 'CL').balance).toBe(10)
  })

  it('gives the days back when approved leave is cancelled before it starts, and HR grants compensatory off', async () => {
    expect((await R.post(`/api/hr/leave/applications/${LV}/cancel`, RA)).statusCode).toBe(200)
    expect((await R.get('/api/hr/me', RA)).json().balances.find((b: { type: string }) => b.type === 'CL').balance).toBe(12)
    expect((await R.post('/api/hr/leave/grant', HR, { employeeId: EMP, leaveType: 'CO', days: 1 })).statusCode).toBe(400)
    expect((await R.post('/api/hr/leave/grant', HR, { employeeId: EMP, leaveType: 'CO', days: 1, reason: 'Worked on Deepavali' })).statusCode).toBe(201)
    expect((await R.get('/api/hr/me', RA)).json().balances.find((b: { type: string }) => b.type === 'CO').balance).toBe(1)
  })
})

describe('training and leaving', () => {
  it('lists certificates running out, and records notice', async () => {
    await R.post(`/api/hr/employees/${EMP}/training`, HR, { kind: 'fssai_food_handler', doneOn: '2024-12-01', validUntil: '2026-12-01' })
    expect((await R.get('/api/hr/training/due', GM)).json().map((t: { name: string; kind: string }) => [t.name, t.kind])).toEqual([['Lakshmi M', 'fssai_food_handler']])
    expect((await R.post(`/api/hr/employees/${EMP}/exit`, HR, { lastDay: '2026-11-30' })).statusCode).toBe(400)
    expect((await R.post(`/api/hr/employees/${EMP}/exit`, HR, { lastDay: '2026-11-30', reason: 'Resigned' })).statusCode).toBe(200)
    expect((await R.get('/api/hr/employees', GM)).json().find((e: { code: string }) => e.code === 'E0001')).toMatchObject({ status: 'notice', grossPaise: 1_700_000 })
    expect((await R.get('/api/hr/employees', EHK)).json().find((e: { code: string }) => e.code === 'E0001')).toMatchObject({ grossPaise: null })
  })
})
