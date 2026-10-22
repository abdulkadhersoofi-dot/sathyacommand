import { esc, toast, tonePill } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import { takePhoto, uploadPhoto } from '../ui/photo'
import { toolbar } from '../ui/toolbar'
import type { WorkspaceHost } from '../ui/workspace'
import { getLang, setLang, t } from './i18n'
import { currentFix, type Tracker } from './tracker'

// The staff app's first screen: clock in and out, the on-duty notice, SOS, and the person's work.
// Also the messages screen.

export interface StaffHost extends WorkspaceHost {
  tracker: Tracker
  openWork(kind: string, ref: string): void
}
interface Me { name: string; consent: boolean; onDuty: boolean; attendance: { clock_in_at: string; late_minutes: number } | null; shift: { name: string; starts: string; ends: string } | null; unread: number; settings: { selfieRequired: boolean; lat: number | null } }
interface Inbox { kind: string; title: string; detail: string; at: string | null; ref: string }
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })

export class TodayView {
  me: Me | null = null
  private inbox: Inbox[] = []
  constructor(private h: StaffHost) {}

  async load() {
    this.me = await this.h.cached<Me>('/api/staff/me')
    this.inbox = await this.h.cached<Inbox[]>('/api/staff/inbox')
    if (this.me.onDuty && !this.h.tracker.active) void this.h.tracker.start()
    if (!this.me.onDuty && this.h.tracker.active) this.h.tracker.stop()
  }

  html() {
    const m = this.me
    if (!m) return '<div class="empty">Loading…</div>'
    const lang = `<div class="lang"><button type="button" class="chip" data-lang="en" aria-pressed="${getLang() === 'en'}">English</button><button type="button" class="chip" data-lang="ta" aria-pressed="${getLang() === 'ta'}">தமிழ்</button></div>`
    if (!m.consent) {
      return lang + `<div class="staff-card"><div class="sec-title">${t('Location policy')}</div><p>${t('policy')}</p><button type="button" class="btn primary big" data-st="consent">${t('I agree')}</button></div>`
    }
    const a = m.attendance
    return lang + `<div class="staff-card ${m.onDuty ? 'on' : ''}">
        <div class="duty-state">${m.onDuty ? tonePill(t('On duty'), '--st-vacant') : tonePill(t('Off duty'), '--muted')}<b>${esc(m.name)}</b></div>
        <div class="muted">${m.shift ? `${t('Your shift')}: ${esc(m.shift.name)} ${esc(m.shift.starts)}–${esc(m.shift.ends)}` : t('No shift on the roster today')}</div>
        ${a ? `<div class="muted">${t('Clocked in at')} ${time(a.clock_in_at)}${a.late_minutes ? ` · <span class="fd-warn">${t('Late by')} ${a.late_minutes} ${t('minutes')}</span>` : ''}</div>` : ''}
        ${m.onDuty ? `<div class="loc-note">📍 ${t('Location on: on duty')}</div>` : `<p class="muted small">${t('Location is shared only while you are on duty.')}</p>`}
        <button type="button" class="btn ${m.onDuty ? '' : 'primary'} big" data-st="${m.onDuty ? 'out' : 'in'}">${m.onDuty ? t('Clock out') : t('Clock in')}</button>
      </div>
      <button type="button" class="sos-btn" data-st="sos" aria-label="${t('SOS')}"><b>${t('SOS')}</b><span>${t('Tap, then confirm')}</span></button>
      <div class="sec-title">${t('My work')} <span>${this.inbox.length}</span></div>
      ${this.inbox.map((i) => `<div class="row-card"><div class="rc-title">${i.kind === 'sos' ? '🚨 ' : ''}${esc(i.title)}</div><div class="rc-sub">${esc(i.detail)}</div>
        <div class="rc-right"><button type="button" class="btn small" data-work="${esc(i.kind)}:${esc(i.ref)}">${t('Open')}</button></div></div>`).join('') || `<div class="empty">${t('Nothing waiting for you.')}</div>`}`
  }

  async click(el: HTMLElement): Promise<boolean> {
    const api = this.h.api
    const lang = el.closest<HTMLElement>('[data-lang]')?.dataset.lang as 'en' | 'ta' | undefined
    if (lang) { setLang(lang); return true }
    const w = el.closest<HTMLElement>('[data-work]')?.dataset.work
    if (w) { const [kind, ref] = w.split(':'); this.h.openWork(kind, ref); return false }
    const a = el.closest<HTMLElement>('[data-st]')?.dataset.st
    if (a === 'consent') { await api.post('/api/staff/consent', { accept: true }); await this.load(); return true }
    if (a === 'in') {
      toast(t('Getting your location…'))
      const fix = await currentFix()
      if (!fix && this.me!.settings.lat != null) { toast(t('Turn on location (GPS) and try again.')); return false }
      let selfieId: string | undefined
      if (this.me!.settings.selfieRequired) {
        const photo = await takePhoto(720, 'user')
        if (!photo) { toast(t('Take a selfie')); return false }
        selfieId = await uploadPhoto(api, 'selfie', photo)
      }
      const r = await api.post<{ lateMinutes: number }>('/api/staff/clock-in', { ...(fix ?? {}), selfieId })
      toast(r.lateMinutes ? `${t('On duty')} · ${t('Late by')} ${r.lateMinutes} ${t('minutes')}` : t('On duty'))
      await this.h.tracker.start()
      await this.load(); return true
    }
    if (a === 'out') {
      const fix = await currentFix(8000)
      const r = await api.post<{ minutes: number }>('/api/staff/clock-out', fix ?? {})
      this.h.tracker.stop()
      toast(`${t('Off duty')} · ${(r.minutes / 60).toFixed(1)} ${t('hours')}`)
      await this.load(); return true
    }
    if (a === 'sos') {
      this.h.modal.open(t('SOS'), `<p>${getLang() === 'ta' ? 'பாதுகாப்பு மற்றும் மேலாளர்களுக்கு உங்கள் இருப்பிடத்துடன் அவசர எச்சரிக்கை அனுப்பவா?' : 'Send an emergency alert with your location to security and the managers?'}</p>`, t('SOS'), async () => {
        // Send at once: the last position from the tracker (or, on duty, the server's last ping) beats waiting for GPS.
        const last = this.h.tracker.last
        const fix = last && Date.now() - last.at < 120_000 ? last.fix : this.me?.onDuty ? null : await currentFix(4000)
        const r = await this.h.outbox.send('POST', '/api/staff/sos', fix ?? {}, 'SOS')
        return r ? t('Help is on the way. Stay where you are if it is safe.') : 'No connection: the SOS is waiting to send. Call security.'
      })
      return false
    }
    return false
  }
}

interface Broadcast { id: string; from_name: string; at: string; text: string; roles: string[] | null; urgent: boolean; read: boolean }
const ROLES: [string, string][] = [['room_attendant', 'Room attendants'], ['hk_supervisor', 'HK supervisors'], ['captain', 'Captains'], ['chef', 'Chefs'], ['bartender', 'Bartenders'],
  ['reception', 'Reception'], ['security', 'Security'], ['engineering', 'Engineering']]

export class MessagesView {
  private list: Broadcast[] = []
  constructor(private h: StaffHost) {}

  async load() {
    this.list = await this.h.cached('/api/staff/broadcasts')
    for (const b of this.list.filter((x) => !x.read)) void this.h.api.post(`/api/staff/broadcasts/${b.id}/read`).catch(() => {})
  }

  html() {
    return toolbar({ primary: this.h.can('broadcast.send') ? [{ attrs: 'data-msg="send"', label: t('Send a message') }] : [] })
      + (this.list.map((b) => `<div class="msg${b.urgent ? ' urgent' : ''}${b.read ? '' : ' unread'}"><div class="msg-head"><b>${esc(b.from_name)}</b>${b.urgent ? tonePill(t('Urgent'), '--st-departing') : ''}<span class="muted small">${new Date(b.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
        <div>${esc(b.text)}</div>${b.roles ? `<div class="muted small">To: ${b.roles.map((r) => esc(ROLES.find((x) => x[0] === r)?.[1] ?? r)).join(', ')}</div>` : ''}</div>`).join('') || '<div class="empty">No messages.</div>')
  }

  async click(el: HTMLElement): Promise<boolean> {
    if (el.closest<HTMLElement>('[data-msg]')?.dataset.msg !== 'send') return false
    this.h.modal.open(t('Send a message'), `<div class="form-grid"><label class="span2">Message<textarea name="text" rows="4" maxlength="500"></textarea></label>
      <fieldset class="span2"><legend>To (none ticked = everyone)</legend>${ROLES.map(([k, v]) => `<label class="check"><input type="checkbox" name="r_${k}"> ${v}</label>`).join('')}</fieldset>
      <label class="check span2"><input type="checkbox" name="urgent"> Urgent</label></div>`, 'Send', async (f) => {
      await this.h.api.post('/api/staff/broadcasts', { text: val(f, 'text'), roles: ROLES.map(([k]) => k).filter((k) => checked(f, `r_${k}`)), urgent: checked(f, 'urgent') })
      await this.load(); this.h.render(); return 'Message sent'
    })
    return false
  }
}
