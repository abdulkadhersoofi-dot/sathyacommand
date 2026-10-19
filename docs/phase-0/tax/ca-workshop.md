# CA workshop pack

Send this folder to the resort's chartered accountant before the workshop (week 3, about 2 hours).

## What the CA receives
1. [tax-config.yaml](../../../packages/tax/config/tax-config.yaml): every GST, TDS, TCS and VAT rule the software will apply. Mark each `ca_status` as `confirmed` or `changed`.
2. [tax-test-book.csv](../../../packages/tax/config/tax-test-book.csv): 44 real scenarios with the expected result. Fill `ca_verdict` (agree / disagree) and `ca_notes`. Every row is already an automatic test (`npm test` in `packages/tax`); a change the CA makes here changes what the tests expect.

## Questions that need a decision
1. **Specified premises.** Did any unit sell above ₹7,500 a night in FY 2025-26? Should the resort opt in by declaration? This decides restaurant GST at 18% with ITC or 5% without.
2. **Extra beds.** Do extra-bed and extra-person charges count towards the ₹7,500 per-night value?
3. **Packages.** How should MAP/AP and wedding packages be split between accommodation, food and hall for GST?
4. **Banquet hall rental.** SAC code and rate; treatment when hall, catering and rooms are sold as one package.
5. **ITC reversal.** Method for common credits given the mix of 5% (no ITC) and 18% (with ITC) supplies.
6. **Income-tax Act, 2025.** Section references and statement/form names to print on TDS certificates and challans from April 2026.
7. **TCS on liquor purchases.** Does TASMAC collect TCS from the bar licensee, and how is the credit claimed?
8. **TN VAT.** Current rates for spirits, beer and wine sold in the bar; return frequency and format; any input credit on TASMAC purchases.
9. **E-invoicing.** Turnover band, and whether IRN generation should be live from Phase 2 go-live.
10. **Tally.** Ledger names and voucher types the CA wants in the export.
11. **Retention.** Confirm 8-year retention for invoices, vouchers and registers.
