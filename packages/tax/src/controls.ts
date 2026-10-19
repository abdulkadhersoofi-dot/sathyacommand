import { TaxConfigError, type TaxConfig } from './config'
import { rupees, type Paise } from './money'
import { addDays } from './dates'

// Legal controls the HMS enforces at the point of action.

/** Cash of ₹2 lakh or more from one person in a day or for one event is not allowed. */
export function cashReceiptCheck(cfg: TaxConfig, amount: Paise, sameDaySamePerson: Paise = 0) {
  const limit = rupees(cfg.income_tax.controls.block_cash_receipt_at_or_above)
  const total = amount + sameDaySamePerson
  return total >= limit
    ? { allowed: false, message: 'Cash of ₹2 lakh or more from one person is not allowed. Take UPI, card or bank transfer.' }
    : { allowed: true, message: null }
}

/** Cash expenses above ₹10,000 to one party in a day are not tax-deductible. */
export function cashExpenseCheck(cfg: TaxConfig, amount: Paise, sameDaySameParty: Paise = 0) {
  const total = amount + sameDaySameParty
  return total > rupees(cfg.income_tax.controls.warn_cash_expense_above)
    ? { warn: true, message: 'Cash payments above ₹10,000 to one party in a day are not deductible. Pay by bank or UPI.' }
    : { warn: false, message: null }
}

/** Micro and small suppliers must be paid within 15 days (45 with a written agreement). */
export function msmePaymentDue(cfg: TaxConfig, invoiceDate: string, writtenAgreement: boolean, alertDaysBefore = 10) {
  const d = cfg.income_tax.controls.msme_payment_days
  const due = addDays(invoiceDate, writtenAgreement ? d.with_agreement : d.without_agreement)
  return { dueDate: due, alertDate: addDays(due, -alertDaysBefore) }
}

/** Whether a liquor order may be taken at a local date-time ("YYYY-MM-DDTHH:MM"). */
export function liquorSaleAllowed(cfg: TaxConfig, localDateTime: string, override?: { open: string; close: string; dryDays: string[] }) {
  const hours = override ?? cfg.liquor_controls.licensed_hours
  const dry = override?.dryDays ?? cfg.liquor_controls.dry_days
  if (!hours.open || !hours.close) throw new TaxConfigError('Licensed bar hours are not set in tax-config.yaml')
  const [date, time] = localDateTime.split('T')
  if (dry.includes(date)) return { allowed: false, reason: 'Dry day: liquor sales are closed today.' }
  const inHours = hours.open <= hours.close
    ? time >= hours.open && time < hours.close
    : time >= hours.open || time < hours.close          // licence runs past midnight
  return inHours ? { allowed: true, reason: null } : { allowed: false, reason: `Outside licensed hours (${hours.open}–${hours.close}).` }
}

/** Form C for a foreign guest is due within 24 hours of arrival. */
export const formCDue = (checkInIso: string) => new Date(new Date(checkInIso).getTime() + 24 * 3600 * 1000).toISOString()

/** Service charge is optional; the guest can have it removed. */
export const serviceCharge = (amount: Paise, rate: number, guestDeclined: boolean) =>
  guestDeclined ? 0 : Math.round((amount * rate) / 100)
