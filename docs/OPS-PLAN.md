# Operations plan: kitchen sync, settings, restaurant screens, the map as the desk, logins

Prompted by the MD's review on 22 October 2026. Work goes in this order; each step is checked in a browser on a computer and a phone before the next.

## What was found

| # | What you saw | Why it happens |
|---|---|---|
| 1 | The kitchen shows nothing pending, the front desk panel still shows pending items | Two things. The desk's Kitchen tab lists **orders** in New / Cooking / "Ready to send", and an order stays "ready" until the waiter marks it served, so the kitchen's board is empty while the desk still shows it. And the live feed to the desk reconnects after a dropped connection (Render sleeps, Wi-Fi blips) but does not catch up on what it missed, so the desk can show a stale state until something else changes. |
| 2 | Getting started cannot be changed once set | A finished item shows "Done" and nothing else; only unfinished items have a button. There is no way back to the screen from the checklist. |
| 3 | The restaurant screens are cluttered and vague | Bar stock and Kitchen stock are stock screens living in the restaurant module. The place filter is a row of chips that grows with every food place. Room service is a list of open orders, not the rooms themselves, so an order for a room starts from a separate form. The kitchen's stations are chips too, one at a time. |
| 4 | The map does not lead to the work | Tapping a room shows facts and a few buttons; tapping a restaurant shows its orders, not a way to take one. There is no waiter on the map: an order is an arc of light, food ready is a dot for rooms only. |
| 5 | Sub-logins | The roles exist (captain, chef, bartender, reception, room attendant, housekeeping supervisor, engineering, security, stores, accounts, HR…), each with its own permissions, but the Add a login form lists bare names with no word on what each one can do, and nothing shows the MD what a role sees. Reception also carries `fnb.bill`, which lets the desk take cash for restaurant bills. |

## The plan

**Step 1. The kitchen and the desk agree (fixes 1)**
- The desk's Kitchen tab uses the kitchen's own words and columns: **New · Cooking · Ready (waiting for the waiter)**; a served order leaves the tab. Each card says which station's ticket is where.
- When the live feed reconnects, the desk reloads everything it may have missed; and while the day is live, orders are refreshed every minute regardless.
- The kitchen screen, when filtered to one station, says how many tickets are waiting at the others.

**Step 2. Getting started, editable (fixes 2)**
- Every item has a button: **Set up** when not done, **Change** when done; both open the right screen. The list re-checks itself when you come back.

**Step 3. Restaurant screens (fixes 3)**
- **Bar stock** and **Kitchen stock** move to **Stores** (the stores module), as two tabs. The restaurant module keeps Orders, Kitchen & bar and Menu.
- **Orders**: the place filter is a dropdown ("All places ▾"); under each place's tables, **Room service** lists the occupied rooms as tiles (room number and guest) so a room-service order starts with one tap, like a table.
- **Kitchen & bar**: the station filter is a dropdown with tick-boxes; tick two or three stations and each gets its own row (New · Cooking · Ready), oldest first; "All stations" stays one board in time order.

**Step 4. The map leads to the work (fixes 4)**
- Tap a **room**: one **Do** row with everything for that room: Open the booking, Room-service order, Laundry pickup, Housekeeping, Report a fault, New booking (when vacant). Tap a **restaurant, bar, lawn café or the pool**: Food orders at that place (its own tables) or Serve food here. Tap a **venue**: Book this venue, Open the event. All of it opens the right module at the right place.
- **A waiter on the map**: when an order is sent, a figure walks from the place (or the room's wing) to the kitchen with the ticket; when the kitchen marks it ready, a figure walks from the kitchen back to the table or the room with the food. Rooms and restaurants alike.

**Step 5. Logins that see only their work (fixes 5)**
- **Add a login** groups the roles by department with one line each on what the role can do (a chef: the kitchen screen and kitchen stock; a captain: orders and bills; reception: the desk, room-service orders, charging restaurant bills to rooms…).
- Reception loses `fnb.bill` (it can still charge a restaurant bill to a room; taking cash for one is the restaurant's job).
- A role-by-role check: every role is signed in and what it sees (modules and tabs) is recorded in `docs/ROLES.md`, so the MD can see at a glance that a kitchen login sees the kitchen and nothing else. Anything a role sees that it should not is fixed.

**Step 6. Release**
- Checks: tests, the walk-throughs, PGlite and PostgreSQL 16, desktop and phone screenshots.
- Docs, merge, deploy, report.

## Status (22 Oct 2026)

All six steps are done and on `main`.

| Step | What changed |
|---|---|
| 1. Kitchen and desk | The desk's Kitchen tab has the kitchen's columns (New · Cooking · Ready, waiting for the waiter) and says why an order sits where it does. After a dropped connection the live feed reloads everything; the day's orders are fetched again every minute regardless. The kitchen screen says how many tickets wait at the stations not shown. |
| 2. Getting started | A finished item keeps a **Change** button to its screen. |
| 3. Restaurant screens | Bar stock and Kitchen stock are under **Stores**. Orders: the place filter is a dropdown; occupied rooms are tiles under Room service, one tap to start or open the room's order. Kitchen & bar: a station picker of tick-boxes; each ticked station gets its own row. |
| 4. The map | Tap a room: **Do** — Open the booking, Room-service order, Housekeeping & laundry, Report a fault, New booking. Tap a food place: its own tables. Tap a venue: Book this venue. A waiter walks from the table or wing to the kitchen when an order is sent, and back with the tray when the food is ready. |
| 5. Logins | Add a login groups the roles by department with one line on what each sees and may do. Reception no longer carries `fnb.bill`. Roles follow the file on every start. Every role was signed in and what it sees is recorded in `docs/ROLES.md`. |
| 6. Release | 443 tests; the walk-through (settings, orders with room tiles, kitchen lanes, stores tabs, the room's Do row, a room-service order from the map, the role picker) on PGlite and PostgreSQL 16; desktop screenshots. |
