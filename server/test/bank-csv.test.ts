import { describe, expect, it } from 'vitest'
import { parseStatement, statementAmount, statementDate } from '../src/bank-csv'

// Bank statements as the banks' websites export them: different columns, dates and number formats.

describe('reading a bank statement', () => {
  it('reads dates and amounts the way Indian banks write them', () => {
    expect(['02/11/2026', '2-11-26', '2026-11-02', '02-Nov-2026', '2 Nov 2026', '02 November 2026'].map(statementDate)).toEqual(Array(6).fill('2026-11-02'))
    expect(statementDate('31/02/2026')).toBeNull()
    expect(statementDate('Opening Balance')).toBeNull()
    expect(['1,23,456.78', '(500.00)', '₹ 1,000', 'INR 50', '', '-12.5'].map(statementAmount)).toEqual([12345678, -50000, 100000, 5000, 0, -1250])
  })

  it('finds the header under the bank\'s preamble, with withdrawal and deposit columns', () => {
    const csv = `State Bank of India,,,,,,
Account Number,00000012345678901,,,,,
Txn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance
01 Nov 2026,01 Nov 2026,"BY TRANSFER-NEFT-TVS LOGISTICS, BLR",UTR123,,"5,000.00","1,05,000.00"
02 Nov 2026,02 Nov 2026,SMS CHARGES,,17.70,,"1,04,982.30"
,,Closing balance,,,,"1,04,982.30"`
    const r = parseStatement(csv)
    expect(r.lines).toEqual([
      { date: '2026-11-01', description: 'BY TRANSFER-NEFT-TVS LOGISTICS, BLR', reference: 'UTR123', amountPaise: 500000, balancePaise: 10500000 },
      { date: '2026-11-02', description: 'SMS CHARGES', reference: null, amountPaise: -1770, balancePaise: 10498230 },
    ])
    expect(r.skipped).toBe(1)
    expect(r.columns).toMatchObject({ date: 'Txn Date', debit: 'Debit', credit: 'Credit' })
  })

  it('reads one amount column with Dr / Cr', () => {
    const r = parseStatement('Date,Narration,Chq/Ref No,Amount,Dr/Cr,Balance\n03/11/26,POS SETTLEMENT HDFC,,410.50,CR,1000\n04/11/26,CHQ 004512 KUMAR,004512,"1,500.00",DR,-500')
    expect(r.lines.map((l) => [l.date, l.amountPaise, l.reference])).toEqual([['2026-11-03', 41050, null], ['2026-11-04', -150000, '004512']])
  })

  it('says what it could not find', () => {
    expect(() => parseStatement('a,b\n1,2')).toThrow(/header row/)
  })
})
