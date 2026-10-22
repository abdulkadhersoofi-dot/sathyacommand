import { esc } from '../ui/dom'
import { val } from '../ui/form-modal'
import { steps, type Step } from '../ui/toolbar'
import { money } from '../acc/books'
import { STYLE_LABEL, type Venue } from './calendar'
import type { BqHost } from './workspace'

// Booking an event in three short steps on one sheet: who, where and when, confirm. The venue is checked
// as the form fills in, so a clash shows at once with the other venues that are free, not after Save.

export interface Pkg { id: string; name: string; kind: string; price_paise: number; per: string; veg: boolean | null; min_pax: number; active: boolean }
interface Clash { functionId: string; name: string; eventId: string; number: string; title: string; status: string; startsAt: string; endsAt: string; firm: boolean }

const KINDS: [string, string][] = [['wedding', 'Wedding'], ['reception', 'Reception'], ['engagement', 'Engagement'], ['birthday', 'Birthday'], ['corporate', 'Corporate'], ['conference', 'Conference'], ['social', 'Social'], ['other', 'Other']]
const SOURCES: [string, string][] = [['walk_in', 'Walk-in'], ['phone', 'Phone'], ['website', 'Website'], ['referral', 'Referral'], ['planner', 'Wedding planner'], ['repeat', 'Repeat client'], ['corporate', 'Corporate account']]
const SLOTS: [string, string, string, string][] = [['morning', 'Morning', '06:00', '11:00'], ['afternoon', 'Afternoon', '12:00', '16:00'], ['evening', 'Evening', '18:00', '23:00'], ['day', 'Full day', '09:00', '23:00'], ['custom', 'Other times', '', '']]
const opt = (pairs: [string, string][], sel?: string | null) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('')
const num = (f: HTMLFormElement, k: string) => (val(f, k) === '' ? undefined : Number(val(f, k)))
const istTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })

export function bookingSheet(h: BqHost, venues: Venue[], pkgs: Pkg[], onSaved: (id: string) => Promise<void>, preset: { venueId?: string; date?: string } = {}) {
  let pane = 1
  const menuOpts = `<option value="">No menu yet</option>${pkgs.filter((p) => p.kind === 'menu' && p.active).map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ${money(p.price_paise)}/${p.per}${p.min_pax ? ` (min ${p.min_pax})` : ''}</option>`).join('')}`
  const tiles = venues.map((v) => `<button type="button" class="venue-tile" data-venue="${esc(v.id)}" aria-pressed="${v.id === preset.venueId}"><b>${esc(v.name)}</b><span>${v.capacity ? `up to ${v.capacity}` : esc(v.kind)}${v.rental_paise ? ` · ${money(v.rental_paise)}` : ''}</span></button>`).join('')
  const body = `<div class="bk-steps" data-bk-steps></div>
    <section data-pane="1">
      <div class="form-grid">
        <div class="span2"><div class="sec-title">What kind of event</div><div class="ws-chips bk-chips" data-kinds>${KINDS.map(([v, l], i) => `<button type="button" class="chip" data-kind="${v}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div><input type="hidden" name="kind" value="wedding"></div>
        <label>Client's name<input name="client" maxlength="120" required autocomplete="off"></label>
        <label>Mobile<input name="mobile" inputmode="tel" placeholder="98400 12345"></label>
        <label>How they came<select name="source">${opt(SOURCES, 'phone')}</select></label>
        <label>Event name (optional)<input name="title" maxlength="120" placeholder="Ravi and Priya wedding"></label>
      </div>
    </section>
    <section data-pane="2" hidden>
      <div class="sec-title">The venue</div>
      <div class="venue-tiles" data-tiles>${tiles}</div><input type="hidden" name="venue0" value="${esc(preset.venueId ?? '')}">
      <div class="form-grid">
        <label>Function<input name="fname0" maxlength="60" value="Reception" placeholder="Reception, Muhurtham…"></label>
        <label>Day<input name="date0" type="date" value="${esc(preset.date ?? '')}" required></label>
        <div class="span2"><div class="sec-title">When</div><div class="ws-chips bk-chips" data-slots>${SLOTS.map(([v, l], i) => `<button type="button" class="chip" data-slot="${v}" aria-pressed="${i === 2}">${l}</button>`).join('')}</div>
          <div class="bq-times" data-times hidden><input name="from0" type="time" value="18:00" aria-label="From"><input name="to0" type="time" value="23:00" aria-label="To"></div></div>
        <label>Guests<input name="pax0" type="number" min="1" inputmode="numeric" required></label>
        <label>Setup<select name="style0">${opt(Object.entries(STYLE_LABEL), 'rounds')}</select></label>
      </div>
      <p class="bk-avail" data-avail="0" aria-live="polite"></p>
      <details class="bq-more" data-fn2><summary>Another function on this booking (the muhurtham that morning, the sangeet the night before)</summary><div class="form-grid">
        <label>Function<input name="fname1" maxlength="60" placeholder="Muhurtham"></label>
        <label>Venue<select name="venue1"><option value="">—</option>${venues.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}${v.capacity ? ` (up to ${v.capacity})` : ''}</option>`).join('')}</select></label>
        <label>Day<input name="date1" type="date" value="${esc(preset.date ?? '')}"></label>
        <label>From – to<span class="bq-times"><input name="from1" type="time" value="06:00"><input name="to1" type="time" value="11:00"></span></label>
        <label>Guests<input name="pax1" type="number" min="1" inputmode="numeric"></label>
        <label>Setup<select name="style1">${opt(Object.entries(STYLE_LABEL), 'rounds')}</select></label></div>
        <p class="bk-avail" data-avail="1" aria-live="polite"></p></details>
    </section>
    <section data-pane="3" hidden>
      <div class="bk-summary" data-summary></div>
      <div class="form-grid">
        <label class="span2">Menu (price a plate)<select name="menu0">${menuOpts}</select></label>
        <label>Discount %<input name="disc" type="number" min="0" max="50" step="0.5" value="0"></label>
        <label>Company (for the bill)<input name="company" maxlength="120"></label>
        <label>GSTIN<input name="gstin" maxlength="15"></label>
        <label>Email<input name="email" type="email"></label>
      </div>
      <p class="bq-estimate small" data-estimate></p>
      <div class="sec-title">What happens now</div>
      <div class="bq-action">${[['book', 'Book now', 'the contract is signed: the dates are theirs'], ['hold', 'Hold the dates', 'kept for a few days while they decide'], ['enquiry', 'Just an enquiry', 'pencilled; nothing is kept']].map(([v, l, t], i) =>
        `<label class="check"><input type="radio" name="action" value="${v}" ${i === 0 ? 'checked' : ''}> <b>${l}</b> <small class="muted">${t}</small></label>`).join('')}</div>
      <div class="form-grid" data-advance><label>Advance received now (₹)<input name="adv" type="number" min="0" inputmode="numeric"></label><label>Paid by<select name="method">${opt([['upi', 'UPI'], ['cash', 'Cash'], ['card', 'Card'], ['bank', 'Bank transfer'], ['cheque', 'Cheque']], 'upi')}</select></label>
        <label class="span2">Reference (UTR, cheque or card approval)<input name="ref" maxlength="80"></label></div>
    </section>`

  const form = h.modal.open('Book an event', body, 'Next', async (f) => {
    if (pane < 3) { if (!validate(f)) throw new Error(pane === 1 ? 'The client\'s name, to start with.' : 'Pick the venue, the day, the times and how many guests.'); go(pane + 1); return undefined }
    const fns = [0, 1].filter((i) => val(f, `venue${i}`) && (i === 0 || val(f, `date${i}`))).map((i) => ({ name: val(f, `fname${i}`) || 'Function', venueId: val(f, `venue${i}`), date: val(f, `date${i}`), from: val(f, `from${i}`), to: val(f, `to${i}`),
      style: val(f, `style${i}`), expectedPax: num(f, `pax${i}`), menuId: i === 0 ? val(f, 'menu0') || null : null }))
    const action = (f.querySelector<HTMLInputElement>('input[name=action]:checked')?.value ?? 'book') as 'book' | 'hold' | 'enquiry'
    const adv = num(f, 'adv')
    const r = await h.api.post<{ id: string; number: string; status: string; note?: string }>('/api/banquets/book', {
      kind: val(f, 'kind'), clientName: val(f, 'client'), clientMobile: val(f, 'mobile'), source: val(f, 'source'), title: val(f, 'title') || undefined, clientEmail: val(f, 'email') || undefined,
      company: val(f, 'company') || undefined, gstin: val(f, 'gstin') || undefined, discountPercent: num(f, 'disc') ?? 0,
      functions: fns, action, advance: adv ? { amount: adv, method: val(f, 'method'), reference: val(f, 'ref') } : undefined })
    await onSaved(r.id)
    return r.note ?? `${r.number} ${r.status === 'definite' ? 'booked' : r.status === 'hold' ? 'on hold' : 'saved as an enquiry'}${adv ? `; advance of ${money(adv * 100)} received` : ''}`
  }, '<button type="button" class="btn ghost" data-bk-back hidden>← Back</button>')
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!, back = form.querySelector<HTMLButtonElement>('[data-bk-back]')!
  const show = (sel: string, on: boolean) => { const el = form.querySelector<HTMLElement>(sel); if (el) el.hidden = !on }

  // ---------- panes ----------
  const validate = (f: HTMLFormElement) => pane === 1 ? !!val(f, 'client') : pane === 2 ? !!(val(f, 'venue0') && val(f, 'date0') && val(f, 'from0') && val(f, 'to0') && num(f, 'pax0')) : true
  function go(n: number) {
    pane = n
    form.querySelectorAll<HTMLElement>('[data-pane]').forEach((s) => { s.hidden = Number(s.dataset.pane) !== n })
    const flow: Step[] = [['Who', 1], ['Where and when', 2], ['Confirm', 3]].map(([label, i]) => ({ label: label as string, state: (i as number) < n ? 'done' : i === n ? 'now' : 'todo' }))
    form.querySelector('[data-bk-steps]')!.innerHTML = steps(flow)
    back.hidden = n === 1
    form.querySelector<HTMLElement>('.pin-error')!.hidden = true
    if (n === 3) { summary(); estimate() }
    submitLabel()
    form.querySelector<HTMLInputElement>(`[data-pane="${n}"] input:not([type=hidden])`)?.focus()
  }
  const submitLabel = () => {
    const action = form.querySelector<HTMLInputElement>('input[name=action]:checked')?.value ?? 'book'
    submit.textContent = pane < 3 ? 'Next' : action === 'book' ? 'Book now' : action === 'hold' ? 'Hold the dates' : 'Save the enquiry'
    show('[data-advance]', action !== 'enquiry')
  }
  back.addEventListener('click', () => go(pane - 1))
  form.addEventListener('change', (e) => { if ((e.target as HTMLInputElement).name === 'action') submitLabel() })

  // ---------- who ----------
  form.querySelector('[data-kinds]')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]'); if (!b) return
    form.querySelectorAll('[data-kind]').forEach((c) => c.setAttribute('aria-pressed', String(c === b)))
    ;(form.elements.namedItem('kind') as HTMLInputElement).value = b.dataset.kind!
    const fname = form.elements.namedItem('fname0') as HTMLInputElement
    if (['wedding', 'reception', 'engagement'].includes(b.dataset.kind!)) fname.value = 'Reception'
    else fname.value = KINDS.find(([v]) => v === b.dataset.kind)?.[1] ?? 'Function'
  })

  // ---------- where and when ----------
  form.querySelector('[data-tiles]')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-venue]'); if (!b) return
    form.querySelectorAll('[data-venue]').forEach((c) => c.setAttribute('aria-pressed', String(c === b)))
    ;(form.elements.namedItem('venue0') as HTMLInputElement).value = b.dataset.venue!
    void availability(0)
  })
  form.querySelector('[data-slots]')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-slot]'); if (!b) return
    form.querySelectorAll('[data-slot]').forEach((c) => c.setAttribute('aria-pressed', String(c === b)))
    const slot = SLOTS.find(([v]) => v === b.dataset.slot)!
    show('[data-times]', slot[0] === 'custom')
    if (slot[2]) { (form.elements.namedItem('from0') as HTMLInputElement).value = slot[2]; (form.elements.namedItem('to0') as HTMLInputElement).value = slot[3] }
    void availability(0)
  })
  let timer = 0
  form.addEventListener('input', (e) => {
    const n = (e.target as HTMLInputElement).name ?? ''
    if (!/^(date|from|to|pax|style|venue)[01]$/.test(n)) return
    clearTimeout(timer)
    timer = window.setTimeout(() => void availability(n.endsWith('1') ? 1 : 0), 350)
  })

  /** Asks the HMS whether the venue is free then; on a clash, which other venues of the size are. */
  async function availability(i: 0 | 1) {
    const out = form.querySelector<HTMLElement>(`[data-avail="${i}"]`)!
    const venueId = val(form, `venue${i}`), date = val(form, `date${i}`), from = val(form, `from${i}`), to = val(form, `to${i}`), pax = num(form, `pax${i}`) ?? 0, style = val(form, `style${i}`)
    const v = venues.find((x) => x.id === venueId)
    if (!v || !date || !from || !to) { out.innerHTML = ''; out.dataset.state = ''; return }
    const cap = v.setups[style] ?? v.capacity
    const tooMany = cap && pax > cap ? `<b>${esc(v.name)} seats ${cap} in this setup</b>, not ${pax}. ` : ''
    out.innerHTML = `${tooMany}Checking ${esc(v.name)}…`; out.dataset.state = 'checking'
    try {
      const { clashes } = await h.api.post<{ clashes: Clash[] }>('/api/banquets/check', { venueId, date, from, to })
      if (val(form, `venue${i}`) !== venueId || val(form, `date${i}`) !== date) return   // changed meanwhile
      const firm = clashes.filter((c) => c.firm), pencil = clashes.filter((c) => !c.firm)
      if (!firm.length) {
        out.innerHTML = `${tooMany}<b>${esc(v.name)} is free</b> on ${esc(date)} ${from}–${to}${pencil.length ? ` · pencilled enquiries then: ${pencil.map((c) => esc(c.title)).join(', ')} (they do not keep the venue)` : ''}.`
        out.dataset.state = tooMany ? 'warn' : 'free'
        return
      }
      const taken = firm.map((c) => `${istTime(c.startsAt)}–${istTime(c.endsAt)} for ${esc(c.title)} (${c.status === 'hold' ? 'on hold' : 'booked'})`).join('; ')
      // Other venues big enough that are free then, checked at once.
      const others = venues.filter((x) => x.id !== venueId && (!pax || !(x.setups[style] ?? x.capacity) || (x.setups[style] ?? x.capacity)! >= pax))
      const free = (await Promise.all(others.map(async (x) => ({ x, r: await h.api.post<{ clashes: Clash[] }>('/api/banquets/check', { venueId: x.id, date, from, to }).catch(() => ({ clashes: [] as Clash[] })) }))))
        .filter(({ r }) => !r.clashes.some((c) => c.firm)).map(({ x }) => x)
      out.innerHTML = `${tooMany}<b>${esc(v.name)} is taken then:</b> ${taken} (plus ${v.turnaround_minutes / 60} h to set up and clear).${free.length ? ` Free at that time: ${free.map((x) => `<button type="button" class="linkish" data-pick="${esc(x.id)}">${esc(x.name)}</button>`).join(', ')}.` : ' No other venue of that size is free then; try another day or time.'}`
      out.dataset.state = 'clash'
    } catch (e) { out.innerHTML = `Could not check the venue: ${esc((e as Error).message)}`; out.dataset.state = 'warn' }
  }
  form.addEventListener('click', (e) => {
    const pick = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]'); if (!pick) return
    const tile = form.querySelector<HTMLElement>(`[data-venue="${CSS.escape(pick.dataset.pick!)}"]`)
    if (tile) tile.click(); else { (form.elements.namedItem('venue1') as HTMLSelectElement).value = pick.dataset.pick!; void availability(1) }
  })

  // ---------- confirm ----------
  function summary() {
    const v = venues.find((x) => x.id === val(form, 'venue0'))
    const lines = [`<b>${esc(val(form, 'client'))}</b>${val(form, 'mobile') ? ` · ${esc(val(form, 'mobile'))}` : ''} · ${esc(KINDS.find(([k]) => k === val(form, 'kind'))?.[1] ?? '')}`,
      `${esc(val(form, 'fname0'))}: <b>${esc(v?.name ?? '')}</b>, ${esc(val(form, 'date0'))} ${esc(val(form, 'from0'))}–${esc(val(form, 'to0'))}, ${esc(val(form, 'pax0'))} guests, ${esc(STYLE_LABEL[val(form, 'style0')] ?? '')}`]
    if (val(form, 'venue1') && val(form, 'date1')) lines.push(`${esc(val(form, 'fname1') || 'Function')}: <b>${esc(venues.find((x) => x.id === val(form, 'venue1'))?.name ?? '')}</b>, ${esc(val(form, 'date1'))} ${esc(val(form, 'from1'))}–${esc(val(form, 'to1'))}, ${esc(val(form, 'pax1') || '?')} guests`)
    form.querySelector('[data-summary]')!.innerHTML = lines.map((l) => `<div class="bk-line">${l}</div>`).join('')
  }
  // A rough price as the form fills in: rental and plates, before GST.
  function estimate() {
    let total = 0
    for (const i of [0, 1]) {
      const v = venues.find((x) => x.id === val(form, `venue${i}`))
      if (!v || (i && !val(form, `date${i}`))) continue
      const p = i === 0 ? pkgs.find((x) => x.id === val(form, 'menu0')) : undefined
      total += v.rental_paise + (p ? p.price_paise * Math.max(p.min_pax || 0, num(form, `pax${i}`) ?? 0) : 0)
    }
    const disc = num(form, 'disc') ?? 0
    form.querySelector<HTMLElement>('[data-estimate]')!.textContent = total ? `About ${money(Math.round(total * (1 - disc / 100)))} before GST (venue rental and plates); the quote works out the exact figure.` : ''
  }
  form.addEventListener('input', (e) => { if (/^(menu0|disc)$/.test((e.target as HTMLInputElement).name ?? '')) estimate() })
  form.addEventListener('change', (e) => { if (/^(menu0|disc)$/.test((e.target as HTMLInputElement).name ?? '')) estimate() })

  go(1)
  if (preset.venueId) void availability(0)
}
