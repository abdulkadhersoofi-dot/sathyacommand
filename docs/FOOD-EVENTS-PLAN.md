# Food and events plan

Prompted by the MD's review of the live site on 22 October 2026: ordering food is two layers deep, new restaurants cannot be added, pool orders land on the pool house, booking an event is hard, the Pavilion shows no event, and a venue with two functions on one day shows only one. Work goes in this order; each step is checked in a browser on a computer and a phone before the next.

## What was found

| # | What you saw | Why it happens |
|---|---|---|
| 1 | Ordering is two layers deep | Orders → pick an outlet → pick a table → the order → pick a section → the dish. Every outlet is its own island with its own tables and its own menu, so the captain must choose the island first. |
| 2 | New restaurants cannot be added; the Grand Lawn cannot take food orders | An outlet can be added, but only under Menu → Outlets, only of five fixed kinds, and it starts with **no dishes**: every outlet has its own menu, so a lawn or cafeteria would need the whole menu typed in again. Nobody can get past that. |
| 3 | Pool orders point to the pool house | The pool deck and the pool house are both "Pool & Deck" on the map. Labels are given to buildings first, so the pool's label (and the order count on it) sits on the pool house. The order marker itself is already over the deck. |
| 4 | The Pavilion shows no event though one is booked | The map draws only **held and signed** bookings. An event that is still an enquiry or a quote (not yet held or signed) is left off, with nothing to say so. The Pavilion booking is most likely one of these. |
| 5 | Two functions on one venue on one day: only one shows | The map keeps the first function of the day for each venue and drops the rest. |
| 6 | Booking an event is hard | One long form of 25 fields. The venue is checked only when you press Save, so a clash comes back as an error after everything is typed, with no alternative offered. There is no way to start from the map. |
| 7 | Licences & tax sit in the Restaurant module | They were built with the bar (liquor rates, dry days), but they are resort-wide settings, not a restaurant screen. |

## The plan

**Step 1. Food places: any place on the map can serve food (fixes 2 and 3)**
- "Outlets" become **Food places**. A food place is a name, a place on the map (any lawn, ground, hall, pool, building), tables if it has them, and **whose menu it serves**: its own, or the menu of another place (the Grand Lawn serves Sathya Dine's menu). Kitchen tickets still go to the stations the dishes are cooked at.
- Adding one takes one small form, reached from three places: Restaurant → Orders → **More ▾ → Add a food place**; the Menu tab; and the 3D map: tap a lawn, ground, hall or the pool → **Serve food here**. The form offers "Tables: 12 of 4 seats, labelled G1…" so the tables are made at once.
- A food place can be closed for the day (an event on the lawn) and reopened, without losing its tables or menu.
- Pool orders: the pool's label and counts go on the pool deck, never the pool house.

**Step 2. One-screen ordering (fixes 1)**
- The Orders screen shows **every table of every food place on one page**, grouped by place, with a search box for a table, room or guest. The place chips only filter. Room-service and takeaway orders are listed below the tables. One tap on a table opens its order.
- The order screen shows the **whole menu on one scrolling page** with section headings and a search box; the section chips just jump. One tap adds a dish; "Send to kitchen" stays as the single green button.
- **New order** asks one question: where? (a table, a room, takeaway) and opens the order.

**Step 3. Events on the map (fixes 4 and 5)**
- Every function of the day shows on its venue: the label lists them in time order ("06:00 Muhurtham · 12:00 Lunch · 18:00 Reception"), the one happening now in bold. The outline says what it is: grey dashed for an enquiry or quote (pencilled), amber for a hold, green for signed.
- The pandal, lights and crowd follow the function that is live or next.
- Tapping a venue lists its day: each function with its client, time and guests, and **Open** to the event page; **Book this venue** opens the booking sheet with the venue and the day filled in; **Serve food here** when the place has no food place yet.

**Step 4. Booking an event in three short steps (fixes 6)**
- One sheet, three steps, with a progress row at the top:
  1. **Who**: client's name, mobile, the kind of event (Wedding, Reception, Engagement, Birthday, Corporate, Other), how they came.
  2. **Where and when**: the venue (tiles with capacity, pre-filled when you come from the map or the calendar), the day, a time slot (Morning 6–11 · Afternoon 12–16 · Evening 18–23 · Full day · or your own times), guests, setup. The sheet checks the venue **as you fill it in**: "Free" in green, or "Booked 18:00–23:00 for Meenakshi wedding; free until 16:00" with the other venues that are free that day. A second function (the muhurtham that morning) is one tap away.
  3. **Confirm**: the menu (price a plate, optional), the estimate, and one choice: **Book now** (contract signed) · **Hold the dates** · **Just an enquiry**. Advance received now, if any.
- Reached from Banquets → Events, the venue calendar (tap an empty day), and the 3D map (tap a venue → Book this venue).
- Everything after that (quote, event order, bill) stays on the event page's step row.

**Step 5. Licences & tax move to Settings (fixes 7)**
- Settings gets a **Licences & tax** tab (licences and permits, TN VAT rates, bar hours and dry days, UPI and service charge). The people who could edit them before (accounts, the bar manager, the F&B manager) can open Settings for that tab only; the rest of Settings stays with the MD. The Restaurant module loses the tab.

**Step 6. Release**
- Checks: all tests, the ordering and booking walk-throughs, PGlite and PostgreSQL 16, desktop and phone screenshots.
- Docs, merge, deploy, report.

## What would help from you
- The names of your food places and where each is: the cafeterias, the lawns that serve food, the pool. I will set them up as food places on the right spots once they exist (you can also add them yourself from the map after step 1).
- The status of the Pavilion event you expected to see (enquiry, quoted, on hold or signed), so I can confirm step 3 covers it.

## Status (22 Oct 2026)

All six steps are done and on `main`.

| Step | What changed |
|---|---|
| 1. Food places | Restaurant → Orders → **More ▾ → Add a food place** (also Menu → Food places, and **Serve food here…** on any lawn, hall, ground, the pool or the restaurant on the map). One form: name, where on the map, what it is (restaurant, café, bar, poolside, lawn or ground, room service, banquet), the menu it serves (its own or another place's), tables made at once (how many, seats, labels), liquor. A place can be closed for the day and reopened. The pool's counts sit on the pool deck. |
| 2. One-screen ordering | Orders shows every place's tables on one page grouped by place, with a search for a table, room or guest; the place chips filter; room-service and takeaway orders below. **New order** asks only where. The order screen shows the whole menu with section headings; the chips jump, the search narrows. |
| 3. Events on the map | Every function of the day on its venue in time order, the live one in bold; pencilled enquiries and quotes in grey dashes, holds in amber, signed bookings in marigold. The pandal, lights and crowd follow the live or next firm function. Tap a venue: each function with its status and **Open the event**, **Book this venue**, and the food action. |
| 4. Booking | **Book an event** is one sheet in three steps: Who · Where and when · Confirm. The venue is checked as the fields change; a clash names who has it and when and offers the other venues of that size that are free, one tap each. Reached from Events, the venue calendar and the map. |
| 5. Licences & tax | Under Settings → Licences & tax. Accounts, the bar manager and the F&B manager open Settings for that tab only. |
| 6. Release | 438 tests (5 new for food places); the ordering, booking, map and settings walk-throughs on PGlite and PostgreSQL 16; desktop and phone screenshots. |

Still needed from you: the names of your food places and where each one is, and the status of the Pavilion event you expected (an enquiry or quote now shows as pencilled; if it still does not show, send me its number).
