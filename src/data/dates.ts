// Dates are local-calendar "YYYY-MM-DD" keys; they compare correctly as strings.

export const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// In live mode "today" is the hotel's business date (it changes at night audit, not at midnight).
let businessToday: string | null = null
export const setToday = (key: string | null) => { businessToday = key }
export const todayKey = () => businessToday ?? dateKey(new Date())

export function addDays(key: string, n: number) {
  const d = new Date(key + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return dateKey(d)
}

export const fmtDay = (key: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(key + 'T12:00:00').toLocaleDateString('en-IN', opts)

export const fmtTime = (isoOrHm?: string) => {
  if (!isoOrHm) return '—'
  if (/^\d\d:\d\d$/.test(isoOrHm)) return isoOrHm
  return new Date(isoOrHm).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export const minutesSince = (iso: string) => Math.round((Date.now() - new Date(iso).getTime()) / 60000)

export const inr = (n: number) =>
  n >= 100000 ? `₹${(n / 100000).toFixed(n >= 1000000 ? 1 : 2)}L` : `₹${n.toLocaleString('en-IN')}`
