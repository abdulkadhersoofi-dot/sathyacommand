import { esc, toast, tonePill } from '../ui/dom'
import { toolbar } from '../ui/toolbar'
import { hydratePhotos, takePhoto, uploadPhoto } from '../ui/photo'
import { foundItem, minutes, roomActions, TASK, TASK_STATE, type HkHost, type HkStatus } from './common'

// The attendant's phone: my rooms in order, start, tick the checklist, photos, finish.

export interface HkTask {
  id: string; space_id: string | null; room_no: string | null; area: string | null; kind: string; credits: string; priority: number; status: string; attendant: string | null
  assigned_to: string | null; started_at: string | null; finished_at: string | null; checklist: { item: string; done: boolean }[]; photos: string[]; notes: string | null
  score: number | null; inspection_notes: string | null; section: string | null; dnd: boolean | null; room_status: HkStatus | null; guest: string | null
}

export class MineView {
  private tasks: HkTask[] = []
  private open: string | null = null
  private ticks = new Map<string, boolean[]>()
  private photos = new Map<string, string[]>()

  constructor(private h: HkHost) {}

  async load() {
    this.tasks = await this.h.cached(`/api/hk/tasks?mine=true`)
    await this.h.loadRooms()
    const active = this.tasks.find((t) => t.status === 'in_progress')
    if (active) this.open = active.id
  }

  html() {
    const todo = this.tasks.filter((t) => ['pending', 'in_progress', 'reclean'].includes(t.status))
    const done = this.tasks.filter((t) => ['cleaned', 'inspected'].includes(t.status))
    const credits = todo.reduce((a, t) => a + Number(t.credits), 0)
    const waiting = this.h.rooms.filter((r) => r.task && ['pending', 'reclean'].includes(r.task.status) && !r.task.attendant && !this.tasks.some((t) => t.id === r.task!.id))
    const card = (t: HkTask) => {
      const isOpen = this.open === t.id && t.status === 'in_progress'
      const ticks = this.ticks.get(t.id) ?? t.checklist.map((c) => c.done)
      const head = `<div class="mine-head"><b>${t.room_no ? `Room ${esc(t.room_no)}` : esc(t.area ?? '')}</b> ${tonePill(...TASK_STATE[t.status])}${t.dnd ? tonePill('DND', '--god') : ''}</div>
        <div class="muted small">${esc(TASK[t.kind] ?? t.kind)}${t.guest ? ` · ${esc(t.guest)}` : ''}${t.status === 'in_progress' && t.started_at ? ` · ${minutes(t.started_at)} min` : ''}${t.status === 'reclean' && t.inspection_notes ? ` · <b>${esc(t.inspection_notes)}</b>` : ''}</div>`
      if (!isOpen) {
        return `<div class="mine-card">${head}<div class="actions">
          ${['pending', 'reclean'].includes(t.status) ? `<button type="button" class="btn primary" data-start="${esc(t.id)}">Start</button>` : ''}
          ${t.status === 'in_progress' ? `<button type="button" class="btn primary" data-openTask="${esc(t.id)}">Continue</button>` : ''}
          ${t.space_id ? `<button type="button" class="btn" data-roomact="${esc(t.space_id)}">Open the room…</button>` : ''}</div></div>`
      }
      const ph = this.photos.get(t.id) ?? []
      return `<div class="mine-card open">${head}
        <ul class="checklist">${t.checklist.map((c, i) => `<li><label><input type="checkbox" data-tick="${esc(t.id)}:${i}" ${ticks[i] ? 'checked' : ''}> ${esc(c.item)}</label></li>`).join('')}</ul>
        <div class="photos">${ph.map((p) => `<img data-upload="${esc(p)}" alt="Room photo">`).join('')}<button type="button" class="btn" data-photo="${esc(t.id)}">📷 Photo</button></div>
        <label class="note-in">Note (anything not done, damage, maintenance needed)<input name="note_${esc(t.id)}" maxlength="300"></label>
        <div class="actions"><button type="button" class="btn primary" data-finish="${esc(t.id)}">Finished</button>${t.space_id ? `<button type="button" class="btn" data-roomact="${esc(t.space_id)}">Room…</button>` : ''}</div></div>`
    }
    return `${toolbar({ primary: [{ attrs: 'data-mine="found"', label: 'Found an item' }], end: `<span class="muted">${todo.length} to do · ${credits} credits</span>` })}
      ${todo.map(card).join('') || '<div class="empty">Nothing assigned to you right now.</div>'}
      ${waiting.length ? `<div class="sec-title">Waiting for anyone <span>${waiting.length}</span></div><p class="muted small">Nobody has been given these rooms. Tap one and start; it becomes yours.</p>
        <div class="hk-grid">${waiting.map((r) => `<button type="button" class="hk-room" data-roomact="${esc(r.space_id)}" data-st="${r.status}" style="--c: var(--st-dirty)"><b>${esc(r.room_no)}</b><span class="hk-st">${esc(TASK[r.task!.kind] ?? r.task!.kind)}</span><span class="muted small">${esc(r.section)}${r.task!.status === 'reclean' ? ' · clean it again' : ''}</span></button>`).join('')}</div>` : ''}
      ${done.length ? `<div class="sec-title">Done today <span>${done.length}</span></div>` + done.map((t) => `<div class="row-card"><div class="rc-title">${t.room_no ? `Room ${esc(t.room_no)}` : esc(t.area ?? '')} · ${esc(TASK[t.kind] ?? t.kind)}</div>
        <div class="rc-sub">${t.started_at && t.finished_at ? `${Math.round((new Date(t.finished_at).getTime() - new Date(t.started_at).getTime()) / 60000)} min` : ''}${t.score != null ? ` · score ${t.score}` : ''}</div>
        <div class="rc-right">${tonePill(...TASK_STATE[t.status])}</div></div>`).join('') : ''}`
  }

  mounted(root: HTMLElement) { hydratePhotos(this.h.api, root) }

  async click(t: HTMLElement): Promise<boolean> {
    const api = this.h.api
    const get = (k: string) => t.closest<HTMLElement>(`[data-${k}]`)?.getAttribute(`data-${k}`) ?? undefined
    const start = get('start')
    if (start) {
      const r = await this.h.outbox.send('POST', `/api/hk/tasks/${start}/start`, {}, 'start cleaning')
      if (!r) toast('No connection: started on this phone, it syncs when back on Wi-Fi.')
      this.open = start
      const task = this.tasks.find((x) => x.id === start)!
      task.status = 'in_progress'; task.started_at = new Date().toISOString()
      if (r) await this.load()
      return true
    }
    const o = get('opentask'); if (o) { this.open = o; return true }
    const ra = get('roomact')
    if (ra) { const room = this.h.rooms.find((x) => x.space_id === ra); if (room) await roomActions(this.h, room); return false }
    const ph = get('photo')
    if (ph) {
      const data = await takePhoto()
      if (!data) return false
      const id = await uploadPhoto(api, 'hk', data)
      this.photos.set(ph, [...(this.photos.get(ph) ?? []), id])
      return true
    }
    const fin = get('finish')
    if (fin) {
      const task = this.tasks.find((x) => x.id === fin)!
      const ticks = this.ticks.get(fin) ?? task.checklist.map((c) => c.done)
      const note = t.closest('.mine-card')!.querySelector<HTMLInputElement>('input[name^="note_"]')?.value.trim() ?? ''
      const checklist = task.checklist.map((c, i) => ({ item: c.item, done: !!ticks[i] }))
      if (checklist.some((c) => !c.done) && !note) { toast('Tick every item, or write a note saying what was not done.'); return false }
      const r = await this.h.outbox.send<{ minutes: number }>('POST', `/api/hk/tasks/${fin}/finish`, { checklist, photos: this.photos.get(fin) ?? [], notes: note || undefined }, `finish room ${task.room_no ?? task.area}`)
      toast(r ? `Room ${task.room_no ?? task.area} done in ${r.minutes} min. Waiting for inspection.` : 'No connection: saved on this phone, it syncs when back on Wi-Fi.')
      this.open = null; this.ticks.delete(fin); this.photos.delete(fin)
      if (r) await this.load(); else task.status = 'cleaned'
      return true
    }
    if (get('mine') === 'found') { await foundItem(this.h, null, ''); return false }
    return false
  }

  async change(t: HTMLElement): Promise<boolean> {
    const tick = t.getAttribute('data-tick')
    if (!tick) return false
    const [id, i] = tick.split(':')
    const task = this.tasks.find((x) => x.id === id)!
    const ticks = this.ticks.get(id) ?? task.checklist.map((c) => c.done)
    ticks[Number(i)] = (t as HTMLInputElement).checked
    this.ticks.set(id, ticks)
    return false
  }
}
