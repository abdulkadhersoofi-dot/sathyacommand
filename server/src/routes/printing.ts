import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { twoCol, type PrintDoc, type PrintLine } from '@sathya/escpos'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { requireCaller } from './auth'

// Printers on the resort network and the queue of jobs for them. The print agent on the edge box
// claims jobs, sends them to the printers (ESC/POS on port 9100) and reports back; failed jobs are
// retried, and after five tries the MD sees it in God Mode.

const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
const MAX_ATTEMPTS = 5
const STALE_MS = 2 * 60_000
const istTime = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 16)

export interface TicketForPrint {
  kind: string; number: number; copy: boolean; station_id: string
  order: { number: number; outlet: string; table: string | null; room: string | null; covers: number }
  lines: { qty: number; name: string; note: string | null; seat: number | null; course: number; alert?: string[]; void?: boolean }[]
}

/** A KOT / BOT as a print document: big ticket number and table, then each dish with notes and allergy alerts. */
export function ticketDoc(t: TicketForPrint, stationName: string, width: number, at: Date): PrintDoc {
  const where = t.order.table ? `TABLE ${t.order.table}` : t.order.room ? `ROOM ${t.order.room}` : 'TAKEAWAY'
  const lines: PrintLine[] = [
    { text: `${t.kind} ${t.number}${t.copy ? ' COPY' : ''}`, big: true, align: 'center' },
    { text: where, big: true, align: 'center' },
    { text: `${stationName} - ${t.order.outlet} - Order ${t.order.number} - ${t.order.covers} pax - ${istTime(at)}`, align: 'center' },
    { text: '-'.repeat(width) },
  ]
  for (const l of t.lines) {
    lines.push({ text: `${l.void ? 'CANCELLED ' : ''}${l.qty} x ${l.name}${l.seat ? ` (seat ${l.seat})` : ''}${l.course > 1 ? ` [course ${l.course}]` : ''}`, bold: true, big: !l.void })
    if (l.note) lines.push({ text: `  * ${l.note}` })
    if (l.alert?.length) lines.push({ text: `  !! ${l.alert.join(' ')} !!`, bold: true })
  }
  lines.push({ text: '-'.repeat(width) })
  return { width, lines, cut: true, beep: true }
}

export interface BillForPrint {
  heading: string[]; title: string; meta: string; duplicate: boolean
  food: { description: string; amount: number }[]; foodTotals: [string, number][]
  liquor: { description: string; amount: number }[]; liquorTotals: [string, number][]
  total: number; roundOff: number; payable: number; words: string; footer: string[]
}

const money = (p: number) => (p / 100).toFixed(2)

/** A restaurant bill as a print document (the UPI QR is on the browser print only). */
export function billDoc(b: BillForPrint, width: number): PrintDoc {
  const lines: PrintLine[] = b.heading.map((h, i) => ({ text: h, align: 'center', bold: i === 0 }))
  if (b.duplicate) lines.push({ text: 'DUPLICATE COPY', align: 'center', bold: true })
  lines.push({ text: b.meta }, { text: '-'.repeat(width) })
  const block = (title: string, items: { description: string; amount: number }[], totals: [string, number][]) => {
    if (!items.length) return
    lines.push({ text: title, bold: true })
    for (const i of items) for (const t of twoCol(i.description, money(i.amount), width)) lines.push({ text: t })
    for (const [label, v] of totals) for (const t of twoCol(label, money(v), width)) lines.push({ text: t })
    lines.push({ text: '-'.repeat(width) })
  }
  block(b.title, b.food, b.foodTotals)
  block('Liquor (TN VAT)', b.liquor, b.liquorTotals)
  for (const t of twoCol('Total', money(b.total), width)) lines.push({ text: t })
  if (b.roundOff) for (const t of twoCol('Round off', money(b.roundOff), width)) lines.push({ text: t })
  for (const t of twoCol('AMOUNT PAYABLE', `Rs.${money(b.payable)}`, width)) lines.push({ text: t, bold: true })
  lines.push({ text: b.words })
  for (const f of b.footer) lines.push({ text: f, align: 'center' })
  return { width, lines, cut: true }
}

/** Queues the KOTs / BOTs for the printers of their stations (stations without a printer are skipped). */
export async function queueTickets(t: Db, tickets: TicketForPrint[], now: Date) {
  for (const tk of tickets) {
    const [st] = await t.query<{ name: string; printer_id: string | null; width: number | null; active: boolean | null }>(
      'select s.name, s.printer_id, p.width, p.active from station s left join printer p on p.id = s.printer_id where s.id = $1', [tk.station_id])
    if (!st?.printer_id || !st.active) continue
    await t.query('insert into print_job (id, printer_id, kind, ref, doc, created_at) values ($1,$2,$3,$4,$5,$6)',
      [newId('PJ'), st.printer_id, 'kot', `${tk.kind} ${tk.number}`, JSON.stringify(ticketDoc(tk, st.name, st.width!, now)), now])
  }
}

/** Queues a document for a printer; returns the job id. */
export async function queueDoc(t: Db, printerId: string, kind: 'bill' | 'test', ref: string, doc: PrintDoc, now: Date) {
  const id = newId('PJ')
  await t.query('insert into print_job (id, printer_id, kind, ref, doc, created_at) values ($1,$2,$3,$4,$5,$6)', [id, printerId, kind, ref, JSON.stringify(doc), now])
  return id
}

export function printingRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function manager(req: FastifyRequest) {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'printers.manage')) throw new HttpError(403, 'Only the F&B manager, GM or MD can change printers.')
    return who
  }

  function agent(req: FastifyRequest) {
    const key = ctx.printAgentKey
    if (!key) throw new HttpError(503, 'The print agent is not set up on this server (PRINT_AGENT_KEY).')
    const sent = Buffer.from(String(req.headers['x-agent-key'] ?? ''))
    const want = Buffer.from(key)
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) throw new HttpError(401, 'Wrong print agent key.')
  }

  // ---------- printers and routing ----------
  app.get('/api/printers', async (req) => {
    await requireCaller(ctx, req)
    const printers = await db.query('select id, name, host, port, width, active from printer order by name')
    const stations = await db.query('select id, name, printer_id from station where active order by name')
    const outlets = await db.query('select id, name, bill_printer_id from outlet where active order by name')
    const [{ agentSeen }] = await db.query<{ agentSeen: string | null }>(`select max(claimed_at) as "agentSeen" from print_job`)
    return { printers, stations, outlets, agentConfigured: !!ctx.printAgentKey, agentLastSeen: agentSeen }
  })

  app.post('/api/printers', async (req, reply) => {
    const who = await manager(req)
    const b = req.body as { name?: string; host?: string; port?: number; width?: number }
    if (!b?.name?.trim() || b.name.length > 40) throw new HttpError(400, 'Name the printer (e.g. Main kitchen).')
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(b.host ?? '')) throw new HttpError(400, 'Printer address: its IP (e.g. 192.168.1.50) or network name.')
    if (b.port !== undefined && !(Number.isInteger(b.port) && b.port >= 1 && b.port <= 65535)) throw new HttpError(400, 'Port 1–65535 (thermal printers use 9100).')
    if (b.width !== undefined && ![32, 42, 48].includes(b.width)) throw new HttpError(400, 'Width: 48 (80 mm), 42 or 32 (58 mm) characters.')
    const id = newId('PRN')
    await db.tx(async (t) => {
      await t.query('insert into printer (id, name, host, port, width, created_at) values ($1,$2,$3,$4,$5,$6)', [id, b.name!.trim(), b.host, b.port ?? 9100, b.width ?? 48, now()])
      await appendAudit(t, { actor: who, action: 'printer.add', entity: { type: 'printer', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/printers/:id', async (req) => {
    const who = await manager(req)
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; host?: string; port?: number; width?: number; active?: boolean }
    if (b.host !== undefined && !/^[A-Za-z0-9.-]{1,253}$/.test(b.host)) throw new HttpError(400, 'Printer address: its IP or network name.')
    if (b.width !== undefined && ![32, 42, 48].includes(b.width)) throw new HttpError(400, 'Width: 48, 42 or 32 characters.')
    return db.tx(async (t) => {
      const [before] = await t.query('select * from printer where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such printer.')
      await t.query('update printer set name = coalesce($2, name), host = coalesce($3, host), port = coalesce($4, port), width = coalesce($5, width), active = coalesce($6, active) where id = $1',
        [id, b.name?.trim() ?? null, b.host ?? null, b.port ?? null, b.width ?? null, b.active ?? null])
      const [after] = await t.query('select * from printer where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'printer.update', entity: { type: 'printer', id }, before, after }, now())
      return after
    })
  })

  // Which printer each station's tickets and each outlet's bills go to (null = no printer, screen only).
  app.put('/api/printers/routes', async (req) => {
    const who = await manager(req)
    const b = (req.body ?? {}) as { stations?: Record<string, string | null>; outlets?: Record<string, string | null> }
    return db.tx(async (t) => {
      const printers = new Set((await t.query<{ id: string }>('select id from printer')).map((p) => p.id))
      for (const p of [...Object.values(b.stations ?? {}), ...Object.values(b.outlets ?? {})]) if (p && !printers.has(p)) throw new HttpError(400, `No printer ${p}.`)
      for (const [s, p] of Object.entries(b.stations ?? {})) await t.query('update station set printer_id = $2 where id = $1', [s, p])
      for (const [o, p] of Object.entries(b.outlets ?? {})) await t.query('update outlet set bill_printer_id = $2 where id = $1', [o, p])
      await appendAudit(t, { actor: who, action: 'printer.routes', entity: { type: 'printer', id: 'routes' }, after: b }, now())
      return { ok: true }
    })
  })

  app.post('/api/printers/:id/test', async (req, reply) => {
    await manager(req)
    const { id } = req.params as { id: string }
    const [p] = await db.query<{ name: string; width: number }>('select name, width from printer where id = $1', [id])
    if (!p) throw new HttpError(404, 'No such printer.')
    const jobId = await queueDoc(db, id, 'test', 'Test page', {
      width: p.width, cut: true, beep: true,
      lines: [{ text: 'Sathya Command', big: true, align: 'center' }, { text: `Test page - ${p.name}`, align: 'center' }, { text: '-'.repeat(p.width) },
        { text: 'If you can read this, kitchen tickets will print here.' }, { text: '0123456789'.repeat(Math.ceil(p.width / 10)).slice(0, p.width) }],
    }, now())
    return reply.status(201).send({ jobId })
  })

  app.get('/api/print-jobs', async (req) => {
    await requireCaller(ctx, req)
    const q = req.query as { status?: string }
    return db.query(
      `select j.id, j.kind, j.ref, j.status, j.attempts, j.error, j.created_at, j.done_at, p.name as printer
         from print_job j join printer p on p.id = j.printer_id where ($1::text is null or j.status = $1) order by j.created_at desc limit 50`, [q.status ?? null])
  })

  app.post('/api/print-jobs/:id/retry', async (req) => {
    const who = await requireCaller(ctx, req)
    if (!can(who, 'printers.manage') && !can(who, 'fnb.order')) throw new HttpError(403, 'Your role cannot do this.')
    const [j] = await db.query(`update print_job set status = 'queued', attempts = 0, error = null where id = $1 and status = 'failed' returning id`, [(req.params as { id: string }).id])
    if (!j) throw new HttpError(409, 'Only failed jobs can be retried.')
    return { ok: true }
  })

  // ---------- the print agent on the edge box ----------
  app.post('/api/print-agent/claim', async (req) => {
    agent(req)
    const max = Math.min(Number((req.body as { max?: number })?.max ?? 10), 50)
    return db.tx(async (t) => {
      await t.query(`update print_job set status = 'queued' where status = 'printing' and claimed_at < $1`, [new Date(now().getTime() - STALE_MS)])
      const jobs = await t.query<{ id: string }>(
        `select j.id, j.kind, j.ref, j.doc, p.host, p.port from print_job j join printer p on p.id = j.printer_id
          where j.status = 'queued' and p.active order by j.created_at limit $1 for update of j skip locked`, [max])
      if (jobs.length) await t.query(`update print_job set status = 'printing', attempts = attempts + 1, claimed_at = $2 where id = any($1)`, [jobs.map((j) => j.id), now()])
      return { jobs }
    })
  })

  app.post('/api/print-agent/jobs/:id/done', async (req) => {
    agent(req)
    const [j] = await db.query(`update print_job set status = 'done', done_at = $2, error = null where id = $1 returning id`, [(req.params as { id: string }).id, now()])
    if (!j) throw new HttpError(404, 'No such job.')
    return { ok: true }
  })

  app.post('/api/print-agent/jobs/:id/failed', async (req) => {
    agent(req)
    const { id } = req.params as { id: string }
    const error = String((req.body as { error?: string })?.error ?? 'Printer did not answer').slice(0, 300)
    return db.tx(async (t) => {
      const [j] = await t.query<{ attempts: number; ref: string; printer: string }>(
        'select j.attempts, j.ref, p.name as printer from print_job j join printer p on p.id = j.printer_id where j.id = $1 for update of j', [id])
      if (!j) throw new HttpError(404, 'No such job.')
      const failed = j.attempts >= MAX_ATTEMPTS
      await t.query('update print_job set status = $2, error = $3 where id = $1', [id, failed ? 'failed' : 'queued', error])
      if (failed) await appendAudit(t, { actor: { userId: 'print-agent', name: 'Print agent', role: 'system' }, action: 'print.failed', entity: { type: 'print_job', id }, after: { ref: j.ref, printer: j.printer }, note: error }, now())
      return { ok: true, willRetry: !failed }
    })
  })
}

/** Remembers the answer to a request sent with an Idempotency-Key, so a tablet that resends it (after losing its connection) gets the same answer and nothing happens twice. */
export function idempotency(app: FastifyInstance, ctx: Ctx) {
  const scopeOf = (auth: string) => createHash('sha256').update(auth).digest('hex').slice(0, 32)
  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key']
    if (req.method !== 'POST' || typeof key !== 'string' || !key || key.length > 80) return
    const scope = scopeOf(String(req.headers.authorization ?? 'anon'))
    const [hit] = await ctx.db.query<{ status: number; body: string }>('select status, body from idempotency_key where scope = $1 and key = $2', [scope, key])
    if (hit) return reply.code(hit.status).header('content-type', 'application/json; charset=utf-8').header('idempotent-replay', 'true').send(hit.body)
    ;(req as unknown as { idem?: { scope: string; key: string } }).idem = { scope, key }
  })
  // Routes often answer from inside a transaction, so the answer is only captured while sending and
  // saved once the response has finished (writing during sending would wait on that transaction).
  app.addHook('onSend', async (req, reply, payload) => {
    const r = req as unknown as { idem?: { scope: string; key: string; body?: string } }
    if (r.idem && reply.statusCode < 300 && typeof payload === 'string') r.idem.body = payload
    return payload
  })
  app.addHook('onResponse', async (req, reply) => {
    const idem = (req as unknown as { idem?: { scope: string; key: string; body?: string } }).idem
    if (!idem?.body) return
    await ctx.db.query('insert into idempotency_key (key, scope, status, body, created_at) values ($1,$2,$3,$4,$5) on conflict do nothing',
      [idem.key, idem.scope, reply.statusCode, idem.body, ctx.now()])
    if (Math.random() < 0.01) await ctx.db.query('delete from idempotency_key where created_at < $1', [new Date(ctx.now().getTime() - 2 * 86_400_000)])
  })
}
