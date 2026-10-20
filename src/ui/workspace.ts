import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import { isNetworkError } from '../live/api'
import type { Outbox } from '../live/outbox'
import { esc, toast } from './dom'
import { FormModal } from './form-modal'

// A full-screen working area over the 3D map (Restaurant, Housekeeping, …): tabs shown by role, one
// form modal, an offline strip, and screens that keep their last copy when the connection drops.

export interface View {
  load(): Promise<void>
  html(): string
  click(t: HTMLElement): Promise<boolean>
  onInput?(t: HTMLElement): void
  tick?(): void
  submit?(f: HTMLFormElement): Promise<boolean>
  change?(t: HTMLElement): Promise<boolean>
  /** Called after the screen is drawn (e.g. to load photos). */
  mounted?(root: HTMLElement): void
}

export interface WorkspaceHost {
  api: Api
  me: Me
  modal: FormModal
  outbox: Outbox
  offline: boolean
  can(...permissions: string[]): boolean
  cached<T>(path: string): Promise<T>
  render(): void
}

export abstract class Workspace<Tab extends string> implements WorkspaceHost {
  modal = new FormModal()
  open = false
  offline = false
  protected tab!: Tab
  protected abstract views: Record<Tab, View>
  private el: HTMLElement
  private busy = false

  constructor(public api: Api, public me: Me, public outbox: Outbox, private title: string, private onClose: () => void) {
    this.outbox.onChange(() => { if (this.open) { if (!this.outbox.queue.length) void this.refresh(); else this.render() } })
    this.el = document.createElement('section')
    this.el.className = 'ws'
    this.el.hidden = true
    this.el.setAttribute('aria-label', title)
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

  abstract tabs(): [Tab, string][]
  /** Data every tab needs, loaded before the tab's own. */
  protected async beforeLoad() {}
  /** False to keep the workspace open (e.g. unsent items). */
  protected canLeave() { return true }

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
      if (copy == null) throw new Error('No connection to the HMS, and this screen has not been opened on this device before.')
      return JSON.parse(copy) as T
    }
  }

  can(...permissions: string[]) { return this.me.permissions.includes('*') || permissions.some((p) => this.me.permissions.includes(p)) }

  async show(tab?: Tab) {
    if (tab) this.tab = tab
    if (!this.tabs().some(([id]) => id === this.tab)) this.tab = this.tabs()[0][0]
    const top = document.querySelector<HTMLElement>('.topbar')?.offsetHeight ?? 56
    this.el.style.setProperty('--ws-top', `${top}px`)
    this.open = true
    this.el.hidden = false
    await this.refresh()
  }

  hide() {
    if (!this.canLeave()) return
    this.open = false
    this.el.hidden = true
    this.modal.close()
    this.onClose()
  }

  /** Reloads the visible screen (on open, tab change, or a live event from another device). */
  async refresh() {
    // Another action is still running: try again shortly rather than draw a screen whose data is not loaded.
    if (this.busy) { setTimeout(() => { if (this.open) void this.refresh() }, 300); return }
    const tab = this.tab
    await this.guard(async () => {
      await this.beforeLoad()
      await this.views[tab].load()
    })
    // The tab changed while loading: that tab's own refresh draws it.
    if (tab === this.tab) this.render()
  }

  render() {
    if (!this.open) return
    const scroll = this.el.querySelector('.ws-body')?.scrollTop ?? 0
    const search = document.activeElement?.classList.contains('ws-search') ? (document.activeElement as HTMLInputElement).selectionStart : null
    this.el.innerHTML = `<header class="ws-head">
        <div class="ws-title">${esc(this.title)}</div>
        <nav class="ws-tabs" role="tablist">${this.tabs().map(([id, label]) => `<button type="button" role="tab" data-wstab="${id}" aria-selected="${id === this.tab}">${esc(label)}</button>`).join('')}</nav>
        <button type="button" class="dr-close" data-wsclose aria-label="Back to the 3D map">✕</button>
      </header>
      ${this.offline || this.outbox.queue.length ? `<div class="ws-offline" role="status">${this.offline ? 'No connection to the HMS. ' : ''}${this.outbox.queue.length ? `${this.outbox.queue.length} action${this.outbox.queue.length > 1 ? 's' : ''} waiting to send: ${this.outbox.queue.slice(0, 3).map((q) => esc(q.label)).join(', ')}${this.outbox.queue.length > 3 ? '…' : ''}. They go through by themselves when the connection is back.` : 'Showing the last copy this device saw.'}</div>` : ''}
      ${this.outbox.failed.length ? `<div class="ws-offline failed" role="alert">${this.outbox.failed.length} queued action${this.outbox.failed.length > 1 ? 's were' : ' was'} refused: ${this.outbox.failed.map((f) => `${esc(f.label)} (${esc(f.error)})`).join('; ')} <button type="button" class="btn small" data-wsdismiss>OK</button></div>` : ''}
      <div class="ws-body" data-tab="${this.tab}">${this.views[this.tab].html()}</div>`
    const body = this.el.querySelector<HTMLElement>('.ws-body')!
    body.scrollTop = scroll
    if (search !== null) { const i = this.el.querySelector<HTMLInputElement>('.ws-search'); i?.focus(); i?.setSelectionRange(search, search) }
    this.views[this.tab].mounted?.(body)
  }

  protected async guard(fn: () => Promise<void>) {
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
    if (!t.closest('button, [data-item], [data-table], [data-order], [data-room], [data-ticket], [data-asset], [data-plan], [data-cal], [data-ic], [data-is], [data-ps], [data-mk], [data-bs]')) return
    await this.guard(async () => { if (await this.views[this.tab].click(t)) this.render() })
  }
}
