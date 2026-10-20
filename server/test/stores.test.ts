import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testResort } from './helpers'

// Stores, the item master and the vendor master: GSTIN / PAN / IFSC checks, TDS category, MSME status,
// bank details kept to accounts, rate contracts.

let R: Awaited<ReturnType<typeof testResort>>
let GM = '', ST = '', AC = '', CHEF = ''
const patch = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const audit = async (action: string) => (await R.get('/api/audit?limit=200', R.md)).json().filter((a: { action: string }) => a.action === action)

beforeAll(async () => {
  R = await testResort('2026-11-01')
  GM = await R.staff('Karthik', '9840000401', ['general_manager'])
  ST = await R.staff('Mani', '9840000402', ['stores'])
  AC = await R.staff('Lakshmi', '9840000403', ['accounts'])
  CHEF = await R.staff('Bala', '9840000404', ['chef'])
}, 40_000)
afterAll(() => R.close())
beforeEach(async () => { for (const t of [R.md, GM, AC]) await R.get('/api/business-date', t) })

describe('stores and items', () => {
  it('starts with the main store and the department stores tied to their books', async () => {
    const stores = (await R.get('/api/stores', CHEF)).json()
    expect(stores.map((s: { id: string; ledger: string }) => `${s.id}:${s.ledger}`)).toEqual(expect.arrayContaining(['ST-MAIN:own', 'ST-KITCHEN:kitchen', 'ST-BAR:bar', 'ST-ENG:spares', 'ST-LINEN:linen']))
  })

  it('keeps items with units, conversions, HSN, GST and input tax credit', async () => {
    expect((await R.post('/api/items', CHEF, { name: 'x' })).statusCode).toBe(403)
    expect((await R.post('/api/items', ST, { name: 'Rice', category: 'food', unit: 'kg', purchaseUnit: 'bag', purchaseFactor: 25 })).json().error).toMatch(/Stock unit/)
    expect((await R.post('/api/items', ST, { name: 'Rice', category: 'food', unit: 'g', purchaseUnit: 'bag of 25 kg', purchaseFactor: 25000, gstRate: 7 })).json().error).toMatch(/GST rate/)
    const rice = (await R.post('/api/items', ST, { name: 'Ponni rice', category: 'food', unit: 'g', purchaseUnit: 'bag of 25 kg', purchaseFactor: 25000, hsn: '1006', gstRate: 5, itc: 'full', defaultStoreId: 'ST-MAIN', parLevel: 100000 })).json().id
    expect((await R.post('/api/items', ST, { name: 'Ponni rice', category: 'food', unit: 'g', purchaseUnit: 'kg', purchaseFactor: 1000 })).statusCode).toBe(409)
    expect((await R.get('/api/items?q=ponni', ST)).json()[0]).toMatchObject({ id: rice, hsn: '1006', gst_rate: '5.00', default_store: 'Main store' })
  })

  it('links items to the kitchen, bar, spares and linen books, in the same units', async () => {
    const [ing] = (await R.get('/api/kitchen/ingredients', GM)).json()
    expect((await R.post('/api/items', ST, { name: 'Linked wrong', category: 'food', unit: 'pcs', purchaseUnit: 'kg', purchaseFactor: 1000, ingredientId: ing.id })).json().error).toMatch(/keeps this ingredient in/)
    const r = (await R.post('/api/items/from-departments', ST)).json()
    expect(r.added).toBeGreaterThan(10)
    const items = (await R.get('/api/items', ST)).json()
    const liquor = items.find((i: { category: string }) => i.category === 'liquor')
    expect(liquor).toMatchObject({ unit: 'ml', default_store: 'Bar (liquor)', brand: expect.any(String) })
    expect(Number(liquor.purchase_factor)).toBeGreaterThan(100)
    expect(items.find((i: { category: string }) => i.category === 'linen')).toMatchObject({ unit: 'pcs', default_store: 'Linen room' })
    expect((await R.post('/api/items/from-departments', ST)).json().added).toBe(0)       // only once
    expect((await R.post('/api/items', ST, { name: 'Dup link', category: 'food', unit: ing.unit, purchaseUnit: 'kg', purchaseFactor: 1000, ingredientId: ing.id })).statusCode).toBe(409)
  })
})

describe('vendors', () => {
  let V = ''
  it('checks the GSTIN, takes the PAN and state from it, and the payee type from the PAN', async () => {
    expect((await R.post('/api/vendors', CHEF, { name: 'x' })).statusCode).toBe(403)
    expect((await R.post('/api/vendors', ST, { name: 'Fresh Farms', gstin: '33AAPFU0939F1ZX' })).json().error).toMatch(/last character/)
    expect((await R.post('/api/vendors', ST, { name: 'Fresh Farms', gstin: '27AAPFU0939F1ZV', pan: 'ABCPE1234F' })).json().error).toMatch(/does not match the GSTIN/)
    V = (await R.post('/api/vendors', ST, { name: 'Fresh Farms', gstin: '27aapfu0939f1zv', tdsCode: 'purchase_of_goods', categories: ['food'] })).json().id
    const v = (await R.get('/api/vendors?q=fresh', ST)).json()[0]
    expect(v).toMatchObject({ gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', state_code: '27', payee_type: 'firm', tds_code: 'purchase_of_goods' })
    expect((await R.post('/api/vendors', ST, { name: 'Again', gstin: '27AAPFU0939F1ZV' })).statusCode).toBe(409)
    expect((await R.post('/api/vendors', ST, { name: 'X', tdsCode: 'salary' })).json().error).toMatch(/Unknown TDS/)
  })

  it('needs the Udyam number for an MSME supplier', async () => {
    expect((await R.post('/api/vendors', ST, { name: 'Kumar Provisions', pan: 'ABCPK1234L', msme: 'micro' })).json().error).toMatch(/Udyam/)
    const id = (await R.post('/api/vendors', ST, { name: 'Kumar Provisions', pan: 'ABCPK1234L', msme: 'micro', udyamNo: 'udyam-tn-02-0012345', writtenAgreement: true })).json().id
    expect((await R.get('/api/vendors?q=kumar', ST)).json()[0]).toMatchObject({ id, payee_type: 'individual', msme: 'micro', udyam_no: 'UDYAM-TN-02-0012345' })
    expect((await R.get('/api/vendors/meta', ST)).json()).toMatchObject({ msmeDays: { with_agreement: 45, without_agreement: 15 }, tds: expect.arrayContaining([expect.objectContaining({ code: 'contractor', section: '194C' })]) })
  })

  it('keeps bank details to accounts and flags a changed account', async () => {
    expect((await patch(`/api/vendors/${V}`, ST, { bankAccount: '123456789012', ifsc: 'SBIN0001234' })).statusCode).toBe(403)
    expect((await patch(`/api/vendors/${V}`, AC, { ifsc: 'SBIN1001234' })).json().error).toMatch(/IFSC/)
    await patch(`/api/vendors/${V}`, AC, { bankName: 'SBI', bankAccount: '1234 5678 9012', ifsc: 'sbin0001234' })
    expect((await R.get('/api/vendors?q=fresh', ST)).json()[0].bank_account).toBe('••••9012')
    expect((await R.get('/api/vendors?q=fresh', AC)).json()[0].bank_account).toBe('123456789012')
    const flagged = await audit('vendor.bank_change')
    expect(flagged).toHaveLength(1)
    expect(flagged[0].note).toMatch(/Fresh Farms: .*bank_account/)
    expect(JSON.stringify(flagged[0])).not.toContain('123456789012')
    await patch(`/api/vendors/${V}`, ST, { phone: '98400 11111' })
    expect(await audit('vendor.bank_change')).toHaveLength(1)
  })

  it('keeps rate contracts per item without overlaps, and shows the best current rate', async () => {
    const [rice] = (await R.get('/api/items?q=ponni', ST)).json()
    const kumar = (await R.get('/api/vendors?q=kumar', ST)).json()[0].id
    await R.post('/api/rate-contracts', ST, { vendorId: V, itemId: rice.id, rate: 1450, validFrom: '2026-10-01', validTo: '2027-03-31' })
    expect((await R.post('/api/rate-contracts', ST, { vendorId: V, itemId: rice.id, rate: 1400, validFrom: '2026-12-01', validTo: '2027-01-31' })).statusCode).toBe(409)
    await R.post('/api/rate-contracts', ST, { vendorId: kumar, itemId: rice.id, rate: 1380, validFrom: '2026-11-01', validTo: '2026-11-30' })
    expect((await R.get('/api/items?q=ponni', ST)).json()[0].best_rate_paise).toBe(138000)
    const rates = (await R.get(`/api/rate-contracts?itemId=${rice.id}`, CHEF)).statusCode
    expect(rates).toBe(403)
    const list = (await R.get(`/api/rate-contracts?itemId=${rice.id}`, ST)).json()
    expect(list.map((x: { vendor: string }) => x.vendor)).toEqual(['Kumar Provisions', 'Fresh Farms'])
    await R.post(`/api/rate-contracts/${list[1].id}/end`, ST, { on: '2026-11-15' })
    expect((await R.get(`/api/rate-contracts?vendorId=${V}`, ST)).json()[0].valid_to).toBe('2026-11-15')
  })
})
