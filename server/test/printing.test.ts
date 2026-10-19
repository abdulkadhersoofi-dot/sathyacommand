import { createServer, type AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { preview } from '@sathya/escpos'
import { runOnce } from '../src/print-agent'
import { testResort } from './helpers'

// Kitchen tickets and bills go to network printers through a queue the edge-box agent works through;
// resent requests (a tablet that lost its connection) are answered once.

let R: Awaited<ReturnType<typeof testResort>>
let CAP = '', FNB = '', PRN = ''
const KEY = 'agent-secret-1234'
const put = (url: string, token: string, payload: unknown) => R.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
const agent = (url: string, payload: unknown = {}, key = KEY) => R.app.inject({ method: 'POST', url, headers: { 'x-agent-key': key }, payload: payload as object })

beforeAll(async () => {
  R = await testResort('2026-11-01', { printAgentKey: KEY })
  CAP = await R.staff('Murugan', '9840000061', ['captain'])
  FNB = await R.staff('Lakshmi', '9840000062', ['fnb_manager'])
}, 40_000)
afterAll(() => R.close())

describe('printers and routing', () => {
  it('adds a printer and routes a station and an outlet to it', async () => {
    expect((await R.post('/api/printers', CAP, { name: 'Kitchen', host: '192.168.1.50' })).statusCode).toBe(403)
    expect((await R.post('/api/printers', FNB, { name: 'Kitchen', host: 'bad host!' })).statusCode).toBe(400)
    PRN = (await R.post('/api/printers', FNB, { name: 'South Indian kitchen', host: '127.0.0.1', port: 9100, width: 42 })).json().id
    expect((await put('/api/printers/routes', FNB, { stations: { SI: PRN, BV: PRN }, outlets: { DINE: PRN } })).json()).toEqual({ ok: true })
    const r = (await R.get('/api/printers', CAP)).json()
    expect(r.stations.find((s: { id: string }) => s.id === 'SI').printer_id).toBe(PRN)
    expect(r.agentConfigured).toBe(true)
  })

  it('queues a ticket for the station\'s printer when the KOT is sent (stations without a printer stay on screen)', async () => {
    const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'DINE', tableId: 'DINE-T1', covers: 3 })).json()
    await R.post(`/api/fnb/orders/${o.id}/items`, CAP, { items: [{ itemId: 'DINE-BF02', qty: 2, note: 'less oil' }, { itemId: 'DINE-NI02' }] })
    await R.post(`/api/fnb/orders/${o.id}/send`, CAP)
    const jobs = (await R.get('/api/print-jobs', CAP)).json()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ kind: 'kot', ref: 'KOT 2', status: 'queued', printer: 'South Indian kitchen' })
  })
})

describe('the print agent', () => {
  it('needs the agent key', async () => {
    expect((await agent('/api/print-agent/claim', {}, 'wrong')).statusCode).toBe(401)
  })

  it('retries a printer that does not answer, then flags the job to God Mode after five tries', async () => {
    let job = ''
    for (let i = 1; i <= 5; i++) {
      const { jobs } = (await agent('/api/print-agent/claim')).json()
      expect(jobs).toHaveLength(1)
      job = jobs[0].id
      expect(preview(jobs[0].doc)).toContain('2 x Masala Dosa')
      const r = (await agent(`/api/print-agent/jobs/${job}/failed`, { error: 'Connection refused' })).json()
      expect(r.willRetry).toBe(i < 5)
    }
    expect((await agent('/api/print-agent/claim')).json().jobs).toHaveLength(0)
    expect((await R.get('/api/print-jobs?status=failed', CAP)).json()[0]).toMatchObject({ id: job, error: 'Connection refused', attempts: 5 })
    const audit = (await R.get('/api/audit?limit=3', R.md)).json()
    expect(audit[0]).toMatchObject({ action: 'print.failed' })
    expect((await R.post(`/api/print-jobs/${job}/retry`, CAP)).json()).toEqual({ ok: true })
  })

  it('prints to a real network printer socket and marks the job done', async () => {
    const received: Buffer[] = []
    const printer = createServer((s) => s.on('data', (d) => received.push(d)))
    await new Promise<void>((r) => printer.listen(0, '127.0.0.1', () => r()))
    const port = (printer.address() as AddressInfo).port
    await R.app.inject({ method: 'PATCH', url: `/api/printers/${PRN}`, headers: { authorization: `Bearer ${FNB}` }, payload: { port } })
    await R.app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(R.app.server.address() as AddressInfo).port}`
    const r = await runOnce({ server: url, key: KEY })
    await new Promise((res) => setTimeout(res, 100))
    printer.close()
    expect(r).toEqual({ printed: 1, failed: 0 })
    const bytes = Buffer.concat(received)
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40])
    const text = bytes.toString('latin1')
    expect(text).toContain('KOT 2')
    expect(text).toContain('TABLE T1')
    expect(text).toContain('* less oil')
    expect((await R.get('/api/print-jobs?status=done', CAP)).json()).toHaveLength(1)
  })

  it('reprints go to the printer marked COPY, and bills print on the outlet\'s bill printer', async () => {
    const kot = (await R.get('/api/fnb/kds?stationId=SI', CAP)).json().tickets[0]
    await R.post(`/api/fnb/kots/${kot.id}/reprint`, CAP)
    const { jobs } = (await agent('/api/print-agent/claim')).json()
    expect(preview(jobs[0].doc)).toContain('KOT 2 COPY')
    await agent(`/api/print-agent/jobs/${jobs[0].id}/done`)

    const o = (await R.post('/api/fnb/orders', CAP, { outletId: 'POOL', tableId: 'POOL-P1' })).json()
    await R.post(`/api/fnb/orders/${o.id}/items`, CAP, { items: [{ itemId: 'POOL-BF02' }] })
    await R.post(`/api/fnb/orders/${o.id}/send`, CAP)
    const [b] = (await R.post(`/api/fnb/orders/${o.id}/bill`, CAP, {})).json().bills
    expect((await R.post(`/api/fnb/bills/${b.id}/print-job`, CAP)).json().error).toMatch(/no bill printer/)
    await put('/api/printers/routes', FNB, { outlets: { POOL: PRN } })
    expect((await R.post(`/api/fnb/bills/${b.id}/print-job`, CAP)).statusCode).toBe(201)
    const bill = (await agent('/api/print-agent/claim')).json().jobs.find((j: { kind: string }) => j.kind === 'bill')
    const text = preview(bill.doc)
    expect(text).toContain('AMOUNT PAYABLE')
    expect(text).toContain('Rs.147.00')
    expect(text).not.toContain('DUPLICATE')
  })
})

describe('resending after a lost connection', () => {
  it('answers a repeated request once, with the same result', async () => {
    const send = (url: string, payload: unknown) => R.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${CAP}`, 'idempotency-key': 'tab3-0001' }, payload: payload as object })
    const first = await send('/api/fnb/orders', { id: 'ORD-TAB3-0001', outletId: 'DINE', tableId: 'DINE-T4', covers: 2 })
    expect(first.statusCode).toBe(201)
    const again = await send('/api/fnb/orders', { id: 'ORD-TAB3-0001', outletId: 'DINE', tableId: 'DINE-T4', covers: 2 })
    expect(again.statusCode).toBe(201)
    expect(again.headers['idempotent-replay']).toBe('true')
    expect(again.json().id).toBe('ORD-TAB3-0001')
    const add = (key: string) => R.app.inject({ method: 'POST', url: '/api/fnb/orders/ORD-TAB3-0001/items', headers: { authorization: `Bearer ${CAP}`, 'idempotency-key': key }, payload: { items: [{ itemId: 'DINE-BV01', qty: 2 }] } })
    await add('tab3-0002'); await add('tab3-0002')
    expect((await R.get('/api/fnb/orders/ORD-TAB3-0001', CAP)).json().items).toHaveLength(1)
    expect((await R.post('/api/fnb/orders', CAP, { id: 'bad id', outletId: 'DINE', tableId: 'DINE-T5' })).statusCode).toBe(400)
  })
})
