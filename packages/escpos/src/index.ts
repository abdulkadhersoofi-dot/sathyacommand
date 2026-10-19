// Device-independent print documents and their ESC/POS encoding for 58 / 80 mm thermal printers
// (kitchen, bar and bill printers on the resort network, port 9100).

export interface PrintLine {
  text: string
  align?: 'left' | 'center' | 'right'
  bold?: boolean
  /** Double width and height, for ticket numbers and table names. */
  big?: boolean
}

export interface PrintDoc {
  /** Characters per line at normal size: 48 on 80 mm paper, 32 on 58 mm. */
  width: number
  lines: PrintLine[]
  cut?: boolean
  beep?: boolean
}

const ESC = 0x1b, GS = 0x1d

/** Printers in text mode speak ASCII: rupee sign and other symbols are spelt out, anything else dropped. */
export function toAscii(s: string) {
  return s.replace(/₹/g, 'Rs.').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/×/g, 'x').replace(/·/g, '-')
    .normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/ {2,}/g, ' ')
}

/** Word-wraps a line to the printer width. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (!word) continue
    if (word.length > width) { if (line) out.push(line); for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width)); line = ''; continue }
    if ((line ? line.length + 1 : 0) + word.length > width) { out.push(line); line = word } else line = line ? `${line} ${word}` : word
  }
  if (line || !out.length) out.push(line)
  return out
}

/** "Masala Dosa ......... 140.00" style line: left text, right text, padded to the width. */
export function twoCol(left: string, right: string, width: number) {
  const r = toAscii(right), room = width - r.length - 1
  const ls = wrap(toAscii(left), Math.max(8, room))
  const last = ls.pop()!
  return [...ls, last.padEnd(width - r.length) + r]
}

export function encode(doc: PrintDoc): Uint8Array {
  const bytes: number[] = [ESC, 0x40]                      // initialise
  if (doc.beep) bytes.push(ESC, 0x42, 2, 2)                  // buzzer on kitchen printers that have one
  for (const l of doc.lines) {
    const width = l.big ? Math.floor(doc.width / 2) : doc.width
    bytes.push(ESC, 0x61, l.align === 'center' ? 1 : l.align === 'right' ? 2 : 0)
    bytes.push(ESC, 0x45, l.bold ? 1 : 0)
    bytes.push(GS, 0x21, l.big ? 0x11 : 0x00)
    for (const part of wrap(toAscii(l.text), width)) {
      for (const ch of part) bytes.push(ch.charCodeAt(0))
      bytes.push(0x0a)
    }
  }
  bytes.push(ESC, 0x45, 0, GS, 0x21, 0, ESC, 0x61, 0)
  if (doc.cut !== false) bytes.push(0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00)   // feed and partial cut
  return Uint8Array.from(bytes)
}

/** Plain-text preview of a document (what the paper shows). */
export function preview(doc: PrintDoc) {
  return doc.lines.flatMap((l) => {
    const width = l.big ? Math.floor(doc.width / 2) : doc.width
    return wrap(toAscii(l.text), width).map((p) => {
      const pad = l.align === 'center' ? Math.floor((width - p.length) / 2) : l.align === 'right' ? width - p.length : 0
      return ' '.repeat(Math.max(0, pad)) + p
    })
  }).join('\n')
}
