import { esc, tonePill } from '../ui/dom'
import { chips } from '../fnb/common'
import { HK, minutes, roomActions, TASK, TASK_STATE, type HkHost, type Room } from './common'

// The room board: every room's housekeeping state, by section, with the day's task and who has it.

type Filter = 'all' | 'dirty' | 'ready' | 'occupied' | 'ooo' | 'dnd' | 'alerts'
const MATCH: Record<Filter, (r: Room) => boolean> = {
  all: () => true,
  dirty: (r) => r.status === 'vacant_dirty' || r.status === 'occupied_dirty',
  ready: (r) => r.status === 'inspected' || r.status === 'vacant_clean',
  occupied: (r) => r.status.startsWith('occupied'),
  ooo: (r) => r.status === 'out_of_order' || r.status === 'out_of_service',
  dnd: (r) => r.dnd,
  alerts: (r) => !!r.discrepancy || (r.arriving != null && !['inspected', 'vacant_clean'].includes(r.status)),
}

export class BoardView {
  filter: Filter = 'all'
  constructor(private h: HkHost) {}

  async load() { await this.h.loadRooms() }

  html() {
    const rooms = this.h.rooms
    const count = (f: Filter) => rooms.filter(MATCH[f]).length
    const filters: [Filter, string][] = [['all', `All ${rooms.length}`], ['dirty', `Dirty ${count('dirty')}`], ['ready', `Ready ${count('ready')}`], ['occupied', `Occupied ${count('occupied')}`],
      ['ooo', `Out of order ${count('ooo')}`], ['dnd', `DND ${count('dnd')}`], ['alerts', `Needs attention ${count('alerts')}`]]
    const shown = rooms.filter(MATCH[this.filter])
    const sections = [...new Set(shown.map((r) => r.section))]
    return chips(filters, this.filter, 'hkf') + sections.map((sec) => `<div class="sec-title">${esc(sec)}</div><div class="hk-grid">${shown.filter((r) => r.section === sec).map((r) => {
      const t = r.task
      return `<button type="button" class="hk-room" data-room="${esc(r.space_id)}" data-st="${r.status}" style="--c: var(${HK[r.status][1]})">
        <b>${esc(r.room_no)}</b>
        <span class="hk-st">${esc(HK[r.status][0])}${r.dnd ? ' · DND' : ''}</span>
        ${r.arriving && !r.in_house ? '<em class="hk-arr">Arrival today</em>' : r.departing ? '<em class="hk-arr">Leaving today</em>' : ''}
        ${t ? `<span class="hk-task">${esc(TASK[t.kind] ?? t.kind)} · ${esc(TASK_STATE[t.status]?.[0] ?? t.status)}${t.attendant ? ` · ${esc(t.attendant.split(' ')[0])}` : ''}${t.status === 'in_progress' && t.startedAt ? ` · ${minutes(t.startedAt)} min` : ''}</span>` : ''}
        ${r.discrepancy ? tonePill(r.discrepancy === 'skipper' ? 'Skipper?' : 'Sleeper?', '--st-departing') : ''}
      </button>`
    }).join('')}</div>`).join('') + (shown.length ? '' : '<div class="empty">No rooms in this view.</div>')
  }

  async click(t: HTMLElement): Promise<boolean> {
    const f = t.closest<HTMLElement>('[data-hkf]')?.dataset.hkf as Filter | undefined
    if (f) { this.filter = f; return true }
    const id = t.closest<HTMLElement>('[data-room]')?.dataset.room
    if (id) { await roomActions(this.h, this.h.rooms.find((r) => r.space_id === id)!); return false }
    return false
  }
}
