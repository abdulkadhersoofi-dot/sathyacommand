import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { autoCloseDays } from '../src/routes/nightaudit'
import { testResort } from './helpers'

// The hotel's business day moves on by itself at the day-close time when nobody closed it, catching up any
// days missed; the date endpoint gives the calendar date beside it so the app can say when they differ.

let R: Awaited<ReturnType<typeof testResort>>
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
// The clock jumps by hours, so the MD signs in afresh each time.
const md = async () => (await R.signIn('md@sathya.test', 'own-first-md-pass-pass')).json().token as string
const date = async () => (await R.get('/api/business-date', await md())).json()

beforeAll(async () => { R = await testResort('2026-10-20') }, 60_000)
afterAll(() => R.close())

describe('closing the day by itself', () => {
  it('waits for the close time, then closes the day as the automatic closer', async () => {
    expect(await date()).toMatchObject({ businessDate: '2026-10-20', calendarDate: '2026-10-20', autoClose: true, dayCloseAt: '03:00', closesAt: '2026-10-20T21:30:00.000Z' })
    R.advance(16 * 60)                                        // 01:00 on the 21st: not yet
    expect(await autoCloseDays(R.app.hms)).toBe(0)
    expect(await date()).toMatchObject({ businessDate: '2026-10-20', calendarDate: '2026-10-21' })
    R.advance(2 * 60 + 1)                                     // 03:01
    expect(await autoCloseDays(R.app.hms)).toBe(1)
    expect((await date()).businessDate).toBe('2026-10-21')
    const [a] = await R.db.query<{ action: string; actor_name: string }>(`select action, entry->'actor'->>'name' as actor_name from audit_log where action like 'night_audit%' order by seq desc limit 1`)
    expect(a).toMatchObject({ action: 'night_audit.auto', actor_name: 'Automatic day close' })
  })

  it('catches up days nobody closed, and stops when switched off', async () => {
    R.advance(3 * 24 * 60)                                    // 03:01 on the 24th
    expect(await autoCloseDays(R.app.hms)).toBe(3)
    expect((await date()).businessDate).toBe('2026-10-24')
    expect((await patch('/api/property', await md(), { autoClose: false })).statusCode).toBe(200)
    R.advance(24 * 60)
    expect(await autoCloseDays(R.app.hms)).toBe(0)
    expect((await R.post('/api/night-audit', await md())).json().nextBusinessDate).toBe('2026-10-25')   // closing by hand still works
  })
})
