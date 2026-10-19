import { esc } from '../ui/dom'
import type { Ticket } from './common'

// Kitchen tickets for an 80 mm printer through the browser's print dialog. Step 3.6 prints them
// straight from the on-site edge box instead.

export function printTickets(tickets: Ticket[], stationName: (id: string) => string) {
  const at = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const body = tickets.map((t) => `<section>
    <h1>${t.kind} ${t.number}${t.copy ? ' · COPY' : ''}</h1>
    <p class="big">${esc(t.order.table ? `Table ${t.order.table}` : t.order.room ? `Room ${t.order.room}` : t.order.outlet)}</p>
    <p>${esc(stationName(t.station_id))} · ${esc(t.order.outlet)} · Order ${t.order.number} · ${t.order.covers} cover${t.order.covers > 1 ? 's' : ''} · ${at}</p>
    <ul>${t.lines.map((l) => `<li${l.void ? ' class="void"' : ''}><b>${l.qty} ×</b> ${esc(l.name)}${l.seat ? ` <i>seat ${l.seat}</i>` : ''}${l.course > 1 ? ` <i>course ${l.course}</i>` : ''}
      ${l.note ? `<div class="note">${esc(l.note)}</div>` : ''}${l.alert?.length ? `<div class="alert">${l.alert.map(esc).join(' · ')}</div>` : ''}</li>`).join('')}</ul>
  </section>`).join('')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Kitchen tickets</title><style>
    @page { size: 80mm auto; margin: 4mm; }
    body { font: 13px/1.35 ui-monospace, Menlo, monospace; width: 72mm; margin: 0 auto; color: #000; }
    section { border-bottom: 1px dashed #000; padding: 6px 0 10px; page-break-after: always; }
    h1 { font-size: 20px; margin: 0; } .big { font-size: 17px; font-weight: 700; margin: 2px 0; } p { margin: 2px 0; }
    ul { list-style: none; padding: 0; margin: 6px 0 0; } li { font-size: 15px; margin: 4px 0; }
    .note { font-style: italic; } .alert { font-weight: 900; text-transform: uppercase; } .void { text-decoration: line-through; }
  </style></head><body>${body}<script>window.onload = () => { window.print() }</script></body></html>`
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  window.open(url, '_blank')
}
