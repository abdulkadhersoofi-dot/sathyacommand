import type { RoomStatus } from '../data/store'
import type { HkStatus } from '../data/types'
import { STATUS_LABEL } from '../scene/palette'

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export const statusPill = (s: RoomStatus) => `<span class="pill" style="--c: var(--st-${s === 'ooo' ? 'ooo' : s})">${STATUS_LABEL[s]}</span>`

const HK_VAR: Record<HkStatus, string> = { clean: 'vacant', inspected: 'inspected', dirty: 'dirty', 'out-of-order': 'ooo' }
export const hkPill = (s: HkStatus) => `<span class="pill" style="--c: var(--st-${HK_VAR[s]})">${s === 'out-of-order' ? 'Out of order' : s[0].toUpperCase() + s.slice(1)}</span>`

export const tonePill = (text: string, cssVar: string) => `<span class="pill" style="--c: var(${cssVar})">${esc(text)}</span>`

export const maskPhone = (p: string, reveal: boolean) => (reveal ? p : p.slice(0, 6) + '•••••' + p.slice(-3))

let toastTimer = 0
export function toast(msg: string) {
  const t = $('#toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600)
}
