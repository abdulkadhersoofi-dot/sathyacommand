# Layout and 3D plan

Prompted by the MD's review of the live site on 22 October 2026. Work goes in this order; each step is checked in a browser on a computer and a phone before the next.

## What was found

| # | What you saw | Why it happens |
|---|---|---|
| 1 | The top buttons overlap on the home page | Above 1560 px wide every module button shows its name, so the row no longer fits and the date chip lands on top of "Modules". The brand name is cut to "Sath". |
| 2 | Settings works once, then nothing responds; logins cannot be added | Each screen waits for its last request to finish before it accepts the next tap. On Render a request can hang (the service wakes from sleep, or the connection drops), and the screen stays locked with no sign of it. Nothing says "still working". |
| 3 | Buttons are placed in a random order | Every screen lists its actions in the order they were built. The banquet event page shows 13 buttons in one row: client details, add function, quote, release hold, contract, payment, lost, cancel… with no grouping. |
| 4 | All KOTs point to the restaurant on the 3D map | The map only knows two food places, Main Kitchen and Sathya Dine. Orders from the bar, the poolside and any outlet added later all fall back to the restaurant. The outlet screen asks for a "place code" to type, so nobody links them. |

## The plan

**Step 1. The two bugs (today)**
- Every request times out after 25 seconds with a plain message, and a screen never stays locked: a small "Working…" mark shows while it waits, and a tap during that time says so instead of being dropped.
- The top bar is rebuilt (see step 2), which removes the overlap.

**Step 2. One clean frame for the whole app**
- **Top bar**, left to right: resort name · today's date and clock · **Approvals** (when something waits) · your name menu (Night, Eco mode, God Mode, Password, Sign out). Nothing else.
- **Module rail** on the left: one column of icons with names (Front desk, Restaurant, Housekeeping, Staff, Engineering, Security, Stores, Accounts, Banquets, Guests, People, Settings). The rail collapses to icons on a laptop and becomes a bottom bar on a phone. The current module is marked. This replaces the row of 14 buttons and the Modules menu.
- **Inside a module**: the title and its tabs on one line; below them a **toolbar** that is the same on every screen:
  - **left**: the one or two things you do most (New booking, Book an event, Add item…), in green;
  - **middle**: filters and search;
  - **right**: everything else under a single **More ▾** menu, with the dangerous ones (cancel, delete, lost) last and in red.
- **Detail pages** (a booking, an event, a ticket, a vendor): the facts at the top, then **one row of next steps in the order they happen** (for an event: Quote → Accept → Contract → Advance → Event order → Guests served → Final bill → Close), the current step highlighted and the finished ones ticked. Side actions (add function, add item, supplier, follow-up, hold rooms) go under More ▾; Lost and Cancel at the end in red.
- **Forms**: labels above fields, two columns on a computer, one on a phone, the Save button bottom right, always.
- **Lists**: cards and tables share one look: title, the two facts that matter, status pill, and the action on the right.
- The same rules are then applied to every module, screen by screen, starting with Banquets, Front desk, Restaurant and Accounts.

**Step 3. The 3D map: the right places for food**
- Each outlet is linked to a place on the map from a list (not a code): Sathya Dine → the restaurant, Bar → the bar, Poolside → the pool deck, a cafeteria → its building, lawn service → that lawn. New outlets and new buildings appear in the list at once.
- Open KOTs show as markers above their own outlet, pulsing while cooking and turning red when late; the kitchen label counts all of them and each outlet label counts its own.
- Tapping a marker opens that order.

**Step 4. The 3D map: alive**
- **Day and night by the clock**: dawn and dusk skies, lamps along the roads and paths come on at sunset, lit windows for occupied rooms, the pool shimmering at night. The Night button stays for a preview.
- **Guests moving**: when a guest checks in or out, or security logs a vehicle at the gate, a car drives along the drive to the lobby (or out). Staff on duty already show as dots; they now walk between the places they are assigned.
- **Events with drama**: a booked function puts up a pandal with string lights on its lawn or hall from set-up time; the crowd fills in as the function starts; a definite booking is marked with a short burst of confetti over the venue.
- **The kitchen breathing**: a wisp of smoke from the kitchen while orders are cooking; faster when late.
- **Tour mode**: with no tap for five minutes (or on demand), the camera glides around the resort and a ticker shows today's figures. For the lobby screen and for visitors.
- **Fly to**: tapping any card in a side panel flies the camera to that room, hall or outlet, and tapping a building opens its module at the right place.
- All of it switches off under Eco mode and on slow phones.

**Step 5. Release**
- Checks: all tests, the walk-through test, PGlite and PostgreSQL 16, desktop and phone screenshots of every module.
- Docs, merge, deploy, report.

## What would help from you
- The names of the places where food is served: the cafeterias, lawns and any other outlet, and which building each is in on the map. I will add them as outlets and link them.
- Whether the tour mode is for a lobby or office screen, so it fits that screen size.

## Status (22 Oct 2026)

All five steps are done and on `main`.

| Step | What changed |
|---|---|
| 1. Bugs | Every request to the server gives up after 25 s with a plain message instead of leaving the screen stuck; a tap while the last action is still running says "Still working on the last action…" and the screen shows a moving line; no internet gives a one-line notice. |
| 2. One frame | Top bar: brand · business date and clock · Approvals · God Mode · your name (menu: Night, Eco, Resort tour, Change password, Sign out). Module rail down the left (icons only on narrow desks, a bar along the bottom on a phone). Every screen of every module uses one toolbar: the one or two things done most on the left in green, filters and search in the middle, everything else under **More ▾** with the dangerous ones last in red. Detail pages (an event, an order, a ticket, a purchase order, a payroll run, a room block) show their steps in order, the next one as the button to press. Tab rows wrap on a desk so no tab is hidden. |
| 3. Food places | Each outlet has a place on the map (Restaurant → Menu → Outlets → edit → "Where on the map"). Orders show above their own outlet with a count, open and late; tapping the marker or the place opens those orders. |
| 4. The resort alive | The map follows the Indian clock through dusk into night (lamps, lit windows, water). Check-ins and check-outs send a car down the drive and a walker to reception; gate entries too. Today's functions on a lawn or ground raise a pandal with string lights and a crowd; signing a contract throws confetti. The kitchen smokes while orders are open. Resort tour: an orbiting camera with a ticker of today's numbers, from your menu or after five idle minutes. |
| 5. Release | 433 tests; fresh-install walk-through and the 3D checks on PGlite and PostgreSQL 16; desktop and phone screenshots of all 87 module tabs; merged and deployed. |

Still needed from you: the names of the other food outlets (cafeterias, lawns, pool) and which map place each one is at, and whether the tour is meant for a lobby screen.
