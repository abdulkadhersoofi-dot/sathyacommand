import { esc, toast, tonePill } from '../ui/dom'
import { val } from '../ui/form-modal'
import { scanQr } from '../ui/qr-scan'
import type { HkHost } from './common'

// Public-area cleaning rounds: scan the QR code fixed in the area to record the round.

interface Area { id: string; name: string; code: string; rounds_per_day: number; done: number; last_at: string | null; last_by: string | null; overdue: boolean; active: boolean }

export class AreasView {
  private areas: Area[] = []
  constructor(private h: HkHost) {}

  async load() { this.areas = await this.h.cached('/api/hk/areas') }

  html() {
    const manage = this.h.can('hk.manage')
    return `<div class="ws-toolbar"><button type="button" class="btn primary" data-ar="scan">Scan an area's QR code</button>
        ${manage ? '<button type="button" class="btn" data-ar="add">Add area</button><button type="button" class="btn" data-ar="labels">Print QR labels</button>' : ''}</div>
      ${this.areas.filter((a) => a.active).map((a) => `<div class="row-card"><div class="rc-title">${esc(a.name)}</div>
        <div class="rc-sub">${a.done} of ${a.rounds_per_day} rounds today${a.last_at ? ` · last ${new Date(a.last_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}${a.last_by ? ` by ${esc(a.last_by)}` : ''}` : ''}</div>
        <div class="rc-right">${a.done >= a.rounds_per_day ? tonePill('Done', '--st-vacant') : a.overdue ? tonePill('Due now', '--st-departing') : tonePill('On track', '--st-occupied')}</div></div>`).join('')}`
  }

  async click(t: HTMLElement): Promise<boolean> {
    const api = this.h.api, modal = this.h.modal
    const act = t.closest<HTMLElement>('[data-ar]')?.dataset.ar
    if (act === 'labels') { await api.openDocument('/api/hk/areas/labels'); return false }
    if (act === 'add') {
      modal.open('Add public area', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="60" placeholder="e.g. Gym washrooms"></label><label>Rounds a day<input name="rounds" type="number" min="1" max="48" value="2"></label></div>`, 'Add', async (f) => {
        await api.post('/api/hk/areas', { name: val(f, 'name'), roundsPerDay: Number(val(f, 'rounds')) }); await this.load(); this.h.render(); return 'Area added. Print its QR label.'
      })
      return false
    }
    if (act === 'scan') {
      modal.open('Cleaning round', `<p class="muted small">Point the camera at the QR code in the area, or type the code printed under it.</p><div data-cam></div>
        <div class="form-grid"><label class="span2">Code<input name="code" placeholder="SPR-…" autocomplete="off"></label><label class="span2">Note (optional)<input name="note" maxlength="200"></label></div>`, 'Record round', async (f) => {
        const r = await this.h.outbox.send<{ area: string }>('POST', '/api/hk/rounds', { code: val(f, 'code').toUpperCase(), note: val(f, 'note') || undefined }, 'cleaning round')
        await this.load().catch(() => {}); this.h.render()
        return r ? `Round recorded: ${r.area}` : 'No connection: the round is saved on this phone.'
      })
      const cam = modal.el.querySelector<HTMLElement>('[data-cam]')!
      const code = await scanQr(cam)
      if (code) {
        const input = modal.el.querySelector<HTMLInputElement>('input[name=code]')
        if (input) { input.value = code; modal.el.querySelector<HTMLFormElement>('form')?.requestSubmit() }
      } else if (cam.isConnected && !('BarcodeDetector' in window)) toast('This browser cannot read QR codes: type the code under it.')
      return false
    }
    return false
  }
}
