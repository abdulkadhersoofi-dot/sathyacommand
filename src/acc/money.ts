import { esc, toast, tonePill, showDate } from '../ui/dom'
import { val } from '../ui/form-modal'
import { drcr, money, type Host } from './books'

// Money owed to the resort and money it holds: company accounts (credit limits, statements, ageing, money
// received), bank accounts (statement import, matching, settlements, reconciliation) and cash.

interface Debtor { id: string; name: string; kind: string; gstin: string | null; pan: string | null; address: string | null; city: string | null; contact_name: string | null; phone: string | null; email: string | null; credit_limit_paise: number | null; terms_days: number; active: boolean; outstandingPaise: number; overduePaise: number; ageing: number[]; oldestDays: number }
interface Item { date: string; voucher: string; narration: string; amountPaise: number; openPaise: number; dueDate: string; daysOld: number; overdue: boolean }
interface Statement { debtor: Debtor; from: string; to: string; openingPaise: number; closingPaise: number; lines: { date: string; voucher: string; narration: string; debitPaise: number; creditPaise: number; balancePaise: number }[]; open: Item[]; ageing: number[]; overduePaise: number }
const KIND: Record<string, string> = { company: 'Company', travel_agent: 'Travel agent', ota: 'OTA', government: 'Government', other: 'Other' }

export class ReceivablesView {
  private list: Debtor[] = []
  private buckets: string[] = []
  private sel: string | null = null
  private st: Statement | null = null
  constructor(private h: Host) {}

  async load() {
    const r = await this.h.cached<{ debtors: Debtor[]; buckets: string[] }>('/api/debtors?all=1')
    this.list = r.debtors; this.buckets = r.buckets
    this.st = this.sel ? await this.h.cached<Statement>(`/api/debtors/${this.sel}/statement?from=${this.h.from}&to=${this.h.to}`) : null
  }

  html() { return this.st ? this.statement(this.st) : this.overview() }

  private overview() {
    const total = this.list.reduce((a, d) => a + d.outstandingPaise, 0), overdue = this.list.reduce((a, d) => a + d.overduePaise, 0)
    return `<div class="ws-toolbar">${this.h.can('receivables.manage') ? '<button type="button" class="btn primary" data-rv="add">Open an account</button>' : ''}
        <span class="small">Owed ${money(total)} · <span class="${overdue ? 'fd-warn' : ''}">overdue ${money(overdue)}</span></span></div>
      <p class="muted small">Companies and agents billed on credit. An account opens by itself the first time a bill is charged to a company; set its terms here, and the GM its credit limit: beyond it the desk and the restaurant cannot charge to it.</p>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Account</th><th class="n">Limit</th><th class="n">Owed</th><th class="n">Overdue</th>${this.buckets.map((b) => `<th class="n">${esc(b)} days</th>`).join('')}</tr></thead><tbody>
        ${this.list.map((d) => `<tr class="acc-click${d.active ? '' : ' retired'}" data-ledger="debtor:${esc(d.id)}"><td><b>${esc(d.name)}</b> <small class="muted">${esc(KIND[d.kind] ?? d.kind)} · ${d.terms_days} days${d.gstin ? ` · ${esc(d.gstin)}` : ''}</small></td>
          <td class="n">${d.credit_limit_paise == null ? '<span class="muted">not set</span>' : money(d.credit_limit_paise)}</td><td class="n"><b>${money(d.outstandingPaise)}</b></td>
          <td class="n ${d.overduePaise ? 'fd-warn' : ''}">${d.overduePaise ? money(d.overduePaise) : ''}</td>${d.ageing.map((a) => `<td class="n">${a ? money(a) : ''}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${4 + this.buckets.length}" class="empty">No accounts yet: they open when a bill is charged to a company.</td></tr>`}
      </tbody></table></div>`
  }

  private statement(s: Statement) {
    const d = s.debtor, full = this.list.find((x) => x.id === d.id)
    return `<div class="ws-toolbar"><button type="button" class="btn" data-rv="back">← All accounts</button>
        <label class="inline">From <input type="date" data-range="from" value="${esc(this.h.from)}"></label><label class="inline">To <input type="date" data-range="to" value="${esc(this.h.to)}"></label>
        ${this.h.can('receivables.manage') ? '<button type="button" class="btn primary" data-rv="receive">Money received…</button><button type="button" class="btn" data-rv="edit">Edit…</button>' : ''}
        ${this.h.can('credit.limit') ? '<button type="button" class="btn" data-rv="limit">Credit limit…</button>' : ''}
        <button type="button" class="btn" data-rv="print">Print statement</button></div>
      <div class="row-card mc-card"><div class="rc-title">${esc(d.name)} ${d.active ? '' : tonePill('Closed', '--muted')}</div>
        <div class="rc-sub">${esc(KIND[d.kind] ?? d.kind)}${d.gstin ? ` · GSTIN ${esc(d.gstin)}` : ''}${d.pan ? ` · PAN ${esc(d.pan)}` : ''} · pays in ${d.terms_days} days · limit ${full?.credit_limit_paise == null ? 'not set' : money(full.credit_limit_paise)}</div>
        <div class="rc-sub">${esc([d.contact_name, d.phone, d.email].filter(Boolean).join(' · ')) || 'No contact yet'}</div>
        <div class="mc-figs"><span><small>Owed</small><b class="mono">${money(full?.outstandingPaise ?? s.closingPaise)}</b></span><span><small>Overdue</small><b class="mono ${s.overduePaise ? 'fd-warn' : ''}">${money(s.overduePaise)}</b></span>
          ${this.buckets.map((b, i) => `<span><small>${esc(b)} days</small><b class="mono">${money(s.ageing[i] ?? 0)}</b></span>`).join('')}</div></div>
      <div class="sec-title">Unpaid</div>
      ${s.open.length ? `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Date</th><th>Bill</th><th class="n">Billed</th><th class="n">Unpaid</th><th>Due</th></tr></thead><tbody>
        ${s.open.map((i) => `<tr><td class="mono">${esc(showDate(i.date))}</td><td>${esc(i.narration)}</td><td class="n">${money(i.amountPaise)}</td><td class="n"><b>${money(i.openPaise)}</b></td>
          <td>${esc(showDate(i.dueDate))} ${i.overdue ? tonePill(`${i.daysOld} days old`, '--st-departing') : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nothing unpaid.</div>'}
      <div class="sec-title">Statement</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Date</th><th>Voucher</th><th>Particulars</th><th class="n">Charged</th><th class="n">Received</th><th class="n">Balance</th></tr></thead><tbody>
        <tr class="acc-grp"><td colspan="5">Opening balance</td><td class="n">${drcr(s.openingPaise)}</td></tr>
        ${s.lines.map((l) => `<tr><td class="mono">${esc(showDate(l.date))}</td><td class="mono">${esc(l.voucher)}</td><td>${esc(l.narration)}</td><td class="n">${l.debitPaise ? money(l.debitPaise) : ''}</td><td class="n">${l.creditPaise ? money(l.creditPaise) : ''}</td><td class="n">${drcr(l.balancePaise)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="5">Closing balance</td><td class="n">${drcr(s.closingPaise)}</td></tr></tfoot></table></div>`
  }

  async change(el: HTMLElement) {
    const k = (el as HTMLInputElement).dataset.range as 'from' | 'to' | undefined
    if (!k || !(el as HTMLInputElement).value) return false
    this.h[k] = (el as HTMLInputElement).value
    await this.load(); return true
  }

  async click(el: HTMLElement) {
    const row = el.closest<HTMLElement>('[data-ledger^="debtor:"]')?.dataset.ledger
    if (row) { this.sel = row.slice(7); await this.load(); return true }
    const a = el.closest<HTMLElement>('[data-rv]')?.dataset.rv
    if (a === 'back') { this.sel = null; this.st = null; await this.load(); return true }
    if (a === 'add') this.form()
    if (a === 'edit' && this.st) this.form(this.st.debtor)
    if (a === 'print' && this.sel) await this.h.api.openDocument(`/api/debtors/${this.sel}/statement/print?from=${this.h.from}&to=${this.h.to}`)
    if (a === 'limit' && this.st) {
      const d = this.list.find((x) => x.id === this.sel)
      this.h.modal.open(`Credit limit: ${this.st.debtor.name}`, `<p class="muted small">Owed now ${money(d?.outstandingPaise ?? 0)}. Leave blank for no limit.</p>
        <div class="form-grid"><label>Limit (₹)<input name="limit" type="number" min="0" step="1000" value="${d?.credit_limit_paise == null ? '' : d.credit_limit_paise / 100}"></label></div>`, 'Save', async (f) => {
        await this.h.api.req('PATCH', `/api/debtors/${this.sel}`, { creditLimit: val(f, 'limit') === '' ? null : Number(val(f, 'limit')) })
        await this.load(); this.h.render()
        return 'Credit limit saved'
      })
    }
    if (a === 'receive' && this.st) {
      const banks = await this.h.api.get<{ id: string; name: string; is_default: boolean; active: boolean }[]>('/api/bank-accounts').catch(() => [])
      this.h.modal.open(`Money received: ${this.st.debtor.name}`, `<div class="form-grid">
          <label>Amount it settles (₹, TDS included)<input name="amount" type="number" min="1" step="0.01" value="${(this.list.find((x) => x.id === this.sel)?.outstandingPaise ?? 0) / 100 || ''}"></label>
          <label>Paid by<select name="mode"><option value="bank">Bank transfer</option><option value="upi">UPI</option><option value="cheque">Cheque</option><option value="cash">Cash</option></select></label>
          <label>UTR / cheque no.<input name="ref" maxlength="40"></label>
          <label>Into<select name="bank">${banks.filter((b) => b.active).map((b) => `<option value="${esc(b.id)}"${b.is_default ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
          <label>TDS they deducted (₹)<input name="tds" type="number" min="0" step="0.01" value="0"></label>
          <label>Section<input name="sec" maxlength="10" placeholder="194-I, 194C"></label>
          <label class="span2">Note<input name="note" maxlength="200"></label></div>`, 'Record', async (f) => {
        const r = await this.h.api.post<{ number: string }>('/api/ar-receipts', { debtorId: this.sel, amount: Number(val(f, 'amount')), mode: val(f, 'mode'), reference: val(f, 'ref') || undefined,
          bankAccountId: val(f, 'bank') || undefined, tds: Number(val(f, 'tds') || 0), tdsSection: val(f, 'sec') || undefined, note: val(f, 'note') || undefined })
        await this.load(); this.h.render()
        return `Recorded ${r.number}`
      })
    }
    return false
  }

  private form(d?: Debtor) {
    this.h.modal.open(d ? d.name : 'Open an account', `<div class="form-grid">
        <label class="span2">Name<input name="name" maxlength="120" value="${esc(d?.name ?? '')}"></label>
        <label>Kind<select name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}"${d?.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Pays in (days)<input name="terms" type="number" min="0" max="365" value="${d?.terms_days ?? 30}"></label>
        <label>GSTIN<input name="gstin" maxlength="15" value="${esc(d?.gstin ?? '')}"></label><label>PAN<input name="pan" maxlength="10" value="${esc(d?.pan ?? '')}"></label>
        <label class="span2">Address<input name="address" maxlength="200" value="${esc(d?.address ?? '')}"></label><label>City<input name="city" maxlength="60" value="${esc(d?.city ?? '')}"></label>
        <label>Contact<input name="contact" maxlength="60" value="${esc(d?.contact_name ?? '')}"></label><label>Phone<input name="phone" maxlength="20" value="${esc(d?.phone ?? '')}"></label>
        <label>Email<input name="email" type="email" maxlength="120" value="${esc(d?.email ?? '')}"></label>
        ${d ? `<label>Account<select name="active"><option value="1"${d.active ? ' selected' : ''}>Open</option><option value="0"${d.active ? '' : ' selected'}>Closed for credit</option></select></label>` : ''}</div>`, d ? 'Save' : 'Open account', async (f) => {
      const body = { name: val(f, 'name'), kind: val(f, 'kind'), termsDays: Number(val(f, 'terms')), gstin: val(f, 'gstin') || null, pan: val(f, 'pan') || null, address: val(f, 'address'), city: val(f, 'city'),
        contactName: val(f, 'contact'), phone: val(f, 'phone'), email: val(f, 'email'), ...(d ? { active: val(f, 'active') === '1' } : {}) }
      if (d) await this.h.api.req('PATCH', `/api/debtors/${d.id}`, body); else await this.h.api.post('/api/debtors', body)
      await this.load(); this.h.render()
      return d ? 'Saved' : 'Account opened'
    })
  }
}

interface Bank { id: string; name: string; bank: string | null; branch: string | null; account_no: string | null; ifsc: string | null; account_code: string; is_default: boolean; active: boolean; open: number; last_date: string | null; bookPaise: number; statementPaise: number | null }
interface BLine { id: string; date: string; description: string; reference: string | null; amount_paise: string; balance_paise: string | null; status: string; voucher_number: string | null; note: string | null; decided_by_name: string | null }
interface Recon { asOf: string; bookPaise: number; statementPaise: number | null; statementDate: string | null; inBooksNotBank: { number: string; date: string; narration: string; amt: number }[]; inBankNotBooks: { id: string }[]; expectedStatementPaise: number; differencePaise: number | null }

export class BanksView {
  private banks: Bank[] = []
  private bankId = ''
  private lines: BLine[] = []
  private show = 'open'
  private recon: Recon | null = null
  constructor(private h: Host) {}

  async load() {
    this.banks = await this.h.cached('/api/bank-accounts')
    if (!this.banks.some((b) => b.id === this.bankId)) this.bankId = this.banks.find((b) => b.is_default)?.id ?? this.banks[0]?.id ?? ''
    if (!this.bankId) return
    this.lines = await this.h.cached(`/api/bank/${this.bankId}/lines?status=${this.show}`)
    this.recon = await this.h.cached(`/api/bank/${this.bankId}/reconcile?asOf=${this.h.to}`)
  }

  html() {
    const b = this.banks.find((x) => x.id === this.bankId), r = this.recon
    const manage = this.h.can('bank.reconcile')
    return `<div class="ws-toolbar"><select data-bank aria-label="Bank account">${this.banks.map((x) => `<option value="${esc(x.id)}"${x.id === this.bankId ? ' selected' : ''}>${esc(x.name)}${x.is_default ? ' (default)' : ''}</option>`).join('')}</select>
        ${manage ? `<label class="btn primary file-btn">Import statement (CSV)<input type="file" accept=".csv,text/csv" data-import hidden></label><button type="button" class="btn" data-bk="auto">Match again</button><button type="button" class="btn" data-bk="add">Add bank account</button>` : ''}
        <select data-show aria-label="Show"><option value="open"${this.show === 'open' ? ' selected' : ''}>To settle</option><option value="all"${this.show === 'all' ? ' selected' : ''}>All lines</option></select></div>
      ${b ? `<div class="row-card mc-card"><div class="rc-title">${esc(b.name)} <small class="muted">${esc([b.bank, b.branch, b.account_no, b.ifsc].filter(Boolean).join(' · '))} · ledger ${esc(b.account_code)}</small></div>
        ${r ? `<div class="mc-figs"><span><small>Books on ${esc(r.asOf)}</small><b class="mono">${money(r.bookPaise)}</b></span>
          <span><small>Statement${r.statementDate ? ` on ${esc(r.statementDate)}` : ''}</small><b class="mono">${r.statementPaise == null ? '—' : money(r.statementPaise)}</b></span>
          <span><small>In the books, not the bank</small><b class="mono">${r.inBooksNotBank.length}</b></span><span><small>In the bank, not the books</small><b class="mono">${r.inBankNotBooks.length}</b></span>
          <span><small>Difference</small><b class="mono ${r.differencePaise ? 'fd-warn' : ''}">${r.differencePaise == null ? '—' : money(r.differencePaise)}</b></span></div>
          ${r.inBooksNotBank.length ? `<div class="rc-sub">Not yet through the bank: ${r.inBooksNotBank.slice(0, 6).map((x) => `${esc(showDate(x.date))} ${esc(x.number)} ${money(x.amt)}`).join(' · ')}${r.inBooksNotBank.length > 6 ? ' …' : ''}</div>` : ''}` : ''}</div>` : '<div class="empty">No bank account yet.</div>'}
      <p class="muted small">Import the statement from the bank's website as CSV. Lines with one book entry of the same amount (or bearing its UTR) match by themselves; post the rest from here: card and UPI settlements (the fee and its GST taken out), money from a company, charges, interest.</p>
      ${this.lines.map((l) => {
        const amt = Number(l.amount_paise)
        return `<div class="row-card bank-line"><div class="rc-title"><span class="mono">${esc(showDate(l.date))}</span> ${esc(l.description)}${l.reference ? ` <small class="muted">${esc(l.reference)}</small>` : ''}</div>
          <div class="rc-sub">${l.status === 'matched' ? `Matched to ${esc(l.voucher_number ?? '')}${l.note ? ` (${esc(l.note.replace('_', ' '))})` : ''}` : l.status === 'ignored' ? `Left out: ${esc(l.note ?? '')}` : 'Not in the books yet'}</div>
          <div class="rc-right"><b class="mono ${amt < 0 ? 'fd-warn' : ''}">${amt > 0 ? '+' : '−'}${money(Math.abs(amt))}</b>
            ${l.status === 'open' && manage ? `<span><button type="button" class="btn small" data-bl="match" data-id="${esc(l.id)}">Match…</button><button type="button" class="btn small primary" data-bl="post" data-id="${esc(l.id)}">Post…</button><button type="button" class="btn small" data-bl="ignore" data-id="${esc(l.id)}">Leave out…</button></span>` : ''}
            ${l.status === 'matched' && manage ? `<button type="button" class="btn small" data-bl="unmatch" data-id="${esc(l.id)}">Unmatch</button>` : ''}</div></div>`
      }).join('') || `<div class="empty">${this.show === 'open' ? 'Every statement line is settled.' : 'No statement imported yet.'}</div>`}`
  }

  async change(el: HTMLElement) {
    if (el.matches('[data-bank]')) { this.bankId = (el as HTMLSelectElement).value; await this.load(); return true }
    if (el.matches('[data-show]')) { this.show = (el as HTMLSelectElement).value; await this.load(); return true }
    if (el.matches('[data-import]')) {
      const file = (el as HTMLInputElement).files?.[0]
      if (!file) return false
      const r = await this.h.api.post<{ added: number; duplicates: number; skipped: number; matched: number }>('/api/bank/import', { bankAccountId: this.bankId, csv: await file.text(), fileName: file.name })
      toast(`${r.added} lines imported${r.duplicates ? `, ${r.duplicates} already there` : ''}; ${r.matched} matched to the books`)
      await this.load(); return true
    }
    return false
  }

  async click(el: HTMLElement) {
    const a = el.closest<HTMLElement>('[data-bk]')?.dataset.bk
    if (a === 'auto') { const r = await this.h.api.post<{ matched: number }>(`/api/bank/${this.bankId}/auto-match`); toast(`${r.matched} matched`); await this.load(); return true }
    if (a === 'add') this.addBank()
    const b = el.closest<HTMLElement>('[data-bl]')
    if (!b) return false
    const id = b.dataset.id!, line = this.lines.find((l) => l.id === id)!
    const amt = Number(line.amount_paise)
    const done = async (msg: string) => { await this.load(); this.h.render(); return msg }
    if (b.dataset.bl === 'unmatch') { await this.h.api.post(`/api/bank/lines/${id}/unmatch`); await this.load(); return true }
    if (b.dataset.bl === 'ignore') {
      this.h.modal.open('Leave the line out', '<div class="form-grid"><label class="span2">Why<input name="reason" maxlength="200" placeholder="e.g. opening balance line"></label></div>', 'Leave out', async (f) => {
        await this.h.api.post(`/api/bank/lines/${id}/ignore`, { reason: val(f, 'reason') }); return done('Left out')
      })
    }
    if (b.dataset.bl === 'match') {
      const c = await this.h.api.get<{ voucher_id: string; line: number; number: string; date: string; narration: string }[]>(`/api/bank/lines/${id}/candidates`)
      this.h.modal.open(`Match ${money(amt)}`, c.length ? `<div class="form-grid"><label class="span2">Book entry<select name="v">${c.map((x) => `<option value="${esc(x.voucher_id)}|${x.line}">${esc(showDate(x.date))} · ${esc(x.number)} · ${esc(x.narration)}</option>`).join('')}</select></label></div>`
        : '<p>No unmatched book entry of this amount near this date. Post it instead.</p>', 'Match', async (f) => {
        const [voucherId, ln] = val(f, 'v').split('|')
        await this.h.api.post(`/api/bank/lines/${id}/match`, { voucherId, line: Number(ln) }); return done('Matched')
      })
    }
    if (b.dataset.bl === 'post') {
      const debtors = amt > 0 ? (await this.h.api.get<{ debtors: { id: string; name: string; outstandingPaise: number }[] }>('/api/debtors').catch(() => ({ debtors: [] }))).debtors : []
      const chart = (await this.h.api.get<{ accounts: { code: string; name: string; active: boolean }[] }>('/api/accounts/chart')).accounts.filter((x) => x.active)
      this.h.modal.open(`Post ${amt > 0 ? '+' : '−'}${money(Math.abs(amt))}: ${line.description}`, `<div class="form-grid">
          <label class="span2">What is it<select name="kind" data-kind>${amt > 0 ? '<option value="card_settlement">Card settlement</option><option value="upi_settlement">UPI settlement</option><option value="debtor_receipt">Money from a company</option>' : ''}<option value="account">Another account</option></select></label>
          <label data-for="settle">Takings settled (₹, before the fee)<input name="gross" type="number" min="0" step="0.01"></label><label data-for="settle">GST on the fee (₹)<input name="gst" type="number" min="0" step="0.01" value="0"></label>
          <label class="span2" data-for="debtor">Company<select name="debtor">${debtors.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} (owes ${money(d.outstandingPaise)})</option>`).join('')}</select></label>
          <label data-for="debtor">TDS they deducted (₹)<input name="tds" type="number" min="0" step="0.01" value="0"></label><label data-for="debtor">Section<input name="sec" maxlength="10"></label>
          <label class="span2" data-for="account">Account<select name="code">${chart.map((x) => `<option value="${esc(x.code)}"${x.code === (amt < 0 ? '6060' : '4900') ? ' selected' : ''}>${esc(x.code)} ${esc(x.name)}</option>`).join('')}</select></label>
          <label class="span2" data-for="account">Narration<input name="narration" maxlength="200" value="${esc(line.description)}"></label></div>`, 'Post', async (f) => {
        const kind = val(f, 'kind')
        await this.h.api.post(`/api/bank/lines/${id}/post`, { kind, gross: Number(val(f, 'gross') || 0), gst: Number(val(f, 'gst') || 0), debtorId: val(f, 'debtor') || undefined,
          tds: Number(val(f, 'tds') || 0), tdsSection: val(f, 'sec') || undefined, accountCode: val(f, 'code'), narration: val(f, 'narration') })
        return done('Posted and matched')
      })
      const m = this.h.modal.el
      const sync = () => {
        const k = m.querySelector<HTMLSelectElement>('[data-kind]')!.value
        m.querySelectorAll<HTMLElement>('[data-for]').forEach((x) => { x.hidden = !(x.dataset.for === 'settle' ? k.endsWith('settlement') : x.dataset.for === 'debtor' ? k === 'debtor_receipt' : k === 'account') })
      }
      m.querySelector('[data-kind]')!.addEventListener('change', sync); sync()
    }
    return false
  }

  private addBank() {
    this.h.modal.open('Add bank account', `<div class="form-grid">
        <label class="span2">Name<input name="name" maxlength="60" placeholder="e.g. SBI current account"></label>
        <label>Bank<input name="bank" maxlength="60"></label><label>Branch<input name="branch" maxlength="60"></label>
        <label>Account number<input name="no" maxlength="20" inputmode="numeric"></label><label>IFSC<input name="ifsc" maxlength="11"></label>
        <label class="span2"><span><input name="def" type="checkbox"> Payments go out of this account by default</span></label></div>`, 'Add', async (f) => {
      await this.h.api.post('/api/bank-accounts', { name: val(f, 'name'), bank: val(f, 'bank'), branch: val(f, 'branch'), accountNo: val(f, 'no'), ifsc: val(f, 'ifsc'), isDefault: (f.elements.namedItem('def') as HTMLInputElement).checked })
      await this.load(); this.h.render()
      return 'Bank account added'
    })
  }
}

interface CashTxn { id: string; number: string; kind: string; date: string; amount_paise: string; account: string | null; description: string | null; payee: string | null; reference: string | null; by_name: string; voucher: string | null }
const CASH_KIND: Record<string, string> = { deposit: 'Banked', petty_topup: 'Petty cash topped up', petty_expense: 'Paid from petty cash' }

export class CashView {
  private d: { asOf: string; cashPaise: number; pettyPaise: number; txns: CashTxn[]; note: string } | null = null
  constructor(private h: Host) {}
  async load() { this.d = await this.h.cached('/api/cash') }
  html() {
    const d = this.d!, manage = this.h.can('cash.manage')
    return `<div class="ws-toolbar">${manage ? '<button type="button" class="btn primary" data-cs="deposit">Bank the cash…</button><button type="button" class="btn" data-cs="topup">Top up petty cash…</button><button type="button" class="btn" data-cs="expense">Pay from petty cash…</button>' : ''}</div>
      <div class="row-card mc-card"><div class="mc-figs"><span><small>Cash in hand</small><b class="mono">${money(d.cashPaise)}</b></span><span><small>Petty cash</small><b class="mono">${money(d.pettyPaise)}</b></span></div>
        <div class="rc-sub">${esc(d.note)}</div></div>
      ${d.txns.map((x) => `<div class="m-row"><span class="mono">${esc(showDate(x.date))}</span><b>${esc(CASH_KIND[x.kind] ?? x.kind)}${x.description ? `: ${esc(x.description)}` : ''}</b>
        <span>${money(Number(x.amount_paise))}${x.payee ? ` · ${esc(x.payee)}` : ''}${x.account ? ` · ${esc(x.account)}` : ''} · ${esc(x.number)} · ${esc(x.by_name)}</span></div>`).join('') || '<div class="empty">Nothing yet.</div>'}`
  }
  async click(el: HTMLElement) {
    const a = el.closest<HTMLElement>('[data-cs]')?.dataset.cs
    if (!a) return false
    const done = async (msg: string) => { await this.load(); this.h.render(); return msg }
    const banks = await this.h.api.get<{ id: string; name: string; is_default: boolean; active: boolean }[]>('/api/bank-accounts')
    const bankSel = `<select name="bank">${banks.filter((b) => b.active).map((b) => `<option value="${esc(b.id)}"${b.is_default ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select>`
    if (a === 'deposit') this.h.modal.open('Bank the cash', `<div class="form-grid"><label>Amount (₹)<input name="amount" type="number" min="1" step="0.01"></label><label>Into${bankSel}</label><label class="span2">Pay-in slip no.<input name="ref" maxlength="40"></label></div>`, 'Record', async (f) => {
      await this.h.api.post('/api/cash/deposit', { amount: Number(val(f, 'amount')), bankAccountId: val(f, 'bank'), reference: val(f, 'ref') || undefined }); return done('Recorded')
    })
    if (a === 'topup') this.h.modal.open('Top up petty cash', `<div class="form-grid"><label>Amount (₹)<input name="amount" type="number" min="1" step="0.01"></label><label>From<select name="from"><option value="cash">Cash in hand</option><option value="bank">Bank</option></select></label><label>Bank${bankSel}</label></div>`, 'Record', async (f) => {
      await this.h.api.post('/api/cash/petty-topup', { amount: Number(val(f, 'amount')), from: val(f, 'from'), bankAccountId: val(f, 'bank') }); return done('Recorded')
    })
    if (a === 'expense') {
      const chart = (await this.h.api.get<{ accounts: { code: string; name: string; type: string; active: boolean }[] }>('/api/accounts/chart')).accounts.filter((x) => x.active && x.type === 'expense')
      this.h.modal.open('Pay from petty cash', `<div class="form-grid"><label>Amount (₹)<input name="amount" type="number" min="1" step="0.01"></label>
          <label>Expense<select name="code">${chart.map((x) => `<option value="${esc(x.code)}"${x.code === '6000' ? ' selected' : ''}>${esc(x.code)} ${esc(x.name)}</option>`).join('')}</select></label>
          <label class="span2">For<input name="desc" maxlength="200" placeholder="e.g. pump repair"></label><label class="span2">Paid to<input name="payee" maxlength="80"></label>
          <label class="span2"><span><input name="confirm" type="checkbox"> Pay in cash even above ₹10,000 to one party today (not deductible)</span></label></div>`, 'Record', async (f) => {
        const r = await this.h.api.post<{ number: string; warning: string | null }>('/api/cash/petty-expense', { amount: Number(val(f, 'amount')), accountCode: val(f, 'code'), description: val(f, 'desc'), payee: val(f, 'payee'),
          confirm: (f.elements.namedItem('confirm') as HTMLInputElement).checked })
        return done(r.warning ? `${r.number} recorded. ${r.warning}` : `${r.number} recorded`)
      })
    }
    return false
  }
}
