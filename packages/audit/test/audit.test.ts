import { describe, expect, it } from 'vitest'
import { AuditLog, verifyChain, type AuditEntry } from '../src'

const captain = { userId: 'u17', name: 'Ravi K', role: 'captain', deviceId: 'tab-03' }
const md = { userId: 'u1', name: 'MD', role: 'managing_director' }

function sampleLog() {
  let t = Date.parse('2026-11-14T19:00:00Z')
  const log = new AuditLog(() => new Date((t += 60_000)))
  log.append({ actor: captain, action: 'kot.create', entity: { type: 'kot', id: 'KOT-1114-101' }, after: { items: 2 }, amount: 76000 })
  log.append({ actor: captain, action: 'kot.void_after_print', entity: { type: 'kot', id: 'KOT-1114-101' }, before: { items: 2 }, after: { items: 1 }, amount: -38000, note: 'Guest changed mind' })
  log.append({ actor: md, action: 'user.lock', entity: { type: 'user', id: 'u17' } })
  return log
}

const tamper = (entries: readonly AuditEntry[], i: number, patch: Partial<AuditEntry>) =>
  entries.map((e, k) => (k === i ? { ...e, ...patch } : e))

describe('God Mode audit log', () => {
  it('hashes dates the same way before and after storage', () => {
    const log = new AuditLog()
    const e = log.append({ actor: md, action: 'room.update', entity: { type: 'room', id: 'RM-1' }, before: { updated_at: new Date('2026-11-01T00:00:00Z') } })
    const roundTripped = JSON.parse(JSON.stringify(e))
    expect(verifyChain([roundTripped])).toEqual({ ok: true })
  })

  it('chains entries and verifies a clean log', () => {
    const log = sampleLog()
    const all = log.all()
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(all[1].prevHash).toBe(all[0].hash)
    expect(verifyChain(all)).toEqual({ ok: true })
  })

  it('entries cannot be edited in memory', () => {
    const e = sampleLog().all()[0]
    expect(() => { (e as { note?: string }).note = 'x' }).toThrow(TypeError)
  })

  it('detects a changed amount', () => {
    const r = verifyChain(tamper(sampleLog().all(), 1, { amount: -1000 }))
    expect(r).toMatchObject({ ok: false, brokenAt: 2, reason: 'Entry content was changed' })
  })

  it('detects a deleted entry', () => {
    const all = sampleLog().all()
    expect(verifyChain([all[0], all[2]])).toMatchObject({ ok: false, brokenAt: 2 })
  })

  it('detects a rewritten entry even if its own hash is recomputed', () => {
    const all = [...sampleLog().all()]
    const forged = new AuditLog()
    forged.append({ ...all[0] })
    const second = forged.append({ actor: captain, action: 'kot.create', entity: { type: 'kot', id: 'X' } })
    const r = verifyChain([all[0], second, all[2]])
    expect(r.ok).toBe(false)
  })

  it('detects a fully rebuilt chain against the nightly anchor', () => {
    const real = sampleLog()
    const anchor = { seq: 3, hash: real.head() }
    const rebuilt = new AuditLog()
    for (const e of real.all()) rebuilt.append({ actor: e.actor, action: e.action, entity: e.entity, note: 'rewritten' })
    expect(verifyChain(rebuilt.all())).toEqual({ ok: true })
    expect(verifyChain(rebuilt.all(), anchor)).toMatchObject({ ok: false, reason: 'Does not match the nightly anchor copy' })
  })
})
