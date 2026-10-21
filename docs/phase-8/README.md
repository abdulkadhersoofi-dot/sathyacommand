# Phase 8 · HR & payroll

Weeks 41–46 of the [blueprint](../HMS_BLUEPRINT.md). **Done when** two payroll months run in parallel with the current method and match.

**Status:** step 8.1 is built. Payroll (8.2) and salary TDS, Form 16 and settlements (8.3) follow.

The rules (departments, leave, holidays, PF, ESI, professional tax, welfare fund, bonus, gratuity, salary TDS) are in [`server/seed/payroll.yaml`](../../server/seed/payroll.yaml), for HR and the CA to review.

| Step | What | Status |
|---|---|---|
| 8.1 | **People** (top bar → **People**). **Employees**: a code (E0001…), name, department (each mapped to its ledger department for payroll costs), designation, kind (permanent, probation, fixed term, contract, trainee), joining date, mobile, gender, date of birth, address, emergency contact; **PAN** and **IFSC** checked, **UAN** (12 digits) and **ESIC IP** (10 digits), the bank account (shown in full only to HR and payroll; a change goes to God Mode, as for vendors), **Aadhaar**: only the last four digits are kept; PF, professional tax and welfare fund each on or off; the tax regime; the person's **app login** linked by its email, so they see their own leave (and later their payslips). **Pay structure**: basic, DA, HRA, conveyance, special and other allowances a month, from a date (a change applies from that date; earlier months keep the old structure), PF on full wages if the employee chose it; under the **Code on Wages**, allowances above half the total pay count as wages for PF, bonus and gratuity, and the screen says so when they do. Pay is seen by HR, payroll and the person; department heads see the record without pay. **Onboarding checklist** (appointment letter, ID proof, PAN, bank, UAN, ESIC, consent notice, medical fitness for food handlers, photo, uniform and locker), ticked with who did it. **ID card** with a QR, printable. **Training and certificates** (FSSAI food handler, fire drill, first aid, hygiene, responsible service of alcohol, safety), with **Training due** listing those lapsed or running out in 60 days. **Leaving**: last working day and reason (resigned, retired, contract ended, dismissed…); the person shows as serving notice, then left. **Leave**: casual and sick leave (12 days each a year, pro rata in the joining year), **earned leave** (one day for each month worked, after a year's service, up to 24 carried into the next year), compensatory off and maternity leave granted by HR, leave without pay; credits are put in once each, by themselves. The employee asks on their phone (**Staff → My leave**: balances, ask, cancel, what was decided, the holidays to come); holidays inside the leave are not counted; more than the balance, overlapping leave, and more than two days of sick leave without a medical certificate are refused; the **department head** approves or turns it down with a reason (only their own department's, once their login is linked to their own employee record; HR, the GM and the operations manager any department's), never their own leave; cancelling gives the days back. **Holidays**: the four national holidays each year (cannot be removed) and the five festival holidays HR chooses, with a reminder until all five are chosen | Done · 6 API tests + browser run (HR adds an employee with IDs, pay structure, login, onboarding, training and two festival holidays; she asks for casual leave on her phone; the executive housekeeper approves it; her balance and the holidays on the phone) |
| 8.2 | **Payroll run** for a month from attendance and leave: paid days, leave without pay, overtime at twice the hourly rate; PF (12% / 12% up to the ₹15,000 ceiling, EPS and EDLI, admin charges) with the ECR file, ESI (0.75% / 3.25% up to ₹21,000) with its file, Tamil Nadu professional tax (half-yearly), labour welfare fund (December); approval by the GM and MD; payslips; the bank transfer file; postings to the ledger by department; the statutory payments and their due dates | Next |
| 8.3 | **Salary TDS** (new or old regime, declarations and proofs, projected over the year), the 24Q figures and Form 16 Part B; salary advances and loans; bonus and gratuity provisions; full and final settlement; payslips, Form 16 and leave in the staff app; the **parallel run** comparison with the current payroll | Planned |

## Roles

| Role | Can |
|---|---|
| HR & payroll | employees, pay structures, onboarding, documents, training, leaving; leave for anyone, grants and corrections; holidays |
| GM, operations manager | employees (without bank details), leave approval, training due |
| Front office manager, executive housekeeper, F&B manager, chief engineer, security head | approve or turn down leave in their own department |
| Everyone with a linked login | their own leave: balances, asking, cancelling, the holidays |
| MD | everything |

## Choices to confirm

- **Leave**: casual 12 and sick 12 days a year (not carried forward), earned leave one day a month after 12 months' service with up to 24 carried forward (Tamil Nadu Shops and Establishments Act); sick leave above two days needs a medical certificate. HR check against the resort's standing orders and appointment letters.
- **Holidays**: the four national holidays (26 January, 1 May, 15 August, 2 October) and five festival holidays chosen by HR (Tamil Nadu Industrial Establishments (National, Festival and Special Holidays) Act). Leave does not count holidays; weekly offs come from the roster.
- **Code on Wages**: allowances above half the total pay count as wages. CA check, with the structures the resort uses now.
- **Aadhaar**: only the last four digits are kept, as for guests.

## Waiting on

- **HR**: the employee list (codes if the resort has them, departments, designations, joining dates, PAN, UAN, ESIC numbers, bank accounts) and current pay structures; the five festival holidays for 2026 and 2027; each person's leave balance today, entered once as an opening grant
- **HR / CA**: the standing orders or leave policy in use, the minimum wage notified for hotels and the resort's zone, the professional tax slabs of the local body (town panchayat or municipality), and how the Code on Wages is applied in today's structures
