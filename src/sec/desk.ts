import { esc, toast, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { hydratePhotos, takePhoto, uploadPhoto } from '../ui/photo'
import { toolbar, type Action } from '../ui/toolbar'
import type { WorkspaceHost } from '../ui/workspace'
import { placeField, readPlace, spaceList, time, when } from './common'

// Incidents (anyone reports; security closes), the key register, CCTV cameras, and emergency mode.

interface Incident { id: string; kind: string; severity: string; title: string; detail: string | null; space: string | null; photos: string[]; police_informed: boolean; reported_by_name: string; at: string; status: string; action_taken: string | null; closed_by_name: string | null }
export const INCIDENT: Record<string, string> = { theft: 'Theft / missing item', injury: 'Injury', fire: 'Fire / smoke', fight: 'Fight / disturbance', damage: 'Damage', trespass: 'Trespass', guest_complaint: 'Guest complaint', lost_child: 'Lost child', other: 'Other' }
const SEV: Record<string, [string, string]> = { critical: ['Critical', '--st-departing'], high: ['High', '--st-departing'], medium: ['Medium', '--marigold'], low: ['Low', '--muted'] }

/** The incident form, used from the security workspace and anywhere else. */
export async function reportIncident(h: WorkspaceHost, done?: () => void) {
  const list = await spaceList(h)
  let photos: string[] = []
  h.modal.open('Report an incident', `<div class="form-grid">
      <label>What<select name="kind">${Object.entries(INCIDENT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label>How serious<select name="severity"><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical: danger now</option><option value="low">Low</option></select></label>
      <label class="span2">In a line<input name="title" maxlength="120" placeholder="e.g. Guest's phone missing from the poolside"></label>
      <label class="span2">What happened<textarea name="detail" rows="3" maxlength="1000"></textarea></label>
      ${placeField(list)}<label class="check"><input type="checkbox" name="police"> Police informed</label></div>
    <div class="actions"><button type="button" class="btn" data-photo>Add a photo</button><span class="muted small" data-photo-state></span></div>
    <p class="muted small">For danger to people now, also press SOS or call security.</p>`, 'Report', async (f) => {
    const photoIds: string[] = []
    for (const p of photos) photoIds.push(await uploadPhoto(h.api, 'incident', p))
    await h.api.post('/api/security/incidents', { kind: val(f, 'kind'), severity: val(f, 'severity'), title: val(f, 'title'), detail: val(f, 'detail') || undefined, policeInformed: checked(f, 'police'), photoIds, ...(await readPlace(f)) })
    done?.()
    return 'Incident reported to security'
  })
  h.modal.el.querySelector('[data-photo]')!.addEventListener('click', async () => {
    const p = await takePhoto()
    if (p) photos = [...photos, p].slice(0, 6)
    h.modal.el.querySelector('[data-photo-state]')!.textContent = photos.length ? `${photos.length} photo${photos.length > 1 ? 's' : ''}` : ''
  })
}

export class IncidentsView {
  private list: Incident[] = []
  private status: 'open' | 'closed' = 'open'
  constructor(private h: WorkspaceHost) {}

  async load() { this.list = await this.h.cached(`/api/security/incidents?status=${this.status}`) }

  html() {
    const chip = (s: string, label: string) => `<button type="button" class="chip" data-is="${s}" aria-pressed="${this.status === s}">${label}</button>`
    return `${toolbar({ primary: [{ attrs: 'data-ic="new"', label: 'Report an incident' }], filters: `<div class="chips">${chip('open', 'Open')}${chip('closed', 'Closed')}</div>` })}
      ${this.list.map((i) => `<div class="row-card" data-ticket="${esc(i.id)}"><div class="rc-title">${esc(i.title)}</div>
        <div class="rc-sub">${esc(INCIDENT[i.kind] ?? i.kind)}${i.space ? ` · ${esc(i.space)}` : ''} · ${when(i.at)} · ${esc(i.reported_by_name)}${i.police_informed ? ' · police informed' : ''}</div>
        <div class="rc-right">${tonePill(...(SEV[i.severity] ?? [i.severity, '--muted']))}</div></div>`).join('') || '<div class="empty">No incidents.</div>'}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const s = el.closest<HTMLElement>('[data-is]')?.dataset.is as 'open' | 'closed' | undefined
    if (s) { this.status = s; await this.load(); return true }
    if (el.closest('[data-ic=new]')) { await reportIncident(this.h, () => void this.load().then(() => this.h.render())); return false }
    const id = el.closest<HTMLElement>('[data-ticket]')?.dataset.ticket
    if (id) this.open(id)
    return false
  }

  open(id: string) {
    const i = this.list.find((x) => x.id === id)
    if (!i) return
    const canClose = i.status === 'open' && this.h.can('security.manage')
    this.h.modal.open(i.title, `<div class="room-head">${tonePill(...(SEV[i.severity] ?? [i.severity, '--muted']))}${tonePill(i.status === 'open' ? 'Open' : 'Closed', i.status === 'open' ? '--st-arriving' : '--muted')}</div>
      <dl class="kv"><dt>What</dt><dd>${esc(INCIDENT[i.kind] ?? i.kind)}</dd>${i.space ? `<dt>Where</dt><dd>${esc(i.space)}</dd>` : ''}<dt>When</dt><dd>${when(i.at)}</dd><dt>Reported by</dt><dd>${esc(i.reported_by_name)}</dd>
        ${i.detail ? `<dt>Detail</dt><dd>${esc(i.detail)}</dd>` : ''}<dt>Police</dt><dd>${i.police_informed ? 'Informed' : 'No'}</dd>
        ${i.action_taken ? `<dt>Action</dt><dd>${esc(i.action_taken)} (${esc(i.closed_by_name ?? '')})</dd>` : ''}</dl>
      ${i.photos.length ? `<div class="photos">${i.photos.map((p) => `<img data-upload="${esc(p)}" alt="Incident photo">`).join('')}</div>` : ''}
      ${canClose ? '<div class="form-grid"><label class="span2">Action taken (to close)<textarea name="action" rows="2" maxlength="500"></textarea></label><label class="check span2"><input type="checkbox" name="police"> Police informed</label></div>' : ''}`,
    canClose ? 'Close incident' : 'Done', async (f) => {
      if (!canClose) return ''
      await this.h.api.post(`/api/security/incidents/${i.id}/close`, { actionTaken: val(f, 'action'), policeInformed: checked(f, 'police') || undefined })
      await this.load(); this.h.render(); return 'Incident closed'
    })
    hydratePhotos(this.h.api, this.h.modal.el)
  }
}

interface Key { id: string; label: string; kind: string; active: boolean; log_id: string | null; issued_to: string | null; out_at: string | null; due_back: string | null; issued_by: string | null; overdue: boolean }

export class KeysView {
  private list: Key[] = []
  private people: { id: string; name: string }[] = []
  constructor(private h: WorkspaceHost) {}

  async load() { this.list = await this.h.cached('/api/security/keys') }

  html() {
    const out = this.list.filter((k) => k.log_id)
    return `${toolbar({ primary: this.h.can('security.manage') ? [{ attrs: 'data-ky="add"', label: 'Add key' }] : [], end: `<span class="muted small">${out.length} out · ${out.filter((k) => k.overdue).length} overdue</span>` })}
      ${this.list.filter((k) => k.active).map((k) => `<div class="row-card${k.overdue ? ' late' : ''}"><div class="rc-title">🔑 ${esc(k.label)}</div>
        <div class="rc-sub">${k.log_id ? `With <b>${esc(k.issued_to ?? '')}</b> since ${time(k.out_at!)}${k.due_back ? ` · back by ${time(k.due_back)}` : ''}${k.overdue ? ' · <span class="fd-warn">overdue</span>' : ''}` : 'In the key box'}</div>
        <div class="rc-right">${this.h.can('security.gate') ? (k.log_id ? `<button type="button" class="btn small" data-ky="back:${esc(k.id)}">Returned</button>` : `<button type="button" class="btn small" data-ky="out:${esc(k.id)}">Issue…</button>`) : ''}</div></div>`).join('') || '<div class="empty">No keys registered.</div>'}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-ky]')?.dataset.ky
    if (!a) return false
    const api = this.h.api, done = async (m: string) => { await this.load(); this.h.render(); return m }
    if (a === 'add') {
      this.h.modal.open('Add key', `<div class="form-grid"><label class="span2">Label<input name="label" maxlength="60" placeholder="e.g. Master key A, DG room, Bar store"></label>
        <label>Kind<select name="kind">${['master', 'room', 'store', 'plant', 'vehicle', 'other'].map((k) => `<option>${k}</option>`).join('')}</select></label></div>`, 'Add', async (f) => {
        await api.post('/api/security/keys', { label: val(f, 'label'), kind: val(f, 'kind') }); return done('Key added')
      })
      return false
    }
    const [act, id] = a.split(':')
    if (act === 'back') { await api.post(`/api/security/keys/${id}/return`); await this.load(); toast('Key back in the box'); return true }
    if (!this.people.length) this.people = await api.get('/api/security/people')
    const k = this.list.find((x) => x.id === id)!
    this.h.modal.open(`Issue: ${k.label}`, `<div class="form-grid"><label class="span2">To (staff)<select name="user"><option value="">— someone else —</option>${this.people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <label class="span2">Or name (contractor, vendor)<input name="to" maxlength="60"></label><label>Back within (hours)<input name="hours" type="number" min="0.25" step="0.25" value="2"></label>
      <label class="span2">Why<input name="note" maxlength="120"></label></div>`, 'Issue', async (f) => {
      await api.post(`/api/security/keys/${id}/issue`, { userId: val(f, 'user') || undefined, issuedTo: val(f, 'to') || undefined, hours: val(f, 'hours') ? Number(val(f, 'hours')) : undefined, note: val(f, 'note') || undefined })
      return done('Key issued')
    })
    return false
  }
}

interface Camera { id: string; name: string; space: string | null; space_id: string | null; channel: string | null; view_url: string | null; active: boolean }

export class CamerasView {
  private list: Camera[] = []
  constructor(private h: WorkspaceHost) {}

  async load() { this.list = await this.h.cached('/api/security/cameras') }

  html() {
    return `${toolbar({ primary: this.h.can('security.manage') ? [{ attrs: 'data-cm="add"', label: 'Add camera' }] : [] })}
      <p class="muted small">Tap a camera pin on the 3D map (Security layer) to open its live view.</p>
      ${this.list.filter((c) => c.active).map((c) => `<div class="row-card"><div class="rc-title">📹 ${esc(c.name)}</div><div class="rc-sub">${esc([c.space, c.channel && `channel ${c.channel}`].filter(Boolean).join(' · ') || '—')}</div>
        <div class="rc-right">${c.view_url ? `<button type="button" class="btn small" data-cm="view:${esc(c.id)}">Live view</button>` : '<span class="muted small">no live view set</span>'}${this.h.can('security.manage') ? `<button type="button" class="btn small" data-cm="edit:${esc(c.id)}">Edit</button>` : ''}</div></div>`).join('') || '<div class="empty">No cameras yet.</div>'}`
  }

  /** Opens the NVR's own page for the camera (signed in there, not here). */
  view(id: string) {
    const c = this.list.find((x) => x.id === id)
    if (c?.view_url) window.open(c.view_url, '_blank', 'noopener')
    else toast('No live view address for this camera yet.')
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-cm]')?.dataset.cm
    if (!a) return false
    if (a.startsWith('view:')) { this.view(a.slice(5)); return false }
    const c = a.startsWith('edit:') ? this.list.find((x) => x.id === a.slice(5)) : undefined
    const list = await spaceList(this.h)
    this.h.modal.open(c ? c.name : 'Add camera', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="60" value="${esc(c?.name ?? '')}" placeholder="e.g. Main gate, Lobby, Pool deck"></label>
      ${placeField(list, 'Where', c?.space_id)}<label>NVR channel<input name="channel" maxlength="10" value="${esc(c?.channel ?? '')}"></label>
      <label class="span2">Live view address (NVR web page or HLS)<input name="url" type="url" maxlength="300" value="${esc(c?.view_url ?? '')}" placeholder="https://nvr.local/view?ch=1"></label>
      ${c ? `<label class="check span2"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> In use</label>` : ''}</div>
      <p class="muted small">Leave out user names and passwords: guards sign in on the NVR page itself. Stand under the camera and leave “Where” on GPS to pin it exactly.</p>`, c ? 'Save' : 'Add', async (f) => {
      const body = { name: val(f, 'name'), channel: val(f, 'channel') || undefined, viewUrl: val(f, 'url') || null, ...(await readPlace(f)), ...(c ? { active: checked(f, 'active') } : {}) }
      if (c) await this.h.api.req('PATCH', `/api/security/cameras/${c.id}`, body)
      else await this.h.api.post('/api/security/cameras', body)
      await this.load(); this.h.render(); return 'Saved'
    })
    return false
  }
}

export interface Emergency {
  active: { id: string; kind: string; note: string | null; started_at: string; started_by: string } | null
  points: { id: string; name: string }[]; mine?: { status: string | null } | null
  people?: { user_id: string; name: string; roles: string | null; on_duty: boolean; status: string | null; at: string | null; point: string | null; marked_by: string | null; last_place: string | null }[]
  counts?: { total: number; safe: number; needHelp: number; missing: number }
}
export const EMERGENCY: Record<string, string> = { fire: 'Fire', evacuation: 'Evacuation', lockdown: 'Lockdown', medical: 'Medical emergency', other: 'Emergency' }

export class EmergencyView {
  private e: Emergency | null = null
  private history: { id: string; kind: string; started_at: string; ended_at: string | null; started_by_name: string; summary: string | null; people: number; safe: number }[] = []
  constructor(private h: WorkspaceHost) {}

  async load() {
    this.e = await this.h.api.get('/api/security/emergency')
    this.history = this.h.can('security.view', 'emergency.start') ? await this.h.api.get('/api/security/emergency/history') : []
  }

  html() {
    const e = this.e!
    const manage = this.h.can('security.manage'), starter = this.h.can('emergency.start')
    const points = `<div class="sec-title">Assembly points <span>${e.points.length}</span></div>
      ${e.points.map((p) => `<div class="row-card"><div class="rc-title">🟢 ${esc(p.name)}</div></div>`).join('') || '<div class="empty">No assembly points set.</div>'}`
    const addPoint: Action[] = manage ? [{ attrs: 'data-em="point"', label: 'Add assembly point' }] : []
    if (!e.active) {
      return `${toolbar({ primary: starter ? [{ attrs: 'data-em="start"', label: 'Start emergency', danger: true }] : [], more: addPoint })}
        ${starter ? '<p class="muted small">Every phone shows the alarm; everyone on duty must answer the roll-call.</p>' : ''}
        ${points}
        ${this.history.length ? `<div class="sec-title">Past emergencies</div>${this.history.map((x) => `<div class="row-card"><div class="rc-title">${esc(EMERGENCY[x.kind] ?? x.kind)} · ${when(x.started_at)}</div>
          <div class="rc-sub">${x.safe}/${x.people} accounted for · started by ${esc(x.started_by_name)}${x.summary ? ` · ${esc(x.summary)}` : ''}</div></div>`).join('')}` : ''}`
    }
    const c = e.counts
    const status = (s: string | null) => s === 'safe' ? tonePill('Safe', '--st-vacant') : s === 'need_help' ? tonePill('Needs help', '--st-departing') : tonePill('Not answered', '--marigold')
    const warden = this.h.can('security.gate', 'staff.track', 'emergency.start')
    return `<div class="em-head"><b>${esc(EMERGENCY[e.active.kind] ?? 'Emergency')}</b> since ${time(e.active.started_at)} · ${esc(e.active.started_by)}${e.active.note ? ` · ${esc(e.active.note)}` : ''}</div>
      ${toolbar({
        primary: [{ attrs: 'data-em="safe"', label: 'I am safe' }, { attrs: 'data-em="help"', label: 'I need help', primary: false, danger: true }],
        more: [...addPoint, ...(starter ? [{ attrs: 'data-em="end"', label: 'End the emergency', danger: true }] : [])],
        end: e.mine?.status ? `<span class="muted small">You: ${status(e.mine.status)}</span>` : '',
      })}
      ${c ? `<div class="kpi-mini"><div><b>${c.safe}/${c.total}</b><span>safe</span></div><div><b class="fd-warn">${c.needHelp}</b><span>need help</span></div><div><b>${c.missing}</b><span>not answered</span></div></div>
        ${e.people!.map((p) => `<div class="row-card${p.status === 'need_help' ? ' late' : ''}"><div class="rc-title">${esc(p.name)}<small class="muted"> ${esc((p.roles ?? '').replace(/_/g, ' '))}</small></div>
          <div class="rc-sub">${p.status ? `${time(p.at!)}${p.point ? ` · at ${esc(p.point)}` : ''}${p.marked_by ? ` · marked by ${esc(p.marked_by)}` : ''}` : `Last seen: ${esc(p.last_place ?? 'unknown')}`}${p.on_duty ? '' : ' · off duty'}</div>
          <div class="rc-right">${status(p.status)}${warden && p.status !== 'safe' ? `<button type="button" class="btn small" data-em="mark:${esc(p.user_id)}">Seen safe</button>` : ''}</div></div>`).join('')}` : ''}
      ${points}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-em]')?.dataset.em
    if (!a) return false
    const api = this.h.api, done = async (m: string) => { await this.load(); this.h.render(); return m }
    if (a === 'start') {
      this.h.modal.open('Start emergency', `<div class="form-grid"><label class="span2">What<select name="kind">${Object.entries(EMERGENCY).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="span2">Where / what to do<input name="note" maxlength="200" placeholder="e.g. Smoke in the kitchen: evacuate the main block"></label></div>
        <p class="muted small">Every signed-in screen and phone shows the alarm with the assembly points. Start it only for a real emergency or a planned drill (say “drill”).</p>`, 'Start emergency', async (f) => {
        await api.post('/api/security/emergency', { kind: val(f, 'kind'), note: val(f, 'note') || undefined }); return done('Emergency started')
      })
      return false
    }
    if (a === 'end') {
      this.h.modal.open('End emergency', `<div class="form-grid"><label class="span2">What happened, and is everyone accounted for?<textarea name="summary" rows="3" maxlength="1000"></textarea></label></div>`, 'End emergency', async (f) => {
        const r = await api.post<{ unaccounted: number }>('/api/security/emergency/end', { summary: val(f, 'summary') })
        return done(r.unaccounted ? `Ended with ${r.unaccounted} not answered: follow up with each of them.` : 'Emergency ended')
      })
      return false
    }
    if (a === 'point') {
      const list = await spaceList(this.h)
      this.h.modal.open('Add assembly point', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="60" placeholder="e.g. Grand Lawn, near the main gate"></label>${placeField(list, 'Where')}</div>`, 'Add', async (f) => {
        await api.post('/api/security/assembly-points', { name: val(f, 'name'), ...(await readPlace(f)) }); return done('Assembly point added')
      })
      return false
    }
    if (a === 'safe' || a === 'help') {
      const e = this.e!
      if (a === 'safe' && e.points.length) {
        this.h.modal.open('I am safe', `<div class="form-grid"><label class="span2">Where are you?<select name="point"><option value="">Somewhere else</option>${e.points.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label></div>`, 'I am safe', async (f) => {
          await this.h.outbox.send('POST', '/api/security/emergency/check', { status: 'safe', pointId: val(f, 'point') || undefined }, 'roll-call'); return done('Marked safe')
        })
        return false
      }
      await this.h.outbox.send('POST', '/api/security/emergency/check', { status: a === 'safe' ? 'safe' : 'need_help' }, 'roll-call')
      toast(a === 'safe' ? 'Marked safe' : 'Security has been told you need help')
      await this.load(); return true
    }
    if (a.startsWith('mark:')) { await api.post('/api/security/emergency/check', { status: 'safe', userId: a.slice(5) }); await this.load(); return true }
    return false
  }
}
