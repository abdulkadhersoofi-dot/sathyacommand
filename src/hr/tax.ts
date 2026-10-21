import { esc } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { money } from '../acc/books'

// The year's income tax on salary as the payroll works it out, and the declaration behind it: shown to HR in
// People and to each person in the staff app (My pay).

export interface TaxYear { regime: string; salaryPaid: number; salaryProjected: number; previousIncome: number; gross: number; standardDeduction: number; hraExempt: number; professionalTax: number
  deductions: { sec80c: number; sec80d: number; homeLoan: number; other: number }; taxable: number; tax: number; rebate: number; cess: number; annualTax: number; tdsSoFar: number; monthsLeft: number }
export interface TaxView { fy: string; declaration: { regime: string; rent: number; sec80c: number; sec80d: number; homeLoan: number; other: number; previousIncome: number; previousTds: number; proofsChecked: boolean }; year: TaxYear; compare: { new: number; old: number } }

export const fyOptions = () => {
  const n = new Date(), y0 = n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1
  return [0, 1, 2].map((k) => { const y = y0 - k; const v = `${y}-${String((y + 1) % 100).padStart(2, '0')}`; return `<option value="${v}">${v}</option>` }).join('')
}

export function taxSummary(tv: TaxView, t: (s: string) => string = (s) => s) {
  const y = tv.year
  const row = (k: string, v: number) => (v ? `<div class="m-row pay-kv"><span>${esc(t(k))}</span><span class="mono">${money(v)}</span></div>` : '')
  const better = tv.compare.new === tv.compare.old ? '' : tv.compare.new < tv.compare.old ? 'new' : 'old'
  return `<div class="m-table">${row('Salary paid so far', y.salaryPaid + y.previousIncome)}${row('Salary to come (to March)', y.salaryProjected)}${row('Standard deduction', -y.standardDeduction)}${row('House rent allowance exempt', -y.hraExempt)}
      ${row('Professional tax', -y.professionalTax)}${row('Deductions (80C, 80D, home loan, other)', -(y.deductions.sec80c + y.deductions.sec80d + y.deductions.homeLoan + y.deductions.other))}
      <div class="m-row pay-kv"><b>${esc(t('Taxable income'))}</b><b class="mono">${money(y.taxable)}</b></div>${row('Tax for the year', y.annualTax)}${row('Deducted so far', y.tdsSoFar)}
      <div class="m-row pay-kv"><b>${esc(t('Still to deduct'))}</b><b class="mono">${money(Math.max(0, y.annualTax - y.tdsSoFar))}</b></div></div>
    <p class="small">${esc(t('Tax for the year'))}: ${esc(t('new regime'))} <b class="mono">${money(tv.compare.new)}</b> · ${esc(t('old regime'))} <b class="mono">${money(tv.compare.old)}</b>${better ? ` · ${esc(t(better === 'new' ? 'the new regime costs less' : 'the old regime costs less'))}` : ''}</p>`
}

export function declarationBody(tv: TaxView, hr: boolean, t: (s: string) => string = (s) => s) {
  const d = tv.declaration
  const n = (name: string, label: string, v: number) => `<label>${esc(t(label))}<input name="${name}" type="number" min="0" value="${v ? v / 100 : ''}"></label>`
  return `<div class="sec-title">${esc(t('Declaration'))} ${esc(tv.fy)}${d.proofsChecked ? ` <small>${esc(t('proofs checked by HR'))}</small>` : ''}</div>
    <div class="form-grid"><label>${esc(t('Tax regime'))}<select name="regime"><option value="new" ${d.regime === 'new' ? 'selected' : ''}>${esc(t('New'))}</option><option value="old" ${d.regime === 'old' ? 'selected' : ''}>${esc(t('Old'))}</option></select></label>
      ${n('rent', 'Rent paid a month (₹)', d.rent)}${n('c80', 'Investments under 80C (₹ a year)', d.sec80c)}${n('d80', 'Health insurance 80D (₹ a year)', d.sec80d)}${n('loan', 'Home loan interest (₹ a year)', d.homeLoan)}${n('other', 'Other deductions (₹ a year)', d.other)}
      ${n('prev', 'Salary earlier this year, elsewhere or before this system (₹)', d.previousIncome)}${n('prevtds', 'Tax deducted on it (₹)', d.previousTds)}
      ${hr ? `<label class="span2 check"><input type="checkbox" name="proofs" ${d.proofsChecked ? 'checked' : ''}> ${esc(t('Proofs checked'))}</label>` : ''}</div>
    <p class="muted small">${esc(t('Rent, 80C, 80D and home loan interest count only in the old regime.'))}</p>`
}

export const declarationForm = (f: HTMLFormElement, fy: string, hr: boolean) => ({
  fy, regime: val(f, 'regime'), rent: Number(val(f, 'rent') || 0), sec80c: Number(val(f, 'c80') || 0), sec80d: Number(val(f, 'd80') || 0), homeLoan: Number(val(f, 'loan') || 0), other: Number(val(f, 'other') || 0),
  previousIncome: Number(val(f, 'prev') || 0), previousTds: Number(val(f, 'prevtds') || 0), ...(hr ? { proofsChecked: checked(f, 'proofs') } : {}),
})
