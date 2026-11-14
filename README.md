# KMC Dengue Intelligence — MVP

AI-assisted dengue **prevention** for the **Kolkata Municipal Corporation (KMC)**: 16 boroughs, 144 wards today, ready for the 209-ward delimitation.

The core of the platform is **finding standing water, ward by ward, and getting it cleared before mosquitoes emerge**. AI reads satellite radar and optical passes, KMC drone imagery, field-team and citizen photos and rain-gauge data to flag water spots; ward teams verify them and clear them inside the breeding window (egg to adult takes about 7 days at 30 °C, 10 at 25 °C). Case surveillance, larval surveys, risk forecasting and field-task tracking sit around that core.

> **Demo mode.** With no Supabase keys the app runs entirely in the browser on a **synthetic** dataset shaped like Kolkata's monsoon-driven dengue season. None of it is real KMC data.

## Live open data (no KMC data needed to start)

The app runs on real, public data from day one. Server functions in `api/` (Vercel) fetch and process it;
results are stored in Supabase (`public_layers`) and refreshed by a daily cron.

| Layer | Source | How it is used |
|---|---|---|
| Rain, temperature, humidity per borough, May 2025 → 16-day forecast | Open-Meteo (forecast models + ERA5) | Rain trigger, breeding-window countdown, season factor |
| New water per ward and 250 m water spots, every Sentinel-1 pass | Copernicus Sentinel-1 RTC on Microsoft Planetary Computer | Each pass minus a dry-season pass of the same orbit (VV < −16 dB) |
| True-colour views | Sentinel-2 L2A (Planetary Computer) | Visual checks on clear days |
| Built-up, bare/vacant, grass, water per ward | ESA WorldCover 2021 | Vacant-land driver |
| Seasonal and permanent surface water | JRC Global Surface Water | Chronic-pooling driver |
| Tyre/repair shops, scrap yards, construction sites, markets, nurseries, ponds, drains, hospitals, schools | OpenStreetMap (Overpass) | Sites to inspect; container-site driver |
| Ward population (141 wards) | Census 2011 PCA (via Wikipedia ward articles) | Density driver |
| Waterlogging pockets, dengue hotspot wards 2022–2025, KMC gauge readings | KMC statements and press (cited in `src/data/`) | Rain trigger; evidence check |

**Prevention index** (`supabase/functions/_shared/prevention.ts`): breeding pressure per ward from the
layers above, never from case data, so it can be checked against case records it has not seen
(Evidence page: ROC AUC against wards named in public reports). Weights are an expert baseline until
fitted on KMC's ward-level history.

**Replay**: any date since June 2025 can be viewed as the data stood then (forecasts are not used).
**Outbreak drill**: simulated cases for training, clearly bannered and kept apart from live data.

What still needs KMC: ward-level case records, larval surveys, drone footage, FFEWS rain gauges and
sensors. Each has an import path or connector ready.

### Deploy (Vercel + Supabase free tiers)

1. Supabase: apply `supabase/migrations/*` (not `seed-demo.sql`), then `supabase/seed.sql`; set the layer
   write token: `insert into private.app_secrets values ('layer_write_token', '<random>')`.
2. Vercel env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `LAYER_WRITE_TOKEN` (same random value), `CRON_SECRET`, optional `ANTHROPIC_API_KEY` for photo AI.
3. Backfill radar history: call `/api/satellite?op=process-next&key=<CRON_SECRET>&order=oldest` until it
   returns `done: true` (one pass per call, about a minute each). The daily cron keeps it current.

## Standing-water detection (the prevention core)

| Source | What it finds | Resolution / frequency | Access | State in this MVP |
| --- | --- | --- | --- | --- |
| KMC drone surveys | Rooftop water, uncovered overhead tanks, tyres, construction-site water | Centimetres; per mission | KMC already flies drones for rooftop surveillance | AI per frame (vision model); `pipelines/drone/` tiles an orthomosaic and sends tiles to the same AI |
| Field-team photos | Containers, drains, premises | Per photo, with GPS | KMC vector-control staff phones | AI photo analysis built in |
| Citizen photos | Complaints with pictures | Per photo | WhatsApp / app intake (Phase 2) | Same AI analysis |
| Sentinel-1C/1D radar | Open waterlogging, flooded plots, construction pits ≥ 300 m² | 10 m, 6-day revisit, through cloud | Free (Copernicus) | `pipelines/satellite/` (Earth Engine) written, not yet run on live imagery |
| Sentinel-2 optical | Pools, ponds, waterlogged land | 10 m, 5-day, cloud-limited | Free (Copernicus) | Same pipeline |
| NISAR L-band radar | Water under vegetation | 12-day repeat | Free (NASA-ISRO) | Phase 2 (scene search stub) |
| KMC rain gauges + flood sensors (FFEWS) | Locality rainfall; streets under water | Real time | KMC Drainage & Sewerage control room | `rain_daily` table + `rain-watch` function; needs the KMC feed |
| Rain + terrain model | Pockets that usually pool after heavy rain | Same day as the rain | Built from past monsoon radar passes + elevation | Built; demo uses synthetic susceptibility |
| CCTV (KMC / Kolkata Police) | Street waterlogging at junctions | Frames | Integrated control room | Phase 2 |

How a spot moves through the system: **detected** (AI, with confidence and source) → **checked** by the ward team (Confirm / False alarm) → **dispatched** as a "Clear standing water" task due before its clear-by date → **cleared**. Spots past the window trigger a water alert with adult-mosquito control. Each confirm / false-alarm decision is a labelled example for retraining the detectors on Kolkata's own rooftops and lanes, and the page shows each source's confirmation rate.

Standing water also feeds the ward risk score (a new "standing water" factor), so wet wards rise in the forecast before cases do.

The AI photo analysis uses one prompt and result format everywhere (`supabase/functions/_shared/vision.ts`):
- **KMC deployment**: photo → Supabase Storage → `analyze-image` Edge Function → Anthropic API (set `ANTHROPIC_API_KEY`).
- **Inside Claude** (the published demo): the page asks Claude vision through the viewer's own Claude account.

## What it does

| Area | What users get |
| --- | --- |
| Standing water | Live rain and satellite status, active spots with clear-by countdown, map layer, AI photo analysis, verify / dispatch / clear, confirmation rate per source |
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
4. Deploy the functions: `compute-risk`, `fetch-weather`, `analyze-image` (secret `ANTHROPIC_API_KEY`) and `rain-watch`; create the private Storage bucket `detection-photos`; enable `pg_cron` + `pg_net` and schedule them (see `migrations/…_schedule.sql`).
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
- The satellite pipeline is written against Google Earth Engine but has not been run on live imagery here; validate it on the 22–23 September 2025 cloudburst before use. Radar is less reliable in dense built-up areas, so those detections carry lower confidence and always need a ward check.
- Drone detection uses a general vision model per tile until a YOLO detector is trained on KMC-labelled tiles (Phase 2).
- Not yet integrated with IDSP-IHIP, private-lab systems, the KMC FFEWS feed or a WhatsApp citizen bot (designed for, see roadmap).

## Roadmap

| Phase | Scope |
| --- | --- |
| 0 — Demo (now) | This MVP on synthetic data |
| 1 — Pilot, 2 boroughs, Jan–Apr 2027 | Connect KMC drone imagery and FFEWS rain gauges; run and validate the satellite pipeline; build the waterlogging susceptibility map from past monsoons; load KMC case history and train the risk model; Bengali UI; offline field capture |
| 2 — Pre-monsoon city rollout, May–Jun 2027 | All 16 boroughs; switch to the 209-ward map; IHIP and private-lab feeds; WhatsApp citizen intake |
| 3 — Season operations, Jul–Nov 2027 | Weekly model monitoring; drone-image breeding-site detection; hospital bed and platelet visibility |

Ward boundary data: DataMeet *Municipal Spatial Data* (Kolkata). Weather: Open-Meteo (IMD when available).
