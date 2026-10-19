import { buildApp } from './app'
import { loadRolesConfig, syncRoles } from './context'
import { migrate, openPglite, openPostgres } from './db'
import { normaliseMobile } from './routes/auth'
import { seed } from './seed'

// DATABASE_URL set → PostgreSQL (production). Otherwise a local PGlite database in ./data.
// MD_MOBILE gives the Managing Director's login its mobile number on first start.
const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite(process.env.PGLITE_DIR ?? './data')
const applied = await migrate(db)
const mdMobile = process.env.MD_MOBILE ? normaliseMobile(process.env.MD_MOBILE) : undefined
const seeded = await seed(db, { mdMobile })
await syncRoles(db, loadRolesConfig())
if (mdMobile) await db.query(`update app_user set mobile = $1 where id = 'u-md' and mobile is null`, [mdMobile])
const app = buildApp(db, { logger: true })
app.log.info({ engine: db.engine, migrationsApplied: applied, seeded }, 'database ready')
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) })
