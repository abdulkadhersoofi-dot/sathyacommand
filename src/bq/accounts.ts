import { esc, tonePill, showDate } from '../ui/dom'
import { confirmDanger, val } from '../ui/form-modal'
import { toolbar, type Action } from '../ui/toolbar'
import { money } from '../acc/books'
import { STATUS_LABEL } from './calendar'
import { ACT_KINDS, activityRows, doneForm, type Activity } from './sales'
import type { BqHost } from './workspace'

// Company accounts: who handles them, their contacts, contracted room rates, what they have booked this
// year, follow-ups, and what they owe.

interface Row { id: string; name: string; kind: string; city: string | null; contact_name: string | null; phone: string | null; active: boolean; owner: string | null; nights: number; roomRevenuePaise: number; eventRevenuePaise: number; rates: number; next_due: string | null; creditLimitPaise: number | null }
interface Detail {
  account: { id: string; name: string; kind: string; gstin: string | null; city: string | null; address: string | null; phone: string | null; email: string | null; owner: string | null; owner_id: string | null; notes: string | null; credit_limit_paise: number | null; terms_days: number }
  contacts: { id: string; name: string; role: string | null; mobile: string | null; email: string | null }[]
  rates: { id: string; room_type: string; plan_code: string; valid_from: string; valid_to: string; rate_paise: number; by: string; current: boolean }[]
  activities: (Activity & { done_at: string | null; outcome: string | null })[]
  stays: { id: string; guest: string; arrival: string; departure: string; status: string; room_type_id: string; amount_paise: string }[]
  events: { id: string; number: string; title: string; status: string }[]
  outstandingPaise: number; today: string
}
const KIND: Record<string, string> = { company: 'Company', travel_agent: 'Travel agent', government: 'Government', other: 'Other', ota: 'OTA' }

export class AccountsView {
  selected: string | null = null
  private rows: Row[] = []
  private from = ''
  private d: Detail | null = null
  private q = ''
  constructor(private h: BqHost) {}

  async load() {
    if (this.selected) this.d = await this.h.cached(`/api/sales/accounts/${this.selected}`)
    else { const r = await this.h.cached<{ from: string; accounts: Row[] }>('/api/sales/accounts'); this.rows = r.accounts; this.from = r.from }
  }
  private async reload() { await this.load(); this.h.render() }

  html() { return this.selected && this.d ? this.detail(this.d) : this.list() }

  private list() {
    const q = this.q.toLowerCase()
    const rows = this.rows.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.city ?? '').toLowerCase().includes(q))
    return `${toolbar({
      primary: this.h.can('sales.manage') ? [{ attrs: 'data-ac="new"', label: 'New account' }] : [],
      filters: `<input class="ws-search" type="search" placeholder="Search accounts" value="${esc(this.q)}" data-acq>`,
    })}
      <p class="muted small">This year (from ${esc(this.from)}): room nights and room revenue booked for each account, and its events billed.</p>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Account</th><th>Handled by</th><th class="n">Room nights</th><th class="n">Rooms</th><th class="n">Events</th><th>Next follow-up</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="${r.active ? '' : 'retired'}"><td><button type="button" class="linkish" data-acopen="${esc(r.id)}"><b>${esc(r.name)}</b></button> <small class="muted">${esc(KIND[r.kind] ?? r.kind)}${r.city ? `, ${esc(r.city)}` : ''}${r.rates ? ' · contracted rate' : ''}</small></td>
          <td>${esc(r.owner ?? '—')}</td><td class="n">${r.nights}</td><td class="n">${money(r.roomRevenuePaise)}</td><td class="n">${money(r.eventRevenuePaise)}</td><td>${r.next_due ? esc(showDate(r.next_due)) : '<span class="muted">—</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No accounts yet.</td></tr>'}
      </tbody></table></div>`
  }

  private detail(d: Detail) {
    const a = d.account, manage = this.h.can('sales.manage'), rates = this.h.can('rates.contract')
    const more: Action[] = [
      manage ? { attrs: 'data-ac="edit"', label: 'Account details' } : null,
      rates ? { attrs: 'data-ac="rate"', label: 'Contracted rate' } : null,
    ].filter((x): x is Action => !!x)
    return `<div class="tb"><button type="button" class="btn ghost" data-ac="back">← All accounts</button></div>
      <div class="bq-head"><div><div class="muted small">${esc(KIND[a.kind] ?? a.kind)}${a.city ? ` · ${esc(a.city)}` : ''}</div><h2>${esc(a.name)}</h2>
        <div class="small">${a.gstin ? `GSTIN <span class="mono">${esc(a.gstin)}</span> · ` : ''}${a.phone ? `${esc(a.phone)} · ` : ''}${a.email ? esc(a.email) : ''}</div>
        <div class="muted small">Handled by ${esc(a.owner ?? 'nobody yet')} · credit ${a.credit_limit_paise == null ? 'limit not set' : `limit ${money(a.credit_limit_paise)}`}, ${a.terms_days} days · owes <b>${money(d.outstandingPaise)}</b></div>
        ${a.notes ? `<p class="small">${esc(a.notes)}</p>` : ''}</div></div>
      ${toolbar({ primary: manage ? [{ attrs: 'data-ac="follow"', label: 'Follow-up' }, { attrs: 'data-ac="contact"', label: 'Add a contact', primary: false }] : [], more })}
      <div class="sec-title">Contacts</div>
      <div class="m-table">${d.contacts.map((c) => `<div class="m-row bq-contact"><b>${esc(c.name)}</b><span>${esc(c.role ?? '')}</span><span>${c.mobile ? `<a href="tel:${esc(c.mobile)}">${esc(c.mobile)}</a>` : ''}</span><span>${esc(c.email ?? '')}</span>
        <span class="rc-right">${manage ? `<button type="button" class="btn small ghost" data-acdel="${esc(c.id)}">Remove</button>` : ''}</span></div>`).join('') || '<p class="empty">No contacts yet.</p>'}</div>
      <div class="sec-title">Contracted room rates</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Room</th><th>Plan</th><th>From</th><th>To</th><th class="n">Per night</th><th>Set by</th><th></th></tr></thead><tbody>
        ${d.rates.map((r) => `<tr class="${r.current ? '' : 'retired'}"><td>${esc(r.room_type)}</td><td>${esc(r.plan_code)}</td><td>${esc(showDate(r.valid_from))}</td><td>${esc(showDate(r.valid_to))}</td><td class="n">${money(r.rate_paise)}</td><td>${esc(r.by)}</td>
          <td>${rates ? `<button type="button" class="btn small ghost" data-rtdel="${esc(r.id)}">Remove</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Rack rates apply.</td></tr>'}
      </tbody></table></div>
      <div class="sec-title">Follow-ups</div>
      ${activityRows(d.activities.filter((x) => !x.done_at), d.today, false) || '<p class="empty">Nothing due.</p>'}
      ${d.activities.some((x) => x.done_at) ? `<div class="m-table">${d.activities.filter((x) => x.done_at).slice(0, 10).map((x) => `<div class="m-row bq-ins"><span class="muted small">${esc(new Date(x.done_at!).toLocaleDateString('en-IN'))}</span><span>${esc(x.subject)}${x.outcome ? `: <i>${esc(x.outcome)}</i>` : ''}</span></div>`).join('')}</div>` : ''}
      <div class="sec-title">Stays</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Guest</th><th>Room</th><th>Arrival</th><th>Departure</th><th>Status</th><th class="n">Rooms</th></tr></thead><tbody>
        ${d.stays.map((s) => `<tr><td>${esc(s.guest)}</td><td>${esc(s.room_type_id)}</td><td>${esc(s.arrival)}</td><td>${esc(s.departure)}</td><td>${esc(s.status.replace('_', ' '))}</td><td class="n">${money(Number(s.amount_paise ?? 0))}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No stays yet.</td></tr>'}
      </tbody></table></div>
      ${d.events.length ? `<div class="sec-title">Events</div><div class="m-table">${d.events.map((e) => `<div class="m-row bq-ins"><span class="mono">${esc(e.number)}</span><span><button type="button" class="linkish" data-ev2="${esc(e.id)}">${esc(e.title)}</button> ${tonePill(STATUS_LABEL[e.status] ?? e.status, '--muted')}</span></div>`).join('')}</div>` : ''}`
  }

  onInput(el: HTMLElement) { if (el.matches('[data-acq]')) { this.q = (el as HTMLInputElement).value; this.h.render() } }

  private accountForm(title: string, a?: Detail['account']) {
    return this.h.api.get<{ id: string; name: string }[]>('/api/sales/people').catch(() => []).then((sellers) => {
      // A new account is looked after by whoever opens it, if they sell.
      const mine = a ? a.owner_id : sellers.find((u) => u.id === this.h.me.id)?.id
      this.h.modal.open(title, `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="120" value="${esc(a?.name ?? '')}"></label>
          <label>Kind<select name="kind">${['company', 'travel_agent', 'government', 'other'].map((k) => `<option value="${k}" ${a?.kind === k ? 'selected' : ''}>${esc(KIND[k])}</option>`).join('')}</select></label>
          <label>GSTIN<input name="gstin" maxlength="15" value="${esc(a?.gstin ?? '')}"></label><label>City<input name="city" value="${esc(a?.city ?? '')}"></label>
          <label>Phone<input name="phone" value="${esc(a?.phone ?? '')}"></label><label>Email<input name="email" value="${esc(a?.email ?? '')}"></label>
          ${sellers.length ? `<label>Handled by<select name="owner"><option value="">—</option>${sellers.map((u) => `<option value="${esc(u.id)}" ${mine === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>` : ''}
          <label class="span2">Address<input name="address" value="${esc(a?.address ?? '')}"></label><label class="span2">Notes<textarea name="notes" rows="2">${esc(a?.notes ?? '')}</textarea></label></div>`, 'Save', async (f) => {
        const body = { name: val(f, 'name'), kind: val(f, 'kind'), gstin: val(f, 'gstin').toUpperCase(), city: val(f, 'city'), phone: val(f, 'phone'), email: val(f, 'email'), address: val(f, 'address'), notes: val(f, 'notes'), ...(sellers.length ? { ownerId: val(f, 'owner') || null } : {}) }
        if (a) await this.h.api.req('PATCH', `/api/debtors/${a.id}`, body)
        else this.selected = (await this.h.api.post<{ id: string }>('/api/debtors', body)).id
        await this.reload(); return 'Saved'
      })
    })
  }

  async click(el: HTMLElement) {
    const api = this.h.api
    const open = el.closest<HTMLElement>('[data-acopen]')?.dataset.acopen
    if (open) { this.selected = open; await this.load(); return true }
    const ev = el.closest<HTMLElement>('[data-ev2]')?.dataset.ev2
    if (ev) { this.h.openEvent(ev); return false }
    const done = el.closest<HTMLElement>('[data-actdone]')?.dataset.actdone
    if (done && this.d) { doneForm(this.h, this.d.activities.find((a) => a.id === done)!, () => this.reload()); return false }
    const del = el.closest<HTMLElement>('[data-acdel]')?.dataset.acdel
    if (del) { confirmDanger(this.h.modal, 'Remove this contact?', 'Their past follow-ups stay on the account.', 'Remove the contact', async () => { await api.req('DELETE', `/api/sales/contacts/${del}`); await this.load(); this.h.render(); return 'Removed' }); return false }
    const rdel = el.closest<HTMLElement>('[data-rtdel]')?.dataset.rtdel
    if (rdel) { confirmDanger(this.h.modal, 'End this contracted rate?', 'New bookings for the account go back to the rate table.', 'End the rate', async () => { await api.req('DELETE', `/api/sales/rates/${rdel}`); await this.load(); this.h.render(); return 'Rate ended' }); return false }
    const a = el.closest<HTMLElement>('[data-ac]')?.dataset.ac
    if (a === 'back') { this.selected = null; this.d = null; await this.load(); return true }
    if (a === 'new') await this.accountForm('New account')
    const d = this.d
    if (!d) return false
    const base = `/api/sales/accounts/${d.account.id}`
    if (a === 'edit') await this.accountForm(d.account.name, d.account)
    if (a === 'contact') this.h.modal.open('Add a contact', `<div class="form-grid"><label>Name<input name="name" maxlength="120"></label><label>Role<input name="role" maxlength="80" placeholder="Admin manager, HR…"></label>
        <label>Mobile<input name="mobile" inputmode="tel"></label><label>Email<input name="email" type="email"></label></div>`, 'Add', async (f) => {
      await api.post(`${base}/contacts`, { name: val(f, 'name'), role: val(f, 'role'), mobile: val(f, 'mobile'), email: val(f, 'email') }); await this.reload(); return 'Contact added'
    })
    if (a === 'follow') this.h.modal.open('Follow-up', `<div class="form-grid"><label>Kind<select name="kind">${ACT_KINDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label>On<input name="due" type="date" value="${esc(d.today)}"></label><label class="span2">About<input name="subject" maxlength="200"></label></div>`, 'Save', async (f) => {
      await api.post('/api/sales/activities', { debtorId: d.account.id, kind: val(f, 'kind'), subject: val(f, 'subject'), dueOn: val(f, 'due') }); await this.reload(); return 'Follow-up saved'
    })
    if (a === 'rate') {
      const types = (await api.get<{ id: string; name: string; active: boolean }[]>('/api/room-types')).filter((t) => t.active)
      const y = Number(d.today.slice(0, 4)), fyEnd = Number(d.today.slice(5, 7)) >= 4 ? `${y + 1}-03-31` : `${y}-03-31`
      this.h.modal.open('Contracted rate', `<p class="small muted">Per night before GST. Above ₹7,500 only the MD can agree (the restaurant would move to 18% GST next year).</p><div class="form-grid">
          <label>Room<select name="type">${types.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
          <label>Plan<select name="plan">${['EP', 'CP', 'MAP', 'AP'].map((p) => `<option ${p === 'CP' ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
          <label>From<input name="from" type="date" value="${esc(d.today)}"></label><label>To<input name="to" type="date" value="${fyEnd}"></label><label>Rate (₹)<input name="rate" type="number" min="1"></label></div>`, 'Save', async (f) => {
        await api.post(`${base}/rates`, { roomTypeId: val(f, 'type'), plan: val(f, 'plan'), validFrom: val(f, 'from'), validTo: val(f, 'to'), rate: Number(val(f, 'rate')) }); await this.reload(); return 'Rate saved'
      })
    }
    return false
  }
}
