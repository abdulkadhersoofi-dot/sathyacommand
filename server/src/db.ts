import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { PGlite, types } from '@electric-sql/pglite'

// One small interface over two engines: real PostgreSQL in production (DATABASE_URL),
// and PGlite (Postgres compiled to WebAssembly) for local runs and tests.

export interface Db {
  readonly engine: 'postgres' | 'pglite'
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  exec(sql: string): Promise<void>
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

const toNumber = (v: string) => Number(v)

interface LiteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  exec(sql: string): Promise<unknown>
}

export async function openPglite(dataDir?: string): Promise<Db> {
  const lite = new PGlite(dataDir, { parsers: { [types.INT8]: toNumber } })
  await lite.waitReady
  const wrap = (q: LiteLike): Omit<Db, 'tx' | 'close'> => ({
    engine: 'pglite',
    query: async (sql, params) => (await q.query(sql, params)).rows as never,
    exec: async (sql) => { await q.exec(sql) },
  })
  return {
    ...wrap(lite),
    tx: async (fn) => {
      let out!: Awaited<ReturnType<typeof fn>>
      await lite.transaction(async (t) => {
        const inner: Db = { ...wrap(t), tx: (f) => f(inner), close: async () => {} }
        out = await fn(inner)
      })
      return out
    },
    close: () => lite.close(),
  }
}

export async function openPostgres(url: string): Promise<Db> {
  pg.types.setTypeParser(20, toNumber)
  const pool = new pg.Pool({ connectionString: url })
  const make = (client: pg.Pool | pg.PoolClient): Omit<Db, 'tx' | 'close'> => ({
    engine: 'postgres',
    query: async (sql, params) => (await client.query(sql, params as unknown[])).rows,
    exec: async (sql) => { await client.query(sql) },
  })
  return {
    ...make(pool),
    async tx(fn) {
      const c = await pool.connect()
      try {
        await c.query('begin')
        const inner: Db = { ...make(c), tx: (f) => f(inner), close: async () => {} }
        const out = await fn(inner)
        await c.query('commit')
        return out
      } catch (e) {
        await c.query('rollback')
        throw e
      } finally {
        c.release()
      }
    },
    close: () => pool.end(),
  }
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

/** Applies migrations/*.sql in name order, once each. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())')
  const done = new Set((await db.query<{ name: string }>('select name from schema_migrations')).map((r) => r.name))
  const applied: string[] = []
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue
    await db.tx(async (t) => {
      await t.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'))
      await t.query('insert into schema_migrations (name) values ($1)', [file])
    })
    applied.push(file)
  }
  return applied
}
