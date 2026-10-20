# Running the live HMS on Render

The repo produces two things:

| What | Render service | Shows |
|---|---|---|
| The demo you already have | **Static Site** (build `npm ci && npm run build`, publish `dist`) | 3D dashboard on sample data and Twin Studio. No server, so no sign-in and **none of the modules**; it says so and points to the live HMS. |
| The live HMS | **Web Service** + **PostgreSQL** (below) | Sign-in, then every module for the person's role: front desk, restaurant & bar, housekeeping, staff, engineering, security, stores & purchase, accounts, God Mode, on the 3D map with real bookings. Same address serves the app and the API. |

**Everything built since Phase 2 is only on the live HMS.** If you open the static demo you will see the 3D map and the layout editor, and a **Where are the modules?** button explaining this.

## 1. Start the live HMS (one click: Blueprint)

The repository has a `render.yaml` that creates both the database and the service.

1. Render dashboard → **New + → Blueprint** → choose the repository `sathyacommand` (branch `main`).
2. Render lists what it will create: **sathya-hms-db** (PostgreSQL 16, Singapore) and **sathya-hms** (web service, Singapore).
3. It asks for **MD_MOBILE**: enter the MD's 10-digit mobile number.
4. Press **Apply**. The first build takes a few minutes. On first start the service creates the tables, loads the placeholder rooms, menus, roles and chart of accounts, and gives the MD login the mobile number above.
5. Every merge into `main` from then on goes live by itself.

The plans in `render.yaml` are paid (an always-on service and a database that is kept). Change `plan` there to `free` only to try it out: a free service sleeps when idle and a free database is deleted after a trial period.

To point the old demo at it: on the **Static Site**, add the environment variable `VITE_LIVE_URL` = the new service's address and redeploy. The demo's **Open the live HMS** button then goes straight there.

## 2. Or create the two by hand

1. **New + → PostgreSQL**: name `sathya-hms-db`, region **Singapore**, PostgreSQL 16, a paid instance. Copy the **Internal Database URL**.
2. **New + → Web Service**: repository `sathyacommand`, branch `main`, region **Singapore**, runtime Node.

| Field | Value |
|---|---|
| Build Command | `npm ci --include=dev && npm run build` (the build tools are dev dependencies, which `npm ci` skips when `NODE_ENV=production`) |
| Start Command | `npm run start -w server` |
| Health Check Path | `/health` |

3. Environment variables:

| Key | Value |
|---|---|
| `NODE_VERSION` | `22` |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the Internal Database URL |
| `MD_MOBILE` | the MD's 10-digit mobile number |
| `OTP_DELIVERY` | `log` (pilot only, see below) |
| `PRINT_AGENT_KEY` | a long random value, shared with the print agent on the edge box ([edge box guide](EDGE.md)); leave unset until printers are installed |

## 3. First sign-in

1. Open the service's address (`https://<name>.onrender.com`).
2. Enter the MD's mobile number.
   Once signed in, the **Modules** button in the top bar lists every module your role can open.
3. **Until an SMS provider is connected**, the 6-digit code is written to the service's **Logs** tab (`[sign-in code] +9198•••••001: 123456`). This is why `OTP_DELIVERY=log` is set; remove it once SMS is set up.
4. Scan the QR code with Google Authenticator or Microsoft Authenticator and enter the code it shows. From then on, every MD sign-in needs the SMS code and the authenticator code.
5. Enter the company's legal name, GSTIN, address and PIN code (check-out is blocked until they are set).
6. Load the real room list (`POST /api/rooms/import`, or ask Claude to do it from your list).
7. Add staff logins: `POST /api/users` with name, mobile and role.

## Before real guests

- Connect a DLT-registered SMS provider and remove `OTP_DELIVERY`.
- Choose a GST Suvidha Provider for e-invoicing (IRNs come from a sandbox until then).
- Turn on Render's daily database backups and test a restore.
