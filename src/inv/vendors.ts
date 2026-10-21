import { esc, toast, tonePill, showDate } from '../ui/dom'
import { checked, val } from '../ui/form-modal'
import type { WorkspaceHost } from '../ui/workspace'
import { CATEGORY, rupees, type Item } from './items'

// The vendor master (GSTIN and PAN checked, TDS category, MSME status for the 15/45-day rule, bank
// details kept to accounts) and rate contracts per item.

interface Vendor {
  id: string; name: string; legal_name: string | null; gstin: string | null; pan: string | null; state_code: string; payee_type: string; tds_code: string | null
  msme: string; udyam_no: string | null; written_agreement: boolean; payment_terms_days: number; categories: string[]; phone: string | null; email: string | null; address: string | null
  bank_name: string | null; bank_account: string | null; ifsc: string | null; upi: string | null; notes: string | null; active: boolean; rates: number
}
interface Meta { tds: { code: string; section: string; rate: number | { individual_huf: number; others: number } }[]; msmeDays: { with_agreement: number; without_agreement: number } }

const TDS_LABEL: Record<string, string> = {
  contractor: 'Contractor (housekeeping/security agency, transport, decor)', professional_fees: 'Professional fees (CA, lawyer, consultant, artist)', technical_services: 'Technical services (software, maintenance contracts)',
  rent_land_building_furniture: 'Rent: land, building, furniture', rent_plant_machinery: 'Rent: plant, machinery, equipment', commission_brokerage: 'Commission (travel / event agents)',
  purchase_of_goods: 'Purchase of goods (large suppliers)', director_fees: 'Director fees',
}
const PAYEE: Record<string, string> = { individual: 'Individual', huf: 'HUF', company: 'Company', firm: 'Firm / LLP', other: 'Other' }

export class VendorsView {
  private list: Vendor[] = []
  private meta: Meta | null = null
  private q = ''
  constructor(private h: WorkspaceHost) {}

  async load() {
    this.list = await this.h.cached('/api/vendors?all=1')
    this.meta ??= await this.h.api.get('/api/vendors/meta')
  }

  html() {
    const q = this.q.toLowerCase()
    const shown = this.list.filter((v) => !q || `${v.name} ${v.gstin ?? ''} ${v.pan ?? ''}`.toLowerCase().includes(q))
    const tds = (code: string | null) => this.meta?.tds.find((t) => t.code === code)?.section
    return `<div class="ws-toolbar">${this.h.can('vendors.manage') ? '<button type="button" class="btn primary" data-vd="add">Add vendor</button>' : ''}
        <input class="ws-search" type="search" placeholder="Search name, GSTIN or PAN" value="${esc(this.q)}" aria-label="Search vendors"></div>
      ${shown.map((v) => `<div class="row-card${v.active ? '' : ' retired'}" data-asset="${esc(v.id)}"><div class="rc-title">${esc(v.name)}</div>
        <div class="rc-sub">${v.gstin ? `GSTIN ${esc(v.gstin)}` : v.pan ? `PAN ${esc(v.pan)} · not GST registered` : '<span class="fd-warn">no GSTIN or PAN</span>'}${v.state_code !== '33' ? ' · outside Tamil Nadu (IGST)' : ''}
          · ${esc(PAYEE[v.payee_type] ?? v.payee_type)}${v.categories.length ? ` · ${v.categories.map((c) => esc(CATEGORY[c] ?? c)).join(', ')}` : ''} · pays in ${v.payment_terms_days} days${v.rates ? ` · ${v.rates} rate${v.rates > 1 ? 's' : ''}` : ''}</div>
        <div class="rc-right">${v.msme !== 'none' ? tonePill(`MSME ${v.msme}`, '--marigold') : ''}${v.tds_code ? tonePill(`TDS ${tds(v.tds_code) ?? v.tds_code}`, '--st-occupied') : ''}${v.bank_account ? '' : tonePill('No bank', '--muted')}</div></div>`).join('') || '<div class="empty">No vendors yet.</div>'}`
  }

  onInput(el: HTMLElement) { if (el.classList.contains('ws-search')) { this.q = (el as HTMLInputElement).value; this.h.render() } }

  async click(el: HTMLElement): Promise<boolean> {
    if (el.closest('[data-vd=add]')) { this.edit(); return false }
    const id = el.closest<HTMLElement>('[data-asset]')?.dataset.asset
    if (id) this.edit(this.list.find((v) => v.id === id))
    return false
  }

  private edit(v?: Vendor) {
    if (!this.h.can('vendors.manage')) return
    const m = this.meta!, bank = this.h.can('vendors.bank')
    const rate = (r: Meta['tds'][number]['rate']) => typeof r === 'number' ? `${r}%` : `${r.individual_huf}% / ${r.others}%`
    this.h.modal.open(v ? v.name : 'Add vendor', `<div class="form-grid">
        <label class="span2">Name<input name="name" maxlength="80" value="${esc(v?.name ?? '')}"></label>
        <label class="span2">Legal name (as on GST)<input name="legal" maxlength="120" value="${esc(v?.legal_name ?? '')}"></label>
        <label>GSTIN<input name="gstin" maxlength="15" autocapitalize="characters" value="${esc(v?.gstin ?? '')}" placeholder="33ABCDE1234F1Z5"></label>
        <label>PAN<input name="pan" maxlength="10" autocapitalize="characters" value="${esc(v?.pan ?? '')}" placeholder="taken from the GSTIN"></label>
        <label class="span2">TDS when paying<select name="tds"><option value="">No TDS (goods below the limit, most suppliers)</option>${m.tds.map((t) => `<option value="${t.code}" ${t.code === v?.tds_code ? 'selected' : ''}>${esc(TDS_LABEL[t.code] ?? t.code)} · ${t.section} · ${rate(t.rate)}</option>`).join('')}</select></label>
        <label>MSME (Udyam)<select name="msme">${['none', 'micro', 'small', 'medium'].map((x) => `<option value="${x}" ${x === (v?.msme ?? 'none') ? 'selected' : ''}>${x === 'none' ? 'Not MSME' : x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></label>
        <label>Udyam number<input name="udyam" maxlength="19" autocapitalize="characters" value="${esc(v?.udyam_no ?? '')}" placeholder="UDYAM-TN-02-0012345"></label>
        <label class="check span2"><input type="checkbox" name="agreement" ${v?.written_agreement ? 'checked' : ''}> Written agreement on payment terms (micro / small: pay within ${m.msmeDays.with_agreement} days, otherwise ${m.msmeDays.without_agreement})</label>
        <label>Payment terms (days)<input name="terms" type="number" min="0" max="180" value="${v?.payment_terms_days ?? 30}"></label>
        <label>Phone<input name="phone" inputmode="tel" maxlength="16" value="${esc(v?.phone ?? '')}"></label>
        <label class="span2">Email<input name="email" type="email" maxlength="80" value="${esc(v?.email ?? '')}"></label>
        <label class="span2">Address<input name="address" maxlength="200" value="${esc(v?.address ?? '')}"></label>
        <fieldset class="span2"><legend>Supplies</legend>${Object.entries(CATEGORY).map(([k, l]) => `<label class="check"><input type="checkbox" name="c_${k}" ${v?.categories.includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}</fieldset>
        ${bank ? `<label>Bank<input name="bankName" maxlength="60" value="${esc(v?.bank_name ?? '')}"></label><label>IFSC<input name="ifsc" maxlength="11" autocapitalize="characters" value="${esc(v?.ifsc ?? '')}"></label>
          <label>Account number<input name="account" inputmode="numeric" maxlength="20" value="${esc(v?.bank_account ?? '')}"></label><label>UPI<input name="upi" maxlength="60" value="${esc(v?.upi ?? '')}"></label>`
          : `<p class="muted small span2">Bank details are entered by accounts${v?.bank_account ? ` (account ${esc(v.bank_account)})` : ''}.</p>`}
        ${v ? `<label class="check span2"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active</label>` : ''}</div>
      <p class="muted small">The GSTIN is checked for typing mistakes here; whether it is active on the GST portal is checked when the GST connection is set up.</p>`, v ? 'Save' : 'Add', async (f) => {
      const body: Record<string, unknown> = {
        name: val(f, 'name'), legalName: val(f, 'legal') || null, gstin: val(f, 'gstin') || null, pan: val(f, 'pan') || null, tdsCode: val(f, 'tds') || null,
        msme: val(f, 'msme'), udyamNo: val(f, 'udyam') || null, writtenAgreement: checked(f, 'agreement'), paymentTermsDays: Number(val(f, 'terms')),
        phone: val(f, 'phone'), email: val(f, 'email'), address: val(f, 'address'), categories: Object.keys(CATEGORY).filter((k) => checked(f, `c_${k}`)),
        ...(bank ? { bankName: val(f, 'bankName'), ifsc: val(f, 'ifsc'), bankAccount: val(f, 'account'), upi: val(f, 'upi') } : {}), ...(v ? { active: checked(f, 'active') } : {}),
      }
      if (v) await this.h.api.req('PATCH', `/api/vendors/${v.id}`, body)
      else await this.h.api.post('/api/vendors', body)
      await this.load(); this.h.render(); return v ? 'Saved' : 'Vendor added'
    })
  }
}

interface Rate { id: string; vendor_id: string; vendor: string; item_id: string; item: string; purchase_unit: string; rate_paise: string; valid_from: string; valid_to: string; current: boolean }

export class RatesView {
  private list: Rate[] = []
  private q = ''
  constructor(private h: WorkspaceHost) {}

  async load() { this.list = await this.h.cached('/api/rate-contracts?current=1') }

  html() {
    const q = this.q.toLowerCase()
    const shown = this.list.filter((r) => !q || `${r.item} ${r.vendor}`.toLowerCase().includes(q))
    const best = new Map<string, number>()
    for (const r of shown.filter((x) => x.current)) best.set(r.item_id, Math.min(best.get(r.item_id) ?? Infinity, Number(r.rate_paise)))
    return `<div class="ws-toolbar">${this.h.can('vendors.manage', 'stores.manage') ? '<button type="button" class="btn primary" data-rt="add">Add rate</button>' : ''}
        <input class="ws-search" type="search" placeholder="Search item or vendor" value="${esc(this.q)}" aria-label="Search rates"></div>
      <div class="m-table"><div class="m-row rate-row head"><span>Item</span><span>Vendor</span><span>Rate</span><span>Valid</span><span></span></div>
      ${shown.map((r) => `<div class="m-row rate-row"><b>${esc(r.item)}</b><span>${esc(r.vendor)}</span>
        <span class="mono">${rupees(Number(r.rate_paise))} <small class="muted">/ ${esc(r.purchase_unit)}</small> ${r.current && best.get(r.item_id) === Number(r.rate_paise) ? tonePill('Best', '--st-vacant') : ''}</span>
        <span class="small">${esc(showDate(r.valid_from))} → ${esc(showDate(r.valid_to))}${r.current ? '' : ' <span class="muted">(from)</span>'}</span>
        ${this.h.can('vendors.manage', 'stores.manage') ? `<button type="button" class="btn small" data-rt="end:${esc(r.id)}">End…</button>` : '<span></span>'}</div>`).join('') || '<div class="empty">No current rates.</div>'}</div>`
  }

  onInput(el: HTMLElement) { if (el.classList.contains('ws-search')) { this.q = (el as HTMLInputElement).value; this.h.render() } }

  async click(el: HTMLElement): Promise<boolean> {
    const a = el.closest<HTMLElement>('[data-rt]')?.dataset.rt
    if (!a) return false
    const api = this.h.api, done = async (m: string) => { await this.load(); this.h.render(); return m }
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
    if (a.startsWith('end:')) {
      this.h.modal.open('End this rate', `<div class="form-grid"><label>Last day<input name="on" type="date" value="${today}"></label></div>`, 'End rate', async (f) => {
        await api.post(`/api/rate-contracts/${a.slice(4)}/end`, { on: val(f, 'on') }); return done('Rate ended')
      })
      return false
    }
    const [items, vendors] = await Promise.all([api.get<Item[]>('/api/items'), api.get<{ id: string; name: string; active: boolean }[]>('/api/vendors')])
    if (!items.length || !vendors.length) { toast('Add the items and vendors first.'); return false }
    const end = new Date(Date.now() + 330 * 60_000); end.setMonth(end.getMonth() + 3)
    this.h.modal.open('Add rate', `<div class="form-grid"><label class="span2">Item<select name="item">${items.map((i) => `<option value="${esc(i.id)}">${esc(i.name)} · per ${esc(i.purchase_unit)}</option>`).join('')}</select></label>
      <label class="span2">Vendor<select name="vendor">${vendors.filter((v) => v.active).map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label>
      <label>Rate (₹, before GST)<input name="rate" type="number" min="0.01" step="0.01"></label><span></span>
      <label>From<input name="from" type="date" value="${today}"></label><label>To<input name="to" type="date" value="${end.toISOString().slice(0, 10)}"></label></div>`, 'Add', async (f) => {
      await api.post('/api/rate-contracts', { itemId: val(f, 'item'), vendorId: val(f, 'vendor'), rate: Number(val(f, 'rate')), validFrom: val(f, 'from'), validTo: val(f, 'to') })
      return done('Rate added')
    })
    return false
  }
}
