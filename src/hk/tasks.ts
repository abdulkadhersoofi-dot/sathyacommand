import { esc, toast, tonePill } from '../ui/dom'
import { val } from '../ui/form-modal'
import { hydratePhotos } from '../ui/photo'
import { minutes, TASK, TASK_STATE, type HkHost } from './common'
import type { HkTask } from './mine'

// The executive housekeeper's and supervisors' screen: share out the day's rooms, see progress, inspect.

export class TasksView {
  private tasks: HkTask[] = []
  private staff: { id: string; name: string; roles: string[] }[] = []
  private onDuty = new Set<string>()

  constructor(private h: HkHost) {}

  async load() {
    this.tasks = await this.h.api.get('/api/hk/tasks')
    this.staff = await this.h.api.get('/api/hk/staff')
    if (!this.onDuty.size) this.staff.filter((s) => s.roles.includes('room_attendant')).forEach((s) => this.onDuty.add(s.id))
  }

  html() {
    const manage = this.h.can('hk.manage'), inspect = this.h.can('hk.inspect')
    const toInspect = this.tasks.filter((t) => t.status === 'cleaned')
    const byPerson = new Map<string, number>()
    for (const t of this.tasks) if (t.assigned_to && ['pending', 'in_progress', 'reclean'].includes(t.status)) byPerson.set(t.assigned_to, (byPerson.get(t.assigned_to) ?? 0) + Number(t.credits))
    const unassigned = this.tasks.filter((t) => !t.assigned_to && ['pending', 'reclean'].includes(t.status)).length
    const opt = (cur: string | null) => `<option value="">Unassigned</option>${this.staff.map((s) => `<option value="${esc(s.id)}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`
    return (manage ? `<div class="assign-box"><div class="sec-title">On duty today</div><div class="duty">${this.staff.map((s) => `<label class="check"><input type="checkbox" data-duty="${esc(s.id)}" ${this.onDuty.has(s.id) ? 'checked' : ''}> ${esc(s.name)} <small class="muted">${byPerson.get(s.id) ?? 0} cr</small></label>`).join('')}</div>
        <div class="actions"><button type="button" class="btn primary" data-hk="assign">Assign ${unassigned} unassigned</button><button type="button" class="btn" data-hk="rebalance">Rebalance all</button><button type="button" class="btn" data-hk="public">Add public-area task…</button></div></div>` : '')
      + (inspect && toInspect.length ? `<div class="sec-title">Waiting for inspection <span>${toInspect.length}</span></div>` + toInspect.map((t) => `<div class="row-card"><div class="rc-title">Room ${esc(t.room_no ?? t.area ?? '')} · ${esc(TASK[t.kind] ?? t.kind)}</div>
          <div class="rc-sub">${esc(t.attendant ?? '')} · ${t.started_at && t.finished_at ? `${Math.round((new Date(t.finished_at).getTime() - new Date(t.started_at).getTime()) / 60000)} min` : ''}${t.photos.length ? ` · ${t.photos.length} photo${t.photos.length > 1 ? 's' : ''}` : ''}${t.notes ? ` · “${esc(t.notes)}”` : ''}</div>
          <div class="rc-right"><button type="button" class="btn small primary" data-inspect="${esc(t.id)}">Inspect</button></div></div>`).join('') : '')
      + `<div class="sec-title">All tasks today <span>${this.tasks.length}</span></div>
      <div class="m-table">${this.tasks.map((t) => `<div class="m-row hk-task-row"><b>${esc(t.room_no ?? t.area ?? '')}</b><span>${esc(TASK[t.kind] ?? t.kind)}</span>
        <span>${tonePill(...TASK_STATE[t.status])}${t.status === 'in_progress' && t.started_at ? ` <small>${minutes(t.started_at)} min</small>` : ''}${t.score != null ? ` <small>${t.score}</small>` : ''}</span>
        ${manage && ['pending', 'reclean'].includes(t.status) ? `<select data-reassign="${esc(t.id)}" aria-label="Attendant">${opt(t.assigned_to)}</select>` : `<span class="muted small">${esc(t.attendant ?? '—')}</span>`}</div>`).join('') || '<div class="empty">No tasks today.</div>'}</div>`
  }

  mounted(root: HTMLElement) { hydratePhotos(this.h.api, root) }

  async click(t: HTMLElement): Promise<boolean> {
    const api = this.h.api, modal = this.h.modal
    const act = t.closest<HTMLElement>('[data-hk]')?.dataset.hk
    if (act === 'assign' || act === 'rebalance') {
      const r = await api.post<{ assigned: number; workload: { name: string; credits: number }[] }>('/api/hk/assign', { attendants: [...this.onDuty], rebalance: act === 'rebalance' })
      toast(`${r.assigned} rooms assigned: ${r.workload.map((w) => `${w.name} ${w.credits}`).join(', ')} credits`)
      await this.load(); return true
    }
    if (act === 'public') {
      const areas = await api.get<{ name: string; active: boolean }[]>('/api/hk/areas')
      modal.open('Public-area task', `<div class="form-grid"><label class="span2">Area<select name="area">${areas.filter((a) => a.active).map((a) => `<option>${esc(a.name)}</option>`).join('')}</select></label>
        <label class="span2">Attendant<select name="who"><option value="">Unassigned</option>${this.staff.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label></div>`, 'Add', async (f) => {
        await api.post('/api/hk/tasks', { area: val(f, 'area'), kind: 'public_area', assignedTo: val(f, 'who') || undefined })
        await this.load(); this.h.render(); return 'Task added'
      })
      return false
    }
    const ins = t.closest<HTMLElement>('[data-inspect]')?.dataset.inspect
    if (ins) {
      const task = this.tasks.find((x) => x.id === ins)!
      modal.open(`Inspect room ${task.room_no ?? task.area}`, `<p class="muted small">${task.checklist.filter((c) => c.done).length} of ${task.checklist.length} checklist items ticked by ${esc(task.attendant ?? '')}.${task.notes ? ` Note: “${esc(task.notes)}”` : ''}</p>
        ${task.photos.length ? `<div class="photos">${task.photos.map((p) => `<img data-upload="${esc(p)}" alt="Cleaning photo">`).join('')}</div>` : ''}
        <div class="form-grid"><label>Score (pass at 80)<input name="score" type="number" min="0" max="100" value="90"></label><label class="span2">What needs re-cleaning (if any)<input name="notes" maxlength="300"></label></div>`, 'Save inspection', async (f) => {
        const r = await api.post<{ pass: boolean }>(`/api/hk/tasks/${ins}/inspect`, { score: Number(val(f, 'score')), notes: val(f, 'notes') || undefined })
        await this.load(); this.h.render()
        return r.pass ? 'Passed: the room is ready for reception' : 'Sent back for re-cleaning'
      })
      hydratePhotos(api, modal.el)
      return false
    }
    return false
  }

  async change(t: HTMLElement): Promise<boolean> {
    const duty = t.getAttribute('data-duty')
    if (duty) { if ((t as HTMLInputElement).checked) this.onDuty.add(duty); else this.onDuty.delete(duty); return false }
    const re = t.getAttribute('data-reassign')
    if (re) { await this.h.api.req('PATCH', `/api/hk/tasks/${re}`, { assignedTo: (t as HTMLSelectElement).value || null }); await this.load(); return true }
    return false
  }
}
