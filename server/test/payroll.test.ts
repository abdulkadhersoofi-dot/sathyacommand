import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// The monthly payroll worked by hand for September 2026 (30 days; the professional tax month of the April–
// September half): a room attendant within the ESI ceiling, a chef above it with PF on the ₹15,000 ceiling,
// a receptionist who joined mid-month, and a guard with leave without pay, a day absent from the roster and
// overtime. Then the checks and approvals, the books, the bank and EPFO files, and paying the dues.

let R: Awaited<ReturnType<typeof testResort>>
let HR = '', GM = '', ACC = '', GUARD = ''
const E: Record<string, string> = {}
let RUN = ''
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const line = async (code: string) => (await R.get(`/api/payroll/runs/${RUN}`, HR)).json().lines.find((l: { code: string }) => l.code === code)

beforeAll(async () => {
  R = await testResort('2026-10-02')
  HR = await R.staff('Revathi', '9840007001', ['hr_payroll'])
  GM = await R.staff('Karthik', '9840007002', ['general_manager'])
  ACC = await R.staff('Meena', '9840007003', ['accounts'])
  GUARD = await R.staff('Ravi', '9840007004', ['security'])
  const add = async (key: string, b: Record<string, unknown>, pay: Record<string, unknown>) => {
    E[key] = (await R.post('/api/hr/employees', HR, b)).json().id
    if (Object.keys(pay).length) expect((await put(`/api/hr/employees/${E[key]}/salary`, HR, { effectiveFrom: b.joinedOn, ...pay })).statusCode).toBe(200)
  }
  await add('A', { name: 'Lakshmi M', department: 'housekeeping', designation: 'Room attendant', joinedOn: '2025-06-10', uan: '100200300400', esicIp: '3100123456', bankAccount: '123456789012', ifsc: 'SBIN0001234' }, { basic: 9000, hra: 4000, special: 3000 })
  await add('B', { name: 'Senthil K', department: 'kitchen', designation: 'Chef', joinedOn: '2024-01-01', dob: '1990-05-01', uan: '100200300401', bankAccount: '223456789012', ifsc: 'HDFC0001234' }, { basic: 15000, da: 5000, hra: 10000, special: 10000 })
  await add('C', { name: 'Priya S', department: 'front_office', designation: 'Receptionist', joinedOn: '2026-09-16' }, { basic: 10000, special: 2000 })
  await add('D', { name: 'Ravi P', department: 'security', designation: 'Guard', joinedOn: '2025-01-01', uan: '100200300402', esicIp: '3100123457', bankAccount: '323456789012', ifsc: 'IOBA0001234' }, { basic: 12000, hra: 3000 })
  await add('X', { name: 'New Joiner', department: 'gardens', designation: 'Gardener', joinedOn: '2026-09-20' }, {})
  // The guard: two days' leave without pay, rostered on the 1st and 2nd but in only on the 1st, staying 9 h 45 min on an 8-hour shift.
  await patch(`/api/hr/employees/${E.D}`, HR, { userId: (await R.get('/auth/me', GUARD)).json().id })
  const lv = (await R.post('/api/hr/leave/applications', HR, { employeeId: E.D, leaveType: 'LOP', from: '2026-09-10', to: '2026-09-11', reason: 'Native place' })).json()
  expect((await R.post(`/api/hr/leave/applications/${lv.id}/decide`, GM, { decision: 'approve' })).statusCode).toBe(200)
  const uid = (await R.get('/auth/me', GUARD)).json().id
  await R.db.query(`insert into shift (id, name, starts, ends) values ('T-MORN', 'Morning', '06:00', '14:00') on conflict do nothing`)
  await R.db.query(`insert into roster (user_id, day, shift_id) values ($1, '2026-09-01', 'T-MORN'), ($1, '2026-09-02', 'T-MORN')`, [uid])
  await R.db.query(`insert into attendance (id, user_id, day, shift_id, clock_in_at, clock_out_at) values ('AT-1', $1, '2026-09-01', 'T-MORN', '2026-09-01T06:00:00+05:30', '2026-09-01T15:45:00+05:30')`, [uid])
}, 120_000)
afterAll(() => R.close())

describe('working out the month', () => {
  it('runs September for everyone on the rolls with a pay structure', async () => {
    expect((await R.post('/api/payroll/runs', GM, { month: '2026-09' })).statusCode).toBe(403)
    expect((await R.post('/api/payroll/runs', HR, { month: '2026-11' })).json().error).toMatch(/not started/)
    const r = (await R.post('/api/payroll/runs', HR, { month: '2026-09' })).json()
    RUN = r.id
    expect(r.missing.map((m: { name: string }) => m.name)).toEqual(['New Joiner'])
    expect((await R.post('/api/payroll/runs', HR, { month: '2026-09' })).statusCode).toBe(409)
  })

  it('pays the room attendant in full, with PF, ESI and the half-year\'s professional tax', async () => {
    expect(await line('E0001')).toMatchObject({
      paid_days: 30, lop_days: 0, gross_paise: 1_600_000, wages_paise: 900_000,
      pf_wages_paise: 900_000, pf_employee_paise: 108_000, eps_paise: 75_000, pf_employer_paise: 33_000, edli_paise: 4_500,
      esi_covered: true, esi_employee_paise: 12_000, esi_employer_paise: 52_000,
      pt_paise: 125_000, net_paise: 1_355_000, bonus_provision_paise: 58_300, gratuity_provision_paise: 43_300,
    })
    expect((await line('E0001')).warnings).toContain('Note: professional tax counts the months paid outside the system at their full structure')
  })

  it('keeps the chef\'s PF on the ₹15,000 ceiling, the pension share at its ₹1,250 most, and no ESI above ₹21,000', async () => {
    expect(await line('E0002')).toMatchObject({ gross_paise: 4_000_000, wages_paise: 2_000_000, pf_wages_paise: 1_500_000, pf_employee_paise: 180_000, eps_paise: 125_000, pf_employer_paise: 55_000, edli_paise: 7_500,
      esi_covered: false, esi_employee_paise: 0, pt_paise: 125_000, net_paise: 3_695_000, bonus_provision_paise: 58_300, gratuity_provision_paise: 96_200 })
  })

  it('pays the receptionist from her joining, with no professional tax for a fortnight in the half', async () => {
    const c = await line('E0003')
    expect(c).toMatchObject({ employed_days: 15, paid_days: 15, basic_paise: 500_000, special_paise: 100_000, gross_paise: 600_000, wages_paise: 500_000,
      pf_employee_paise: 60_000, eps_paise: 41_700, pf_employer_paise: 18_300, esi_employee_paise: 4_500, esi_employer_paise: 19_500, pt_paise: 0, net_paise: 535_500 })
    expect(c.warnings.join(' ')).toMatch(/No UAN.*No ESIC.*No bank/)
  })

  it('takes leave without pay and a rostered day not in out of the guard\'s pay, and pays his overtime at double', async () => {
    expect(await line('E0004')).toMatchObject({ leave_lop_days: 2, absent_days: 1, lop_days: 3, paid_days: 27, ot_hours: 1.5,
      basic_paise: 1_080_000, hra_paise: 270_000, overtime_paise: 17_300, gross_paise: 1_367_300, wages_paise: 1_080_000,
      pf_employee_paise: 129_600, eps_paise: 90_000, pf_employer_paise: 39_600, esi_employee_paise: 10_300, esi_employer_paise: 44_500, pt_paise: 125_000, net_paise: 1_102_400 })
  })

  it('lets HR add other earnings with a reason, and totals what each authority is owed', async () => {
    expect((await patch(`/api/payroll/runs/${RUN}/lines/${E.B}`, HR, { otherEarnings: 2000 })).json().error).toMatch(/what the other earnings/)
    expect((await patch(`/api/payroll/runs/${RUN}/lines/${E.B}`, HR, { otherEarnings: 2000, note: 'Festival incentive' })).json().netPaise).toBe(3_895_000)
    expect((await patch(`/api/payroll/runs/${RUN}/lines/${E.D}`, HR, { lopDays: 2.3 })).statusCode).toBe(400)
    const run = (await R.get(`/api/payroll/runs/${RUN}`, HR)).json()
    expect(run.totals).toMatchObject({ people: 4, pf_admin: 50_000 })
    expect(Object.fromEntries(run.dues.map((d: { kind: string; amount: number; due: string }) => [d.kind, [d.amount, d.due]]))).toEqual({
      pf: [220_500 + 367_500 + 122_500 + 264_600 + 50_000, '2026-10-15'], esi: [64_000 + 24_000 + 54_800, '2026-10-15'], pt: [375_000, '2026-10-15'] })
  })
})

describe('approval, books and payment', () => {
  it('is submitted by HR, checked by the GM and approved by the MD, freezing the month\'s pay and leave', async () => {
    expect((await R.post(`/api/payroll/runs/${RUN}/submit`, HR)).statusCode).toBe(200)
    expect((await patch(`/api/payroll/runs/${RUN}/lines/${E.B}`, HR, { otherEarnings: 0 })).statusCode).toBe(409)
    expect((await put(`/api/hr/employees/${E.A}/salary`, HR, { effectiveFrom: '2026-09-01', basic: 9500 })).json().error).toMatch(/already submitted/)
    expect((await R.post('/api/hr/leave/applications', HR, { employeeId: E.A, leaveType: 'CL', from: '2026-09-21', to: '2026-09-21' })).json().error).toMatch(/waiting for approval/)
    expect((await R.post(`/api/payroll/runs/${RUN}/approve`, GM)).statusCode).toBe(403)
    expect((await R.post(`/api/payroll/runs/${RUN}/check`, HR)).statusCode).toBe(403)
    expect((await R.post(`/api/payroll/runs/${RUN}/check`, GM)).statusCode).toBe(200)
    expect((await R.post(`/api/payroll/runs/${RUN}/approve`, R.md)).statusCode).toBe(200)
    expect((await put(`/api/hr/employees/${E.A}/salary`, HR, { effectiveFrom: '2026-10-01', basic: 9500, hra: 4000, special: 3000 })).statusCode).toBe(200)
  })

  it('posts the month to the books by department, with the dues and net pay as liabilities', async () => {
    const rows = await R.db.query<{ account_code: string; dept: string | null; dr: string; cr: string }>(
      `select l.account_code, l.dept, sum(l.debit_paise) as dr, sum(l.credit_paise) as cr from voucher_line l join voucher v on v.id = l.voucher_id
        where v.source_type = 'payroll_run' and v.source_id = $1 group by 1, 2 order by 1, 2`, [RUN])
    const at = (code: string, dept?: string) => rows.filter((r) => r.account_code === code && (!dept || r.dept === dept)).reduce((s, r) => s + Number(r.dr) - Number(r.cr), 0)
    expect(at('6100', 'rooms')).toBe(1_600_000 + 600_000)       // housekeeping and front office
    expect(at('6100', 'fnb')).toBe(4_200_000)
    expect(at('6100', 'admin')).toBe(1_367_300)                  // security
    expect(at('2410')).toBe(-(1_025_100))
    expect(at('2420')).toBe(-142_800)
    expect(at('2430')).toBe(-375_000)
    expect(at('2400')).toBe(-(1_355_000 + 3_895_000 + 535_500 + 1_102_400))
    expect(at('2900')).toBe(0)
  })

  it('gives accounts the bank file and the EPFO and ESIC files, and records the salaries and dues paid', async () => {
    const bank = await R.get(`/api/payroll/runs/${RUN}/bank`, ACC)
    expect(bank.body).toContain('E0001,Lakshmi M,123456789012,SBIN0001234,13550.00,SALARY 2026-09')
    expect(bank.body).not.toContain('Priya S')                   // no bank account: paid by cheque
    const ecr = (await R.get(`/api/payroll/runs/${RUN}/ecr`, HR)).body.trim().split('\r\n')
    expect(ecr).toHaveLength(3)                                    // the receptionist has no UAN yet
    expect(ecr[0]).toBe('100200300400#~#LAKSHMI M#~#16000#~#9000#~#9000#~#9000#~#1080#~#750#~#330#~#0#~#0')
    expect(ecr[2]).toMatch(/^100200300402#~#RAVI P#~#13673#~#10800#~#10800#~#10800#~#1296#~#900#~#396#~#3#~#0$/)
    const esi = (await R.get(`/api/payroll/runs/${RUN}/esi`, ACC)).body
    expect(esi).toContain('3100123456,Lakshmi M,30,16000,,')
    expect(esi).toContain(',Priya S,15,6000,,')
    expect((await R.post(`/api/payroll/runs/${RUN}/pay`, HR, { paidOn: '2026-10-01' })).statusCode).toBe(403)
    expect((await R.post(`/api/payroll/runs/${RUN}/pay`, ACC, { paidOn: '2026-10-01', reference: 'NEFT bulk 4471' })).statusCode).toBe(200)
    expect((await R.post('/api/payroll/statutory', ACC, { month: '2026-09', kind: 'pf', amount: 10251, paidOn: '2026-10-10' })).json().error).toMatch(/TRRN/)
    expect((await R.post('/api/payroll/statutory', ACC, { month: '2026-09', kind: 'pf', amount: 10251, paidOn: '2026-10-10', reference: '1012610000123' })).statusCode).toBe(201)
    const bal = async (code: string) => Number((await R.db.query<{ b: string | null }>('select sum(debit_paise - credit_paise) as b from voucher_line where account_code = $1', [code]))[0].b ?? 0)
    expect(await bal('2400')).toBe(0)
    expect(await bal('2410')).toBe(0)
    expect((await R.get(`/api/payroll/runs/${RUN}`, ACC)).json().dues.find((d: { kind: string }) => d.kind === 'pf')).toMatchObject({ paid: 1_025_100 })
  })
})

describe('the next months', () => {
  it('sends a run back to HR with a reason, and takes the welfare fund in December', async () => {
    await R.db.query(`update property set business_date = '2027-01-02'`)
    const oct = (await R.post('/api/payroll/runs', HR, { month: '2026-10' })).json().id
    const a = (await R.get(`/api/payroll/runs/${oct}`, HR)).json().lines.find((l: { code: string }) => l.code === 'E0001')
    expect(a).toMatchObject({ gross_paise: 1_650_000, pt_paise: 0, lwf_employee_paise: 0 })   // the new structure from October
    await R.post(`/api/payroll/runs/${oct}/submit`, HR)
    expect((await R.post(`/api/payroll/runs/${oct}/send-back`, GM, {})).statusCode).toBe(400)
    expect((await R.post(`/api/payroll/runs/${oct}/send-back`, GM, { note: 'Overtime for Deepavali week missing' })).statusCode).toBe(200)
    expect((await R.get(`/api/payroll/runs/${oct}`, HR)).json()).toMatchObject({ status: 'draft', sent_back_note: 'Overtime for Deepavali week missing' })
    const dec = (await R.post('/api/payroll/runs', HR, { month: '2026-12' })).json().id
    const d = (await R.get(`/api/payroll/runs/${dec}`, HR)).json()
    expect(d.lines.find((l: { code: string }) => l.code === 'E0001')).toMatchObject({ lwf_employee_paise: 2_000, lwf_employer_paise: 4_000 })
    expect(d.dues.find((x: { kind: string }) => x.kind === 'lwf')).toMatchObject({ due: '2027-01-31' })
  })
})
