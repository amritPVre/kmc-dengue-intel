"""
Fit the ward risk model's weights on KMC history and validate on a held-out season.

The web app and the nightly job score wards with a logistic model over ten features
(supabase/functions/_shared/risk-engine.ts). This script rebuilds the same features from
weekly history, fits the coefficients, reports out-of-season performance, and writes
ml/weights.json in the engine's format.

Target: does the ward's case count over the NEXT 4 weeks exceed the larger of 4 cases and
1.5x its count over the previous 4 weeks (a "rise in transmission")?

Inputs (CSV, one row per ward-week; export from Supabase or run scripts/export-demo-csv.ts):
  ml/data/wards.csv          ward_no, borough, population, neighbours ("58 59 65")
  ml/data/cases_weekly.csv   ward_no, week_start, cases
  ml/data/larval_weekly.csv  ward_no, week_start, houses_visited, houses_positive, containers_positive
  ml/data/weather_weekly.csv week_start, rain_mm, t_mean_c, rh_pct

Usage: python ml/train_baseline.py [--holdout-year 2026]
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

FEATURES = ["recentIncidence", "trend", "neighbourPressure", "breteau", "houseIndex",
            "breedingSites", "rainfallLag", "temperature", "humidity", "history"]
DATA = Path(__file__).parent / "data"


def build_frame() -> pd.DataFrame:
    wards = pd.read_csv(DATA / "wards.csv")
    cases = pd.read_csv(DATA / "cases_weekly.csv", parse_dates=["week_start"])
    larv = pd.read_csv(DATA / "larval_weekly.csv", parse_dates=["week_start"])
    wx = pd.read_csv(DATA / "weather_weekly.csv", parse_dates=["week_start"]).sort_values("week_start")

    pop = dict(zip(wards.ward_no, wards.population))
    nbrs = {w: [int(x) for x in str(n).split()] for w, n in zip(wards.ward_no, wards.neighbours)}
    piv = cases.pivot_table(index="week_start", columns="ward_no", values="cases", fill_value=0).sort_index()
    weeks = piv.index

    lv = larv.set_index(["ward_no", "week_start"]).sort_index()
    wx = wx.set_index("week_start").reindex(weeks).ffill()
    rain_lag = wx.rain_mm.rolling(5).sum().shift(2)        # weeks t-6 … t-2
    t2 = wx.t_mean_c.rolling(2).mean()
    rh2 = wx.rh_pct.rolling(2).mean()
    cum = piv.cumsum()

    rows = []
    for i in range(10, len(weeks) - 4):
        t = weeks[i]
        hist_rate = (cum.iloc[i - 8] / pd.Series(pop)).rank(pct=True)
        for w in piv.columns:
            s = piv[w].values
            last2, prev2 = s[i] + s[i - 1], s[i - 2] + s[i - 3]
            nb = nbrs.get(w, [])
            nb_cases = sum(piv[x].values[i] + piv[x].values[i - 1] for x in nb if x in piv.columns)
            nb_pop = sum(pop.get(x, 0) for x in nb) or 1000
            try:
                l = lv.loc[(w, slice(weeks[i - 1], t)), :].sum()
                hv = l.houses_visited
            except KeyError:
                hv = 0
            bi = (l.containers_positive / hv * 100) if hv else None
            hi = (l.houses_positive / hv * 100) if hv else None
            p = max(pop.get(w, 31000), 1000)
            future = s[i + 1:i + 5].sum()
            past4 = s[i - 3:i + 1].sum()
            rows.append({
                "ward": w, "week": t,
                "recentIncidence": math.log1p(last2 / p * 1e4 * 2),
                "trend": float(np.clip(math.log2((last2 + 1) / (prev2 + 1)), -2, 2)),
                "neighbourPressure": math.log1p(nb_cases / nb_pop * 1e4 * 2),
                "breteau": 0.5 if bi is None else float(np.clip(bi / 20, 0, 2.5)),
                "houseIndex": 0.5 if hi is None else float(np.clip(hi / 10, 0, 2.5)),
                "breedingSites": 0.0,  # add when breeding-site history is available per week
                "rainfallLag": float(np.clip((rain_lag.iloc[i] or 0) / 250, 0, 2)),
                "temperature": math.exp(-(((t2.iloc[i] or 28) - 29) / 4) ** 2),
                "humidity": float(np.clip(((rh2.iloc[i] or 75) - 60) / 25, 0, 1)),
                "history": float(hist_rate.get(w, 0.5)),
                "y": int(future >= max(4, 1.5 * past4)),
            })
    return pd.DataFrame(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdout-year", type=int, default=None, help="season held out for validation (default: latest year)")
    args = ap.parse_args()
    df = build_frame()
    year = args.holdout_year or df.week.dt.year.max()
    train, test = df[df.week.dt.year < year], df[df.week.dt.year == year]
    if train.y.nunique() < 2 or test.empty:
        raise SystemExit("Not enough history: need at least one full prior season with rises in transmission.")

    m = LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced")
    m.fit(train[FEATURES], train.y)
    p = m.predict_proba(test[FEATURES])[:, 1]
    print(f"train rows {len(train)}, positives {train.y.mean():.1%} | holdout {year}: rows {len(test)}, positives {test.y.mean():.1%}")
    print(f"holdout ROC-AUC {roc_auc_score(test.y, p):.3f} · PR-AUC {average_precision_score(test.y, p):.3f} · Brier {brier_score_loss(test.y, p):.3f}")
    top = test.assign(p=p).sort_values("p", ascending=False)
    k = max(1, int(0.1 * len(top)))
    print(f"precision in top 10% of ward-weeks: {top.head(k).y.mean():.1%} (base rate {test.y.mean():.1%})")

    out = {"intercept": float(m.intercept_[0]), "weights": dict(zip(FEATURES, map(float, m.coef_[0]))),
           "trained_on": f"{train.week.min().date()} to {train.week.max().date()}", "holdout_year": int(year)}
    (Path(__file__).parent / "weights.json").write_text(json.dumps(out, indent=2))
    print("wrote ml/weights.json — review, then copy into DEFAULT_CONFIG in risk-engine.ts and bump MODEL_VERSION")


if __name__ == "__main__":
    main()
