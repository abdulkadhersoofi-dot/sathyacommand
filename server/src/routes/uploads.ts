import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { can, HttpError, type Ctx } from '../context'
import { requireCaller } from './auth'

// Photos from phones (cleaning proof, faults, lost & found, incidents). The app shrinks them before
// sending, so they fit in the database and nothing depends on a server disk.

const MAX = 1_500_000
const KINDS = ['hk', 'fault', 'lost_found', 'incident', 'selfie', 'wastage', 'document', 'gate', 'other']

export function uploadRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db

  app.post('/api/uploads', { bodyLimit: 2_200_000 }, async (req, reply) => {
    const who = await requireCaller(ctx, req)
    const b = req.body as { kind?: string; dataUrl?: string }
    if (!KINDS.includes(b?.kind ?? '')) throw new HttpError(400, `kind: ${KINDS.join(', ')}.`)
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl ?? '')
    if (!m) throw new HttpError(400, 'Send the photo as a JPEG, PNG or WebP data URL.')
    const bytes = Buffer.from(m[2], 'base64')
    if (bytes.length > MAX) throw new HttpError(413, 'The photo is too large (1.5 MB at most).')
    const id = `UP-${randomUUID()}`
    await db.query('insert into upload (id, kind, mime, bytes, size, uploaded_by, at) values ($1,$2,$3,$4,$5,$6,$7)', [id, b.kind, m[1], bytes, bytes.length, who.userId, ctx.now()])
    return reply.status(201).send({ id, url: `/api/uploads/${id}` })
  })

  app.get('/api/uploads/:id', async (req, reply) => {
    const who = await requireCaller(ctx, req)
    const [u] = await db.query<{ mime: string; bytes: Uint8Array; kind: string; uploaded_by: string }>('select mime, bytes, kind, uploaded_by from upload where id = $1', [(req.params as { id: string }).id])
    if (!u) throw new HttpError(404, 'No such photo.')
    // Clock-in selfies are personal: only the person and those who check attendance see them.
    if (u.kind === 'selfie' && u.uploaded_by !== who.userId && !can(who, 'attendance.view')) throw new HttpError(403, 'Your role cannot see this photo.')
    return reply.type(u.mime).header('cache-control', 'private, max-age=86400').send(Buffer.from(u.bytes))
  })
}
