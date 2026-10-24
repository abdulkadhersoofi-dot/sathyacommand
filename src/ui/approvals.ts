import type { Api } from '../live/api'
import { esc, toast } from './dom'
import { FormModal } from './form-modal'

// The approval inbox: every request that waits for a manager (new devices, discounts above a limit, cancelled
// items after the KOT, price changes, counts, payments, purchase orders…) in one place, with Approve and Reject.
// The top-bar button shows how many wait for this person; it hides when there are none.

interface Item { id: string; kind: string; title: string; detail: string; reason: string | null; requested_by_name: string; created_at: string; canDecide: boolean }

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export class Approvals {
  private items: Item[] = []
  private modal = new FormModal()

  constructor(private api: Api, private btn: HTMLButtonElement) {
    btn.addEventListener('click', () => this.show())
    void this.refresh()
    setInterval(() => { if (!document.hidden) void this.refresh() }, 30_000)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.refresh() })
  }

  get waiting() { return this.items.filter((i) => i.canDecide).length }

  async refresh() {
    try { this.items = await this.api.get<Item[]>('/api/approvals') } catch { return }
    const n = this.waiting
    this.btn.hidden = !this.items.length
    this.btn.querySelector('.ib-count')!.textContent = n ? String(n) : ''
    this.btn.title = n ? `${n} request${n === 1 ? '' : 's'} waiting for your approval` : 'Your requests waiting for approval'
    if (this.modal.isOpen) this.render()
  }

  private card(i: Item) {
    return `<div class="row-card ap-card" data-ap="${esc(i.id)}"><div class="rc-title">${esc(i.title)}</div>
      <div class="rc-sub">${i.detail ? `${esc(i.detail)}<br>` : ''}Asked by ${esc(i.requested_by_name)} · ${esc(ago(i.created_at))}</div>
      ${i.canDecide ? `<div class="ap-actions"><input name="note-${esc(i.id)}" placeholder="Note (optional)" maxlength="200">
        <button type="button" class="btn small" data-reject="${esc(i.id)}">Reject</button><button type="button" class="btn small" data-approve="${esc(i.id)}">Approve</button></div>` : ''}</div>`
  }

  private render() {
    const mine = this.items.filter((i) => i.canDecide), others = this.items.filter((i) => !i.canDecide)
    const body = `${mine.length ? mine.map((i) => this.card(i)).join('') : '<div class="empty">Nothing waiting for you.</div>'}
      ${others.length ? `<div class="sec-title">Your requests, waiting for someone else <span>${others.length}</span></div>${others.map((i) => this.card(i)).join('')}` : ''}`
    const host = this.modal.el.querySelector<HTMLElement>('.ap-list')
    if (host) host.innerHTML = body
    return body
  }

  show() {
    const form = this.modal.open('Approvals', `<div class="ap-list">${this.render()}</div>`, 'Done', async () => '')
    form.addEventListener('click', async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-approve], [data-reject]')
      if (!b) return
      const id = b.dataset.approve ?? b.dataset.reject!
      const decision = b.dataset.approve ? 'approve' : 'reject'
      const note = (form.elements.namedItem(`note-${id}`) as HTMLInputElement | null)?.value.trim() || undefined
      b.disabled = true
      try {
        await this.api.post(`/api/approvals/${id}/decide`, { decision, note })
        toast(decision === 'approve' ? 'Approved' : 'Rejected')
        window.dispatchEvent(new CustomEvent('sathya:approval-decided'))
      } catch (x) { toast((x as Error).message) }
      await this.refresh()
    })
  }
}
