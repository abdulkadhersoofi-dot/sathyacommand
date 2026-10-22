import type { WorkspaceHost } from '../ui/workspace'
import { esc } from '../ui/dom'

// Shared pieces for the restaurant screens (orders, kitchen, menu, licences & tax).

export interface Outlet { id: string; name: string; kind: string; space_id: string | null; serves_liquor: boolean; active: boolean; menu_of: string | null; place: string | null }
export interface Station { id: string; name: string; kind: 'kitchen' | 'bar'; active: boolean }
export interface Category { id: string; name: string; sort: number }
export interface MenuItem {
  id: string; category_id: string | null; code: string; name: string; name_ta: string | null; price_paise: number; liquor_class: string | null
  station_id: string; diet: 'veg' | 'egg' | 'non_veg'; jain: boolean; allergens: string[]; available: boolean; placeholder: boolean; active?: boolean
  brand_id?: string | null; pour_ml?: number | null
}
export interface Table { id: string; outlet_id: string; label: string; seats: number; section: string | null; order_id: string | null; order_number: number | null; covers: number | null; order_status: string | null; opened_at: string | null; ready_tickets: number }
export interface Ticket { id: string; number: number; kind: 'KOT' | 'BOT'; station_id: string; prints: number; copy: boolean; order: { number: number; outlet: string; table: string | null; room: string | null; covers: number }; lines: { qty: number; name: string; note: string | null; seat: number | null; course: number; alert?: string[]; void?: boolean }[] }

/** What each restaurant screen gets from the workspace. */
export interface Ws extends WorkspaceHost {
  outlets: Outlet[]
  stations: Station[]
  /** Checked-in guests, for room-service orders. */
  inHouse(): { id: string; guest: string; roomNo: string | null; pax: number }[]
  /** Fetches the food places again (after one is added or changed). */
  refreshOutlets(): Promise<void>
}

export const rs = (paise: number) => (paise < 0 ? '−' : '') + '₹' + (Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })
export const minutesAgo = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000))
export const chips = (items: [string, string][], current: string, attr: string) =>
  `<div class="ws-chips">${items.map(([id, label]) => `<button type="button" class="chip" data-${attr}="${esc(id)}" aria-pressed="${id === current}">${esc(label)}</button>`).join('')}</div>`
export const DIET: Record<string, string> = { veg: 'Veg', egg: 'Egg', non_veg: 'Non-veg' }
export const dietDot = (d: string) => `<span class="diet diet-${d}" title="${DIET[d] ?? d}"></span>`
