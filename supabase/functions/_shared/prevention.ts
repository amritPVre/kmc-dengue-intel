// KMC Dengue Intelligence — prevention index.
// Where are Aedes mosquitoes most likely to breed in the next 1–2 weeks, using only data that
// exists before a single case is reported: weather, satellite-detected water, land cover, mapped
// container sites, ponds and drains, population density and reported waterlogging pockets.
// It never uses case data, so it can be checked against case records it has not seen.
//
// Weights are an expert-set baseline. Calibrate them against KMC's ward-level case and larval
// survey history before operational use.

export const PREVENTION_VERSION = 'prevention-0.1';

export interface PreventionInput {
  ward: number;
  areaKm2: number;
  population: number | null;
  /** Borough rainfall (mm) over the last 7 and 28 days, and forecast for the next 3 days. */
  rain7: number;
  rain28: number;
  rainNext3: number;
  /** Mean air temperature over the last 7 days (°C). */
  tMean7: number;
  /** New water (ha) on the most recent Sentinel-1 pass and its age in days (null when none in 14 days). */
  newWaterHa: number | null;
  passAgeDays: number | null;
  /** Share of processed monsoon passes in which the ward showed new water (null until enough passes). */
  wetFrequency: number | null;
  /** JRC Global Surface Water: share of the ward that is water in 1–50 % of observations. */
  seasonalWater: number | null;
  /** ESA WorldCover shares. */
  bare: number | null;
  grass: number | null;
  built: number | null;
  /** OpenStreetMap candidate counts by category. */
  candidates: Record<string, number>;
  /** Waterlogging pockets named in KMC statements or press reports. */
  reportedPockets: number;
  /** Active standing-water spots on record (satellite, rain model, photo AI, field). */
  activeSpots: number;
}

export type PreventionKey = 'weather' | 'currentWater' | 'chronicPooling' | 'vacantLand' | 'containerSites' | 'pondsDrains' | 'people';
export const PREVENTION_LABELS: Record<PreventionKey, string> = {
  weather: 'Rain and temperature (season)',
  currentWater: 'Standing water seen now (satellite, AI, field)',
  chronicPooling: 'Ward floods repeatedly (satellite history, reported pockets)',
  vacantLand: 'Vacant and bare land',
  containerSites: 'Tyre shops, scrap yards, construction sites, markets',
  pondsDrains: 'Ponds, canals and open drains',
  people: 'Population density',
};
export const PREVENTION_WEIGHTS: Record<Exclude<PreventionKey, 'weather' | 'currentWater'>, number> = {
  chronicPooling: 0.25, vacantLand: 0.2, containerSites: 0.2, pondsDrains: 0.1, people: 0.25,
};

export interface PreventionResult {
  ward: number;
  score: number; // 0–100
  level: 'Low' | 'Moderate' | 'High' | 'Very high';
  /** Structural receptivity (0–1): how prone the ward is, whatever the weather. */
  structural: number;
  components: { key: PreventionKey; label: string; value: number; raw: string }[];
  version: string;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

/** Thermal suitability for Aedes aegypti (Brière form, Mordecai et al. 2017 limits 17.8–34.6 °C), 0–1. */
export function thermalSuitability(t: number): number {
  const lo = 17.8, hi = 34.6;
  if (t <= lo || t >= hi) return 0;
  const f = (x: number) => x * (x - lo) * Math.sqrt(hi - x);
  let peak = 0;
  for (let x = 25; x <= 33; x += 0.05) peak = Math.max(peak, f(x));
  return clamp(f(t) / peak);
}

/** Season factor (0–1): temperature suitability times recent wetness. */
export function seasonFactor(tMean7: number, rain28: number, rainNext3 = 0): number {
  const wet = clamp(0.15 + (rain28 + 0.5 * rainNext3) / 180);
  return thermalSuitability(tMean7) * wet;
}

function rankMap(values: Map<number, number | null>): Map<number, number> {
  const list = [...values.entries()].filter(([, v]) => v != null && Number.isFinite(v)) as [number, number][];
  list.sort((a, b) => a[1] - b[1]);
  const out = new Map<number, number>();
  // average rank for ties, scaled to 0–1
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1][1] === list[i][1]) j++;
    const r = list.length > 1 ? (i + j) / 2 / (list.length - 1) : 0.5;
    for (let k = i; k <= j; k++) out.set(list[k][0], r);
    i = j + 1;
  }
  return out;
}

const CONTAINER_KEYS: Record<string, number> = { tyres: 1.5, vehicle: 1, scrap: 1.5, construction: 2, market: 1, nursery: 1, depot: 1 };

export function preventionIndex(inputs: PreventionInput[]): Map<number, PreventionResult> {
  const area = (i: PreventionInput) => Math.max(i.areaKm2, 0.2);
  const chronicRaw = new Map<number, number | null>();
  const vacantRaw = new Map<number, number | null>();
  const containerRaw = new Map<number, number | null>();
  const pondRaw = new Map<number, number | null>();
  const peopleRaw = new Map<number, number | null>();
  for (const i of inputs) {
    const c = i.candidates;
    const seasonal = i.seasonalWater ?? 0;
    chronicRaw.set(i.ward, (i.wetFrequency ?? 0) * 2 + seasonal * 10 + Math.min(i.reportedPockets, 3) * 0.35);
    vacantRaw.set(i.ward, i.bare == null && i.grass == null ? null : (i.bare ?? 0) + 0.5 * (i.grass ?? 0) + (c.vacant ?? 0) * 0.002 / area(i));
    let cont = 0;
    for (const [k, w] of Object.entries(CONTAINER_KEYS)) cont += (c[k] ?? 0) * w;
    containerRaw.set(i.ward, cont / area(i));
    pondRaw.set(i.ward, ((c.pond ?? 0) + 0.5 * (c.drain ?? 0)) / area(i));
    peopleRaw.set(i.ward, i.population ? i.population / area(i) : i.built != null ? i.built * 30000 : null);
  }
  const R = {
    chronicPooling: rankMap(chronicRaw), vacantLand: rankMap(vacantRaw), containerSites: rankMap(containerRaw),
    pondsDrains: rankMap(pondRaw), people: rankMap(peopleRaw),
  };
  const out = new Map<number, PreventionResult>();
  for (const i of inputs) {
    const weather = seasonFactor(i.tMean7, i.rain28, i.rainNext3);
    const recentHa = i.newWaterHa != null && i.passAgeDays != null && i.passAgeDays <= 14 ? i.newWaterHa * Math.exp(-i.passAgeDays / 10) : 0;
    const currentWater = 1 - Math.exp(-(recentHa + 0.6 * i.activeSpots) / 3);
    let structural = 0;
    let wsum = 0;
    for (const [k, w] of Object.entries(PREVENTION_WEIGHTS) as [keyof typeof PREVENTION_WEIGHTS, number][]) {
      const v = R[k].get(i.ward);
      if (v == null) continue;
      structural += w * v;
      wsum += w;
    }
    structural = wsum ? structural / wsum : 0.5;
    const score = Math.round(100 * (0.25 + 0.75 * weather) * (0.7 * structural + 0.3 * currentWater));
    const level = score >= 75 ? 'Very high' : score >= 50 ? 'High' : score >= 25 ? 'Moderate' : 'Low';
    const c = i.candidates;
    const nCont = Object.keys(CONTAINER_KEYS).reduce((a, k) => a + (c[k] ?? 0), 0);
    const pct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
    out.set(i.ward, {
      ward: i.ward, score, level, structural: +structural.toFixed(3), version: PREVENTION_VERSION,
      components: [
        { key: 'weather', label: PREVENTION_LABELS.weather, value: +weather.toFixed(3), raw: `${i.rain28.toFixed(0)} mm in 28 days, ${i.tMean7.toFixed(1)} °C` },
        { key: 'currentWater', label: PREVENTION_LABELS.currentWater, value: +currentWater.toFixed(3), raw: `${recentHa.toFixed(1)} ha new water on radar, ${i.activeSpots} active spots` },
        { key: 'chronicPooling', label: PREVENTION_LABELS.chronicPooling, value: +(R.chronicPooling.get(i.ward) ?? 0).toFixed(3), raw: `${i.wetFrequency == null ? 'radar history building' : `wet on ${pct(i.wetFrequency)} of monsoon passes`}; ${i.reportedPockets} reported pocket(s)` },
        { key: 'vacantLand', label: PREVENTION_LABELS.vacantLand, value: +(R.vacantLand.get(i.ward) ?? 0).toFixed(3), raw: `bare ${pct(i.bare)}, grass ${pct(i.grass)} of ward` },
        { key: 'containerSites', label: PREVENTION_LABELS.containerSites, value: +(R.containerSites.get(i.ward) ?? 0).toFixed(3), raw: `${nCont} mapped (${(nCont / area(i)).toFixed(1)} per km²)` },
        { key: 'pondsDrains', label: PREVENTION_LABELS.pondsDrains, value: +(R.pondsDrains.get(i.ward) ?? 0).toFixed(3), raw: `${c.pond ?? 0} ponds, ${c.drain ?? 0} drain/canal segments` },
        { key: 'people', label: PREVENTION_LABELS.people, value: +(R.people.get(i.ward) ?? 0).toFixed(3), raw: i.population ? `${Math.round(i.population / area(i)).toLocaleString('en-IN')} per km² (Census 2011)` : 'no census figure' },
      ],
    });
  }
  return out;
}

/** Probability that a randomly chosen named ward scores above a randomly chosen other ward (ROC AUC). */
export function aucNamed(scores: Map<number, number>, named: Set<number>): { auc: number | null; nNamed: number; nOther: number } {
  const pos = [...scores.entries()].filter(([w]) => named.has(w)).map(([, s]) => s);
  const neg = [...scores.entries()].filter(([w]) => !named.has(w)).map(([, s]) => s);
  if (!pos.length || !neg.length) return { auc: null, nNamed: pos.length, nOther: neg.length };
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return { auc: wins / (pos.length * neg.length), nNamed: pos.length, nOther: neg.length };
}
