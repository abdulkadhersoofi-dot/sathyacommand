import { buildApp } from './app'
import { migrate, openPglite, openPostgres } from './db'
import { seed } from './seed'

// DATABASE_URL set → PostgreSQL (production). Otherwise a local PGlite database in ./data.
const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite(process.env.PGLITE_DIR ?? './data')
const applied = await migrate(db)
const seeded = await seed(db)
const app = buildApp(db, { logger: true })
app.log.info({ engine: db.engine, migrationsApplied: applied, seeded }, 'database ready')
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) })
