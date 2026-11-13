import {
  DEFAULT_CONFIG, clusters, entomological, exceedance, predicted, scoreWard,
  type CasePoint, type EngineConfig, type Signal,
} from '@shared/risk-engine';
import type { BoroughCode, Db, WardStats } from './types';
import { BOROUGHS } from './types';
import { addDays, daysBetween, mondayOf, parseIso } from './util';

export interface Analytics {
  completeWeeks: string[]; // week starts of complete weeks
  currentWeek: string | null; // partial week containing asOf
  stats: Map<number, WardStats>;
  currentWeekCases: Map<number, number>;
  signals: Signal[];
  cityWeekly: number[];
  boroughWeekly: Map<BoroughCode, number[]>;
  rainWeekly: number[];
  config: EngineConfig;
}

export interface AnalyseOptions {
  /** Analyse as if the latest complete week were completeWeeks[endIndex] (used to back-fill history). */
  endIndex?: number;
  config?: EngineConfig;
}

export function analyse(db: Db, opts: AnalyseOptions = {}): Analytics {
  const cfg = opts.config ?? DEFAULT_CONFIG;
  const thisMonday = mondayOf(db.asOf);
  const allComplete = db.weeks.filter((w) => w < thisMonday);
  const endIndex = opts.endIndex ?? allComplete.length - 1;
  const completeWeeks = allComplete.slice(0, endIndex + 1);
  const n = completeWeeks.length;
  const weekIdx = new Map(completeWeeks.map((w, i) => [w, i]));
  const horizonEnd = addDays(completeWeeks[n - 1], 7); // first day after the last complete week
  const isBacktest = opts.endIndex != null && opts.endIndex < allComplete.length - 1;
  const currentWeek = isBacktest ? null : thisMonday;

  const weekly = new Map<number, number[]>();
  const currentWeekCases = new Map<number, number>();
  for (const w of db.wards) { weekly.set(w.ward, new Array(n).fill(0)); currentWeekCases.set(w.ward, 0); }
  const points: CasePoint[] = [];
  const day0 = completeWeeks[0];
  for (const c of db.cases) {
    const m = mondayOf(c.reportedOn);
    const i = weekIdx.get(m);
    if (i != null) weekly.get(c.ward)![i]++;
    else if (!isBacktest && m === thisMonday) currentWeekCases.set(c.ward, (currentWeekCases.get(c.ward) ?? 0) + 1);
    if (c.reportedOn < (isBacktest ? horizonEnd : addDays(db.asOf, 1))) {
      points.push({ id: c.id, ward: c.ward, lat: c.lat, lng: c.lng, dayIndex: daysBetween(day0, c.reportedOn) });
    }
  }
  const todayIndex = daysBetween(day0, isBacktest ? addDays(horizonEnd, -1) : db.asOf);

  // larval indices: last 14 days up to the analysis date
  const surveyFrom = isBacktest ? addDays(horizonEnd, -14) : addDays(db.asOf, -13);
  const surveyTo = isBacktest ? horizonEnd : addDays(db.asOf, 1);
  const larv = new Map<number, { hv: number; hp: number; ci: number; cp: number }>();
  for (const s of db.surveys) {
    if (s.date < surveyFrom || s.date >= surveyTo) continue;
    const a = larv.get(s.ward) ?? { hv: 0, hp: 0, ci: 0, cp: 0 };
    a.hv += s.housesVisited; a.hp += s.housesPositive; a.ci += s.containersInspected; a.cp += s.containersPositive;
    larv.set(s.ward, a);
  }

  // weather inputs, aligned with completeWeeks
  const wx = new Map(db.weather.map((w) => [w.weekStart, w]));
  const rainWeekly = completeWeeks.map((w) => wx.get(w)?.rainMm ?? 0);
  const rainLag = rainWeekly.slice(Math.max(0, n - 6), Math.max(0, n - 1)).reduce((a, b) => a + b, 0);
  const last2Wx = completeWeeks.slice(-2).map((w) => wx.get(w)).filter(Boolean) as Db['weather'];
  const meanT = last2Wx.length ? last2Wx.reduce((a, w) => a + w.tMeanC, 0) / last2Wx.length : 28;
  const meanRh = last2Wx.length ? last2Wx.reduce((a, w) => a + w.rhPct, 0) / last2Wx.length : 75;

  // historical burden: incidence before the last 8 weeks, ranked
  const histCut = Math.max(1, n - 8);
  const histRate = db.wards.map((w) => ({
    ward: w.ward,
    rate: weekly.get(w.ward)!.slice(0, histCut).reduce((a, b) => a + b, 0) / Math.max(w.population, 1),
  }));
  histRate.sort((a, b) => a.rate - b.rate);
  const pct = new Map(histRate.map((h, i) => [h.ward, histRate.length > 1 ? i / (histRate.length - 1) : 0.5]));

  const sitesOpen = new Map<number, number>();
  for (const s of db.sites) if (s.status === 'Open' && s.firstSeen < surveyTo) sitesOpen.set(s.ward, (sitesOpen.get(s.ward) ?? 0) + 1);
  const nowMs = isBacktest ? parseIso(horizonEnd).getTime() : Date.now();
  const openTasks = new Map<number, number>();
  const overdueTasks = new Map<number, number>();
  for (const t of db.tasks) {
    if (t.status === 'Done' || t.status === 'Verified') continue;
    openTasks.set(t.ward, (openTasks.get(t.ward) ?? 0) + 1);
    if (new Date(t.dueAt).getTime() < nowMs) overdueTasks.set(t.ward, (overdueTasks.get(t.ward) ?? 0) + 1);
  }

  const popByWard = new Map(db.wards.map((w) => [w.ward, w.population]));
  const ytdStart = `${db.asOf.slice(0, 4)}-01-01`;
  const stats = new Map<number, WardStats>();
  const signals: Signal[] = [];
  for (const w of db.wards) {
    const series = weekly.get(w.ward)!;
    const last2 = (series[n - 1] ?? 0) + (series[n - 2] ?? 0);
    const prev2 = (series[n - 3] ?? 0) + (series[n - 4] ?? 0);
    const nb2 = w.neighbours.reduce((a, nbw) => {
      const s = weekly.get(nbw);
      return a + (s ? (s[n - 1] ?? 0) + (s[n - 2] ?? 0) : 0);
    }, 0);
    const nbPop = w.neighbours.reduce((a, nbw) => a + (popByWard.get(nbw) ?? 0), 0);
    const L = larv.get(w.ward);
    const idx = L && L.hv > 0 ? { HI: (L.hp / L.hv) * 100, CI: L.ci ? (L.cp / L.ci) * 100 : 0, BI: (L.cp / L.hv) * 100 } : null;
    const risk = scoreWard({
      ward: w.ward,
      population: w.population,
      weeklyCases: series,
      neighbourCases2w: nb2,
      neighbourPopulation: nbPop,
      breteauIndex: idx ? idx.BI : null,
      houseIndex: idx ? idx.HI : null,
      openBreedingSites: sitesOpen.get(w.ward) ?? 0,
      rainLagMm: rainLag,
      meanTempC: meanT,
      meanRhPct: meanRh,
      historicalPercentile: pct.get(w.ward) ?? 0.5,
    }, cfg);
    const ytd = completeWeeks.reduce((a, wk, i) => a + (wk >= mondayOf(ytdStart) ? series[i] : 0), 0) + (currentWeekCases.get(w.ward) ?? 0);
    stats.set(w.ward, {
      ward: w.ward, borough: w.borough, population: w.population, weekly: series,
      last2w: last2, prev2w: prev2, ytd,
      bi: idx ? idx.BI : null, hi: idx ? idx.HI : null, ci: idx ? idx.CI : null,
      openSites: sitesOpen.get(w.ward) ?? 0,
      openTasks: openTasks.get(w.ward) ?? 0,
      overdueTasks: overdueTasks.get(w.ward) ?? 0,
      risk,
    });
    const ex = exceedance(w.ward, series, cfg); if (ex) signals.push(ex);
    const en = entomological(w.ward, idx ? idx.BI : null, idx ? idx.HI : null, cfg); if (en) signals.push(en);
    const pr = predicted(risk, cfg); if (pr) signals.push(pr);
  }
  signals.push(...clusters(points, todayIndex, cfg));

  const cityWeekly = new Array(n).fill(0);
  const boroughWeekly = new Map<BoroughCode, number[]>(BOROUGHS.map((b) => [b, new Array(n).fill(0)]));
  for (const s of stats.values()) {
    const bw = boroughWeekly.get(s.borough)!;
    s.weekly.forEach((v, i) => { cityWeekly[i] += v; bw[i] += v; });
  }
  return { completeWeeks, currentWeek, stats, currentWeekCases, signals, cityWeekly, boroughWeekly, rainWeekly, config: cfg };
}

export function boroughSummary(a: Analytics, b: BoroughCode) {
  const wards = [...a.stats.values()].filter((s) => s.borough === b);
  const sum = (f: (s: WardStats) => number) => wards.reduce((acc, s) => acc + f(s), 0);
  const hv = wards.filter((s) => s.bi != null);
  return {
    borough: b,
    wards,
    population: sum((s) => s.population),
    last2w: sum((s) => s.last2w),
    prev2w: sum((s) => s.prev2w),
    ytd: sum((s) => s.ytd),
    highRisk: wards.filter((s) => s.risk.level === 'High' || s.risk.level === 'Very high').length,
    maxRisk: Math.max(...wards.map((s) => s.risk.score)),
    meanBi: hv.length ? hv.reduce((acc, s) => acc + (s.bi ?? 0), 0) / hv.length : null,
    openSites: sum((s) => s.openSites),
    openTasks: sum((s) => s.openTasks),
    overdueTasks: sum((s) => s.overdueTasks),
    weekly: a.boroughWeekly.get(b)!,
  };
}

export const LEVEL_ORDER = { Low: 0, Moderate: 1, High: 2, 'Very high': 3 } as const;
