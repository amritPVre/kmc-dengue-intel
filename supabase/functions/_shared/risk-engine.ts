// KMC Dengue Intelligence — shared analytics engine.
// Pure TypeScript with no imports, so the same file runs in the browser (Vite)
// and in Supabase Edge Functions (Deno).
//
// What it does, per ward:
//   1. Risk score (0–100): probability-style score that the ward sees a rise in
//      dengue transmission over the next 2–4 weeks, with an explanation of drivers.
//   2. Short-term forecast: expected weekly cases for the next 4 weeks with a 90% band.
//   3. Early-warning signals: case exceedance (EARS-style), entomological thresholds,
//      spatial case clusters (DBSCAN on case locations), and high predicted risk.
//   4. SOP actions: the field tasks each signal should trigger.
//
// IMPORTANT: the weights below are an expert-set BASELINE, not a model trained on
// KMC data. Replace them with coefficients fitted on KMC's historical case,
// larval-survey and weather records (see ml/train_baseline.py) before operational use.

export const MODEL_VERSION = 'baseline-logit-0.1';

export type RiskLevel = 'Low' | 'Moderate' | 'High' | 'Very high';
export type AlertType = 'exceedance' | 'cluster' | 'entomological' | 'predicted';
export type AlertLevel = 'Watch' | 'Warning' | 'Outbreak';

export interface WardWeekInput {
  ward: number;
  population: number;
  /** Weekly confirmed cases, oldest → newest. Last element = most recent complete week. */
  weeklyCases: number[];
  /** Cases in adjacent wards over the last 2 complete weeks. */
  neighbourCases2w: number;
  /** Combined population of adjacent wards. */
  neighbourPopulation: number;
  /** Breteau Index from the last 2 weeks of larval surveys (positive containers per 100 houses). */
  breteauIndex: number | null;
  /** House Index (% houses positive) from the last 2 weeks. */
  houseIndex: number | null;
  openBreedingSites: number;
  /** Rainfall total over weeks t-6 … t-2 (mm): the lag that drives Aedes breeding. */
  rainLagMm: number;
  /** Mean temperature over the last 2 weeks (°C). */
  meanTempC: number;
  /** Mean relative humidity over the last 2 weeks (%). */
  meanRhPct: number;
  /** Ward's long-run incidence rank among all wards, 0 (lowest) … 1 (highest). */
  historicalPercentile: number;
}

export interface EngineConfig {
  intercept: number;
  weights: Record<FeatureKey, number>;
  levels: { moderate: number; high: number; veryHigh: number };
  alerts: {
    baselineWeeks: number;
    exceedanceSd: number;
    exceedanceMin: number;
    breteauHigh: number;
    houseIndexHigh: number;
    clusterRadiusM: number;
    clusterDays: number;
    clusterMinCases: number;
    predictedRiskScore: number;
  };
}

export type FeatureKey =
  | 'recentIncidence' | 'trend' | 'neighbourPressure' | 'breteau' | 'houseIndex'
  | 'breedingSites' | 'rainfallLag' | 'temperature' | 'humidity' | 'history';

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  recentIncidence: 'Recent cases per 10,000 people',
  trend: 'Case trend (last 2 vs previous 2 weeks)',
  neighbourPressure: 'Cases in neighbouring wards',
  breteau: 'Breteau Index (larval density)',
  houseIndex: 'House Index (% houses with larvae)',
  breedingSites: 'Open breeding sites',
  rainfallLag: 'Rainfall 2–6 weeks ago',
  temperature: 'Temperature suitability for Aedes',
  humidity: 'Humidity',
  history: 'Historical dengue burden of the ward',
};

export const DEFAULT_CONFIG: EngineConfig = {
  intercept: -3.6,
  weights: {
    recentIncidence: 0.9,
    trend: 0.55,
    neighbourPressure: 0.5,
    breteau: 0.8,
    houseIndex: 0.35,
    breedingSites: 0.3,
    rainfallLag: 0.6,
    temperature: 0.4,
    humidity: 0.2,
    history: 0.6,
  },
  levels: { moderate: 25, high: 50, veryHigh: 75 },
  alerts: {
    baselineWeeks: 8,
    exceedanceSd: 2,
    exceedanceMin: 3,
    breteauHigh: 20,
    houseIndexHigh: 10,
    clusterRadiusM: 200,
    clusterDays: 14,
    clusterMinCases: 3,
    predictedRiskScore: 75,
  },
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const sd = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / (a.length - 1));
};
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Transforms raw inputs into roughly 0–2 scaled features. */
export function features(i: WardWeekInput): Record<FeatureKey, number> {
  const n = i.weeklyCases.length;
  const c = (k: number) => (n - 1 - k >= 0 ? i.weeklyCases[n - 1 - k] : 0);
  const last2 = c(0) + c(1);
  const prev2 = c(2) + c(3);
  const pop = Math.max(i.population, 1000);
  const incidence = (last2 / pop) * 1e4;
  const nbIncidence = (i.neighbourCases2w / Math.max(i.neighbourPopulation, 1000)) * 1e4;
  return {
    recentIncidence: Math.log1p(incidence * 2),
    trend: clamp(Math.log2((last2 + 1) / (prev2 + 1)), -2, 2),
    neighbourPressure: Math.log1p(nbIncidence * 2),
    breteau: i.breteauIndex == null ? 0.5 : clamp(i.breteauIndex / 20, 0, 2.5),
    houseIndex: i.houseIndex == null ? 0.5 : clamp(i.houseIndex / 10, 0, 2.5),
    breedingSites: Math.log1p(Math.max(0, i.openBreedingSites)) / Math.log1p(10),
    rainfallLag: clamp(i.rainLagMm / 250, 0, 2),
    temperature: Math.exp(-(((i.meanTempC - 29) / 4) ** 2)),
    humidity: clamp((i.meanRhPct - 60) / 25, 0, 1),
    history: clamp(i.historicalPercentile, 0, 1),
  };
}

export interface Driver { key: FeatureKey; label: string; value: number; contribution: number }
export interface ForecastPoint { step: number; mean: number; lo: number; hi: number }
export interface RiskResult {
  ward: number;
  score: number; // 0–100
  level: RiskLevel;
  drivers: Driver[]; // sorted by contribution, largest first
  forecast: ForecastPoint[]; // next 4 weeks
  modelVersion: string;
}

export function levelFor(score: number, cfg: EngineConfig = DEFAULT_CONFIG): RiskLevel {
  if (score >= cfg.levels.veryHigh) return 'Very high';
  if (score >= cfg.levels.high) return 'High';
  if (score >= cfg.levels.moderate) return 'Moderate';
  return 'Low';
}

export function scoreWard(i: WardWeekInput, cfg: EngineConfig = DEFAULT_CONFIG): RiskResult {
  const f = features(i);
  let z = cfg.intercept;
  const drivers: Driver[] = [];
  for (const key of Object.keys(f) as FeatureKey[]) {
    const contribution = cfg.weights[key] * f[key];
    z += contribution;
    drivers.push({ key, label: FEATURE_LABELS[key], value: f[key], contribution });
  }
  drivers.sort((a, b) => b.contribution - a.contribution);
  const p = sigmoid(z);
  const score = Math.round(p * 100);
  return {
    ward: i.ward,
    score,
    level: levelFor(score, cfg),
    drivers,
    forecast: forecastWard(i.weeklyCases, p),
    modelVersion: MODEL_VERSION,
  };
}

/**
 * 4-week forecast: exponentially weighted recent level, grown or decayed by the risk
 * probability and the recent case trend, with a negative-binomial (dispersion k = 2) 90% band.
 */
export function forecastWard(weekly: number[], p: number, steps = 4): ForecastPoint[] {
  const recent = weekly.slice(-4);
  let level = recent.length ? recent[0] : 0;
  for (const v of recent.slice(1)) level = 0.6 * v + 0.4 * level;
  const n = weekly.length;
  const last2 = (weekly[n - 1] ?? 0) + (weekly[n - 2] ?? 0);
  const prev2 = (weekly[n - 3] ?? 0) + (weekly[n - 4] ?? 0);
  const trend = clamp(Math.log2((last2 + 1) / (prev2 + 1)), -2, 2);
  const g = clamp(Math.exp(0.7 * (p - 0.5) + 0.25 * trend), 0.6, 1.35);
  const out: ForecastPoint[] = [];
  for (let k = 1; k <= steps; k++) {
    const m = Math.max(0.05, level) * g ** k;
    const v = m + (m * m) / 2;
    const half = 1.645 * Math.sqrt(v);
    out.push({ step: k, mean: +m.toFixed(2), lo: +Math.max(0, m - half).toFixed(2), hi: +(m + half).toFixed(2) });
  }
  return out;
}

// ---------- early-warning signals ----------

export interface Signal {
  ward: number;
  type: AlertType;
  level: AlertLevel;
  title: string;
  detail: string;
  clusterCentroid?: [number, number];
  caseIds?: string[];
}

/** EARS-style exceedance: latest week vs mean + k·SD of the baseline window (1-week guard band). */
export function exceedance(ward: number, weekly: number[], cfg: EngineConfig = DEFAULT_CONFIG): Signal | null {
  const n = weekly.length;
  const B = cfg.alerts.baselineWeeks;
  if (n < B + 2) return null;
  const current = weekly[n - 1];
  const base = weekly.slice(n - 2 - B, n - 2);
  const m = mean(base);
  const threshold = Math.max(cfg.alerts.exceedanceMin, m + cfg.alerts.exceedanceSd * sd(base));
  if (current < threshold || current <= m) return null;
  const level: AlertLevel = current >= 2 * threshold ? 'Outbreak' : 'Warning';
  return {
    ward, type: 'exceedance', level,
    title: `Cases above expected: ${current} this week`,
    detail: `Ward ${ward} reported ${current} cases last week against an expected ${m.toFixed(1)} (threshold ${threshold.toFixed(1)}, mean + ${cfg.alerts.exceedanceSd} SD of the previous ${B} weeks).`,
  };
}

export function entomological(ward: number, bi: number | null, hi: number | null, cfg: EngineConfig = DEFAULT_CONFIG): Signal | null {
  const biHigh = bi != null && bi >= cfg.alerts.breteauHigh;
  const hiHigh = hi != null && hi >= cfg.alerts.houseIndexHigh;
  if (!biHigh && !hiHigh) return null;
  const parts: string[] = [];
  if (biHigh) parts.push(`Breteau Index ${bi!.toFixed(0)} (threshold ${cfg.alerts.breteauHigh})`);
  if (hiHigh) parts.push(`House Index ${hi!.toFixed(1)}% (threshold ${cfg.alerts.houseIndexHigh}%)`);
  return {
    ward, type: 'entomological', level: biHigh && hiHigh ? 'Warning' : 'Watch',
    title: 'High larval density',
    detail: `Larval surveys over the last 2 weeks show ${parts.join(' and ')}.`,
  };
}

export function predicted(r: RiskResult, cfg: EngineConfig = DEFAULT_CONFIG): Signal | null {
  if (r.score < cfg.alerts.predictedRiskScore) return null;
  const top = r.drivers.slice(0, 3).map((d) => d.label.toLowerCase()).join(', ');
  return {
    ward: r.ward, type: 'predicted', level: 'Watch',
    title: `Very high predicted risk (${r.score}/100)`,
    detail: `Model ${r.modelVersion} expects rising transmission over the next 2–4 weeks. Main drivers: ${top}.`,
  };
}

export interface CasePoint { id: string; ward: number; lat: number; lng: number; dayIndex: number }

const metres = (a: CasePoint, b: CasePoint) => {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dx = toRad(b.lng - a.lng) * Math.cos(toRad((a.lat + b.lat) / 2)) * R;
  const dy = toRad(b.lat - a.lat) * R;
  return Math.hypot(dx, dy);
};

/** DBSCAN over case locations within the last `clusterDays` days (Aedes flight range ≈ 100–200 m). */
export function clusters(points: CasePoint[], todayIndex: number, cfg: EngineConfig = DEFAULT_CONFIG): Signal[] {
  const pts = points.filter((p) => todayIndex - p.dayIndex <= cfg.alerts.clusterDays && todayIndex >= p.dayIndex);
  const eps = cfg.alerts.clusterRadiusM;
  const minPts = cfg.alerts.clusterMinCases;
  const label = new Array<number>(pts.length).fill(-1);
  const near = (i: number) => pts.map((_, j) => j).filter((j) => metres(pts[i], pts[j]) <= eps);
  let cid = 0;
  for (let i = 0; i < pts.length; i++) {
    if (label[i] !== -1) continue;
    const nb = near(i);
    if (nb.length < minPts) { label[i] = -2; continue; }
    label[i] = cid;
    const queue = nb.filter((j) => j !== i);
    while (queue.length) {
      const j = queue.shift()!;
      if (label[j] === -2) label[j] = cid;
      if (label[j] !== -1) continue;
      label[j] = cid;
      const nb2 = near(j);
      if (nb2.length >= minPts) queue.push(...nb2.filter((k) => label[k] < 0));
    }
    cid++;
  }
  const out: Signal[] = [];
  for (let c = 0; c < cid; c++) {
    const members = pts.filter((_, i) => label[i] === c);
    const wardCounts = new Map<number, number>();
    for (const m of members) wardCounts.set(m.ward, (wardCounts.get(m.ward) ?? 0) + 1);
    const ward = [...wardCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const lat = mean(members.map((m) => m.lat));
    const lng = mean(members.map((m) => m.lng));
    const wards = [...wardCounts.keys()].sort((a, b) => a - b);
    out.push({
      ward, type: 'cluster', level: members.length >= 2 * minPts ? 'Outbreak' : 'Warning',
      title: `Case cluster: ${members.length} cases within ${eps} m`,
      detail: `${members.length} cases in the last ${cfg.alerts.clusterDays} days within ${eps} m of each other` +
        (wards.length > 1 ? `, spanning wards ${wards.join(', ')}.` : ` in ward ${ward}.`),
      clusterCentroid: [lng, lat],
      caseIds: members.map((m) => m.id),
    });
  }
  return out;
}

// ---------- SOP: signal → field tasks ----------

export type TaskType =
  | 'House-to-house larval survey' | 'Source reduction drive' | 'Larviciding'
  | 'Focal space spraying' | 'Fever survey' | 'Notice to property owner (Sec 496A)'
  | 'Construction site inspection' | 'Community awareness (IEC)' | 'Reporting review with labs';

export interface TaskTemplate { type: TaskType; title: string; slaHours: number; priority: 'P1' | 'P2' | 'P3' }

/** Default response playbook. KMC should replace this with its own SOP (state / NCVBDC guidance). */
export const SOP: Record<AlertType, TaskTemplate[]> = {
  cluster: [
    { type: 'House-to-house larval survey', title: 'House-to-house survey within 100 m of each case', slaHours: 48, priority: 'P1' },
    { type: 'Source reduction drive', title: 'Source reduction around the cluster', slaHours: 48, priority: 'P1' },
    { type: 'Fever survey', title: 'Active fever search in cluster households', slaHours: 72, priority: 'P1' },
    { type: 'Focal space spraying', title: 'Focal space spraying in cluster area (per SOP)', slaHours: 72, priority: 'P2' },
  ],
  exceedance: [
    { type: 'House-to-house larval survey', title: 'Intensified larval survey across the ward', slaHours: 72, priority: 'P1' },
    { type: 'Reporting review with labs', title: 'Check case reporting from private labs and hospitals', slaHours: 72, priority: 'P2' },
    { type: 'Community awareness (IEC)', title: 'Awareness drive in affected neighbourhoods', slaHours: 120, priority: 'P3' },
  ],
  entomological: [
    { type: 'Source reduction drive', title: 'Source reduction in positive premises', slaHours: 72, priority: 'P2' },
    { type: 'Larviciding', title: 'Larvicide in water bodies and drains that cannot be emptied', slaHours: 72, priority: 'P2' },
    { type: 'Notice to property owner (Sec 496A)', title: 'Serve notices on repeat-positive premises', slaHours: 120, priority: 'P3' },
  ],
  predicted: [
    { type: 'Construction site inspection', title: 'Inspect construction sites and vacant plots', slaHours: 120, priority: 'P2' },
    { type: 'Source reduction drive', title: 'Pre-emptive source reduction in hotspots', slaHours: 120, priority: 'P2' },
  ],
};

// ---------- entomological indices ----------

export function indices(housesVisited: number, housesPositive: number, containersInspected: number, containersPositive: number) {
  const HI = housesVisited ? (housesPositive / housesVisited) * 100 : 0;
  const CI = containersInspected ? (containersPositive / containersInspected) * 100 : 0;
  const BI = housesVisited ? (containersPositive / housesVisited) * 100 : 0;
  return { HI, CI, BI };
}
