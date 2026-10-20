import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Bar stock in ml: TASMAC purchases in, pegs and bottles out as BOTs are sent, breakage, and a
// physical count that the GM approves before the book is corrected.

let R: Awaited<ReturnType<typeof testResort>>
let BM = '', BT = '', GM = '', ACC = ''
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const stock = async () => Object.fromEntries((await R.get('/api/bar/stock', BM)).json().map((b: { id: string; ml: number; fullBottles: number; openMl: number }) => [b.id, b]))

beforeAll(async () => {
  R = await testResort('2026-11-01')
  BM = await R.staff('Joseph', '9840000041', ['bar_manager'])
  BT = await R.staff('Arul', '9840000042', ['bartender'])
  GM = await R.staff('Karthik', '9840000043', ['general_manager'])
  ACC = await R.staff('Meena', '9840000044', ['accounts'])
  await put('/api/fnb/bar-settings', GM, { open: '00:00', close: '23:59' })
}, 40_000)
afterAll(() => R.close())

describe('brands and purchases', () => {
  it('starts with sample brands linked to the sample bar menu', async () => {
    const brands = (await R.get('/api/bar/brands', BM)).json()
    expect(brands.map((b: { id: string }) => b.id).sort()).toEqual(['BR-BEER650', 'BR-REDWINE750', 'BR-RUM750', 'BR-WHISKY750'])
    const item = (await R.get('/api/fnb/menu?outletId=BAR', BM)).json().items.find((i: { code: string }) => i.code === 'SP01')
    expect(item).toMatchObject({ brand_id: 'BR-WHISKY750', pour_ml: 30 })
  })

  it('adds a brand and links a 60 ml peg to it', async () => {
    const b = (await R.post('/api/bar/brands', BM, { name: 'Royal Whisky 750 ml', liquorClass: 'imfl_spirits', bottleMl: 750 })).json()
    const item = (await R.post('/api/fnb/items', GM, { outletId: 'BAR', code: 'SP60', name: 'Royal Whisky (60 ml)', price: 320, stationId: 'BAR', liquorClass: 'imfl_spirits', category: 'Spirits' })).json()
    expect((await R.post(`/api/fnb/items/${item.id}/pour`, BM, { brandId: 'BR-BEER650', pourMl: 60 })).json().error).toMatch(/same liquor class/)
    expect((await R.post(`/api/fnb/items/${item.id}/pour`, BM, { brandId: b.id, pourMl: 800 })).statusCode).toBe(400)
    expect((await R.post(`/api/fnb/items/${item.id}/pour`, BM, { brandId: b.id, pourMl: 60 })).json()).toEqual({ ok: true })
    expect((await R.post('/api/bar/brands', BT, { name: 'X', liquorClass: 'beer', bottleMl: 650 })).statusCode).toBe(403)
  })

  it('accepts purchases only from TASMAC, once per invoice', async () => {
    expect((await R.post('/api/bar/purchases', BM, { supplier: 'Local Wines', invoiceNo: '1', invoiceDate: '2026-10-31', lines: [{ brandId: 'BR-BEER650', bottles: 24, cost: 150 }] })).json().error).toMatch(/only be bought from TASMAC/)
    const lines = [{ brandId: 'BR-BEER650', bottles: 24, cost: 150 }, { brandId: 'BR-WHISKY750', bottles: 6, cost: 900 }]
    expect((await R.post('/api/bar/purchases', BM, { supplier: 'TASMAC', invoiceNo: 'TSM/CBE/88231', invoiceDate: '2026-10-31', lines })).json().error).toMatch(/transport permit/)
    const r = await R.post('/api/bar/purchases', BM, { supplier: 'tasmac', invoiceNo: 'TSM/CBE/88231', invoiceDate: '2026-10-31', vat: 0, permitNo: 'TP/CBE/2026/4411', lines })
    // TCS at 1% on what TASMAC charged, a credit for the income-tax return.
    expect(r.json()).toMatchObject({ valuePaise: 24 * 15000 + 6 * 90000, tcsPaise: 9000, totalPaise: 909000 })
    expect((await R.post('/api/bar/purchases', BM, { supplier: 'TASMAC', invoiceNo: 'TSM/CBE/88231', invoiceDate: '2026-10-31', permitNo: 'X', lines: [{ brandId: 'BR-BEER650', bottles: 1, cost: 150 }] })).statusCode).toBe(409)
    const s = await stock()
    expect(s['BR-BEER650']).toMatchObject({ ml: 24 * 650, fullBottles: 24, openMl: 0 })
    expect(s['BR-WHISKY750']).toMatchObject({ ml: 4500, valuePaise: 540000 })
    expect((await R.get('/api/bar/purchases', ACC)).json()[0]).toMatchObject({ supplier: 'TASMAC', invoice_no: 'TSM/CBE/88231', permit_no: 'TP/CBE/2026/4411' })
  })
})

describe('sales come off the stock', () => {
  it('pours pegs and bottles when the BOT is sent, and puts back a cancelled item', async () => {
    const o = (await R.post('/api/fnb/orders', BT, { outletId: 'BAR', tableId: 'BAR-B3', covers: 2 })).json()
    await R.post(`/api/fnb/orders/${o.id}/items`, BT, { items: [{ itemId: 'BAR-SP01', qty: 3 }, { itemId: 'BAR-BR01', qty: 2 }] })
    let s = await stock()
    expect(s['BR-WHISKY750'].ml).toBe(4500)                 // nothing poured until it is sent
    await R.post(`/api/fnb/orders/${o.id}/send`, BT)
    s = await stock()
    expect(s['BR-WHISKY750']).toMatchObject({ ml: 4500 - 90, fullBottles: 5, openMl: 660 })
    expect(s['BR-BEER650'].ml).toBe(22 * 650)
    const beer = (await R.get(`/api/fnb/orders/${o.id}`, BT)).json().items.find((i: { name: string }) => i.name === 'Beer 650 ml')
    await R.post(`/api/fnb/order-items/${beer.id}/void`, BM, { reason: 'Wrong brand' })
    expect((await stock())['BR-BEER650'].ml).toBe(24 * 650)
  })

  it('keeps a daily register: opening, received, sold, breakage, closing', async () => {
    const r = (await R.get('/api/bar/register?date=2026-11-01', BT)).json()
    const w = r.brands.find((b: { id: string }) => b.id === 'BR-WHISKY750')
    expect(w).toMatchObject({ opening: 0, received: 4500, sold: 90, breakage: 0, closing: 4410 })
    const beer = r.brands.find((b: { id: string }) => b.id === 'BR-BEER650')
    expect(beer).toMatchObject({ received: 24 * 650, sold: 0, closing: 24 * 650 })
  })
})

describe('breakage and counts', () => {
  it('records breakage within the bar manager\'s limit, and sends a bartender\'s report for approval', async () => {
    expect((await R.post('/api/bar/breakage', BM, { brandId: 'BR-BEER650', ml: 650 })).statusCode).toBe(400)
    expect((await R.post('/api/bar/breakage', BM, { brandId: 'BR-BEER650', ml: 650, reason: 'Bottle dropped' })).statusCode).toBe(201)
    const r = await R.post('/api/bar/breakage', BT, { brandId: 'BR-WHISKY750', ml: 750, reason: 'Bottle cracked in the crate' })
    expect(r.statusCode).toBe(202)
    expect((await R.post(`/api/approvals/${r.json().approvalId}/decide`, BM, { decision: 'approve' })).statusCode).toBe(403)
    await R.post(`/api/approvals/${r.json().approvalId}/decide`, GM, { decision: 'approve' })
    const s = await stock()
    expect(s['BR-BEER650'].ml).toBe(23 * 650)
    expect(s['BR-WHISKY750'].ml).toBe(4410 - 750)
  })

  it('flags a count with variance above 3% and corrects the book only when the GM approves', async () => {
    const c = (await R.post('/api/bar/counts', BM, { lines: [{ brandId: 'BR-WHISKY750', fullBottles: 4, openMl: 500 }, { brandId: 'BR-BEER650', fullBottles: 23 }] })).json()
    expect(c.lines.find((l: { brandId: string }) => l.brandId === 'BR-WHISKY750')).toMatchObject({ bookMl: 3660, countedMl: 3500, varianceMl: -160 })
    expect(c.variancePercent).toBeCloseTo((160 / (3660 + 23 * 650)) * 100, 1)
    expect(c.alert).toBe(false)
    expect((await stock())['BR-WHISKY750'].ml).toBe(3660)
    await R.post(`/api/approvals/${c.approvalId}/decide`, GM, { decision: 'approve' })
    expect((await stock())['BR-WHISKY750'].ml).toBe(3500)

    const big = (await R.post('/api/bar/counts', BM, { lines: [{ brandId: 'BR-WHISKY750', fullBottles: 3, openMl: 0 }] })).json()
    expect(big.alert).toBe(true)
    const audit = (await R.get('/api/audit?limit=5', R.md)).json()
    expect(audit.some((a: { action: string }) => a.action === 'bar.count_variance_alert')).toBe(true)
    await R.post(`/api/approvals/${big.approvalId}/decide`, GM, { decision: 'reject' })
    expect((await stock())['BR-WHISKY750'].ml).toBe(3500)
    expect((await R.get('/api/bar/counts', GM)).json().map((x: { status: string }) => x.status).sort()).toEqual(['approved', 'rejected'])
    const reg = (await R.get('/api/bar/register?date=2026-11-01', BM)).json().brands.find((b: { id: string }) => b.id === 'BR-WHISKY750')
    expect(reg).toMatchObject({ breakage: 750, adjusted: -160, closing: 3500 })
  })
})
