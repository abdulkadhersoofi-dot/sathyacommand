import { randomUUID } from 'node:crypto'
import { financialYear } from '@sathya/tax'
import type { Db } from './db'
import { addDays } from './eng-core'
import { businessDate } from './fo-core'
import { nextSeriesNumber } from './invoicing'

// The general ledger: the chart of accounts, posting a voucher (balanced, numbered, never changed), and the
// automatic postings from what the resort already records. Stock is kept on the periodic method usual in
// India: purchases are expensed by category as goods arrive, and each month close brings every store's
// inventory account to its counted closing value.

export const LEDGER_LOCK = 7_301_006

type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'
/** code, name, type, heading, department */
export const CHART: [string, string, AccountType, string, string | null][] = [
  ['1100', 'Cash in hand', 'asset', 'Cash and bank', null],
  ['1110', 'Petty cash', 'asset', 'Cash and bank', null],
  ['1200', 'Bank: current account', 'asset', 'Cash and bank', null],
  ['1210', 'Card settlements receivable', 'asset', 'Cash and bank', null],
  ['1220', 'UPI settlements receivable', 'asset', 'Cash and bank', null],
  ['1300', 'Guest ledger (in-house guests)', 'asset', 'Trade receivables', null],
  ['1310', 'City ledger (companies)', 'asset', 'Trade receivables', null],
  ['1320', 'OTA receivable', 'asset', 'Trade receivables', null],
  ['1330', 'Restaurant sales clearing', 'asset', 'Trade receivables', null],
  ['1340', 'Banquet ledger (events)', 'asset', 'Trade receivables', null],
  ['1400', 'Inventory: main store', 'asset', 'Inventories', null],
  ['1401', 'Inventory: kitchen', 'asset', 'Inventories', null],
  ['1402', 'Inventory: bar (liquor)', 'asset', 'Inventories', null],
  ['1403', 'Inventory: housekeeping', 'asset', 'Inventories', null],
  ['1404', 'Inventory: engineering spares', 'asset', 'Inventories', null],
  ['1405', 'Inventory: linen', 'asset', 'Inventories', null],
  ['1500', 'Input CGST', 'asset', 'Taxes recoverable', null],
  ['1501', 'Input SGST', 'asset', 'Taxes recoverable', null],
  ['1502', 'Input IGST', 'asset', 'Taxes recoverable', null],
  ['1510', 'GST paid on advances', 'asset', 'Taxes recoverable', null],
  ['1520', 'TDS deducted by customers', 'asset', 'Taxes recoverable', null],
  ['1521', 'TCS paid on purchases (TASMAC)', 'asset', 'Taxes recoverable', null],
  ['1522', 'GST TCS deducted by OTAs', 'asset', 'Taxes recoverable', null],
  ['1540', 'Advance income tax paid', 'asset', 'Taxes recoverable', null],
  ['1600', 'Fixed assets: buildings', 'asset', 'Property, plant and equipment', null],
  ['1601', 'Fixed assets: plant and machinery', 'asset', 'Property, plant and equipment', null],
  ['1602', 'Fixed assets: furniture and fittings', 'asset', 'Property, plant and equipment', null],
  ['1603', 'Fixed assets: vehicles', 'asset', 'Property, plant and equipment', null],
  ['1604', 'Fixed assets: computers', 'asset', 'Property, plant and equipment', null],
  ['1605', 'Intangible assets (software)', 'asset', 'Property, plant and equipment', null],
  ['1690', 'Accumulated depreciation', 'asset', 'Property, plant and equipment', null],
  ['2100', 'Sundry creditors (vendors)', 'liability', 'Trade payables', null],
  ['2110', 'Goods received, bill pending', 'liability', 'Trade payables', null],
  ['2120', 'TASMAC payable', 'liability', 'Trade payables', null],
  ['2200', 'Output CGST', 'liability', 'Duties and taxes', null],
  ['2201', 'Output SGST', 'liability', 'Duties and taxes', null],
  ['2202', 'RCM CGST payable', 'liability', 'Duties and taxes', null],
  ['2203', 'RCM SGST payable', 'liability', 'Duties and taxes', null],
  ['2204', 'RCM IGST payable', 'liability', 'Duties and taxes', null],
  ['2210', 'TN VAT payable', 'liability', 'Duties and taxes', null],
  ['2220', 'GST payable after set-off', 'liability', 'Duties and taxes', null],
  ['2300', 'TDS payable', 'liability', 'Duties and taxes', null],
  ['2900', 'Suspense (posting differences)', 'liability', 'Other current liabilities', null],
  ['3000', 'Share capital', 'equity', 'Equity', null],
  ['3100', 'Retained earnings', 'equity', 'Equity', null],
  ['3200', 'Opening balances', 'equity', 'Equity', null],
  ['4000', 'Room revenue', 'income', 'Revenue from operations', 'rooms'],
  ['4010', 'Laundry revenue', 'income', 'Revenue from operations', 'rooms'],
  ['4100', 'Food & beverage revenue', 'income', 'Revenue from operations', 'fnb'],
  ['4200', 'Liquor revenue', 'income', 'Revenue from operations', 'bar'],
  ['4300', 'Banquet hall and lawn rental', 'income', 'Revenue from operations', 'banquets'],
  ['4310', 'Banquet food revenue', 'income', 'Revenue from operations', 'banquets'],
  ['4320', 'Banquet services revenue', 'income', 'Revenue from operations', 'banquets'],
  ['4900', 'Other operating income', 'income', 'Other income', 'other'],
  ['4910', 'Profit or loss on sale of assets', 'income', 'Other income', 'admin'],
  ['5000', 'Purchases: food', 'expense', 'Cost of materials consumed', 'fnb'],
  ['5010', 'Purchases: beverages', 'expense', 'Cost of materials consumed', 'fnb'],
  ['5020', 'Purchases: liquor', 'expense', 'Cost of materials consumed', 'bar'],
  ['5030', 'Purchases: housekeeping supplies and amenities', 'expense', 'Cost of materials consumed', 'rooms'],
  ['5040', 'Purchases: linen', 'expense', 'Cost of materials consumed', 'rooms'],
  ['5050', 'Purchases: crockery and glassware', 'expense', 'Cost of materials consumed', 'fnb'],
  ['5060', 'Purchases: engineering stores', 'expense', 'Cost of materials consumed', 'maintenance'],
  ['5070', 'Purchases: other stores', 'expense', 'Cost of materials consumed', 'admin'],
  ['5100', 'Change in inventory: main store', 'expense', 'Changes in inventories', 'admin'],
  ['5101', 'Change in inventory: kitchen', 'expense', 'Changes in inventories', 'fnb'],
  ['5102', 'Change in inventory: bar', 'expense', 'Changes in inventories', 'bar'],
  ['5103', 'Change in inventory: housekeeping', 'expense', 'Changes in inventories', 'rooms'],
  ['5104', 'Change in inventory: engineering', 'expense', 'Changes in inventories', 'maintenance'],
  ['5105', 'Change in inventory: linen', 'expense', 'Changes in inventories', 'rooms'],
  ['6000', 'Repairs and maintenance', 'expense', 'Other expenses', 'maintenance'],
  ['6010', 'Contract services', 'expense', 'Other expenses', 'admin'],
  ['6020', 'Professional fees', 'expense', 'Other expenses', 'admin'],
  ['6030', 'Rent', 'expense', 'Other expenses', 'admin'],
  ['6040', 'Commission', 'expense', 'Other expenses', 'sales'],
  ['6050', 'Card and UPI charges', 'expense', 'Other expenses', 'admin'],
  ['6060', 'Bank charges', 'expense', 'Finance costs', 'admin'],
  ['6070', 'Cash shortage and excess', 'expense', 'Other expenses', 'admin'],
  ['6080', 'Round off', 'expense', 'Other expenses', 'admin'],
  ['6090', 'Input tax credit reversed (rule 42)', 'expense', 'Other expenses', 'admin'],
  ['6095', 'Interest and fees on late taxes', 'expense', 'Other expenses', 'admin'],
  ['6100', 'Salaries and wages', 'expense', 'Employee benefits expense', 'admin'],
  ['6200', 'Depreciation', 'expense', 'Depreciation and amortisation', 'admin'],
]
export const DEPTS: Record<string, string> = {
  rooms: 'Rooms', fnb: 'Food & beverage', bar: 'Bar', banquets: 'Banquets', other: 'Other operated',
  admin: 'Administrative & general', sales: 'Sales & marketing', maintenance: 'Maintenance', utilities: 'Utilities',
}
/** Departments that earn: their profit is revenue less their own costs. The rest are undistributed. */
export const OPERATED = ['rooms', 'fnb', 'bar', 'banquets', 'other']

const STORE_ACCOUNTS: Record<string, [string, string]> = {
  main: ['1400', '5100'], kitchen: ['1401', '5101'], bar: ['1402', '5102'], housekeeping: ['1403', '5103'], engineering: ['1404', '5104'], linen: ['1405', '5105'], other: ['1400', '5100'],
}
const PURCHASE_ACCOUNT: Record<string, string> = {
  food: '5000', beverage: '5010', liquor: '5020', housekeeping: '5030', amenities: '5030', cleaning: '5030', linen: '5040', crockery: '5050', engineering: '5060', stationery: '5070', other: '5070',
}
/** A service bill's expense account, from the vendor's TDS category when accounts have not chosen one. */
const SERVICE_ACCOUNT: Record<string, string> = {
  contractor: '6010', professional_fees: '6020', technical_services: '6000', rent_land_building_furniture: '6030', rent_plant_machinery: '6030', commission_brokerage: '6040',
}
const REVENUE: Record<string, string> = { room: '4000', extra_bed: '4000', laundry: '4010', misc: '4900', fnb: '4100' }
const METHOD: Record<string, string> = { cash: '1100', card: '1210', upi: '1220', bank: '1200', cheque: '1200', company: '1310', ota: '1320' }
/** A banquet bill's revenue, by the kind of each line. */
const EVENT_REVENUE: Record<string, string> = { hall: '4300', catering: '4310', other: '4320' }

export async function ensureChart(db: Db, now = new Date()) {
  for (const [code, name, type, grp, dept] of CHART) {
    await db.query('insert into account (code, name, type, grp, dept, system, created_at) values ($1,$2,$3,$4,$5,true,$6) on conflict (code) do nothing', [code, name, type, grp, dept, now])
  }
  await assignStoreAccounts(db)
  const [bank] = await db.query('select 1 from bank_account limit 1')
  if (!bank) await db.query(`insert into bank_account (id, name, account_code, is_default, created_at) values ('BANK-1', 'Current account', '1200', true, $1)`, [now])
}

/** The ledger account of the bank that payments go out of unless another is chosen. */
export async function defaultBankCode(t: Db) {
  const [b] = await t.query<{ account_code: string }>('select account_code from bank_account where is_default and active limit 1')
  return b?.account_code ?? '1200'
}

/** A store added later gets the inventory and change accounts of its kind. */
export async function assignStoreAccounts(db: Db) {
  const stores = await db.query<{ id: string; kind: string }>('select id, kind from store where inventory_account is null')
  for (const s of stores) {
    const [inv, chg] = STORE_ACCOUNTS[s.kind] ?? STORE_ACCOUNTS.other
    await db.query('update store set inventory_account = $2, change_account = $3 where id = $1', [s.id, inv, chg])
  }
}

export interface Party { type: 'vendor' | 'company' | 'guest' | 'staff' | 'ota' | 'event'; id: string; name?: string | null }
export interface PostLine { code: string; amount: number; dept?: string | null; party?: Party | null; ref?: string | null }   // amount: debit +, credit −
export interface VoucherInput {
  kind: 'sales' | 'receipt' | 'purchase' | 'payment' | 'contra' | 'stock' | 'journal' | 'reversal'
  date: string; narration: string; lines: PostLine[]
  source?: { type: string; id: string } | null; reverses?: string | null; userId?: string | null; now: Date
  /** Hand-entered vouchers must balance and may not go into a locked month; the system's move to the next open day. */
  manual?: boolean
}
const PREFIX: Record<VoucherInput['kind'], string> = { sales: 'SL', receipt: 'RC', purchase: 'PU', payment: 'PY', contra: 'CO', stock: 'SK', journal: 'JV', reversal: 'RJ' }

export class LedgerError extends Error { constructor(msg: string, public statusCode = 400) { super(msg) } }

/** The first day on or after `day` whose month is not locked. */
export async function openDay(t: Db, day: string) {
  let d = day
  for (;;) {
    const [l] = await t.query<{ month: string }>('select month from period_lock where month = $1', [d.slice(0, 7)])
    if (!l) return d
    d = addDays(`${d.slice(0, 7)}-01`, 32).slice(0, 7) + '-01'
  }
}

export async function postVoucher(t: Db, v: VoucherInput): Promise<{ id: string; number: string } | null> {
  if (v.source) {
    const [done] = await t.query('select 1 from posted_source where source_type = $1 and source_id = $2', [v.source.type, v.source.id])
    if (done) return null
  }
  // Same account, department and party: one line.
  const merged = new Map<string, PostLine>()
  for (const l of v.lines) {
    const a = Math.round(l.amount)
    if (!a) continue
    const key = [l.code, l.dept ?? '', l.party?.type ?? '', l.party?.id ?? '', l.ref ?? ''].join('|')
    const m = merged.get(key)
    if (m) m.amount += a; else merged.set(key, { ...l, amount: a })
  }
  const lines = [...merged.values()].filter((l) => l.amount !== 0)
  const diff = lines.reduce((s, l) => s + l.amount, 0)
  if (diff !== 0) {
    if (v.manual) throw new LedgerError(`Debits and credits differ by ₹${(Math.abs(diff) / 100).toFixed(2)}.`)
    lines.push({ code: '2900', amount: -diff, ref: 'difference' })
  }
  if (!lines.length) {
    if (v.source) await t.query('insert into voucher_skip (source_type, source_id) values ($1, $2) on conflict do nothing', [v.source.type, v.source.id])
    return null
  }
  let date = v.date
  const locked = (await t.query('select 1 from period_lock where month = $1', [date.slice(0, 7)])).length > 0
  if (locked) {
    if (v.manual) throw new LedgerError(`The books for ${date.slice(0, 7)} are locked.`, 409)
    date = await openDay(t, date)
  }
  const accounts = new Map((await t.query<{ code: string; dept: string | null; active: boolean }>('select code, dept, active from account where code = any($1)', [lines.map((l) => l.code)])).map((a) => [a.code, a]))
  for (const l of lines) if (!accounts.has(l.code)) throw new LedgerError(`No account ${l.code}.`)
  if (v.manual) for (const l of lines) if (!accounts.get(l.code)!.active) throw new LedgerError(`Account ${l.code} is archived.`)
  const id = randomUUID()
  const number = await nextSeriesNumber(t, `voucher_${v.kind}`, financialYear(date), PREFIX[v.kind])
  const total = lines.reduce((s, l) => s + Math.max(0, l.amount), 0)
  await t.query(
    `insert into voucher (id, number, kind, date, doc_date, narration, source_type, source_id, reverses, total_paise, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, number, v.kind, date, date !== v.date ? v.date : null, v.narration, v.source?.type ?? null, v.source?.id ?? null, v.reverses ?? null, total, v.userId ?? null, v.now])
  let n = 0
  for (const l of lines) {
    await t.query(
      `insert into voucher_line (voucher_id, line, account_code, dept, debit_paise, credit_paise, party_type, party_id, party_name, ref) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, ++n, l.code, l.dept ?? accounts.get(l.code)!.dept, Math.max(0, l.amount), Math.max(0, -l.amount), l.party?.type ?? null, l.party?.id ?? null, l.party?.name ?? null, l.ref ?? null])
  }
  return { id, number }
}

/** Balance of an account (debit positive) up to and including a day. */
export async function balanceOf(t: Db, code: string, upto: string) {
  const [r] = await t.query<{ b: string | null }>('select sum(l.debit_paise - l.credit_paise) as b from voucher_line l join voucher v on v.id = l.voucher_id where l.account_code = $1 and v.date <= $2', [code, upto])
  return Number(r.b ?? 0)
}

const n = (v: unknown) => Number(v ?? 0)
type Post = (input: Omit<VoucherInput, 'now'>) => Promise<unknown>

/**
 * Posts everything not yet in the books. Bills, payments, purchases and documents post as they happen; the
 * front office and restaurant post one voucher per closed business day. Safe to run at any time: each
 * source posts once.
 */
export async function postPending(db: Db, now: Date) {
  return db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock($1)', [LEDGER_LOCK])
    await assignStoreAccounts(t)
    const today = await businessDate(t)
    let posted = 0
    const post: Post = async (input) => { if (await postVoucher(t, { ...input, now })) posted++ }

    // ---------- front office, by closed business day ----------
    const foDays = await t.query<{ d: string }>(
      `select distinct l.business_date::text as d from folio_line l where l.business_date < $1
          and not exists (select 1 from posted_source v where v.source_type = 'fo_day' and v.source_id = l.business_date::text) order by 1`, [today])
    for (const { d } of foDays) {
      const rows = await t.query<{ kind: string; orig_kind: string | null; amount_paise: string; cgst_paise: string; sgst_paise: string; reservation_id: string; bill_to: string }>(
        `select l.kind, o.kind as orig_kind, l.amount_paise, l.cgst_paise, l.sgst_paise, f.reservation_id, f.bill_to
           from folio_line l join folio f on f.id = l.folio_id left join folio_line o on o.id = l.reverses
          where l.business_date = $1 and l.kind not in ('payment', 'refund')`, [d])
      const lines: PostLine[] = []
      for (const r of rows) {
        const kind = r.kind === 'reversal' ? r.orig_kind ?? 'misc' : r.kind
        const amt = n(r.amount_paise), cgst = n(r.cgst_paise), sgst = n(r.sgst_paise)
        lines.push({ code: '1300', amount: amt, party: { type: 'guest', id: r.reservation_id, name: r.bill_to } })
        if (kind === 'liquor') { lines.push({ code: '1330', amount: -amt }); continue }   // its VAT invoice is the sale
        lines.push({ code: REVENUE[kind] ?? '4900', amount: -(amt - cgst - sgst) }, { code: '2200', amount: -cgst }, { code: '2201', amount: -sgst })
      }
      await post({ kind: 'sales', date: d, narration: `Guest charges for ${d}`, source: { type: 'fo_day', id: d }, lines })
    }
    const payDays = await t.query<{ d: string }>(
      `select distinct l.business_date::text as d from payment p join folio_line l on l.id = p.line_id where l.business_date < $1
          and not exists (select 1 from posted_source v where v.source_type = 'fo_pay_day' and v.source_id = l.business_date::text) order by 1`, [today])
    const bank = await defaultBankCode(t)
    for (const { d } of payDays) {
      const rows = await t.query<{ method: string; amount_paise: string; reservation_id: string; bill_to: string; debtor_id: string | null; debtor: string | null; invoice: string | null; ota_ref: string | null }>(
        `select p.method, p.amount_paise, f.reservation_id, f.bill_to, p.debtor_id, dr.name as debtor, (select ota_ref from reservation where id = f.reservation_id) as ota_ref,
                (select x.number from tax_document x where x.reservation_id = f.reservation_id and x.doc_type = 'invoice' order by x.issued_at desc limit 1) as invoice
           from payment p join folio_line l on l.id = p.line_id join folio f on f.id = p.folio_id
           left join debtor dr on dr.id = p.debtor_id where l.business_date = $1`, [d])
      const lines: PostLine[] = []
      for (const r of rows) {
        const amt = n(r.amount_paise)
        // Each stay a company is billed for is its own line on the company's account, with the invoice number.
        // OTA-collected bookings are owed by the OTA, booking by booking.
        const party: Party | null = r.method === 'company' ? { type: 'company', id: r.debtor_id ?? r.bill_to, name: r.debtor ?? r.bill_to }
          : r.method === 'ota' && r.debtor_id ? { type: 'ota', id: r.debtor_id, name: r.debtor } : null
        lines.push({ code: r.method === 'bank' ? bank : METHOD[r.method] ?? '1100', amount: amt, party,
          ref: r.method === 'company' ? r.invoice ?? `Booking ${r.reservation_id}` : r.method === 'ota' ? r.ota_ref ?? r.reservation_id : null })
        lines.push({ code: '1300', amount: -amt, party: { type: 'guest', id: r.reservation_id, name: r.bill_to } })
      }
      await post({ kind: 'receipt', date: d, narration: `Front office receipts for ${d}`, source: { type: 'fo_pay_day', id: d }, lines })
    }

    // ---------- restaurant and bar, by closed business day ----------
    const fnbDays = await t.query<{ d: string }>(
      `select d from (select issue_date::text as d from tax_document where doc_type = 'fnb_invoice' union select issue_date::text from vat_invoice union select business_date::text from fnb_payment) x
        where d < $1 and not exists (select 1 from posted_source v where v.source_type = 'fnb_day' and v.source_id = x.d) order by 1`, [today])
    for (const { d } of fnbDays) {
      const lines: PostLine[] = []
      for (const g of await t.query<{ taxable_paise: string; cgst_paise: string; sgst_paise: string; total_paise: string }>(`select taxable_paise, cgst_paise, sgst_paise, total_paise from tax_document where doc_type = 'fnb_invoice' and issue_date = $1`, [d])) {
        lines.push({ code: '1330', amount: n(g.total_paise) }, { code: '4100', amount: -n(g.taxable_paise) }, { code: '2200', amount: -n(g.cgst_paise) }, { code: '2201', amount: -n(g.sgst_paise) })
      }
      for (const v of await t.query<{ taxable_paise: string; vat_paise: string; total_paise: string }>('select taxable_paise, vat_paise, total_paise from vat_invoice where issue_date = $1', [d])) {
        lines.push({ code: '1330', amount: n(v.total_paise) }, { code: '4200', amount: -n(v.taxable_paise) }, { code: '2210', amount: -n(v.vat_paise) })
      }
      for (const p of await t.query<{ method: string; amount_paise: string; bill_to: { company?: string } | null; debtor_id: string | null; debtor: string | null; doc: string | null }>(
        `select p.method, p.amount_paise, b.bill_to, p.debtor_id, dr.name as debtor, coalesce(g.number, vi.number) as doc from fnb_payment p join fnb_bill b on b.id = p.bill_id
           left join debtor dr on dr.id = p.debtor_id left join tax_document g on g.id = b.gst_document_id left join vat_invoice vi on vi.id = b.vat_invoice_id
          where p.business_date = $1 and p.method <> 'room'`, [d])) {
        const company = p.debtor ?? p.bill_to?.company ?? 'Restaurant credit'
        lines.push({ code: METHOD[p.method] ?? '1100', amount: n(p.amount_paise), party: p.method === 'company' ? { type: 'company', id: p.debtor_id ?? company, name: company } : null, ref: p.method === 'company' ? p.doc : null }, { code: '1330', amount: -n(p.amount_paise) })
      }
      // Rounding to the rupee on bills paid for (not those charged to a room).
      const [ro] = await t.query<{ ro: string | null }>(
        `select sum((b.amounts->>'roundOff')::bigint) as ro from fnb_bill b where b.status = 'settled' and b.reservation_id is null
            and exists (select 1 from fnb_payment p where p.bill_id = b.id and p.business_date = $1)
            and not exists (select 1 from fnb_payment p where p.bill_id = b.id and p.business_date <> $1)`, [d])
      if (n(ro.ro)) lines.push({ code: '1330', amount: n(ro.ro) }, { code: '6080', amount: -n(ro.ro) })
      await post({ kind: 'sales', date: d, narration: `Restaurant and bar sales for ${d}`, source: { type: 'fnb_day', id: d }, lines })
    }

    // ---------- GST documents: advances, their adjustment, credit notes ----------
    const docs = await t.query<{ id: string; doc_type: string; number: string; issue_date: string; reservation_id: string | null; event_id: string | null; cgst_paise: string; sgst_paise: string; taxable_paise: string; total_paise: string; advance_adjusted_paise: string; lines: { sac: string | null }[]; recipient: { name: string } }>(
      `select d.id, d.doc_type, d.number, d.issue_date::text, d.reservation_id, d.event_id, d.cgst_paise, d.sgst_paise, d.taxable_paise, d.total_paise, d.advance_adjusted_paise, d.lines, d.recipient
         from tax_document d where (d.doc_type in ('receipt_voucher', 'refund_voucher', 'credit_note') or (d.doc_type = 'invoice' and d.advance_adjusted_paise > 0 and (d.reservation_id is not null or d.event_id is not null)))
          and not exists (select 1 from posted_source v where v.source_type = 'tax_doc' and v.source_id = d.id) order by d.issued_at`)
    for (const d of docs) {
      const cg = n(d.cgst_paise), sg = n(d.sgst_paise)
      if (d.doc_type === 'receipt_voucher' || d.doc_type === 'refund_voucher') {
        const s = d.doc_type === 'receipt_voucher' ? 1 : -1
        await post({ kind: 'journal', date: d.issue_date, narration: `GST on advance, ${d.number}`, source: { type: 'tax_doc', id: d.id },
          lines: [{ code: '1510', amount: s * (cg + sg) }, { code: '2200', amount: -s * cg }, { code: '2201', amount: -s * sg }] })
      } else if (d.doc_type === 'credit_note' && d.event_id) {
        await post({ kind: 'sales', date: d.issue_date, narration: `Credit note ${d.number}`, source: { type: 'tax_doc', id: d.id }, lines: [
          { code: d.lines[0]?.sac === '996334' ? '4310' : '4300', amount: n(d.taxable_paise) }, { code: '2200', amount: cg }, { code: '2201', amount: sg },
          { code: '1340', amount: -n(d.total_paise), party: { type: 'event', id: d.event_id, name: d.recipient?.name } }] })
      } else if (d.doc_type === 'credit_note') {
        const rev = d.lines[0]?.sac === '996331' ? '4100' : '4000'
        await post({ kind: 'sales', date: d.issue_date, narration: `Credit note ${d.number}`, source: { type: 'tax_doc', id: d.id }, lines: [
          { code: rev, amount: n(d.taxable_paise) }, { code: '2200', amount: cg }, { code: '2201', amount: sg },
          { code: '1300', amount: -n(d.total_paise), party: d.reservation_id ? { type: 'guest', id: d.reservation_id, name: d.recipient?.name } : null }] })
      } else {
        // A stay invoice that takes in advances: the GST already paid on them comes off what this invoice owes.
        const [a] = await t.query<{ cg: string | null; sg: string | null }>(
          `select sum(case when doc_type = 'receipt_voucher' then cgst_paise else -cgst_paise end) as cg, sum(case when doc_type = 'receipt_voucher' then sgst_paise else -sgst_paise end) as sg
             from tax_document where ${d.event_id ? 'event_id' : 'reservation_id'} = $1 and doc_type in ('receipt_voucher', 'refund_voucher')`, [d.event_id ?? d.reservation_id])
        await post({ kind: 'journal', date: d.issue_date, narration: `GST on advances adjusted in ${d.number}`, source: { type: 'tax_doc', id: d.id },
          lines: [{ code: '2200', amount: n(a.cg) }, { code: '2201', amount: n(a.sg) }, { code: '1510', amount: -(n(a.cg) + n(a.sg)) }] })
      }
    }

    // ---------- banquets: each event's bill, and money received or refunded ----------
    const evInv = await t.query<{ id: string; number: string; issue_date: string; event_id: string; title: string; cgst_paise: string; sgst_paise: string; total_paise: string; lines: { kind?: string; taxable: number }[] }>(
      `select d.id, d.number, d.issue_date::text, d.event_id, e.title, d.cgst_paise, d.sgst_paise, d.total_paise, d.lines from tax_document d join event e on e.id = d.event_id
        where d.doc_type = 'invoice' and not exists (select 1 from posted_source v where v.source_type = 'event_inv' and v.source_id = d.id) order by d.issued_at`)
    for (const d of evInv) {
      await post({ kind: 'sales', date: d.issue_date, narration: `Event bill ${d.number}, ${d.title}`, source: { type: 'event_inv', id: d.id }, lines: [
        { code: '1340', amount: n(d.total_paise), party: { type: 'event', id: d.event_id, name: d.title }, ref: d.number },
        ...d.lines.map((l) => ({ code: EVENT_REVENUE[l.kind ?? ''] ?? '4320', amount: -n(l.taxable) })),
        { code: '2200', amount: -n(d.cgst_paise) }, { code: '2201', amount: -n(d.sgst_paise) }] })
    }
    const evPay = await t.query<{ id: string; event_id: string; title: string; number: string; method: string; amount_paise: string; business_date: string; reference: string | null; debtor_id: string | null; debtor: string | null; invoice: string | null }>(
      `select p.id, p.event_id, e.title, e.number, p.method, p.amount_paise, p.business_date::text, p.reference, p.debtor_id, d.name as debtor,
              (select x.number from tax_document x where x.event_id = e.id and x.doc_type = 'invoice' order by x.issued_at desc limit 1) as invoice
         from event_payment p join event e on e.id = p.event_id left join debtor d on d.id = p.debtor_id
        where not exists (select 1 from posted_source v where v.source_type = 'event_pay' and v.source_id = p.id) order by p.received_at`)
    for (const p of evPay) {
      const amt = n(p.amount_paise)
      // Moved to the company's account: the bill becomes its own line there, named by the invoice.
      const debit: PostLine = p.method === 'company'
        ? { code: '1310', amount: amt, party: { type: 'company', id: p.debtor_id!, name: p.debtor }, ref: p.invoice ?? p.number }
        : { code: p.method === 'bank' || p.method === 'cheque' ? bank : METHOD[p.method] ?? '1100', amount: amt, ref: p.reference }
      await post({ kind: p.method === 'company' ? 'journal' : amt > 0 ? 'receipt' : 'payment', date: p.business_date, narration: `${p.method === 'company' ? `To ${p.debtor}'s account:` : amt > 0 ? 'Received for' : 'Refunded on'} ${p.number}, ${p.title}`, source: { type: 'event_pay', id: p.id }, lines: [
        debit, { code: '1340', amount: -amt, party: { type: 'event', id: p.event_id, name: p.title }, ref: p.number }] })
    }

    // ---------- purchases ----------
    const grns = await t.query<{ id: string; number: string; business_date: string; vendor: string }>(
      `select g.id, g.number, g.business_date::text, v.name as vendor from grn g join vendor v on v.id = g.vendor_id
        where not exists (select 1 from posted_source x where x.source_type = 'grn' and x.source_id = g.id) order by g.received_at`)
    for (const g of grns) {
      const ls = await t.query<{ category: string; itc: string; gst_rate: string | null; qty_accepted: string; rate_paise: string }>(
        'select i.category, i.itc, i.gst_rate, l.qty_accepted, l.rate_paise from grn_line l join item i on i.id = l.item_id where l.grn_id = $1', [g.id])
      const lines: PostLine[] = []
      for (const l of ls) {
        const taxable = Math.round(n(l.qty_accepted) * n(l.rate_paise))
        const cost = taxable + (l.itc === 'full' ? 0 : Math.round((taxable * n(l.gst_rate)) / 100))
        lines.push({ code: PURCHASE_ACCOUNT[l.category] ?? '5070', amount: cost }, { code: '2110', amount: -cost, ref: g.number })
      }
      await post({ kind: 'purchase', date: g.business_date, narration: `Goods received ${g.number} from ${g.vendor}`, source: { type: 'grn', id: g.id }, lines })
    }
    // Bought straight into the kitchen (the market run), awaiting the bill.
    const kr = await t.query<{ ref: string; d: string; v: string }>(
      `select ref, min(business_date)::text as d, sum(cost_paise) as v from kitchen_stock_move m where kind = 'receipt' and ref like 'KR-%'
          and not exists (select 1 from posted_source x where x.source_type = 'kitchen_receipt' and x.source_id = m.ref) group by ref`)
    for (const k of kr) {
      await post({ kind: 'purchase', date: k.d, narration: `Kitchen receipt ${k.ref}`, source: { type: 'kitchen_receipt', id: k.ref }, lines: [{ code: '5000', amount: n(k.v) }, { code: '2110', amount: -n(k.v), ref: k.ref }] })
    }
    const bills = await t.query<{ id: string; bill_no: string; bill_date: string; vendor_id: string; vendor: string; tds_code: string | null; state_code: string; rcm_paise: string; cgst_paise: string; sgst_paise: string; igst_paise: string; itc_paise: string; round_off_paise: string; total_paise: string; approved_at: Date }>(
      `select b.id, b.bill_no, b.bill_date::text, b.vendor_id, v.name as vendor, v.tds_code, v.state_code, b.rcm_paise, b.cgst_paise, b.sgst_paise, b.igst_paise, b.itc_paise, b.round_off_paise, b.total_paise, b.approved_at
         from purchase_bill b join vendor v on v.id = b.vendor_id where b.status in ('approved', 'partly_paid', 'paid')
          and not exists (select 1 from posted_source x where x.source_type = 'bill' and x.source_id = b.id) order by b.approved_at`)
    for (const b of bills) {
      const ls = await t.query<{ item_id: string | null; amount_paise: string; gst_paise: string; itc: string; account_code: string | null }>(
        'select l.item_id, l.amount_paise, l.gst_paise, l.itc, l.account_code from bill_line l where l.bill_id = $1 order by l.line', [b.id])
      const lines: PostLine[] = []
      for (const l of ls) {
        // Goods were expensed when the store received them: the bill clears that (a bill for goods never received stays open there).
        const code = l.item_id ? '2110' : l.account_code ?? SERVICE_ACCOUNT[b.tds_code ?? ''] ?? '6000'
        lines.push({ code, amount: n(l.amount_paise) + (l.itc === 'full' ? 0 : n(l.gst_paise)), ref: code === '2110' ? b.bill_no : null })
      }
      // Input tax credit by the vendor's state: IGST from outside Tamil Nadu, CGST and SGST in halves within it.
      const itc = n(b.itc_paise), rcm = n(b.rcm_paise), inter = b.state_code !== '33'
      if (inter) lines.push({ code: '1502', amount: itc })
      else { const c = Math.round(itc / 2); lines.push({ code: '1500', amount: c }, { code: '1501', amount: itc - c }) }
      // Reverse charge: the GST is owed to the government, not the vendor.
      if (inter) lines.push({ code: '2204', amount: -rcm, ref: b.bill_no })
      else { const c = Math.round(rcm / 2); lines.push({ code: '2202', amount: -c, ref: b.bill_no }, { code: '2203', amount: -(rcm - c), ref: b.bill_no }) }
      lines.push({ code: '6080', amount: n(b.round_off_paise) }, { code: '2100', amount: -n(b.total_paise), party: { type: 'vendor', id: b.vendor_id, name: b.vendor }, ref: b.bill_no })
      // Booked when passed, in the month of the vendor's bill if it is still open.
      const passed = istDay(b.approved_at)
      await post({ kind: 'purchase', date: b.bill_date <= passed ? b.bill_date : passed, narration: `Bill ${b.bill_no} from ${b.vendor}`, source: { type: 'bill', id: b.id }, lines })
    }
    const pays = await t.query<{ id: string; number: string; vendor_id: string; vendor: string; pay_date: string; mode: string; gross_paise: string; tds_paise: string; tds_section: string | null; net_paise: string; reference: string | null }>(
      `select p.id, p.number, p.vendor_id, v.name as vendor, p.pay_date::text, p.mode, p.gross_paise, p.tds_paise, p.tds_section, p.net_paise, p.reference
         from vendor_payment p join vendor v on v.id = p.vendor_id where p.status = 'paid'
          and not exists (select 1 from posted_source x where x.source_type = 'vendor_payment' and x.source_id = p.id) order by p.paid_at`)
    for (const p of pays) {
      await post({ kind: 'payment', date: p.pay_date, narration: `${p.number} to ${p.vendor}${p.reference ? ` (${p.reference})` : ''}`, source: { type: 'vendor_payment', id: p.id }, lines: [
        { code: '2100', amount: n(p.gross_paise), party: { type: 'vendor', id: p.vendor_id, name: p.vendor }, ref: p.number },
        { code: p.mode === 'cash' ? '1100' : await defaultBankCode(t), amount: -n(p.net_paise), ref: p.reference },
        { code: '2300', amount: -n(p.tds_paise), ref: p.tds_section, party: { type: 'vendor', id: p.vendor_id, name: p.vendor } }] })
    }
    const tasmac = await t.query<{ id: string; invoice_no: string; business_date: string; value_paise: string; vat_paise: string; tcs_paise: string | null; total_paise: string }>(
      `select id, invoice_no, business_date::text, value_paise, vat_paise, tcs_paise, total_paise from tasmac_purchase p
        where not exists (select 1 from posted_source x where x.source_type = 'tasmac' and x.source_id = p.id) order by received_at`)
    for (const p of tasmac) {
      await post({ kind: 'purchase', date: p.business_date, narration: `TASMAC invoice ${p.invoice_no}`, source: { type: 'tasmac', id: p.id }, lines: [
        { code: '5020', amount: n(p.value_paise) + n(p.vat_paise) }, { code: '1521', amount: n(p.tcs_paise) }, { code: '2120', amount: -n(p.total_paise), ref: p.invoice_no }] })
    }

    // ---------- stock: opening stock taken, and each month close ----------
    const opening = await t.query<{ store_id: string; d: string; v: string; inventory_account: string }>(
      `select m.store_id, m.business_date::text as d, sum(m.value_paise) as v, s.inventory_account from stock_move m join store s on s.id = m.store_id
        where m.kind = 'opening' and not exists (select 1 from posted_source x where x.source_type = 'opening_stock' and x.source_id = m.store_id || ':' || m.business_date::text)
        group by m.store_id, m.business_date, s.inventory_account`)
    for (const o of opening) {
      await post({ kind: 'stock', date: o.d, narration: `Opening stock, ${o.store_id}`, source: { type: 'opening_stock', id: `${o.store_id}:${o.d}` }, lines: [{ code: o.inventory_account, amount: n(o.v) }, { code: '3200', amount: -n(o.v) }] })
    }
    const closes = await t.query<{ id: string; store_id: string; name: string; month: string; opening_paise: string; closing_paise: string; inventory_account: string; change_account: string }>(
      `select c.id, c.store_id, s.name, c.month, c.opening_paise, c.closing_paise, s.inventory_account, s.change_account from month_close c join store s on s.id = c.store_id
        where c.status = 'closed' and not exists (select 1 from posted_source x where x.source_type = 'month_close' and x.source_id = c.id) order by c.month`)
    for (const c of closes) {
      const end = addDays(addDays(`${c.month}-01`, 32).slice(0, 7) + '-01', -1)
      const before = await balanceOf(t, c.inventory_account, addDays(`${c.month}-01`, -1)), atEnd = await balanceOf(t, c.inventory_account, end)
      const adj = n(c.closing_paise) - atEnd
      const unbooked = n(c.opening_paise) - before                 // stock held before the books knew of it
      await post({ kind: 'stock', date: end, narration: `Closing stock ${c.month}, ${c.name}`, source: { type: 'month_close', id: c.id },
        lines: [{ code: c.inventory_account, amount: adj }, { code: '3200', amount: -unbooked }, { code: c.change_account, amount: -(adj - unbooked) }] })
    }

    // ---------- cash counted short or over at the end of a cashier shift ----------
    const shifts = await t.query<{ id: string; business_date: string; variance: string; name: string }>(
      `select s.id, s.business_date::text, s.variance, u.name from cashier_shift s join app_user u on u.id = s.user_id
        where s.closed_at is not null and coalesce(s.variance, 0) <> 0 and not exists (select 1 from posted_source x where x.source_type = 'shift' and x.source_id = s.id)`)
    for (const s of shifts) {
      await post({ kind: 'journal', date: s.business_date, narration: `Cash ${n(s.variance) < 0 ? 'short' : 'over'} at the close of ${s.name}'s shift`, source: { type: 'shift', id: s.id },
        lines: [{ code: '1100', amount: n(s.variance) }, { code: '6070', amount: -n(s.variance) }] })
    }
    return { posted }
  })
}

const istDay = (d: Date) => new Date(new Date(d).getTime() + 330 * 60_000).toISOString().slice(0, 10)
