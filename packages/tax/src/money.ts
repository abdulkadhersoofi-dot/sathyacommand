// All money is integer paise, so tax maths never drifts on floating point.

export type Paise = number

export const rupees = (r: number): Paise => Math.round(r * 100)

/** `rate` percent of `amount`, rounded half-up to the paisa. Rates like 0.1 and 0.5 are exact. */
export const pct = (amount: Paise, rate: number): Paise =>
  Math.round((amount * Math.round(rate * 1000)) / 100000)

/** Tax contained in a tax-inclusive amount (e.g. an advance received). */
export const taxInside = (inclusive: Paise, rate: number): Paise =>
  Math.round((inclusive * rate) / (100 + rate))

export const formatInr = (p: Paise) =>
  '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
