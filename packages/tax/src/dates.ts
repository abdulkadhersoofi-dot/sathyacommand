// Calendar dates as YYYY-MM-DD strings; arithmetic in UTC so time zones never shift a day.

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Indian financial year label for a date, e.g. 2026-10-19 → "2026-27". */
export function financialYear(date: string): string {
  const [y, m] = date.split('-').map(Number)
  const start = m >= 4 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}
