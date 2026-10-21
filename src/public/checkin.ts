import './guest.css'

// Online check-in from the guest's signed link: arrival time, ID, address, purpose, preferences and a
// company for the bill, so the desk only has to see the ID and hand over the key.

const app = document.getElementById('g-app')!
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const q = new URLSearchParams(location.search)
const id = q.get('r') ?? '', token = q.get('t') ?? ''

interface Booking { id: string; status: string; guest: string; arrival: string; departure: string; room_type: string; adults: number; children: number; nationality: string; resort: { name: string; address: string | null; city: string | null }; checkedInOnline: string | null }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error ?? 'Something went wrong. Please call the resort.')
  return j as T
}

const head = (b?: Booking) => `<header class="g-head"><span class="g-mark" aria-hidden="true"></span><div><h1>${esc(b?.resort.name ?? 'Online check-in')}</h1><p>Online check-in${b?.resort.city ? ` · ${esc(b.resort.city)}` : ''}</p></div></header>`

function form(b: Booking, error = '') {
  const foreign = b.nationality && b.nationality !== 'IN'
  app.innerHTML = `${head(b)}<div class="g-card"><dl class="g-sum"><dt>Booking</dt><dd class="mono">${esc(b.id)}</dd><dt>Guest</dt><dd>${esc(b.guest)}</dd><dt>Room</dt><dd>${esc(b.room_type)}</dd>
      <dt>Dates</dt><dd>${day(b.arrival)} to ${day(b.departure)}</dd></dl>${b.checkedInOnline ? '<p class="g-ok">You have checked in online. You can change the details below.</p>' : ''}</div>
    <form class="g-card" id="g-ci"><h2>Before you arrive</h2><div class="g-grid">
      <label>Arrival time<input name="eta" type="time" value="14:00"></label>
      <label>Nationality<select name="nat"><option value="IN" ${foreign ? '' : 'selected'}>Indian</option><option value="OTHER" ${foreign ? 'selected' : ''}>Another country</option></select></label>
      <label data-country ${foreign ? '' : 'hidden'}>Country code (GB, US, AE…)<input name="country" maxlength="2" value="${foreign ? esc(b.nationality) : ''}"></label>
      <label>ID you will bring<select name="idType"><option value="aadhaar">Aadhaar</option><option value="passport">Passport</option><option value="driving_licence">Driving licence</option><option value="voter_id">Voter ID</option></select></label>
      <label>ID number<input name="idNumber" autocomplete="off" inputmode="text"></label>
      <label class="full">Home address<input name="address" maxlength="300" autocomplete="street-address"></label>
      <label>Purpose of visit<select name="purpose"><option>Leisure</option><option>Business</option><option>Wedding or event</option><option>Other</option></select></label>
      <label>Company (for a GST bill)<input name="company" maxlength="120"></label>
      <label>Company GSTIN<input name="gstin" maxlength="15"></label>
      <label class="full">Preferences<textarea name="prefs" rows="2" maxlength="500" placeholder="Twin beds, ground floor, Jain food, a cot…"></textarea></label>
      <label class="full g-check"><input type="checkbox" name="consent"> I agree to the resort keeping these details for my stay, as the law requires for hotel guests.</label></div>
      <p class="g-note">Only the type of ID and its last four characters are kept; please bring the ID itself. Guests from outside India bring their passport and visa (the resort files Form C).</p>
      <div class="g-actions"><button class="g-btn primary" type="submit">Check in</button></div><p class="g-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p></form>`
  const f = document.getElementById('g-ci') as HTMLFormElement
  const country = app.querySelector<HTMLElement>('[data-country]')!
  f.nat.addEventListener('change', () => { country.hidden = f.nat.value === 'IN'; if (f.nat.value !== 'IN') f.idType.value = 'passport' })
  f.addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = f.querySelector<HTMLButtonElement>('button[type=submit]')!
    btn.disabled = true
    try {
      await call('POST', `/public/bookings/${encodeURIComponent(id)}/checkin?t=${encodeURIComponent(token)}`, {
        eta: f.eta.value || undefined, nationality: f.nat.value === 'IN' ? 'IN' : String(f.country.value).toUpperCase(), idType: f.idType.value, idNumber: f.idNumber.value,
        address: f.address.value, purpose: f.purpose.value, company: f.company.value || undefined, gstin: f.gstin.value || undefined, preferences: f.prefs.value || undefined, consent: f.consent.checked })
      app.innerHTML = `${head(b)}<div class="g-card"><h2 class="g-ok">You are checked in online</h2><p>See you on ${day(b.arrival)}. At the desk, show your ID and collect your key.</p>
        ${b.resort.address ? `<p class="g-note">${esc(b.resort.address)}${b.resort.city ? `, ${esc(b.resort.city)}` : ''}</p>` : ''}</div>`
    } catch (x) {
      // Keep what the guest typed: show the problem in place.
      const err = f.querySelector<HTMLElement>('.g-error')!
      err.textContent = (x as Error).message; err.hidden = false; btn.disabled = false
    }
  })
}

async function start() {
  try {
    const b = await call<Booking>('GET', `/public/bookings/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`)
    document.title = `Online check-in · ${b.resort.name}`
    if (b.status !== 'confirmed') { app.innerHTML = `${head(b)}<div class="g-card"><p>${b.status === 'in_house' ? 'You are already checked in. Enjoy your stay.' : 'This booking is not open for check-in. Please call the resort.'}</p></div>`; return }
    form(b)
  } catch (x) { app.innerHTML = `${head()}<div class="g-card"><p class="g-error">${esc((x as Error).message)}</p></div>` }
}
void start()
