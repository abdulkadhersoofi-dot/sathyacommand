import { createHash } from 'node:crypto'

// GST e-invoice (IRN) payload in the IRP JSON schema, and the provider interface.
// The real provider is a GST Suvidha Provider (GSP) chosen in Phase 0; it plugs in here.

export interface IrnResult { irn: string; ackNo: string; ackDate: string; signedQr: string }
export interface EInvoiceProvider { name: string; generate(payload: EInvoicePayload): Promise<IrnResult> }

export interface Party { name: string; gstin: string | null; address: string | null; city: string | null; pin: string | null; stateCode: string | null }

export interface DocForIrn {
  docType: 'invoice' | 'credit_note'
  number: string
  issueDate: string                   // YYYY-MM-DD
  supplier: Party
  recipient: Party
  placeOfSupply: string               // state code
  lines: { description: string; sac: string | null; gstRate: number; taxable: number; cgst: number; sgst: number; total: number }[]
  totals: { taxable: number; cgst: number; sgst: number; total: number }
  original?: { number: string; issueDate: string }
}

export type EInvoicePayload = ReturnType<typeof buildIrnPayload>

const rs = (p: number) => Math.round(p) / 100
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`

/** Problems that would make the IRP reject the document, in plain words. */
export function irnBlockers(d: DocForIrn): string[] {
  const out: string[] = []
  for (const [who, p] of [['Seller', d.supplier], ['Buyer', d.recipient]] as const) {
    if (!p.gstin) out.push(`${who} GSTIN is missing.`)
    if (!p.address) out.push(`${who} address is missing.`)
    if (!p.city) out.push(`${who} city is missing.`)
    if (!/^\d{6}$/.test(p.pin ?? '')) out.push(`${who} PIN code must be 6 digits.`)
  }
  if (!d.lines.length) out.push('The document has no lines.')
  if (d.lines.some((l) => !l.sac)) out.push('Every line needs a SAC code.')
  return out
}

export function buildIrnPayload(d: DocForIrn) {
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: d.docType === 'invoice' ? 'INV' : 'CRN', No: d.number, Dt: ddmmyyyy(d.issueDate) },
    SellerDtls: { Gstin: d.supplier.gstin!, LglNm: d.supplier.name, Addr1: d.supplier.address!, Loc: d.supplier.city!, Pin: Number(d.supplier.pin), Stcd: d.supplier.stateCode! },
    BuyerDtls: { Gstin: d.recipient.gstin!, LglNm: d.recipient.name, Pos: d.placeOfSupply, Addr1: d.recipient.address!, Loc: d.recipient.city!, Pin: Number(d.recipient.pin), Stcd: d.recipient.stateCode! },
    ItemList: d.lines.map((l, i) => ({
      SlNo: String(i + 1), PrdDesc: l.description.slice(0, 300), IsServc: 'Y', HsnCd: l.sac!, Qty: 1, Unit: 'OTH',
      UnitPrice: rs(l.taxable), TotAmt: rs(l.taxable), AssAmt: rs(l.taxable), GstRt: l.gstRate,
      CgstAmt: rs(l.cgst), SgstAmt: rs(l.sgst), IgstAmt: 0, TotItemVal: rs(l.total),
    })),
    ValDtls: { AssVal: rs(d.totals.taxable), CgstVal: rs(d.totals.cgst), SgstVal: rs(d.totals.sgst), IgstVal: 0, TotInvVal: rs(d.totals.total) },
    ...(d.original ? { RefDtls: { PrecDocDtls: [{ InvNo: d.original.number, InvDt: ddmmyyyy(d.original.issueDate) }] } } : {}),
  }
}

/**
 * Stand-in provider for development and tests. It computes the IRN the way the IRP does
 * (SHA-256 of supplier GSTIN, financial year, document type and number) but registers nothing.
 */
export const sandboxProvider: EInvoiceProvider = {
  name: 'sandbox (not registered with the IRP)',
  async generate(p) {
    const [, mm, yyyy] = p.DocDtls.Dt.split('/').map(Number)
    const fyStart = mm >= 4 ? yyyy : yyyy - 1
    const irn = createHash('sha256').update(`${p.SellerDtls.Gstin}${fyStart}-${String(fyStart + 1).slice(2)}${p.DocDtls.Typ}${p.DocDtls.No}`).digest('hex')
    return { irn, ackNo: String(Date.now()).slice(-12), ackDate: new Date().toISOString(), signedQr: `SANDBOX.${irn.slice(0, 16)}` }
  },
}
