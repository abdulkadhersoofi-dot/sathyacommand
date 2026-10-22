import { esc, tonePill } from '../ui/dom'
import { val } from '../ui/form-modal'
import { hydratePhotos, takePhoto, uploadPhoto } from '../ui/photo'
import { toolbar } from '../ui/toolbar'
import type { WorkspaceHost } from '../ui/workspace'
import { rupees } from './common'

// The engineering spares store (stock at average cost, receipts, issues to jobs) and the compliance
// calendar (licences, maintenance contracts and statutory checks, with their expiry reminders).

interface Spare { id: string; name: string; unit: string; reorder_level: string | null; stock: number; costPaise: number; low: boolean; active: boolean }
interface Move { id: string; at: string; kind: string; qty: string; value_paise: string; ticket_id: string | null; vendor: string | null; note: string | null; spare: string; unit: string; by: string }

export class SparesView {
  private list: Spare[] = []
  private moves: Move[] = []
  constructor(private h: WorkspaceHost) {}

  async load() {
    this.list = await this.h.cached('/api/eng/spares')
    this.moves = await this.h.cached('/api/eng/spares/moves')
  }

  html() {
    const value = this.list.reduce((a, s) => a + Math.max(0, s.stock) * s.costPaise, 0)
    return `${toolbar({ primary: this.h.can('eng.manage') ? [{ attrs: 'data-sp="add"', label: 'Add spare part' }] : [], end: `<span class="muted small">Stock value ${rupees(Math.round(value))}</span>` })}
      <div class="m-table"><div class="m-row spare-row head"><span>Part</span><span>Stock</span><span>Avg cost</span><span></span></div>
      ${this.list.filter((s) => s.active).map((s) => `<div class="m-row spare-row"><b>${esc(s.name)}</b><span class="mono">${s.stock} ${esc(s.unit)} ${s.low ? tonePill('Reorder', '--marigold') : ''}</span>
        <span class="mono">${rupees(s.costPaise)}</span><span class="row-btns"><button type="button" class="btn small" data-sp="in:${esc(s.id)}">Received…</button><button type="button" class="btn small" data-sp="out:${esc(s.id)}" ${s.stock > 0 ? '' : 'disabled'}>Issue…</button></span></div>`).join('') || '<div class="empty">No spares yet.</div>'}</div>
      <div class="sec-title">Recent movements</div>
      ${this.moves.slice(0, 40).map((m) => `<div class="m-row move-row"><span class="mono">${new Date(m.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span><b>${esc(m.spare)}</b>
        <span class="mono">${Number(m.qty) > 0 ? '+' : ''}${Number(m.qty)} ${esc(m.unit)}</span><span>${esc([m.ticket_id, m.vendor, m.note, m.by].filter(Boolean).join(' · '))}</span></div>`).join('')}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-sp]')?.dataset.sp
    if (!a) return false
    const api = this.h.api, done = async (msg: string) => { await this.load(); this.h.render(); return msg }
    if (a === 'add') {
      this.h.modal.open('Add spare part', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="80" placeholder="e.g. MCB 32A, AC capacitor 45 µF"></label>
        <label>Unit<input name="unit" maxlength="12" value="nos"></label><label>Reorder at<input name="reorder" type="number" min="0" step="1"></label></div>`, 'Add', async (f) => {
        await api.post('/api/eng/spares', { name: val(f, 'name'), unit: val(f, 'unit'), reorderLevel: val(f, 'reorder') ? Number(val(f, 'reorder')) : undefined }); return done('Added')
      })
      return false
    }
    const [kind, id] = a.split(':')
    const s = this.list.find((x) => x.id === id)!
    if (kind === 'in') {
      this.h.modal.open(`Received: ${s.name}`, `<div class="form-grid"><label>Quantity (${esc(s.unit)})<input name="qty" type="number" min="0.01" step="0.01"></label><label>Total cost (₹)<input name="cost" type="number" min="0" step="0.01"></label>
        <label class="span2">Supplier<input name="vendor" maxlength="60"></label></div>`, 'Receive', async (f) => {
        await api.post(`/api/eng/spares/${id}/receive`, { qty: Number(val(f, 'qty')), cost: Number(val(f, 'cost')), vendor: val(f, 'vendor') || undefined }); return done('Stock updated')
      })
    }
    if (kind === 'out') {
      const open = (await api.get<{ id: string; title: string }[]>('/api/eng/tickets')).slice(0, 100)
      this.h.modal.open(`Issue: ${s.name}`, `<div class="form-grid"><label>Quantity (${esc(s.unit)})<input name="qty" type="number" min="0.01" step="0.01" max="${s.stock}" value="1"></label>
        <label>For ticket<select name="ticket"><option value="">— (general use)</option>${open.map((k) => `<option value="${esc(k.id)}">${esc(k.title)}</option>`).join('')}</select></label>
        <label class="span2">Note<input name="note" maxlength="120"></label></div>`, 'Issue', async (f) => {
        const r = await api.post<{ pending?: boolean }>(`/api/eng/spares/${id}/issue`, { qty: Number(val(f, 'qty')), ticketId: val(f, 'ticket') || undefined, note: val(f, 'note') || undefined })
        return done(r.pending ? 'Above your limit: sent for approval' : 'Issued')
      })
    }
    return false
  }
}

interface Item { type: string; id: string; name: string; due: string | null; daysLeft: number | null; tier: number; owner: string | null; detail: string | null; docIds?: string[] }
const TYPE: Record<string, string> = { licence: 'Licence', amc: 'Contract', maintenance: 'Statutory check' }

export class ComplianceView {
  private items: Item[] = []
  private people: { id: string; name: string }[] = []
  constructor(private h: WorkspaceHost) {}

  async load() {
    const r = await this.h.cached<{ items: Item[]; people: { id: string; name: string }[] }>('/api/compliance')
    this.items = r.items; this.people = r.people
  }

  html() {
    const groups: [string, (i: Item) => boolean][] = [
      ['Overdue', (i) => i.daysLeft != null && i.daysLeft < 0], ['Within 7 days', (i) => i.daysLeft != null && i.daysLeft >= 0 && i.daysLeft <= 7],
      ['Within 30 days', (i) => i.daysLeft != null && i.daysLeft > 7 && i.daysLeft <= 30], ['Within 60 days', (i) => i.daysLeft != null && i.daysLeft > 30 && i.daysLeft <= 60],
      ['Later', (i) => i.daysLeft != null && i.daysLeft > 60], ['No expiry date entered', (i) => i.due == null],
    ]
    const tone = (i: Item) => (i.daysLeft == null ? '--muted' : i.daysLeft < 0 ? '--st-departing' : i.daysLeft <= 30 ? '--marigold' : '--st-vacant')
    return `<p class="muted small">Reminders go out 60, 30 and 7 days before each date, and when it has passed. Add or renew licences under Settings → Licences &amp; tax.</p>
      ${groups.map(([title, test]) => { const list = this.items.filter(test); return list.length ? `<div class="sec-title">${title} <span>${list.length}</span></div>${list.map((i) => `<div class="row-card cal-card" ${i.type === 'licence' && this.h.can('licences.edit') ? `data-cal="${esc(i.id)}"` : ''}>
        <div class="rc-title">${esc(i.name)}</div><div class="rc-sub">${esc(TYPE[i.type] ?? i.type)}${i.detail ? ` · ${esc(i.detail)}` : ''}${i.owner ? ` · owner ${esc(i.owner)}` : i.type === 'licence' ? ' · <b>no owner</b>' : ''}</div>
        <div class="rc-right">${tonePill(i.due ? (i.daysLeft! < 0 ? `${-i.daysLeft!} days late` : i.daysLeft === 0 ? 'today' : `${i.due}`) : 'no date', tone(i))}</div></div>`).join('')}` : '' }).join('') || '<div class="empty">Nothing on the calendar yet.</div>'}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const id = el.closest<HTMLElement>('[data-cal]')?.dataset.cal
    if (!id) return false
    const item = this.items.find((i) => i.id === id)!
    let photo: string | null = null
    this.h.modal.open(item.name, `<div class="form-grid"><label class="span2">Owner (gets the reminders, renews it)<select name="owner"><option value="">—</option>${this.people.map((p) => `<option value="${esc(p.id)}" ${p.name === item.owner ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label></div>
      <div class="actions"><button type="button" class="btn" data-photo>Photo of the licence</button><span class="muted small" data-photo-state></span></div>
      ${item.docIds?.length ? `<div class="photos">${item.docIds.map((d) => `<img data-upload="${esc(d)}" alt="Licence copy">`).join('')}</div>` : ''}`, 'Save', async (f) => {
      const docIds = photo ? [await uploadPhoto(this.h.api, 'document', photo)] : undefined
      await this.h.api.req('PATCH', `/api/compliance/licences/${id}`, { ownerId: val(f, 'owner') || null, ...(docIds ? { docIds: [...(item.docIds ?? []), ...docIds] } : {}) })
      await this.load(); this.h.render(); return 'Saved'
    })
    hydratePhotos(this.h.api, this.h.modal.el)
    this.h.modal.el.querySelector('[data-photo]')!.addEventListener('click', async () => {
      photo = await takePhoto(1600); this.h.modal.el.querySelector('[data-photo-state]')!.textContent = photo ? 'Photo ready' : ''
    })
    return false
  }
}
