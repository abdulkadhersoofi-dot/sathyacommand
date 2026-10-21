import './guest.css'

// The page behind the QR card in every room: ask housekeeping, order room service, report a problem, see
// what there is to do, and say how the stay is going. Only the guest staying in the room can send requests.

interface Page {
  resort: string; room: string; guest: string | null; departure: string | null; occupied: boolean; housekeeping: string[]
  menu: { id: string; name: string; price_paise: number; diet: string; category: string | null }[]
  activities: { id: string; name: string; price_paise: number; per: string; opens: string | null; closes: string | null; notes: string | null }[]
  open: { id: string; kind: string; items: { name: string; qty: number }[]; note: string | null; status: string }[]
}

const app = document.getElementById('g-app')!
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const q = new URLSearchParams(location.search)
const base = `/public/room/${encodeURIComponent(q.get('s') ?? '')}`, tok = `t=${encodeURIComponent(q.get('t') ?? '')}`
const KIND: Record<string, string> = { housekeeping: 'Housekeeping', food: 'Room service', maintenance: 'Something not working', other: 'Request' }
const DIET: Record<string, string> = { veg: '🟢', egg: '🟡', non_veg: '🔴' }
let tab: 'home' | 'hk' | 'food' | 'fix' | 'do' | 'say' = 'home'
let p: Page
const cart = new Map<string, number>()

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${path}${path.includes('?') ? '&' : '?'}${tok}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error ?? 'Something went wrong. Please call the front desk.')
  return j as T
}

function draw(msg = '') {
  const head = `<header class="g-head"><span class="g-mark" aria-hidden="true"></span><div><h1>${esc(p.resort)}</h1><p>Room ${esc(p.room)}${p.guest ? ` · Welcome, ${esc(p.guest)}` : ''}</p></div></header>`
  const back = tab === 'home' ? '' : '<button class="g-btn" type="button" data-tab="home">← Back</button>'
  const ok = msg ? `<p class="g-ok" role="status">${esc(msg)}</p>` : ''
  let body = ''
  if (!p.occupied && tab !== 'do') {
    body = `<div class="g-card"><p>Requests open once you have checked in. For anything now, please call the front desk.</p></div>
      <div class="g-card"><button class="g-plan" data-tab="do"><span>Things to do at the resort</span><b>→</b></button></div>`
  } else if (tab === 'home') {
    body = `${ok}<div class="g-card g-plans">${[['hk', 'Housekeeping', 'Towels, cleaning, pillows, water…'], ['food', 'Room service', 'Order food to your room'], ['fix', 'Something not working?', 'AC, lights, water, TV…'], ['do', 'Things to do', 'Pool, cricket, cycles, tours'], ['say', 'How is your stay?', 'Tell the manager']]
      .map(([k, t, s]) => `<button class="g-plan" data-tab="${k}"><span><b>${t}</b><br><small class="g-note">${s}</small></span><b>→</b></button>`).join('')}</div>
      ${p.open.length ? `<div class="g-card"><h2>On its way</h2>${p.open.map((r) => `<p>${esc(KIND[r.kind])}: ${esc(r.items.map((i) => `${i.name}${i.qty > 1 ? ` × ${i.qty}` : ''}`).join(', ') || r.note || '')} · <span class="g-note">${r.status === 'accepted' ? 'being handled' : 'received'}</span></p>`).join('')}</div>` : ''}`
  } else if (tab === 'hk') {
    body = `<form class="g-card" data-send="housekeeping"><h2>Housekeeping</h2><div class="g-grid">${p.housekeeping.map((h) => `<label class="g-check full"><input type="checkbox" name="hk" value="${esc(h)}"> ${esc(h)}</label>`).join('')}
      <label class="full">Anything else<input name="note" maxlength="200"></label></div><div class="g-actions">${back}<button class="g-btn primary" type="submit">Send</button></div><p class="g-error" hidden></p></form>`
  } else if (tab === 'food') {
    const cats = [...new Set(p.menu.map((m) => m.category ?? 'Menu'))]
    const total = [...cart].reduce((a, [id, n]) => a + (p.menu.find((m) => m.id === id)?.price_paise ?? 0) * n, 0)
    body = `<form class="g-card" data-send="food"><h2>Room service</h2>${cats.map((c) => `<h3 class="g-note">${esc(c)}</h3>${p.menu.filter((m) => (m.category ?? 'Menu') === c).map((m) => `<div class="g-plan"><span>${DIET[m.diet] ?? ''} ${esc(m.name)} <small class="g-note">${inr(m.price_paise)}</small></span>
        <span class="g-qty"><button type="button" class="g-btn" data-qty="${esc(m.id)}|-1" aria-label="Fewer">−</button><b>${cart.get(m.id) ?? 0}</b><button type="button" class="g-btn" data-qty="${esc(m.id)}|1" aria-label="More">+</button></span></div>`).join('')}`).join('') || '<p class="g-note">Room service is not open right now.</p>'}
      <div class="g-grid"><label class="full">Note for the kitchen<input name="note" maxlength="200" placeholder="Less spicy, no onion…"></label></div>
      <p class="g-note">${total ? `About ${inr(total)} before GST, added to your room bill once the order is confirmed.` : 'Prices before GST; the order is added to your room bill.'}</p>
      <div class="g-actions">${back}<button class="g-btn primary" type="submit" ${total ? '' : 'disabled'}>Place order</button></div><p class="g-error" hidden></p></form>`
  } else if (tab === 'fix') {
    body = `<form class="g-card" data-send="maintenance"><h2>Something not working?</h2><div class="g-grid"><label class="full">What is the problem<textarea name="note" rows="3" maxlength="300" required placeholder="The AC is not cooling"></textarea></label></div>
      <p class="g-note">The engineer on duty is told at once.</p><div class="g-actions">${back}<button class="g-btn primary" type="submit">Send</button></div><p class="g-error" hidden></p></form>`
  } else if (tab === 'do') {
    body = `<div class="g-card"><h2>Things to do</h2>${p.activities.map((a) => `<p><b>${esc(a.name)}</b><br><span class="g-note">${a.price_paise ? `${inr(a.price_paise)} per ${esc(a.per)}` : 'Free for guests'}${a.opens ? ` · ${esc(a.opens)}–${esc(a.closes ?? '')}` : ''}${a.notes ? ` · ${esc(a.notes)}` : ''}</span></p>`).join('')}
      <p class="g-note">To book, call the front desk; it goes on your room bill.</p><div class="g-actions"><button class="g-btn" type="button" data-tab="home">← Back</button></div></div>`
  } else if (tab === 'say') {
    const stars = (k: string, label: string, required = false) => `<label class="full">${label}<select name="${k}" ${required ? 'required' : ''}><option value="">—</option>${[5, 4, 3, 2, 1].map((x) => `<option value="${x}">${'★'.repeat(x)}${'☆'.repeat(5 - x)}</option>`).join('')}</select></label>`
    body = `<form class="g-card" data-send="feedback"><h2>How is your stay?</h2><div class="g-grid">${stars('overall', 'Overall', true)}${stars('room', 'Room')}${stars('cleanliness', 'Cleanliness')}${stars('food', 'Food')}${stars('service', 'Service')}
      <label class="full">Anything to tell the manager<textarea name="comment" rows="3" maxlength="1000"></textarea></label></div><div class="g-actions">${back}<button class="g-btn primary" type="submit">Send</button></div><p class="g-error" hidden></p></form>`
  }
  app.innerHTML = head + body
}

app.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')
  if (t) { tab = t.dataset.tab as typeof tab; draw(); return }
  const qty = (e.target as HTMLElement).closest<HTMLElement>('[data-qty]')?.dataset.qty
  if (qty) { const [id, d] = qty.split('|'); cart.set(id, Math.max(0, Math.min(20, (cart.get(id) ?? 0) + Number(d)))); draw() }
})
app.addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.target as HTMLFormElement, kind = f.dataset.send!, err = f.querySelector<HTMLElement>('.g-error')!
  const btn = f.querySelector<HTMLButtonElement>('button[type=submit]')!
  btn.disabled = true
  try {
    const note = (f.elements.namedItem('note') as HTMLInputElement | null)?.value || undefined
    if (kind === 'feedback') {
      const v = (k: string) => (f.elements.namedItem(k) as HTMLSelectElement).value || undefined
      const r = await call<{ review: string | null }>('POST', `${base}/feedback`, { overall: v('overall'), room: v('room'), cleanliness: v('cleanliness'), food: v('food'), service: v('service'), comment: (f.elements.namedItem('comment') as HTMLTextAreaElement).value || undefined })
      tab = 'home'; p = await call<Page>('GET', base); draw('Thank you. The manager reads every message.')
      if (r.review) app.insertAdjacentHTML('beforeend', `<div class="g-card"><p>Glad you are enjoying it. Would you share it on Google?</p><a class="g-btn primary" href="${esc(r.review)}" target="_blank" rel="noopener">Write a review</a></div>`)
      return
    }
    const items = kind === 'food' ? [...cart].filter(([, n]) => n > 0).map(([id, qty]) => ({ id, qty }))
      : kind === 'housekeeping' ? [...f.querySelectorAll<HTMLInputElement>('input[name=hk]:checked')].map((c) => ({ name: c.value })) : []
    await call('POST', `${base}/requests`, { kind, items, note })
    cart.clear(); tab = 'home'; p = await call<Page>('GET', base)
    draw(kind === 'food' ? 'Order sent: the kitchen will call to confirm.' : kind === 'maintenance' ? 'Sent: the engineer is on the way.' : 'Sent: housekeeping is on the way.')
  } catch (x) { err.textContent = (x as Error).message; err.hidden = false; btn.disabled = false }
})

async function start() {
  try { p = await call<Page>('GET', base); document.title = `Room ${p.room} · ${p.resort}`; draw() }
  catch (x) { app.innerHTML = `<div class="g-card"><p class="g-error">${esc((x as Error).message)}</p></div>` }
}
void start()
