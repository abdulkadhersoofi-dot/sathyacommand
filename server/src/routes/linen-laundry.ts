import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import qrcode from 'qrcode-generator'
import { rupees, splitGst } from '@sathya/tax'
import { appendAudit } from '../audit-store'
import { can, HttpError, type Ctx } from '../context'
import type { Db } from '../db'
import { businessDate, folioBalance, LODGING } from '../fo-core'
import { requireCaller } from './auth'

// Linen stock (on the shelf, at the laundry, lost), guest laundry charged to the room, and public-area
// cleaning rounds confirmed by scanning the QR code fixed in each area.

const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
const LINEN_KINDS = ['purchase', 'send_laundry', 'receive_laundry', 'laundry_loss', 'discard', 'count_adjust'] as const
const SERVICES = ['wash_iron', 'dry_clean', 'press']
const EXPRESS = 1.5

export function linenLaundryRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db
  const now = () => ctx.now()

  async function need(req: FastifyRequest, ...perms: string[]) {
    const who = await requireCaller(ctx, req)
    if (!perms.some((p) => can(who, p))) throw new HttpError(403, 'Your role cannot do this.')
    return who
  }

  // ---------- linen ----------
  app.get('/api/linen', async (req) => {
    await need(req, 'hk.view', 'hk.attend', 'hk.manage')
    const [{ rooms }] = await db.query<{ rooms: number }>('select count(*)::int as rooms from space where active and sellable and kind = any($1)', [LODGING])
    const rows = await db.query<{ id: string; name: string; par_per_room: string; par_sets: string; active: boolean; shelf: number; laundry: number; lost: number; bought: number }>(
      `select i.id, i.name, i.par_per_room, i.par_sets, i.active,
              coalesce(sum(case m.kind when 'purchase' then m.qty when 'send_laundry' then -m.qty when 'receive_laundry' then m.qty when 'discard' then -m.qty when 'count_adjust' then m.qty else 0 end), 0)::int as shelf,
              coalesce(sum(case m.kind when 'send_laundry' then m.qty when 'receive_laundry' then -m.qty when 'laundry_loss' then -m.qty else 0 end), 0)::int as laundry,
              coalesce(sum(case when m.kind in ('laundry_loss', 'discard') then m.qty else 0 end), 0)::int as lost,
              coalesce(sum(case when m.kind = 'purchase' then m.qty else 0 end), 0)::int as bought
         from linen_item i left join linen_move m on m.item_id = i.id group by i.id order by i.active desc, i.name`)
    return rows.map((r) => {
      const inRooms = Math.round(Number(r.par_per_room) * rooms)
      const owned = r.shelf + r.laundry + inRooms
      const needed = Math.ceil(Number(r.par_per_room) * rooms * Number(r.par_sets))
      return { ...r, parPerRoom: Number(r.par_per_room), parSets: Number(r.par_sets), inRooms, owned, needed, short: Math.max(0, needed - owned) }
    })
  })

  app.post('/api/linen/items', async (req, reply) => {
    const who = await need(req, 'hk.manage')
    const b = req.body as { name?: string; parPerRoom?: number; parSets?: number }
    if (!b?.name?.trim() || !(b.parPerRoom! >= 0)) throw new HttpError(400, 'Name and pieces per room are required.')
    const id = newId('LN')
    await db.tx(async (t) => {
      const [dup] = await t.query('select 1 from linen_item where lower(name) = lower($1)', [b.name!.trim()])
      if (dup) throw new HttpError(409, `${b.name} already exists.`)
      await t.query('insert into linen_item (id, name, par_per_room, par_sets) values ($1,$2,$3,$4)', [id, b.name!.trim(), b.parPerRoom, b.parSets ?? 3])
      await appendAudit(t, { actor: who, action: 'linen_item.add', entity: { type: 'linen_item', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/linen/items/:id', async (req) => {
    const who = await need(req, 'hk.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; parPerRoom?: number; parSets?: number; active?: boolean }
    return db.tx(async (t) => {
      const [before] = await t.query('select * from linen_item where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such linen item.')
      await t.query('update linen_item set name = coalesce($2, name), par_per_room = coalesce($3, par_per_room), par_sets = coalesce($4, par_sets), active = coalesce($5, active) where id = $1',
        [id, b.name?.trim() ?? null, b.parPerRoom ?? null, b.parSets ?? null, b.active ?? null])
      const [after] = await t.query('select * from linen_item where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'linen_item.update', entity: { type: 'linen_item', id }, before, after }, now())
      return after
    })
  })

  app.post('/api/linen/moves', async (req, reply) => {
    const who = await need(req, 'hk.manage', 'hk.inspect')
    const b = req.body as { itemId?: string; kind?: typeof LINEN_KINDS[number]; qty?: number; vendor?: string; note?: string }
    if (!LINEN_KINDS.includes(b?.kind as typeof LINEN_KINDS[number])) throw new HttpError(400, `kind: ${LINEN_KINDS.join(', ')}.`)
    if (!Number.isInteger(b.qty) || b.qty === 0 || (b.kind !== 'count_adjust' && b.qty! < 0)) throw new HttpError(400, 'Quantity must be a whole number (negative only for a count adjustment).')
    if ((b.kind === 'discard' || b.kind === 'laundry_loss' || b.kind === 'count_adjust') && !b.note?.trim()) throw new HttpError(400, 'Give a reason (torn, stained, lost by the laundry…).')
    return db.tx(async (t) => {
      const [i] = await t.query<{ name: string }>('select name from linen_item where id = $1', [b.itemId])
      if (!i) throw new HttpError(404, 'No such linen item.')
      const id = newId('LM')
      await t.query('insert into linen_move (id, item_id, kind, qty, vendor, note, business_date, by_user, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, b.itemId, b.kind, b.qty, b.vendor?.trim() || null, b.note?.trim() || null, await businessDate(t), who.userId, now()])
      await appendAudit(t, { actor: who, action: `linen.${b.kind}`, entity: { type: 'linen_item', id: b.itemId! }, after: { item: i.name, qty: b.qty, vendor: b.vendor ?? null }, note: b.note }, now())
      return reply.status(201).send({ id })
    })
  })

  // ---------- guest laundry ----------
  app.get('/api/laundry/items', async (req) => {
    await requireCaller(ctx, req)
    return db.query('select id, name, service, price_paise, active from laundry_item order by active desc, service, name')
  })

  app.post('/api/laundry/items', async (req, reply) => {
    const who = await need(req, 'hk.manage')
    const b = req.body as { name?: string; service?: string; price?: number }
    if (!b?.name?.trim() || !SERVICES.includes(b.service ?? '') || !(b.price! >= 0)) throw new HttpError(400, `Name, service (${SERVICES.join(', ')}) and price are required.`)
    const id = newId('LI')
    await db.tx(async (t) => {
      await t.query('insert into laundry_item (id, name, service, price_paise) values ($1,$2,$3,$4)', [id, b.name!.trim(), b.service, rupees(b.price!)])
      await appendAudit(t, { actor: who, action: 'laundry_item.add', entity: { type: 'laundry_item', id }, after: b }, now())
    })
    return reply.status(201).send({ id })
  })

  app.patch('/api/laundry/items/:id', async (req) => {
    const who = await need(req, 'hk.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; price?: number; active?: boolean }
    return db.tx(async (t) => {
      const [before] = await t.query('select * from laundry_item where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such laundry item.')
      await t.query('update laundry_item set name = coalesce($2, name), price_paise = coalesce($3, price_paise), active = coalesce($4, active) where id = $1',
        [id, b.name?.trim() ?? null, b.price !== undefined ? rupees(b.price) : null, b.active ?? null])
      const [after] = await t.query('select * from laundry_item where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'laundry_item.update', entity: { type: 'laundry_item', id }, before, after }, now())
      return after
    })
  })

  app.get('/api/laundry/orders', async (req) => {
    await need(req, 'hk.view', 'hk.attend', 'hk.manage', 'front_desk')
    const status = (req.query as { status?: string }).status ?? 'picked_up'
    return db.query(
      `select o.id, s.room_no, g.name as guest, o.items, o.express, o.total_paise, o.status, u.name as picked_by, o.picked_at, o.delivered_at
         from laundry_order o join space s on s.id = o.space_id join reservation r on r.id = o.reservation_id join guest g on g.id = r.guest_id
         join app_user u on u.id = o.picked_by where ($1 = 'all' or o.status = $1) order by o.picked_at desc limit 200`, [status])
  })

  app.post('/api/laundry/orders', async (req, reply) => {
    const who = await need(req, 'hk.attend', 'hk.manage', 'front_desk')
    const b = req.body as { spaceId?: string; items?: { itemId: string; qty: number }[]; express?: boolean }
    if (!Array.isArray(b?.items) || !b.items.length) throw new HttpError(400, 'Add the pieces collected.')
    return db.tx(async (t) => {
      const [r] = await t.query<{ id: string; room_no: string }>(`select r.id, s.room_no from reservation r join space s on s.id = r.space_id where r.space_id = $1 and r.status = 'in_house'`, [b.spaceId])
      if (!r) throw new HttpError(409, 'No guest is checked in to this room.')
      const items = []
      let total = 0
      for (const l of b.items!) {
        if (!(Number.isInteger(l.qty) && l.qty >= 1 && l.qty <= 100)) throw new HttpError(400, 'Pieces 1–100.')
        const [li] = await t.query<{ name: string; service: string; price_paise: number }>('select name, service, price_paise from laundry_item where id = $1 and active', [l.itemId])
        if (!li) throw new HttpError(400, `No laundry item ${l.itemId}.`)
        const amount = Math.round(Number(li.price_paise) * l.qty * (b.express ? EXPRESS : 1))
        items.push({ itemId: l.itemId, name: li.name, service: li.service, qty: l.qty, amount })
        total += amount
      }
      const id = newId('LO')
      await t.query('insert into laundry_order (id, reservation_id, space_id, items, express, total_paise, picked_by, picked_at) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, r.id, b.spaceId, JSON.stringify(items), !!b.express, total, who.userId, now()])
      await appendAudit(t, { actor: who, action: 'laundry.pickup', entity: { type: 'laundry_order', id }, amount: total, after: { room: r.room_no, pieces: items.reduce((a, i) => a + i.qty, 0), express: !!b.express } }, now())
      return reply.status(201).send({ id, totalPaise: total })
    })
  })

  // Delivered back to the room: the charge goes on the guest's bill (laundry is GST at the configured rate).
  app.post('/api/laundry/orders/:id/deliver', async (req) => {
    const who = await need(req, 'hk.attend', 'hk.manage', 'front_desk')
    const { id } = req.params as { id: string }
    return db.tx(async (t) => {
      const [o] = await t.query<{ status: string; reservation_id: string; total_paise: number; items: { name: string; qty: number }[]; express: boolean }>(
        'select status, reservation_id, total_paise, items, express from laundry_order where id = $1 for update', [id])
      if (!o) throw new HttpError(404, 'No such laundry order.')
      if (o.status !== 'picked_up') throw new HttpError(409, `Already ${o.status}.`)
      const [f] = await t.query<{ id: string }>(`select f.id from folio f join reservation r on r.id = f.reservation_id where f.reservation_id = $1 and f.status = 'open' order by f.created_at limit 1`, [o.reservation_id])
      if (!f) throw new HttpError(409, 'The guest has checked out. Add the charge at the front desk.')
      const rate = ctx.tax.gst.other_services?.laundry?.rate ?? 18
      const g = splitGst(Number(o.total_paise), rate)
      const lineId = newId('L')
      await t.query(
        `insert into folio_line (id, folio_id, business_date, posted_at, kind, description, sac, gst_rate, taxable_paise, cgst_paise, sgst_paise, amount_paise, posted_by, ref)
         values ($1,$2,$3,$4,'laundry',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [lineId, f.id, await businessDate(t), now(), `Laundry${o.express ? ' (express)' : ''} · ${o.items.map((i) => `${i.qty} × ${i.name}`).join(', ')}`,
          ctx.tax.gst.other_services?.laundry?.sac ?? null, rate, g.taxable, g.cgst, g.sgst, g.total, who.userId, id])
      await t.query(`update laundry_order set status = 'delivered', delivered_by = $2, delivered_at = $3, folio_line_id = $4 where id = $1`, [id, who.userId, now(), lineId])
      await appendAudit(t, { actor: who, action: 'laundry.deliver', entity: { type: 'laundry_order', id }, amount: g.total }, now())
      return { ok: true, chargedPaise: g.total, balance: await folioBalance(t, f.id) }
    })
  })

  // ---------- public areas ----------
  app.get('/api/hk/areas', async (req) => {
    await need(req, 'hk.view', 'hk.attend', 'hk.manage')
    const day = await businessDate(db)
    const rows = await db.query<{ rounds_per_day: number; done: number; last_at: string | null }>(
      `select a.id, a.name, a.space_id, s.twin_id, a.code, a.rounds_per_day, a.active,
              (select count(*)::int from area_round r where r.area_id = a.id and r.business_date = $1) as done,
              (select max(r.at) from area_round r where r.area_id = a.id) as last_at,
              (select u.name from area_round r join app_user u on u.id = r.by_user where r.area_id = a.id order by r.at desc limit 1) as last_by
         from public_area a left join space s on s.id = a.space_id order by a.active desc, a.name`, [day])
    // A round is overdue when the gap since the last one is longer than the day divided by the rounds due.
    const gap = (n: number) => (16 * 60) / n
    return rows.map((a) => ({ ...a, overdue: a.done < a.rounds_per_day && (!a.last_at || (now().getTime() - new Date(a.last_at).getTime()) / 60_000 > gap(a.rounds_per_day)) }))
  })

  app.post('/api/hk/areas', async (req, reply) => {
    const who = await need(req, 'hk.manage')
    const b = req.body as { name?: string; spaceId?: string | null; roundsPerDay?: number }
    if (!b?.name?.trim()) throw new HttpError(400, 'Name the area (e.g. Lobby washrooms).')
    const id = newId('PA'), code = `SPR-${randomBytes(5).toString('hex').toUpperCase()}`
    await db.tx(async (t) => {
      await t.query('insert into public_area (id, name, space_id, code, rounds_per_day) values ($1,$2,$3,$4,$5)', [id, b.name!.trim(), b.spaceId ?? null, code, b.roundsPerDay ?? 2])
      await appendAudit(t, { actor: who, action: 'public_area.add', entity: { type: 'public_area', id }, after: b }, now())
    })
    return reply.status(201).send({ id, code })
  })

  app.patch('/api/hk/areas/:id', async (req) => {
    const who = await need(req, 'hk.manage')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; roundsPerDay?: number; active?: boolean }
    return db.tx(async (t) => {
      const [before] = await t.query('select * from public_area where id = $1 for update', [id])
      if (!before) throw new HttpError(404, 'No such area.')
      await t.query('update public_area set name = coalesce($2, name), rounds_per_day = coalesce($3, rounds_per_day), active = coalesce($4, active) where id = $1', [id, b.name?.trim() ?? null, b.roundsPerDay ?? null, b.active ?? null])
      const [after] = await t.query('select * from public_area where id = $1', [id])
      await appendAudit(t, { actor: who, action: 'public_area.update', entity: { type: 'public_area', id }, before, after }, now())
      return after
    })
  })

  // Printable QR labels to fix in each area.
  app.get('/api/hk/areas/labels', async (req, reply) => {
    await need(req, 'hk.manage')
    const areas = await db.query<{ name: string; code: string }>('select name, code from public_area where active order by name')
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cleaning round QR codes</title><style>
      body{font:14px system-ui;margin:16px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
      .l{border:1px dashed #999;padding:12px;text-align:center;break-inside:avoid}.l svg{width:150px;height:150px}.n{font-weight:700;font-size:16px}.c{font:11px monospace;color:#555}
    </style></head><body><div class="grid">${areas.map((a) => {
      const q = qrcode(0, 'M'); q.addData(a.code); q.make()
      return `<div class="l"><div class="n">${esc(a.name)}</div>${q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}<div>Scan with the Sathya staff app after cleaning</div><div class="c">${esc(a.code)}</div></div>`
    }).join('')}</div><script>window.onload=()=>window.print()</script></body></html>`
    return reply.type('text/html; charset=utf-8').send(html)
  })

  // Scanning the QR code on site proves the round was done there.
  app.post('/api/hk/rounds', async (req, reply) => {
    const who = await need(req, 'hk.attend', 'hk.manage')
    const b = req.body as { code?: string; note?: string; photoId?: string }
    return db.tx(async (t) => {
      const [a] = await t.query<{ id: string; name: string }>('select id, name from public_area where code = $1 and active', [String(b?.code ?? '').trim()])
      if (!a) throw new HttpError(404, 'That QR code is not a cleaning point. Scan the code fixed in the area.')
      const id = newId('AR')
      await t.query('insert into area_round (id, area_id, by_user, at, business_date, note, photo_id) values ($1,$2,$3,$4,$5,$6,$7)',
        [id, a.id, who.userId, now(), await businessDate(t), b.note?.trim() || null, b.photoId ?? null])
      await appendAudit(t, { actor: who, action: 'hk.round', entity: { type: 'public_area', id: a.id }, after: { area: a.name } }, now())
      return reply.status(201).send({ id, area: a.name })
    })
  })
}

/** Starting lists so the screens are useful on day one (prices and pars are samples to edit). */
export async function ensureLinenLaundryAreas(db: Db) {
  const [{ n }] = await db.query<{ n: number }>('select count(*)::int as n from linen_item')
  if (n === 0) {
    const linen: [string, number][] = [['Bed sheet (double)', 2], ['Pillow cover', 4], ['Duvet cover', 1], ['Bath towel', 2], ['Hand towel', 2], ['Face towel', 2], ['Bath mat', 1], ['Bathrobe', 2]]
    for (const [name, par] of linen) await db.query('insert into linen_item (id, name, par_per_room) values ($1,$2,$3)', [`LN-${name.toUpperCase().replace(/[^A-Z]+/g, '-').replace(/-$/, '')}`, name, par])
    const laundry: [string, string, number][] = [['Shirt', 'wash_iron', 60], ['Trousers', 'wash_iron', 70], ['Saree', 'wash_iron', 150], ['Dhoti / veshti', 'wash_iron', 60], ['T-shirt', 'wash_iron', 50],
      ['Suit (2 piece)', 'dry_clean', 450], ['Saree (silk)', 'dry_clean', 350], ['Shirt', 'press', 30], ['Trousers', 'press', 35]]
    for (const [name, service, price] of laundry) await db.query('insert into laundry_item (id, name, service, price_paise) values ($1,$2,$3,$4)', [`LI-${randomUUID().slice(0, 6).toUpperCase()}`, name, service, price * 100])
  }
  const [{ a }] = await db.query<{ a: number }>('select count(*)::int as a from public_area')
  if (a === 0) {
    const spaces = new Set((await db.query<{ id: string }>('select id from space')).map((s) => s.id))
    const areas: [string, string | null, number][] = [['Lobby & reception', 'RECEPTION', 4], ['Lobby washrooms', 'RECEPTION', 6], ['Sathya Dine', 'RESTAURANT', 3], ['Pool deck', 'POOL', 3],
      ['A. John Samuel Hall', 'HALL-JSH', 1], ['Convention Hall', 'CONV-HALL', 1], ['Garden Lawn', 'LAWN-GARDEN', 1], ['Grand Lawn', 'LAWN-GRAND', 1], ['Park Wing corridors', null, 2], ['Pavilion', 'PAVILION', 1]]
    for (const [name, space, rounds] of areas) {
      await db.query('insert into public_area (id, name, space_id, code, rounds_per_day) values ($1,$2,$3,$4,$5)',
        [`PA-${randomUUID().slice(0, 8).toUpperCase()}`, name, space && spaces.has(space) ? space : null, `SPR-${randomBytes(5).toString('hex').toUpperCase()}`, rounds])
    }
  }
}
