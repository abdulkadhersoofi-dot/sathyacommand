# Front desk plan

Prompted by the MD's review on 22 October 2026: a guest can be checked out from the first page with a restaurant order still open, the stay's services cannot be seen on the map, and the desk panel is dull and hard to read. Work goes in this order; each step is checked in a browser on a computer and a phone before the next.

## What was found

| # | What you saw | Why it happens |
|---|---|---|
| 1 | Check out is on the first page, and checks out only the room | Every card in Due out and In-house carries a **Check out** button, and the room on the 3D map has one too. Check-out looks only at the **room bill's balance**. A room-service order still open, a restaurant bill not yet settled, laundry not yet delivered or an activity not yet charged is simply left behind: it never reaches the invoice and there is nowhere to close it. |
| 2 | The services a guest used cannot be seen on the map | The room's drawer shows the booking (dates, guests, phone) and today's room-service orders, nothing else: not the restaurant bills charged to the room, the laundry, the activities, or what has been paid. |
| 3 | The desk is dull and badly arranged | Three flat lists of grey cards with buttons in a row; nothing says at a glance how the day stands (who is still to come, who is leaving with money due, which rooms are ready). |

## The plan

**Step 1. Check-out only from the opened booking, and only when everything is on the bill (fixes 1)**
- The **Check out** button leaves the lists and the map. It lives on the opened booking only.
- The HMS knows what a guest still has open: restaurant and room-service orders not yet billed to the room, laundry picked up but not delivered, activities booked but not charged. Check-out is **refused** while any of these exist, and the refusal names them.
- The opened booking shows them under **Before check-out**, each with its amount, and one button: **Put them on the room bill** (an order is billed and charged to the room, laundry is delivered and charged, an activity is charged; an order with nothing sent to the kitchen is cancelled). Then Check out lights up, takes any balance, and issues the one tax invoice with everything on it.
- The lists keep **Open** and **Payment**; the map's room drawer gets **Open the booking**.

**Step 2. The whole stay on the 3D map (fixes 2)**
- Tap an occupied room: under the guest, **The stay so far**: room nights, restaurant and bar bills charged to the room, laundry, activities and other charges, what has been paid, and the balance, with each line's date. Then **Still open**: the same items as on the desk, so the desk sees at a glance what must be closed. Today's room-service orders stay where they are.
- The room's label on the map gets a small mark while the guest has something open, so a departing guest with an unsettled order is visible from the lobby screen.

**Step 3. A desk that reads at a glance (fixes 3)**
- At the top, **the day in four tiles**: Arrivals (how many still to come), Due out (how many with money due), In-house, Rooms ready. Tapping a tile scrolls to its list.
- Each guest is a **card with a coloured band** (arriving amber, in-house blue, leaving red, done grey), the guest's initials, the room number large, and the facts that matter as tags: ETA, nights, balance due in red or "Settled" in green, open orders in amber, VIP, returning guest, online check-in, OTA. One action on the right: **Check in** for an arrival, **Open** for everyone else.
- The opened booking becomes a proper page: the guest and room at the top with a status pill, a **step row** (Booked → Checked in → Bill settled → Checked out), the toolbar (Check in or Check out in green when allowed, Payment, and Add a charge, Move room, Extra bed, Discount, Cancel under More ▾), then Before check-out, the bill grouped by kind with subtotals, and the invoices.

**Step 4. Release**
- Checks: tests for the refusal and the settlement, the walk-through (book, check in, room-service order, laundry, check-out refused, settle, check-out with one invoice), PGlite and PostgreSQL 16, desktop and phone screenshots.
- Docs, merge, deploy, report.

## Status (22 Oct 2026)

All four steps are done and on `main`.

| Step | What changed |
|---|---|
| 1. Check-out gate | **Check out** is gone from the lists and the map. On the opened booking it is greyed while the guest has a restaurant or room-service order not yet on the room bill, or laundry not yet delivered; those show under **Before check-out** with their amounts, and **Put them on the room bill** charges them all (an order with food sent is billed to the room, an order with nothing sent is cancelled, laundry is delivered and charged). The HMS refuses check-out while anything is open, naming it. The one tax invoice carries the room, the food and the laundry. |
| 2. The stay on the map | Tap an occupied room: **The stay so far** (the bill grouped as Room, Restaurant & bar, Laundry, Other, Paid, with the balance) and **Still open** (what check-out waits for), with **Open the booking**. A guest leaving today with something open gets a red marker above the room. |
| 3. The desk | The day in four tiles (Arrivals · Due out · In-house · Rooms ready; tap one to jump), guests as cards with a coloured band (arriving amber, in-house blue, leaving red), initials, the room number large, and the facts as tags (ETA, nights, due or settled, open bills, VIP, returning, online check-in, OTA). One action per card: **Check in** for an arrival, **Open** for the rest. The booking is a page: guest and room, the stay's steps (Booked → Checked in → Bill settled → Checked out), the toolbar, Before check-out, the bill by kind, the invoices. |
| 4. Release | 443 tests (5 new for the gate); the walk-through (book, check in, room-service order, laundry, drawer, refusal, settle, check-out with one invoice) on PGlite and PostgreSQL 16; desktop and phone screenshots. |
