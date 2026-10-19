import { describe, expect, it } from 'vitest'
import { encode, preview, toAscii, twoCol, wrap } from '../src'

describe('ESC/POS', () => {
  it('spells out symbols the printer cannot print', () => {
    expect(toAscii('2 × Masala Dosa · ₹280 – less oil')).toBe('2 x Masala Dosa - Rs.280 - less oil')
    expect(toAscii('மசாலா தோசை Dosa')).toBe(' Dosa')
  })

  it('wraps to the paper width and lines up prices on the right', () => {
    expect(wrap('Paneer Butter Masala with extra gravy', 16)).toEqual(['Paneer Butter', 'Masala with', 'extra gravy'])
    expect(twoCol('Masala Dosa', '280.00', 24)).toEqual(['Masala Dosa       280.00'])
    expect(twoCol('Paneer Butter Masala Special', '320.00', 24)).toEqual(['Paneer Butter', 'Masala Special    320.00'])
  })

  it('encodes initialise, styles, text and a cut', () => {
    const b = encode({ width: 32, lines: [{ text: 'KOT 12', big: true, align: 'center' }, { text: '2 x Dosa', bold: true }] })
    expect([...b.slice(0, 2)]).toEqual([0x1b, 0x40])
    const s = Buffer.from(b).toString('latin1')
    expect(s).toContain('\x1ba\x01\x1bE\x00\x1d!\x11KOT 12\n')
    expect(s).toContain('\x1bE\x01\x1d!\x002 x Dosa\n')
    expect([...b.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00])
    expect(preview({ width: 20, lines: [{ text: 'Table 5', align: 'center' }] })).toBe('      Table 5')
  })
})
