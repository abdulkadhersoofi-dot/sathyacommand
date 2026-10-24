# Payment status and housekeeping plan

Prompted by the MD's review on 24 October 2026. Two problems; work goes in this order and each step is checked in a browser before the next.

## What was found

| # | What you saw | Why it happens |
|---|---|---|
| 1 | A room booked from the map shows "Settled" at once | The desk and the map say "Settled" whenever the bill's **balance is zero**. A guest who has just checked in has a zero balance because the room night is charged only when the day closes; nothing has been paid. Zero balance and "paid in full" are not the same thing. |
| 2 | Dirty rooms do not stand out on the map; the room card is a row of plain buttons with "Set status…" | On the map a dirty room is a flat purple, like any other colour. The room card lists every action the same way, so the one thing an attendant does most (start, then "room is clean") sits beside out-of-order and sleeper/skipper checks, and the status itself hides behind a dropdown. |

## The plan

**Step 1. Honest payment status (fixes 1)**
- Each stay knows three figures: what is **charged so far**, what is **paid**, and what is **still to come** (room nights not yet charged, with GST). The desk card and the room on the map say which applies: **₹X due now** (red), **Nothing paid yet · ~₹Y for the stay** or **Paid ahead ₹Z · ~₹Y still to come** (amber), **Paid ahead** (green) and **Settled** (green) only when nothing more is to come and nothing is due. A checked-out stay is settled by definition.
- The booking page's "Bill settled" step is done only when nothing is open, nothing is due and no night is left to charge.
- A banquet function on the map says **Nothing paid yet**, **Advance paid** or **Paid in full** (amounts for the MD only).

**Step 2. Dirty rooms flash on the map; the room card is made for the hand (fixes 2)**
- A room that needs cleaning **flashes** purple-white on the map (in the Occupancy and Housekeeping layers), so the floor sees it from across the lobby screen.
- The room card is rebuilt around what the person does: one or two **big tiles with a picture and two words**, in colour, that change with the room's state:
  - To clean → **Start cleaning** (blue). Cleaning → **Room is clean** (green; the checklist appears as big tick rows, all ticked, with one Done button). Cleaned → for a supervisor **Inspected · ready** (teal) and **Needs re-clean** (red). Occupied → **Serviced** / **Needs service**. Plus **Do not disturb** on/off (amber).
  - Below, small plain buttons for the rest: Minibar, Laundry, Found an item, Report a fault, I found it empty / a guest.
  - Managers' tools (Out of order, Add task, Change status, Return to service) go under **More ▾**.

**Step 3. Release**
- Checks: tests, a walk-through (check in a guest → desk and map say nothing paid yet; the room's task from Start to Inspected from the card; a dirty room flashing), PGlite and PostgreSQL 16, screenshots on a computer and a phone.
- Docs, merge, deploy, report.

## Status (24 Oct 2026)

All three steps are done and on `main`.

| Step | What changed |
|---|---|
| 1. Payment status | Every stay carries what is paid and what is still to come. The desk card, the booking page and the room on the map say **Nothing paid yet · ~₹Y for the stay**, **Paid ahead ₹Z · ~₹Y still to come**, **₹X due now** or **Settled**; "Settled" needs nothing due and no night left to charge. A venue on the map says **Nothing paid yet**, **Advance paid** or **Paid in full** for its function. |
| 2. Housekeeping | A room to clean blinks purple and white on the map, in the Occupancy and Housekeeping layers, even in eco mode. The room card is big coloured tiles that follow the room: **Start cleaning** → **Room is clean** (a tick list, one Done button) → **Inspected · ready** / **Needs re-clean**; occupied rooms get **Serviced** / **Needs service**; **Do not disturb** stays in amber. Minibar, laundry, found-an-item, report-a-fault and the empty / guest checks are small buttons under the tiles; Add a task, Change the status and Out of order sit under **More ▾** for managers only. An attendant's **My rooms** tab also lists the rooms nobody has been given yet; tapping one and starting makes it theirs. |
| 3. Release | 444 tests (one new: whoever starts an unassigned room keeps it). The walk-through on PGlite and PostgreSQL 16: a guest checked in with nothing paid, another with an advance; the desk and the map say so; Room 103 from Start cleaning to Inspected from the card as the MD; Room 102 from an attendant's phone through the tick list; a dirty room blinking on the map. Desktop and phone screenshots. |
