import type { FastifyInstance } from 'fastify'
import { defaultLayout, layoutDiff, lodgingObjects, validateLayout, type SiteLayout } from '@sathya/twin'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Caller, type Ctx } from '../context'
import type { Db } from '../db'
import { LODGING } from '../fo-core'
import { requireCaller } from './auth'

// Twin Studio: versions of the 3D resort layout. Drafts are saved freely; publishing checks what the
// change does to bookable rooms, unlinks rooms whose drawing was removed, and refuses if that would
// strand a guest. Every save, publish and restore goes into the God Mode log.

const MAX_BYTES = 1_000_000

/** Makes sure a published layout exists (the traced default on a fresh database). */
export async function ensureSiteLayout(db: Db) {
  const [p] = await db.query('select id from site_version where status = $1', ['published'])
  if (p) return
  const [md] = await db.query<{ id: string }>(`select id from app_user where id = 'u-md'`)
  if (!md) return
  await db.query(
    `insert into site_version (status, layout, note, created_by, created_at, published_by, published_at)
     values ('published', $1, 'Traced from the satellite image', 'u-md', now(), 'u-md', now())`, [JSON.stringify(defaultLayout())])
}

function checkLayout(layout: unknown): SiteLayout {
  if (JSON.stringify(layout ?? null).length > MAX_BYTES) throw new HttpError(413, 'The layout is too large.')
  const problems = validateLayout(layout as SiteLayout)
  if (problems.length) throw new HttpError(400, 'The layout has problems to fix before it can be saved.', { problems })
  return layout as SiteLayout
}

async function publishLayout(ctx: Ctx, t: Db, who: Caller, versionId: number) {
  const [v] = await t.query<{ id: number; status: string; layout: SiteLayout }>('select id, status, layout from site_version where id = $1 for update', [versionId])
  if (!v) throw new HttpError(404, 'No such version.')
  if (v.status === 'published') throw new HttpError(409, 'This version is already live.')
  const layout = checkLayout(v.layout)
  const drawn = new Set(lodgingObjects(layout).map((o) => o.id))

  // Rooms whose drawing disappears: refused while a guest is booked or in-house, otherwise unlinked.
  const orphaned = await t.query<{ id: string; room_no: string; twin_id: string }>(
    `select id, room_no, twin_id from space where active and kind = any($1) and twin_id is not null and not (twin_id = any($2))`, [LODGING, [...drawn]])
  if (orphaned.length) {
    const busy = await t.query<{ room_no: string }>(
      `select distinct s.room_no from space s join reservation r on r.space_id = s.id
        where s.id = any($1) and r.status in ('confirmed', 'in_house')`, [orphaned.map((o) => o.id)])
    if (busy.length) {
      throw new HttpError(409, `This change removes the drawing of room${busy.length > 1 ? 's' : ''} ${busy.map((b) => b.room_no).join(', ')}, which ${busy.length > 1 ? 'have' : 'has'} guests booked. Move those bookings first.`,
        { busyRooms: busy.map((b) => b.room_no) })
    }
    await t.query('update space set twin_id = null, updated_at = $2 where id = any($1)', [orphaned.map((o) => o.id), ctx.now()])
  }

  const [prev] = await t.query<{ id: number; layout: SiteLayout }>(`select id, layout from site_version where status = 'published' for update`)
  if (prev) await t.query(`update site_version set status = 'superseded' where id = $1`, [prev.id])
  await t.query(`update site_version set status = 'published', published_by = $2, published_at = $3 where id = $1`, [v.id, who.userId, ctx.now()])

  const linked = new Set((await t.query<{ twin_id: string }>('select twin_id from space where active and twin_id is not null')).map((r) => r.twin_id))
  const unlinkedObjects = lodgingObjects(layout).filter((o) => !linked.has(o.id))
  const diff = layoutDiff(prev?.layout ?? null, layout)
  await appendAudit(t, { actor: who, action: 'site.published', entity: { type: 'site_version', id: String(v.id) },
    before: { version: prev?.id ?? null }, after: { version: v.id, ...diff, unlinkedRooms: orphaned.map((o) => o.room_no) } }, ctx.now())
  return { version: v.id, ...diff, unlinkedRooms: orphaned.map((o) => o.room_no), unlinkedObjects }
}

export function siteRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db

  app.get('/api/site', async (req) => {
    await requireCaller(ctx, req)
    const [v] = await db.query<{ id: number; layout: SiteLayout; published_at: string; published_by: string }>(
      `select v.id, v.layout, v.published_at, u.name as published_by from site_version v left join app_user u on u.id = v.published_by
        where v.status = 'published'`)
    if (!v) throw new HttpError(404, 'No published layout yet.')
    return { version: v.id, layout: v.layout, publishedAt: v.published_at, publishedBy: v.published_by }
  })

  app.get('/api/site/versions', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'site.edit') && !can(who, 'site.publish')) throw new HttpError(403, 'You cannot see layout versions.')
    return db.query(
      `select v.id, v.status, v.note, v.based_on, c.name as created_by, v.created_at, p.name as published_by, v.published_at
         from site_version v join app_user c on c.id = v.created_by left join app_user p on p.id = v.published_by
        order by v.id desc limit 100`)
  })

  app.get('/api/site/versions/:id', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'site.edit') && !can(who, 'site.publish')) throw new HttpError(403, 'You cannot see layout versions.')
    const [v] = await db.query('select id, status, note, layout from site_version where id = $1', [Number((req.params as { id: string }).id)])
    if (!v) throw new HttpError(404, 'No such version.')
    return v
  })

  app.post('/api/site/drafts', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'site.edit')) throw new HttpError(403, 'Only the Operations Manager, GM or MD can change the resort layout.')
    const b = req.body as { layout?: unknown; note?: string; basedOn?: number }
    const layout = checkLayout(b?.layout)
    const [row] = await db.query<{ id: number }>(
      `insert into site_version (status, layout, note, based_on, created_by, created_at) values ('draft', $1, $2, $3, $4, $5) returning id`,
      [JSON.stringify(layout), b.note?.trim() || null, b.basedOn ?? null, who.userId, ctx.now()])
    const [live] = await db.query<{ layout: SiteLayout }>(`select layout from site_version where status = 'published'`)
    const diff = layoutDiff(live?.layout ?? null, layout)
    await appendAudit(db, { actor: who, action: 'site.draft_saved', entity: { type: 'site_version', id: String(row.id) }, after: { ...diff, note: b.note ?? null } }, ctx.now())
    return reply.status(201).send({ id: row.id, ...diff })
  })

  app.post('/api/site/versions/:id/publish', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'site.publish')) throw new HttpError(403, 'Only the MD or GM can publish a layout.')
    return db.tx((t) => publishLayout(ctx, t, who, Number((req.params as { id: string }).id)))
  })

  // Restoring copies an old version into a new one and publishes it, so history only grows.
  app.post('/api/site/versions/:id/restore', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'site.publish')) throw new HttpError(403, 'Only the MD or GM can restore a layout.')
    const id = Number((req.params as { id: string }).id)
    return db.tx(async (t) => {
      const [old] = await t.query<{ layout: SiteLayout }>('select layout from site_version where id = $1', [id])
      if (!old) throw new HttpError(404, 'No such version.')
      const [row] = await t.query<{ id: number }>(
        `insert into site_version (status, layout, note, based_on, created_by, created_at) values ('draft', $1, $2, $3, $4, $5) returning id`,
        [JSON.stringify(old.layout), `Restored version ${id}`, id, who.userId, ctx.now()])
      await appendAudit(t, { actor: who, action: 'site.restored', entity: { type: 'site_version', id: String(row.id) }, after: { from: id } }, ctx.now())
      return publishLayout(ctx, t, who, row.id)
    })
  })
}
