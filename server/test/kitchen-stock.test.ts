import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Recipes take ingredients off the kitchen stock as KOTs are sent; receipts, wastage and counts move it
// too; the food cost report compares what was sold with what it cost.

let R: Awaited<ReturnType<typeof testResort>>
let CHEF = '', FNB = '', CAP = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const ing = async (name: string) => (await R.get('/api/kitchen/ingredients', CHEF)).json().find((i: { name: string }) => i.name === name)

beforeAll(async () => {
  R = await testResort('2026-11-01')
  CHEF = await R.staff('Chef Ravi', '9840000051', ['chef'])
  FNB = await R.staff('Lakshmi', '9840000052', ['fnb_manager'])
  CAP = await R.staff('Murugan', '9840000053', ['captain'])
}, 40_000)
afterAll(() => R.close())

describe('recipes', () => {
  it('starts with sample ingredients and recipes, costed per portion', async () => {
    const dosa = (await R.get('/api/kitchen/recipes', CHEF)).json().find((d: { code: string }) => d.code === 'BF02')
    // batter 150 g × 6p + masala 100 g × 8p + oil 15 ml × 15p + chutney 40 g × 12p + sambar 120 ml × 7p
    expect(dosa).toMatchObject({ name: 'Masala Dosa', price_paise: 14000, costPaise: 900 + 800 + 225 + 480 + 840 })
    expect(dosa.costPercent).toBeCloseTo(23.2, 1)
    expect(dosa.outlets.sort()).toEqual(['DINE', 'IRD', 'POOL'])
  })

  it('lets the chef add ingredients and change a recipe; captains cannot', async () => {
    const r = await R.post('/api/kitchen/ingredients', CHEF, { name: 'Ghee', unit: 'ml', costPerPack: 600, parLevel: 2000 })
    expect(r.statusCode).toBe(201)
    expect((await R.post('/api/kitchen/ingredients', CHEF, { name: 'ghee', unit: 'ml' })).statusCode).toBe(409)
    const ghee = r.json().id
    const dosa = (await R.get('/api/kitchen/recipes', CHEF)).json().find((d: { code: string }) => d.code === 'BF02')
    const lines = [...dosa.lines.map((l: { ingredientId: string; qty: number }) => ({ ingredientId: l.ingredientId, qty: l.qty })), { ingredientId: ghee, qty: 5 }]
    expect((await put('/api/kitchen/recipes/BF02', CAP, { lines })).statusCode).toBe(403)
    expect((await put('/api/kitchen/recipes/BF02', CHEF, { lines: [...lines, lines[0]] })).statusCode).toBe(400)
    expect((await put('/api/kitchen/recipes/BF02', CHEF, { lines })).json()).toEqual({ ok: true })
    const after = (await R.get('/api/kitchen/recipes', CHEF)).json().find((d: { code: string }) => d.code === 'BF02')
    expect(after.costPaise).toBe(3245 + 300)
    expect((await patch(`/api/kitchen/ingredients/${ghee}`, CHEF, { active: false })).json().error).toMatch(/BF02 still uses it/)
  })
})

describe('stock movements', () => {
  it('receives stock and updates the cost from the latest price', async () => {
    const batter = await ing('Dosa batter')
    await R.post('/api/kitchen/receipts', CHEF, { lines: [{ ingredientId: batter.id, qty: 10000, cost: 650 }], note: 'From stores' })
    expect(await ing('Dosa batter')).toMatchObject({ stock: 10000, costPerPack: 65, valuePaise: 65000 })
  })

  it('takes recipes off the stock when the KOT is sent', async () => {
    const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'DINE', tableId: 'DINE-T1', covers: 2 })).json()
    await R.post(`/api/fnb/orders/${o.id}/items`, CAP, { items: [{ itemId: 'DINE-BF02', qty: 2 }, { itemId: 'DINE-SI02' }] })
    expect((await ing('Dosa batter')).stock).toBe(10000)
    await R.post(`/api/fnb/orders/${o.id}/send`, CAP)
    expect((await ing('Dosa batter')).stock).toBe(9700)
    expect((await ing('Sambar')).stock).toBe(-240)              // never received: shows below zero
  })

  it('records wastage within the chef\'s limit and sends larger wastage to the F&B manager', async () => {
    const batter = await ing('Dosa batter')
    expect((await R.post('/api/kitchen/wastage', CHEF, { ingredientId: batter.id, qty: 1000 })).statusCode).toBe(400)
    expect((await R.post('/api/kitchen/wastage', CHEF, { ingredientId: batter.id, qty: 1000, reason: 'Batter turned sour' })).json()).toMatchObject({ ok: true, valuePaise: 6500 })
    const paneer = await ing('Paneer')
    const big = await R.post('/api/kitchen/wastage', CHEF, { ingredientId: paneer.id, qty: 3000, reason: 'Fridge failed overnight' })   // ₹1,200, above ₹1,000
    expect(big.statusCode).toBe(202)
    await R.post(`/api/approvals/${big.json().approvalId}/decide`, FNB, { decision: 'approve' })
    expect((await ing('Dosa batter')).stock).toBe(8700)
    expect((await ing('Paneer')).stock).toBe(-3000)
  })

  it('corrects the book stock to a physical count and reports the shortfall', async () => {
    const batter = await ing('Dosa batter')
    const c = (await R.post('/api/kitchen/counts', CHEF, { lines: [{ ingredientId: batter.id, qty: 8500 }] })).json()
    expect(c.lines[0]).toMatchObject({ difference: -200, valuePaise: -1300 })
    expect(c.shortfallPaise).toBe(1300)
    expect((await ing('Dosa batter')).stock).toBe(8500)
  })
})

describe('food cost', () => {
  it('compares sales with recipe cost, adds wastage and count losses, and classes the dishes', async () => {
    expect((await R.get('/api/kitchen/food-cost', CAP)).statusCode).toBe(403)
    const r = (await R.get('/api/kitchen/food-cost?from=2026-11-01&to=2026-11-01', FNB)).json()
    const dosa = r.dishes.find((d: { code: string }) => d.code === 'BF02')
    // 2 portions: batter at the new 6.5p/g, ghee 5 ml × 60p
    expect(dosa).toMatchObject({ qty: 2, salesPaise: 28000, hasRecipe: true, costPaise: 2 * (975 + 800 + 225 + 480 + 840 + 300) })
    expect(r.dishes.find((d: { code: string }) => d.code === 'SI02')).toMatchObject({ hasRecipe: false, costPaise: 0 })
    expect(r.totals).toMatchObject({ salesPaise: 28000 + 26000, wastagePaise: 6500 + 120000, countLossPaise: 1300, dishesWithoutRecipe: ['SI02'] })
    expect(r.totals.actualCostPaise).toBe(r.totals.theoreticalCostPaise + 6500 + 120000 + 1300)
    expect(dosa.class).toBe('star')
  })
})
