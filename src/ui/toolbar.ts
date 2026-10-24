import { esc } from './dom'

// One toolbar for every screen: the one or two things done most on the left (green), filters and search in
// the middle, and everything else under a single "More ▾" menu on the right, the dangerous ones last in red.
// A detail page shows its next steps in the order they happen, with the current one as the button to press.

export interface Action {
  /** The data attribute the screen already handles, e.g. `data-evact="pay"`. */
  attrs: string
  label: string
  primary?: boolean
  danger?: boolean
  title?: string
  disabled?: boolean
  /** A file to pick: the button is a label around a hidden file input with these attributes (e.g. `name="csv" accept=".csv"`). */
  file?: string
  /** The form this button submits, when it sits outside it. */
  form?: string
}

const button = (a: Action, cls: string) =>
  a.file
    ? `<label class="${cls}${a.danger ? ' danger' : ''} file-btn" ${a.attrs}${a.title ? ` title="${esc(a.title)}"` : ''}><input type="file" ${a.file} hidden>${esc(a.label)}</label>`
    : `<button type="${a.form ? 'submit' : 'button'}" class="${cls}${a.danger ? ' danger' : ''}" ${a.attrs}${a.form ? ` form="${esc(a.form)}"` : ''}${a.title ? ` title="${esc(a.title)}"` : ''}${a.disabled ? ' disabled' : ''}>${esc(a.label)}</button>`

/**
 * A row's own menu (rule 2: a row carries one button, the rest go here): a small "⋯" that opens the list,
 * the dangerous items last in red. Returns '' when there is nothing to put in it.
 */
export function rowMenu(items: (Action | false | null | undefined)[], label = '⋯', cls = 'btn small') {
  const list = items.filter((a): a is Action => !!a)
  if (!list.length) return ''
  const plain = list.filter((a) => !a.danger), danger = list.filter((a) => a.danger)
  return `<details class="menu row-menu"><summary class="${cls}" aria-label="More">${esc(label)}</summary><div class="menu-list" role="menu">
      ${plain.map((a) => button(a, 'menu-row')).join('')}${plain.length && danger.length ? '<div class="menu-sep"></div>' : ''}${danger.map((a) => button(a, 'menu-row')).join('')}</div></details>`
}

/** Up to two primary actions, then filters, then the rest under More ▾ (danger last). Empty groups are left out. */
export function toolbar(o: { primary?: Action[]; filters?: string; more?: Action[]; end?: string }) {
  const primary = (o.primary ?? []).map((a) => button(a, `btn${a.primary === false ? '' : ' primary'}`)).join('')
  const more = (o.more ?? []).filter(Boolean)
  const plain = more.filter((a) => !a.danger), danger = more.filter((a) => a.danger)
  const menu = more.length ? `<details class="menu"><summary class="btn">More ▾</summary><div class="menu-list" role="menu">
      ${plain.map((a) => button(a, 'menu-row')).join('')}${plain.length && danger.length ? '<div class="menu-sep"></div>' : ''}${danger.map((a) => button(a, 'menu-row')).join('')}</div></details>` : ''
  if (!primary && !o.filters && !menu && !o.end) return ''
  return `<div class="tb">${primary ? `<div class="tb-primary">${primary}</div>` : ''}${o.filters ? `<div class="tb-mid">${o.filters}</div>` : ''}
    ${menu || o.end ? `<div class="tb-end">${o.end ?? ''}${menu}</div>` : ''}</div>`
}

export interface Step {
  label: string
  /** done: finished; now: the next thing to do (a button when `attrs` is given); todo: later; skip: not needed. */
  state: 'done' | 'now' | 'todo' | 'skip'
  attrs?: string
  title?: string
}

/** The steps of a process as a row: ticked, the current one highlighted and pressable, the rest to come. */
export function steps(list: Step[]) {
  return `<div class="steps" role="list">${list.map((s, i) => {
    const inner = `<span class="n">${s.state === 'done' ? '✓' : i + 1}</span>${esc(s.label)}`
    const cls = `step ${s.state}`
    const el = s.state === 'now' && s.attrs ? `<button type="button" class="${cls}" ${s.attrs}${s.title ? ` title="${esc(s.title)}"` : ''}>${inner}</button>` : `<span class="${cls}" role="listitem"${s.title ? ` title="${esc(s.title)}"` : ''}>${inner}</span>`
    return (i ? '<span class="step-sep"></span>' : '') + el
  }).join('')}</div>`
}

/** Closes any open More ▾ menu when something else is tapped. */
export function watchMenus() {
  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) if (!d.contains(e.target as Node) || (e.target as HTMLElement).closest('.menu-row')) d.open = false
  })
}
