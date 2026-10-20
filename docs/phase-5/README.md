# Phase 5 · Stores, purchase & inventory

Weeks 25–30 of the [blueprint](../HMS_BLUEPRINT.md). **Done when** a full month closes with stock variance under the agreed limit.

The kitchen, bar, engineering and linen already keep their own stock books (Phases 3 and 4). Phase 5 adds the main store and the purchase cycle around them: goods received or issued into a department store land in that department's book, so nothing is counted twice.

| Step | What | Status |
|---|---|---|
| 5.1 | **Stores, items and vendors**: the stores (main, kitchen, bar, housekeeping, engineering, linen), each tied to the book it keeps stock in; the **item master**: stock unit and purchase unit with the conversion (1 bag = 25,000 g, 1 case = 48 pcs), HSN, GST rate, input tax credit (claimable, not claimable, blocked), perishable and shelf life, reorder level and quantity, barcode, and the link to the kitchen ingredient, bar brand, spare part or linen item (same unit enforced); one step brings every existing kitchen, bar, spares and linen item in. The **vendor master**: GSTIN checked for typing mistakes (check character), state and PAN taken from it (IGST for vendors outside Tamil Nadu), PAN format and holder type (individual / HUF / company / firm) for the TDS rate, TDS category from the tax table (194C, 194J, 194-I, 194H, 194Q…), MSME status with Udyam number and written agreement (15 or 45 days to pay), payment terms, what they supply; **bank details only by accounts**, masked for everyone else, and a changed account logged separately for God Mode. **Rate contracts** per item and vendor with validity (no overlaps), the best current rate shown on each item | Done · 7 API tests + PAN/IFSC checks + browser run |
| 5.2 | **Indents and purchase orders**: departments (kitchen, housekeeping, bar, engineering, front office) raise numbered indents (IND/26-27/…) in purchase units with an estimate at the best rate; approved or turned down (with a reason) by the GM or operations manager, never by the person who asked; stores turn ticked indents into draft POs, each line going to the vendor with the best current rate (one PO per vendor and store). **Purchase orders** numbered gap-free per financial year (PO/26-27/…), rate from the vendor's contract unless typed, GST line by line (CGST + SGST, or IGST for vendors outside Tamil Nadu), refused for items without a GST rate; submitted POs within the raiser's limit (stores ₹25,000) are approved at once, above it they wait for the GM (up to ₹5 lakh) or the MD; printed PO with HSN, tax split, amount in words and approver, marked DRAFT until approved; sent; cancelled with a reason (indent lines freed). **Market list**: perishables (or everything) below their reorder level, read from the department's own book (kitchen, bar, spares, linen) or the store's ledger, less what is already on order, at the best current rate; ticked lines become draft POs per vendor | Done · 8 API tests + browser run (chef's indent on a phone, approval, ordered, submitted, printed) |
| 5.3 | Goods receipt with photo, quality check, batch and expiry; vendor bills with GST and input tax credit; three-way match (PO, receipt, bill); payments with TDS; MSME 45-day tracker | |
| 5.4 | Stock ledger at weighted average, first-to-expire first out, requisitions and issues, inter-store transfers, counts on the phone with GM approval of adjustments, breakage register, labels, reorder suggestions | |
| 5.5 | Liquor store and excise registers: daily FL-3 stock register by brand, monthly statement, transport permits, TCS on TASMAC purchases | |
| 5.6 | Month close per store with the variance limit, theoretical vs actual food cost, GM sign-off, closed months locked | |

## Roles

| Role | Can |
|---|---|
| Stores | stores, items, vendors (not bank details), rate contracts; indents, purchase orders up to ₹25,000, market list |
| Department heads (chef, F&B, executive housekeeper, bar, chief engineer, front office) | raise indents |
| Operations manager | approve indents |
| Accounts | vendors including bank details, item and stock reports |
| GM | approve indents and purchase orders up to ₹5 lakh, everything else |
| MD | everything, any amount |

## Waiting on

- **CA**: HSN code and GST rate for each item, and which items' input tax credit is blocked (staff food, gifts); TDS category for each service vendor
- **Resort**: the vendor list with GSTIN / PAN, MSME certificates (Udyam) and whether each has a written payment agreement; current rates
