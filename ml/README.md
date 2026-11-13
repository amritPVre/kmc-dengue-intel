# Model training

`train_baseline.py` fits the ward risk model on KMC history and checks it on a held-out season.

Export these four CSVs from Supabase into `ml/data/` (or run `npx vite-node scripts/export-demo-csv.ts` to try the pipeline on synthetic data):

| File | Columns | From |
| --- | --- | --- |
| wards.csv | ward_no, borough, population, neighbours | `v_wards_active` (neighbours space-separated) |
| cases_weekly.csv | ward_no, week_start, cases | `v_ward_weekly` |
| larval_weekly.csv | ward_no, week_start, houses_visited, houses_positive, containers_positive | `larval_surveys` grouped by ward and week |
| weather_weekly.csv | week_start, rain_mm, t_mean_c, rh_pct | `weather_weekly` |

Then `python ml/train_baseline.py --holdout-year 2025`. It prints ROC-AUC, PR-AUC, Brier score and precision in the top 10% of ward-weeks, and writes `ml/weights.json`. Copy accepted weights into `DEFAULT_CONFIG` in `supabase/functions/_shared/risk-engine.ts` and bump `MODEL_VERSION`.

Accept a model only if it clearly beats the baseline on the held-out season, and re-check it every season.
