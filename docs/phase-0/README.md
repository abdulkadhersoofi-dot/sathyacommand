# Phase 0 · Discovery & compliance foundation

Weeks 1–4. Goal: agree exactly what gets built, sign off the tax set-up with the CA, and collect everything Phase 2 needs to start.
Full plan: [HMS_BLUEPRINT.md](../HMS_BLUEPRINT.md).

**Done when:** scope, tax set-up and designs are signed off by the MD and the CA.

## Workstreams

| # | Workstream | File | Status | Needs from the resort |
|---|---|---|---|---|
| 1 | Owner decisions & property facts | [01-owner-intake.md](01-owner-intake.md) | 5 of 28 answered | Room locations, entity & GSTIN, Champagne vendor contact |
| 2 | Department workshops | [02-department-workshops.md](02-department-workshops.md) | Question sets ready | One 60–90 min session per department head |
| 3 | Data export from current HMS / POS | [03-data-export-checklist.md](03-data-export-checklist.md) | Checklist ready | IT or vendor to export files |
| 4 | Tax set-up (GST, TDS/TCS, TN VAT) | [tax/](tax/) | Drafted, waiting for CA | CA review of config and test book |
| 5 | Roles, approval limits, God Mode alerts | [roles-and-approvals.draft.yaml](roles-and-approvals.draft.yaml) | Drafted | MD to confirm limits |
| 6 | Licence & compliance register | [licence-register.csv](licence-register.csv) | Template ready | Licence numbers and expiry dates |
| 7 | Site, network & hardware survey | [04-site-and-hardware-survey.md](04-site-and-hardware-survey.md) | Checklist ready | Site walk, drone photo |
| 8 | Tamil glossary for staff screens | [tamil-glossary.draft.csv](tamil-glossary.draft.csv) | Drafted | Review by Tamil-speaking supervisors |
| 9 | Screen designs (clickable prototype) | to follow | Starts after workshops | Feedback sessions |

## Decisions so far

| Date | Decision | By |
|---|---|---|
| 2026-10-19 | Restaurant GST stays at 5% without ITC; no opt-in as specified premises (CA to confirm) | MD |
| 2026-10-19 | Any room rate above ₹7,500 a night needs MD approval, to protect the 5% restaurant rate | MD |
| 2026-10-19 | Product owner is the Managing Director | MD |
| 2026-10-19 | Inventory is 33 keys: 20 rooms, 10 villas, 3 suites | MD |
| 2026-10-19 | Turnover above ₹10 crore: e-invoicing with 30-day IRN reporting; 194Q TDS on large purchases | MD |

## Weekly plan

| Week | Focus |
|---|---|
| 1 | Owner intake answered · data export requested · licence register filled · CA receives tax pack |
| 2 | Department workshops (front office, F&B, kitchen, bar, housekeeping) · site walk & drone photo |
| 3 | Workshops (stores, accounts, HR, engineering, security, sales) · CA workshop · roles & limits agreed |
| 4 | Prototype review with each department · final scope · sign-off |

## How drafts work

Files ending in `.draft.*` are my starting proposals. Edit them directly (or tell Claude what to change). Once the MD or CA signs off, the file is renamed without `.draft` and becomes the configuration the software loads in Phase 2.
