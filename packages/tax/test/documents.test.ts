import { describe, expect, it } from 'vitest'
import { amountInWords, documentNumber, inWords, validateGstin } from '../src'

describe('GSTIN', () => {
  it('accepts valid GSTINs (published examples)', () => {
    expect(validateGstin('27AAPFU0939F1ZV')).toMatchObject({ ok: true, stateCode: '27', state: 'Maharashtra' })
    expect(validateGstin(' 29aagcb7383j1z4 ')).toMatchObject({ ok: true, gstin: '29AAGCB7383J1Z4' })
  })
  it('rejects a typing mistake through the check character', () => {
    expect(validateGstin('27AAPFU0939F1ZW')).toMatchObject({ ok: false })
    expect(validateGstin('27AAPFU0938F1ZV')).toMatchObject({ ok: false })
  })
  it('rejects wrong shapes and unknown states', () => {
    expect(validateGstin('33AAACS1234A1Z')).toMatchObject({ ok: false })
    expect(validateGstin('99AAACS1234A1Z9')).toMatchObject({ ok: false })
  })
})

describe('document numbers', () => {
  it('fits the 16-character GST limit', () => {
    expect(documentNumber('SPR', '2026-27', 123)).toBe('SPR/26-27/000123')
    expect(() => documentNumber('SATHYA', '2026-27', 1)).toThrow()
  })
})

describe('amount in words', () => {
  it('uses the Indian system', () => {
    expect(inWords(12_34_56_789)).toBe('Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine')
    expect(amountInWords(705640)).toBe('Rupees Seven Thousand Fifty-Six and Forty Paise Only')
    expect(amountInWords(10000000)).toBe('Rupees One Lakh Only')
  })
})
