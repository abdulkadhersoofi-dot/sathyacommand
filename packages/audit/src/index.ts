import { createHash } from 'node:crypto'

// God Mode log: append-only and tamper-evident. Each entry stores the hash of the entry
// before it, so editing, deleting or reordering any past entry breaks every hash after it.

export interface Actor { userId: string; name: string; role: string; deviceId?: string }

export interface AuditInput {
  actor: Actor
  action: string                         // e.g. "kot.void", "reservation.check_in"
  entity: { type: string; id: string }   // what was acted on
  before?: unknown
  after?: unknown
  location?: { lat?: number; lng?: number; zone?: string }
  amount?: number                        // paise, when money is involved
  note?: string
}

export interface AuditEntry extends AuditInput {
  seq: number
  at: string        // ISO time, server clock
  prevHash: string
  hash: string
}

export const GENESIS = '0'.repeat(64)

/** JSON with sorted keys at every level, so the same entry always hashes the same way. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}

export function hashEntry(e: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonical(e)).digest('hex')
}

/** Builds the next entry after `prev` (null for the first). Shared by the in-memory log and the database store. */
export function buildEntry(prev: { seq: number; hash: string } | null, input: AuditInput, at: Date): AuditEntry {
  const base = { ...input, seq: (prev?.seq ?? 0) + 1, at: at.toISOString(), prevHash: prev?.hash ?? GENESIS }
  return Object.freeze({ ...base, hash: hashEntry(base) })
}

export class AuditLog {
  private entries: AuditEntry[] = []
  private clock: () => Date

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock
  }

  append(input: AuditInput): AuditEntry {
    const entry = buildEntry(this.entries[this.entries.length - 1] ?? null, input, this.clock())
    this.entries.push(entry)
    return entry
  }

  all(): readonly AuditEntry[] { return this.entries }

  /** The newest hash; storing a copy of it elsewhere each night anchors the whole chain. */
  head(): string { return this.entries[this.entries.length - 1]?.hash ?? GENESIS }
}

export interface VerifyResult { ok: boolean; brokenAt?: number; reason?: string }

/** Checks a chain from the start; reports the first entry that doesn't match. */
export function verifyChain(entries: readonly AuditEntry[], anchor?: { seq: number; hash: string }): VerifyResult {
  let prev = GENESIS
  for (let i = 0; i < entries.length; i++) {
    const { hash, ...rest } = entries[i]
    if (rest.seq !== i + 1) return { ok: false, brokenAt: i + 1, reason: 'Entry missing or out of order' }
    if (rest.prevHash !== prev) return { ok: false, brokenAt: rest.seq, reason: 'Link to previous entry broken' }
    if (hashEntry(rest) !== hash) return { ok: false, brokenAt: rest.seq, reason: 'Entry content was changed' }
    prev = hash
  }
  if (anchor) {
    const e = entries[anchor.seq - 1]
    if (!e || e.hash !== anchor.hash) return { ok: false, brokenAt: anchor.seq, reason: 'Does not match the nightly anchor copy' }
  }
  return { ok: true }
}
