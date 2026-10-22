import { steps, toolbar, type Action, type Step } from '../ui/toolbar'
import { esc, toast, tonePill, showDate } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { money } from '../acc/books'
import { STATUS_LABEL, STATUS_TONE, STYLE_LABEL, type Venue } from './calendar'
import { ACT_KINDS } from './sales'
import type { BqHost } from './workspace'
import { bookingSheet, type Pkg } from './book'

// Events: the pipeline from enquiry to feedback, and one event in full: functions, extras, quotes, the
// contract's advance schedule, payments, permissions, the event order and the bill.

interface Row { id: string; number: string; kind: string; title: string; client: string; company: string | null; status: string; holdUntil: string | null; owner: string | null; date: string | null; lastDate: string | null
  venues: string[]; pax: number | null; quotePaise: number; quoteStatus: string | null; paidPaise: number; billedPaise: number | null; overdue: number; beoRevision: number | null; checksOpen: number; lostReason: string | null }
interface Clash { number: string; title: string; status: string; startsAt: string; firm: boolean }
interface Fn { id: string; name: string; venueId: string; venue: string; date: string; from: string; to: string; style: string; expectedPax: number; guaranteedPax: number | null; actualPax: number | null; menuId: string | null; menu: string | null; capacity: number | null; rentalPaise: number; rentalOverride: boolean; clashes: Clash[] }
interface Line { description: string; qty: number; gstRate: number; taxable: number; total: number; kind: string }
interface Quote { id: string; version: number; status: string; discountPercent: number; totalPaise: number; validUntil: string; lines: Line[] }
interface Detail {
  id: string; number: string; kind: string; title: string; status: string; holdUntil: string | null; source: string; owner: string | null
  client: { name: string; mobile: string | null; email: string | null; company: string | null; gstin: string | null; address: string | null }
  expectedPax: number | null; siteVisitOn: string | null; notes: string | null; instructions: Record<string, string>; contractSignedOn: string | null
  lostReason: string | null; lostTo: string | null; cancelReason: string | null; feedback: { score: number; note: string | null } | null
  functions: Fn[]; items: { id: string; functionId: string | null; description: string; qty: number; ratePaise: number; gstKind: string }[]
  quotes: Quote[]; priced: { lines: Line[]; taxable: number; gst: number; total: number }
  milestones: { id: string; label: string; dueOn: string; amountPaise: number; status: string }[]
  payments: { id: string; kind: string; method: string; amount_paise: number; reference: string | null; business_date: string; by: string; voucher: string | null }[]
  paidPaise: number; advancesHeldPaise: number; invoice: { id: string; number: string; totalPaise: number; balancePaise: number } | null
  documents: { id: string; type: string; number: string; date: string; totalPaise: number }[]
  checks: { item: string; label: string; status: string; ref: string | null; by: string | null }[]
  beo: { revisions: { revision: number; issuedAt: string; by: string; acks: { dept: string; by: string; acked_at: string }[] }[]; changed: boolean; depts: Record<string, { name: string }> }
  limits: { discountPercent: number | null; holdDays: number | null }; today: string
  account: { id: string; name: string } | null; vendorCostPaise: number
  vendors: { id: string; vendor: string; service: string; agreedPaise: number; billedPaise: number; paidPaise: number; notes: string | null }[]
  blocks: { id: string; number: string; name: string; status: string; arrival: string; departure: string }[]
}

const KINDS: [string, string][] = [['wedding', 'Wedding'], ['reception', 'Reception'], ['engagement', 'Engagement'], ['birthday', 'Birthday'], ['corporate', 'Corporate'], ['conference', 'Conference'], ['social', 'Social'], ['other', 'Other']]
const SOURCES: [string, string][] = [['walk_in', 'Walk-in'], ['phone', 'Phone'], ['website', 'Website'], ['referral', 'Referral'], ['planner', 'Wedding planner'], ['repeat', 'Repeat client'], ['corporate', 'Corporate account']]
const FILTERS: [string, string, string[]][] = [['live', 'Coming up', ['enquiry', 'quoted', 'hold', 'definite', 'billed']], ['open', 'Enquiries & holds', ['enquiry', 'quoted', 'hold']], ['definite', 'Definite', ['definite']], ['billed', 'Billed', ['billed']], ['done', 'Closed', ['closed']], ['gone', 'Lost & cancelled', ['lost', 'cancelled']], ['all', 'All', []]]
const DOC: Record<string, string> = { receipt_voucher: 'Receipt voucher', refund_voucher: 'Refund voucher', invoice: 'Tax invoice', credit_note: 'Credit note' }
const CHECK_LABEL: Record<string, string> = { pending: 'Pending', applied: 'Applied for', received: 'Received', not_needed: 'Not needed' }
const MS_TONE: Record<string, string> = { paid: '--st-vacant', part: '--marigold', due: '--muted', overdue: '--st-departing' }
const pill = (s: string) => tonePill(STATUS_LABEL[s] ?? s, STATUS_TONE[s] ?? '--muted')
const opt = (pairs: [string, string][], sel?: string | null) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('')
const num = (f: HTMLFormElement, k: string) => (val(f, k) === '' ? undefined : Number(val(f, k)))

export class EventsView {
  selected: string | null = null
  private filter = 'live'
  private rows: Row[] = []
  private d: Detail | null = null
  private venues: Venue[] = []
  private pkgs: Pkg[] = []
  private accounts: { id: string; name: string; active: boolean }[] = []
  constructor(private h: BqHost) {}

  async load() {
    this.venues = await this.h.cached('/api/banquets/venues')
    this.pkgs = await this.h.cached('/api/banquets/packages')
    if (this.h.can('sales.manage', 'rates.contract') && !this.accounts.length) this.accounts = (await this.h.api.get<{ accounts: { id: string; name: string; active: boolean }[] }>('/api/sales/accounts').catch(() => ({ accounts: [] }))).accounts.filter((a) => a.active)
    if (this.selected) this.d = await this.h.cached(`/api/banquets/events/${this.selected}`)
    else this.rows = await this.h.cached('/api/banquets/events')
  }
  private async reload() { await this.load(); this.h.render() }

  html() { return this.selected && this.d ? this.detail(this.d) : this.list() }

  private list() {
    const f = FILTERS.find((x) => x[0] === this.filter)!
    const rows = this.rows.filter((r) => !f[2].length || f[2].includes(r.status))
    const pipeline = this.rows.filter((r) => ['enquiry', 'quoted', 'hold'].includes(r.status)).reduce((a, r) => a + r.quotePaise, 0)
    const lost = this.rows.filter((r) => r.status === 'lost')
    const won = this.rows.filter((r) => ['definite', 'billed', 'closed'].includes(r.status))
    return `${toolbar({
      primary: this.h.can('events.manage') ? [{ attrs: 'data-evact="book"', label: 'Book an event' }, { attrs: 'data-evact="new"', label: 'New enquiry', primary: false }] : [],
      filters: FILTERS.map(([id, label]) => `<button type="button" class="chip" data-evf="${id}" aria-pressed="${id === this.filter}">${esc(label)}</button>`).join(''),
    })}
      <div class="row-card mc-card"><div class="mc-figs"><span><small>Open pipeline</small><b class="mono">${money(pipeline)}</b></span><span><small>Won</small><b class="mono">${won.length}</b></span>
        <span><small>Lost</small><b class="mono">${lost.length}</b></span><span><small>Conversion</small><b class="mono">${won.length + lost.length ? Math.round((won.length * 100) / (won.length + lost.length)) : 0}%</b></span></div></div>
      ${rows.map((r) => `<div class="row-card bq-row" data-ev="${esc(r.id)}" role="button" tabindex="0">
        <div class="rc-title"><span class="mono muted">${esc(r.number)}</span> ${esc(r.title)}</div>
        <div class="rc-sub">${esc(r.company ?? r.client)} · ${r.date ? esc(r.date === r.lastDate || !r.lastDate ? showDate(r.date) : `${showDate(r.date)} to ${showDate(r.lastDate)}`) : 'no date yet'}${r.venues.length ? ` · ${esc(r.venues.join(', '))}` : ''}${r.pax ? ` · ${r.pax} guests` : ''}${r.owner ? ` · ${esc(r.owner)}` : ''}
          ${r.status === 'lost' && r.lostReason ? ` · lost: ${esc(r.lostReason)}` : ''}</div>
        <div class="rc-right">${pill(r.status)}${r.status === 'hold' && r.holdUntil ? `<small class="muted">until ${esc(showDate(r.holdUntil))}</small>` : ''}
          ${r.quotePaise ? `<small class="mono">${money(r.billedPaise ?? r.quotePaise)}${r.paidPaise ? ` · paid ${money(r.paidPaise)}` : ''}</small>` : ''}
          ${r.overdue ? tonePill(`${r.overdue} instalment${r.overdue > 1 ? 's' : ''} overdue`, '--st-departing') : ''}${r.quoteStatus === 'awaiting_approval' ? tonePill('Discount awaits approval', '--marigold') : ''}</div></div>`).join('') || '<p class="empty">No events here.</p>'}`
  }

  private detail(d: Detail) {
    const manage = this.h.can('events.manage'), pay = this.h.can('events.payment'), bill = this.h.can('events.bill')
    const live = ['enquiry', 'quoted', 'hold'].includes(d.status), editable = live || d.status === 'definite'
    const accepted = d.quotes.find((q) => q.status === 'accepted')
    // The event's steps in the order they happen; the current one is the button to press.
    const issued = d.quotes.find((q) => q.status === 'issued')
    const gone = ['lost', 'cancelled'].includes(d.status)
    const signed = ['definite', 'billed', 'closed'].includes(d.status)
    const served = d.functions.length > 0 && d.functions.every((f) => !f.menu || f.actualPax != null)
    const beoSent = d.beo.revisions.length > 0
    const st = (done: boolean, nowIf: boolean, label: string, attrs?: string, title?: string): Step =>
      ({ label, state: done ? 'done' : nowIf && attrs ? 'now' : 'todo', attrs: nowIf ? attrs : undefined, title })
    const flow: Step[] = gone ? [] : [
      { label: 'Enquiry', state: 'done' },
      st(d.quotes.length > 0, manage && live, d.quotes.length ? 'Quoted' : 'Quote', 'data-evact="quote"', 'Price the functions and send the quote'),
      st(!!accepted, manage && !!issued, 'Client accepts', issued ? `data-qaccept="${esc(issued.id)}"` : undefined, 'The client agreed to the quote'),
      st(signed, manage && live && !!accepted, 'Contract signed', 'data-evact="contract"', 'The event becomes definite and its venues are booked'),
      st(d.paidPaise > 0, pay && signed && d.status !== 'closed', 'Advance', 'data-evact="pay"', 'Advances are receipted with GST'),
      st(beoSent, manage && d.status === 'definite', 'Event order', 'data-evact="beo"', 'Tells every department what to do'),
      st(served, bill && d.status === 'definite' && beoSent, 'Guests served', 'data-evact="served"', 'Entered on the day, for the bill'),
      st(!!d.invoice, bill && d.status === 'definite' && served, 'Final bill', 'data-evact="bill"', 'The tax invoice, after the event'),
      st(d.status === 'closed', (manage || bill) && d.status === 'billed', 'Closed', 'data-evact="feedback"', 'Feedback and close'),
    ]
    const more: Action[] = [
      manage && editable ? { attrs: 'data-evact="client"', label: 'Client details' } : null,
      manage && editable ? { attrs: 'data-evact="fn"', label: 'Add a function' } : null,
      manage && editable ? { attrs: 'data-evact="item"', label: 'Add an item' } : null,
      manage && d.quotes.length && live ? { attrs: 'data-evact="quote"', label: 'New quote' } : null,
      manage && (d.status === 'enquiry' || d.status === 'quoted') ? { attrs: 'data-evact="hold"', label: 'Hold the dates' } : null,
      manage && d.status === 'hold' ? { attrs: 'data-evact="release"', label: 'Release the hold' } : null,
      manage && editable ? { attrs: 'data-evact="instructions"', label: 'Department instructions' } : null,
      manage && editable ? { attrs: 'data-evact="vendor"', label: 'Add a supplier' } : null,
      manage && editable && this.h.can('sales.manage') ? { attrs: 'data-evact="block"', label: 'Hold rooms for guests' } : null,
      manage && !gone && d.status !== 'closed' ? { attrs: 'data-evact="follow"', label: 'Follow-up' } : null,
      manage && live ? { attrs: 'data-evact="lost"', label: 'Lost to another venue', danger: true } : null,
      manage && (live || d.status === 'definite') ? { attrs: 'data-evact="cancel"', label: 'Cancel the event', danger: true } : null,
    ].filter((x): x is Action => !!x)
    const primary: Action[] = [
      pay && !gone && d.status !== 'closed' && d.paidPaise > 0 ? { attrs: 'data-evact="pay"', label: d.invoice ? 'Take the balance' : 'Take a payment' } : null,
      manage && d.status === 'definite' && beoSent && d.beo.changed ? { attrs: 'data-evact="beo"', label: 'Send revised event order' } : null,
    ].filter((x): x is Action => !!x)
    const fnRows = d.functions.map((f) => `<tr><td><b>${esc(f.name)}</b>${f.clashes.length ? `<div class="${f.clashes.some((c) => c.firm) ? 'fd-warn' : 'muted'} small">${f.clashes.map((c) => `${c.firm ? 'Clashes with' : 'Also pencilled'}: ${esc(c.title)} (${esc(STATUS_LABEL[c.status])})`).join('<br>')}</div>` : ''}</td>
        <td>${esc(f.venue)}</td><td>${esc(showDate(f.date))} <span class="mono">${esc(f.from)}–${esc(f.to)}</span></td><td>${esc(STYLE_LABEL[f.style] ?? f.style)}${f.capacity ? ` <small class="muted">(seats ${f.capacity})</small>` : ''}</td>
        <td class="n">${f.expectedPax}${f.guaranteedPax ? ` / <b>${f.guaranteedPax}</b>` : ''}${f.actualPax != null ? ` / served ${f.actualPax}` : ''}</td><td>${esc(f.menu ?? '—')}</td><td class="n">${money(f.rentalPaise)}</td>
        <td>${manage && editable ? `<button type="button" class="btn small" data-fn="${esc(f.id)}">Edit</button>${live ? `<button type="button" class="btn small ghost" data-fndel="${esc(f.id)}">Remove</button>` : ''}` : ''}</td></tr>`).join('')
    const itemRows = d.items.map((i) => `<tr><td>${esc(i.description)}${i.functionId ? ` <small class="muted">${esc(d.functions.find((f) => f.id === i.functionId)?.name ?? '')}</small>` : ''}</td><td class="n">${i.qty}</td><td class="n">${money(i.ratePaise)}</td>
        <td>${esc({ hall: 'Venue', catering: 'Food', other: 'Services' }[i.gstKind] ?? i.gstKind)}</td><td>${manage && live ? `<button type="button" class="btn small ghost" data-itdel="${esc(i.id)}">Remove</button>` : ''}</td></tr>`).join('')
    const lastBeo = d.beo.revisions[0]
    return `<div class="tb"><button type="button" class="btn ghost" data-evact="back">← All events</button></div>
      <div class="bq-head"><div><div class="muted mono small">${esc(d.number)} · ${esc(KINDS.find((k) => k[0] === d.kind)?.[1] ?? d.kind)}</div><h2>${esc(d.title)}</h2>
        <div class="small">${esc(d.client.name)}${d.client.company ? `, ${esc(d.client.company)}` : ''}${d.client.mobile ? ` · <a href="tel:${esc(d.client.mobile)}">${esc(d.client.mobile)}</a>` : ''}${d.client.email ? ` · ${esc(d.client.email)}` : ''}${d.client.gstin ? ` · GSTIN <span class="mono">${esc(d.client.gstin)}</span>` : ''}</div>
        ${d.account ? `<div class="small">Account: <b>${esc(d.account.name)}</b></div>` : ''}
        <div class="muted small">${esc(SOURCES.find((s) => s[0] === d.source)?.[1] ?? d.source)}${d.owner ? ` · handled by ${esc(d.owner)}` : ''}${d.siteVisitOn ? ` · site visit ${esc(showDate(d.siteVisitOn))}` : ''}${d.contractSignedOn ? ` · contract signed ${esc(showDate(d.contractSignedOn))}` : ''}</div></div>
        <div class="rc-right">${pill(d.status)}${d.status === 'hold' && d.holdUntil ? `<small>held until ${esc(showDate(d.holdUntil))}</small>` : ''}</div></div>
      ${d.lostReason ? `<p class="fd-warn">Lost: ${esc(d.lostReason)}${d.lostTo ? ` (to ${esc(d.lostTo)})` : ''}</p>` : ''}${d.cancelReason ? `<p class="fd-warn">Cancelled: ${esc(d.cancelReason)}</p>` : ''}
      ${d.feedback ? `<p>Feedback: <b>${'★'.repeat(d.feedback.score)}${'☆'.repeat(5 - d.feedback.score)}</b> ${esc(d.feedback.note ?? '')}</p>` : ''}
      ${d.notes ? `<p class="small">${esc(d.notes)}</p>` : ''}
      ${flow.length ? steps(flow) : ''}
      ${toolbar({ primary, more })}

      <div class="sec-title">Functions</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Function</th><th>Venue</th><th>When</th><th>Setup</th><th class="n">Guests (expected / guaranteed)</th><th>Menu</th><th class="n">Rental</th><th></th></tr></thead>
        <tbody>${fnRows || '<tr><td colspan="8" class="empty">No functions yet: add the venue, day and time.</td></tr>'}</tbody></table></div>
      ${d.items.length ? `<div class="sec-title">Extras</div><div class="acc-scroll"><table class="acc-table"><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th>GST as</th><th></th></tr></thead><tbody>${itemRows}</tbody></table></div>` : ''}

      <div class="sec-title">Price${accepted ? ` (accepted quote v${accepted.version}, ${accepted.discountPercent}% off)` : ''} <span class="mono">${money(d.priced.total)}</span></div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Line</th><th class="n">Qty</th><th class="n">Amount</th><th class="n">GST</th><th class="n">Total</th></tr></thead><tbody>
        ${d.priced.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="n">${l.qty}</td><td class="n">${money(l.taxable)}</td><td class="n">${l.gstRate}%</td><td class="n">${money(l.total)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing priced yet.</td></tr>'}
      </tbody><tfoot><tr><td colspan="2">Total</td><td class="n">${money(d.priced.taxable)}</td><td class="n">${money(d.priced.gst)}</td><td class="n">${money(d.priced.total)}</td></tr></tfoot></table></div>
      ${d.quotes.length ? `<div class="m-table bq-quotes">${d.quotes.map((q) => `<div class="m-row bq-qrow ${q.status === 'superseded' || q.status === 'rejected' ? 'retired' : ''}"><b>v${q.version}</b><span>${money(q.totalPaise)}${q.discountPercent ? ` <small class="muted">${q.discountPercent}% off</small>` : ''}</span>
          <span>${tonePill({ issued: 'Sent', accepted: 'Accepted', superseded: 'Replaced', rejected: 'Discount refused', awaiting_approval: 'Awaits GM' }[q.status] ?? q.status, q.status === 'accepted' ? '--st-vacant' : q.status === 'awaiting_approval' ? '--marigold' : '--muted')}</span>
          <small class="muted">valid to ${esc(q.validUntil)}</small><span class="rc-right"><button type="button" class="btn small" data-qprint="${esc(q.id)}">Print</button>${manage && q.status === 'issued' ? `<button type="button" class="btn small primary" data-qaccept="${esc(q.id)}">Client accepted</button>` : ''}</span></div>`).join('')}</div>` : ''}

      ${d.milestones.length || d.payments.length ? `<div class="sec-title">Advances and payments <span class="mono">received ${money(d.paidPaise)}</span></div>
        ${d.milestones.length ? `<div class="m-table">${d.milestones.map((m) => `<div class="m-row bq-ms"><span>${esc(m.label)}</span><span>${esc(showDate(m.dueOn))}</span><span class="mono">${money(m.amountPaise)}</span><span>${tonePill({ paid: 'Paid', part: 'Part paid', due: 'Due', overdue: 'Overdue' }[m.status] ?? m.status, MS_TONE[m.status])}</span></div>`).join('')}</div>` : ''}
        <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Date</th><th>Kind</th><th>How</th><th>Reference</th><th>Voucher</th><th class="n">Amount</th></tr></thead><tbody>
          ${d.payments.map((p) => `<tr><td>${esc(showDate(p.business_date))}</td><td>${esc({ advance: 'Advance', settlement: 'Balance', refund: 'Refund' }[p.kind] ?? p.kind)}</td><td>${esc(p.method.toUpperCase())}</td><td class="mono">${esc(p.reference ?? '')}</td><td class="mono">${esc(p.voucher ?? '')}</td><td class="n">${money(p.amount_paise)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nothing received yet.</td></tr>'}
        </tbody></table></div>` : ''}
      ${d.invoice ? `<div class="row-card mc-card"><div class="mc-figs"><span><small>Bill ${esc(d.invoice.number)}</small><b class="mono">${money(d.invoice.totalPaise)}</b></span><span><small>Received</small><b class="mono">${money(d.paidPaise)}</b></span>
        <span><small>${d.invoice.balancePaise >= 0 ? 'Balance due' : 'Paid over'}</small><b class="mono ${d.invoice.balancePaise > 0 ? 'fd-warn' : ''}">${money(Math.abs(d.invoice.balancePaise))}</b></span></div></div>` : ''}

      ${d.vendors.length ? `<div class="sec-title">Suppliers <span class="mono">cost ${money(d.vendorCostPaise)}</span></div>
        <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Supplier</th><th>For</th><th class="n">Agreed</th><th class="n">Billed</th><th class="n">Paid</th><th></th></tr></thead><tbody>
          ${d.vendors.map((v) => `<tr><td>${esc(v.vendor)}</td><td>${esc(v.service)}${v.notes ? ` <small class="muted">${esc(v.notes)}</small>` : ''}</td><td class="n">${money(v.agreedPaise)}</td><td class="n">${v.billedPaise ? money(v.billedPaise) : '<span class="muted">not yet</span>'}</td><td class="n">${money(v.paidPaise)}</td>
            <td>${manage && !v.billedPaise ? `<button type="button" class="btn small ghost" data-vdel="${esc(v.id)}">Remove</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div><p class="muted small">Their bills are entered in Stores → Bills with this event chosen, and paid there with TDS.${d.invoice ? ` Margin after suppliers: <b>${money(d.invoice.totalPaise - d.vendorCostPaise)}</b> before GST on the bill.` : ''}</p>` : ''}
      ${d.blocks.length ? `<div class="sec-title">Rooms held for guests</div><div class="m-table">${d.blocks.map((b) => `<div class="m-row bq-ins"><span class="mono">${esc(b.number)}</span><span><button type="button" class="linkish" data-blk="${esc(b.id)}">${esc(b.name)}</button> · ${esc(b.arrival)} to ${esc(b.departure)} · ${esc(b.status)}</span></div>`).join('')}</div>` : ''}

      <div class="sec-title">Permissions</div>
      <div class="m-table">${d.checks.map((c) => `<div class="m-row bq-check"><span>${esc(c.label)}</span><span>${tonePill(CHECK_LABEL[c.status] ?? c.status, c.status === 'received' ? '--st-vacant' : c.status === 'not_needed' ? '--muted' : '--marigold')}${c.ref ? ` <span class="mono small">${esc(c.ref)}</span>` : ''}</span>
        <span class="rc-right">${manage && !['closed', 'lost', 'cancelled'].includes(d.status) ? `<button type="button" class="btn small" data-check="${esc(c.item)}">Update</button>` : ''}</span></div>`).join('')}</div>

      <div class="sec-title">Event order (BEO)</div>
      ${lastBeo ? `<p class="small">Revision ${lastBeo.revision} sent by ${esc(lastBeo.by)} on ${esc(new Date(lastBeo.issuedAt).toLocaleString('en-IN'))}.${d.beo.changed ? ' <b class="fd-warn">The event has changed since: send a revision.</b>' : ''}</p>
        <div class="bq-acks">${Object.entries(d.beo.depts).map(([k, dep]) => { const a = lastBeo.acks.find((x) => x.dept === k); return `<span>${a ? tonePill(`${dep.name}: ${a.by}`, '--st-vacant') : tonePill(`${dep.name}: not yet`, '--marigold')}</span>` }).join('')}</div>`
        : `<p class="muted small">${d.status === 'definite' ? 'Not sent yet.' : 'Sent to the kitchen, service, housekeeping, engineering, security and front office once the contract is signed.'}</p>`}
      ${Object.entries(d.instructions).some(([, v]) => v) ? `<div class="m-table">${Object.entries(d.instructions).filter(([, v]) => v).map(([k, v]) => `<div class="m-row bq-ins"><b>${esc(d.beo.depts[k]?.name ?? k)}</b><span>${esc(v)}</span></div>`).join('')}</div>` : ''}

      ${d.documents.length ? `<div class="sec-title">GST documents</div><div class="m-table">${d.documents.map((x) => `<div class="m-row bq-doc"><span class="mono">${esc(x.number)}</span><span>${esc(DOC[x.type] ?? x.type)}</span><span>${esc(showDate(x.date))}</span><span class="mono">${money(x.totalPaise)}</span><span class="rc-right"><button type="button" class="btn small" data-doc="${esc(x.id)}">Print</button></span></div>`).join('')}</div>` : ''}`
  }

  private venueOpts(sel?: string) { return this.venues.map((v) => `<option value="${esc(v.id)}" ${v.id === sel ? 'selected' : ''}>${esc(v.name)}${v.capacity ? ` (up to ${v.capacity})` : ''}</option>`).join('') }
  private menuOpts(sel?: string | null) { return `<option value="">No menu</option>${this.pkgs.filter((p) => p.kind === 'menu' && (p.active || p.id === sel)).map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)} · ${money(p.price_paise)}/${p.per}${p.min_pax ? ` (min ${p.min_pax})` : ''}</option>`).join('')}` }
  private fnFields(f?: Partial<Fn>, defaults: { venueId?: string; date?: string } = {}) {
    return `<label>Function<input name="fname" maxlength="60" placeholder="Muhurtham, Reception…" value="${esc(f?.name ?? '')}"></label>
      <label>Venue<select name="venue">${this.venueOpts(f?.venueId ?? defaults.venueId)}</select></label>
      <label>Day<input name="date" type="date" value="${esc(f?.date ?? defaults.date ?? '')}"></label>
      <label>From – to<span class="bq-times"><input name="from" type="time" value="${esc(f?.from ?? '18:00')}"><input name="to" type="time" value="${esc(f?.to ?? '22:30')}"></span></label>
      <label>Setup<select name="style">${opt(Object.entries(STYLE_LABEL), f?.style ?? 'rounds')}</select></label>
      <label>Menu<select name="menu">${this.menuOpts(f?.menuId)}</select></label>
      <label>Expected guests<input name="fpax" type="number" min="1" value="${esc(f?.expectedPax ?? '')}"></label>
      <label>Guaranteed guests<input name="guar" type="number" min="1" value="${esc(f?.guaranteedPax ?? '')}" placeholder="given ~7 days before"></label>`
  }
  private fnBody(f: HTMLFormElement) {
    return { name: val(f, 'fname'), venueId: val(f, 'venue'), date: val(f, 'date'), from: val(f, 'from'), to: val(f, 'to'), style: val(f, 'style'), menuId: val(f, 'menu') || null, expectedPax: num(f, 'fpax') ?? num(f, 'pax'), guaranteedPax: num(f, 'guar') ?? null }
  }
  private clientFields(c?: Detail) {
    return `<label class="span2">Event<input name="title" maxlength="120" placeholder="Ravi and Priya wedding" value="${esc(c?.title ?? '')}"></label>
      ${this.accounts.length ? `<label class="span2">Company account (fills in the company for the bill)<select name="acct"><option value="">—</option>${this.accounts.map((a) => `<option value="${esc(a.id)}" ${c?.account?.id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>` : ''}
      <label>Kind<select name="kind">${opt(KINDS, c?.kind)}</select></label><label>How they came<select name="source">${opt(SOURCES, c?.source)}</select></label>
      <label>Client's name<input name="client" maxlength="120" value="${esc(c?.client.name ?? '')}"></label><label>Mobile<input name="mobile" inputmode="tel" value="${esc(c?.client.mobile ?? '')}"></label>
      <label>Email<input name="email" type="email" value="${esc(c?.client.email ?? '')}"></label><label>Company (for the bill)<input name="company" value="${esc(c?.client.company ?? '')}"></label>
      <label>GSTIN<input name="gstin" maxlength="15" value="${esc(c?.client.gstin ?? '')}"></label><label>Guests expected<input name="pax" type="number" min="1" value="${esc(c?.expectedPax ?? '')}"></label>
      <label class="span2">Billing address<input name="addr" maxlength="300" value="${esc(c?.client.address ?? '')}"></label>
      <label>Site visit on<input name="visit" type="date" value="${esc(c?.siteVisitOn ?? '')}"></label><label class="span2">Notes<textarea name="notes" rows="2" maxlength="2000">${esc(c?.notes ?? '')}</textarea></label>`
  }
  private clientBody(f: HTMLFormElement) {
    return { title: val(f, 'title'), kind: val(f, 'kind'), source: val(f, 'source'), clientName: val(f, 'client'), clientMobile: val(f, 'mobile'), clientEmail: val(f, 'email'), company: val(f, 'company'),
      gstin: val(f, 'gstin'), expectedPax: num(f, 'pax') ?? null, billingAddress: val(f, 'addr'), siteVisitOn: val(f, 'visit') || null, notes: val(f, 'notes'),
      ...(this.accounts.length ? { debtorId: val(f, 'acct') || null } : {}) }
  }

  /**
   * Book an event in one form: who, the function (and a second one if needed), and book it, hold the dates or
   * keep it as an enquiry, with any advance taken now. The quote and contract are made from it.
   */
  /** The booking sheet: who, where and when, confirm; the venue is checked as it fills in. */
  async book(venueId?: string, date?: string) {
    if (!this.venues.length || !this.pkgs.length) { this.venues = await this.h.cached('/api/banquets/venues'); this.pkgs = await this.h.cached('/api/banquets/packages') }
    bookingSheet(this.h, this.venues, this.pkgs, async (id) => { this.selected = id; await this.reload() }, { venueId, date })
    this.h.modal.el.querySelector('.fd-card')?.classList.add('bk-card')
  }

  /** A new enquiry, with its first function if a venue and day are given. */
  async enquiry(venueId?: string, date?: string) {
    if (!this.venues.length || !this.pkgs.length) { this.venues = await this.h.cached('/api/banquets/venues'); this.pkgs = await this.h.cached('/api/banquets/packages') }
    if (this.h.can('sales.manage', 'rates.contract') && !this.accounts.length) this.accounts = (await this.h.api.get<{ accounts: { id: string; name: string; active: boolean }[] }>('/api/sales/accounts').catch(() => ({ accounts: [] }))).accounts.filter((a) => a.active)
    this.h.modal.open('New enquiry', `<div class="form-grid">${this.clientFields()}</div><div class="sec-title">First function (optional)</div><div class="form-grid">${this.fnFields(undefined, { venueId, date })}</div>`, 'Save enquiry', async (f) => {
      const r = await this.h.api.post<{ id: string; number: string }>('/api/banquets/events', this.clientBody(f))
      this.selected = r.id
      if (val(f, 'fname') && val(f, 'date')) {
        try { await this.h.api.post(`/api/banquets/events/${r.id}/functions`, this.fnBody(f)) }
        catch (e) { toast(`Enquiry saved; the function was not: ${(e as Error).message}`) }
      }
      await this.reload()
      return `Enquiry ${r.number} saved`
    })
  }

  async change() { return false }

  async click(el: HTMLElement) {
    const api = this.h.api
    const fl = el.closest<HTMLElement>('[data-evf]')?.dataset.evf
    if (fl) { this.filter = fl; return true }
    const ev = el.closest<HTMLElement>('[data-ev]')?.dataset.ev
    if (ev && !this.selected) { this.selected = ev; await this.load(); return true }
    const d = this.d
    const qp = el.closest<HTMLElement>('[data-qprint]')?.dataset.qprint
    if (qp) { await api.openDocument(`/api/banquets/quotes/${qp}/print`); return false }
    const doc = el.closest<HTMLElement>('[data-doc]')?.dataset.doc
    if (doc) { await api.openDocument(`/api/tax-documents/${doc}/print`); return false }
    const qa = el.closest<HTMLElement>('[data-qaccept]')?.dataset.qaccept
    if (qa) { await api.post(`/api/banquets/quotes/${qa}/accept`); toast('Quote accepted'); await this.load(); return true }
    const fnId = el.closest<HTMLElement>('[data-fn]')?.dataset.fn
    if (fnId && d) {
      const fn = d.functions.find((x) => x.id === fnId)!
      this.h.modal.open(`Function: ${fn.name}`, `<div class="form-grid">${this.fnFields(fn)}<label>Rental (₹, blank: the venue's)<input name="rental" type="number" min="0" value="${fn.rentalOverride ? fn.rentalPaise / 100 : ''}"></label></div>`, 'Save', async (f) => {
        const r = await api.req<{ clashes: Clash[] }>('PATCH', `/api/banquets/functions/${fnId}`, { ...this.fnBody(f), rental: val(f, 'rental') === '' ? null : Number(val(f, 'rental')) })
        await this.reload()
        return r.clashes?.length ? `Saved. Also pencilled: ${r.clashes.map((c) => c.title).join(', ')}` : 'Saved'
      })
      return false
    }
    const fnDel = el.closest<HTMLElement>('[data-fndel]')?.dataset.fndel
    if (fnDel) { await api.req('DELETE', `/api/banquets/functions/${fnDel}`); await this.load(); return true }
    const itDel = el.closest<HTMLElement>('[data-itdel]')?.dataset.itdel
    if (itDel) { await api.req('DELETE', `/api/banquets/items/${itDel}`); await this.load(); return true }
    const vdel = el.closest<HTMLElement>('[data-vdel]')?.dataset.vdel
    if (vdel) { await api.req('DELETE', `/api/banquets/vendors/${vdel}`); await this.load(); return true }
    const blk = el.closest<HTMLElement>('[data-blk]')?.dataset.blk
    if (blk) { this.h.openBlock(blk); return false }
    const chk = el.closest<HTMLElement>('[data-check]')?.dataset.check
    if (chk && d) {
      const c = d.checks.find((x) => x.item === chk)!
      this.h.modal.open(c.label, `<div class="form-grid"><label>Status<select name="st">${opt(Object.entries(CHECK_LABEL), c.status)}</select></label><label>Number / reference<input name="ref" maxlength="80" value="${esc(c.ref ?? '')}"></label></div>`, 'Save', async (f) => {
        await api.req('PUT', `/api/banquets/events/${d.id}/checks/${chk}`, { status: val(f, 'st'), ref: val(f, 'ref') })
        await this.reload(); return 'Saved'
      })
      return false
    }
    const a = el.closest<HTMLElement>('[data-evact]')?.dataset.evact
    if (!a) return false
    if (a === 'new') { await this.enquiry(); return false }
    if (a === 'book') { await this.book(); return false }
    if (a === 'back') { this.selected = null; this.d = null; await this.load(); return true }
    if (!d) return false
    const done = async (msg: string) => { await this.reload(); return msg }
    const base = `/api/banquets/events/${d.id}`
    switch (a) {
      case 'client':
        this.h.modal.open('Client details', `<div class="form-grid">${this.clientFields(d)}</div>`, 'Save', async (f) => { await api.req('PATCH', base, this.clientBody(f)); return done('Saved') })
        break
      case 'fn':
        this.h.modal.open('Add function', `<div class="form-grid">${this.fnFields(undefined, { date: d.functions[0]?.date })}</div>`, 'Add', async (f) => {
          const r = await api.post<{ clashes: Clash[] }>(`${base}/functions`, this.fnBody(f))
          return done(r.clashes.length ? `Added. Also pencilled: ${r.clashes.map((c) => c.title).join(', ')}` : 'Function added')
        })
        break
      case 'item': {
        const extras = this.pkgs.filter((p) => p.kind !== 'menu' && p.active)
        this.h.modal.open('Add item', `<div class="form-grid"><label class="span2">From a package<select name="pkg"><option value="">— describe it below —</option>${extras.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ${money(p.price_paise)}</option>`).join('')}</select></label>
            <label class="span2">Description<input name="desc" maxlength="160" placeholder="Nadaswaram troupe, welcome cake…"></label>
            <label>Quantity<input name="qty" type="number" min="0.5" step="0.5" value="1"></label><label>Rate (₹)<input name="rate" type="number" min="0"></label>
            <label>GST as<select name="kind">${opt([['other', 'Services (18%)'], ['catering', 'Food (restaurant rate)'], ['hall', 'Venue (18%)']])}</select></label>
            <label>For<select name="fn"><option value="">The whole event</option>${d.functions.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label></div>`, 'Add', async (f) => {
          await api.post(`${base}/items`, { packageId: val(f, 'pkg') || undefined, description: val(f, 'desc') || undefined, qty: num(f, 'qty') ?? 1, rate: num(f, 'rate'), gstKind: val(f, 'pkg') ? undefined : val(f, 'kind'), functionId: val(f, 'fn') || undefined })
          return done('Item added')
        })
        break
      }
      case 'quote':
        this.h.modal.open('Issue a quote', `<p class="small">The quote freezes today's lines and prices: ${money(d.priced.total)} before any discount. ${d.limits.discountPercent == null ? 'There is no limit on your discount.' : `Your discount limit is ${d.limits.discountPercent}%; more goes to the GM.`}</p>
          <div class="form-grid"><label>Discount (%)<input name="disc" type="number" min="0" max="50" step="0.5" value="0"></label><label>Valid for (days)<input name="days" type="number" min="1" max="60" value="15"></label></div>`, 'Issue', async (f) => {
          const r = await api.post<{ status: string; version: number }>(`${base}/quote`, { discountPercent: Number(val(f, 'disc') || 0), validDays: Number(val(f, 'days') || 15) })
          return done(r.status === 'awaiting_approval' ? `Quote v${r.version} waits for the GM to approve the discount` : `Quote v${r.version} issued`)
        })
        break
      case 'hold':
        this.h.modal.open('Hold the dates', `<p class="small">While held, no other event can hold or book these venues and times. The hold lapses by itself.</p><div class="form-grid"><label>Days<input name="days" type="number" min="1" max="${d.limits.holdDays ?? 60}" value="${Math.min(7, d.limits.holdDays ?? 7)}"></label></div>`, 'Hold', async (f) => {
          const r = await api.post<{ holdUntil: string }>(`${base}/hold`, { days: Number(val(f, 'days')) })
          return done(`Held until ${showDate(r.holdUntil)}`)
        })
        break
      case 'release': await api.post(`${base}/release`); toast('Hold released'); await this.load(); return true
      case 'contract': {
        const acc = d.quotes.find((q) => q.status === 'accepted')!
        this.h.modal.open('Contract signed', `<p class="small">The event becomes definite and its venues are booked. Quote v${acc.version}: ${money(acc.totalPaise)}.</p>
          <div class="form-grid"><label>Signed on<input name="on" type="date" value="${esc(d.today)}"></label>
          <label class="span2 check"><input type="checkbox" name="std" checked> Standard schedule: 25% on signing, 50% 30 days before, the rest 7 days before</label>
          <label class="span2">Or your own instalments, one per line: label, date, amount (₹)<textarea name="ms" rows="3" placeholder="On signing, ${esc(d.today)}, 100000"></textarea></label></div>`, 'Confirm', async (f) => {
          const custom = checked(f, 'std') ? undefined : val(f, 'ms').split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((x) => x.length >= 3).map(([label, dueOn, amount]) => ({ label, dueOn, amount: Number(amount.replace(/[^\d.]/g, '')) }))
          await api.post(`${base}/contract`, { signedOn: val(f, 'on'), milestones: custom })
          return done('Definite: venues booked')
        })
        break
      }
      case 'beo': {
        const r = await api.post<{ revision: number; permissionsOpen: string[] }>(`${base}/beo`)
        toast(`Event order revision ${r.revision} sent to every department${r.permissionsOpen.length ? `. Still open: ${r.permissionsOpen.length} permission${r.permissionsOpen.length > 1 ? 's' : ''}` : ''}`)
        await this.load(); return true
      }
      case 'instructions':
        this.h.modal.open('Department instructions', `<p class="small muted">These go on the event order for each department.</p><div class="form-grid">${Object.entries(d.beo.depts).map(([k, dep]) =>
          `<label class="span2">${esc(dep.name)}<textarea name="ins:${k}" rows="2" maxlength="2000">${esc(d.instructions[k] ?? '')}</textarea></label>`).join('')}</div>`, 'Save', async (f) => {
          await api.req('PATCH', base, { instructions: Object.fromEntries(Object.keys(d.beo.depts).map((k) => [k, val(f, `ins:${k}`)])) })
          return done('Saved')
        })
        break
      case 'vendor': {
        const vendors = await api.get<{ id: string; name: string }[]>('/api/banquets/vendor-list')
        this.h.modal.open('Add a supplier', `<p class="small muted">Decorators, DJs, photographers, tent and lighting: from the vendor master (Stores → Vendors), where their PAN and TDS category are kept.</p>
          <div class="form-grid"><label class="span2">Supplier<select name="v">${vendors.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label>
          <label>For<input name="svc" maxlength="120" placeholder="Stage decor, DJ…"></label><label>Agreed (₹, before GST)<input name="amt" type="number" min="0" value="0"></label>
          <label class="span2">Notes<input name="notes" maxlength="500"></label></div>`, 'Add', async (f) => {
          await api.post(`${base}/vendors`, { vendorId: val(f, 'v'), service: val(f, 'svc'), agreed: Number(val(f, 'amt') || 0), notes: val(f, 'notes') })
          return done('Supplier added')
        })
        break
      }
      case 'block': this.h.newBlock(d.id, d.title); return false
      case 'follow':
        this.h.modal.open('Follow-up', `<div class="form-grid"><label>Kind<select name="kind">${opt(ACT_KINDS)}</select></label><label>On<input name="due" type="date" value="${esc(d.today)}"></label>
          <label class="span2">About<input name="subject" maxlength="200" placeholder="Call back about the menu tasting"></label></div>`, 'Save', async (f) => {
          await api.post('/api/sales/activities', { eventId: d.id, kind: val(f, 'kind'), subject: val(f, 'subject'), dueOn: val(f, 'due') })
          return done('Follow-up saved')
        })
        break
      case 'pay':
        this.h.modal.open('Payment', `<p class="small">${d.invoice ? `Balance due on the bill: ${money(d.invoice.balancePaise)}.` : 'Advances get a GST receipt voucher.'} Cash for one event stays under ₹2 lakh in all.</p>
          <div class="form-grid"><label>How<select name="m">${opt([['upi', 'UPI'], ['bank', 'Bank transfer'], ['card', 'Card'], ['cheque', 'Cheque'], ['cash', 'Cash'], ...(d.invoice && d.account ? [['company', `To ${d.account.name}'s account`] as [string, string]] : [])])}</select></label><label>Amount (₹)<input name="amt" type="number" min="1" step="0.01" value="${d.invoice && d.invoice.balancePaise > 0 ? d.invoice.balancePaise / 100 : ''}"></label>
          <label class="span2">Reference (UTR, cheque or approval no.)<input name="ref" maxlength="80"></label><label class="span2 check"><input type="checkbox" name="refund"> This is a refund to the client</label></div>`, 'Record', async (f) => {
          const r = await api.post<{ voucher: { number: string } | null }>(`${base}/payments`, { method: val(f, 'm'), amount: Number(val(f, 'amt')), reference: val(f, 'ref'), refund: checked(f, 'refund') })
          return done(r.voucher ? `Recorded on ${r.voucher.number}` : 'Recorded')
        })
        break
      case 'served':
        this.h.modal.open('Guests served', `<p class="small">Plates are billed at the guarantee, or at the number served if more.</p><div class="form-grid">${d.functions.map((x) => `<label>${esc(x.name)} <small class="muted">guaranteed ${x.guaranteedPax ?? x.expectedPax}</small><input name="srv:${x.id}" type="number" min="0" value="${x.actualPax ?? ''}"></label>`).join('')}</div>`, 'Save', async (f) => {
          for (const x of d.functions) if (val(f, `srv:${x.id}`) !== '') await api.req('PATCH', `/api/banquets/functions/${x.id}`, { actualPax: Number(val(f, `srv:${x.id}`)) })
          return done('Saved')
        })
        break
      case 'bill':
        this.h.modal.open('Final bill', `<p class="small">Issues the tax invoice for ${esc(d.title)} with the guests served, and takes in the ${money(d.advancesHeldPaise)} advanced. It cannot be changed afterwards; a correction is a credit note.</p>`, 'Issue bill', async () => {
          const r = await api.post<{ number: string; id: string; balancePaise: number }>(`${base}/bill`)
          await this.reload()
          toast(`Bill ${r.number}: ${r.balancePaise > 0 ? `${money(r.balancePaise)} due` : 'nothing due'}`)
          void api.openDocument(`/api/tax-documents/${r.id}/print`)
          return ''
        })
        break
      case 'feedback':
        this.h.modal.open('Client feedback', `<div class="form-grid"><label>Score<select name="score">${opt([['5', '5 · excellent'], ['4', '4 · good'], ['3', '3 · fair'], ['2', '2 · poor'], ['1', '1 · very poor']])}</select></label><label class="span2">What they said<textarea name="note" rows="3" maxlength="1000"></textarea></label></div><p class="muted small">A score of 2 or less goes to the MD at once.</p>`, 'Close the event', async (f) => {
          await api.post(`${base}/feedback`, { score: Number(val(f, 'score')), note: val(f, 'note') })
          return done('Closed')
        })
        break
      case 'lost':
        this.h.modal.open('Lost', `<div class="form-grid"><label class="span2">Why<select name="why">${opt([['Price', 'Price'], ['Date not available', 'Date not available'], ['Chose another venue', 'Chose another venue'], ['Event called off', 'Event called off'], ['No response', 'No response'], ['Other', 'Other']])}</select></label>
          <label class="span2">Went to (if known)<input name="to" maxlength="120"></label></div>`, 'Mark lost', async (f) => { await api.post(`${base}/lost`, { reason: val(f, 'why'), lostTo: val(f, 'to') }); return done('Marked lost') })
        break
      case 'cancel':
        this.h.modal.open('Cancel the event', `<p class="small">${money(d.advancesHeldPaise)} is held. What is refunded goes back on a refund voucher; what is kept is invoiced as the cancellation charge.</p>
          <div class="form-grid"><label class="span2">Reason<input name="why" maxlength="200"></label><label>Refund (₹)<input name="amt" type="number" min="0" step="0.01" value="0"></label>
          <label>How<select name="m">${opt([['bank', 'Bank transfer'], ['upi', 'UPI'], ['cheque', 'Cheque'], ['card', 'Card'], ['cash', 'Cash']])}</select></label><label class="span2">Reference<input name="ref" maxlength="80"></label></div>`, 'Cancel event', async (f) => {
          await api.post(`${base}/cancel`, { reason: val(f, 'why'), refund: Number(val(f, 'amt') || 0), method: val(f, 'm'), reference: val(f, 'ref') })
          return done('Cancelled')
        })
        break
    }
    return false
  }
}
