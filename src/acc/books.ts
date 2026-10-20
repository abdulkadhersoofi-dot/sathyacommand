import { esc, tonePill } from '../ui/dom'
import { val } from '../ui/form-modal'
import type { WorkspaceHost } from '../ui/workspace'

// The books: day book, trial balance, ledgers (with the parties in them), profit and loss by department,
// balance sheet, journal entries and their reversal, the chart of accounts and month locks.

export type Host = WorkspaceHost & { from: string; to: string; openLedger(code: string, party?: string): void }
interface Account { code: string; name: string; type: string; grp: string; dept: string | null; system: boolean; active: boolean; openingPaise: number; debitPaise: number; creditPaise: number; closingPaise: number }
interface VLine { line: number; account_code: string; account: string; dept: string | null; debit_paise: string; credit_paise: string; party_name: string | null; ref: string | null }
interface Voucher { id: string; number: string; kind: string; date: string; doc_date: string | null; narration: string; source_type: string | null; total_paise: string; created_by: string | null; reversed_by: string | null; reverses: string | null; lines: VLine[] }

/** ₹ with paise, Indian grouping. */
export const money = (paise: number) => `${paise < 0 ? '−' : ''}₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** A balance as Dr / Cr. */
export const drcr = (paise: number) => (paise ? `${money(Math.abs(paise))} ${paise > 0 ? 'Dr' : 'Cr'}` : '—')
const KIND: Record<string, string> = { sales: 'Sales', receipt: 'Receipt', purchase: 'Purchase', payment: 'Payment', stock: 'Stock', journal: 'Journal', reversal: 'Reversal' }

export const rangeBar = (h: Host, extra = '') => `<div class="ws-toolbar"><label class="inline">From <input type="date" data-range="from" value="${esc(h.from)}"></label>
  <label class="inline">To <input type="date" data-range="to" value="${esc(h.to)}"></label>${extra}</div>`
/** Applies a changed date range; true when it was one. */
export function rangeChange(h: Host, el: HTMLElement) {
  const k = (el as HTMLInputElement).dataset.range as 'from' | 'to' | undefined
  if (!k || !(el as HTMLInputElement).value) return false
  h[k] = (el as HTMLInputElement).value
  return true
}

function voucherCard(v: Voucher) {
  const auto = v.source_type ? 'posted by the system' : v.created_by ? `by ${esc(v.created_by)}` : ''
  return `<div class="row-card acc-voucher"><div class="rc-title"><span class="mono">${esc(v.number)}</span> · ${esc(v.date)} · ${esc(v.narration)}</div>
    <div class="rc-sub">${esc(KIND[v.kind] ?? v.kind)} · ${auto}${v.doc_date ? ` · document dated ${esc(v.doc_date)} (that month was locked)` : ''}${v.reversed_by ? ` · reversed by ${esc(v.reversed_by)}` : ''}</div>
    <div class="acc-scroll"><table class="acc-table"><tbody>${v.lines.map((l) => `<tr><td><button type="button" class="link" data-ledger="${esc(l.account_code)}">${esc(l.account_code)} ${esc(l.account)}</button>${l.party_name ? ` <small class="muted">${esc(l.party_name)}</small>` : ''}${l.ref ? ` <small class="muted">${esc(l.ref)}</small>` : ''}</td>
      <td class="n">${Number(l.debit_paise) ? money(Number(l.debit_paise)) : ''}</td><td class="n">${Number(l.credit_paise) ? money(Number(l.credit_paise)) : ''}</td></tr>`).join('')}</tbody></table></div>
    ${v.kind === 'journal' && !v.source_type && !v.reversed_by ? `<div class="rc-right"><button type="button" class="btn small" data-reverse="${esc(v.id)}">Reverse…</button></div>` : ''}</div>`
}

async function reverse(h: Host, id: string, done: () => Promise<void>) {
  h.modal.open('Reverse the journal', `<p class="muted small">A reversal posts the same lines the other way round, dated today. The original stays in the books.</p>
    <div class="form-grid"><label class="span2">Why<input name="reason" maxlength="200" required></label></div>`, 'Reverse', async (f) => {
    const r = await h.api.post<{ number: string }>(`/api/accounts/vouchers/${id}/reverse`, { reason: val(f, 'reason') })
    await done(); h.render()
    return `Reversed by ${r.number}`
  })
}

export class DayBookView {
  private list: Voucher[] = []
  private kind = ''
  constructor(private h: Host) {}
  async load() { this.list = await this.h.cached(`/api/accounts/daybook?from=${this.h.from}&to=${this.h.to}${this.kind ? `&kind=${this.kind}` : ''}`) }
  html() {
    return `${rangeBar(this.h, `<select data-kind aria-label="Kind"><option value="">All vouchers</option>${Object.entries(KIND).map(([k, v]) => `<option value="${k}"${k === this.kind ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
      <p class="muted small">Bills, payments, purchases and documents post as they happen; the front office and restaurant post once their business day is closed by the night audit.</p>
      ${this.list.map(voucherCard).join('') || '<div class="empty">Nothing posted in these days.</div>'}`
  }
  async change(el: HTMLElement) {
    if (el.matches('[data-kind]')) this.kind = (el as HTMLSelectElement).value
    else if (!rangeChange(this.h, el)) return false
    await this.load(); return true
  }
  async click(el: HTMLElement) {
    const code = el.closest<HTMLElement>('[data-ledger]')?.dataset.ledger
    if (code) { this.h.openLedger(code); return false }
    const r = el.closest<HTMLElement>('[data-reverse]')?.dataset.reverse
    if (r) await reverse(this.h, r, () => this.load())
    return false
  }
}

export class TrialBalanceView {
  private d: { rows: Account[]; totals: { debitPaise: number; creditPaise: number; closingDebitPaise: number; closingCreditPaise: number } } | null = null
  constructor(private h: Host) {}
  async load() { this.d = await this.h.cached(`/api/accounts/trial-balance?from=${this.h.from}&to=${this.h.to}`) }
  html() {
    const d = this.d!, ok = d.totals.closingDebitPaise === d.totals.closingCreditPaise
    let grp = ''
    return `${rangeBar(this.h, `<span class="small">${tonePill(ok ? 'Balanced' : 'Does not balance', ok ? '--st-vacant' : '--st-departing')}</span>`)}
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Account</th><th class="n">Opening</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Closing</th></tr></thead><tbody>
      ${d.rows.map((r) => `${r.grp !== grp ? `<tr class="acc-grp"><td colspan="5">${esc((grp = r.grp))}</td></tr>` : ''}<tr data-ledger="${esc(r.code)}" class="acc-click"><td><span class="mono">${esc(r.code)}</span> ${esc(r.name)}</td>
        <td class="n">${drcr(r.openingPaise)}</td><td class="n">${r.debitPaise ? money(r.debitPaise) : ''}</td><td class="n">${r.creditPaise ? money(r.creditPaise) : ''}</td><td class="n"><b>${drcr(r.closingPaise)}</b></td></tr>`).join('')}
      </tbody><tfoot><tr><td>Total</td><td></td><td class="n">${money(d.totals.debitPaise)}</td><td class="n">${money(d.totals.creditPaise)}</td><td class="n">${money(d.totals.closingDebitPaise)} Dr · ${money(d.totals.closingCreditPaise)} Cr</td></tr></tfoot></table></div>`
  }
  async change(el: HTMLElement) { if (!rangeChange(this.h, el)) return false; await this.load(); return true }
  async click(el: HTMLElement) { const c = el.closest<HTMLElement>('[data-ledger]')?.dataset.ledger; if (c) this.h.openLedger(c); return false }
}

export class LedgerView {
  code = '1100'
  party = ''
  private chart: Account[] = []
  private d: { account: { code: string; name: string }; openingPaise: number; closingPaise: number; rows: (VLine & { voucher_id: string; number: string; date: string; narration: string; balancePaise: number; party_id: string | null })[]; parties: { id: string; name: string; type: string; balancePaise: number }[] } | null = null
  constructor(private h: Host) {}
  async load() {
    this.chart = (await this.h.cached<{ accounts: Account[] }>('/api/accounts/chart')).accounts
    this.d = await this.h.cached(`/api/accounts/ledger?code=${this.code}&from=${this.h.from}&to=${this.h.to}${this.party ? `&party=${encodeURIComponent(this.party)}` : ''}`)
  }
  html() {
    const d = this.d!
    return `${rangeBar(this.h, `<select data-acct aria-label="Account">${this.chart.map((a) => `<option value="${esc(a.code)}"${a.code === this.code ? ' selected' : ''}>${esc(a.code)} ${esc(a.name)}</option>`).join('')}</select>
        ${d.parties.length ? `<select data-party aria-label="Party"><option value="">Everyone</option>${d.parties.map((p) => `<option value="${esc(p.id)}"${p.id === this.party ? ' selected' : ''}>${esc(p.name)} (${drcr(p.balancePaise)})</option>`).join('')}</select>` : ''}`)}
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Date</th><th>Voucher</th><th>Particulars</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th></tr></thead><tbody>
        <tr class="acc-grp"><td colspan="5">Opening balance</td><td class="n">${drcr(d.openingPaise)}</td></tr>
        ${d.rows.map((r) => `<tr><td class="mono">${esc(r.date)}</td><td class="mono">${esc(r.number)}</td><td>${esc(r.narration)}${r.party_name ? ` <small class="muted">${esc(r.party_name)}</small>` : ''}</td>
          <td class="n">${Number(r.debit_paise) ? money(Number(r.debit_paise)) : ''}</td><td class="n">${Number(r.credit_paise) ? money(Number(r.credit_paise)) : ''}</td><td class="n">${drcr(r.balancePaise)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="5">Closing balance</td><td class="n">${drcr(d.closingPaise)}</td></tr></tfoot></table></div>`
  }
  async change(el: HTMLElement) {
    if (el.matches('[data-acct]')) { this.code = (el as HTMLSelectElement).value; this.party = '' }
    else if (el.matches('[data-party]')) this.party = (el as HTMLSelectElement).value
    else if (!rangeChange(this.h, el)) return false
    await this.load(); return true
  }
  async click() { return false }
}

interface Pnl {
  lines: { code: string; name: string; type: string; grp: string; dept: string; amountPaise: number }[]
  departments: { dept: string; name: string; operated: boolean; revenuePaise: number; costPaise: number; profitPaise: number }[]
  totals: { revenuePaise: number; expensesPaise: number; departmentalProfitPaise: number; undistributedPaise: number; profitPaise: number }
}
export class PnlView {
  private d: Pnl | null = null
  constructor(private h: Host) {}
  async load() { this.d = await this.h.cached(`/api/accounts/pnl?from=${this.h.from}&to=${this.h.to}`) }
  html() {
    const d = this.d!
    const sec = (type: string, title: string) => {
      const ls = d.lines.filter((l) => l.type === type)
      return `<tr class="acc-grp"><td colspan="3">${title}</td></tr>${ls.map((l) => `<tr data-ledger="${esc(l.code)}" class="acc-click"><td><span class="mono">${esc(l.code)}</span> ${esc(l.name)}</td><td>${esc(d.departments.find((x) => x.dept === l.dept)?.name ?? l.dept)}</td><td class="n">${money(l.amountPaise)}</td></tr>`).join('')}`
    }
    return `${rangeBar(this.h)}
      <div class="sec-title">By department</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Department</th><th class="n">Revenue</th><th class="n">Costs</th><th class="n">Profit</th></tr></thead><tbody>
        ${d.departments.filter((x) => x.operated).map((x) => `<tr><td>${esc(x.name)}</td><td class="n">${money(x.revenuePaise)}</td><td class="n">${money(x.costPaise)}</td><td class="n"><b class="${x.profitPaise < 0 ? 'fd-warn' : ''}">${money(x.profitPaise)}</b></td></tr>`).join('')}
        <tr class="acc-grp"><td colspan="3">Departmental profit</td><td class="n">${money(d.totals.departmentalProfitPaise)}</td></tr>
        ${d.departments.filter((x) => !x.operated).map((x) => `<tr><td>${esc(x.name)} <small class="muted">undistributed</small></td><td class="n">${x.revenuePaise ? money(x.revenuePaise) : ''}</td><td class="n">${money(x.costPaise)}</td><td class="n">${money(-x.costPaise + x.revenuePaise)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="3">Profit for the period</td><td class="n">${money(d.totals.profitPaise)}</td></tr></tfoot></table></div>
      <div class="sec-title">Accounts</div>
      <div class="acc-scroll"><table class="acc-table"><tbody>${sec('income', 'Income')}${sec('expense', 'Expenses')}</tbody>
        <tfoot><tr><td colspan="2">Income ${money(d.totals.revenuePaise)} less expenses ${money(d.totals.expensesPaise)}</td><td class="n">${money(d.totals.profitPaise)}</td></tr></tfoot></table></div>`
  }
  async change(el: HTMLElement) { if (!rangeChange(this.h, el)) return false; await this.load(); return true }
  async click(el: HTMLElement) { const c = el.closest<HTMLElement>('[data-ledger]')?.dataset.ledger; if (c) this.h.openLedger(c); return false }
}

interface Side { code: string; name: string; grp: string; amountPaise: number }
export class BalanceSheetView {
  private d: { asOf: string; assets: Side[]; liabilities: Side[]; equity: Side[]; totals: { assetsPaise: number; liabilitiesPaise: number; equityPaise: number } } | null = null
  constructor(private h: Host) {}
  async load() { this.d = await this.h.cached(`/api/accounts/balance-sheet?asOf=${this.h.to}`) }
  html() {
    const d = this.d!, ok = d.totals.assetsPaise === d.totals.liabilitiesPaise + d.totals.equityPaise
    const block = (title: string, xs: Side[], total: number) => {
      let grp = ''
      return `<tr class="acc-grp"><td colspan="2">${title}</td></tr>${xs.map((x) => `${x.grp !== grp && x.code ? `<tr><td colspan="2" class="muted small">${esc((grp = x.grp))}</td></tr>` : ''}<tr${x.code ? ` data-ledger="${esc(x.code)}" class="acc-click"` : ''}><td>${x.code ? `<span class="mono">${esc(x.code)}</span> ` : ''}${esc(x.name)}</td><td class="n">${money(x.amountPaise)}</td></tr>`).join('')}
        <tr><td><b>Total ${title.toLowerCase()}</b></td><td class="n"><b>${money(total)}</b></td></tr>`
    }
    return `<div class="ws-toolbar"><label class="inline">As on <input type="date" data-range="to" value="${esc(this.h.to)}"></label>${tonePill(ok ? 'Balanced' : 'Does not balance', ok ? '--st-vacant' : '--st-departing')}</div>
      <div class="acc-scroll"><table class="acc-table"><tbody>${block('Equity', d.equity, d.totals.equityPaise)}${block('Liabilities', d.liabilities, d.totals.liabilitiesPaise)}${block('Assets', d.assets, d.totals.assetsPaise)}</tbody></table></div>`
  }
  async change(el: HTMLElement) { if (!rangeChange(this.h, el)) return false; await this.load(); return true }
  async click(el: HTMLElement) { const c = el.closest<HTMLElement>('[data-ledger]')?.dataset.ledger; if (c) this.h.openLedger(c); return false }
}

export class JournalView {
  private list: Voucher[] = []
  private chart: Account[] = []
  constructor(private h: Host) {}
  async load() {
    this.chart = (await this.h.cached<{ accounts: Account[] }>('/api/accounts/chart')).accounts.filter((a) => a.active)
    this.list = (await this.h.cached<Voucher[]>(`/api/accounts/daybook?from=${this.h.from}&to=${this.h.to}&kind=journal`)).filter((v) => !v.source_type)
      .concat(await this.h.cached<Voucher[]>(`/api/accounts/daybook?from=${this.h.from}&to=${this.h.to}&kind=reversal`))
  }
  html() {
    return `${rangeBar(this.h, this.h.can('accounts.post') ? '<button type="button" class="btn primary" data-jv>New journal entry</button>' : '')}
      <p class="muted small">Entries by hand: opening balances, capital, provisions, corrections. A wrong entry is reversed, never edited or deleted.</p>
      ${this.list.map(voucherCard).join('') || '<div class="empty">No journal entries in these days.</div>'}`
  }
  async change(el: HTMLElement) { if (!rangeChange(this.h, el)) return false; await this.load(); return true }
  async click(el: HTMLElement) {
    const r = el.closest<HTMLElement>('[data-reverse]')?.dataset.reverse
    if (r) await reverse(this.h, r, () => this.load())
    const code = el.closest<HTMLElement>('[data-ledger]')?.dataset.ledger
    if (code) this.h.openLedger(code)
    if (el.closest('[data-jv]')) this.entry()
    return false
  }
  private entry() {
    const opts = this.chart.map((a) => `<option value="${esc(a.code)}">${esc(a.code)} ${esc(a.name)}</option>`).join('')
    const row = (i: number) => `<label class="span2">Account<select name="a${i}"><option value="">—</option>${opts}</select></label><label>Debit (₹)<input name="d${i}" type="number" min="0" step="0.01"></label><label>Credit (₹)<input name="c${i}" type="number" min="0" step="0.01"></label>`
    this.h.modal.open('Journal entry', `<div class="form-grid">
        <label>Date<input name="date" type="date" value="${esc(this.h.to)}"></label>
        <label class="span2">Narration<input name="narration" maxlength="200" required placeholder="e.g. Opening balance of the current account"></label>
        ${[0, 1, 2, 3].map(row).join('')}</div>`, 'Post', async (f) => {
      const lines = [0, 1, 2, 3].filter((i) => val(f, `a${i}`)).map((i) => ({ code: val(f, `a${i}`), debit: Number(val(f, `d${i}`) || 0), credit: Number(val(f, `c${i}`) || 0) }))
      const r = await this.h.api.post<{ number: string }>('/api/accounts/journal', { date: val(f, 'date'), narration: val(f, 'narration'), lines })
      await this.load(); this.h.render()
      return `Posted ${r.number}`
    })
  }
}

export class ChartView {
  private list: Account[] = []
  private depts: Record<string, string> = {}
  constructor(private h: Host) {}
  async load() { const r = await this.h.cached<{ accounts: Account[]; departments: Record<string, string> }>('/api/accounts/chart'); this.list = r.accounts; this.depts = r.departments }
  html() {
    let grp = ''
    return `<div class="ws-toolbar">${this.h.can('accounts.post') ? '<button type="button" class="btn primary" data-addacct>Add account</button>' : ''}</div>
      <div class="acc-scroll"><table class="acc-table"><thead><tr><th>Account</th><th>Department</th><th class="n">This year</th></tr></thead><tbody>
      ${[...this.list].sort((a, b) => a.grp.localeCompare(b.grp) || a.code.localeCompare(b.code)).map((a) => `${a.grp !== grp ? `<tr class="acc-grp"><td colspan="3">${esc((grp = a.grp))}</td></tr>` : ''}
        <tr data-ledger="${esc(a.code)}" class="acc-click${a.active ? '' : ' retired'}"><td><span class="mono">${esc(a.code)}</span> ${esc(a.name)}${a.system ? '' : ' <small class="muted">added</small>'}</td><td>${esc(a.dept ? this.depts[a.dept] ?? a.dept : '')}</td><td class="n">${drcr(a.closingPaise)}</td></tr>`).join('')}
      </tbody></table></div>`
  }
  async click(el: HTMLElement) {
    if (el.closest('[data-addacct]')) {
      this.h.modal.open('Add account', `<div class="form-grid">
          <label>Code<input name="code" maxlength="4" inputmode="numeric" placeholder="6110"></label>
          <label>Type<select name="type"><option value="expense">Expense</option><option value="income">Income</option><option value="asset">Asset</option><option value="liability">Liability</option><option value="equity">Equity</option></select></label>
          <label class="span2">Name<input name="name" maxlength="80"></label>
          <label>Heading<input name="grp" maxlength="60" placeholder="Other expenses"></label>
          <label>Department<select name="dept"><option value="">—</option>${Object.entries(this.depts).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label></div>`, 'Add', async (f) => {
        await this.h.api.post('/api/accounts/chart', { code: val(f, 'code'), type: val(f, 'type'), name: val(f, 'name'), grp: val(f, 'grp'), dept: val(f, 'dept') || null })
        await this.load(); this.h.render()
        return 'Account added'
      })
      return false
    }
    const c = el.closest<HTMLElement>('[data-ledger]')?.dataset.ledger
    if (c) this.h.openLedger(c)
    return false
  }
}

export class PeriodsView {
  private list: { month: string; note: string | null; locked_at: string; locked_by: string }[] = []
  constructor(private h: Host) {}
  async load() { this.list = await this.h.cached('/api/accounts/periods') }
  html() {
    return `<div class="ws-toolbar">${this.h.can('accounts.lock') ? '<button type="button" class="btn primary" data-lock>Lock a month</button>' : ''}</div>
      <p class="muted small">Once a month's returns are filed, lock it: nothing more can be posted into it, and a late document is booked in the next open month. Only the MD can reopen a month, and God Mode records it.</p>
      ${this.list.map((p) => `<div class="row-card"><div class="rc-title">${esc(p.month)}</div><div class="rc-sub">Locked by ${esc(p.locked_by)} on ${new Date(p.locked_at).toLocaleDateString('en-IN')}${p.note ? ` · ${esc(p.note)}` : ''}</div>
        <div class="rc-right">${this.h.me.permissions.includes('*') ? `<button type="button" class="btn small" data-unlock="${esc(p.month)}">Reopen…</button>` : tonePill('Locked', '--muted')}</div></div>`).join('') || '<div class="empty">No month is locked yet.</div>'}`
  }
  async click(el: HTMLElement) {
    if (el.closest('[data-lock]')) {
      const d = new Date(Date.now() + 330 * 60_000); d.setUTCDate(0)
      this.h.modal.open('Lock a month', `<div class="form-grid"><label>Month<input name="month" type="month" value="${d.toISOString().slice(0, 7)}"></label><label class="span2">Note<input name="note" maxlength="200" placeholder="e.g. GSTR-1 and 3B filed"></label></div>`, 'Lock', async (f) => {
        await this.h.api.post('/api/accounts/periods', { month: val(f, 'month'), note: val(f, 'note') || undefined })
        await this.load(); this.h.render()
        return `${val(f, 'month')} locked`
      })
    }
    const m = el.closest<HTMLElement>('[data-unlock]')?.dataset.unlock
    if (m) {
      this.h.modal.open(`Reopen ${m}`, '<div class="form-grid"><label class="span2">Why<input name="reason" maxlength="200" required></label></div>', 'Reopen', async (f) => {
        await this.h.api.post(`/api/accounts/periods/${m}/unlock`, { reason: val(f, 'reason') })
        await this.load(); this.h.render()
        return `${m} reopened`
      })
    }
    return false
  }
}
