import { fileURLToPath } from 'node:url'
import { loadTaxConfig } from '@sathya/tax'
import { buildApp } from './app'
import { loadRolesConfig, syncRoles } from './context'
import { migrate, openPglite, openPostgres } from './db'
import { normaliseMobile } from './routes/auth'
import { seed } from './seed'
import { ensureSiteLayout } from './routes/site'
import { ensureRestaurant } from './fnb-seed'
import { ensureLiquorClasses } from './routes/settings'
import { ensureBarStock } from './routes/bar'
import { ensureRecipes } from './routes/kitchen-stock'

// DATABASE_URL set → PostgreSQL (production). Otherwise a local PGlite database in ./data.
// MD_MOBILE gives the Managing Director's login its mobile number on first start.
const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite(process.env.PGLITE_DIR ?? './data')
const applied = await migrate(db)
const mdMobile = process.env.MD_MOBILE ? normaliseMobile(process.env.MD_MOBILE) : undefined
const seeded = await seed(db, { mdMobile })
await syncRoles(db, loadRolesConfig())
if (mdMobile) await db.query(`update app_user set mobile = $1 where id = 'u-md' and mobile is null`, [mdMobile])
await ensureSiteLayout(db)
await ensureLiquorClasses(db, { tax: loadTaxConfig() })
await ensureRestaurant(db)
await ensureBarStock(db)
await ensureRecipes(db)
const app = buildApp(db, { logger: true, printAgentKey: process.env.PRINT_AGENT_KEY || undefined, appDir: process.env.APP_DIR ?? fileURLToPath(new URL('../../dist/', import.meta.url)) })
app.log.info({ engine: db.engine, migrationsApplied: applied, seeded }, 'database ready')
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) })
