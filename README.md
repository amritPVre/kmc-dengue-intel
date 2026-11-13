# KMC Dengue Intelligence — MVP

AI-assisted dengue prevention, early detection and outbreak management for the **Kolkata Municipal Corporation (KMC)**: 16 boroughs, 144 wards today, ready for the 209-ward delimitation.

One platform for KMC HQ, borough health officers, ward health officers, field vector-control teams, labs and councillors. It brings case reports, larval surveys, breeding sites, weather and field action into a single ward-level risk picture, forecasts risk 2–4 weeks ahead, raises alerts, and tracks the response until it is verified.

> **Demo mode.** With no Supabase keys the app runs entirely in the browser on a **synthetic** dataset shaped like Kolkata's monsoon-driven dengue season. None of it is real KMC data.

## What it does

| Area | What users get |
| --- | --- |
| City overview (HQ) | Weekly cases vs last year with rainfall, high-risk wards, active alerts, overdue tasks, city Breteau Index, ward choropleth (risk, cases, Breteau, forecast), borough ranking |
| Borough view | Borough KPIs, ward map and sortable ward ranking, borough epi curve, open alerts, task on-time rate |
| Ward view | Risk score with an explanation of its drivers, 4-week forecast with a 90% band, larval index trend, case and breeding-site map with cluster rings, playbook actions, tasks, anonymised case line list |
| Alerts | Four signal types (case cluster, cases above expected, high larval density, high predicted risk); one click assigns the playbook's field tasks with deadlines |
| Field operations | Task board (Open → In progress → Done → Verified) with overdue flags; mobile "today's work" view for field teams; larval survey form with live HI/CI/BI; breeding-site report with photo |
| Case reporting | Form and CSV bulk upload for KMC labs, private labs and hospitals; ward found from location; hashed duplicate check |
| Citizen reports | Intake list (stagnant water, garbage, fever clusters) → field task |
| Situation report | Auto-written report for the user's area, ready to paste into email or WhatsApp, plus print |
| Settings & model | Alert thresholds, model weights (transparent), geography versions, integrations, data-protection notes |

### Roles and scope

| Role | Sees | Can do |
| --- | --- | --- |
| KMC HQ (Health Dept) | All 144 wards | Everything, including thresholds |
| Borough Executive Health Officer | Wards in their borough | Alerts, tasks, surveys, cases, citizen reports |
| Ward Health Officer | Their ward | Same, for the ward; verifies field work |
| Field vector-control team | Their ward's tasks | Start / complete tasks, log surveys and sites |
| Councillor | Their ward, aggregates only | View risk, trends, alerts, reports (no case line list) |
| Lab / hospital reporter | Only their own submissions | Report cases for any ward |

In demo mode a role switcher in the header simulates each role. With Supabase, the role comes from the signed-in user's profile and **row-level security** enforces it in the database.

## How the analytics work

All logic lives in one dependency-free file, `supabase/functions/_shared/risk-engine.ts`, used by the browser and the nightly server job alike.

1. **Risk score (0–100)** — a logistic model over ten factors: recent incidence per 10,000, case trend, cases in neighbouring wards, Breteau and House Index, open breeding sites, rainfall 2–6 weeks earlier, temperature suitability, humidity and the ward's historical burden. Each factor's contribution is shown on the ward page.
2. **Forecast** — expected weekly cases for 4 weeks from the recent level, the risk score and the trend, with a negative-binomial 90% band.
3. **Signals** —
   - *Cases above expected*: last week vs mean + 2 SD of the previous 8 weeks (EARS-style, 1-week guard), minimum 3 cases.
   - *Case cluster*: DBSCAN on case locations, 3+ cases within 200 m in 14 days (Aedes flight range).
   - *High larval density*: Breteau Index ≥ 20 or House Index ≥ 10% over 2 weeks.
   - *High predicted risk*: score ≥ 75.
4. **Playbook** — each signal maps to field tasks with SLAs (e.g. a cluster triggers a house-to-house survey within 100 m of each case in 48 h). KMC should replace the default playbook with its own SOP.

**The weights are an expert-set baseline, not yet trained on KMC data.** `ml/train_baseline.py` fits them on KMC's historical ward-week records and validates on a held-out season; it writes `ml/weights.json` in the engine's format. Run it once KMC shares 3–5 seasons of case, larval-survey and weather data, before any operational use.

## Run it

```bash
npm install
npm run dev          # demo mode on synthetic data → http://localhost:5173
npm test             # engine and data tests
npm run build        # static build in dist/ (relative paths, hash routing)
```

## Connect Supabase (live mode)

1. Create a Supabase project (India region, `ap-south-1`) and enable the **PostGIS** extension.
2. Apply the migrations in `supabase/migrations/` in order (`supabase db push`, or paste them in the SQL editor).
3. Load geography: run `supabase/seed.sql` (16 boroughs, 144 wards, adjacency, two teams per ward).
   Optional for a demo project only: `supabase/seed-demo.sql` (synthetic history). Never load it next to real data.
4. Deploy the functions: `supabase functions deploy compute-risk` and `supabase functions deploy fetch-weather`, then enable `pg_cron` + `pg_net` and schedule them (see `migrations/…_schedule.sql`).
5. Create users in Supabase Auth and add a row per user in `public.profiles` (role, borough or ward).
6. Copy `.env.example` to `.env`, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and build.

Users sign in with an emailed magic link. The migrations were tested on Postgres 17 + PostGIS (PGlite): schema, seeds, ward-from-location trigger, adjacency and every role's row-level security.

Regenerating data files:

```bash
npm run prep:geo                        # ward geometry + adjacency for the app (src/data)
node scripts/build-seed-sql.mjs         # supabase/seed.sql
npx vite-node scripts/export-demo.ts    # supabase/seed-demo.sql (synthetic)
npx vite-node scripts/export-demo-csv.ts && python ml/train_baseline.py   # exercise the training pipeline
```

## Architecture

```
Labs / hospitals ──┐                         ┌── HQ dashboard
Field teams (mobile)┤   Supabase (Postgres +  │── Borough & ward views
Citizen channels ───┤   PostGIS, Auth, RLS,   │── Field task board
Open-Meteo / IMD ───┘   Storage, Edge Fns)  ──┤── Alerts & playbook
        │                    │                 └── Situation reports
        └── fetch-weather    └── compute-risk (daily scores, Monday 09:00 IST alerts)
                                   └── shared risk-engine.ts (same code as the browser)
```

- **Frontend**: React 18, TypeScript, Vite, Tailwind, Leaflet (ward boundaries, no external tiles needed), Recharts.
- **Backend**: Supabase — Postgres + PostGIS, Auth, row-level security, Storage for site photos, Edge Functions (Deno), pg_cron.
- **Geography**: versioned (`geo_versions`). The 209-ward map loads as version 2; cases are re-assigned by location so trends stay comparable.
- **Hosting**: any static host for the frontend (Vercel, or the West Bengal State Data Centre via Webel); Supabase cloud in India or self-hosted Supabase at the State Data Centre.

## Data protection

- Analytics tables hold no names, phone numbers or addresses. Identifiable details, if KMC needs them for follow-up, go in `case_contacts`, readable only by officers with `pii_access`, and are never copied into the audit log.
- Duplicate detection uses a salted hash of partial identity fields. **Before go-live, move hashing server-side** (an RPC or edge function with the salt in Vault); the MVP hashes in the browser.
- Every write to cases, contacts, tasks, alerts and sites is audited.
- Built for the Digital Personal Data Protection Act, 2023 and its Rules (substantive obligations from May 2027).

## Known limitations of this MVP

- Demo data is synthetic; the risk weights are a baseline until trained and validated on KMC history.
- Ward boundaries: 141 from DataMeet open data (simplified); wards 142–144 are approximate points. Replace with KMC's official GIS.
- Ward populations are placeholders (31,000 per ward in the seed); load census or KMC figures.
- Field app works online only; offline capture and a Bengali interface are next.
- Not yet integrated with IDSP-IHIP, private-lab systems, KMC drones or a WhatsApp citizen bot (designed for, see roadmap).

## Roadmap

| Phase | Scope |
| --- | --- |
| 0 — Demo (now) | This MVP on synthetic data |
| 1 — Pilot, 2 boroughs, Jan–Apr 2027 | Load KMC history; train and validate the model; onboard 2 boroughs' ward teams and 10+ labs; Bengali UI; offline field capture |
| 2 — Pre-monsoon city rollout, May–Jun 2027 | All 16 boroughs; switch to the 209-ward map; IHIP and private-lab feeds; WhatsApp citizen intake |
| 3 — Season operations, Jul–Nov 2027 | Weekly model monitoring; drone-image breeding-site detection; hospital bed and platelet visibility |

Ward boundary data: DataMeet *Municipal Spatial Data* (Kolkata). Weather: Open-Meteo (IMD when available).
