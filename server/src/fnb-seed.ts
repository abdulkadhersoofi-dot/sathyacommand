import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rupees } from '@sathya/tax'
import type { Db } from './db'

// Outlets, kitchen and bar stations, tables and a placeholder menu, so the restaurant works on a fresh
// database. The real menu comes from the Champagne export through POST /api/fnb/menu/import.

export const STATIONS = [
  { id: 'SI', name: 'South Indian', kind: 'kitchen' },
  { id: 'NI', name: 'North Indian & Tandoor', kind: 'kitchen' },
  { id: 'CH', name: 'Chinese', kind: 'kitchen' },
  { id: 'DS', name: 'Desserts', kind: 'kitchen' },
  { id: 'BV', name: 'Beverages', kind: 'kitchen' },
  { id: 'BAR', name: 'Bar', kind: 'bar' },
]

const OUTLETS = [
  { id: 'DINE', name: 'Sathya Dine', kind: 'restaurant', space: 'RESTAURANT', liquor: true, tables: { prefix: 'T', n: 20, sections: ['Hall', 'Hall', 'Hall', 'Veranda'] } },
  { id: 'IRD', name: 'Room Service', kind: 'room_service', space: 'KITCHEN', liquor: false },
  { id: 'BAR', name: 'Bar', kind: 'bar', space: 'BAR', liquor: true, tables: { prefix: 'B', n: 8, sections: ['Bar'] } },
  { id: 'POOL', name: 'Poolside', kind: 'poolside', space: 'POOL', liquor: true, tables: { prefix: 'P', n: 6, sections: ['Pool deck'] } },
]

export async function ensureRestaurant(db: Db) {
  const [{ n }] = await db.query<{ n: number }>('select count(*)::int as n from outlet')
  if (n > 0) return
  const spaces = new Set((await db.query<{ id: string }>('select id from space')).map((s) => s.id))
  const now = new Date()
  await db.tx(async (t) => {
    for (const s of STATIONS) await t.query('insert into station (id, name, kind) values ($1, $2, $3)', [s.id, s.name, s.kind])
    for (const o of OUTLETS) {
      await t.query('insert into outlet (id, name, kind, space_id, serves_liquor) values ($1, $2, $3, $4, $5)',
        [o.id, o.name, o.kind, spaces.has(o.space) ? o.space : null, o.liquor])
      for (let i = 1; i <= (o.tables?.n ?? 0); i++) {
        const sec = o.tables!.sections[Math.floor(((i - 1) / o.tables!.n) * o.tables!.sections.length)]
        await t.query('insert into dining_table (id, outlet_id, label, seats, section) values ($1, $2, $3, $4, $5)',
          [`${o.id}-${o.tables!.prefix}${i}`, o.id, `${o.tables!.prefix}${i}`, i % 5 === 0 ? 6 : 4, sec])
      }
    }
    const rows = readFileSync(fileURLToPath(new URL('../seed/menu.placeholder.csv', import.meta.url)), 'utf8').trim().split('\n').slice(1)
    const cats = new Map<string, string>()
    let sort = 0
    for (const line of rows) {
      const [outlets, category, code, name, nameTa, price, station, diet, liquor, allergens] = line.split(',')
      for (const outlet of outlets.split('|')) {
        const catKey = `${outlet}/${category}`
        if (!cats.has(catKey)) {
          cats.set(catKey, `${outlet}-${category.replace(/[^A-Za-z]+/g, '').toUpperCase()}`)
          await t.query('insert into menu_category (id, outlet_id, name, sort) values ($1, $2, $3, $4)', [cats.get(catKey), outlet, category, sort++])
        }
        await t.query(
          `insert into menu_item (id, outlet_id, category_id, code, name, name_ta, price_paise, liquor_class, station_id, diet, allergens, placeholder, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12)`,
          [`${outlet}-${code}`, outlet, cats.get(catKey), code, name, nameTa || null, rupees(Number(price)), liquor || null, station, diet,
            allergens ? allergens.split('|') : [], now])
      }
    }
  })
}
