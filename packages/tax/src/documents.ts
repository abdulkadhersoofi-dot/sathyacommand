import type { Paise } from './money'

// Helpers for statutory documents: GSTIN validation, document numbers, amount in words.

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
}

export function gstinCheckDigit(first14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(v / 36) + (v % 36)
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36]
}

export function validateGstin(raw: string): { ok: true; gstin: string; stateCode: string; state: string } | { ok: false; reason: string } {
  const g = String(raw ?? '').trim().toUpperCase()
  if (!GSTIN_SHAPE.test(g)) return { ok: false, reason: 'A GSTIN has 15 characters, like 33AAACS1234A1Z9.' }
  const state = STATES[g.slice(0, 2)]
  if (!state) return { ok: false, reason: `State code ${g.slice(0, 2)} does not exist.` }
  if (gstinCheckDigit(g.slice(0, 14)) !== g[14]) return { ok: false, reason: 'The last character does not match. Check the GSTIN for a typing mistake.' }
  return { ok: true, gstin: g, stateCode: g.slice(0, 2), state }
}

/** "SPR/26-27/000123": prefix, financial year, 6-digit serial. GST allows at most 16 characters. */
export function documentNumber(prefix: string, fy: string, serial: number): string {
  const n = `${prefix}/${fy.slice(2)}/${String(serial).padStart(6, '0')}`
  if (n.length > 16) throw new Error(`Document number ${n} is longer than 16 characters`)
  return n
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function below100(n: number) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '') }
function below1000(n: number) {
  const h = Math.floor(n / 100), r = n % 100
  return [h ? ONES[h] + ' Hundred' : '', r ? below100(r) : ''].filter(Boolean).join(' ')
}

/** Indian numbering in words: crore, lakh, thousand. */
export function inWords(n: number): string {
  if (n === 0) return 'Zero'
  const parts: string[] = []
  const crore = Math.floor(n / 1e7); n %= 1e7
  const lakh = Math.floor(n / 1e5); n %= 1e5
  const thousand = Math.floor(n / 1e3); n %= 1e3
  if (crore) parts.push(inWords(crore) + ' Crore')
  if (lakh) parts.push(below100(lakh) + ' Lakh')
  if (thousand) parts.push(below100(thousand) + ' Thousand')
  if (n) parts.push(below1000(n))
  return parts.join(' ')
}

export function amountInWords(p: Paise): string {
  const neg = p < 0
  const abs = Math.abs(p)
  const r = Math.floor(abs / 100), paise = abs % 100
  return `${neg ? 'Minus ' : ''}Rupees ${inWords(r)}${paise ? ` and ${below100(paise)} Paise` : ''} Only`
}
