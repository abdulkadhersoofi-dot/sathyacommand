import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import { esc, toast } from '../ui/dom'
import { FormModal } from '../ui/form-modal'
import { CaptainView } from './captain'
import type { Outlet, Station, Ws } from './common'
import { KitchenView } from './kitchen'
import { MenuView } from './menu'
import { SettingsView } from './settings'

// The restaurant workspace: a full-screen layer over the 3D map with Orders (captain tablet),
// Kitchen (kitchen and bar screens), Menu and Licences & tax. Each tab shows only to roles that use it.

type Tab = 'orders' | 'kitchen' | 'menu' | 'settings'
interface View { load(): Promise<void>; html(): string; click(t: HTMLElement): Promise<boolean> }

export class FnbWorkspace implements Ws {
  outlets: Outlet[] = []
  stations: Station[] = []
  modal = new FormModal()
  open = false
  private el: HTMLElement
  private tab: Tab
  private views: Record<Tab, View & Partial<{ onInput(t: HTMLElement): void; tick(): void; submit(f: HTMLFormElement): Promise<boolean> }>>
  private captain: CaptainView
  private busy = false

  constructor(public api: Api, public me: Me, public inHouse: Ws['inHouse'], private onClose: () => void) {
    this.captain = new CaptainView(this)
    this.views = { orders: this.captain, kitchen: new KitchenView(this), menu: new MenuView(this), settings: new SettingsView(this) }
    this.tab = this.tabs()[0]?.[0] ?? 'settings'
    this.el = document.createElement('section')
    this.el.className = 'ws'
    this.el.hidden = true
    this.el.setAttribute('aria-label', 'Restaurant')
    document.getElementById('app')!.appendChild(this.el)
    this.el.addEventListener('click', (e) => void this.onClick(e))
    this.el.addEventListener('input', (e) => this.views[this.tab].onInput?.(e.target as HTMLElement))
    this.el.addEventListener('submit', (e) => {
      e.preventDefault()
      void this.guard(async () => { if (await this.views[this.tab].submit?.(e.target as HTMLFormElement)) { this.render(); toast('Saved') } })
    })
    setInterval(() => { if (this.open) this.views[this.tab].tick?.() }, 20_000)
  }

  can(...permissions: string[]) { return this.me.permissions.includes('*') || permissions.some((p) => this.me.permissions.includes(p)) }

  tabs(): [Tab, string][] {
    const t: [Tab, string][] = []
    if (this.can('fnb.order')) t.push(['orders', 'Orders'])
    if (this.can('kitchen', 'fnb.order')) t.push(['kitchen', 'Kitchen & bar'])
    if (this.can('menu.edit', 'menu.price')) t.push(['menu', 'Menu'])
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
      const r = await this.api.get<{ outlets: Outlet[]; stations: Station[] }>('/api/fnb/outlets')
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
    const tab = t.closest<HTMLElement>('[data-wstab]')?.dataset.wstab as Tab | undefined
    if (tab) { if (tab !== this.tab) { this.tab = tab; await this.refresh() } return }
    if (!t.closest('button, [data-item], [data-table], [data-order]')) return
    await this.guard(async () => { if (await this.views[this.tab].click(t)) this.render() })
  }
}
