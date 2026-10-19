# Phase 2 · Core platform, front office & billing

Weeks 5–14 of the [blueprint](../HMS_BLUEPRINT.md). Built in steps, each one tested before the next.

| Step | What | Status |
|---|---|---|
| 2.1 | **Tax engine** (`packages/tax`): GST per room-night with the ₹7,500 guard, restaurant 5%/18% by premises status, GST + TN VAT bill split, advances, credit notes, e-invoice deadlines, reverse charge, OTA settlement, ITC reversal, TDS with thresholds and no-PAN rate, TCS, cash and MSME controls, liquor hours and dry days, Form C | Done · 44 test-book scenarios pass |
| 2.2 | **God Mode log** (`packages/audit`): append-only, hash-chained, tamper detection, nightly anchor | Done · 6 tests pass |
| 2.3 | **Database and API server** (`server/`): PostgreSQL schema with an append-only audit table enforced by the database; property, 47 rooms (placeholder list), venues, room types, EP/CP/MAP/AP rate plans, roles from the approvals file; API for spaces, room types, rates, night-by-night GST quotes, rate changes guarded at ₹7,500, audit log and chain check | Done · 12 API tests pass |
| 2.4 | Sign-in (mobile OTP), two-factor for owner roles, approval engine, device registration | Next |
| 2.5 | Reservations, check-in / check-out, folios, cashier shifts, night audit | |
| 2.6 | GST invoices, e-invoice (IRN) via GSP, receipt and refund vouchers | |
| 2.7 | Front desk screens; 3D dashboard switched to live data | |
| 2.8 | Twin Studio v1 (edit the 3D resort) | |

## Waiting on

- **CA**: review `packages/tax/config/tax-config.yaml` and `tax-test-book.csv` (TN VAT rates are still blank; bar hours and dry days from the licence)
- **Resort**: split of the 47 rooms by type, building, floor and room number, to build the room inventory and redraw the 3D model

## Run it

```bash
npm install
npm test                      # 64 tests: tax book, audit log, API
npm run start -w server       # API on http://localhost:8080 with a local database in server/data
```

Set `DATABASE_URL` to use a real PostgreSQL database instead of the local one.
Until sign-in arrives in step 2.4, send `x-user-id: u-md` to act as the MD.

## Notes

- **Meal-plan packages and the ₹7,500 limit.** A package is taxed on its full nightly value, so a ₹7,000 villa with breakfast (₹7,600) would cross ₹7,500 and move the restaurant to 18% next year. The seed therefore leaves out every plan/room-type combination above ₹7,500 (CP/MAP/AP for villas and suites, AP for premium rooms). The MD and CA decide how to price those (for example, billing meals separately).
- **Room list is a placeholder**: 36 Park Wing rooms, 8 villas, 3 suites, with assumed rates. Every row is flagged `placeholder` until the real list replaces `server/seed/rooms.placeholder.csv`.
