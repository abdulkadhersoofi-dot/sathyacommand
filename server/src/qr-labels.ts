import qrcode from 'qrcode-generator'

// A printable sheet of QR labels to fix on site (cleaning points, patrol checkpoints).

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export function qrLabelsPage(title: string, hint: string, items: { name: string; code: string }[]) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      body{font:14px system-ui;margin:16px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
      .l{border:1px dashed #999;padding:12px;text-align:center;break-inside:avoid}.l svg{width:150px;height:150px}.n{font-weight:700;font-size:16px}.c{font:11px monospace;color:#555}
    </style></head><body><div class="grid">${items.map((a) => {
      const q = qrcode(0, 'M'); q.addData(a.code); q.make()
      return `<div class="l"><div class="n">${esc(a.name)}</div>${q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}<div>${esc(hint)}</div><div class="c">${esc(a.code)}</div></div>`
    }).join('')}</div><script>window.onload=()=>window.print()</script></body></html>`
}
