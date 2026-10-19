# Sathya Command — Phase 1

Animated 3D command center for Sathya Park & Resorts. The main screen is a digital twin of the
resort (traced from the satellite image) with live room status, check-ins, kitchen orders (KOTs) and
events. Phase 1 runs on a deterministic sample HMS so it works before any integration exists.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN for tablets)
npm run build      # production bundle in dist/ (~160 KB gzipped incl. Three.js)
npm run artifact   # single hosted page in dist-artifact/
```

## How it fits together

| Path | What it is |
|---|---|
| `src/data/types.ts` | Normalised domain model (Space, Reservation, Order/KOT, EventBooking, Housekeeping) |
| `src/data/adapters/HmsAdapter.ts` | The one interface the app depends on |
| `src/data/adapters/mock.ts` | Sample HMS: ~90 days of bookings, events, KOTs, plus a live event simulator |
| `src/data/adapters/http.ts` | Resort Gateway adapter (REST + Server-Sent Events) for Phase 2 |
| `src/data/registry.ts` | Site registry: footprints traced from the satellite image ↔ twin ids ↔ HMS room numbers |
| `src/data/store.ts` | Derived state: room status per date, KPIs, feed, audit log |
| `src/scene/` | Three.js twin: `Site` (terrain, trees, buildings), `Rooms` (Park Wing + villas), `Overlays` (events, KOT arcs, guest motion, labels), `World` (camera, picking, render-on-demand) |
| `src/ui/` | Hover/tap card, detail drawer, side rail, KPI dock and date scrubber |

To switch to live data, build with `VITE_GATEWAY_URL=https://gateway.example/api`.

## Things to confirm on site (marked "verify" in the registry)

Room count and numbering in the Park Wing (assumed 3 floors × 12), number of villas (assumed 6),
restaurant and kitchen location, use of the south-west white-roof building, hall and lawn capacities.

## Plans & Phase 0

- [HMS Blueprint](docs/HMS_BLUEPRINT.md): full phased plan for the hotel management system ([formatted HTML](docs/hms-blueprint.html))
- [Phase 0 workspace](docs/phase-0/README.md): owner intake, department workshops, tax pack for the CA, roles and limits, licence register, site survey, Tamil glossary
- [Phase 2 progress](docs/phase-2/README.md): tax engine (`packages/tax`), God Mode log (`packages/audit`) and API server with database (`server/`); run `npm test`
