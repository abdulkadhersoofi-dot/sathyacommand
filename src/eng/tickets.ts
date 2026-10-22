import { esc, toast } from '../ui/dom'
import { val } from '../ui/form-modal'
import { hydratePhotos, takePhoto, uploadPhoto } from '../ui/photo'
import { steps, toolbar, type Action, type Step } from '../ui/toolbar'
import type { WorkspaceHost } from '../ui/workspace'
import { age, CATEGORY, priorityPill, reportFault, rupees, statusPill, type Ticket } from './common'

// Fault and maintenance tickets: what is open (most urgent first, late ones flagged), mine, fixed and
// waiting for the reporter to confirm, and closed. Each ticket's actions depend on who is looking.

type Filter = 'open' | 'mine' | 'done' | 'closed'

export class TicketsView {
  private list: Ticket[] = []
  private filter: Filter = 'open'
  private people: { id: string; name: string; on_duty: boolean }[] = []
  constructor(private h: WorkspaceHost) {}

  private get worker() { return this.h.can('eng.work', 'eng.manage') }

  async load() {
    const status = this.filter === 'mine' ? 'open' : this.filter
    this.list = await this.h.cached(`/api/eng/tickets?status=${status}`)
    if (this.filter === 'mine') this.list = this.list.filter((k) => k.assigned_to === this.h.me.id)
  }

  html() {
    const chip = (f: Filter, label: string) => `<button type="button" class="chip" data-tf="${f}" aria-pressed="${this.filter === f}">${label}</button>`
    const late = this.list.filter((k) => k.responseLate || k.resolveLate).length
    return `${toolbar({
      primary: [{ attrs: 'data-tk="new"', label: 'Report a fault' }],
      filters: `<div class="chips">${chip('open', 'Open')}${this.worker ? chip('mine', 'Mine') : ''}${chip('done', 'Fixed: to confirm')}${chip('closed', 'Closed')}</div>`,
      end: late ? `<span class="fd-warn">${late} late</span>` : '',
    })}
      ${this.list.map((k) => `<div class="row-card tk-card${k.escalation ? ' late' : ''}" data-ticket="${esc(k.id)}">
          <div class="rc-title">${k.kind === 'pm' ? '🛠 ' : ''}${esc(k.title)}</div>
          <div class="rc-sub">${esc([k.space, k.asset].filter(Boolean).join(' · ') || 'Place not given')} · ${age(k.reported_at)} ago${k.reported_by ? ` · by ${esc(k.reported_by)}` : ''}${k.assignee ? ` · ${esc(k.assignee)}` : this.worker && ['open', 'on_hold'].includes(k.status) ? ' · <b>nobody yet</b>' : ''}
            ${k.responseLate ? ' · <span class="fd-warn">not taken in time</span>' : k.resolveLate ? ' · <span class="fd-warn">overdue</span>' : ''}${k.hold_reason && k.status === 'on_hold' ? ` · waiting: ${esc(k.hold_reason)}` : ''}</div>
          <div class="rc-right">${priorityPill(k.priority)}${statusPill(k.status)}</div></div>`).join('') || '<div class="empty">Nothing here.</div>'}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const f = el.closest<HTMLElement>('[data-tf]')?.dataset.tf as Filter | undefined
    if (f) { this.filter = f; await this.load(); return true }
    if (el.closest('[data-tk=new]')) { reportFault(this.h, {}, () => void this.load().then(() => this.h.render())); return false }
    const id = el.closest<HTMLElement>('[data-ticket]')?.dataset.ticket
    if (id) await this.open(id)
    return false
  }

  /** The ticket's details and what this person can do with it. */
  async open(id: string) {
    let k = this.list.find((x) => x.id === id)
    if (!k) { k = (await this.h.api.get<Ticket[]>('/api/eng/tickets?status=all')).find((x) => x.id === id); if (!k) { toast('Ticket not found'); return } }
    const t = k
    const isOpen = ['open', 'in_progress', 'on_hold'].includes(t.status)
    const manage = this.h.can('eng.manage'), worker = this.worker
    const mineToClose = t.status === 'done' && (manage || t.reporter_id === this.h.me.id)
    // The ticket's steps in the order they happen; the current one is the button to press, the rest of
    // what this person can do goes under More.
    const started = ['in_progress', 'done', 'closed'].includes(t.status), fixed = ['done', 'closed'].includes(t.status)
    const now = isOpen && worker && !t.assigned_to ? 'take' : isOpen && worker && !started ? 'start' : worker && t.status === 'in_progress' ? 'done' : mineToClose ? 'close' : null
    const st = (label: string, done: boolean, key: string, title?: string): Step => ({ label, state: done ? 'done' : now === key ? 'now' : 'todo', attrs: now === key ? `data-ta="${key}"` : undefined, title })
    const flow: Step[] = t.status === 'cancelled' ? [] : [
      { label: 'Reported', state: 'done' },
      st(t.assigned_to ? 'Assigned' : 'Take it', !!t.assigned_to, 'take', t.assignee ? `With ${t.assignee}` : 'Nobody has taken it yet'),
      st(started ? 'Started' : 'Start work', started, 'start', t.status === 'on_hold' ? `On hold: ${t.hold_reason ?? ''}` : undefined),
      st(fixed ? 'Fixed' : 'Mark fixed', fixed, 'done', 'What was done, with a photo'),
      st(t.status === 'closed' ? 'Confirmed' : 'Confirm fixed', t.status === 'closed', 'close', 'The person who reported it confirms'),
    ]
    const act = (key: string, label: string, danger = false): Action | null => now === key ? null : { attrs: `data-ta="${key}"`, label, danger }
    const more: Action[] = [
      ...(isOpen && worker ? [
        t.assigned_to !== this.h.me.id ? act('take', 'I will take it') : null,
        t.status !== 'in_progress' ? act('start', 'Start work') : null,
        act('done', 'Mark fixed'), act('hold', 'Put on hold'), act('spares', 'Draw spares'),
      ] : []),
      ...(isOpen && manage ? [act('assign', 'Assign to someone'), act('cancel', 'Cancel the ticket', true)] : []),
      mineToClose ? act('close', 'Confirm fixed') : null,
      fixed && (manage || t.reporter_id === this.h.me.id) ? act('reopen', 'Still not right') : null,
    ].filter((x): x is Action => !!x)
    this.h.modal.open(t.title, `<div class="room-head">${priorityPill(t.priority)}${statusPill(t.status)}${t.escalation ? '<span class="fd-warn">Escalated</span>' : ''}</div>
      <dl class="kv">${t.space ? `<dt>Where</dt><dd>${esc(t.space)}</dd>` : ''}${t.asset ? `<dt>Asset</dt><dd>${esc(t.asset)} · ${esc(CATEGORY[t.category ?? ''] ?? '')}</dd>` : ''}
        ${t.detail ? `<dt>Detail</dt><dd>${esc(t.detail)}</dd>` : ''}<dt>Reported</dt><dd>${new Date(t.reported_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${t.reported_by ? ` by ${esc(t.reported_by)}` : ' (planned)'}</dd>
        <dt>Answer by</dt><dd>${new Date(t.respond_by).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${t.responseLate ? ' <span class="fd-warn">late</span>' : ''}</dd>
        <dt>Fix by</dt><dd>${new Date(t.resolve_by).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${t.resolveLate ? ' <span class="fd-warn">late</span>' : ''}</dd>
        ${t.assignee ? `<dt>With</dt><dd>${esc(t.assignee)}</dd>` : ''}${t.hold_reason ? `<dt>Waiting for</dt><dd>${esc(t.hold_reason)}</dd>` : ''}
        ${t.resolution ? `<dt>Done</dt><dd>${esc(t.resolution)}</dd>` : ''}${t.spares_paise ? `<dt>Spares</dt><dd>${rupees(Number(t.spares_paise))}</dd>` : ''}</dl>
      ${t.checklist.length ? `<ul class="checklist">${t.checklist.map((c, i) => `<li><label><input type="checkbox" data-ck="${i}" ${c.done ? 'checked' : ''} ${isOpen && this.worker ? '' : 'disabled'}> ${esc(c.item)}</label></li>`).join('')}</ul>` : ''}
      ${t.photos.length ? `<div class="photos">${t.photos.map((p) => `<img data-upload="${esc(p)}" alt="Fault photo">`).join('')}</div>` : ''}
      <div class="room-actions">${flow.length ? steps(flow) : ''}${toolbar({ more })}</div>`, 'Done', async () => '')
    hydratePhotos(this.h.api, this.h.modal.el)
    const checklist = () => t.checklist.map((c, i) => ({ item: c.item, done: !!this.h.modal.el.querySelector<HTMLInputElement>(`[data-ck="${i}"]`)?.checked }))
    const after = async (msg: string) => { await this.load(); this.h.render(); return msg }
    const post = (action: string, body: unknown = {}) => this.h.api.post(`/api/eng/tickets/${t.id}/${action}`, body)
    this.h.modal.el.querySelector('.room-actions')!.addEventListener('click', async (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-ta]')?.dataset.ta
      if (!a) return
      try {
        if (a === 'take' || a === 'start' || a === 'close') { await post(a); this.h.modal.close(); toast(await after(a === 'close' ? 'Closed. Thank you.' : a === 'take' ? 'It is yours' : 'Started')); return }
        if (a === 'done') {
          const list = checklist()
          let photo: string | null = null
          this.h.modal.open(`Fixed: ${t.title}`, `<div class="form-grid"><label class="span2">What was done?<textarea name="resolution" rows="3" maxlength="500"></textarea></label></div>
            <div class="actions"><button type="button" class="btn" data-photo>Photo of the fix</button><span class="muted small" data-photo-state></span></div>`, 'Mark fixed', async (f) => {
            const photoIds = photo ? [await uploadPhoto(this.h.api, 'fault', photo)] : []
            await post('done', { resolution: val(f, 'resolution'), checklist: list.length ? list : undefined, photoIds })
            return after(t.reported_by ? `Fixed. ${t.reported_by} is asked to confirm.` : 'Fixed')
          })
          this.h.modal.el.querySelector('[data-photo]')!.addEventListener('click', async () => {
            photo = await takePhoto(); this.h.modal.el.querySelector('[data-photo-state]')!.textContent = photo ? 'Photo ready' : ''
          })
        }
        const reasonForm = (title: string, label: string, action: string, ok: string) => this.h.modal.open(title, `<div class="form-grid"><label class="span2">${label}<input name="reason" maxlength="200"></label></div>`, ok, async (f) => {
          await post(action, { reason: val(f, 'reason') }); return after(ok)
        })
        if (a === 'hold') reasonForm('On hold', 'Waiting for (spares, vendor, guest in the room…)', 'hold', 'On hold')
        if (a === 'cancel') reasonForm('Cancel ticket', 'Why (duplicate, not a fault…)', 'cancel', 'Cancelled')
        if (a === 'reopen') reasonForm('Still not right', 'What is still wrong?', 'reopen', 'Reopened')
        if (a === 'assign') {
          if (!this.people.length) this.people = await this.h.api.get('/api/eng/people')
          this.h.modal.open('Assign', `<div class="form-grid"><label class="span2">To<select name="user">${this.people.map((p) => `<option value="${esc(p.id)}" ${p.id === t.assigned_to ? 'selected' : ''}>${esc(p.name)}${p.on_duty ? ' · on duty' : ''}</option>`).join('')}</select></label></div>`, 'Assign', async (f) => {
            await post('assign', { userId: val(f, 'user') }); return after('Assigned')
          })
        }
        if (a === 'spares') {
          const spares = (await this.h.api.get<{ id: string; name: string; unit: string; stock: number; active: boolean }[]>('/api/eng/spares')).filter((s) => s.active && s.stock > 0)
          this.h.modal.open('Draw spares', spares.length ? `<div class="form-grid"><label class="span2">Part<select name="spare">${spares.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${s.stock} ${esc(s.unit)}</option>`).join('')}</select></label>
            <label>Quantity<input name="qty" type="number" min="0.01" step="0.01" value="1"></label></div>` : '<p>The engineering store has nothing in it yet. Ask the stores to transfer the part from the main store (Stores → Stock → Transfer to a store → Engineering store), or raise an indent for it.</p>', spares.length ? 'Draw' : 'Done', async (f) => {
            if (!spares.length) return ''
            const r = await this.h.api.post<{ pending?: boolean }>(`/api/eng/spares/${val(f, 'spare')}/issue`, { qty: Number(val(f, 'qty')), ticketId: t.id })
            return after(r.pending ? 'Above your limit: sent for approval' : 'Drawn from the store')
          })
        }
      } catch (err) { toast((err as Error).message) }
    })
  }

  mounted(root: HTMLElement) { hydratePhotos(this.h.api, root) }
}
