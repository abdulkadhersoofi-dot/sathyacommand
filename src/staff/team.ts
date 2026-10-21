import { esc, toast, tonePill, showDate } from '../ui/dom'
import { val } from '../ui/form-modal'
import { hydratePhotos } from '../ui/photo'
import { t } from './i18n'
import type { StaffHost } from './today'

// The person's own attendance and location history; the team on duty, missing, and SOS alerts.

interface Att { id: string; user_id: string; name: string; day: string; shift: string | null; starts: string | null; clock_in_at: string; clock_out_at: string | null; late_minutes: number; selfie_id: string | null; minutes: number; roles: string | null }
interface Live { user_id: string; name: string; roles: string | null; at: string | null; source: string | null; inside: boolean | null; place: string | null; sos: boolean }
interface Sos { id: string; name: string; at: string; x: number | null; z: number | null; place: string | null; status: string; ack_by: string | null; note: string | null }
interface Absent { user_id: string; name: string; shift: string; starts: string }
const hhmm = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'
const hours = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
const SOURCE: Record<string, string> = { gps: 'GPS', beacon: 'Beacon', qr: 'QR scan' }

export class MyAttendanceView {
  private rows: Att[] = []
  private pings: { at: string; source: string; inside: boolean | null; place: string | null }[] = []
  constructor(private h: StaffHost) {}

  async load() {
    this.rows = await this.h.cached(`/api/staff/attendance?userId=${encodeURIComponent(this.h.me.id)}`)
    this.pings = await this.h.cached('/api/staff/my-locations')
  }

  html() {
    const total = this.rows.reduce((a, r) => a + r.minutes, 0)
    return `<div class="sec-title">${t('My attendance')} <span>${hours(total)}</span></div>
      <div class="m-table"><div class="m-row att-row head"><span>Day</span><span>Shift</span><span>In</span><span>Out</span><span>Hours</span></div>
      ${this.rows.slice().reverse().map((r) => `<div class="m-row att-row"><b>${esc(showDate(r.day))}</b><span>${esc(r.shift ?? '—')}</span>
        <span>${hhmm(r.clock_in_at)}${r.late_minutes ? ` <small class="fd-warn">+${r.late_minutes}m</small>` : ''}</span><span>${hhmm(r.clock_out_at)}</span><span class="mono">${hours(r.minutes)}</span></div>`).join('') || '<div class="empty">No attendance yet.</div>'}</div>
      <div class="sec-title">Where the app saw me today <span>${this.pings.length}</span></div>
      <p class="muted small">Only while on duty. Kept for 90 days.</p>
      ${this.pings.slice(-30).reverse().map((p) => `<div class="m-row ping-row"><span class="mono">${hhmm(p.at)}</span><span>${esc(SOURCE[p.source] ?? p.source)}</span><span>${esc(p.place ?? (p.inside === false ? 'Outside the resort' : p.inside ? 'In the resort' : ''))}</span></div>`).join('')}`
  }

  async click() { return false }
}

export class TeamView {
  private on: Live[] = []
  private absent: Absent[] = []
  private sos: Sos[] = []
  private today: Att[] = []
  constructor(private h: StaffHost & { showOnMap(userId: string): void }) {}

  async load() {
    const track = this.h.can('staff.track'), att = this.h.can('attendance.view')
    this.on = track ? await this.h.cached('/api/staff/live') : []
    this.sos = track ? await this.h.cached('/api/staff/sos') : []
    this.absent = att ? await this.h.cached('/api/staff/absent') : []
    this.today = att ? await this.h.cached('/api/staff/attendance') : []
  }

  html() {
    const sos = this.sos.map((s) => `<div class="row-card sos-card ${s.status}"><div class="rc-title">🚨 ${esc(s.name)} · ${hhmm(s.at)}</div>
      <div class="rc-sub">${esc(s.place ?? (s.x != null ? 'Located on the map' : 'Location not known'))} · ${s.status === 'acknowledged' ? `Taken by ${esc(s.ack_by ?? '')}` : 'Nobody has taken it yet'}</div>
      <div class="rc-right">${s.x != null ? `<button type="button" class="btn small" data-tm="map:${esc(s.id)}">Map</button>` : ''}${s.status === 'open' ? `<button type="button" class="btn small primary" data-tm="ack:${esc(s.id)}">I'm going</button>` : ''}<button type="button" class="btn small" data-tm="resolve:${esc(s.id)}">Resolve…</button></div></div>`).join('')
    const late = new Set(this.today.filter((a) => a.late_minutes).map((a) => a.user_id))
    return (sos ? `<div class="sec-title">SOS <span>${this.sos.length}</span></div>${sos}` : '')
      + (this.h.can('staff.track') ? `<div class="sec-title">On duty now <span>${this.on.length}</span></div>
      <div class="m-table">${this.on.map((p) => `<div class="m-row team-row"><b>${esc(p.name)}${p.sos ? ' 🚨' : ''}<small class="muted"> ${esc((p.roles ?? '').replace(/_/g, ' '))}</small></b>
        <span>${p.at ? `${esc(p.place ?? (p.inside === false ? 'Outside the resort' : SOURCE[p.source ?? ''] ?? ''))} · ${hhmm(p.at)}` : '<span class="muted">No location yet</span>'}</span>
        <span>${p.inside === false ? tonePill('Outside', '--st-departing') : late.has(p.user_id) ? tonePill('Late', '--marigold') : ''}</span>
        <button type="button" class="btn small" data-tm="who:${esc(p.user_id)}">Map</button></div>`).join('') || '<div class="empty">Nobody is clocked in.</div>'}</div>` : '')
      + (this.h.can('attendance.view') ? `<div class="sec-title">Rostered but not in <span>${this.absent.length}</span></div>
      ${this.absent.map((a) => `<div class="m-row team-row"><b>${esc(a.name)}</b><span>${esc(a.shift)} from ${esc(a.starts)}</span><span></span><span></span></div>`).join('') || '<div class="empty">Everyone rostered is in.</div>'}
      <div class="sec-title">Today's attendance <span>${this.today.length}</span></div>
      <div class="m-table"><div class="m-row att-row head"><span>Name</span><span>Shift</span><span>In</span><span>Out</span><span>Hours</span></div>
      ${this.today.map((r) => `<div class="m-row att-row"><b>${r.selfie_id ? `<img class="selfie" data-upload="${esc(r.selfie_id)}" alt="">` : ''}${esc(r.name)}</b><span>${esc(r.shift ?? '—')}</span>
        <span>${hhmm(r.clock_in_at)}${r.late_minutes ? ` <small class="fd-warn">+${r.late_minutes}m</small>` : ''}</span><span>${hhmm(r.clock_out_at)}</span><span class="mono">${hours(r.minutes)}</span></div>`).join('')}</div>` : '')
  }

  mounted(root: HTMLElement) { hydratePhotos(this.h.api, root) }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-tm]')?.dataset.tm
    if (!a) return false
    const [act, id] = a.split(':')
    if (act === 'who') { this.h.showOnMap(id); return false }
    if (act === 'map') { const s = this.sos.find((x) => x.id === id); const p = this.on.find((x) => x.name === s?.name); this.h.showOnMap(p?.user_id ?? ''); return false }
    if (act === 'ack') { await this.h.api.post(`/api/staff/sos/${id}/ack`); toast('Others can see you are going.'); await this.load(); return true }
    if (act === 'resolve') {
      this.h.modal.open('Resolve SOS', `<div class="form-grid"><label class="span2">What happened?<textarea name="note" rows="3" maxlength="300"></textarea></label></div>`, 'Resolve', async (f) => {
        await this.h.api.post(`/api/staff/sos/${id}/resolve`, { note: val(f, 'note') }); await this.load(); this.h.render(); return 'Resolved'
      })
    }
    return false
  }
}
