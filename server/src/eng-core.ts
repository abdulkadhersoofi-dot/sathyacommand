import { randomUUID } from 'node:crypto'
import { appendAudit } from './audit-store'
import type { Caller } from './context'
import type { Db } from './db'
import { spacePosition } from './geo'

// Engineering: how fast a fault must be answered and fixed, the sweep that escalates late tickets,
// raises planned maintenance when due and reminds owners of expiring licences and contracts.

export type Priority = 'urgent' | 'high' | 'normal' | 'low'

/** Minutes to respond (someone takes it) and to resolve, by priority. */
export const SLA: Record<Priority, { respond: number; resolve: number }> = {
  urgent: { respond: 15, resolve: 4 * 60 },
  high: { respond: 60, resolve: 24 * 60 },
  normal: { respond: 4 * 60, resolve: 3 * 24 * 60 },
  low: { respond: 24 * 60, resolve: 7 * 24 * 60 },
}

export const CATEGORIES = ['ac', 'dg', 'pump', 'transformer', 'electrical', 'stp', 'pool', 'kitchen', 'cctv', 'lift', 'fire', 'plumbing', 'solar', 'laundry', 'vehicle', 'other'] as const

/** Starting checklists for planned maintenance, by kind of equipment (edited per plan). */
export const PM_TEMPLATES: Partial<Record<(typeof CATEGORIES)[number], { title: string; everyDays: number; checklist: string[] }>> = {
  ac: { title: 'AC service', everyDays: 90, checklist: ['Clean or wash filters', 'Clean indoor and outdoor coils', 'Check gas pressure', 'Clear the drain line', 'Check thermostat and remote', 'Note supply air temperature'] },
  dg: { title: 'DG set weekly check', everyDays: 7, checklist: ['Engine oil level', 'Coolant level', 'Battery voltage and terminals', 'Diesel level', 'Run 15 minutes on load', 'Log running hours'] },
  pump: { title: 'Pump check', everyDays: 30, checklist: ['Noise and vibration', 'Gland / seal leakage', 'Motor current within rating', 'Pressure switch working', 'Strainer cleaned'] },
  transformer: { title: 'Transformer check', everyDays: 30, checklist: ['Oil level', 'Silica gel colour', 'Oil and winding temperature', 'Earthing connections', 'No leaks'] },
  stp: { title: 'STP maintenance', everyDays: 7, checklist: ['Blowers and diffusers working', 'Screens cleaned', 'Sludge level checked', 'Chlorine dosing', 'Pumps and floats'] },
  pool: { title: 'Pool plant service', everyDays: 7, checklist: ['Backwash filter', 'Clean skimmer and pump baskets', 'Dosing pump working', 'Check pool lights', 'Vacuum floor'] },
  fire: { title: 'Fire extinguisher service', everyDays: 365, checklist: ['Pressure in the green', 'Seal and pin intact', 'Hose and nozzle', 'Refilled / hydro-tested if due', 'Tag updated'] },
  lift: { title: 'Lift service', everyDays: 30, checklist: ['Doors and sensors', 'Emergency alarm and phone', 'Brakes', 'Ropes and pulleys', 'Pit clean'] },
  kitchen: { title: 'Kitchen equipment check', everyDays: 30, checklist: ['Burners and gas lines', 'Exhaust hood and filters', 'Refrigeration temperatures', 'Door gaskets', 'Electrical cords'] },
  solar: { title: 'Solar panel cleaning', everyDays: 15, checklist: ['Panels cleaned', 'Inverter display normal', 'Cables and connectors', 'Note generation'] },
}

const SYSTEM: Caller = { userId: 'system', name: 'System', role: 'system', roles: [], godMode: false, permissions: new Set(), sessionId: '', scope: 'full' }
export const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
export const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10)
export const addDays = (day: string, n: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10)
export const daysBetween = (from: string, to: string) => Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000)

export interface NewTicket { kind: 'fault' | 'pm'; title: string; detail?: string | null; priority: Priority; assetId?: string | null; spaceId?: string | null; x?: number | null; z?: number | null; pmPlanId?: string | null; checklist?: string[]; photos?: string[] }

export async function addTicket(t: Db, n: NewTicket, who: Caller, now: Date, due?: { respondBy: Date; resolveBy: Date }) {
  const id = newId('TK')
  const sla = SLA[n.priority]
  await t.query(
    `insert into ticket (id, kind, title, detail, priority, asset_id, space_id, x, z, pm_plan_id, checklist, photos, reported_by, reported_at, respond_by, resolve_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, n.kind, n.title, n.detail ?? null, n.priority, n.assetId ?? null, n.spaceId ?? null, n.x ?? null, n.z ?? null, n.pmPlanId ?? null,
      JSON.stringify((n.checklist ?? []).map((item) => ({ item, done: false }))), n.photos ?? [], who.userId === 'system' ? null : who.userId, now,
      due?.respondBy ?? new Date(now.getTime() + sla.respond * 60_000), due?.resolveBy ?? new Date(now.getTime() + sla.resolve * 60_000)])
  await appendAudit(t, { actor: who, action: n.kind === 'pm' ? 'eng.pm_due' : 'eng.ticket', entity: { type: 'ticket', id }, after: { title: n.title, priority: n.priority, assetId: n.assetId ?? null, spaceId: n.spaceId ?? null } }, now)
  return id
}

/** Where a ticket or asset sits on the 3D map: its own pin, else its asset's, else its room's centre. */
export async function positionOf(t: Db, p: { x: string | number | null; z: string | number | null; asset_id?: string | null; space_id: string | null }): Promise<{ x: number; z: number } | null> {
  if (p.x != null && p.z != null) return { x: Number(p.x), z: Number(p.z) }
  if (p.asset_id) {
    const [a] = await t.query<{ x: string | null; z: string | null; space_id: string | null }>('select x, z, space_id from asset where id = $1', [p.asset_id])
    if (a) return positionOf(t, { ...a, asset_id: null })
  }
  return p.space_id ? spacePosition(t, p.space_id) : null
}

/** Expiry reminder tier for a date: 60, 30 or 7 days before, -1 once passed, 0 when not yet near. */
export function reminderTier(today: string, due: string) {
  const left = daysBetween(today, due)
  return left < 0 ? -1 : left <= 7 ? 7 : left <= 30 ? 30 : left <= 60 ? 60 : 0
}
const tierRank = (t: number) => (t === -1 ? 4 : t === 7 ? 3 : t === 30 ? 2 : t === 60 ? 1 : 0)

/**
 * Runs every minute on the server (and before the lists are read): escalates tickets not answered or
 * not fixed in time, raises planned-maintenance tickets on their due day, and reminds owners of licences
 * and maintenance contracts 60, 30 and 7 days before expiry, and when overdue.
 */
export async function sweepEngineering(db: Db, now: Date) {
  await db.tx(async (t) => {
    const late = await t.query<{ id: string; title: string; responded_at: string | null; respond_by: string; resolve_by: string; escalation: number; priority: string }>(
      `select id, title, responded_at, respond_by, resolve_by, escalation, priority from ticket
        where status in ('open', 'in_progress', 'on_hold') and ((responded_at is null and respond_by < $1 and escalation < 1) or (resolve_by < $1 and escalation < 2))`, [now])
    for (const k of late) {
      const level = new Date(k.resolve_by) < now ? 2 : 1
      await t.query('update ticket set escalation = $2 where id = $1', [k.id, level])
      await appendAudit(t, { actor: SYSTEM, action: 'eng.escalated', entity: { type: 'ticket', id: k.id },
        after: { level, title: k.title, priority: k.priority, reason: level === 2 ? 'not fixed in time' : 'nobody has taken it' } }, now)
    }

    const today = istDay(now)
    const due = await t.query<{ id: string; asset_id: string; title: string; checklist: string[]; next_due: string; asset: string; space_id: string | null }>(
      `select p.id, p.asset_id, p.title, p.checklist, p.next_due::text, a.name as asset, a.space_id from pm_plan p join asset a on a.id = p.asset_id
        where p.active and a.active and p.next_due <= $1 and not exists (select 1 from ticket k where k.pm_plan_id = p.id and k.status in ('open', 'in_progress', 'on_hold'))`, [today])
    for (const p of due) {
      const end = new Date(`${p.next_due}T23:59:00+05:30`)
      await addTicket(t, { kind: 'pm', title: `${p.title}: ${p.asset}`, priority: 'normal', assetId: p.asset_id, spaceId: p.space_id, pmPlanId: p.id, checklist: p.checklist }, SYSTEM, now,
        { respondBy: end, resolveBy: new Date(end.getTime() + 3 * 86_400_000) })
    }

    const lic = await t.query<{ id: string; name: string; valid_until: string; reminded: number }>(
      `select id, name, valid_until::text, reminded from licence where active and valid_until is not null and valid_until <= $1`, [addDays(today, 60)])
    for (const l of lic) {
      const tier = reminderTier(today, l.valid_until)
      if (tierRank(tier) <= tierRank(l.reminded)) continue
      await t.query('update licence set reminded = $2 where id = $1', [l.id, tier])
      await appendAudit(t, { actor: SYSTEM, action: 'compliance.reminder', entity: { type: 'licence', id: l.id }, after: { name: l.name, due: l.valid_until, daysLeft: daysBetween(today, l.valid_until) } }, now)
    }
    const amc = await t.query<{ id: string; name: string; amc_until: string; amc_reminded: number }>(
      `select id, name, amc_until::text, amc_reminded from asset where active and amc_until is not null and amc_until <= $1`, [addDays(today, 60)])
    for (const a of amc) {
      const tier = reminderTier(today, a.amc_until)
      if (tierRank(tier) <= tierRank(a.amc_reminded)) continue
      await t.query('update asset set amc_reminded = $2 where id = $1', [a.id, tier])
      await appendAudit(t, { actor: SYSTEM, action: 'compliance.reminder', entity: { type: 'asset', id: a.id }, after: { name: `AMC: ${a.name}`, due: a.amc_until, daysLeft: daysBetween(today, a.amc_until) } }, now)
    }
  })
}

/** Utility meters every resort has, so the daily readings can start on day one (rates are samples to edit). */
export async function ensureEngineering(db: Db) {
  const [{ n }] = await db.query<{ n: number }>('select count(*)::int as n from meter')
  if (n > 0) return
  const meters: [string, string, string, string, boolean, number][] = [
    ['MT-EB', 'EB main meter', 'electricity', 'kWh', true, 850], ['MT-DGH', 'DG set running hours', 'dg_hours', 'hours', true, 0],
    ['MT-DSL', 'Diesel used (DG)', 'diesel', 'litres', false, 9200], ['MT-SOLAR', 'Solar generation', 'solar', 'kWh', true, 0],
    ['MT-WATER', 'Water (bore + tanker)', 'water', 'kL', true, 0], ['MT-LPG', 'LPG used (kitchen)', 'lpg', 'kg', false, 10500],
  ]
  for (const [id, name, kind, unit, cumulative, rate] of meters) {
    await db.query('insert into meter (id, name, kind, unit, cumulative, rate_paise) values ($1,$2,$3,$4,$5,$6)', [id, name, kind, unit, cumulative, rate])
  }
}
