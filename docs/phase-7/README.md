# Phase 7 · Banquets, sales & guest channels

Weeks 35–42 of the [blueprint](../HMS_BLUEPRINT.md). **Done when** a full wedding runs end to end in the system, from enquiry to final bill.

| Step | What | Status |
|---|---|---|
| 7.1 | **Banquets** (top bar → **Banquets**). **Venue calendar**: the halls, lawns, pavilion and grounds down the side, a fortnight across; each function on its venue and day, pencilled (enquiry or quote), on hold or booked; a tap on an empty day takes an enquiry for that venue. Each venue keeps a **turnaround** (setting up and clearing, 3 hours to start) free around every booking. Pencilled enquiries may overlap; only one event can **hold** or **book** a slot, a clash is refused with the other event named. **Events**: an enquiry (kind, client, mobile, company and GSTIN for the bill, how they came, guests, site visit, notes) with one or more **functions** (mehendi, muhurtham, reception…): venue, day and times (past midnight allowed), setup (round tables, theatre, U-shape, classroom, cocktail, buffet), guests expected and guaranteed (refused above the venue's capacity for that setup), a **menu** per plate (with a minimum number of plates) and the venue's **rental** (or a negotiated one); **extras** from the packages (decor) or written in (nadaswaram, cake), each taxed as venue, food or services. **Quotes**: a frozen copy of the lines with the discount, versioned, printable for the client, valid for 15 days; a discount above the sales limit (10%; GM 25%) waits for the GM. **Hold** the dates (sales up to 7 days, GM 21); a hold lapses by itself. **Contract signed** (after the client accepts a quote): the event becomes definite, with an **advance schedule** (25% on signing, 50% a month before, the rest a week before, or one's own) shown paid, part paid, due or overdue. **Payments**: advances on **GST receipt vouchers** (GST spread over the quote's rates: venue and services at 18%, food at the restaurant's 5%; 18% if no quote yet), refunds on refund vouchers; **cash for one event stays under ₹2 lakh in all** (section 269ST counts one event or occasion together, not per day). **Permissions** checklist per event: music licence, police, fire safety, liquor; each applied for, received (with its number) or not needed. **Event order (BEO)**: a frozen revision sent to the kitchen (plates to cook: the guarantee plus 5%, the menu), F&B service, housekeeping (tables and chairs for the setup), engineering, security (parking, about one car per three guests) and front office, with each department's own instructions; it reaches their phones as a staff broadcast, each department **acknowledges** its sheet (only its own), a later change shows "send a revision", and the old revision can no longer be acknowledged. **On the day**: guests served per function; the **final bill** charges plates at the guarantee, or the number served if more (as extra plates), takes in the advances, and is a normal tax invoice (e-invoice when the client has a GSTIN, once the CA gives the hall's SAC); then the balance and the client's **feedback** close the event (a score of 2 or less goes to God Mode at once). **Lost** with the reason and who won it (for the conversion figure); **cancelled** with part of the advance refunded and the rest invoiced as the cancellation charge. **Books**: the banquet ledger (each event its own party), hall rental, banquet food and banquet services revenue in the Banquets department, GST on advances taken back when the bill takes them in; GSTR-1 counts event advances and bills like stays. **3D map**: held and booked functions show on their venue, live while they run. **Venues & packages**: each venue's rental, turnaround and capacity by setup; menus, decor and services (placeholders until the resort's own) | Done · 12 API tests + browser run (enquiry from the calendar, quote, hold, contract, advance with ₹2.5 lakh cash refused, permission, instructions, BEO, the chef acknowledging on a phone, live on the 3D map, guests served, bill, balance, feedback) |
| 7.2 | **Sales CRM and corporate accounts**: accounts with contacts and contracted room rates, follow-ups, pipeline value by stage, lost reasons; event vendors (decorators, DJs, photographers, tent) paid through payables with TDS; wedding **room blocks** linked to the event (rooming list, cut-off, release); an event billed to a company's credit account | Planned |
| 7.3 | **Channel manager, website booking engine and online check-in**: rates and availability out to the OTAs and bookings in, through a channel manager chosen with the resort; a booking page with a payment link; pre-arrival check-in (ID upload, arrival time, preferences) | Planned |
| 7.4 | **Guest journey**: WhatsApp messages (confirmation, directions, pre-arrival, requests during the stay, bill, feedback); a QR in every room (menu and room service, housekeeping requests, information, feedback); reviews with low scores alerted before they reach Google; activities (pool, cricket ground, tours) charged to the room | Planned |

## Roles

| Role | Can |
|---|---|
| Sales & banquets | enquiries, functions, quotes (discount up to 10%), holds (up to 7 days), contracts, payments, the event order, guests served, the bill, cancellations |
| GM | all of the above (discount up to 25%, holds up to 21 days), approves larger discounts, venues and packages |
| Accounts | events (read), payments and refunds, the bill |
| Front office manager | events (read), payments; the front office's event orders |
| Operations manager | events (read), event orders |
| Chef, F&B manager, captain, housekeeping, engineering, security, reception | their department's event orders, and acknowledging them |
| MD | everything |

## Choices to confirm

- **Each line of an event bill at its own rate**: venue rental, decor and services at 18%, food at the restaurant's rate (5% while no room sells above ₹7,500). CA check: whether a hall-with-food package is instead one composite supply taxed at its principal supply's rate.
- **GST on an advance** is spread over the rates of the accepted quote; before any quote, at 18%. CA check
- **What is kept on a cancellation** is invoiced as a cancellation charge at the rates the advances were taxed. CA check
- **Plates**: billed at the guarantee, or the number served if more; the kitchen cooks 5% over the guarantee.
- **Turnaround**: 3 hours kept free around each booking on every venue until the resort sets its own.

## Waiting on

- **CA**: the SAC for hall and lawn rental and for decor and services sold by the resort (e-invoices for companies are held until then), and the three CA checks above
- **Resort / sales**: the real venue list with capacities by setup, rentals and turnaround; the banquet menus with their prices and minimum plates; decor and service packages; the advance schedule and cancellation policy used in contracts
- **Resort**: which music licences (PPL, IPRS, Novex) the resort holds itself, and the police station and fire office for event permissions
