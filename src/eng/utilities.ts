import { esc, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import type { WorkspaceHost } from '../ui/workspace'
import { rupees } from './common'

// Daily meter readings with the month's use and cost per occupied room; pool, STP and fire checks.

interface Sheet { id: string; name: string; kind: string; unit: string; cumulative: boolean; reading: string | null; qty: string | null; reset: boolean | null; previous: string | null; previous_day: string | null; by: string | null }
interface Report {
  from: string; to: string; meters: { id: string; name: string; kind: string; unit: string; rate_paise: string }[]
  days: { day: string; occupied: number; qty: Record<string, number>; costPaise: number }[]; totals: Record<string, { qty: number; costPaise: number }>
  occupiedRoomNights: number; costPaise: number; costPerOccupiedRoomPaise: number | null; kwhPerOccupiedRoom: number | null; dieselPerDgHour: number | null
}
interface Meter { id: string; name: string; unit: string; rate_paise: number; active: boolean }

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
const n = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 })

export class MetersView {
  private day = today()
  private sheet: Sheet[] = []
  private report: Report | null = null
  constructor(private h: WorkspaceHost) {}

  async load() {
    this.sheet = await this.h.cached(`/api/eng/readings?day=${this.day}`)
    this.report = await this.h.cached('/api/eng/utilities')
  }

  html() {
    const r = this.report!
    return `<form class="meter-form" data-form="readings">
        <div class="ws-toolbar"><label class="inline">Readings for <input type="date" name="day" value="${this.day}" max="${today()}" data-day></label></div>
        <div class="m-table"><div class="m-row meter-row head"><span>Meter</span><span>Last</span><span>Today</span><span>Use</span><span>Reset</span></div>
        ${this.sheet.map((m) => `<div class="m-row meter-row"><b>${esc(m.name)}<small class="muted"> ${esc(m.unit)}${m.cumulative ? '' : ' used'}</small></b>
          <span class="mono">${m.cumulative && m.previous != null ? `${n(Number(m.previous))}<small class="muted"> ${esc(m.previous_day ?? '')}</small>` : '—'}</span>
          <input name="r_${esc(m.id)}" type="number" min="0" step="0.01" inputmode="decimal" value="${m.reading ?? ''}" aria-label="${esc(m.name)} reading">
          <span class="mono">${m.qty != null ? n(Number(m.qty)) : ''}</span>
          ${m.cumulative ? `<label class="check"><input type="checkbox" name="x_${esc(m.id)}" ${m.reset ? 'checked' : ''} aria-label="Meter reset"></label>` : '<span></span>'}</div>`).join('')}</div>
        <div class="actions"><button class="btn primary">Save readings</button><span class="muted small">Take them at the same time each morning. Tick reset only when a meter was replaced or rolled over.</span></div>
      </form>
      <div class="sec-title">Last 30 days <span>${esc(r.from)} – ${esc(r.to)}</span></div>
      <div class="kpi-mini">
        <div><b>${rupees(r.costPaise)}</b><span>utilities</span></div>
        <div><b>${r.costPerOccupiedRoomPaise != null ? rupees(r.costPerOccupiedRoomPaise) : '—'}</b><span>per occupied room (${r.occupiedRoomNights} room-nights)</span></div>
        <div><b>${r.kwhPerOccupiedRoom ?? '—'}</b><span>kWh per occupied room</span></div>
        <div><b>${r.dieselPerDgHour ?? '—'}</b><span>litres diesel per DG hour</span></div>
      </div>
      <div class="m-table"><div class="m-row meter-row head"><span>Meter</span><span>Use</span><span>Rate</span><span>Cost</span><span></span></div>
      ${r.meters.map((m) => `<div class="m-row meter-row"><b>${esc(m.name)}</b><span class="mono">${n(r.totals[m.id]?.qty ?? 0)} ${esc(m.unit)}</span><span class="mono">${Number(m.rate_paise) ? rupees(Number(m.rate_paise)) : '—'}</span>
        <span class="mono">${rupees(r.totals[m.id]?.costPaise ?? 0)}</span>${this.h.can('eng.manage') ? `<button type="button" class="btn small" data-mt="${esc(m.id)}">Rate…</button>` : '<span></span>'}</div>`).join('')}</div>`
  }

  async change(el: HTMLElement): Promise<boolean> {
    if (!el.matches('[data-day]')) return false
    this.day = (el as HTMLInputElement).value || today()
    this.sheet = await this.h.api.get(`/api/eng/readings?day=${this.day}`)
    return true
  }

  async submit(f: HTMLFormElement): Promise<boolean> {
    const readings = this.sheet.filter((m) => val(f, `r_${m.id}`) !== '').map((m) => ({ meterId: m.id, reading: Number(val(f, `r_${m.id}`)), reset: checked(f, `x_${m.id}`) }))
    if (!readings.length) throw new Error('Enter at least one reading.')
    await this.h.api.post('/api/eng/readings', { day: this.day, readings })
    await this.load()
    return true
  }

  async click(el: HTMLElement): Promise<boolean> {
    const id = el.closest<HTMLElement>('[data-mt]')?.dataset.mt
    if (!id) return false
    const m = (await this.h.api.get<Meter[]>('/api/eng/meters')).find((x) => x.id === id)!
    this.h.modal.open(m.name, `<div class="form-grid"><label>Cost per ${esc(m.unit)} (₹)<input name="rate" type="number" min="0" step="0.01" value="${m.rate_paise / 100}"></label>
      <label>Name<input name="name" maxlength="60" value="${esc(m.name)}"></label><label class="check span2"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> In use</label></div>
      <p class="muted small">Electricity: the tariff per unit including fixed and demand charges spread over the units. Diesel and LPG: the last purchase price.</p>`, 'Save', async (f) => {
      await this.h.api.req('PATCH', `/api/eng/meters/${id}`, { rate: Number(val(f, 'rate')), name: val(f, 'name'), active: checked(f, 'active') })
      await this.load(); this.h.render(); return 'Saved'
    })
    return false
  }
}

interface Log { id: string; kind: string; asset: string | null; data: Record<string, unknown>; ok: boolean; issues: string[]; ticket_id: string | null; note: string | null; by: string; at: string }
const KIND: Record<string, string> = { pool: 'Pool water', stp: 'STP', fire: 'Fire safety' }

export class LogsView {
  private list: Log[] = []
  private fire: { id: string; name: string; category: string; active: boolean }[] = []
  constructor(private h: WorkspaceHost) {}

  async load() {
    this.list = await this.h.cached('/api/eng/logs?days=30')
    this.fire = (await this.h.cached<{ id: string; name: string; category: string; active: boolean }[]>('/api/eng/assets')).filter((a) => a.category === 'fire' && a.active)
  }

  html() {
    const summary = (l: Log) => l.kind === 'pool' ? `pH ${l.data.ph} · chlorine ${l.data.chlorine} ppm` : l.kind === 'stp' ? `pH ${l.data.ph}${l.data.bod != null ? ` · BOD ${l.data.bod}` : ''}${l.data.tss != null ? ` · TSS ${l.data.tss}` : ''}${l.data.flowKl != null ? ` · ${l.data.flowKl} kL` : ''}` : esc(l.asset ?? '')
    return `<div class="ws-toolbar"><button type="button" class="btn primary" data-lg="pool">Pool check</button><button type="button" class="btn" data-lg="stp">STP check</button><button type="button" class="btn" data-lg="fire">Fire extinguisher / hydrant</button></div>
      <p class="muted small">Pool: pH 7.2–7.8, free chlorine 1–3 ppm, twice a day. STP outlet: pH 6.5–9, BOD up to 30, TSS up to 100 mg/L (check the TNPCB consent order). A reading outside the range raises a fault for engineering.</p>
      ${this.list.map((l) => `<div class="row-card"><div class="rc-title">${esc(KIND[l.kind])} · ${new Date(l.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
        <div class="rc-sub">${summary(l)} · ${esc(l.by)}${l.issues.length ? ` · <span class="fd-warn">${esc(l.issues.join(', '))}</span>` : ''}${l.note ? ` · ${esc(l.note)}` : ''}</div>
        <div class="rc-right">${l.ok ? tonePill('OK', '--st-vacant') : tonePill('Fault raised', '--st-departing')}</div></div>`).join('') || '<div class="empty">No checks in the last 30 days.</div>'}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const k = el.closest<HTMLElement>('[data-lg]')?.dataset.lg
    if (!k) return false
    const yes = (name: string, label: string) => `<label>${label}<select name="${name}"><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select></label>`
    const body = k === 'pool'
      ? `<label>pH<input name="ph" type="number" step="0.1" min="0" max="14" inputmode="decimal"></label><label>Free chlorine (ppm)<input name="chlorine" type="number" step="0.1" min="0" inputmode="decimal"></label>
         <label>Water temperature (°C)<input name="temperature" type="number" step="0.5" min="0"></label><label>Water<select name="clarity"><option value="clear">Clear</option><option value="cloudy">Cloudy</option></select></label>`
      : k === 'stp'
        ? `<label>Outlet pH<input name="ph" type="number" step="0.1" min="0" max="14"></label><label>Treated water (kL)<input name="flowKl" type="number" step="0.1" min="0"></label>
           <label>BOD mg/L (lab)<input name="bod" type="number" step="1" min="0"></label><label>TSS mg/L (lab)<input name="tss" type="number" step="1" min="0"></label>
           <label>MLSS mg/L<input name="mlss" type="number" step="10" min="0"></label><label>Blower hours<input name="blowerHours" type="number" step="0.1" min="0"></label>
           <label class="check span2"><input type="checkbox" name="odour"> Bad smell</label>`
        : `<label class="span2">Extinguisher / hydrant<select name="asset">${this.fire.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></label>
           ${yes('pressureOk', 'Pressure in the green?')}${yes('sealOk', 'Seal and pin intact?')}${yes('accessible', 'Easy to reach (not blocked)?')}${yes('signage', 'Sign in place?')}
           <label>Next refill due<input name="nextRefill" type="date"></label>`
    if (k === 'fire' && !this.fire.length) { this.h.modal.open('Fire check', '<p>Add the extinguishers and hydrants as assets (kind: Fire safety) first.</p>', 'Done', async () => ''); return false }
    this.h.modal.open(`${KIND[k]} check`, `<div class="form-grid">${body}<label class="span2">Note<input name="note" maxlength="200"></label></div>`, 'Save', async (f) => {
      const num = (x: string) => (val(f, x) === '' ? undefined : Number(val(f, x)))
      const yn = (x: string) => (val(f, x) === '' ? undefined : val(f, x) === 'yes')
      const data = k === 'pool' ? { ph: num('ph'), chlorine: num('chlorine'), temperature: num('temperature'), clarity: val(f, 'clarity') }
        : k === 'stp' ? { ph: num('ph'), flowKl: num('flowKl'), bod: num('bod'), tss: num('tss'), mlss: num('mlss'), blowerHours: num('blowerHours'), odour: checked(f, 'odour') }
          : { pressureOk: yn('pressureOk'), sealOk: yn('sealOk'), accessible: yn('accessible'), signage: yn('signage'), nextRefill: val(f, 'nextRefill') || undefined }
      const r = await this.h.api.post<{ ok: boolean; issues: string[] }>('/api/eng/logs', { kind: k, assetId: k === 'fire' ? val(f, 'asset') : undefined, data, note: val(f, 'note') || undefined })
      await this.load(); this.h.render()
      return r.ok ? 'All in range' : `Out of range: ${r.issues.join(', ')}. A fault has been raised.`
    })
    return false
  }
}
