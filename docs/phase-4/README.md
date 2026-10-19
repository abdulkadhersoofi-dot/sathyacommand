# Phase 4 · Housekeeping, staff app, GPS, engineering & security

Weeks 19–26 of the [blueprint](../HMS_BLUEPRINT.md). **Done when** every room's status and every on-duty employee is live on the 3D map.

| Step | What | Status |
|---|---|---|
| 4.1 | **Housekeeping core (server)**: every room's housekeeping status (vacant clean, inspected, vacant dirty, occupied clean / dirty, out of order, out of service) with do-not-disturb and sections by building and floor; check-out makes the room dirty with a check-out clean, check-in makes it occupied (refused if out of order, warned if not yet cleaned), room moves dirty the old room, the night audit turns occupied rooms into stay-overs (do-not-disturb resets, ended out-of-order periods come back dirty); tasks with workload credits (check-out 2, stay-over 1, deep clean 4…) shared out by section and workload, reassign and rebalance; attendants start and finish their own rooms with a checklist, a note for anything not done, photos and a timer; do-not-disturb blocks starting; supervisor inspection with a score (pass at 80, someone other than the cleaner), failures go back for re-cleaning, a pass makes the room ready and reception is told; out of order with reason and dates removes the room from availability and assignment (refused while a guest is in or booked); return to service; sleeper / skipper check of what housekeeping saw against reception, flagged to God Mode; minibar items and charges to the guest's bill with GST; lost & found linked to the last guest, returned (who collected) or disposed (manager); photo uploads | Done · 11 tests |
| 4.2 | **Housekeeping screens and live status**: a Housekeeping button opens the room board (every room by section with its status, do-not-disturb, arrivals and departures, the day's task and attendant, and sleeper / skipper alerts; filters for dirty, ready, occupied, out of order, DND and needs attention) with each room's actions by role; the attendant's phone screen (my rooms in order with credits, start, tick the checklist, camera photos, note, finish; works offline and syncs); assign & inspect (who is on duty, assign or rebalance, reassign, inspection with photos and score); public-area rounds recorded by scanning the QR code in each area (camera or typed code), printable QR labels, overdue areas; guest laundry collected from the room and charged with GST on delivery (express +50%), laundry and minibar price lists; linen against par (in rooms, shelf, laundry, owned vs needed, losses) with every movement; lost & found with photos, the last guest's contact and hand-over; room status colours on the 3D housekeeping layer for every role, a Housekeeping… button in the room panel, and "room ready" in the live feed | Done · 5 API tests + browser run (attendant on a phone, supervisor inspection, 3D layer) |
| 4.3 | Staff app: geofenced attendance, shifts, task inbox, SOS, broadcasts, Tamil; on-duty location and the live staff layer | |
| 4.4 | Engineering: assets on the 3D map, preventive maintenance, fault tickets with escalation, meters and utilities, pool / STP / fire logs, compliance calendar | |
| 4.5 | Security: gate register, vehicle tags, QR patrols, incidents, CCTV pins, key register, emergency roll-call | |

## Roles

| Role | Can |
|---|---|
| Room attendant | own rooms: start, checklist, photos, finish; do-not-disturb; minibar; report what is in the room; log lost & found |
| Housekeeping supervisor | all of the above, inspect and score |
| Executive housekeeper | everything in housekeeping: assign, out of order, room status, minibar list, dispose of lost & found |
| Reception / front office manager | room board, do-not-disturb, minibar, lost & found returns |
| Operations manager, GM, MD | everything |

## Waiting on

- **Resort**: housekeeping sections (which rooms each attendant normally covers), the minibar list and prices, laundry prices, linen pieces per room, the public areas and how often each is cleaned (then print and fix the QR labels)
- **CA**: GST rate and HSN / SAC for minibar items (set per item in the app; 18% until confirmed)
