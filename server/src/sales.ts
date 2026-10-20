import type { Actor } from '@sathya/audit'
import { appendAudit } from './audit-store'
import type { Db } from './db'

// Sales rules the front desk shares: a company's contracted rate, and room blocks (rooms held for a wedding
// or a group until their cut-off, then released).

/** The company's contracted rate for a room type, plan and night, if one is in force. */
export async function contractRate(t: Db, debtorId: string, plan: string, roomTypeId: string, night: string): Promise<number | null> {
  const [r] = await t.query<{ rate_paise: string }>(
    `select rate_paise from contract_rate where debtor_id = $1 and plan_code = $2 and room_type_id = $3 and $4::date between valid_from and valid_to
      order by valid_from desc limit 1`, [debtorId, plan, roomTypeId, night])
  return r ? Number(r.rate_paise) : null
}

/** Rooms of a type booked in a block, night by night. */
export async function blockPickup(t: Db, blockId: string, roomTypeId: string, nights: string[]) {
  const rows = await t.query<{ night: string; picked: number }>(
    `select n::date::text as night, (select count(*)::int from room_night rn join reservation r on r.id = rn.reservation_id
        where r.block_id = $1 and rn.room_type_id = $2 and rn.night = n::date and not rn.released) as picked
       from unnest($3::date[]) n`, [blockId, roomTypeId, nights])
  return rows.map((r) => ({ night: r.night, picked: Number(r.picked) }))
}

const SYSTEM: Actor = { userId: 'system', name: 'System', role: 'system' }

/** Blocks past their cut-off give back the rooms not picked up. */
export async function sweepBlocks(t: Db, today: string, _who: Actor | null, now: Date) {
  const gone = await t.query<{ id: string; number: string; name: string }>(
    `update room_block set status = 'released', released_at = $2 where status = 'open' and cutoff < $1 returning id, number, name`, [today, now])
  for (const b of gone) await appendAudit(t, { actor: SYSTEM, action: 'room_block.released_at_cutoff', entity: { type: 'room_block', id: b.id }, note: `${b.number} ${b.name}` }, now)
  return gone.length
}
