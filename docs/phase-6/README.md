# Phase 6 · Accounts & full compliance

Weeks 29–38 of the [blueprint](../HMS_BLUEPRINT.md). **Done when** the CA files one full quarter's GST and TDS from the system's data without manual correction.

Every module so far already keeps its own records (bills, payments, purchases, stock). Phase 6 turns them into books without anyone typing them again, then produces the return data the CA files.

| Step | What | Status |
|---|---|---|
| 6.1 | **General ledger**: a hotel chart of accounts (Schedule III headings, USALI departments: rooms, food & beverage, bar, banquets, other operated; administrative, sales, maintenance, utilities undistributed), each store with its own inventory and change-in-inventory account; **vouchers** numbered per kind and financial year (SL sales, RC receipts, PU purchases, PY payments, SK stock, JV journal, RJ reversal), balanced, and final: a database trigger refuses any change or deletion, a mistake is put right by a reversal. **Automatic postings**, each source exactly once: guest charges (rooms, extra beds, laundry, sundries, food charged to rooms) and front-office receipts by method (cash, card, UPI, bank, company, OTA) as one voucher per business day once the night audit closes it; restaurant and bar sales from their GST and TN VAT invoices with the payments and the rounding, per day, through a clearing account that comes to nil; GST on advances (receipt and refund vouchers) and its adjustment on the stay invoice; credit notes; goods received expensed by item category as they arrive (the periodic method: GST that cannot be claimed is part of the cost) and cleared by the vendor's bill; bills with input CGST / SGST / IGST, service bills to the expense of the vendor's TDS category (contract services, professional fees, rent, commission, repairs); vendor payments with TDS by section; TASMAC purchases with TCS as a tax credit; opening stock; each **month close** bringing the store's inventory account to its counted closing value; cashier shifts short or over. A late document dated in a locked month is booked on the first open day, with its own date kept. **Reports**: day book, ledgers (with the guests, companies and vendors in them and their balances), trial balance (income and expense from the start of the financial year), **profit and loss by department** (departmental profit, undistributed costs, profit), balance sheet (with the year's profit and earlier years' not yet transferred). **Journal entries** by accounts, reversed only with a reason; accounts added to the chart (archived only at nil balance). **Month locks** by the GM; only the MD reopens one, logged to God Mode. An **Accounts** workspace for all of it | Done · 9 API tests + browser run (a day of trade, check-out, vendor paid with TDS, journal entry, ledger from the trial balance), also on PostgreSQL 16 |
| 6.2 | **Receivables (the city ledger)**: an account for every company or agent billed on credit, opened by itself the first time a stay or a restaurant bill is charged to it (found again by GSTIN or name), completed by accounts: kind (company, travel agent, OTA, government), GSTIN checked, PAN, contact, **payment terms**; a **credit limit** set only by the GM, enforced at the front desk and the restaurant (what is owed counts today's credit not yet posted), and a closed account takes no credit. Each bill is its own line on the account, named by its invoice number. **Statements** for any period (printable, with the bank details to pay into) and **ageing** by the bill's date (0–30, 31–60, 61–90, over 90 days), overdue after the terms; the overdue list, oldest first. **Money received** by bank, UPI, cheque or cash, settling the oldest bills first, with the **TDS the company deducted** (by section) booked as a tax credit; cash of ₹2 lakh or more from one party in a day refused. **Banks**: the resort's bank accounts, each with its own ledger account, one the default for payments. **Statement import** from the bank's CSV (the header row found by name, Indian date and amount formats, withdrawal / deposit or one amount with Dr / Cr; a line imported twice is skipped); **automatic matching** to the books by amount, date (a week either side) and the UTR or cheque number; matching by hand from the entries of that amount; what only the statement has is **posted from the line**: card or UPI **settlements** (the takings settled, the acquirer's fee and the GST on it, which is claimable), money from a company, or any account (bank charges, interest, capital, TASMAC, a transfer); lines left out with a reason. The **reconciliation**: books against the statement balance, what is on one side only, and the difference. **Cash**: banking the takings, the **petty cash** float topped up from cash or the bank, small expenses paid from it against an expense account (refused beyond the float; cash over ₹10,000 to one party in a day needs confirming, as it is not deductible) | Done · 11 API tests + 4 statement-reading tests + browser run (company stay and restaurant credit, money received with TDS, statement imported from a file, settlement and charges posted, reconciled to nil, petty cash, phone) |
| 6.3 | OTA reconciliation (commission, GST on it, GST TCS, income-tax TDS, net payout) and credits to claim (TDS by customers, TASMAC TCS) matched with Form 26AS | |
| 6.4 | GST returns: GSTR-1 and GSTR-3B data and upload files, IMS actions on purchase bills, GSTR-2B matching, reverse charge, common-credit reversal, period lock after filing | |
| 6.5 | TDS: thresholds, lower-deduction certificates, challans with interest and late fee, quarterly statement data, Form 16A, advance-tax reminders | |
| 6.6 | TN VAT return data, fixed assets with depreciation (Companies Act and income tax), department budgets, Tally export, the CA's read-only access | |

## Roles

| Role | Can |
|---|---|
| Accounts | the books (read), journal entries and reversals, the chart of accounts; company accounts and money received; bank accounts, statements and reconciliation; banking cash and petty cash |
| GM | the books (read), lock a month; company accounts (read) and their **credit limits** |
| Front office manager | company accounts and statements (read) |
| External auditor / CA | the books, tax documents, payables and receivables (read only) |
| MD | everything, and the only one who can reopen a locked month |

## Choices to confirm

- **Stock on the periodic method** (usual for Indian hotels and Tally): purchases are expensed by category as goods arrive; each month close sets every store's inventory to its counted value through "change in inventory". Opening stock goes to "Opening balances".
- **Front office and restaurant post once per business day**, after the night audit; bills, payments and purchases post as they happen.
- **VAT on TASMAC purchases** is part of the cost of liquor, not a credit. CA check
- **TASMAC purchases** are owed to "TASMAC payable" until paid from the bank (bank matching in 6.2).

## Waiting on

- **CA**: the chart of accounts (codes and headings), and opening balances of every account on the go-live date
- **CA**: whether VAT paid to TASMAC can be set off against VAT on bar sales
- **Resort**: the bank accounts (bank, branch, account number, IFSC), and a sample statement CSV from each bank's website to check the import
- **Resort / GM**: the list of credit companies and agents with their terms and credit limits
- **Resort**: the card and UPI acquirers (which bank settles, how often) and their fee rates
