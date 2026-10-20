import { esc } from '../ui/dom'
import { val } from '../ui/form-modal'
import type { WorkspaceHost } from '../ui/workspace'
import { currentFix } from '../staff/tracker'

// Shared pieces for the security screens: choosing a place (a room or building, or where the phone is).

export interface Space { id: string; name: string }
let spaces: Space[] | null = null

export async function spaceList(h: WorkspaceHost) {
  if (spaces) return spaces
  const d = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
  spaces = (await h.api.get<{ spaces: Space[] }>(`/api/dashboard?from=${d}&to=${d}`).catch(() => ({ spaces: [] }))).spaces
  return spaces
}

/** A "where" field: a place on the resort, or (left blank) where the phone is now. */
export const placeField = (list: Space[], label = 'Where', selected?: string | null) =>
  `<label>${esc(label)}<select name="space"><option value="">Where I am standing (GPS)</option>${list.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>`

export async function readPlace(f: HTMLFormElement): Promise<{ spaceId?: string; lat?: number; lng?: number }> {
  const spaceId = val(f, 'space')
  if (spaceId) return { spaceId }
  const fix = await currentFix(8000)
  return fix ? { lat: fix.lat, lng: fix.lng } : {}
}

export const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
