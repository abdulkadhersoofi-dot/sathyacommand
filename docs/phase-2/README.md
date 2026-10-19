# Phase 2 · Core platform, front office & billing

Weeks 5–14 of the [blueprint](../HMS_BLUEPRINT.md). Built in steps, each one tested before the next.

| Step | What | Status |
|---|---|---|
| 2.1 | **Tax engine** (`packages/tax`): GST per room-night with the ₹7,500 guard, restaurant 5%/18% by premises status, GST + TN VAT bill split, advances, credit notes, e-invoice deadlines, reverse charge, OTA settlement, ITC reversal, TDS with thresholds and no-PAN rate, TCS, cash and MSME controls, liquor hours and dry days, Form C | Done · 44 test-book scenarios pass |
| 2.2 | **God Mode log** (`packages/audit`): append-only, hash-chained, tamper detection, nightly anchor | Done · 6 tests pass |
| 2.3 | Database schema and API server (Postgres, Fastify): property, 47 rooms, rate plans, users and roles | Next |
| 2.4 | Sign-in, roles, approval engine, device registration | |
| 2.5 | Reservations, check-in / check-out, folios, cashier shifts, night audit | |
| 2.6 | GST invoices, e-invoice (IRN) via GSP, receipt and refund vouchers | |
| 2.7 | Front desk screens; 3D dashboard switched to live data | |
| 2.8 | Twin Studio v1 (edit the 3D resort) | |

## Waiting on

- **CA**: review `packages/tax/config/tax-config.yaml` and `tax-test-book.csv` (TN VAT rates are still blank; bar hours and dry days from the licence)
- **Resort**: split of the 47 rooms by type, building, floor and room number, to build the room inventory and redraw the 3D model

## Run the tests

```bash
npm install
npm test
```
