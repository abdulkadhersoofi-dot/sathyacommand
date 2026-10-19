import { esc, tonePill } from '../ui/dom'
import { val } from '../ui/form-modal'
import type { HkHost } from './common'

// Linen against par: what the resort owns (in rooms, on the shelf, at the laundry), what is short,
// and every movement (purchase, laundry out and back, losses, discards, counts).

interface Linen { id: string; name: string; parPerRoom: number; parSets: number; inRooms: number; shelf: number; laundry: number; lost: number; owned: number; needed: number; short: number; active: boolean }
const MOVES: [string, string][] = [['send_laundry', 'Sent to laundry'], ['receive_laundry', 'Back from laundry'], ['purchase', 'New stock bought'], ['laundry_loss', 'Lost by the laundry'], ['discard', 'Discarded (torn, stained)'], ['count_adjust', 'Count correction (+/-)']]

export class LinenView {
  private items: Linen[] = []
  constructor(private h: HkHost) {}

  async load() { this.items = await this.h.api.get('/api/linen') }

  html() {
    const manage = this.h.can('hk.manage')
    return `<div class="ws-toolbar"><button type="button" class="btn primary" data-ln="move">Record a movement</button>${manage ? '<button type="button" class="btn" data-ln="add">Add linen item</button>' : ''}</div>
      <div class="m-table"><div class="m-row linen-row head"><span>Item</span><span>In rooms</span><span>Shelf</span><span>Laundry</span><span>Owned / needed</span><span>Lost</span></div>
      ${this.items.filter((i) => i.active).map((i) => `<div class="m-row linen-row"><b>${esc(i.name)}<small class="muted"> ${i.parPerRoom}/room × ${i.parSets} sets</small></b>
        <span class="mono">${i.inRooms}</span><span class="mono">${i.shelf}</span><span class="mono">${i.laundry}</span>
        <span>${i.owned} / ${i.needed} ${i.short ? tonePill(`${i.short} short`, '--st-departing') : tonePill('OK', '--st-vacant')}</span><span class="mono">${i.lost}</span></div>`).join('')}</div>`
  }

  async click(t: HTMLElement): Promise<boolean> {
    const api = this.h.api, modal = this.h.modal
    const act = t.closest<HTMLElement>('[data-ln]')?.dataset.ln
    if (act === 'move') {
      modal.open('Linen movement', `<div class="form-grid"><label class="span2">What<select name="kind">${MOVES.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="span2">Item<select name="item">${this.items.filter((i) => i.active).map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('')}</select></label>
        <label>Pieces<input name="qty" type="number" step="1"></label><label>Laundry / supplier<input name="vendor" maxlength="60"></label>
        <label class="span2">Reason or note<input name="note" maxlength="200"></label></div>`, 'Save', async (f) => {
        await api.post('/api/linen/moves', { itemId: val(f, 'item'), kind: val(f, 'kind'), qty: Number(val(f, 'qty')), vendor: val(f, 'vendor') || undefined, note: val(f, 'note') || undefined })
        await this.load(); this.h.render(); return 'Recorded'
      })
    }
    if (act === 'add') {
      modal.open('Add linen item', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="60"></label><label>Pieces per room<input name="par" type="number" min="0" step="0.5" value="2"></label><label>Sets to own<input name="sets" type="number" min="1" step="0.5" value="3"></label></div>`, 'Add', async (f) => {
        await api.post('/api/linen/items', { name: val(f, 'name'), parPerRoom: Number(val(f, 'par')), parSets: Number(val(f, 'sets')) }); await this.load(); this.h.render(); return 'Added'
      })
    }
    return false
  }
}
