import { esc, showDate } from '../ui/dom'
import type { BqHost } from './workspace'

// Venues down the side, days across: every function on its venue and day, pencilled, held or booked.

export interface Venue { id: string; kind: string; name: string; capacity: number | null; rental_paise: number; turnaround_minutes: number; setups: Record<string, number> }
interface Booking { functionId: string; name: string; venueId: string; date: string; from: string; to: string; pax: number; eventId: string; number: string; title: string; status: string; holdUntil: string | null; firm: boolean }

export const STATUS_LABEL: Record<string, string> = { enquiry: 'Enquiry', quoted: 'Quoted', hold: 'On hold', definite: 'Definite', billed: 'Billed', closed: 'Closed', lost: 'Lost', cancelled: 'Cancelled' }
export const STATUS_TONE: Record<string, string> = { enquiry: '--muted', quoted: '--st-inspected', hold: '--marigold', definite: '--st-vacant', billed: '--st-occupied', closed: '--muted', lost: '--st-departing', cancelled: '--st-departing' }
export const STYLE_LABEL: Record<string, string> = { rounds: 'Round tables', theatre: 'Theatre', u_shape: 'U-shape', classroom: 'Classroom', cocktail: 'Cocktail', floating: 'Buffet (standing)' }

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const DAYS = 14

export class CalendarView {
  private from = ''
  private venues: Venue[] = []
  private bookings: Booking[] = []
  constructor(private h: BqHost) {}

  async load() {
    if (!this.from) this.from = (await this.h.api.get<{ businessDate: string }>('/api/business-date')).businessDate
    this.venues = await this.h.cached('/api/banquets/venues')
    this.bookings = (await this.h.cached<{ bookings: Booking[] }>(`/api/banquets/calendar?from=${this.from}&to=${addDays(this.from, DAYS - 1)}`)).bookings
  }

  html() {
    const days = Array.from({ length: DAYS }, (_, i) => addDays(this.from, i))
    const manage = this.h.can('events.manage')
    const head = days.map((d) => { const x = new Date(`${d}T00:00:00Z`); const wk = x.getUTCDay() === 0 || x.getUTCDay() === 6
      return `<div class="bq-day${wk ? ' wk' : ''}"><small>${x.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })}</small><b>${x.getUTCDate()} ${x.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })}</b></div>` }).join('')
    const rows = this.venues.map((v) => `<div class="bq-venue"><b>${esc(v.name)}</b><small>${v.capacity ? `up to ${v.capacity}` : esc(v.kind)}</small></div>${days.map((d) => {
      const here = this.bookings.filter((b) => b.venueId === v.id && b.date === d)
      return `<div class="bq-cell" ${manage ? `data-cal="${esc(v.id)}|${d}" title="Book ${esc(v.name)} on ${d}"` : ''}>${here.map((b) =>
        `<button type="button" class="bq-chip ${b.firm ? (b.status === 'hold' ? 'hold' : 'firm') : 'pencil'}" data-ev="${esc(b.eventId)}" title="${esc(`${b.title} · ${b.name} ${b.from}–${b.to} · ${b.pax} guests · ${STATUS_LABEL[b.status]}${b.holdUntil ? ` until ${showDate(b.holdUntil)}` : ''}`)}">
          <span class="mono">${esc(b.from)}</span> ${esc(b.title)}<small>${esc(b.name)} · ${b.pax}</small></button>`).join('')}</div>`
    }).join('')}`).join('')
    return `<div class="ws-toolbar"><button type="button" class="btn" data-cal-nav="-7">◀ Week</button>
        <label class="inline">From <input type="date" data-cal-from value="${esc(this.from)}"></label><button type="button" class="btn" data-cal-nav="7">Week ▶</button>
        ${manage ? '<button type="button" class="btn primary" data-cal-book>Book an event</button><button type="button" class="btn" data-cal-new>New enquiry</button>' : ''}
        <span class="bq-legend"><span class="bq-chip pencil">Pencilled</span><span class="bq-chip hold">On hold</span><span class="bq-chip firm">Booked</span></span></div>
      <p class="muted small">A venue is kept free for its turnaround (setting up and clearing) around each booking. Pencilled enquiries may overlap; only one can hold or book a slot.${manage ? ' Tap an empty day to book that venue; tap a booking to open it.' : ''}</p>
      <div class="bq-cal-wrap"><div class="bq-cal" style="--days:${DAYS}"><div class="bq-venue head">Venue</div>${head}${rows}</div></div>`
  }

  async change(el: HTMLElement) {
    if (!el.matches('[data-cal-from]') || !(el as HTMLInputElement).value) return false
    this.from = (el as HTMLInputElement).value
    await this.load(); return true
  }

  async click(el: HTMLElement) {
    const ev = el.closest<HTMLElement>('[data-ev]')?.dataset.ev
    if (ev) { this.h.openEvent(ev); return false }
    const nav = el.closest<HTMLElement>('[data-cal-nav]')?.dataset.calNav
    if (nav) { this.from = addDays(this.from, Number(nav)); await this.load(); return true }
    if (el.closest('[data-cal-new]')) { this.h.newEnquiry(); return false }
    if (el.closest('[data-cal-book]')) { this.h.newBooking(); return false }
    const cell = el.closest<HTMLElement>('[data-cal]')?.dataset.cal
    if (cell) { const [venue, date] = cell.split('|'); this.h.newBooking(venue, date) }
    return false
  }
}
