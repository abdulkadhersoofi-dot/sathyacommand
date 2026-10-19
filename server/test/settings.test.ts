import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Licences, VAT rates and the restaurant set-up are edited in the app, checked, and logged.

let R: Awaited<ReturnType<typeof testResort>>
let ACC = '', GM = '', FNB = '', CAP = '', BAR = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })

beforeAll(async () => {
  R = await testResort('2026-11-01')
  ACC = await R.staff('Meena', '9840000021', ['accounts'])
  GM = await R.staff('Karthik', '9840000022', ['general_manager'])
  FNB = await R.staff('Lakshmi', '9840000023', ['fnb_manager'])
  CAP = await R.staff('Murugan', '9840000024', ['captain'])
  BAR = await R.staff('Joseph', '9840000025', ['bartender'])
}, 30_000)
afterAll(() => R.close())

describe('licences', () => {
  it('checks the number format for FSSAI and TN VAT, and prints them on the right bills', async () => {
    expect((await R.post('/api/licences', ACC, { kind: 'fssai', name: 'FSSAI', number: '1234' })).json().error).toMatch(/14 digits/)
    const f = await R.post('/api/licences', ACC, { kind: 'fssai', name: 'FSSAI State Licence', number: '12423008000123', validUntil: '2027-03-31' })
    expect(f.statusCode).toBe(201)
    expect((await R.post('/api/licences', ACC, { kind: 'tn_vat', name: 'TN VAT', number: '29123456789' })).json().error).toMatch(/starting with 33/)
    expect((await R.post('/api/licences', GM, { kind: 'tn_vat', name: 'TN VAT registration', number: '33123456789' })).statusCode).toBe(201)
    expect((await R.post('/api/licences', CAP, { kind: 'fire_noc', name: 'Fire NOC', number: 'F/123' })).statusCode).toBe(403)
    const list = (await R.get('/api/licences', CAP)).json()
    expect(list.find((l: { kind: string }) => l.kind === 'fssai')).toMatchObject({ number: '12423008000123', print_on: ['fnb_bill', 'vat_bill'], state: 'valid' })
    expect(list.find((l: { kind: string }) => l.kind === 'tn_vat').print_on).toEqual(['vat_bill'])
  })

  it('flags licences due for renewal or expired, and keeps edits in the log', async () => {
    const r = (await R.post('/api/licences', GM, { kind: 'fire_noc', name: 'Fire NOC', number: 'FNOC/CBE/2025/118', validUntil: '2026-11-20', authority: 'TN Fire & Rescue' })).json()
    let l = (await R.get('/api/licences', GM)).json().find((x: { id: string }) => x.id === r.id)
    expect(l.state).toBe('renew_soon')
    await patch(`/api/licences/${r.id}`, GM, { validUntil: '2026-10-01' })
    l = (await R.get('/api/licences', GM)).json().find((x: { id: string }) => x.id === r.id)
    expect(l.state).toBe('expired')
    expect((await patch(`/api/licences/${r.id}`, GM, { validFrom: '2026-12-01' })).json().error).toMatch(/after valid from/)
    await patch(`/api/licences/${r.id}`, GM, { validUntil: '2027-10-01', number: 'FNOC/CBE/2026/044' })
    l = (await R.get('/api/licences', GM)).json().find((x: { id: string }) => x.id === r.id)
    expect(l).toMatchObject({ number: 'FNOC/CBE/2026/044', state: 'valid' })
    const audit = (await R.get('/api/audit?limit=3', R.md)).json()
    expect(audit[0]).toMatchObject({ action: 'licence.update' })
  })
})

describe('TN VAT rates', () => {
  it('starts with the liquor classes and no rates until accounts set them', async () => {
    const v = (await R.get('/api/vat-rates', BAR)).json()
    expect(v.map((c: { id: string; rate: number | null }) => [c.id, c.rate]).sort()).toEqual([['beer', null], ['imfl_spirits', null], ['wine', null]])
  })

  it('lets only accounts or the MD set a rate, from today or a future date', async () => {
    expect((await put('/api/vat-rates/beer', GM, { rate: 14.5 })).statusCode).toBe(403)
    expect((await put('/api/vat-rates/beer', ACC, { rate: 14.555 })).statusCode).toBe(400)
    expect((await put('/api/vat-rates/beer', ACC, { rate: 14.5 })).json()).toEqual({ liquorClass: 'beer', rate: 14.5, effectiveFrom: '2026-11-01' })
    expect((await put('/api/vat-rates/beer', ACC, { rate: 16, effectiveFrom: '2026-12-01', note: 'G.O. dated 20 Nov' })).statusCode).toBe(200)
    expect((await put('/api/vat-rates/beer', ACC, { rate: 12, effectiveFrom: '2026-10-01' })).json().error).toMatch(/Only the MD/)
    expect((await put('/api/vat-rates/beer', R.md, { rate: 12, effectiveFrom: '2026-10-01' })).statusCode).toBe(200)
    const beer = (await R.get('/api/vat-rates', BAR)).json().find((c: { id: string }) => c.id === 'beer')
    expect(beer.rate).toBe(14.5)
    expect(beer.upcoming).toEqual([expect.objectContaining({ rate: 16, effective_from: '2026-12-01', note: 'G.O. dated 20 Nov' })])
    expect(beer.history).toHaveLength(3)
  })

  it('adds a liquor class that menu items can then use', async () => {
    expect((await R.post('/api/vat-classes', ACC, { id: 'Brandy', label: 'Brandy' })).statusCode).toBe(400)
    expect((await R.post('/api/vat-classes', ACC, { id: 'ready_to_drink', label: 'Ready-to-drink' })).statusCode).toBe(201)
    await put('/api/vat-rates/ready_to_drink', ACC, { rate: 20 })
    const item = await R.post('/api/fnb/items', GM, { outletId: 'BAR', code: 'RTD1', name: 'Breezer', price: 220, stationId: 'BAR', liquorClass: 'ready_to_drink', category: 'Ready-to-drink' })
    expect(item.statusCode).toBe(201)
    expect((await patch('/api/vat-classes/ready_to_drink', ACC, { active: false })).json().error).toMatch(/Breezer is still sold/)
  })

  it('adds VAT to the order total at the rate in force, and flags classes without a rate', async () => {
    await put('/api/fnb/bar-settings', GM, { open: '09:00', close: '23:00' })
    const o = (await R.post('/api/fnb/orders', BAR, { outletId: 'BAR', tableId: 'BAR-B1' })).json()
    const r = (await R.post(`/api/fnb/orders/${o.id}/items`, BAR, { items: [{ itemId: 'BAR-BR01', qty: 2 }, { itemId: 'BAR-RTD1' }, { itemId: 'BAR-SP01' }, { itemId: 'BAR-BS01' }] })).json()
    // beer 640 × 14.5% = 92.80; breezer 220 × 20% = 44; whisky has no rate yet
    expect(r.totals).toMatchObject({ food: 12000, liquorBeforeVat: 104000, vat: 9280 + 4400, vatMissing: ['imfl_spirits'] })
    expect(r.totals.payable).toBe(12000 + 600 + 104000 + 13680)
  })
})

describe('restaurant set-up', () => {
  it('adds and edits outlets, stations, menu sections and tables', async () => {
    expect((await R.post('/api/fnb/outlets', CAP, { id: 'CAFE', name: 'Lobby Café', kind: 'restaurant' })).statusCode).toBe(403)
    expect((await R.post('/api/fnb/outlets', FNB, { id: 'CAFE', name: 'Lobby Café', kind: 'restaurant', spaceId: 'RECEPTION' })).statusCode).toBe(201)
    expect((await patch('/api/fnb/outlets/CAFE', FNB, { name: 'Lobby Coffee Shop', servesLiquor: false })).json()).toMatchObject({ name: 'Lobby Coffee Shop', space_id: 'RECEPTION' })
    expect((await R.post('/api/fnb/stations', FNB, { id: 'COFFEE', name: 'Coffee bar', kind: 'kitchen' })).statusCode).toBe(201)
    const cat = (await R.post('/api/fnb/categories', FNB, { outletId: 'CAFE', name: 'Coffee' })).json()
    expect((await R.post('/api/fnb/categories', FNB, { outletId: 'CAFE', name: 'Coffee' })).statusCode).toBe(409)
    await R.post('/api/fnb/items', FNB, { outletId: 'CAFE', code: 'CF1', name: 'Cappuccino', price: 150, stationId: 'COFFEE', categoryId: cat.id })
    expect((await patch(`/api/fnb/categories/${cat.id}`, FNB, { name: 'Hot coffee', sort: 1 })).json()).toMatchObject({ name: 'Hot coffee', sort: 1 })
    expect((await patch('/api/fnb/stations/COFFEE', FNB, { active: false })).json().error).toMatch(/Cappuccino is still made here/)
    const menu = (await R.get('/api/fnb/menu?outletId=CAFE', CAP)).json()
    expect(menu.items[0]).toMatchObject({ name: 'Cappuccino', station_id: 'COFFEE', category_id: cat.id })

    await R.post('/api/fnb/tables', FNB, { outletId: 'CAFE', label: 'C1', seats: 2 })
    expect((await patch('/api/fnb/tables/CAFE-C1', FNB, { seats: 4, section: 'Lobby' })).json()).toMatchObject({ seats: 4, section: 'Lobby' })
    const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'CAFE', tableId: 'CAFE-C1' })).json()
    expect((await patch('/api/fnb/tables/CAFE-C1', FNB, { active: false })).json().error).toMatch(/open order/)
    expect((await patch('/api/fnb/outlets/CAFE', FNB, { active: false })).json().error).toMatch(/open orders/)
    await R.post(`/api/fnb/orders/${o.id}/cancel`, CAP, {})
    expect((await patch('/api/fnb/outlets/CAFE', FNB, { active: false })).json().active).toBe(false)
    const all = (await R.get('/api/fnb/outlets?all=true', FNB)).json().outlets
    expect(all.find((x: { id: string }) => x.id === 'CAFE').active).toBe(false)
  })

  it('retires a menu item and still shows it to editors', async () => {
    await patch('/api/fnb/items/DINE-CH03', FNB, { active: false })
    expect((await R.get('/api/fnb/menu?outletId=DINE', CAP)).json().items.some((i: { code: string }) => i.code === 'CH03')).toBe(false)
    const all = (await R.get('/api/fnb/menu?outletId=DINE&all=true', FNB)).json().items
    expect(all.find((i: { code: string }) => i.code === 'CH03').active).toBe(false)
  })
})
