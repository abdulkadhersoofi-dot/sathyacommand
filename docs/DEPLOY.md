# Running the live HMS on Render

The repo produces two things:

| What | Render service | Shows |
|---|---|---|
| The demo you already have | **Static Site** (build `npm ci && npm run build`, publish `dist`) | 3D dashboard on sample data. No server, so no sign-in. |
| The live HMS | **Web Service** + **PostgreSQL** (below) | Sign-in, front desk, invoices, God Mode log, 3D dashboard on real bookings. Same address serves the app and the API. |

## 1. Create the database

1. Render dashboard → **New + → PostgreSQL**.
2. Name `sathya-hms-db`, region **Singapore** (closest to Tamil Nadu), PostgreSQL 16.
3. Choose a paid instance for real guest data (free databases are deleted after a trial period).
4. After it is created, copy the **Internal Database URL**.

## 2. Create the web service

1. **New + → Web Service** → repository `sathyacommand`, branch `main`, region **Singapore**.
2. Settings:

| Field | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm run start -w server` |

3. Environment variables:

| Key | Value |
|---|---|
| `NODE_VERSION` | `22` |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the Internal Database URL from step 1 |
| `MD_MOBILE` | the MD's 10-digit mobile number |
| `OTP_DELIVERY` | `log` (pilot only, see below) |
| `PRINT_AGENT_KEY` | a long random value, shared with the print agent on the edge box ([edge box guide](EDGE.md)); leave unset until printers are installed |

4. Create the service. On first start it creates the tables, loads the placeholder rooms and roles, and gives the MD login the mobile number above.

## 3. First sign-in

1. Open the service's address (`https://<name>.onrender.com`).
2. Enter the MD's mobile number.
3. **Until an SMS provider is connected**, the 6-digit code is written to the service's **Logs** tab (`[sign-in code] +9198•••••001: 123456`). This is why `OTP_DELIVERY=log` is set; remove it once SMS is set up.
4. Scan the QR code with Google Authenticator or Microsoft Authenticator and enter the code it shows. From then on, every MD sign-in needs the SMS code and the authenticator code.
5. Enter the company's legal name, GSTIN, address and PIN code (check-out is blocked until they are set).
6. Load the real room list (`POST /api/rooms/import`, or ask Claude to do it from your list).
7. Add staff logins: `POST /api/users` with name, mobile and role.

## Before real guests

- Connect a DLT-registered SMS provider and remove `OTP_DELIVERY`.
- Choose a GST Suvidha Provider for e-invoicing (IRNs come from a sandbox until then).
- Turn on Render's daily database backups and test a restore.
