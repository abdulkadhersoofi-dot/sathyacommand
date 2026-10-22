import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Food places: any place on the map can take orders, serving its own menu or another place's, with its
// tables made in one go.

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', CAP = ''

beforeAll(async () => {
  R = await testResort('2026-11-01')
  GM = await R.staff('Karthik', '9840000014', ['general_manager'])
  CAP = await R.staff('Murugan', '9840000011', ['captain'])
}, 30_000)
afterAll(() => R.close())

describe('food places', () => {
  it('adds a lawn café on the Grand Lawn that serves the restaurant\'s menu, with its tables', async () => {
    const r = await R.post('/api/fnb/outlets', GM, { name: 'Grand Lawn café', kind: 'lawn', spaceId: 'LAWN-GRAND', menuOf: 'DINE', tables: { count: 6, seats: 4, prefix: 'GL' } })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toEqual({ id: 'GRANDLAW', tables: 6 })
    const { outlets } = (await R.get('/api/fnb/outlets', CAP)).json()
    expect(outlets.find((o: { id: string }) => o.id === 'GRANDLAW')).toMatchObject({ name: 'Grand Lawn café', kind: 'lawn', space_id: 'LAWN-GRAND', menu_of: 'DINE', place: 'Grand Lawn' })
    const menu = (await R.get('/api/fnb/menu?outletId=GRANDLAW', CAP)).json()
    expect(menu.menuOutletId).toBe('DINE')
    expect(menu.items.some((i: { code: string }) => i.code === 'BF02')).toBe(true)
    const tables = (await R.get('/api/fnb/tables?outletId=GRANDLAW', CAP)).json()
    expect(tables.map((t: { label: string }) => t.label)).toEqual(['GL1', 'GL2', 'GL3', 'GL4', 'GL5', 'GL6'])
  })

  it('takes an order there from the borrowed menu and sends it to the kitchen', async () => {
    const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'GRANDLAW', tableId: 'GRANDLAW-GL2', covers: 3 })).json()
    expect(o.outlet).toBe('Grand Lawn café')
    const added = await R.post(`/api/fnb/orders/${o.id}/items`, CAP, { items: [{ itemId: 'DINE-BF02', qty: 2 }] })
    expect(added.statusCode).toBe(200)
    const sent = (await R.post(`/api/fnb/orders/${o.id}/send`, CAP)).json()
    expect(sent.tickets).toHaveLength(1)
    expect(sent.tickets[0].order.outlet).toBe('Grand Lawn café')
    const open = (await R.get('/api/fnb/orders', CAP)).json()
    expect(open.find((x: { id: string }) => x.id === o.id)).toMatchObject({ outlet_space_id: 'LAWN-GRAND', table_label: 'GL2' })
  })

  it('makes a code from the name, and keeps codes apart', async () => {
    const a = (await R.post('/api/fnb/outlets', GM, { name: 'Pool café', kind: 'cafe', spaceId: 'POOL', menuOf: 'DINE' })).json()
    const b = (await R.post('/api/fnb/outlets', GM, { name: 'Pool café', kind: 'cafe', spaceId: 'POOL', menuOf: 'DINE' })).json()
    expect(a.id).toBe('POOLCAF')
    expect(b.id).toBe('POOLCAF2')
  })

  it('refuses a menu chain and a place lending its menu switching to another\'s', async () => {
    expect((await R.post('/api/fnb/outlets', GM, { name: 'Chain', kind: 'cafe', menuOf: 'GRANDLAW' })).json().error).toMatch(/serves another place's menu/)
    const r = await R.app.inject({ method: 'PATCH', url: '/api/fnb/outlets/DINE', headers: { authorization: `Bearer ${GM}` }, payload: { menuOf: 'POOL' } })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/Grand Lawn café serves this place's menu/)
  })

  it('closes a place for the day and reopens it', async () => {
    const off = await R.app.inject({ method: 'PATCH', url: '/api/fnb/outlets/POOLCAF2', headers: { authorization: `Bearer ${GM}` }, payload: { active: false } })
    expect(off.statusCode).toBe(200)
    expect((await R.get('/api/fnb/outlets', CAP)).json().outlets.some((o: { id: string }) => o.id === 'POOLCAF2')).toBe(false)
    expect((await R.post('/api/fnb/orders', CAP, { outletId: 'POOLCAF2', kind: 'takeaway' })).statusCode).toBe(400)
    const on = await R.app.inject({ method: 'PATCH', url: '/api/fnb/outlets/POOLCAF2', headers: { authorization: `Bearer ${GM}` }, payload: { active: true } })
    expect(on.json().active).toBe(true)
  })
})
