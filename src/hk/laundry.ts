import { esc, toast } from '../ui/dom'
import { toolbar } from '../ui/toolbar'
import { checked, val } from '../ui/form-modal'
import { rs } from '../fnb/common'
import type { HkHost } from './common'

// Guest laundry in progress (deliver to charge the room) and the price lists for laundry and minibar.

interface Order { id: string; room_no: string; guest: string; items: { name: string; qty: number; amount: number }[]; express: boolean; total_paise: number; status: string; picked_by: string; picked_at: string }
interface Price { id: string; name: string; service?: string; price_paise: number; gst_rate?: string; active: boolean }
const SV: Record<string, string> = { wash_iron: 'Wash & iron', dry_clean: 'Dry clean', press: 'Press' }

export class LaundryView {
  private orders: Order[] = []
  private laundry: Price[] = []
  private minibar: Price[] = []
  constructor(private h: HkHost) {}

  async load() {
    this.orders = await this.h.api.get('/api/laundry/orders')
    this.laundry = await this.h.api.get('/api/laundry/items')
    this.minibar = await this.h.api.get('/api/hk/minibar-items')
  }

  html() {
    const manage = this.h.can('hk.manage')
    return `<p class="muted small">Collect laundry from a room on the room board (Room… → Collect laundry). It is charged to the guest when delivered back.</p>
      <div class="sec-title">With the laundry <span>${this.orders.length}</span></div>
      ${this.orders.map((o) => `<div class="row-card"><div class="rc-title">Room ${esc(o.room_no)} · ${esc(o.guest)}${o.express ? ' · <b>Express</b>' : ''}</div>
        <div class="rc-sub">${o.items.map((i) => `${i.qty} × ${esc(i.name)}`).join(', ')} · collected by ${esc(o.picked_by)} ${new Date(o.picked_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>
        <div class="rc-right"><span class="mono">${rs(Number(o.total_paise))}</span><button type="button" class="btn small primary" data-deliver="${esc(o.id)}">Delivered</button></div></div>`).join('') || '<div class="empty">Nothing at the laundry.</div>'}
      <div class="sec-title">Laundry prices</div>
      ${toolbar({ primary: manage ? [{ attrs: 'data-lp="laundry"', label: 'Add laundry item' }] : [] })}
      <div class="m-table">${this.laundry.map((i) => `<div class="m-row m-row-4${i.active ? '' : ' retired'}"><b>${esc(i.name)}</b><span>${SV[i.service!]}</span><span class="mono">${rs(i.price_paise)}</span>${manage ? `<button type="button" class="btn small" data-edit-price="laundry:${esc(i.id)}">Edit</button>` : '<span></span>'}</div>`).join('')}</div>
      <div class="sec-title">Minibar</div>
      ${toolbar({ primary: manage ? [{ attrs: 'data-lp="minibar"', label: 'Add minibar item' }] : [] })}
      <div class="m-table">${this.minibar.map((i) => `<div class="m-row m-row-4${i.active ? '' : ' retired'}"><b>${esc(i.name)}</b><span>GST ${Number(i.gst_rate)}%</span><span class="mono">${rs(i.price_paise)}</span>${manage ? `<button type="button" class="btn small" data-edit-price="minibar:${esc(i.id)}">Edit</button>` : '<span></span>'}</div>`).join('') || '<div class="empty">No minibar items yet.</div>'}</div>`
  }

  async click(t: HTMLElement): Promise<boolean> {
    const api = this.h.api, modal = this.h.modal
    const d = t.closest<HTMLElement>('[data-deliver]')?.dataset.deliver
    if (d) {
      const r = await api.post<{ chargedPaise: number }>(`/api/laundry/orders/${d}/deliver`)
      toast(`Delivered: ${rs(r.chargedPaise)} added to the guest's bill`)
      await this.load(); return true
    }
    const lp = t.closest<HTMLElement>('[data-lp]')?.dataset.lp
    const ep = t.closest<HTMLElement>('[data-edit-price]')?.dataset.editPrice
    if (lp || ep) {
      const [kind, id] = (ep ?? `${lp}:`).split(':') as ['laundry' | 'minibar', string]
      const item = id ? (kind === 'laundry' ? this.laundry : this.minibar).find((x) => x.id === id) : undefined
      modal.open(`${item ? 'Edit' : 'Add'} ${kind} item`, `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="60" value="${esc(item?.name ?? '')}"></label>
        ${kind === 'laundry' && !item ? `<label>Service<select name="service">${Object.entries(SV).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>` : ''}
        <label>Price ₹<input name="price" type="number" min="0" step="0.5" value="${item ? item.price_paise / 100 : ''}"></label>
        ${kind === 'minibar' ? `<label>GST %<select name="gst">${[5, 12, 18, 28, 40].map((g) => `<option ${Number(item?.gst_rate ?? 18) === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>` : ''}
        ${item ? `<label class="check"><input type="checkbox" name="active" ${item.active ? 'checked' : ''}> In use</label>` : ''}</div>`, 'Save', async (f) => {
        const body: Record<string, unknown> = { name: val(f, 'name'), price: Number(val(f, 'price')) }
        if (kind === 'minibar') body.gstRate = Number(val(f, 'gst'))
        const base = kind === 'laundry' ? '/api/laundry/items' : '/api/hk/minibar-items'
        if (item) await api.req('PATCH', `${base}/${item.id}`, { ...body, active: checked(f, 'active') })
        else await api.post(base, kind === 'laundry' ? { ...body, service: val(f, 'service') } : body)
        await this.load(); this.h.render(); return 'Saved'
      })
      return false
    }
    return false
  }
}
