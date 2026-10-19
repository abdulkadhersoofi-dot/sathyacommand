import { connect } from 'node:net'
import { pathToFileURL } from 'node:url'
import { encode, type PrintDoc } from '@sathya/escpos'

// The print agent runs on the edge box in the resort, on the same network as the kitchen, bar and bill
// printers. It asks the HMS server for print jobs, sends each to its printer (ESC/POS on port 9100) and
// reports back. If a printer is off or out of paper the job is retried, then flagged to the MD.
//
//   SERVER_URL=http://localhost:8080 PRINT_AGENT_KEY=… npm run print-agent -w server

interface Job { id: string; kind: string; ref: string | null; doc: PrintDoc; host: string; port: number }

/** Sends bytes to a network printer and waits until they are written. */
export function sendToPrinter(host: string, port: number, bytes: Uint8Array, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port })
    const fail = (e: Error) => { sock.destroy(); reject(e) }
    sock.setTimeout(timeoutMs, () => fail(new Error(`Printer ${host}:${port} did not answer`)))
    sock.once('error', (e) => fail(new Error(`Printer ${host}:${port}: ${e.message}`)))
    sock.once('connect', () => sock.end(Buffer.from(bytes), () => resolve()))
  })
}

/** Claims waiting jobs once, prints them, and reports each result. */
export async function runOnce(opts: { server: string; key: string; send?: typeof sendToPrinter; fetchImpl?: typeof fetch }) {
  const send = opts.send ?? sendToPrinter, f = opts.fetchImpl ?? fetch
  const call = (path: string, body: unknown = {}) => f(`${opts.server}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-key': opts.key }, body: JSON.stringify(body) })
  const res = await call('/api/print-agent/claim', { max: 10 })
  if (!res.ok) throw new Error(`Server refused the agent (${res.status}): ${await res.text()}`)
  const { jobs } = await res.json() as { jobs: Job[] }
  let printed = 0, failed = 0
  for (const j of jobs) {
    try {
      await send(j.host, j.port, encode(j.doc))
      await call(`/api/print-agent/jobs/${j.id}/done`)
      printed++
    } catch (e) {
      await call(`/api/print-agent/jobs/${j.id}/failed`, { error: (e as Error).message })
      failed++
    }
  }
  return { printed, failed }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const server = process.env.SERVER_URL ?? 'http://localhost:8080'
  const key = process.env.PRINT_AGENT_KEY
  if (!key) { console.error('Set PRINT_AGENT_KEY (the same value as on the HMS server).'); process.exit(1) }
  console.log(`Print agent: printing jobs from ${server}`)
  for (;;) {
    try {
      const r = await runOnce({ server, key })
      if (r.printed || r.failed) console.log(new Date().toISOString(), `printed ${r.printed}, failed ${r.failed}`)
    } catch (e) { console.error(new Date().toISOString(), (e as Error).message) }
    await new Promise((r) => setTimeout(r, 2000))
  }
}
