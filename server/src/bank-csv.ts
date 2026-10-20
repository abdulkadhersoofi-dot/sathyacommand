// Reads a bank statement saved as CSV from the bank's website. Banks differ in their columns, so the header
// row is found and read by name: the date, the narration, a reference (cheque / UTR), withdrawals and
// deposits (or one amount with Dr / Cr), and the running balance. Rows without a date are skipped.

export interface StatementLine { date: string; description: string; reference: string | null; amountPaise: number; balancePaise: number | null }

/** Splits CSV text into rows, honouring quoted fields. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((f) => f.trim())) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f.trim())) rows.push(row)
  return rows
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }

/** dd/mm/yyyy, dd-mm-yy, yyyy-mm-dd, dd-Mon-yyyy or dd Mon yyyy → yyyy-mm-dd (null when not a date). */
export function statementDate(raw: string): string | null {
  const s = raw.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s)
  if (m) return valid(`${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`)
  m = /^(\d{1,2})[\s/-]([A-Za-z]{3})[a-z]*[\s/-](\d{2,4})$/.exec(s)
  if (m && MONTHS[m[2].toLowerCase()]) return valid(`${m[3].length === 2 ? `20${m[3]}` : m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`)
  return null
}
const valid = (d: string) => (Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d ? null : d)

/** "1,23,456.78", "(500.00)", "₹ 1,000", "" → paise. */
export function statementAmount(raw: string | undefined): number {
  if (!raw) return 0
  let s = raw.replace(/[₹,\s]|INR|Rs\.?/gi, '')
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-')
  s = s.replace(/[()\-+]/g, '')
  if (!s || Number.isNaN(Number(s))) return 0
  return Math.round(Number(s) * 100) * (neg ? -1 : 1)
}

export function parseStatement(text: string): { lines: StatementLine[]; skipped: number; columns: Record<string, string> } {
  const rows = csvRows(text.replace(/^﻿/, ''))
  const isHeader = (r: string[]) => { const h = r.map((x) => x.trim().toLowerCase()); return h.some((x) => /date/.test(x)) && h.some((x) => /debit|withdrawal|credit|deposit|amount/.test(x)) }
  const hi = rows.findIndex(isHeader)
  if (hi < 0) throw new Error('Could not find the header row (Date, Narration, Withdrawal / Deposit or Debit / Credit, Balance).')
  const head = rows[hi].map((x) => x.trim().toLowerCase())
  const find = (re: RegExp, not?: RegExp) => head.findIndex((h) => re.test(h) && !(not?.test(h)))
  let date = find(/^(txn|tran|transaction|posting)\s*date/)
  if (date < 0) date = find(/date/, /value/)
  if (date < 0) date = find(/date/)
  const desc = find(/narration|description|particulars|remarks|details/)
  const ref = find(/ref|chq|cheque|utr/)
  const debit = find(/debit|withdrawal|\bdr\b/, /credit|balance|dr\s*\/\s*cr|cr\s*\/\s*dr/)
  const credit = find(/credit|deposit|\bcr\b/, /debit|balance|dr\s*\/\s*cr|cr\s*\/\s*dr/)
  const amount = find(/^amount/)
  const drcr = find(/dr\s*\/\s*cr|^type$|cr\/dr/)
  const balance = find(/balance/)
  if (desc < 0 || (debit < 0 && credit < 0 && amount < 0)) throw new Error('The statement needs a narration column and withdrawal / deposit (or amount) columns.')
  const lines: StatementLine[] = []
  let skipped = 0
  for (const r of rows.slice(hi + 1)) {
    const d = statementDate(r[date] ?? '')
    if (!d) { skipped++; continue }
    let amt = 0
    if (debit >= 0 || credit >= 0) amt = statementAmount(r[credit]) - statementAmount(r[debit])
    else {
      amt = statementAmount(r[amount])
      if (drcr >= 0 && /^d/i.test((r[drcr] ?? '').trim())) amt = -Math.abs(amt)
    }
    if (!amt) { skipped++; continue }
    lines.push({ date: d, description: (r[desc] ?? '').trim().replace(/\s+/g, ' '), reference: ref >= 0 && ref !== desc ? (r[ref] ?? '').trim() || null : null, amountPaise: amt,
      balancePaise: balance >= 0 && (r[balance] ?? '').trim() ? statementAmount(r[balance]) : null })
  }
  return { lines, skipped, columns: Object.fromEntries(Object.entries({ date, desc, ref, debit, credit, amount, balance }).filter(([, i]) => i >= 0).map(([k, i]) => [k, rows[hi][i].trim()])) }
}
