import { esc, tonePill, showDate } from '../ui/dom'
import { val } from '../ui/form-modal'
import { toolbar } from '../ui/toolbar'
import { money } from '../acc/books'
import { STATUS_LABEL } from './calendar'
import type { BqHost } from './workspace'

// Sales at a glance: events by stage with their value, won and lost this year and why, each person's
// pipeline, where enquiries come from, and the follow-ups due.

interface Pipeline { from: string; today: string; stages: { status: string; count: number; valuePaise: number }[]; wonCount: number; wonPaise: number; lostCount: number; conversion: number | null
  lost: { reason: string; count: number; valuePaise: number }[]; owners: { owner: string; open: number; openPaise: number; won: number; wonPaise: number }[]; sources: { source: string; c: number; won: number }[]; followUpsDue: number }
export interface Activity { id: string; kind: string; subject: string; due_on: string | null; account: string | null; debtor_id: string | null; event: string | null; event_id: string | null; event_number: string | null; owner: string }

export const ACT_KINDS: [string, string][] = [['call', 'Call'], ['visit', 'Visit'], ['meeting', 'Meeting'], ['email', 'Email'], ['whatsapp', 'WhatsApp'], ['note', 'Note']]
const SOURCE: Record<string, string> = { walk_in: 'Walk-in', phone: 'Phone', website: 'Website', referral: 'Referral', planner: 'Wedding planner', repeat: 'Repeat client', corporate: 'Corporate account' }

/** The "done" form for a follow-up, with the next step booked at once. */
export function doneForm(h: BqHost, a: { id: string; subject: string }, after: () => Promise<void>) {
  h.modal.open(`Done: ${a.subject}`, `<div class="form-grid"><label class="span2">What happened<textarea name="out" rows="2" maxlength="1000"></textarea></label>
      <label>Next step<select name="nk"><option value="">None</option>${ACT_KINDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label><label>On<input name="nd" type="date"></label>
      <label class="span2">About<input name="ns" maxlength="200"></label></div>`, 'Done', async (f) => {
    await h.api.post(`/api/sales/activities/${a.id}/done`, { outcome: val(f, 'out'), next: val(f, 'nk') ? { kind: val(f, 'nk'), dueOn: val(f, 'nd'), subject: val(f, 'ns') || a.subject } : undefined })
    await after()
    return 'Done'
  })
}

export function activityRows(list: Activity[], today: string, withTarget = true) {
  return list.map((a) => `<div class="row-card"><div class="rc-title">${esc(ACT_KINDS.find((k) => k[0] === a.kind)?.[1] ?? a.kind)}: ${esc(a.subject)}</div>
      <div class="rc-sub">${withTarget ? `${a.account ? esc(a.account) : ''}${a.event ? `${esc(a.event_number ?? '')} ${esc(a.event)}` : ''} · ` : ''}${esc(a.owner)}</div>
      <div class="rc-right">${a.due_on ? tonePill(a.due_on < today ? `Overdue ${showDate(a.due_on)}` : a.due_on === today ? 'Today' : a.due_on, a.due_on < today ? '--st-departing' : a.due_on === today ? '--marigold' : '--muted') : ''}
        <button type="button" class="btn small" data-actdone="${esc(a.id)}">Done…</button></div></div>`).join('')
}

export class SalesView {
  private p: Pipeline | null = null
  private acts: Activity[] = []
  private today = ''
  private all = false
  constructor(private h: BqHost) {}

  async load() {
    this.p = await this.h.cached('/api/sales/pipeline')
    const a = await this.h.cached<{ today: string; activities: Activity[] }>(`/api/sales/activities${this.all ? '?all=1' : ''}`)
    this.acts = a.activities; this.today = a.today
  }

  html() {
    const p = this.p!
    const max = Math.max(1, ...p.stages.map((s) => s.valuePaise))
    return `<div class="row-card mc-card"><div class="mc-figs"><span><small>Won this year</small><b class="mono">${p.wonCount} · ${money(p.wonPaise)}</b></span><span><small>Lost</small><b class="mono">${p.lostCount}</b></span>
        <span><small>Conversion</small><b class="mono">${p.conversion == null ? '—' : `${p.conversion}%`}</b></span><span><small>Follow-ups due</small><b class="mono ${p.followUpsDue ? 'fd-warn' : ''}">${p.followUpsDue}</b></span></div></div>
      <div class="sec-title">Pipeline</div>
      <div class="bq-funnel">${p.stages.map((s) => `<div class="bq-stage"><div class="bq-bar" style="width:${Math.max(4, Math.round((s.valuePaise * 100) / max))}%"></div><b>${esc(STATUS_LABEL[s.status])}</b><span>${s.count} · <span class="mono">${money(s.valuePaise)}</span></span></div>`).join('')}</div>
      ${toolbar({ filters: `<div class="chips"><button type="button" class="chip" data-sall="0" aria-pressed="${!this.all}">My follow-ups</button><button type="button" class="chip" data-sall="1" aria-pressed="${this.all}">Everyone's</button></div>` })}<div class="sec-title">Follow-ups</div>
      ${activityRows(this.acts, this.today) || '<p class="empty">Nothing to follow up.</p>'}
      <div class="bq-two">
        <div><div class="sec-title">Lost this year, by reason</div><div class="m-table">${p.lost.map((l) => `<div class="m-row bq-lost"><span>${esc(l.reason)}</span><span class="mono">${l.count}</span><span class="mono">${money(l.valuePaise)}</span></div>`).join('') || '<p class="empty">None lost.</p>'}</div></div>
        <div><div class="sec-title">Where enquiries come from</div><div class="m-table">${p.sources.map((s) => `<div class="m-row bq-lost"><span>${esc(SOURCE[s.source] ?? s.source)}</span><span class="mono">${s.c}</span><span class="mono">${s.won} won</span></div>`).join('') || '<p class="empty">No enquiries yet.</p>'}</div></div>
      </div>
      <div class="sec-title">By person</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Handled by</th><th class="n">Open</th><th class="n">Open value</th><th class="n">Won</th><th class="n">Won value</th></tr></thead><tbody>
        ${p.owners.map((o) => `<tr><td>${esc(o.owner)}</td><td class="n">${o.open}</td><td class="n">${money(o.openPaise)}</td><td class="n">${o.won}</td><td class="n">${money(o.wonPaise)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No events this year.</td></tr>'}
      </tbody></table></div>`
  }

  async click(el: HTMLElement) {
    const all = el.closest<HTMLElement>('[data-sall]')?.dataset.sall
    if (all) { this.all = all === '1'; await this.load(); return true }
    const done = el.closest<HTMLElement>('[data-actdone]')?.dataset.actdone
    if (done) doneForm(this.h, this.acts.find((a) => a.id === done)!, async () => { await this.load(); this.h.render() })
    return false
  }
}
