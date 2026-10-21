import { esc, toast, tonePill, showDate } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import type { WorkspaceHost } from '../ui/workspace'
import { currentFix } from '../staff/tracker'
import { assetOptions, CATEGORY, reportFault, rupees } from './common'

// The asset register (what the resort owns, where it is, warranty and maintenance contract) and the
// planned-maintenance schedules that raise tickets on their due day.

interface Asset {
  id: string; name: string; category: string; space_id: string | null; space: string | null; x: string | null; z: string | null; make: string | null; model: string | null; serial: string | null
  installed_on: string | null; warranty_until: string | null; amc_vendor: string | null; amc_until: string | null; amc_cost_paise: number | null; notes: string | null; active: boolean
  open_tickets: number; next_pm: string | null
}
interface Plan { id: string; asset_id: string; asset: string; category: string; title: string; every_days: number; checklist: string[]; next_due: string; last_done: string | null; active: boolean }
interface Meta { categories: string[]; templates: Record<string, { title: string; everyDays: number; checklist: string[] }> }

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
const left = (day: string) => Math.round((new Date(`${day}T00:00:00Z`).getTime() - new Date(`${today()}T00:00:00Z`).getTime()) / 86_400_000)
const dueText = (day: string) => { const d = left(day); return d < 0 ? `<span class="fd-warn">${-d} days overdue</span>` : d === 0 ? '<b>due today</b>' : `in ${d} days` }

async function spaces(h: WorkspaceHost) {
  const d = today()
  return (await h.api.get<{ spaces: { id: string; name: string }[] }>(`/api/dashboard?from=${d}&to=${d}`)).spaces
}

export class AssetsView {
  private list: Asset[] = []
  private q = ''
  constructor(private h: WorkspaceHost & { meta(): Promise<Meta> }) {}

  async load() { this.list = await this.h.cached('/api/eng/assets') }

  html() {
    const q = this.q.toLowerCase()
    const shown = this.list.filter((a) => !q || `${a.name} ${a.space ?? ''} ${CATEGORY[a.category]} ${a.make ?? ''}`.toLowerCase().includes(q))
    const groups = [...new Set(shown.map((a) => a.category))]
    return `<div class="ws-toolbar">${this.h.can('eng.manage') ? '<button type="button" class="btn primary" data-as="add">Add asset</button>' : ''}<input class="ws-search" type="search" placeholder="Search assets" value="${esc(this.q)}" aria-label="Search assets"></div>
      ${groups.map((g) => `<div class="sec-title">${esc(CATEGORY[g] ?? g)} <span>${shown.filter((a) => a.category === g).length}</span></div>
        ${shown.filter((a) => a.category === g).map((a) => `<div class="row-card${a.active ? '' : ' retired'}" data-asset="${esc(a.id)}"><div class="rc-title">${esc(a.name)}</div>
          <div class="rc-sub">${esc([a.space, a.make, a.model].filter(Boolean).join(' · ') || (a.x != null ? 'Pinned on the map' : 'No place set'))}${a.next_pm ? ` · service ${dueText(a.next_pm)}` : ''}</div>
          <div class="rc-right">${a.open_tickets ? tonePill(`${a.open_tickets} open`, '--st-departing') : ''}${a.amc_until ? tonePill(`AMC ${left(a.amc_until) < 0 ? 'expired' : a.amc_until}`, left(a.amc_until) < 30 ? '--marigold' : '--muted') : ''}</div></div>`).join('')}`).join('')
      || '<div class="empty">No assets yet. Add the ACs, DG sets, pumps, transformer, STP, pool plant, kitchen equipment, CCTV and fire extinguishers.</div>'}`
  }

  onInput(el: HTMLElement) {
    if (!el.classList.contains('ws-search')) return
    this.q = (el as HTMLInputElement).value; this.h.render()
  }

  async click(el: HTMLElement): Promise<boolean> {
    if (el.closest('[data-as=add]')) { await this.edit(); return false }
    const id = el.closest<HTMLElement>('[data-asset]')?.dataset.asset
    if (id) {
      const a = this.list.find((x) => x.id === id)!
      if (this.h.can('eng.manage')) await this.edit(a)
      else reportFault(this.h, { assetId: a.id, where: a.name })
    }
    return false
  }

  private async edit(a?: Asset) {
    const meta = await this.h.meta()
    const sp = await spaces(this.h).catch(() => [])
    this.h.modal.open(a ? a.name : 'Add asset', `<div class="form-grid">
        <label class="span2">Name<input name="name" maxlength="80" value="${esc(a?.name ?? '')}" placeholder="e.g. Room 101 split AC, DG set 125 kVA"></label>
        <label>Kind<select name="category">${meta.categories.map((c) => `<option value="${c}" ${c === a?.category ? 'selected' : ''}>${esc(CATEGORY[c] ?? c)}</option>`).join('')}</select></label>
        <label>In<select name="space"><option value="">— (pin on the map)</option>${sp.map((s) => `<option value="${esc(s.id)}" ${s.id === a?.space_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label>Make<input name="make" maxlength="40" value="${esc(a?.make ?? '')}"></label><label>Model<input name="model" maxlength="40" value="${esc(a?.model ?? '')}"></label>
        <label>Serial no.<input name="serial" maxlength="40" value="${esc(a?.serial ?? '')}"></label><label>Installed<input name="installed" type="date" value="${a?.installed_on ?? ''}"></label>
        <label>Warranty until<input name="warranty" type="date" value="${a?.warranty_until ?? ''}"></label><label>AMC vendor<input name="amcVendor" maxlength="60" value="${esc(a?.amc_vendor ?? '')}"></label>
        <label>AMC until<input name="amcUntil" type="date" value="${a?.amc_until ?? ''}"></label><label>AMC cost a year (₹)<input name="amcCost" type="number" min="0" step="1" value="${a?.amc_cost_paise != null ? a.amc_cost_paise / 100 : ''}"></label>
        <label class="span2">Notes<input name="notes" maxlength="200" value="${esc(a?.notes ?? '')}"></label>
        <label class="check span2"><input type="checkbox" name="gps"> Pin it where I am standing now (outdoor equipment)</label>
        ${a ? `<label class="check span2"><input type="checkbox" name="active" ${a.active ? 'checked' : ''}> In use</label>` : ''}</div>
      ${a ? `<div class="actions"><button type="button" class="btn" data-af="fault">Report a fault on it</button>${a.amc_cost_paise ? `<span class="muted small">AMC ${rupees(a.amc_cost_paise)} a year</span>` : ''}</div>` : ''}`, a ? 'Save' : 'Add', async (f) => {
      const fix = checked(f, 'gps') ? await currentFix() : null
      if (checked(f, 'gps') && !fix) throw new Error('Location not available: allow location and try again.')
      const body = {
        name: val(f, 'name'), category: val(f, 'category'), spaceId: val(f, 'space') || null, make: val(f, 'make'), model: val(f, 'model'), serial: val(f, 'serial'),
        installedOn: val(f, 'installed') || null, warrantyUntil: val(f, 'warranty') || null, amcVendor: val(f, 'amcVendor'), amcUntil: val(f, 'amcUntil') || null,
        amcCost: val(f, 'amcCost') === '' ? null : Number(val(f, 'amcCost')), notes: val(f, 'notes'), ...(fix ? { lat: fix.lat, lng: fix.lng, spaceId: null } : {}),
        ...(a ? { active: checked(f, 'active') } : {}),
      }
      if (a) await this.h.api.req('PATCH', `/api/eng/assets/${a.id}`, body)
      else await this.h.api.post('/api/eng/assets', body)
      await this.load(); this.h.render(); return a ? 'Saved' : 'Asset added'
    })
    this.h.modal.el.querySelector('[data-af=fault]')?.addEventListener('click', () => { if (a) reportFault(this.h, { assetId: a.id, where: a.name }) })
  }
}

export class PlansView {
  private list: Plan[] = []
  private assets: Asset[] = []
  constructor(private h: WorkspaceHost & { meta(): Promise<Meta> }) {}

  async load() {
    this.list = await this.h.cached('/api/eng/plans')
    this.assets = await this.h.cached('/api/eng/assets')
  }

  html() {
    const active = this.list.filter((p) => p.active)
    return `<div class="ws-toolbar">${this.h.can('eng.manage') ? '<button type="button" class="btn primary" data-pl="add">Add a schedule</button>' : ''}
        <span class="muted small">A ticket is raised on the due day; finishing it sets the next date.</span></div>
      ${active.map((p) => `<div class="row-card${left(p.next_due) < 0 ? ' late' : ''}" data-plan="${esc(p.id)}"><div class="rc-title">${esc(p.title)} · ${esc(p.asset)}</div>
        <div class="rc-sub">Every ${p.every_days} days · next ${esc(showDate(p.next_due))} (${dueText(p.next_due)})${p.last_done ? ` · last done ${esc(p.last_done)}` : ''} · ${p.checklist.length} checks</div></div>`).join('') || '<div class="empty">No maintenance schedules yet.</div>'}
      ${this.list.some((p) => !p.active) ? `<div class="sec-title">Stopped</div>${this.list.filter((p) => !p.active).map((p) => `<div class="row-card retired" data-plan="${esc(p.id)}"><div class="rc-title">${esc(p.title)} · ${esc(p.asset)}</div></div>`).join('')}` : ''}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    if (!this.h.can('eng.manage')) return false
    if (el.closest('[data-pl=add]')) { await this.edit(); return false }
    const id = el.closest<HTMLElement>('[data-plan]')?.dataset.plan
    if (id) await this.edit(this.list.find((p) => p.id === id))
    return false
  }

  private async edit(p?: Plan) {
    const meta = await this.h.meta()
    if (!p && !this.assets.length) { toast('Add the asset first (Assets tab).'); return }
    this.h.modal.open(p ? `${p.title} · ${p.asset}` : 'New maintenance schedule', `<div class="form-grid">
        ${p ? '' : `<label class="span2">Asset<select name="asset" data-tpl>${assetOptions(this.assets)}</select></label>`}
        <label class="span2">Title<input name="title" maxlength="60" value="${esc(p?.title ?? '')}"></label>
        <label>Every (days)<input name="every" type="number" min="1" max="1095" value="${p?.every_days ?? 30}"></label>
        <label>${p ? 'Next due' : 'First due'}<input name="due" type="date" value="${p?.next_due ?? today()}"></label>
        <label class="span2">Checklist (one per line)<textarea name="checklist" rows="6">${esc((p?.checklist ?? []).join('\n'))}</textarea></label>
        ${p ? `<label class="check span2"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Running</label>` : ''}</div>`, p ? 'Save' : 'Add', async (f) => {
      const body = { title: val(f, 'title'), everyDays: Number(val(f, 'every')), nextDue: val(f, 'due'), checklist: val(f, 'checklist').split('\n').map((x) => x.trim()).filter(Boolean) }
      if (p) await this.h.api.req('PATCH', `/api/eng/plans/${p.id}`, { ...body, active: checked(f, 'active') })
      else await this.h.api.post('/api/eng/plans', { ...body, assetId: val(f, 'asset') })
      await this.load(); this.h.render(); return 'Saved'
    })
    // Picking an asset fills in the usual schedule for that kind of equipment.
    this.h.modal.el.querySelector<HTMLSelectElement>('[data-tpl]')?.addEventListener('change', (e) => {
      const a = this.assets.find((x) => x.id === (e.target as HTMLSelectElement).value)
      const tpl = a && meta.templates[a.category]
      if (!tpl) return
      const form = this.h.modal.el.querySelector('form')!
      const set = (n: string, v: string) => { (form.elements.namedItem(n) as HTMLInputElement).value = v }
      set('title', tpl.title); set('every', String(tpl.everyDays)); set('checklist', tpl.checklist.join('\n'))
    })
  }
}
