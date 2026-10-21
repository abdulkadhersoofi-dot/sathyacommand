import { fileURLToPath } from 'node:url'
import { loadTaxConfig } from '@sathya/tax'
import { buildApp } from './app'
import { loadRolesConfig, syncRoles } from './context'
import { migrate, openPglite, openPostgres } from './db'
import { normaliseMobile } from './routes/auth'
import { ensureMdLogin } from './password'
import { seed } from './seed'
import { ensureSiteLayout } from './routes/site'
import { ensureRestaurant } from './fnb-seed'
import { ensureLiquorClasses } from './routes/settings'
import { ensureBarStock } from './routes/bar'
import { ensureRecipes } from './routes/kitchen-stock'
import { ensureRoomHk } from './hk-core'
import { ensureLinenLaundryAreas } from './routes/linen-laundry'
import { ensureStores } from './routes/stores'
import { ensureChart, postPending } from './ledger'
import { ensureEngineering, sweepEngineering } from './eng-core'
import { sweepSecurity } from './routes/security'
import { sweepPayables } from './routes/payables'
import { ensureBanquets } from './banquets'
import { sweepBlocks } from './sales'
import { paymentProviderFromEnv, sweepUnpaid } from './channels'
import { ensureActivities, planMessages, sendDue } from './guest'
import { ensureHolidays, loadPayrollConfig } from './hr'
import { businessDate } from './fo-core'

// DATABASE_URL set → PostgreSQL (production). Otherwise a local PGlite database in ./data.
// MD_EMAIL and MD_PASSWORD give the Managing Director's login its email and first password (changed at the first
// sign-in; MD_PASSWORD_RESET=yes sets it again, for a forgotten password). MD_MOBILE is optional, for SMS codes later.
const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite(process.env.PGLITE_DIR ?? './data')
const applied = await migrate(db)
const mdMobile = process.env.MD_MOBILE ? normaliseMobile(process.env.MD_MOBILE) : undefined
const seeded = await seed(db, { mdMobile })
await syncRoles(db, loadRolesConfig())
if (mdMobile) await db.query(`update app_user set mobile = $1 where id = 'u-md' and mobile is null`, [mdMobile])
await ensureMdLogin(db, { email: process.env.MD_EMAIL, password: process.env.MD_PASSWORD, reset: /^(1|yes|true)$/i.test(process.env.MD_PASSWORD_RESET ?? '') })
await ensureSiteLayout(db)
await ensureLiquorClasses(db, { tax: loadTaxConfig() })
await ensureRestaurant(db)
await ensureBarStock(db)
await ensureRecipes(db)
await ensureRoomHk(db)
await ensureLinenLaundryAreas(db)
await ensureEngineering(db)
await ensureStores(db)
await ensureChart(db)
await ensureBanquets(db)
await ensureActivities(db)
await ensureHolidays(db, loadPayrollConfig(), [new Date().getFullYear(), new Date().getFullYear() + 1])
const app = buildApp(db, { logger: true, printAgentKey: process.env.PRINT_AGENT_KEY || undefined, payments: paymentProviderFromEnv(), channelKey: process.env.CHANNEL_KEY || undefined, appDir: process.env.APP_DIR ?? fileURLToPath(new URL('../../dist/', import.meta.url)) })
app.log.info({ engine: db.engine, migrationsApplied: applied, seeded }, 'database ready')
// Escalations, planned maintenance, expiry reminders, missed patrols and keys not returned, once a minute.
setInterval(() => {
  sweepEngineering(db, new Date()).catch((e) => app.log.error(e))
  sweepSecurity(db, new Date()).catch((e) => app.log.error(e))
  sweepPayables(db, new Date()).catch((e) => app.log.error(e))
  postPending(db, new Date()).catch((e) => app.log.error(e))
  db.tx(async (t) => sweepBlocks(t, await businessDate(t), null, new Date())).catch((e) => app.log.error(e))
  sweepUnpaid(db, new Date()).catch((e) => app.log.error(e))
  planMessages(db, new Date()).then(() => sendDue(db, undefined, new Date())).catch((e) => app.log.error(e))
}, 60_000)
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) })
