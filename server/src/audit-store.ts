import { buildEntry, verifyChain, type AuditEntry, type AuditInput } from '@sathya/audit'
import { EventEmitter } from 'node:events'
import type { Db } from './db'

// Persists the God Mode chain. A transaction-scoped advisory lock serialises appends,
// so two actions at the same instant can never claim the same sequence number.

const AUDIT_LOCK = 7_301_001

/** Every logged action is also announced here, so live screens (3D dashboard, God Mode) can refresh. */
export const auditBus = new EventEmitter()
auditBus.setMaxListeners(500)
export interface LiveEvent { seq: number; at: string; action: string; entity: { type: string; id: string }; actor: string; amount?: number }

export async function appendAudit(db: Db, input: AuditInput, at = new Date()): Promise<AuditEntry> {
  return db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock($1)', [AUDIT_LOCK])
    const [last] = await t.query<{ seq: number; hash: string }>('select seq, hash from audit_log order by seq desc limit 1')
    const entry = buildEntry(last ?? null, input, at)
    const { hash, ...hashed } = entry
    await t.query(
      `insert into audit_log (seq, at, actor_id, action, entity_type, entity_id, amount_paise, entry, prev_hash, hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [entry.seq, entry.at, entry.actor.userId, entry.action, entry.entity.type, entry.entity.id,
        entry.amount ?? null, JSON.stringify(hashed), entry.prevHash, hash],
    )
    return entry
  }).then((entry) => {
    auditBus.emit('event', { seq: entry.seq, at: entry.at, action: entry.action, entity: entry.entity, actor: entry.actor.name, amount: entry.amount } satisfies LiveEvent)
    return entry
  })
}

export async function readAudit(db: Db, opts: { limit?: number; entityId?: string; actorId?: string } = {}): Promise<AuditEntry[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.entityId) { params.push(opts.entityId); where.push(`entity_id = $${params.length}`) }
  if (opts.actorId) { params.push(opts.actorId); where.push(`actor_id = $${params.length}`) }
  params.push(opts.limit ?? 100)
  const rows = await db.query<{ entry: Omit<AuditEntry, 'hash'>; hash: string }>(
    `select entry, hash from audit_log ${where.length ? 'where ' + where.join(' and ') : ''} order by seq desc limit $${params.length}`,
    params,
  )
  return rows.map((r) => ({ ...r.entry, hash: r.hash }))
}

export async function verifyStoredChain(db: Db) {
  const rows = await db.query<{ entry: Omit<AuditEntry, 'hash'>; hash: string }>('select entry, hash from audit_log order by seq')
  const result = verifyChain(rows.map((r) => ({ ...r.entry, hash: r.hash })))
  return { ...result, entries: rows.length }
}
