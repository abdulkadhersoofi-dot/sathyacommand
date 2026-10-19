import { esc, tonePill } from '../ui/dom'
import { val } from '../ui/form-modal'
import { hydratePhotos } from '../ui/photo'
import { chips } from '../fnb/common'
import { foundItem, type HkHost } from './common'

// Lost & found register: what was found where, the guest to call, and who collected it.

interface Item { id: string; description: string; place: string | null; room_no: string | null; photo_id: string | null; status: string; found_by: string; found_at: string; handed_to: string | null; guest: string | null; guest_mobile: string | null }

export class LostView {
  status = 'held'
  private items: Item[] = []
  constructor(private h: HkHost) {}

  async load() { this.items = await this.h.api.get(`/api/hk/lost-found?status=${this.status}`) }

  html() {
    return `<div class="ws-toolbar">${chips([['held', 'Being held'], ['returned', 'Returned'], ['disposed', 'Disposed'], ['all', 'All']], this.status, 'lf')}<button type="button" class="btn" data-lfa="add">Log a found item</button></div>
      ${this.items.map((i) => `<div class="row-card lf-card">${i.photo_id ? `<img data-upload="${esc(i.photo_id)}" alt="">` : ''}<div class="rc-title">${esc(i.description)}</div>
        <div class="rc-sub">${i.room_no ? `Room ${esc(i.room_no)}` : esc(i.place ?? '')} · ${new Date(i.found_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} by ${esc(i.found_by)}${i.guest ? ` · last guest ${esc(i.guest)}${i.guest_mobile ? ` (${esc(i.guest_mobile)})` : ''}` : ''}${i.handed_to ? ` · collected by ${esc(i.handed_to)}` : ''}</div>
        <div class="rc-right">${i.status === 'held' ? `<button type="button" class="btn small" data-lfclose="${esc(i.id)}">Hand over…</button>` : tonePill(i.status === 'returned' ? 'Returned' : 'Disposed', i.status === 'returned' ? '--st-vacant' : '--st-ooo')}</div></div>`).join('') || '<div class="empty">Nothing here.</div>'}`
  }

  mounted(root: HTMLElement) { hydratePhotos(this.h.api, root) }

  async click(t: HTMLElement): Promise<boolean> {
    const s = t.closest<HTMLElement>('[data-lf]')?.dataset.lf
    if (s) { this.status = s; await this.load(); return true }
    if (t.closest('[data-lfa]')) { await foundItem(this.h, null, ''); return false }
    const c = t.closest<HTMLElement>('[data-lfclose]')?.dataset.lfclose
    if (c) {
      this.h.modal.open('Hand over', `<div class="form-grid"><label class="span2">Outcome<select name="outcome"><option value="returned">Returned to the owner</option>${this.h.can('hk.manage') ? '<option value="disposed">Disposed / donated after the holding period</option>' : ''}</select></label>
        <label class="span2">Collected by (name, ID seen)<input name="to" maxlength="100"></label><label class="span2">Note<input name="note" maxlength="200"></label></div>`, 'Save', async (f) => {
        await this.h.api.post(`/api/hk/lost-found/${c}/close`, { outcome: val(f, 'outcome'), handedTo: val(f, 'to') || undefined, note: val(f, 'note') || undefined })
        await this.load(); this.h.render(); return 'Saved'
      })
    }
    return false
  }
}
