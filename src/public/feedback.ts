import './guest.css'

// Feedback after the stay, from the link in the guest's thank-you message. A good score is asked to be
// shared on Google; a poor one reaches the manager at once.

const app = document.getElementById('g-app')!
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const q = new URLSearchParams(location.search)
const id = q.get('r') ?? '', token = q.get('t') ?? ''

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error ?? 'Something went wrong.')
  return j as T
}

async function start() {
  try {
    const b = await call<{ guest: string; resort: { name: string } }>('GET', `/public/bookings/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`)
    document.title = `Your stay · ${b.resort.name}`
    const head = `<header class="g-head"><span class="g-mark" aria-hidden="true"></span><div><h1>${esc(b.resort.name)}</h1><p>How was your stay, ${esc(b.guest.split(' ')[0])}?</p></div></header>`
    const stars = (k: string, label: string, required = false) => `<label class="full">${label}<select name="${k}" ${required ? 'required' : ''}><option value="">—</option>${[5, 4, 3, 2, 1].map((x) => `<option value="${x}">${'★'.repeat(x)}${'☆'.repeat(5 - x)}</option>`).join('')}</select></label>`
    app.innerHTML = `${head}<form class="g-card" id="g-fb"><div class="g-grid">${stars('overall', 'Overall', true)}${stars('room', 'Room')}${stars('cleanliness', 'Cleanliness')}${stars('food', 'Food')}${stars('service', 'Service')}
      <label class="full">Anything to tell us<textarea name="comment" rows="4" maxlength="2000"></textarea></label></div>
      <div class="g-actions"><button class="g-btn primary" type="submit">Send</button></div><p class="g-error" hidden></p></form>`
    const f = document.getElementById('g-fb') as HTMLFormElement
    f.addEventListener('submit', async (e) => {
      e.preventDefault()
      const v = (k: string) => (f.elements.namedItem(k) as HTMLSelectElement).value || undefined
      try {
        const r = await call<{ review: string | null }>('POST', `/public/bookings/${encodeURIComponent(id)}/feedback?t=${encodeURIComponent(token)}`, { overall: v('overall'), room: v('room'), cleanliness: v('cleanliness'), food: v('food'), service: v('service'), comment: (f.elements.namedItem('comment') as HTMLTextAreaElement).value || undefined })
        app.innerHTML = `${head}<div class="g-card"><h2 class="g-ok">Thank you</h2><p>The manager reads every message.</p>
          ${r.review ? `<p>Would you share your stay on Google? It helps other travellers find us.</p><div class="g-actions"><a class="g-btn primary" href="${esc(r.review)}" target="_blank" rel="noopener">Write a review</a></div>` : ''}</div>`
      } catch (x) { const err = f.querySelector<HTMLElement>('.g-error')!; err.textContent = (x as Error).message; err.hidden = false }
    })
  } catch (x) { app.innerHTML = `<div class="g-card"><p class="g-error">${esc((x as Error).message)}</p></div>` }
}
void start()
