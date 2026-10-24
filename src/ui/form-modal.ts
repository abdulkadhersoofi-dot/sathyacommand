import { esc, toast } from './dom'

// One modal form at a time: title, body, Cancel / submit. onSubmit returns a toast message (or '')
// to close, or undefined to keep the modal open (e.g. after replacing it with a result).

export class FormModal {
  readonly el: HTMLDivElement

  constructor() {
    this.el = document.createElement('div')
    this.el.className = 'modal fd-modal'
    this.el.hidden = true
    document.getElementById('app')!.appendChild(this.el)
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close() })
  }

  get isOpen() { return !this.el.hidden }

  /**
   * `opts`: extra footer HTML (left of Cancel); `danger` makes the submit red for a step that undoes or removes
   * something; `cancelLabel` names the way out ("Keep it") so two "Cancel" buttons never sit side by side.
   */
  open(title: string, body: string, submitLabel: string, onSubmit: (f: HTMLFormElement) => Promise<string | void>, opts: string | { extra?: string; danger?: boolean; cancelLabel?: string } = '') {
    const o = typeof opts === 'string' ? { extra: opts } : opts
    this.el.innerHTML = `<form class="pin-card fd-card" novalidate>
      <div class="fd-head"><div class="pin-title">${esc(title)}</div><button type="button" class="dr-close" data-x aria-label="Close">✕</button></div>
      ${body}<div class="pin-error" hidden></div>
      <div class="pin-actions">${o.extra ?? ''}${submitLabel === 'Done' ? '' : `<button type="button" class="btn ghost" data-x>${esc(o.cancelLabel ?? 'Cancel')}</button>`}<button type="submit" class="btn ${o.danger ? 'danger' : 'primary'}">${esc(submitLabel)}</button></div></form>`
    this.el.hidden = false
    const form = this.el.querySelector('form')!
    form.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => this.close()))
    form.querySelector<HTMLInputElement>('input, select')?.focus()
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const btn = form.querySelector<HTMLButtonElement>('button[type=submit]')!
      const err = form.querySelector<HTMLElement>('.pin-error')!
      btn.disabled = true
      err.hidden = true
      try {
        const msg = await onSubmit(form)
        if (msg !== undefined) { this.close(); if (msg) toast(msg) }
      } catch (x) {
        err.textContent = (x as Error).message
        err.hidden = false
      } finally { btn.disabled = false }
    })
    return form
  }

  close() { this.el.hidden = true; this.el.innerHTML = '' }
}

/** Trimmed value of a named field. */
export const val = (f: HTMLFormElement, name: string) => (f.elements.namedItem(name) as HTMLInputElement | null)?.value.trim() ?? ''
export const checked = (f: HTMLFormElement, name: string) => (f.elements.namedItem(name) as HTMLInputElement | null)?.checked ?? false

/** A red "are you sure" for a step that removes or undoes something: the question, one line of why, and the deed as the button. */
export function confirmDanger(modal: FormModal, title: string, why: string, deed: string, go: () => Promise<string | void>, keep = 'Keep it') {
  modal.open(title, `<p>${esc(why)}</p>`, deed, go, { danger: true, cancelLabel: keep })
}
