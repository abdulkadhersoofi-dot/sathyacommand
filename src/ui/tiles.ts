import { esc } from './dom'

// Big coloured tiles with a picture and two words: the "do" buttons for hand-held screens and the map's
// drawers (docs/BUTTONS.md, rules 4 and 6). One colour each, for one meaning.

export const ICON: Record<string, string> = {
  broom: '<svg viewBox="0 0 24 24"><path d="M3 21l6-6M9 15l6-6m0 0l4-4m-4 4l5 5M3 21c2-5 5-6 8-4s4 5 2 7"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg>',
  double: '<svg viewBox="0 0 24 24"><path d="M2 12l5 5 7-7M9 17l2 2 11-11"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4M3 3l18 18"/></svg>',
  bed: '<svg viewBox="0 0 24 24"><path d="M3 18V8M3 12h18v6M7 12V9h5v3M21 18v-2"/></svg>',
  wrench: '<svg viewBox="0 0 24 24"><path d="M14 7a4 4 0 0 1 5 5l-9 9-5-5 9-9zM3 21l5-5"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M9 14h2M13 14h2M9 17h2"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h12l-2 4 2 4H5"/></svg>',
  tray: '<svg viewBox="0 0 24 24"><path d="M3 17h18M5 17a7 7 0 0 1 14 0M12 10V8M8 21h8"/></svg>',
  key: '<svg viewBox="0 0 24 24"><path d="M15 7a4 4 0 1 1-2.8 6.8L4 22l-1-1 2-2 2 2 2-2-2-2 2-2 2.2 2.2A4 4 0 0 1 15 7z"/></svg>',
  rupee: '<svg viewBox="0 0 24 24"><path d="M6 4h12M6 9h12M6 4c6 0 8 2 8 5s-2 5-8 5l8 7"/></svg>',
}

/** A tile: `attrs` is the data attribute that names the action, `tone` the CSS colour variable. */
export const tile = (attrs: string, icon: string, label: string, sub: string, tone: string) =>
  `<button type="button" class="hk-tile" ${attrs} style="--tile: var(${tone})">${ICON[icon] ?? ''}<b>${esc(label)}</b><small>${esc(sub)}</small></button>`
