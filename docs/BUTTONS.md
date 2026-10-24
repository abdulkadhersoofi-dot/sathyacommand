# Buttons: where they go and what they look like

The one rulebook for every button in Sathya Command. A screen that breaks a rule is a bug. Written on 24 October 2026 after the MD's review; the audit at the end says what each screen looked like and what moved.

## The ten rules

1. **One primary per screen.** The thing the screen is for is the one teal button, first on the left of the toolbar (`toolbar({ primary })`). One more everyday action may sit beside it, plain. Filters and search come after. Everything else goes under a single **More ▾** at the right end, with the dangerous items last, in red, after a line.
2. **A row or a card carries one button.** Usually **Open**; sometimes the row's own next step (Approve, Delivered). Anything else a row can do goes in its **⋯** menu (`rowMenu`). Row buttons are small and plain: the colour belongs to the screen's primary, not to forty rows.
3. **A detail page** (a booking, an event, an order, a purchase order, a payroll run) opens with its **step row** saying where it stands, then **one toolbar**: the next step is the primary, the rest plain, the dangerous under More ▾. The same step may appear in the row and as the button; that is on purpose.
4. **The map's drawers** show facts first, then **tiles**: a picture, two words, one colour each (`tile()` in `src/ui/tiles.ts`). A stay's own buttons live inside the stay box, not in a general row.
5. **Forms** end with the way out, then the deed, bottom right: *Cancel* · **Book**. The deed names the outcome (Book, Check in, Send it back, Save hours), never OK or Submit. A label that opens another form ends with "…". A page-form (a settings form, meter readings) keeps its Save as the primary at its bottom right.
6. **Hand-held screens** (housekeeping, kitchen, waiters, security rounds, the staff app) use tiles or big buttons for the thumb and show only the next thing to do.
7. **Colour means one thing.** Teal: the primary. Green: done or ready. Blue: start, in progress. Amber: attention, hold, do-not-disturb. Red: stop, undo, remove, cancel. Grey: everything else. A row of plain buttons is all grey.
8. **Words.** A verb and a thing, one line: "Report a fault…", "Add dry day". Never "Actions…", "Set status…", "Manage", "Room…".
9. **Three sizes.** Tile (hand), normal (desk toolbars and forms), small (inside rows). Never more than three buttons side by side without a More ▾ or ⋯.
10. **The same place on every tab.** One module, one toolbar position; a tab with nothing to add has no toolbar rather than an odd one.

Undoing or removing something always asks first, in red, with the deed as the button and a named way out: **Remove the function** · *Keep it* (`confirmDanger`). Two "Cancel" buttons never sit side by side: the way out of "Cancel the order?" is **Keep the order**.

## The pieces

| Piece | Where | Use |
|---|---|---|
| `toolbar({ primary, filters, more, end })` | `src/ui/toolbar.ts` | Every screen's one toolbar. `primary: false` on an item makes it the plain second button. An item with `file:` is an upload; with `form:` it submits a form it sits outside of. |
| `rowMenu(items, label?, cls?)` | `src/ui/toolbar.ts` | A row's ⋯ (or a card's "More ▾"), dangerous items last in red. |
| `steps([...])` | `src/ui/toolbar.ts` | A detail page's step row. |
| `tile(attrs, icon, label, sub, tone)` | `src/ui/tiles.ts` | Hand screens and drawers. |
| `FormModal.open(..., { danger, cancelLabel, extra })` | `src/ui/form-modal.ts` | A red deed and a named way out. |
| `confirmDanger(modal, question, why, deed, go, keep?)` | `src/ui/form-modal.ts` | Ask before removing or undoing. |
| `.btn`, `.btn.primary`, `.btn.danger`, `.btn.small`, `.btn.ghost`, `.actions.end` | `src/style.css` | The three sizes and the colours. |

## The audit (24 Oct 2026)

What was found in each place and what moved. "ok" means the screen already followed the rules.

| Screen | Found | Now |
|---|---|---|
| Map · room drawer | "Do" row of four equal buttons; the stay's buttons away from the guest; grey Housekeeping / Report a fault; a fixed 14-day strip; no New booking while occupied | The room's bookings on a slidable strip; the stay box carries Open the booking · Room-service order · Check in · Payment and the day's orders; tiles for Housekeeping (coloured by state), Report a fault, New booking (from the next free night) |
| Map · New booking from a room | The desk's general form, first room type selected | Pinned to the room: its type and tariff, "Keep this exact room", arrival on the room's next free night; the server assigns the room |
| Housekeeping · room card | 1–3 tiles then six plain buttons in a row, More ▾ for managers only | Tiles, then at most three small buttons (Minibar, Laundry, Found an item); **More ▾** for everyone: Report a fault, the empty / guest checks, and for managers Add a task, Change the status, Out of order (red) |
| Housekeeping · My rooms | "Room…" | "Open the room…" |
| Housekeeping · Laundry | Two green toolbars; green Delivered per row | One primary (Add laundry item), Add minibar item plain; Delivered plain |
| Housekeeping · Assign & inspect | Green Inspect per row | Plain |
| Restaurant · Kitchen & bar | Start plain but Ready green | Each ticket's next step is the coloured one: Start, Ready, Served |
| Restaurant · order cancel | "Cancel order" green beside "Cancel" | Red **Cancel order** · *Keep the order* |
| Stores · Indents | Four buttons per row, Cancel immediate | Approve (plain) + Issue from stock…; Turn down… and Cancel the indent… under ⋯; cancelling asks first |
| Stores · Market list | The primary in the toolbar's end slot | In the primary slot (submits the form) |
| Stores · Month close | A full-size green Close per store card | Small, plain |
| Stores · Bills / Payments | Green Pass… / Pay… / Mark paid… per row; "Cancel bill" green | Plain; cancelling is red with *Keep the bill* |
| Stores · Purchase orders | "Cancel order" green beside "Cancel" | Red with *Keep the order* |
| Stores · Bar stock | Report breakage was the primary on one sub-tab and in More on the others | Always under More ▾ |
| Accounts · Banks | Import as a green label in the filters; Match… / Post… / Leave out… per line; Unmatch immediate | Import is the primary; Post… plus a ⋯ with Match to a voucher… and Leave the line out…; Unmatch asks first |
| Accounts · OTAs, Tax credits | Upload as a green label in the filters | The primary |
| Accounts · TDS | Green Deposited… per month | Plain |
| Banquets · Event | Function, extra and supplier Remove deleted at once; "Cancel event" green beside "Cancel"; Lost without a way out | Each Remove asks first in red; cancel is red with *Keep the event*; lost is red with *Not lost yet* |
| Banquets · Accounts | Contact and rate Remove deleted at once | Ask first |
| Banquets · Rates & channels | "Map a room code" in a heading; code Remove immediate; green Resolved… | Map a room code… under More ▾; Remove asks first; Resolved… plain |
| Banquets · Venues & packages | "Add" inside a heading | A toolbar with Add a menu or package |
| Banquets · Venue calendar | Full-size ◀ Week / Week ▶ | Small |
| Banquets · Sales | Mine / Everyone's chips inside a heading | In the toolbar's filters |
| Banquets · Event orders | Green Acknowledge per row | Plain |
| Guests · Requests | Cancel immediate; green On it / Done per row | Cancel asks first; row buttons plain |
| Guests · Messages | Green WhatsApp link per row | Plain |
| Guests · Activities | Green Book on every row | Plain "Book…" |
| People · Leave, Payroll | Green Approve / Paid… per row | Plain |
| People · Holidays | Remove immediate | Asks first |
| Staff app · My leave | Cancel immediate | "Withdraw this leave?" asks first |
| Staff app · My pay | Toolbar at the bottom | At the top |
| Staff app · Settings | "Save" | "Save the settings", bottom right |
| Security · Cameras | Green Live view per row | Plain |
| Security · Emergency banner | I am safe / I need help plain, unlike the tab | Teal and red, like the tab |
| Engineering · Meters | Save readings at the left | Bottom right |
| Settings · Resort profile | Old toolbar class at the bottom | The form's primary, bottom right |
| Settings · Licences & tax | Three green section toolbars; "Save hours" and "Save" plain; dry-day Remove immediate | One primary (Add licence), the other adders plain; the saves are the primaries of their forms; Remove asks first |
| Restaurant · Menu · printers | "Save routing" plain | Primary, bottom right |
| Front desk · Due out | "Check out" that only opens the booking | "Check out…" |
| Approvals inbox | Green Approve per item | Plain |
| Everything else (Eng tickets, Assets, Patrols, Gate, Keys, Stock, Items, Vendors, Chart, GST, Rosters, Logins, Getting started…) | ok | ok |
