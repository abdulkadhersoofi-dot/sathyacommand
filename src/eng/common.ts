import { esc, toast, tonePill } from '../ui/dom'
import { val } from '../ui/form-modal'
import { takePhoto, uploadPhoto } from '../ui/photo'
import type { WorkspaceHost } from '../ui/workspace'
import { currentFix } from '../staff/tracker'

// Shared pieces for the engineering screens, and the "report a fault" form used everywhere
// (the room panel, housekeeping, the engineering workspace).

export type Priority = 'urgent' | 'high' | 'normal' | 'low'
export interface Ticket {
  id: string; kind: 'fault' | 'pm'; title: string; detail: string | null; priority: Priority; status: string
  asset_id: string | null; asset: string | null; category: string | null; space_id: string | null; space: string | null
  photos: string[]; checklist: { item: string; done: boolean }[]; reported_by: string | null; reporter_id: string | null; reported_at: string
  assigned_to: string | null; assignee: string | null; responded_at: string | null; respond_by: string; resolve_by: string
  done_at: string | null; resolution: string | null; hold_reason: string | null; escalation: number; spares_paise: number
  responseLate: boolean; resolveLate: boolean
}

export const CATEGORY: Record<string, string> = {
  ac: 'Air conditioning', dg: 'DG set', pump: 'Pump', transformer: 'Transformer', electrical: 'Electrical', stp: 'STP', pool: 'Pool plant', kitchen: 'Kitchen equipment',
  cctv: 'CCTV', lift: 'Lift', fire: 'Fire safety', plumbing: 'Plumbing', solar: 'Solar', laundry: 'Laundry', vehicle: 'Vehicle', other: 'Other',
}
export const PRIORITY: Record<Priority, [string, string]> = { urgent: ['Urgent', '--st-departing'], high: ['High', '--marigold'], normal: ['Normal', '--st-occupied'], low: ['Low', '--muted'] }
export const STATUS: Record<string, [string, string]> = {
  open: ['Open', '--st-arriving'], in_progress: ['Being fixed', '--marigold'], on_hold: ['On hold', '--god'], done: ['Fixed: to confirm', '--st-vacant'], closed: ['Closed', '--muted'], cancelled: ['Cancelled', '--muted'],
}
export const priorityPill = (p: Priority) => tonePill(...PRIORITY[p])
export const statusPill = (s: string) => tonePill(...(STATUS[s] ?? [s, '--muted']))
export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/** "35 min", "3 h", "2 days" since a moment. */
export function age(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`
}

/** Report a fault: what is wrong, how urgent, a photo, and where (a room, an asset, or the phone's location). */
export function reportFault(h: WorkspaceHost, at: { spaceId?: string; assetId?: string; where?: string } = {}, done?: (id: string) => void) {
  let photo: string | null = null
  h.modal.open(`Report a fault${at.where ? ` · ${at.where}` : ''}`, `<div class="form-grid">
      <label class="span2">What is wrong?<input name="title" maxlength="120" placeholder="e.g. AC not cooling, tap leaking, light not working"></label>
      <label class="span2">More detail (optional)<textarea name="detail" rows="2" maxlength="500"></textarea></label>
      <label>How urgent<select name="priority"><option value="normal">Normal: within the day</option><option value="high">High: guest affected</option><option value="urgent">Urgent: safety, water, power</option><option value="low">Low: when free</option></select></label>
      ${at.spaceId || at.assetId ? '' : '<label class="check"><input type="checkbox" name="here" checked> I am standing at the fault (use my location)</label>'}
    </div>
    <div class="actions"><button type="button" class="btn" data-photo>Take a photo</button><span class="muted small" data-photo-state></span></div>
    <p class="muted small">Engineering is told at once. You can follow it under Engineering → Tickets.</p>`, 'Report', async (f) => {
    const here = !at.spaceId && !at.assetId && (f.elements.namedItem('here') as HTMLInputElement | null)?.checked
    const fix = here ? await currentFix(8000) : null
    const photoIds = photo ? [await uploadPhoto(h.api, 'fault', photo)] : []
    const r = await h.api.post<{ id: string; located: boolean }>('/api/eng/tickets', {
      title: val(f, 'title'), detail: val(f, 'detail') || undefined, priority: val(f, 'priority'), spaceId: at.spaceId, assetId: at.assetId, lat: fix?.lat, lng: fix?.lng, photoIds,
    })
    done?.(r.id)
    return r.located ? 'Fault reported' : 'Fault reported (no location: say where in the detail)'
  })
  h.modal.el.querySelector('[data-photo]')!.addEventListener('click', async () => {
    photo = await takePhoto()
    h.modal.el.querySelector('[data-photo-state]')!.textContent = photo ? 'Photo ready' : ''
    if (!photo) toast('No photo taken')
  })
}

export const assetOptions = (assets: { id: string; name: string; category: string; active?: boolean }[], selected?: string | null) =>
  `<option value="">—</option>${assets.filter((a) => a.active !== false).map((a) => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)} · ${esc(CATEGORY[a.category] ?? a.category)}</option>`).join('')}`
