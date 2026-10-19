# Edge box: kitchen printers and working through internet cuts

The resort runs on the HMS server (cloud, see [DEPLOY.md](DEPLOY.md)). A small computer on the resort's own
network, the **edge box**, connects the kitchen, bar and bill printers, and can carry the restaurant when
the internet line is down.

## What you need

- A small always-on PC or mini-PC (4 GB RAM is plenty) on the resort LAN, with Node.js 22, on a UPS.
- Thermal printers (80 mm or 58 mm) with a network port, each with a **fixed IP address** (set it in the
  router's DHCP reservations), listening on port 9100 (the usual default).
- The tablets and the edge box on the same Wi-Fi / LAN.

## 1. Printers in the app

Restaurant → Menu → **Printers**: add each printer by name and IP address, print a test page, then choose
which printer gets each kitchen or bar station's tickets and each outlet's bills. Stations without a
printer show their tickets on the kitchen screens only.

## 2. The print agent

On the HMS server set an environment variable `PRINT_AGENT_KEY` to a long random value (Render →
Environment). On the edge box:

```bash
git clone https://github.com/abdulkadhersoofi-dot/sathyacommand && cd sathyacommand && npm ci
SERVER_URL=https://<your-hms-address> PRINT_AGENT_KEY=<same value> npm run print-agent -w server
```

Run it as a service so it starts with the box (for example with `pm2 start "npm run print-agent -w server"`
and `pm2 save`). Every two seconds it collects waiting tickets and bills and sends them to the printers.
If a printer is off or out of paper the job is tried again; after five failures it is marked failed,
shown under Printers with a Retry button, and flagged to the MD in God Mode.

## 3. When the connection drops

- Captain tablets keep the menu, tables and open orders they last saw.
- New orders, items and KOTs taken while offline wait on the tablet (a yellow strip shows how many) and
  go to the HMS by themselves, in order, as soon as the connection is back. Each carries a one-time key,
  so nothing is ever taken twice even if the tablet sends it again.
- Billing and payments need the connection (tax invoice numbers must be issued in sequence by the HMS).

## 4. Running the whole HMS on the edge box (internet-proof)

For the restaurant to keep printing KOTs while the internet line is down, run the HMS itself on the edge
box with a local PostgreSQL database, and point the tablets at the box's LAN address:

```bash
DATABASE_URL=postgres://sathya:<password>@localhost/sathya PORT=8080 MD_MOBILE=<MD mobile> \
PRINT_AGENT_KEY=<key> npm run start -w server
```

Then `SERVER_URL=http://localhost:8080` for the print agent. Take a nightly database backup to the cloud
(`pg_dump`) and keep the box on a UPS. Phase 10 adds live replication from the box to the cloud copy.
