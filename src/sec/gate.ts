import { esc, toast, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { takePhoto, uploadPhoto } from '../ui/photo'
import { scanQr } from '../ui/qr-scan'
import type { WorkspaceHost } from '../ui/workspace'
import { currentFix } from '../staff/tracker'
import { placeField, readPlace, spaceList, time, when } from './common'

// The gate register (who and what is inside now, today's register) and guard patrols by QR checkpoint.

interface Entry {
  id: string; kind: string; name: string | null; mobile: string | null; vehicle_no: string | null; pax: number | null; purpose: string | null; host: string | null
  guest: string | null; room_no: string | null; tag_no: string | null; parking: string | null; in_at: string; out_at: string | null; in_by_name: string; note: string | null
}
const KIND: Record<string, string> = { guest_vehicle: 'Guest vehicle', visitor: 'Visitor', vendor: 'Vendor', delivery: 'Delivery', taxi: 'Taxi / cab', staff_vehicle: 'Staff vehicle' }

export class GateView {
  private inside: Entry[] = []
  private today: Entry[] = []
  constructor(private h: WorkspaceHost) {}

  async load() {
    this.inside = await this.h.cached('/api/security/gate?inside=1')
    this.today = (await this.h.cached<Entry[]>('/api/security/gate')).filter((e) => e.out_at)
  }

  private card(e: Entry, out: boolean) {
    const who = e.kind === 'guest_vehicle' ? `${e.guest ?? 'Guest'}${e.room_no ? ` · room ${e.room_no}` : ''}` : [e.name, e.purpose, e.host && `for ${e.host}`].filter(Boolean).join(' · ')
    return `<div class="row-card"><div class="rc-title">${e.vehicle_no ? `<span class="plate">${esc(e.vehicle_no)}</span> ` : ''}${esc(KIND[e.kind] ?? e.kind)}${e.tag_no ? ` · tag ${esc(e.tag_no)}` : ''}</div>
      <div class="rc-sub">${esc(who)} · in ${time(e.in_at)}${e.out_at ? ` · out ${time(e.out_at)}` : ''}${e.parking ? ` · parked ${esc(e.parking)}` : ''}${e.pax ? ` · ${e.pax} people` : ''}</div>
      <div class="rc-right">${out && this.h.can('security.gate') ? `<button type="button" class="btn small" data-gt="out:${esc(e.id)}">Out</button>` : ''}</div></div>`
  }

  html() {
    const cars = this.inside.filter((e) => e.vehicle_no).length
    return `<div class="ws-toolbar">${this.h.can('security.gate') ? '<button type="button" class="btn primary" data-gt="in">Entry at the gate</button>' : ''}
        <span class="muted small">${this.inside.length} inside now · ${cars} vehicle${cars === 1 ? '' : 's'}</span></div>
      <div class="sec-title">Inside now <span>${this.inside.length}</span></div>
      ${this.inside.map((e) => this.card(e, true)).join('') || '<div class="empty">Nobody signed in at the gate.</div>'}
      ${this.today.length ? `<div class="sec-title">Left today <span>${this.today.length}</span></div>${this.today.map((e) => this.card(e, false)).join('')}` : ''}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-gt]')?.dataset.gt
    if (!a) return false
    const api = this.h.api
    if (a.startsWith('out:')) { await api.post(`/api/security/gate/${a.slice(4)}/out`); await this.load(); toast('Marked out'); return true }
    if (a !== 'in') return false
    const guests = await api.get<{ id: string; name: string; room_no: string | null; status: string }[]>('/api/security/gate/guests')
    let photo: string | null = null
    this.h.modal.open('Entry at the gate', `<div class="form-grid">
        <label class="span2">Who<select name="kind" data-kind>${Object.entries(KIND).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="span2" data-for="guest_vehicle">Guest<select name="res"><option value="">—</option>${guests.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}${g.room_no ? ` · room ${esc(g.room_no)}` : ' · arriving'}</option>`).join('')}</select></label>
        <label>Vehicle number<input name="vehicle" maxlength="14" autocapitalize="characters" placeholder="TN 38 AB 1234"></label>
        <label data-for="guest_vehicle">Tag given<input name="tag" maxlength="10" placeholder="G-07"></label>
        <label data-for="visitor vendor delivery taxi staff_vehicle">Name / company<input name="name" maxlength="80"></label>
        <label data-for="visitor vendor delivery taxi">Mobile<input name="mobile" inputmode="tel" maxlength="14"></label>
        <label data-for="visitor vendor delivery">Purpose<input name="purpose" maxlength="80" placeholder="e.g. meeting, vegetables, gas cylinders"></label>
        <label data-for="visitor vendor delivery">Meeting / for<input name="host" maxlength="60" placeholder="e.g. GM, Kitchen, room 204"></label>
        <label>People<input name="pax" type="number" min="0" max="200"></label><label>Parking<input name="parking" maxlength="20" placeholder="e.g. P1, basement"></label>
        <label class="check span2"><input type="checkbox" name="here"> Parked where I am standing (shows on the map)</label>
        <label class="span2">Note<input name="note" maxlength="200"></label></div>
      <div class="actions"><button type="button" class="btn" data-photo>Photo (vehicle or ID)</button><span class="muted small" data-photo-state></span></div>`, 'Sign in', async (f) => {
      const fix = checked(f, 'here') ? await currentFix(8000) : null
      const photoId = photo ? await uploadPhoto(api, 'gate', photo) : undefined
      await api.post('/api/security/gate', {
        kind: val(f, 'kind'), reservationId: val(f, 'res') || undefined, vehicleNo: val(f, 'vehicle') || undefined, tagNo: val(f, 'tag') || undefined, name: val(f, 'name') || undefined,
        mobile: val(f, 'mobile') || undefined, purpose: val(f, 'purpose') || undefined, host: val(f, 'host') || undefined, pax: val(f, 'pax') ? Number(val(f, 'pax')) : undefined,
        parking: val(f, 'parking') || undefined, note: val(f, 'note') || undefined, photoId, ...(fix ? { lat: fix.lat, lng: fix.lng } : {}),
      })
      await this.load(); this.h.render(); return 'Signed in'
    })
    // Show only the fields that apply to who is coming in.
    const sync = () => {
      const k = this.h.modal.el.querySelector<HTMLSelectElement>('[data-kind]')!.value
      this.h.modal.el.querySelectorAll<HTMLElement>('[data-for]').forEach((x) => { x.hidden = !x.dataset.for!.split(' ').includes(k) })
    }
    this.h.modal.el.querySelector('[data-kind]')!.addEventListener('change', sync)
    sync()
    this.h.modal.el.querySelector('[data-photo]')!.addEventListener('click', async () => {
      photo = await takePhoto(); this.h.modal.el.querySelector('[data-photo-state]')!.textContent = photo ? 'Photo ready' : ''
    })
    return false
  }
}

interface Checkpoint { id: string; name: string; code: string; space: string | null; x: string | null; last_scan: string | null; last_by: string | null; overdue: boolean; overdueMinutes: number | null; active: boolean }
interface Route { id: string; name: string; checkpoint_ids: string[]; every_minutes: number; starts: string; ends: string; active: boolean }
interface Scan { id: string; at: string; checkpoint: string; by: string; note: string | null }

export class PatrolsView {
  private cps: Checkpoint[] = []
  private routes: Route[] = []
  private scans: Scan[] = []
  constructor(private h: WorkspaceHost) {}

  async load() {
    this.cps = await this.h.cached('/api/security/checkpoints')
    this.routes = await this.h.cached('/api/security/routes')
    this.scans = await this.h.cached('/api/security/patrols?hours=12')
  }

  html() {
    const manage = this.h.can('security.manage'), name = (id: string) => this.cps.find((c) => c.id === id)?.name ?? id
    return `<div class="ws-toolbar">${this.h.can('security.gate') ? '<button type="button" class="btn primary" data-pt="scan">Scan checkpoint</button>' : ''}
        ${manage ? '<button type="button" class="btn" data-pt="cp">Add checkpoint</button><button type="button" class="btn" data-pt="route">Add round</button><button type="button" class="btn" data-pt="labels">Print QR labels</button>' : ''}</div>
      <div class="sec-title">Checkpoints <span>${this.cps.filter((c) => c.overdue).length} due</span></div>
      ${this.cps.filter((c) => c.active).map((c) => `<div class="row-card${c.overdue ? ' late' : ''}"><div class="rc-title">${esc(c.name)}</div>
        <div class="rc-sub">${c.last_scan ? `Last ${when(c.last_scan)} by ${esc(c.last_by ?? '')}` : 'Never scanned'}${c.space ? ` · ${esc(c.space)}` : ''}${c.overdue ? ` · <span class="fd-warn">due ${c.overdueMinutes} min</span>` : ''}</div>
        <div class="rc-right">${c.overdue ? tonePill('Missed', '--st-departing') : c.last_scan ? tonePill('OK', '--st-vacant') : ''}</div></div>`).join('') || '<div class="empty">No checkpoints yet.</div>'}
      <div class="sec-title">Rounds</div>
      ${this.routes.map((r) => `<div class="row-card${r.active ? '' : ' retired'}"><div class="rc-title">${esc(r.name)} · ${esc(r.starts)}–${esc(r.ends)} · every ${r.every_minutes} min</div>
        <div class="rc-sub">${r.checkpoint_ids.map((id) => esc(name(id))).join(' → ')}</div>${manage ? `<div class="rc-right"><button type="button" class="btn small" data-pt="toggle:${esc(r.id)}">${r.active ? 'Stop' : 'Start'}</button></div>` : ''}</div>`).join('') || '<div class="empty">No patrol rounds yet.</div>'}
      <div class="sec-title">Scans in the last 12 hours <span>${this.scans.length}</span></div>
      ${this.scans.slice(0, 60).map((s) => `<div class="m-row ping-row"><span class="mono">${time(s.at)}</span><b>${esc(s.checkpoint)}</b><span>${esc(s.by)}${s.note ? ` · ${esc(s.note)}` : ''}</span></div>`).join('')}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-pt]')?.dataset.pt
    if (!a) return false
    const api = this.h.api, modal = this.h.modal, done = async (msg: string) => { await this.load(); this.h.render(); return msg }
    if (a === 'labels') { await api.openDocument('/api/security/checkpoints/labels'); return false }
    if (a.startsWith('toggle:')) { const r = this.routes.find((x) => x.id === a.slice(7))!; await api.req('PATCH', `/api/security/routes/${r.id}`, { active: !r.active }); await this.load(); return true }
    if (a === 'cp') {
      const list = await spaceList(this.h)
      modal.open('Add checkpoint', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="60" placeholder="e.g. Back gate, DG room, Pool store"></label>${placeField(list, 'Where')}</div>
        <p class="muted small">Stand at the spot to pin it by GPS, or choose the building. Then print its QR label and fix it there.</p>`, 'Add', async (f) => {
        await api.post('/api/security/checkpoints', { name: val(f, 'name'), ...(await readPlace(f)) }); return done('Checkpoint added: print its label')
      })
    }
    if (a === 'route') {
      if (!this.cps.length) { toast('Add the checkpoints first.'); return false }
      modal.open('Add patrol round', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="40" placeholder="e.g. Night round"></label>
        <label>From<input name="starts" type="time" value="22:00"></label><label>To<input name="ends" type="time" value="06:00"></label>
        <label>Every (minutes)<input name="every" type="number" min="15" max="1440" value="120"></label>
        <fieldset class="span2"><legend>Checkpoints, in order</legend>${this.cps.filter((c) => c.active).map((c) => `<label class="check"><input type="checkbox" name="c_${esc(c.id)}"> ${esc(c.name)}</label>`).join('')}</fieldset></div>
        <p class="muted small">A checkpoint not scanned within the interval (plus 10 minutes) alerts the security head and appears in the guard's work.</p>`, 'Add', async (f) => {
        await api.post('/api/security/routes', { name: val(f, 'name'), starts: val(f, 'starts'), ends: val(f, 'ends'), everyMinutes: Number(val(f, 'every')), checkpointIds: this.cps.filter((c) => checked(f, `c_${c.id}`)).map((c) => c.id) })
        return done('Round added')
      })
    }
    if (a === 'scan') {
      modal.open('Patrol checkpoint', `<p class="muted small">Point the camera at the checkpoint's QR code, or type the code printed under it.</p><div data-cam></div>
        <div class="form-grid"><label class="span2">Code<input name="code" placeholder="SP-CP-…" autocomplete="off"></label><label class="span2">Anything to note?<input name="note" maxlength="200" placeholder="e.g. light not working, door found open"></label></div>`, 'Record', async (f) => {
        const r = await this.h.outbox.send<{ checkpoint: string }>('POST', '/api/security/scan', { code: val(f, 'code').toUpperCase(), note: val(f, 'note') || undefined }, 'patrol scan')
        await this.load().catch(() => {}); this.h.render()
        return r ? `Checked: ${r.checkpoint}` : 'No connection: the scan is saved on this phone.'
      })
      const cam = modal.el.querySelector<HTMLElement>('[data-cam]')!
      const code = await scanQr(cam)
      if (code) {
        const input = modal.el.querySelector<HTMLInputElement>('input[name=code]')
        if (input) input.value = code
      } else if (cam.isConnected && !('BarcodeDetector' in window)) toast('This browser cannot read QR codes: type the code under it.')
    }
    return false
  }
}
