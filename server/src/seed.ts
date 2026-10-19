import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadTaxConfig, priceGuard, rupees } from '@sathya/tax'
import { appendAudit } from './audit-store'
import { loadRolesConfig, syncRoles } from './context'
import type { Db } from './db'

// First-run data. Rooms come from seed/rooms.placeholder.csv until the resort's real
// room list replaces it; every placeholder row is flagged so it can't be mistaken for real data.

const seedFile = (name: string) => fileURLToPath(new URL(`../seed/${name}`, import.meta.url))
const PROPERTY = 'sathya'
const SYSTEM = { userId: 'system', name: 'System', role: 'system' }

const ROOM_TYPES = [
  { id: 'deluxe', name: 'Deluxe Room', rate: 4200, occ: 3 },
  { id: 'premium', name: 'Premium Room', rate: 5800, occ: 3 },
  { id: 'villa', name: 'Garden Villa', rate: 7000, occ: 4 },
  { id: 'suite', name: 'Suite', rate: 7500, occ: 4 },
]

// Venues and outlets traced from the satellite image (Phase 1); capacities to confirm in Phase 0.
const PLACES = [
  { id: 'HALL-JSH', kind: 'hall', name: 'A. John Samuel Hall', capacity: 600 },
  { id: 'CONV-HALL', kind: 'hall', name: 'Convention Hall', capacity: 1000 },
  { id: 'LAWN-GRAND', kind: 'lawn', name: 'Grand Lawn', capacity: 1200 },
  { id: 'LAWN-GARDEN', kind: 'lawn', name: 'Garden Lawn', capacity: 250 },
  { id: 'PAVILION', kind: 'pavilion', name: 'Pavilion', capacity: 150 },
  { id: 'GROUND-CRICKET', kind: 'ground', name: 'Cricket Ground', capacity: 400 },
  { id: 'GROUND-NORTH', kind: 'ground', name: 'North Ground', capacity: 2000 },
  { id: 'RESTAURANT', kind: 'restaurant', name: 'Sathya Dine', capacity: 80 },
  { id: 'KITCHEN', kind: 'kitchen', name: 'Main Kitchen' },
  { id: 'BAR', kind: 'bar', name: 'Bar' },
  { id: 'RECEPTION', kind: 'reception', name: 'Reception & Lobby' },
  { id: 'POOL', kind: 'pool', name: 'Pool & Deck', capacity: 40 },
  { id: 'SERVICE', kind: 'service', name: 'Service Block' },
  { id: 'OFFICE', kind: 'office', name: 'Admin Office' },
]

const RATE_PLANS = [
  { code: 'EP', name: 'Room only', meal: 'EP', add: 0 },
  { code: 'CP', name: 'Room with breakfast', meal: 'CP', add: 600 },
  { code: 'MAP', name: 'Breakfast and one meal', meal: 'MAP', add: 1200 },
  { code: 'AP', name: 'All meals', meal: 'AP', add: 1800 },
]

export async function seed(db: Db, opts: { today?: string; mdMobile?: string } = {}) {
  const [{ n }] = await db.query<{ n: number }>('select count(*)::int as n from property')
  if (n > 0) return { seeded: false }
  return db.tx((t) => seedInto(t, opts))     // all or nothing
}

async function seedInto(db: Db, opts: { today?: string; mdMobile?: string }) {
  const tax = loadTaxConfig()
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  const skipped: string[] = []

  await db.query(
    `insert into property (id, name, legal_name, entity_type, state_code) values ($1, $2, $3, $4, $5)`,
    [PROPERTY, 'Sathya Park & Resorts', null, 'private_limited_company', '33'],
  )
  for (const t of ROOM_TYPES) {
    await db.query('insert into room_type (id, property_id, name, base_rate_paise, max_occupancy) values ($1, $2, $3, $4, $5)',
      [t.id, PROPERTY, t.name, rupees(t.rate), t.occ])
  }

  const csv = readFileSync(seedFile('rooms.placeholder.csv'), 'utf8').trim().split('\n').slice(1)
  for (const line of csv) {
    const [roomNo, kind, type, building, floor, twin] = line.split(',')
    const label = kind === 'room' ? `Room ${roomNo}` : kind === 'villa' ? `Villa ${roomNo.slice(1)}` : `Suite ${roomNo.slice(1)}`
    await db.query(
      `insert into space (id, property_id, kind, name, room_no, room_type_id, building, floor, twin_id, sellable, placeholder)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, true)`,
      [`RM-${roomNo}`, PROPERTY, kind, label, roomNo, type, building, Number(floor), twin || null],
    )
  }
  for (const p of PLACES) {
    await db.query('insert into space (id, property_id, kind, name, capacity, twin_id) values ($1, $2, $3, $4, $5, $1)',
      [p.id, PROPERTY, p.kind, p.name, p.capacity ?? null])
  }

  // Rates: a plan is only priced for a room type if the night stays within the ₹7,500 guard,
  // because packages are taxed on their full value and would otherwise flip the restaurant to 18%.
  for (const plan of RATE_PLANS) {
    const planId = `${PROPERTY}-${plan.code}`
    await db.query('insert into rate_plan (id, property_id, code, name, meal_plan) values ($1, $2, $3, $4, $5)',
      [planId, PROPERTY, plan.code, plan.name, plan.meal])
    for (const t of ROOM_TYPES) {
      const amount = rupees(t.rate + plan.add)
      if (!priceGuard(tax, amount).allowed) { skipped.push(`${plan.code}/${t.id}`); continue }
      await db.query('insert into rate (rate_plan_id, room_type_id, valid_from, valid_to, amount_paise) values ($1, $2, $3, $4, $5)',
        [planId, t.id, today, '2027-03-31', amount])
    }
  }

  const roles = loadRolesConfig()
  await syncRoles(db, roles)
  await db.query(`insert into app_user (id, name, mobile) values ('u-md', 'Managing Director', $1)`, [opts.mdMobile ?? null])
  await db.query(`insert into user_role (user_id, role_id) values ('u-md', 'managing_director')`)

  await appendAudit(db, {
    actor: SYSTEM, action: 'system.seed', entity: { type: 'property', id: PROPERTY },
    after: { rooms: csv.length, places: PLACES.length, roles: Object.keys(roles.roles).length, ratesSkippedByGuard: skipped },
    note: 'Initial data. Room list is a placeholder until the resort provides the real one.',
  })
  return { seeded: true, rooms: csv.length, ratesSkippedByGuard: skipped }
}
