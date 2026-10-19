import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import { esc, toast } from '../ui/dom'
import { FormModal } from '../ui/form-modal'
import { isNetworkError } from '../live/api'
import { Outbox } from '../live/outbox'
import { CaptainView } from './captain'
import type { Outlet, Station, Ws } from './common'
import { KitchenView } from './kitchen'
import { MenuView } from './menu'
import { SettingsView } from './settings'
import { BarView } from './bar'
import { KitchenStockView } from './kitchen-stock'

// The restaurant workspace: a full-screen layer over the 3D map with Orders (captain tablet),
// Kitchen (kitchen and bar screens), Menu and Licences & tax. Each tab shows only to roles that use it.

type Tab = 'orders' | 'kitchen' | 'menu' | 'bar' | 'kstock' | 'settings'
interface View { load(): Promise<void>; html(): string; click(t: HTMLElement): Promise<boolean> }

export class FnbWorkspace implements Ws {
  outlets: Outlet[] = []
  stations: Station[] = []
  modal = new FormModal()
  open = false
  offline = false
  outbox: Outbox
  private el: HTMLElement
  private tab: Tab
  private views: Record<Tab, View & Partial<{ onInput(t: HTMLElement): void; tick(): void; submit(f: HTMLFormElement): Promise<boolean>; change(t: HTMLElement): Promise<boolean> }>>
  private captain: CaptainView
  private busy = false

  constructor(public api: Api, public me: Me, public inHouse: Ws['inHouse'], private onClose: () => void) {
    this.outbox = new Outbox(api)
    this.outbox.onChange(() => { if (this.open) { if (!this.outbox.queue.length) void this.refresh(); else this.render() } })
    this.captain = new CaptainView(this)
    this.views = { orders: this.captain, kitchen: new KitchenView(this), menu: new MenuView(this), bar: new BarView(this), kstock: new KitchenStockView(this), settings: new SettingsView(this) }
    this.tab = this.tabs()[0]?.[0] ?? 'settings'
    this.el = document.createElement('section')
    this.el.className = 'ws'
    this.el.hidden = true
    this.el.setAttribute('aria-label', 'Restaurant')
    document.getElementById('app')!.appendChild(this.el)
    this.el.addEventListener('click', (e) => void this.onClick(e))
    this.el.addEventListener('input', (e) => this.views[this.tab].onInput?.(e.target as HTMLElement))
    this.el.addEventListener('change', (e) => void this.guard(async () => { if (await this.views[this.tab].change?.(e.target as HTMLElement)) this.render() }))
    this.el.addEventListener('submit', (e) => {
      e.preventDefault()
      void this.guard(async () => { if (await this.views[this.tab].submit?.(e.target as HTMLFormElement)) { this.render(); toast('Saved') } })
    })
    setInterval(() => { if (this.open) this.views[this.tab].tick?.() }, 20_000)
  }

  async cached<T>(path: string): Promise<T> {
    const key = `sathya.cache:${path}`
    try {
      const v = await this.api.get<T>(path)
      this.offline = false
      try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* storage full: carry on without a copy */ }
      return v
    } catch (e) {
      if (!isNetworkError(e)) throw e
      this.offline = true
      const copy = (() => { try { return localStorage.getItem(key) } catch { return null } })()
      if (copy == null) throw new Error('No connection to the HMS, and this screen has not been opened on this tablet before.')
      return JSON.parse(copy) as T
    }
  }

  can(...permissions: string[]) { return this.me.permissions.includes('*') || permissions.some((p) => this.me.permissions.includes(p)) }

  tabs(): [Tab, string][] {
    const t: [Tab, string][] = []
    if (this.can('fnb.order')) t.push(['orders', 'Orders'])
    if (this.can('kitchen', 'fnb.order')) t.push(['kitchen', 'Kitchen & bar'])
    if (this.can('menu.edit', 'menu.price')) t.push(['menu', 'Menu'])
    if (this.can('bar.stock', 'bar.approve') || this.me.roles.includes('bartender')) t.push(['bar', 'Bar stock'])
    if (this.can('kitchen.stock', 'kitchen', 'food_cost.view')) t.push(['kstock', 'Kitchen stock'])
    t.push(['settings', 'Licences & tax'])
    return t
  }

  async show(tab?: Tab) {
    if (tab) this.tab = tab
    const top = document.querySelector<HTMLElement>('.topbar')?.offsetHeight ?? 56
    this.el.style.setProperty('--ws-top', `${top}px`)
    this.open = true
    this.el.hidden = false
    await this.refresh()
  }

  hide() {
    if (this.captain.dirty && !confirm('Leave without sending the new items?')) return
    this.open = false
    this.el.hidden = true
    this.modal.close()
    this.onClose()
  }

  /** Opens a particular order on the captain screen (from the kitchen panel or the 3D map). */
  async openOrder(id: string) {
    await this.captain.openOrder(id)
    await this.show('orders')
  }

  /** Reloads the visible screen (on open, tab change, or a live event from another tablet). */
  async refresh() {
    await this.guard(async () => {
      const r = await this.cached<{ outlets: Outlet[]; stations: Station[] }>('/api/fnb/outlets')
      this.outlets = r.outlets; this.stations = r.stations
      await this.views[this.tab].load()
    })
    this.render()
  }

  render() {
    if (!this.open) return
    const scroll = this.el.querySelector('.ws-body')?.scrollTop ?? 0
    const search = document.activeElement?.classList.contains('ws-search') ? (document.activeElement as HTMLInputElement).selectionStart : null
    this.el.innerHTML = `<header class="ws-head">
        <div class="ws-title">Restaurant</div>
        <nav class="ws-tabs" role="tablist">${this.tabs().map(([id, label]) => `<button type="button" role="tab" data-wstab="${id}" aria-selected="${id === this.tab}">${esc(label)}</button>`).join('')}</nav>
        <button type="button" class="dr-close" data-wsclose aria-label="Back to the 3D map">✕</button>
      </header>
      ${this.offline || this.outbox.queue.length ? `<div class="ws-offline" role="status">${this.offline ? 'No connection to the HMS. ' : ''}${this.outbox.queue.length ? `${this.outbox.queue.length} action${this.outbox.queue.length > 1 ? 's' : ''} waiting to send: ${this.outbox.queue.slice(0, 3).map((q) => esc(q.label)).join(', ')}${this.outbox.queue.length > 3 ? '…' : ''}. They go through by themselves when the connection is back.` : 'Showing the last copy this tablet saw.'}</div>` : ''}
      ${this.outbox.failed.length ? `<div class="ws-offline failed" role="alert">${this.outbox.failed.length} queued action${this.outbox.failed.length > 1 ? 's were' : ' was'} refused: ${this.outbox.failed.map((f) => `${esc(f.label)} (${esc(f.error)})`).join('; ')} <button type="button" class="btn small" data-wsdismiss>OK</button></div>` : ''}
      <div class="ws-body" data-tab="${this.tab}">${this.views[this.tab].html()}</div>`
    this.el.querySelector('.ws-body')!.scrollTop = scroll
    if (search !== null) { const i = this.el.querySelector<HTMLInputElement>('.ws-search'); i?.focus(); i?.setSelectionRange(search, search) }
  }

  private async guard(fn: () => Promise<void>) {
    if (this.busy) return
    this.busy = true
    try { await fn() } catch (e) { toast((e as Error).message) } finally { this.busy = false }
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement
    if (t.closest('[data-wsclose]')) { this.hide(); return }
    if (t.closest('[data-wsdismiss]')) { this.outbox.dismissFailed(); return }
    const tab = t.closest<HTMLElement>('[data-wstab]')?.dataset.wstab as Tab | undefined
    if (tab) { if (tab !== this.tab) { this.tab = tab; await this.refresh() } return }
    if (!t.closest('button, [data-item], [data-table], [data-order]')) return
    await this.guard(async () => { if (await this.views[this.tab].click(t)) this.render() })
  }
}
