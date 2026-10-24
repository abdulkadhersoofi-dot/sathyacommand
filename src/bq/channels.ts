import { esc, toast, tonePill } from '../ui/dom'
import { checked, confirmDanger, val } from '../ui/form-modal'
import { toolbar } from '../ui/toolbar'
import type { BqHost } from './workspace'

// Rates and channels: the booking page's address, selling rules night by night (stop-sell, minimum stay,
// closed to arrival or departure), the channel manager's room codes, and OTA bookings, with the ones that
// could not be placed first.

interface Rule { room_type_id: string; day: string; stop_sell: boolean; min_stay: number | null; cta: boolean; ctd: boolean }
interface CBooking { id: string; channel: string; ota_ref: string; action: string; status: string; error: string | null; received_at: string; reservation_id: string | null; resolved_by: string | null; payload: { guest?: { name?: string }; arrival?: string; departure?: string } }

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export class ChannelsView {
  private from = ''
  private types: { id: string; name: string }[] = []
  private rules: Rule[] = []
  private maps: { channel: string; code: string; room_type_id: string; plan_code: string }[] = []
  private channels: Record<string, string> = {}
  private connected = false
  private payOnline = false
  private log: CBooking[] = []
  constructor(private h: BqHost) {}

  async load() {
    if (!this.from) this.from = (await this.h.api.get<{ businessDate: string }>('/api/business-date')).businessDate
    const r = await this.h.cached<{ roomTypes: { id: string; name: string }[]; restrictions: Rule[] }>(`/api/channels/restrictions?from=${this.from}&to=${addDays(this.from, 27)}`)
    this.types = r.roomTypes; this.rules = r.restrictions
    const m = await this.h.cached<{ maps: ChannelsView['maps']; connected: boolean; channels: Record<string, string> }>('/api/channels/maps')
    this.maps = m.maps; this.connected = m.connected; this.channels = m.channels
    this.log = await this.h.cached('/api/channels/bookings')
    this.payOnline = (await fetch('/public/property').then((x) => x.json()).catch(() => ({ payOnline: false }))).payOnline
  }

  html() {
    const days = Array.from({ length: 28 }, (_, i) => addDays(this.from, i))
    const manage = this.h.can('revenue.manage')
    const url = `${location.origin}/book`
    const failed = this.log.filter((b) => b.status === 'failed')
    const mark = (r?: Rule) => !r ? '' : `${r.stop_sell ? '<b class="fd-warn" title="Stop-sell">✕</b>' : ''}${r.min_stay ? `<span title="Minimum stay">${r.min_stay}+</span>` : ''}${r.cta ? '<span title="Closed to arrival">CTA</span>' : ''}${r.ctd ? '<span title="Closed to departure">CTD</span>' : ''}`
    return `<div class="row-card"><div class="rc-title">Booking page</div><div class="rc-sub"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a> · guests book and check in online.
        ${this.payOnline ? 'Deposits are taken by payment link.' : 'No payment gateway yet: guests pay at the resort.'}</div>
        <div class="rc-right"><button type="button" class="btn small" data-chn="copy">Copy link</button></div></div>
      ${failed.length ? `<div class="sec-title fd-warn">OTA bookings that could not be placed <span>${failed.length}</span></div>${failed.map((b) => `<div class="row-card"><div class="rc-title">${esc(this.channels[b.channel] ?? b.channel)} ${esc(b.ota_ref)} · ${esc(b.payload.guest?.name ?? '')}</div>
        <div class="rc-sub">${esc(b.payload.arrival ?? '')} to ${esc(b.payload.departure ?? '')} · ${esc(b.error ?? '')}</div><div class="rc-right"><button type="button" class="btn small" data-chres="${esc(b.id)}">Resolved…</button></div></div>`).join('')}` : ''}
      <div class="sec-title">Selling rules</div>
      ${toolbar({
        primary: manage ? [{ attrs: 'data-chn="rule"', label: 'Set a rule' }] : [],
        more: manage ? [{ attrs: 'data-chn="map"', label: 'Map a room code…' }] : [],
        filters: `<button type="button" class="btn small" data-chnav="-14" aria-label="Earlier">◀</button><span class="small">${esc(days[0])} to ${esc(days[27])}</span><button type="button" class="btn small" data-chnav="14" aria-label="Later">▶</button>`,
      })}
      <div class="acc-scroll"><table class="acc-table bq-rules"><thead><tr><th>Room</th>${days.map((d) => { const x = new Date(`${d}T00:00:00Z`); return `<th class="n ${x.getUTCDay() % 6 === 0 ? 'wk' : ''}">${WEEK[x.getUTCDay()][0]}<br>${x.getUTCDate()}</th>` }).join('')}</tr></thead><tbody>
        ${this.types.map((t) => `<tr><td>${esc(t.name)}</td>${days.map((d) => `<td class="n">${mark(this.rules.find((r) => r.room_type_id === t.id && r.day === d))}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>
      <p class="muted small">✕ not sold online · 3+ minimum stay from that arrival · CTA no arrivals · CTD no departures. The booking page follows these, and they go to the channel manager with availability and rates.</p>
      <div class="sec-title">Channel manager ${tonePill(this.connected ? 'Connected (key set)' : 'Not set up', this.connected ? '--st-vacant' : '--muted')}</div>
      <div class="m-table">${this.maps.map((m) => `<div class="m-row bq-doc"><span>${esc(this.channels[m.channel] ?? m.channel)}</span><span class="mono">${esc(m.code)}</span><span>${esc(this.types.find((t) => t.id === m.room_type_id)?.name ?? m.room_type_id)}</span><span>${esc(m.plan_code)}</span>
        <span class="rc-right">${manage ? `<button type="button" class="btn small ghost" data-chunmap="${esc(m.channel)}|${esc(m.code)}">Remove</button>` : ''}</span></div>`).join('') || '<p class="empty">No room codes mapped yet.</p>'}</div>
      <div class="sec-title">From the channel manager</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Received</th><th>Channel</th><th>Booking</th><th>Change</th><th>Result</th></tr></thead><tbody>
        ${this.log.map((b) => `<tr><td>${esc(new Date(b.received_at).toLocaleString('en-IN'))}</td><td>${esc(this.channels[b.channel] ?? b.channel)}</td><td class="mono">${esc(b.ota_ref)}</td><td>${esc(b.action)}</td>
          <td>${tonePill(b.status, b.status === 'failed' ? '--st-departing' : b.status === 'resolved' ? '--muted' : '--st-vacant')}${b.reservation_id ? ` <span class="mono small">${esc(b.reservation_id)}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing yet.</td></tr>'}
      </tbody></table></div>`
  }

  async click(el: HTMLElement) {
    const api = this.h.api
    const nav = el.closest<HTMLElement>('[data-chnav]')?.dataset.chnav
    if (nav) { this.from = addDays(this.from, Number(nav)); await this.load(); return true }
    const res = el.closest<HTMLElement>('[data-chres]')?.dataset.chres
    if (res) this.h.modal.open('Resolved', '<div class="form-grid"><label class="span2">What was done<input name="note" maxlength="300" placeholder="Booked by hand as R-…, moved to a sister hotel…"></label></div>', 'Save', async (f) => {
      await api.post(`/api/channels/bookings/${res}/resolve`, { note: val(f, 'note') }); await this.load(); this.h.render(); return 'Marked resolved'
    })
    const un = el.closest<HTMLElement>('[data-chunmap]')?.dataset.chunmap
    if (un) { const [channel, code] = un.split('|'); confirmDanger(this.h.modal, 'Remove this room code?', 'The channel manager stops receiving rates and availability for it.', 'Remove the code', async () => { await api.req('PUT', '/api/channels/maps', { channel, code, remove: true }); await this.load(); this.h.render(); return 'Removed' }); return false }
    const a = el.closest<HTMLElement>('[data-chn]')?.dataset.chn
    if (a === 'copy') { try { await navigator.clipboard.writeText(`${location.origin}/book`); toast('Link copied') } catch { toast(`${location.origin}/book`) } }
    if (a === 'rule') this.h.modal.open('Selling rule', `<div class="form-grid"><fieldset class="span2"><legend>Rooms</legend>${this.types.map((t) => `<label class="check"><input type="checkbox" name="t:${esc(t.id)}" checked> ${esc(t.name)}</label>`).join('')}</fieldset>
        <label>From<input name="from" type="date" value="${esc(this.from)}"></label><label>To<input name="to" type="date" value="${esc(this.from)}"></label>
        <fieldset class="span2"><legend>Only on (none ticked: every day)</legend>${WEEK.map((w, i) => `<label class="check"><input type="checkbox" name="w:${i}"> ${w}</label>`).join('')}</fieldset>
        <label class="check"><input type="checkbox" name="stop"> Stop-sell</label><label>Minimum stay (nights)<input name="min" type="number" min="1" max="30"></label>
        <label class="check"><input type="checkbox" name="cta"> Closed to arrival</label><label class="check"><input type="checkbox" name="ctd"> Closed to departure</label></div>
        <p class="muted small">Leave every rule off and save to clear the nights chosen.</p>`, 'Save', async (f) => {
      const r = await api.req<{ nights: number }>('PUT', '/api/channels/restrictions', { roomTypeIds: this.types.filter((t) => checked(f, `t:${t.id}`)).map((t) => t.id), from: val(f, 'from'), to: val(f, 'to'),
        weekdays: WEEK.map((_, i) => i).filter((i) => checked(f, `w:${i}`)), stopSell: checked(f, 'stop'), minStay: val(f, 'min') ? Number(val(f, 'min')) : null, cta: checked(f, 'cta'), ctd: checked(f, 'ctd') })
      await this.load(); this.h.render(); return `${r.nights} nights set`
    })
    if (a === 'map') this.h.modal.open('Map a room code', `<div class="form-grid"><label>Channel<select name="ch">${Object.entries(this.channels).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select></label>
        <label>Their room / rate code<input name="code" maxlength="60"></label><label>Room<select name="rt">${this.types.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
        <label>Meal plan<select name="plan">${['EP', 'CP', 'MAP', 'AP'].map((p) => `<option>${p}</option>`).join('')}</select></label></div>`, 'Save', async (f) => {
      await api.req('PUT', '/api/channels/maps', { channel: val(f, 'ch'), code: val(f, 'code'), roomTypeId: val(f, 'rt'), plan: val(f, 'plan') }); await this.load(); this.h.render(); return 'Mapped'
    })
    return false
  }
}
