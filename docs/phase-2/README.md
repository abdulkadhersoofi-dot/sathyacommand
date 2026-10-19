# Phase 2 · Core platform, front office & billing

Weeks 5–14 of the [blueprint](../HMS_BLUEPRINT.md). Built in steps, each one tested before the next.

| Step | What | Status |
|---|---|---|
| 2.1 | **Tax engine** (`packages/tax`): GST per room-night with the ₹7,500 guard, restaurant 5%/18% by premises status, GST + TN VAT bill split, advances, credit notes, e-invoice deadlines, reverse charge, OTA settlement, ITC reversal, TDS with thresholds and no-PAN rate, TCS, cash and MSME controls, liquor hours and dry days, Form C | Done · 44 test-book scenarios pass |
| 2.2 | **God Mode log** (`packages/audit`): append-only, hash-chained, tamper detection, nightly anchor | Done · 6 tests pass |
| 2.3 | **Database and API server** (`server/`): PostgreSQL schema with an append-only audit table enforced by the database; property, 47 rooms (placeholder list), venues, room types, EP/CP/MAP/AP rate plans, roles from the approvals file; API for spaces, room types, rates, night-by-night GST quotes, rate changes guarded at ₹7,500, audit log and chain check | Done · 12 API tests pass |
| 2.3b | **Editable rooms and room types**: add, rename, renumber, retype or archive rooms and room types at any time (no fixed total); bulk import of the real room list that archives leftover placeholders; MD/GM only; every change logged with before and after | Done |
| 2.4 | **Sign-in and approvals**: SMS code sign-in, authenticator app (second factor) for MD, GM, accounts and HR with first-time set-up, new-device approval for back-office logins, sliding session timeouts by role (15 / 30 / 240 min), staff logins and roles (only the MD grants God Mode), instant lock-out that ends all sessions, approval inbox (rates above ₹7,500, new devices) | Done · 25 API tests pass |
| 2.4b | SMS provider (DLT-registered), 4-digit PIN quick-switch on shared tablets, shift-bound sign-in (needs rosters) | Later |
| 2.5 | **Front office**: availability by room type and night; reservations with the price fixed per night at booking; overbooking refused (and double-booking a room refused by the database itself); room assignment, moves and upgrades; discounts within role limits, larger ones to the approval inbox; extra beds (counted toward the ₹7,500 slab); cancellation; check-in with ID (only the last 4 characters stored) and a 24-hour Form C task for foreign guests; guest bills with laundry and other charges, manager-only reversals (never deletion), payments by cash, card, UPI, bank, company or OTA, refunds; ₹2 lakh cash block (attempts logged); check-out with balance check and early-departure night release; cashier shifts with denomination count and variance flag; night audit that marks no-shows, posts each night's room charge with GST from that night's value, records the day's figures and moves the business date | Done · 18 tests run two full business days |
| 2.6 | **GST documents**: company tax details with GSTIN check-digit validation (must be a Tamil Nadu GSTIN); tax invoice issued automatically at check-out with every field the invoice rules require, SAC per line, rate-wise summary, amount in words and advances adjusted; reversed charges drop out; gap-free numbering per financial year (`SPR/26-27/000001`, max 16 characters); receipt vouchers with GST on advances and refund vouchers on refunds; credit notes capped at what was invoiced; issued documents frozen by the database; B2B documents queued for e-invoicing with the 30-day deadline, IRP JSON payload, pre-checks that name what the portal would reject, IRN generation through a pluggable provider (sandbox until a GSP is chosen); printable invoice; e-invoice deadlines in the night audit; check-out refused until the company GSTIN is set | Done · 11 tests |
| 2.7 | **Front desk screens and live 3D**: the app finds the HMS server and switches from sample data to live; sign-in screen (SMS code, authenticator code, first-time set-up with QR code, new-device approval message); 3D dashboard and panels on real rooms and bookings, refreshed instantly from a live event stream, with check-in / check-out animations; front desk panel (arrivals, due out, in-house with balances); forms for new booking (live GST quote), check-in with room choice and ID, payment (advance → receipt voucher), check-out with tax invoice and print, cashier shift open / close with note count, closing the day with its summary; God Mode tied to the signed-in role; sign-out; one Render web service serves app and API ([deploy guide](../DEPLOY.md)) | Done · 3 API tests + browser run of the full flow |
| 2.8 | Twin Studio v1 (edit the 3D resort) | |

## Waiting on

- **MD**: company legal name, GSTIN, address and PIN (Property settings) — check-out is blocked until these are set
- **Phase 0 decision**: which GST Suvidha Provider (GSP) to use for e-invoicing; until then IRNs come from a sandbox and are not registered
- **CA**: SAC code for laundry (e-invoices with laundry lines are held until it is set)

- **CA**: review `packages/tax/config/tax-config.yaml` and `tax-test-book.csv` (TN VAT rates are still blank; bar hours and dry days from the licence)
- **Resort**: split of the 47 rooms by type, building, floor and room number, to build the room inventory and redraw the 3D model

## Run it

```bash
npm install
npm test                      # 115 tests: tax book, documents, audit log, API, front office, invoicing, dashboard feed
npm run build && npm run start -w server   # app + API on http://localhost:8080, local database in server/data
```

Set `DATABASE_URL` to use a real PostgreSQL database instead of the local one, and `MD_MOBILE` to give the MD's login a mobile number on first start.
Until an SMS provider is connected, sign-in codes are printed in the server log (never in production).

## Notes

- **Meal-plan packages and the ₹7,500 limit.** A package is taxed on its full nightly value, so a ₹7,000 villa with breakfast (₹7,600) would cross ₹7,500 and move the restaurant to 18% next year. The seed therefore leaves out every plan/room-type combination above ₹7,500 (CP/MAP/AP for villas and suites, AP for premium rooms). The MD and CA decide how to price those (for example, billing meals separately).
- **Room list is a placeholder**: 36 Park Wing rooms, 8 villas, 3 suites, with assumed rates. The real list can be loaded at any time through `POST /api/rooms/import` with `replacePlaceholders: true`; rooms can be added later without limit.
