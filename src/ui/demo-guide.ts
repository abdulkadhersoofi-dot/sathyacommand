import { esc } from './dom'

// The hosted demo has no HMS server behind it, so only the 3D map and Twin Studio work there. This panel
// says so plainly, lists every module the live HMS has, and points to it (or to how to start it).

const MODULES: [string, string, string][] = [
  ['Front desk', 'Phase 2', 'Bookings, room assignment, check-in and check-out, guest bills, GST invoices and credit notes, advances, cashier shifts, night audit, editable rooms and rates'],
  ['Restaurant & bar', 'Phase 3', 'Tables and captain orders, kitchen screens and KOTs, GST food bills and TN VAT liquor bills, splits, room charges, menus, bar stock, recipes and food cost, printers'],
  ['Housekeeping', 'Phase 4', 'Live room board on the 3D map, cleaning with checklists and photos, inspections, minibar, linen and laundry, public areas, lost and found'],
  ['Staff', 'Phase 4', 'Attendance with selfie and GPS, tasks, SOS, rosters, broadcasts, staff live on the map; the same screens as a phone app'],
  ['Engineering', 'Phase 4', 'Fault tickets with escalation, planned maintenance, assets, spares, meters and utility costs, pool / STP / fire logs, compliance calendar'],
  ['Security', 'Phase 4', 'Gate register, QR patrol rounds, incidents, cameras, key register, emergency mode with roll-call'],
  ['Stores & purchase', 'Phase 5', 'Items and vendors, indents, purchase orders, goods received, vendor bills with three-way match, payments with TDS, stock, counts, breakage, month close, excise registers'],
  ['Accounts', 'Phase 6, being built', 'Ledgers posted automatically from bills, payments and purchases; trial balance, profit & loss by department, balance sheet, journals, locked months'],
  ['God Mode', 'MD only', 'Every change in a log that cannot be altered, approvals, alerts'],
]

export function showDemoGuide(liveUrl: string | undefined) {
  document.querySelector('.demo-guide')?.remove()
  const el = document.createElement('div')
  el.className = 'demo-guide'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.setAttribute('aria-label', 'This is the sample demo')
  el.innerHTML = `<div class="dg-card">
      <button type="button" class="dr-close" data-dg-close aria-label="Close">✕</button>
      <h2>You are looking at the sample demo</h2>
      <p>This address shows the 3D resort on made-up bookings, with Twin Studio for editing the map. It has no HMS server behind it, so the modules below do not appear here. They run on the <b>live HMS</b>, where each person signs in with their mobile number and sees the buttons for their role.</p>
      ${liveUrl
        ? `<p><a class="btn primary" href="${esc(liveUrl)}">Open the live HMS</a> <span class="muted small">${esc(liveUrl)}</span></p>`
        : `<div class="dg-steps"><b>Start the live HMS on Render (one time, about 10 minutes)</b><ol>
            <li>Render dashboard → <b>New → Blueprint</b> → choose the <code>sathyacommand</code> repository.</li>
            <li>Enter the MD's mobile number when asked (<code>MD_MOBILE</code>) and press <b>Apply</b>. Render creates the database and the HMS service.</li>
            <li>Open the new service's address (<code>https://sathya-hms….onrender.com</code>), enter the MD's mobile number; the sign-in code appears in the service's <b>Logs</b> tab until SMS is connected.</li>
            <li>Optional: on this demo site set <code>VITE_LIVE_URL</code> to that address, and this box will link straight to it.</li>
          </ol><span class="muted small">Full guide: docs/DEPLOY.md in the repository.</span></div>`}
      <div class="dg-grid">${MODULES.map(([name, phase, what]) => `<div class="dg-mod"><div><b>${esc(name)}</b> <small class="muted">${esc(phase)}</small></div><div class="small">${esc(what)}</div></div>`).join('')}</div>
    </div>`
  const close = () => el.remove()
  el.addEventListener('click', (e) => { if (e.target === el || (e.target as HTMLElement).closest('[data-dg-close]')) close() })
  document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey) } })
  document.body.appendChild(el)
}
