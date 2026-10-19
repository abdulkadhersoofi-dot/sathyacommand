# Phase 3 · Restaurant, kitchen & bar

Weeks 13–20 of the [blueprint](../HMS_BLUEPRINT.md). This is the first go-live: front office and all food and beverage outlets move off Champagne together, starting on the 1st of a month so the GST period is clean.

| Step | What | Status |
|---|---|---|
| 3.1 | **Orders and KOT routing (server)**: outlets (Sathya Dine, Room Service, Bar, Poolside), kitchen and bar stations (South Indian, North Indian & Tandoor, Chinese, Desserts, Beverages, Bar), tables; menu items in English and Tamil with diet, Jain and allergen tags; sold-out ("86") switch for the kitchen; menu import for the real menu from Champagne; price changes only by the GM (others go to the approval inbox); orders per table (one open order per table), room service only for checked-in guests, covers, notes, seat and course; items sent as one ticket per station, KOT for kitchens and BOT for the bar, numbered per business day; allergen and Jain alerts on tickets; kitchen screen feed with ticket age and all-day counts; cooking → ready → served, with recall; reprints marked COPY and counted; table moves; cancelling an item after its KOT needs a reason and a manager (directly, or through the approval inbox), and is logged for God Mode; liquor refused until licensed hours are set, outside those hours, and on dry days | Done · 20 tests |
| 3.2 | **Restaurant screens in the app, and editable menus, licences and VAT rates**: a **Restaurant** button opens Orders, Kitchen & bar, Menu and Licences & tax (each shown only to roles that use it). **Orders** (captain tablet): table plan per outlet (free / open / food ready), covers, menu by section with search in English or Tamil, veg / egg / non-veg marks, sold-out dishes greyed, a cart with quantities and kitchen notes, age check before the first liquor item, send to kitchen (one ticket per station), print tickets, reprint (COPY), mark served, move table, cancel an item (manager approval after KOT), takeaway and room-service orders for checked-in guests, running total with GST and TN VAT. **Kitchen & bar**: tickets by station in New / Cooking / Ready with timers (amber at 10, red at 20 minutes), allergen and Jain alerts, start, ready, recall, served, all-day counts, sold-out switches across outlets. **Menu**: add and edit outlets, menu sections, dishes (code, English and Tamil names, price, station, diet, allergens, Jain, liquor class), tables and kitchen / bar stations; retire instead of delete; menu import by pasting rows from Champagne or a spreadsheet; price changes by the F&B manager wait for the GM. **Licences & tax**: licences and permits (FSSAI, FL-3, TN VAT TIN, fire NOC, trade, pollution, lift, music, legal metrology, any other) with number checks, issuing authority, validity, renewal warnings and which bills print them; TN VAT rate per liquor class with effective dates and history (bills on earlier dates keep the old rate; only the MD can backdate), new liquor classes; bar licensed hours and dry days. Restaurant orders now show on the 3D map and the Kitchen panel, and every tablet updates live | Done · 8 API tests + browser run of the full flow |
| 3.3 | F&B billing: GST bill for food and a separate TN VAT bill for liquor with one payment, split and merge, post to room bill, discounts within limits, UPI QR, FSSAI number on bills, reprint alerts | |
| 3.4 | Bar stock: brands, bottle sizes and pegs, open-bottle levels, TASMAC purchases, daily stock register | |
| 3.5 | Recipes and automatic stock deduction (basic) | |
| 3.6 | Printing through the on-site edge box, and ordering while the internet is down | |

## Roles

| Role | Can |
|---|---|
| Captain | open orders, add items, send KOTs, move tables, mark served; ask a manager to cancel a sent item |
| Chef | kitchen screen: cooking, ready, recall; mark items sold out |
| Bartender | bar orders and the bar screen |
| F&B Manager | all of the above, cancel sent items, approve captains' cancellations, edit the menu (price changes go to the GM) |
| Bar Manager | bar orders and screen, cancel sent items, licensed hours and dry days |
| Reception | room-service orders taken by phone |
| Accounts | licences and permits, TN VAT rates and liquor classes |
| GM / MD | everything, including prices, menu import, bar settings and licences (VAT rates: MD and accounts) |

## Waiting on

- **Resort**: the real menu for each outlet (an export from Champagne is enough), table numbers per outlet, which outlets may serve liquor
- **Licence numbers**: FSSAI, FL-3 and the TN VAT registration, with validity dates (enter them under Restaurant → Licences & tax)
- **CA**: TN VAT rates for beer, wine and spirits (enter them under Licences & tax; needed before the liquor bill in 3.3)
