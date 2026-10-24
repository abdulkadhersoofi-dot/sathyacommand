# Booking from the map, the room drawer, and a button strategy for the whole app

Prompted by the MD's review on 24 October 2026. Three problems; work goes in this order and each step is checked in a browser on a computer and a phone before the next.

## What was found

| # | What you saw | Why it happens |
|---|---|---|
| 1 | Book a room from the map and the form shows another room's tariff | The map's "New booking…" opens the desk's general form: it knows nothing about the room you tapped. The room type dropdown starts at the first type in the list, and the booking is for *a* room of that type, not the one you chose. |
| 2 | The room drawer: "Open the booking" is away from the guest in a "Do" row; Housekeeping and Report a fault are grey; the 14-day strip cannot be moved; "Room-service order…" sits among room actions; no way to book the same room for a later date while someone is in it | The drawer grew one section at a time. The strip is fixed at 3 days back and 10 ahead. The actions all look the same because they all use the plain button. "New booking…" only appears when the room is vacant today. |
| 3 | Buttons sit in different places on different screens, in rows with no hierarchy | There was never a written rule. Each module placed its own buttons; some rows carry three or four, some screens have two primaries, some things that open a form look the same as things that act at once, and dangerous actions sit beside everyday ones. |

## The plan

**Step 1. Booking from the map carries the room (fixes 1)**
- Tap a room, tap **New booking**: the form opens *for that room*. It says **Room 207 · Deluxe Room · ₹4,200 a night** at the top, the room type is set to the room's type, and the quote is that room's. A tick-box "Keep this exact room" is on; untick it to let the desk give any room of the type.
- Arrival starts at the **next date the room is free** from the day shown on the map (today if the map is on today), so a booking for a room with a guest in it lands on the first free night.
- The server books and assigns the room in one go, and refuses with a plain sentence if the room is taken on any of those nights.
- A vacant room's drawer and an occupied room's drawer both offer New booking.

**Step 2. The room drawer is rebuilt around the room (fixes 2)**
- **The room's timeline** at the top: a strip of days you can slide with ‹ › or by dragging, from 30 days back to 60 days ahead, with every booking of *this room* as a coloured bar (grey past, blue in-house, teal booked, amber arriving). Tap a day to move the map to it; tap a bar to see that booking in the drawer.
- **The stay box** holds everything about the guest *and* their own buttons: **Open the booking** (primary), **Room-service order**, **Payment** when due. Room-service orders of the day are listed inside the stay box, not as a separate section.
- **Room tiles** below, coloured with an icon, like the housekeeping card: **Housekeeping** (purple when the room needs cleaning, teal when ready), **Report a fault** (orange), **New booking** (green, "from <date>"). A vacant room shows New booking first.
- No more "Do" row, no "Room service" section at the bottom.

**Step 3. One button strategy for the whole app (fixes 3)**
- The rules are written down in `docs/BUTTONS.md` and every screen is made to follow them. The rules, in short:
  1. **One primary per screen**, teal, first on the left of the toolbar. Other everyday actions beside it, plain. Filters after. **More ▾** at the right end holds the rare and the dangerous; dangerous items are red and last, after a line.
  2. **A row or a card carries at most one button: Open.** Everything else is on the thing's own page.
  3. **A detail page** (a booking, an event, an order, a purchase order) has a step row that says where it stands, then one toolbar: the next step is the primary, the rest plain, the dangerous under More ▾.
  4. **The map's drawers**: facts first, then coloured tiles with an icon and two words for what you can do. A stay's own buttons live in the stay box.
  5. **Forms**: Cancel then the primary, bottom right. The primary names the outcome (Book, Check in, Send it back), never OK or Submit. A label that opens another form ends with "…".
  6. **Screens used by hand** (housekeeping, kitchen, waiters, security rounds): big tiles for the thumb, showing only the next thing to do.
  7. **Colour means one thing**: teal = the primary; green = done or ready; blue = start or in progress; amber = attention, hold, do-not-disturb; red = stop, undo, delete; grey = everything else. Plain buttons in one row are all grey.
  8. **Words**: a verb and a thing, one line. Never "Actions…", "Set status…", "Manage".
  9. **Three sizes only**: tile (hand), normal (desk), small (inside a row). Never more than three buttons in a row without a More ▾.
  10. **The same place on every tab** of a module.
- A screen-by-screen audit lists where each screen breaks a rule and what moves; it is done and recorded in `docs/BUTTONS.md`.

**Step 4. Release**
- Checks: tests, a walk-through (book Room 207 from the map for its next free date; slide the room's timeline; the stay box's buttons; the tiles; a sweep of every module's tabs for the rules), PGlite and PostgreSQL 16, screenshots on a computer and a phone.
- Docs, merge, deploy, report.

## Status (24 Oct 2026)

All four steps are done and on `main`.

| Step | What changed |
|---|---|
| 1. Booking from the map | Tap a room, tap **New booking**: the form is pinned to that room (Room 207 · Deluxe Room · ₹4,200 a night), "Keep this exact room" is ticked, the arrival starts on the room's next free night, and the server assigns the room in the same step (refusing with "Room 207 is already booked on some of these nights" when it is taken). Offered for vacant and occupied rooms alike. |
| 2. The room drawer | The room's bookings on a strip you slide with ‹ › or by dragging, across the map's whole window; tap a day to move the map there, tap a bar to see that booking. The stay box carries **Open the booking**, **Check in…**, **Room-service order…**, **Payment…** and the day's room-service orders. Below, tiles: **Housekeeping** (purple when dirty, amber under do-not-disturb, teal when ready), **Report a fault**, **New booking** (from the next free night). The "Do" row and the "Room service" section are gone. |
| 3. Button strategy | The ten rules and the pieces that enforce them are in `docs/BUTTONS.md`, with a screen-by-screen audit of what moved: red "are you sure" with a named way out for everything that removes or undoes (fourteen places that deleted at once now ask); rows with three or four buttons reduced to one plus a ⋯ menu (indents, bank lines, the housekeeping card); uploads and form submits moved into the primary slot; page-form saves made the primary at the bottom right; green row buttons made plain across Stores, Accounts, Banquets, Guests, People, Security and Housekeeping; labels fixed ("Open the room…", "Check out…"); the kitchen's next step coloured on every ticket; the emergency banner matching its tab. |
| 4. Release | 445 tests (one new: booking an exact room, and the refusal when it is taken). The walk-through on PGlite and PostgreSQL 16: Room 207 occupied, the drawer's strip, stay box and tiles; sliding and dragging the strip; New booking from the room landing on the next free night; the housekeeping card's More ▾; a sweep of the changed screens. Desktop and phone screenshots. |
