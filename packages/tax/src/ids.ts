import type { PayeeType } from './tds'

// PAN and IFSC checks for the vendor master (GSTINs are checked by validateGstin in documents.ts).

/** PAN: five letters, four digits, a letter. The fourth letter says who holds it. */
export const PAN_RE = /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/

/** Kind of holder from the PAN's fourth letter, for the TDS rate (individual/HUF or others). */
export function payeeTypeFromPan(pan: string): PayeeType {
  const c = pan[3]
  return c === 'P' ? 'individual' : c === 'H' ? 'huf' : c === 'C' ? 'company' : c === 'F' ? 'firm' : 'other'
}

/** IFSC: bank code, a zero, branch code. */
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
