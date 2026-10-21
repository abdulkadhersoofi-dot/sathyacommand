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
3. It asks for **MD_EMAIL** (the MD's email address) and **MD_PASSWORD** (a first password, at least 8 characters; you change it at the first sign-in).
4. Press **Apply**. The first build takes a few minutes. On first start the service creates the tables, loads the placeholder rooms, menus, roles and chart of accounts, and gives the MD login the email and password above.

**Already running the Blueprint from before (with MD_MOBILE)?** Open the **sathya-hms** service → **Environment** → add `MD_EMAIL` and `MD_PASSWORD` → **Save, rebuild and deploy**. `MD_MOBILE` and `OTP_DELIVERY` can stay or go; nothing uses them while SMS sign-in is off.
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
| `MD_EMAIL` | the MD's email address |
| `MD_PASSWORD` | the MD's first password (changed at the first sign-in) |
| `MD_PASSWORD_RESET` | `yes` only if the MD has forgotten the password: the service sets `MD_PASSWORD` again on its next start. **Remove it afterwards**, or every restart resets it |
| `MD_MOBILE` | optional: the MD's mobile, for SMS sign-in later |
| `PRINT_AGENT_KEY` | a long random value, shared with the print agent on the edge box ([edge box guide](EDGE.md)); leave unset until printers are installed |

## 3. First sign-in

1. Open the service's address (`https://<name>.onrender.com`).
2. Enter `MD_EMAIL` and `MD_PASSWORD`.
3. Choose your own password (at least 8 characters). The one in Render's settings stops working, so nobody who can see the settings can sign in as you.
   Once signed in, the **Modules** button in the top bar lists every module your role can open. **Password** in the top bar changes it later.
4. Enter the company's legal name, GSTIN, address and PIN code (check-out is blocked until they are set).
5. Load the real room list (`POST /api/rooms/import`, or ask Claude to do it from your list).
6. Add staff logins: **Staff → Logins → Add login** (name, email, roles). It shows a temporary password once; give it to the person with their email. They choose their own at the first sign-in. **Reset password** there gives a new temporary one to someone who forgot theirs (or got locked out by 5 wrong passwords, which otherwise clears after 15 minutes).

Accounts, HR, stores and the front-office manager can still only sign in from a device the MD or GM has approved (the approval inbox in God Mode).

### SMS codes and the authenticator app (later)

Both are built and switched off in `server/seed/roles-and-approvals.yaml`:

- `mobile_otp: true` turns on sign-in by SMS code (needs a DLT-registered SMS provider, and mobile numbers on the logins).
- `password_second_factor: true` makes the MD, GM, accounts and HR also enter an authenticator-app code after the password.

### The booking page, payments and a channel manager (optional)

The booking page is at `https://<your service>/book`; guests check in online from the link they get after booking. Without any of the settings below it works with guests paying at the resort. Add these on the service's **Environment** page when the resort is ready:

| Setting | What it does |
|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Website bookings take a deposit (the first night with GST) by Razorpay payment link; an unpaid booking lapses after two hours. In Razorpay's dashboard, add a webhook to `https://<your service>/public/payments/webhook` for the event `payment_link.paid`, with the same webhook secret. Try it in Razorpay's test mode first |
| `CHANNEL_KEY` | A long random key shared with the channel manager. It reads availability and rates from `/channel/ari` and sends OTA bookings to `/channel/bookings`, both with the header `X-Channel-Key`. The channel manager's own format is mapped to these by its integration team |
| `PUBLIC_URL` | The address guests should see in their links, if it is not the service's own (e.g. `https://book.sathyaresorts.in`) |

## Before real guests

- Choose a GST Suvidha Provider for e-invoicing (IRNs come from a sandbox until then).
- Turn on Render's daily database backups and test a restore.
