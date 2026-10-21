# Fix plan before Phase 9

Prompted by the MD's review on 21 October 2026. Each problem below was reproduced on a fresh install. Work goes in this order; nothing from Phase 9 starts until every item is fixed and checked.

## What was found

| # | What you saw | Why it happens |
|---|---|---|
| 1 | The date stays on 20 October | The app shows the **hotel's business day**. It moves on only when someone runs **Close day** (the night audit). Nobody is prompted to run it, and nothing closes the day by itself. |
| 2 | None of the accounts features work | (a) The front desk and the restaurant post their takings to the books only when a day is closed (see 1), so the books stay empty. (b) Every tax invoice (check-out bill, restaurant bill, banquet bill) is refused until the company's legal name and GSTIN are set, and there is no screen to set them (see 3). (c) Accounts has only a journal entry for hand entries: no simple payment, receipt or bank-to-cash entry, and no opening balances. |
| 3 | No profile settings for GSTIN and other details | The server can store them, but no screen was ever built. The error message even points to "Property settings", which does not exist. |
| 4 | Booking a banquet event is very difficult | A booking needs five separate steps: a long enquiry form, a quote, accepting the quote, a contract form, then a payment. |
| 5 | New places in the 3D map have no name label | Labels come from a fixed list of 12 places. A new or renamed building, hall or villa never gets its own label. |
| 6 | Roads and pathways cannot be edited | Twin Studio can move and add buildings, blocks, villas and lawns, but roads and paths can only be drawn in code. |
| 7 | "Full of bugs" generally | The automated checks prepared things a real user would not (for example the GSTIN was filled in beforehand), so whole-flow problems were missed. |

## The plan

**Step 1. Resort profile (fixes 3, and the invoice half of 2)**
- Add **Settings → Resort profile** for the MD:
  - names: trading name and legal name;
  - tax IDs: GSTIN (checked; it fills in the PAN and state), PAN and TAN;
  - contact: address, city, PIN, phone, email and website;
  - documents: invoice number prefix, the person who signs TDS returns and Form 16;
  - day close: the time the day closes by itself.
- Add a **Getting started** checklist for the MD: profile, rooms and rates, outlets, bank account and opening balances. It shows until each item is done.

**Step 2. The date (fixes 1, and the posting half of 2)**
- The date chip shows the **real calendar date**.
- If the hotel day is behind, a clear bar says "20 Oct not closed yet" with one **Close day** button.
- The day **closes by itself** at a set time (3:00 am unless changed), catching up any days that were missed. The God Mode log records it.
- Once a day closes, its takings post to the books.

**Step 3. Accounts made usable (fixes 2c)**
- Simple entries alongside the journal:
  - **Payment** (an expense or bill paid, by cash or bank);
  - **Receipt** (money received);
  - **Bank ↔ cash** (deposit or withdrawal).
- **Opening balances** entered once.
- Each figure in the trial balance, P&L and balance sheet opens its ledger.
- Clear messages when there is nothing yet, with what to do next.
- A full walk-through of every Accounts tab with real entries; every failure fixed.

**Step 4. Banquet booking in one screen (fixes 4)**
- **Book an event** from the calendar or the Events tab, on one form:
  - who, phone, kind of event;
  - venue, date, times;
  - guests, menu and price;
  - the advance received now, if any.
- It creates the booking, the quote and the contract in one go. Enquiries and quotes stay available for those who want them.
- Tapping a booking on the calendar opens it. The long form keeps only what is needed, with the rest under "more details".

**Step 5. 3D map (fixes 5 and 6)**
- Every building, hall, block and villa shows its own name label, which follows when it is renamed or moved.
- In Twin Studio, **roads and pathways can be edited**:
  - draw a new road or footpath;
  - select one and drag its points, add or remove a point;
  - change its width and kind (main drive, footpath, highway);
  - delete it.
- Footpaths are drawn narrower and in a paving colour.

**Step 6. A real-day walk-through on a fresh install (fixes 7)**
- A scripted day run the way staff would use it, with nothing prepared in advance, on desktop and phone:
  - the MD sets up the profile;
  - front desk: booking → check-in → restaurant charge → check-out with invoice;
  - restaurant order → bill;
  - housekeeping;
  - a purchase and payment in Stores;
  - a banquet booking and its advance;
  - payroll;
  - Close day;
  - every Accounts report.
- Every error, dead end or confusing step found is fixed.
- That walk-through then becomes a permanent automated test.
- Dates shown as day/month/year throughout.

**Step 7. Release**
- Checks: all tests, the new walk-through, and both databases (PGlite and PostgreSQL 16).
- Release: docs updated, merged, deployed.
- Report: a summary of what was fixed, with screenshots.

## What would help from you

- Any other screen or step that failed for you: what you tapped and what happened (a phone screenshot is enough).
- The resort's live address on Render, if you would like me to check it there as well.

## Status (21 October 2026): done

All seven steps are done. Checks:
- the automated tests pass (440, including a real day on a fresh install);
- the front desk, approvals and accounts were walked through in a browser on PGlite and on PostgreSQL 16, on a computer and on a phone.

| # | What you saw | Now |
|---|---|---|
| 1 | Date stuck on 20 October | The chip shows today's date. A bar says when the hotel day is still open, with **Close the day**. The day closes by itself at 3:00 am (Settings → Resort profile), catching up missed days. Closing a day early asks you to confirm. |
| 2 | Accounts did nothing | Takings reach the books when each day closes. Invoices work once the profile is filled in. Accounts has Payment, Receipt, Cash ↔ bank, Journal and Opening balances. |
| 3 | No GSTIN / profile screen | **Settings → Resort profile**: the PAN fills itself from the GSTIN. **Getting started** lists what is left. |
| 4 | Banquet booking hard | **Book an event** is one form, from the calendar or the Events tab: venue, date, guests, menu, advance. |
| 5 | No labels on new places | Every building, hall, lawn, pool, block and villa has its own label. The label follows a rename. |
| 6 | Roads not editable | Twin Studio draws, bends, extends, narrows and deletes roads and footpaths. |
| 7 | Many other bugs | Three walk-throughs (front office; restaurant, stores, engineering and security; accounts, banquets and HR) found about 50 problems. All are fixed except the two listed below. |

### What the walk-throughs fixed

**Front desk**
- **Find a booking** searches by name, mobile, booking number, room or OTA ID, and lists the coming bookings.
- One booking screen shows the stay, the bill, payments, the balance, and invoices with Print. It also offers:
  - check in and check out;
  - take an advance or payment;
  - add a charge, move room, extra bed, discount;
  - cancel, reverse a charge, record Form C.
- **Check-in**:
  - lists clean rooms first;
  - a room not yet cleaned needs a tick;
  - explains a different room type;
  - checks Aadhaar and passport numbers.
- **Payment** and **check-out**:
  - show what is still to be charged;
  - check-out takes the payment in the same step;
  - a same-day stay is charged.
- **Invoices** print the stay, the total with GST, and paid and balance, and fit a phone.
- **Settings → Rooms & rates**:
  - rate per room type and meal plan;
  - set a rate;
  - carry all rates into the next season;
  - edit room types.

**Approvals**
- An **Approvals** button appears in the top bar when something waits for you: new devices, discounts, cancelled items after the KOT, price changes, stock counts, payments and purchase orders.
- Each request shows in plain words, with Approve or Reject.
- A restaurant order cannot be billed or paid while a cancellation or discount on it waits.

**Restaurant and stores**
- Liquor bills wait until the VAT rates and the TIN are set.
- The bill card adds up.
- The kitchen screen drops cancelled tickets and old paid orders.
- Printers opens without an error.
- Breakage cannot exceed the stock.
- Goods for the kitchen, engineering or linen store link themselves.
- A vendor bill with lines not on the PO is shown as a difference.

**Accounts**
- **E-invoices** (Accounts → GST):
  - Generate, when a GST provider is connected;
  - or download the JSON for einvoice1.gst.gov.in and record the IRN by hand.
- **Fixed assets**:
  - an asset already in the opening balances is not posted twice;
  - depreciation runs from the month the books begin and catches up.
- **Banks**: the bank details can be edited.
- **Customer advances** show as liabilities on the balance sheet.
- **Company statements** name the tax invoice.
- **Banquet invoices** carry SAC codes.

**Banquets and HR**
- An event can only be marked served, or given its final bill, on or after its date.
- Payroll for the current month opens from the 25th.
- A holiday date already taken is refused.

### Still to do, or for you to decide
- **SAC codes for halls and event services**: I used 997212 and 998596. Please have the CA confirm them.
- **Split restaurant bills**: tax can differ from one bill by a few paise, because each part is rounded.
- **PF without a UAN**: PF is still deducted for an employee who has no UAN. The screen warns, but the ECR file leaves them out. Get the UAN generated before running payroll.
- **E-invoices**: generating them in one tap needs a GST provider (GSP) account. Until then, upload the JSON on the portal.
