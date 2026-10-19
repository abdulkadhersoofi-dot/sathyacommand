import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// A restaurant service from the captain's tablet to the kitchen screens and back, with the controls
// the MD relies on: sold-out items, liquor hours and dry days, cancellations after KOT, reprints.

let R: Awaited<ReturnType<typeof testResort>>
let CAP = '', CHEF = '', FNB = '', GM = '', FD = '', BAR = ''
const ids: Record<string, string> = {}

const menu = async (outletId: string) => (await R.get(`/api/fnb/menu?outletId=${outletId}`, CAP)).json()
const add = (orderId: string, items: unknown[], token = CAP) => R.post(`/api/fnb/orders/${orderId}/items`, token, { items })

beforeAll(async () => {
  R = await testResort('2026-11-01')            // clock starts 09:00 IST
  CAP = await R.staff('Murugan', '9840000011', ['captain'])
  CHEF = await R.staff('Chef Ravi', '9840000012', ['chef'])
  FNB = await R.staff('Lakshmi', '9840000013', ['fnb_manager'])
  GM = await R.staff('Karthik', '9840000014', ['general_manager'])
  FD = await R.staff('Priya', '9840000015', ['reception'])
  BAR = await R.staff('Joseph', '9840000016', ['bartender'])
}, 30_000)
afterAll(() => R.close())

describe('outlets and menu', () => {
  it('starts with outlets, stations, tables and a placeholder menu in Tamil and English', async () => {
    const { outlets, stations } = (await R.get('/api/fnb/outlets', CAP)).json()
    expect(outlets.map((o: { id: string }) => o.id).sort()).toEqual(['BAR', 'DINE', 'IRD', 'POOL'])
    expect(stations.map((s: { id: string }) => s.id)).toContain('BAR')
    const m = await menu('DINE')
    const dosa = m.items.find((i: { code: string }) => i.code === 'BF02')
    expect(dosa).toMatchObject({ name: 'Masala Dosa', name_ta: 'மசாலா தோசை', price_paise: 14000, station_id: 'SI', placeholder: true })
    expect((await R.get('/api/fnb/tables?outletId=DINE', CAP)).json()).toHaveLength(20)
  })

  it('lets only the GM change prices; the F&B manager\'s change waits for approval', async () => {
    expect((await R.post('/api/fnb/items', CHEF, { outletId: 'DINE', code: 'X1', name: 'Test', price: 10, stationId: 'SI' })).statusCode).toBe(403)
    const req = await R.app.inject({ method: 'PATCH', url: '/api/fnb/items/DINE-BV01', headers: { authorization: `Bearer ${FNB}` }, payload: { price: 70, nameTa: 'காபி' } })
    expect(req.statusCode).toBe(202)
    expect(req.json().item).toMatchObject({ price_paise: 6000, name_ta: 'காபி' })
    const inbox = (await R.get('/api/approvals', GM)).json()
    const a = inbox.find((x: { kind: string }) => x.kind === 'menu.price')
    expect(a.payload).toMatchObject({ item: 'Filter Coffee', from: 6000, price: 7000 })
    expect((await R.post(`/api/approvals/${a.id}/decide`, GM, { decision: 'approve' })).json()).toMatchObject({ status: 'approved' })
    expect((await menu('DINE')).items.find((i: { code: string }) => i.code === 'BV01').price_paise).toBe(7000)
  })

  it('refuses liquor items that do not go to the bar, and unknown liquor classes', async () => {
    const r = await R.post('/api/fnb/items', GM, { outletId: 'BAR', code: 'GN1', name: 'Gin (30 ml)', price: 200, stationId: 'SI', liquorClass: 'imfl_spirits' })
    expect(r.json().error).toMatch(/bar station/)
    expect((await R.post('/api/fnb/items', GM, { outletId: 'BAR', code: 'GN1', name: 'Gin', price: 200, stationId: 'BAR', liquorClass: 'toddy' })).statusCode).toBe(400)
    expect((await R.post('/api/fnb/items', GM, { outletId: 'BAR', code: 'GN1', name: 'Gin (30 ml)', price: 200, stationId: 'BAR', liquorClass: 'imfl_spirits', category: 'Spirits' })).statusCode).toBe(201)
  })

  it('imports the real menu and retires leftover placeholders', async () => {
    const r = await R.post('/api/fnb/menu/import', GM, {
      outletId: 'POOL', replacePlaceholders: true,
      items: [
        { code: 'BF02', name: 'Masala Dosa', price: 150, stationId: 'SI', category: 'Breakfast', nameTa: 'மசாலா தோசை' },
        { code: 'PL01', name: 'Fish Fingers', price: 340, stationId: 'CH', diet: 'non_veg', category: 'Snacks', allergens: ['fish', 'gluten'] },
      ],
    })
    expect(r.json()).toMatchObject({ created: 1, updated: 1 })
    expect(r.json().retired).toBeGreaterThan(5)
    expect((await menu('POOL')).items.map((i: { code: string }) => i.code).sort()).toEqual(['BF02', 'PL01'])
    expect((await R.post('/api/fnb/menu/import', FNB, { outletId: 'POOL', items: [{ code: 'Z', name: 'Z', price: 1, stationId: 'SI' }] })).statusCode).toBe(403)
  })
})

describe('taking an order', () => {
  it('opens one order per table', async () => {
    const r = await R.post('/api/fnb/orders', CAP, { outletId: 'DINE', tableId: 'DINE-T5', covers: 3 })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ number: 1, kind: 'dine_in', table_label: 'T5', covers: 3, status: 'open' })
    ids.T5 = r.json().id
    expect((await R.post('/api/fnb/orders', CAP, { outletId: 'DINE', tableId: 'DINE-T5' })).statusCode).toBe(409)
    expect((await R.post('/api/fnb/orders', CHEF, { outletId: 'DINE', tableId: 'DINE-T6' })).statusCode).toBe(403)
  })

  it('adds items with notes and keeps a running total with 5% GST on food', async () => {
    const r = await add(ids.T5, [
      { itemId: 'DINE-BF02', qty: 2, note: 'less oil' }, { itemId: 'DINE-NI01' }, { itemId: 'DINE-NI02', qty: 3 }, { itemId: 'DINE-BV01', qty: 3 },
    ])
    const o = r.json()
    expect(o.items).toHaveLength(4)
    expect(o.items.every((i: { status: string }) => i.status === 'pending')).toBe(true)
    // 2×140 + 320 + 3×70 + 3×70 = 1,020
    expect(o.totals).toMatchObject({ food: 102000, gstRate: 5, cgst: 2550, sgst: 2550, beforeVat: 107100 })
  })

  it('refuses items that are sold out, and the chef can mark them back', async () => {
    expect((await R.post('/api/fnb/items/DINE-DS01/availability', CHEF, { available: false })).json()).toEqual({ id: 'DINE-DS01', available: false })
    const r = await add(ids.T5, [{ itemId: 'DINE-DS01' }])
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/Gulab Jamun \(2\) is sold out/)
    await R.post('/api/fnb/items/DINE-DS01/availability', CHEF, { available: true })
  })

  it('removes an unsent item without a manager', async () => {
    const o = (await add(ids.T5, [{ itemId: 'DINE-CH01' }])).json()
    const gobi = o.items.find((i: { name: string }) => i.name === 'Gobi 65')
    expect((await R.post(`/api/fnb/order-items/${gobi.id}/void`, CAP, {})).json()).toEqual({ voided: true })
  })

  it('sends one ticket per station, numbered for the day, with allergens and notes', async () => {
    const r = (await R.post(`/api/fnb/orders/${ids.T5}/send`, CAP)).json()
    expect(r.tickets.map((t: { kind: string; number: number; station_id: string }) => `${t.kind}${t.number}:${t.station_id}`)).toEqual(['KOT1:SI', 'KOT2:NI', 'KOT3:BV'])
    const si = r.tickets[0]
    expect(si.order).toMatchObject({ number: 1, table: 'T5', covers: 3, outlet: 'Sathya Dine' })
    expect(si.lines).toEqual([{ qty: 2, name: 'Masala Dosa', note: 'less oil', seat: null, course: 1, alert: [] }])
    expect(r.tickets[1].lines.find((l: { name: string }) => l.name === 'Butter Naan').alert).toEqual(['GLUTEN', 'DAIRY'])
    expect(r.order.items.filter((i: { status: string }) => i.status === 'sent')).toHaveLength(4)
    expect((await R.post(`/api/fnb/orders/${ids.T5}/send`, CAP)).statusCode).toBe(409)
    const audit = (await R.get('/api/audit?limit=10', R.md)).json()
    expect(audit.find((a: { action: string }) => a.action === 'kot.create')).toBeTruthy()
  })

  it('moves the party to another table', async () => {
    const r = await R.post(`/api/fnb/orders/${ids.T5}/move`, CAP, { tableId: 'DINE-T7' })
    expect(r.json().table_label).toBe('T7')
    const tables = (await R.get('/api/fnb/tables?outletId=DINE', CAP)).json()
    expect(tables.find((t: { label: string }) => t.label === 'T7').order_number).toBe(1)
    expect(tables.find((t: { label: string }) => t.label === 'T5').order_id).toBeNull()
  })
})

describe('kitchen screens', () => {
  it('shows each station its tickets, oldest first, with all-day counts', async () => {
    R.advance(12)
    const k = (await R.get('/api/fnb/kds?stationId=NI', CHEF)).json()
    expect(k.tickets).toHaveLength(1)
    expect(k.tickets[0]).toMatchObject({ kind: 'KOT', number: 2, table_label: 'T7', ageMinutes: 12, status: 'new' })
    expect(k.allDay).toEqual([{ name: 'Butter Naan', qty: 3 }, { name: 'Paneer Butter Masala', qty: 1 }])
  })

  it('moves a ticket from cooking to ready, allows recall, and the captain marks it served', async () => {
    const kot = (await R.get('/api/fnb/kds?stationId=NI', CHEF)).json().tickets[0]
    expect((await R.post(`/api/fnb/kots/${kot.id}/status`, CAP, { status: 'cooking' })).statusCode).toBe(403)
    expect((await R.post(`/api/fnb/kots/${kot.id}/status`, CHEF, { status: 'cooking' })).json().status).toBe('cooking')
    expect((await R.post(`/api/fnb/kots/${kot.id}/status`, CHEF, { status: 'ready' })).json().status).toBe('ready')
    expect((await R.post(`/api/fnb/kots/${kot.id}/status`, CHEF, { status: 'cooking' })).json().status).toBe('cooking')   // recall
    await R.post(`/api/fnb/kots/${kot.id}/status`, CHEF, { status: 'ready' })
    expect((await R.post(`/api/fnb/kots/${kot.id}/status`, CHEF, { status: 'new' })).statusCode).toBe(400)
    expect((await R.post(`/api/fnb/kots/${kot.id}/status`, CAP, { status: 'served' })).json().status).toBe('served')
    expect((await R.get('/api/fnb/kds?stationId=NI', CHEF)).json().tickets).toHaveLength(0)
  })

  it('marks reprints as copies and logs them', async () => {
    const kot = (await R.get('/api/fnb/kds?stationId=SI', CHEF)).json().tickets[0]
    const p = (await R.post(`/api/fnb/kots/${kot.id}/reprint`, CAP)).json()
    expect(p).toMatchObject({ number: 1, kind: 'KOT', prints: 2, copy: true })
    expect(p.lines[0]).toMatchObject({ qty: 2, name: 'Masala Dosa', void: false })
    const audit = (await R.get('/api/audit?limit=5', R.md)).json()
    expect(audit[0]).toMatchObject({ action: 'kot.reprint' })
  })
})

describe('cancelling after KOT', () => {
  it('needs a reason, and from a captain it goes to a manager', async () => {
    const o = (await R.get(`/api/fnb/orders/${ids.T5}`, CAP)).json()
    const coffee = o.items.find((i: { name: string }) => i.name === 'Filter Coffee')
    expect((await R.post(`/api/fnb/order-items/${coffee.id}/void`, CAP, {})).statusCode).toBe(400)
    const r = await R.post(`/api/fnb/order-items/${coffee.id}/void`, CAP, { reason: 'Guest changed mind' })
    expect(r.statusCode).toBe(202)
    const a = (await R.get('/api/approvals', FNB)).json().find((x: { kind: string }) => x.kind === 'fnb.void_after_kot')
    expect(a.payload).toMatchObject({ item: 'Filter Coffee', qty: 3, amount: 21000, order: 1 })
    expect((await R.post(`/api/approvals/${a.id}/decide`, CAP, { decision: 'approve' })).statusCode).toBe(403)
    expect((await R.post(`/api/approvals/${a.id}/decide`, FNB, { decision: 'approve' })).json().status).toBe('approved')
    const after = (await R.get(`/api/fnb/orders/${ids.T5}`, CAP)).json()
    expect(after.items.find((i: { id: string }) => i.id === coffee.id)).toMatchObject({ status: 'void', void_reason: 'Guest changed mind' })
    expect(after.totals.food).toBe(102000 - 21000)
    const audit = (await R.get('/api/audit?limit=10', R.md)).json()
    expect(audit.find((x: { action: string }) => x.action === 'order_item.void_after_kot')).toMatchObject({ amount: 21000 })
  })

  it('a manager cancels directly, and the order cannot be cancelled whole once the kitchen has it', async () => {
    const o = (await R.get(`/api/fnb/orders/${ids.T5}`, CAP)).json()
    const naan = o.items.find((i: { name: string }) => i.name === 'Butter Naan')
    expect((await R.post(`/api/fnb/order-items/${naan.id}/void`, FNB, { reason: 'Burnt' })).json()).toEqual({ voided: true })
    expect((await R.post(`/api/fnb/orders/${ids.T5}/cancel`, CAP, { reason: 'Left' })).statusCode).toBe(409)
  })

  it('cancels an order that never reached the kitchen', async () => {
    const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'DINE', tableId: 'DINE-T9' })).json()
    await add(o.id, [{ itemId: 'DINE-SI03' }])
    expect((await R.post(`/api/fnb/orders/${o.id}/cancel`, CAP, { reason: 'Walked out' })).json()).toEqual({ ok: true })
    expect((await R.get('/api/fnb/orders?outletId=DINE', CAP)).json().map((x: { id: string }) => x.id)).not.toContain(o.id)
  })
})

describe('liquor', () => {
  it('is refused until the licensed hours are set, then only within them', async () => {
    const o = (await R.post('/api/fnb/orders', BAR, { outletId: 'BAR', tableId: 'BAR-B2', covers: 2 })).json()
    ids.B2 = o.id
    const before = await add(o.id, [{ itemId: 'BAR-BR01' }], BAR)
    expect(before.statusCode).toBe(409)
    expect(before.json().error).toMatch(/licensed bar hours/)
    expect((await R.app.inject({ method: 'PUT', url: '/api/fnb/bar-settings', headers: { authorization: `Bearer ${CAP}` }, payload: { open: '11:00', close: '23:00' } })).statusCode).toBe(403)
    await R.app.inject({ method: 'PUT', url: '/api/fnb/bar-settings', headers: { authorization: `Bearer ${GM}` }, payload: { open: '11:00', close: '23:00' } })
    const early = await add(o.id, [{ itemId: 'BAR-BR01' }], BAR)              // it is about 09:15
    expect(early.json().error).toMatch(/Outside licensed hours \(11:00–23:00\)/)
    expect((await add(o.id, [{ itemId: 'BAR-BS01' }], BAR)).statusCode).toBe(200)   // snacks are fine
    R.advance(120)
    const ok = await add(o.id, [{ itemId: 'BAR-BR01', qty: 2 }, { itemId: 'BAR-SP01' }], BAR)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().totals).toMatchObject({ food: 12000, liquorBeforeVat: 82000 })
  })

  it('sends liquor to the bar as a BOT, numbered separately from KOTs', async () => {
    const r = (await R.post(`/api/fnb/orders/${ids.B2}/send`, BAR)).json()
    expect(r.tickets.map((t: { kind: string; number: number }) => `${t.kind}${t.number}`)).toEqual(['BOT1'])
    expect(r.tickets[0].lines.map((l: { name: string }) => l.name)).toEqual(['Masala Peanuts', 'Beer 650 ml', 'Whisky (30 ml)'])
  })

  it('is closed all day on a dry day', async () => {
    const d = await R.post('/api/fnb/dry-days', GM, { day: '2026-11-01', reason: 'Test dry day' })
    expect(d.statusCode).toBe(201)
    const r = await add(ids.B2, [{ itemId: 'BAR-BR01' }], BAR)
    expect(r.json().error).toMatch(/Dry day/)
    const s = (await R.get('/api/fnb/bar-settings', BAR)).json()
    expect(s).toMatchObject({ open: '11:00', close: '23:00', legalAge: 21, liquorNow: { allowed: false } })
    expect((await R.app.inject({ method: 'DELETE', url: '/api/fnb/dry-days/2026-11-01', headers: { authorization: `Bearer ${GM}` } })).statusCode).toBe(200)
  })
})

describe('room service', () => {
  it('is only for checked-in guests, and shows the room on the ticket', async () => {
    const res = (await R.post('/api/reservations', FD, { roomTypeId: 'deluxe', plan: 'EP', arrival: '2026-11-01', departure: '2026-11-02', guest: { name: 'Anand' } })).json()
    expect((await R.post('/api/fnb/orders', FD, { outletId: 'IRD', reservationId: res.id })).statusCode).toBe(409)
    await R.post(`/api/reservations/${res.id}/check-in`, FD, { spaceId: 'RM-102', idType: 'aadhaar', idNumber: '1111 2222 3333' })
    const o = (await R.post('/api/fnb/orders', FD, { outletId: 'IRD', reservationId: res.id })).json()
    expect(o).toMatchObject({ kind: 'room_service', room_no: '102', guest: 'Anand' })
    await add(o.id, [{ itemId: 'IRD-SI03' }], FD)
    const t = (await R.post(`/api/fnb/orders/${o.id}/send`, FD)).json().tickets[0]
    expect(t.order).toMatchObject({ room: '102', outlet: 'Room Service' })
    expect(t.number).toBe(4)
    const list = (await R.get('/api/fnb/orders?outletId=IRD', FD)).json()
    expect(list[0]).toMatchObject({ room_no: '102', kitchen: 'new', pending_items: 0, subtotal_paise: 15000 })
  })
})
