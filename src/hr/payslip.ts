import { esc, toast } from '../ui/dom'

// Printable payslips and Form 16 Part B, opened in a new window: from People → Payroll for everyone, and from
// the staff app for one's own.

export interface Slip {
  monthName: string; days_in_month: number; code: string; name: string; designation: string; department: string; uan: string | null; esic_ip: string | null; pan: string | null; bank_account: string | null
  paid_days: number; lop_days: number; ot_hours: number; note: string | null
  basic_paise: number; da_paise: number; hra_paise: number; conveyance_paise: number; special_paise: number; other_paise: number; overtime_paise: number; other_earnings_paise: number; gross_paise: number
  pf_employee_paise: number; esi_employee_paise: number; pt_paise: number; lwf_employee_paise: number; tds_paise: number; advance_recovery_paise?: number; net_paise: number; net_words: string; eps_paise: number; pf_employer_paise: number; esi_employer_paise: number
}
export interface Employer { name: string; address: string; tan?: string | null; responsible?: string | null; designation?: string | null }

const amt = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const STYLE = `body{font:12px system-ui;margin:16px;color:#111}.slip{border:1px solid #333;padding:10px 14px;margin-bottom:14px;page-break-inside:avoid}header{text-align:center}h2{font-size:14px;margin:6px 0}h3{font-size:13px;margin:12px 0 4px}
  table{border-collapse:collapse;width:100%}td,th{padding:3px 6px;border-bottom:1px solid #ddd;text-align:left}.n{text-align:right}.who td:nth-child(odd){color:#555;width:16%}.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px}
  .t td{font-weight:700;border-top:1px solid #333}.net{font-size:14px;font-weight:700;margin:10px 0 4px}.foot{color:#555;font-size:11px;margin:0}@media print{.slip{page-break-after:always}}`

function open(title: string, body: string) {
  const w = window.open('', '_blank')
  if (!w) { toast('Allow pop-ups to print.'); return }
  w.document.write(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style>${body}<script>print()</script>`)
  w.document.close()
}

export function printPayslips(slips: Slip[], employer: Employer, title: string) {
  const rows = (pairs: [string, number | undefined][]) => pairs.filter(([, v]) => v).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${amt(v!)}</td></tr>`).join('')
  const slip = (l: Slip) => `<section class="slip"><header><b>${esc(employer.name)}</b><div>${esc(employer.address)}</div><h2>Payslip for ${esc(l.monthName)}</h2></header>
    <table class="who"><tr><td>Name</td><td>${esc(l.name)}</td><td>Code</td><td>${esc(l.code)}</td></tr><tr><td>Designation</td><td>${esc(l.designation)}</td><td>Department</td><td>${esc(l.department)}</td></tr>
      <tr><td>UAN</td><td>${esc(l.uan ?? '—')}</td><td>ESIC IP</td><td>${esc(l.esic_ip ?? '—')}</td></tr><tr><td>PAN</td><td>${esc(l.pan ?? '—')}</td><td>Bank</td><td>${esc(l.bank_account ? `••••${l.bank_account.slice(-4)}` : '—')}</td></tr>
      <tr><td>Days in month</td><td>${l.days_in_month}</td><td>Paid days</td><td>${l.paid_days}${l.lop_days ? ` (leave without pay ${l.lop_days})` : ''}</td></tr></table>
    <div class="cols"><table><thead><tr><th>Earnings</th><th class="n">₹</th></tr></thead>${rows([['Basic', l.basic_paise], ['DA', l.da_paise], ['HRA', l.hra_paise], ['Conveyance', l.conveyance_paise], ['Special allowance', l.special_paise], ['Other allowance', l.other_paise], [`Overtime (${l.ot_hours} h)`, l.overtime_paise], [l.note ?? 'Other earnings', l.other_earnings_paise]])}<tr class="t"><td>Gross</td><td class="n">${amt(l.gross_paise)}</td></tr></table>
      <table><thead><tr><th>Deductions</th><th class="n">₹</th></tr></thead>${rows([['Provident fund', l.pf_employee_paise], ['ESI', l.esi_employee_paise], ['Professional tax', l.pt_paise], ['Labour welfare fund', l.lwf_employee_paise], ['Income tax', l.tds_paise], ['Salary advance / loan', l.advance_recovery_paise]])}<tr class="t"><td>Total</td><td class="n">${amt(l.gross_paise - l.net_paise)}</td></tr></table></div>
    <p class="net">Net pay ₹${amt(l.net_paise)} · ${esc(l.net_words)}</p>
    <p class="foot">Employer's PF ${amt(l.eps_paise + l.pf_employer_paise)} (pension ${amt(l.eps_paise)}) · ESI ${amt(l.esi_employer_paise)}. Computer-generated; no signature needed.</p></section>`
  open(title, slips.map(slip).join(''))
}

export interface Form16 {
  fy: string; complete: boolean; employee: { code: string; name: string; pan: string | null; designation: string }; employer: Employer; taxWords: string
  months: { month: string; grossPaise: number; tdsPaise: number }[]; deposits: { month: string; reference: string; paid_on: string }[]
  year: { regime: string; salaryPaid: number; previousIncome: number; gross: number; standardDeduction: number; hraExempt: number; professionalTax: number; deductions: { sec80c: number; sec80d: number; homeLoan: number; other: number }; taxable: number; tax: number; rebate: number; cess: number; annualTax: number; tdsSoFar: number }
}

export function printForm16(f: Form16) {
  const y = f.year
  const r = (k: string, v: number) => `<tr><td>${esc(k)}</td><td class="n">${amt(v)}</td></tr>`
  open(`Form 16 Part B ${f.fy} ${f.employee.code}`, `<section class="slip"><header><b>${esc(f.employer.name)}</b><div>${esc(f.employer.address)}${f.employer.tan ? ` · TAN ${esc(f.employer.tan)}` : ''}</div>
    <h2>Form 16 Part B · financial year ${esc(f.fy)}</h2>${f.complete ? '' : '<div><b>The year is not over: these are the figures so far, not the final certificate.</b></div>'}</header>
    <table class="who"><tr><td>Employee</td><td>${esc(f.employee.name)} (${esc(f.employee.code)})</td><td>PAN</td><td>${esc(f.employee.pan ?? 'not given')}</td></tr><tr><td>Designation</td><td>${esc(f.employee.designation)}</td><td>Tax regime</td><td>${esc(y.regime)}</td></tr></table>
    <h3>Salary and tax</h3><table>${r('Salary paid by this employer', y.salaryPaid)}${y.previousIncome ? r('Salary before (earlier employer or before this system)', y.previousIncome) : ''}${r('Gross salary', y.gross)}
      ${r('Standard deduction', y.standardDeduction)}${y.hraExempt ? r('House rent allowance exempt', y.hraExempt) : ''}${y.professionalTax ? r('Professional tax', y.professionalTax) : ''}
      ${y.deductions.sec80c ? r('Deduction: life insurance, PF, ELSS… (80C)', y.deductions.sec80c) : ''}${y.deductions.sec80d ? r('Deduction: health insurance (80D)', y.deductions.sec80d) : ''}${y.deductions.homeLoan ? r('Interest on home loan', y.deductions.homeLoan) : ''}${y.deductions.other ? r('Other deductions', y.deductions.other) : ''}
      <tr class="t"><td>Taxable income</td><td class="n">${amt(y.taxable)}</td></tr>${r('Tax on it', y.tax)}${y.rebate ? r('Rebate', y.rebate) : ''}${r('Health and education cess', y.cess)}<tr class="t"><td>Tax for the year</td><td class="n">${amt(y.annualTax)}</td></tr>${r('Tax deducted', y.tdsSoFar)}</table>
    <h3>Month by month</h3><table><thead><tr><th>Month</th><th class="n">Salary</th><th class="n">Tax deducted</th><th>Deposited</th></tr></thead>
      ${f.months.map((m) => `<tr><td>${esc(m.month)}</td><td class="n">${amt(m.grossPaise)}</td><td class="n">${amt(m.tdsPaise)}</td><td>${esc(f.deposits.filter((d) => d.month === m.month).map((d) => `${d.reference}`).join('; ') || '—')}</td></tr>`).join('')}</table>
    <p class="net">Tax for the year: ${esc(f.taxWords)}</p>
    <p class="foot">Part A (the tax deposited against the PAN) is downloaded from TRACES. ${f.employer.responsible ? `Signed for the employer by ${esc(f.employer.responsible)}${f.employer.designation ? `, ${esc(f.employer.designation)}` : ''}.` : ''}</p></section>`)
}
