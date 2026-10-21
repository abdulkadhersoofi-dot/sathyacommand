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
  ['Accounts', 'Phase 6', 'Ledgers posted automatically from bills, payments and purchases; trial balance, profit & loss by department, balance sheet, GST, TDS and VAT returns, receivables, banks, fixed assets, budgets, Tally'],
  ['Banquets & sales', 'Phase 7', 'Venue calendar with clash checks, weddings and events from enquiry to quote, contract and advances (GST receipt vouchers), event orders to every department, final bill; company accounts with contracted rates, follow-ups, wedding room blocks; the guests\' booking page and online check-in, selling rules, the channel manager link'],
  ['Guests', 'Phase 7', 'Requests from the QR in every room (housekeeping, room service, faults), WhatsApp messages at each step of a stay, feedback with replies, activities on the room bill'],
  ['People', 'Phase 8', 'Employee records with statutory IDs, pay structures under the Code on Wages, onboarding, ID cards, training due; leave asked on the phone and approved by the department head; the holiday calendar; the monthly payroll with PF, ESI, professional tax and welfare fund, checked by the GM and approved by the MD, payslips, bank, ECR and ESIC files; salary TDS with declarations, 24Q and Form 16, advances and loans, full and final settlements, the parallel run beside the current payroll'],
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
      <p>This address shows the 3D resort on made-up bookings, with Twin Studio for editing the map. It has no HMS server behind it, so the modules below do not appear here. They run on the <b>live HMS</b>, where each person signs in with their email and password and sees the buttons for their role.</p>
      ${liveUrl
        ? `<p><a class="btn primary" href="${esc(liveUrl)}">Open the live HMS</a> <span class="muted small">${esc(liveUrl)}</span></p>`
        : `<div class="dg-steps"><b>Start the live HMS on Render (one time, about 10 minutes)</b><ol>
            <li>Render dashboard → <b>New → Blueprint</b> → choose the <code>sathyacommand</code> repository.</li>
            <li>Enter the MD's email and a first password when asked (<code>MD_EMAIL</code>, <code>MD_PASSWORD</code>) and press <b>Apply</b>. Render creates the database and the HMS service.</li>
            <li>Open the new service's address (<code>https://sathya-hms….onrender.com</code>), sign in with that email and password, then choose your own password.</li>
            <li>Optional: on this demo site set <code>VITE_LIVE_URL</code> to that address, and this box will link straight to it.</li>
          </ol><span class="muted small">Full guide: docs/DEPLOY.md in the repository.</span></div>`}
      <div class="dg-grid">${MODULES.map(([name, phase, what]) => `<div class="dg-mod"><div><b>${esc(name)}</b> <small class="muted">${esc(phase)}</small></div><div class="small">${esc(what)}</div></div>`).join('')}</div>
    </div>`
  const close = () => el.remove()
  el.addEventListener('click', (e) => { if (e.target === el || (e.target as HTMLElement).closest('[data-dg-close]')) close() })
  document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey) } })
  document.body.appendChild(el)
}
