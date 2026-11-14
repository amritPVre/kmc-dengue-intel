import {
  DEFAULT_CONFIG, aedesDevelopmentDays, clusters, daysToClear, entomological, exceedance, predicted, scoreWard, waterSignal,
  type CasePoint, type EngineConfig, type Signal,
} from '@shared/risk-engine';
import { preventionIndex, type PreventionInput, type PreventionResult } from '@shared/prevention';
import type { BoroughCode, Db, WardStats, WardWater, WaterDetection } from './types';
import { BOROUGHS } from './types';
import { addDays, daysBetween, mondayOf, parseIso } from './util';
import { meanRange, passesUpTo, sumRange } from './liveDb';

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
  /** Mean temperature over the last 2 weeks and the resulting egg-to-adult time for Aedes. */
  meanTempC: number;
  devDays: number;
  /** Prevention index per ward (no case data used). */
  prevention: Map<number, PreventionResult>;
  /** True when no case records are loaded (KMC feed not connected). */
  noCases: boolean;
}

export const isActiveWater = (d: WaterDetection) => d.status === 'New' || d.status === 'Confirmed';
/** Days left before water at this spot can produce adult mosquitoes (negative = window passed). */
export const daysLeft = (d: WaterDetection, today: string, meanTempC: number) => daysToClear(d.waterSince, today, meanTempC);

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

  // standing water: active hotspots per ward, weighted by confidence (confirmed = 1)
  const today = isBacktest ? addDays(horizonEnd, -1) : db.asOf;
  const water = new Map<number, WardWater>();
  for (const w of db.wards) water.set(w.ward, { active: 0, urgent: 0, pastWindow: 0, index: 0 });
  const areaByWard = new Map(db.wards.map((w) => [w.ward, w.areaKm2]));
  for (const d of db.detections ?? []) {
    if (!isActiveWater(d) || d.detectedAt.slice(0, 10) > today || d.waterSince < addDays(today, -30)) continue;
    const acc = water.get(d.ward);
    if (!acc) continue;
    const left = daysToClear(d.waterSince, today, meanT);
    acc.active++;
    if (left >= 0 && left <= 2) acc.urgent++;
    if (left < 0) acc.pastWindow++;
    acc.index += (d.status === 'Confirmed' ? 1 : d.confidence) / Math.max(areaByWard.get(d.ward) ?? 1, 0.5);
  }

  // prevention index inputs (open data; never uses cases)
  const cand = new Map<number, Record<string, number>>();
  for (const c of db.candidates ?? []) {
    const m = cand.get(c.ward) ?? {};
    m[c.cat] = (m[c.cat] ?? 0) + 1;
    cand.set(c.ward, m);
  }
  const pub = db.pub;
  const bw = new Map((pub?.weather?.boroughs ?? []).map((b) => [b.borough, b]));
  const passes = passesUpTo(pub, today);
  const latest = passes.length ? passes[passes.length - 1] : null;
  const latestAge = latest ? daysBetween(latest.pass.date, today) : null;
  const monsoon = passes.filter((h) => { const m = Number(h.pass.date.slice(5, 7)); return m >= 6 && m <= 10; });
  const pockets = new Map<number, number>();
  for (const p of pub?.landscape?.hotspots?.places ?? []) if (p.ward != null) pockets.set(p.ward, (pockets.get(p.ward) ?? 0) + 1);
  const cityRain = (from: string, to: string) => db.rainDaily.filter((r) => r.date >= from && r.date <= to).reduce((x, r) => x + r.mm, 0);
  const prevInputs: PreventionInput[] = db.wards.map((w) => {
    const b = bw.get(w.borough);
    const wc = pub?.landscape?.worldcover?.wards?.[w.ward];
    const wv = latest?.wards?.[w.ward];
    const wetN = monsoon.filter((h) => (h.wards?.[w.ward]?.[0] ?? 0) >= 0.01).length;
    const measured = monsoon.filter((h) => h.wards?.[w.ward]?.[0] != null).length;
    return {
      ward: w.ward, areaKm2: w.areaKm2, population: w.populationSource === 'census2011' || w.populationSource === 'kmc' ? w.population : null,
      rain7: b ? sumRange(b, 'rain', addDays(today, -6), today) : cityRain(addDays(today, -6), today),
      rain28: b ? sumRange(b, 'rain', addDays(today, -27), today) : cityRain(addDays(today, -27), today),
      rainNext3: b && db.live ? sumRange(b, 'rain', addDays(today, 1), addDays(today, 3)) : 0,
      tMean7: (b ? meanRange(b, 'tmean', addDays(today, -6), today) : null) ?? meanT,
      newWaterHa: latestAge != null && latestAge <= 14 ? wv?.[1] ?? null : null,
      passAgeDays: latestAge,
      wetFrequency: measured >= 5 ? wetN / measured : null,
      seasonalWater: pub?.landscape?.water?.wards?.[w.ward]?.seasonal ?? (pub ? null : (db.susceptibility?.[w.ward] ?? 0) / 8),
      bare: wc?.bare ?? null, grass: wc?.grass ?? null, built: wc?.built ?? null,
      candidates: cand.get(w.ward) ?? {},
      reportedPockets: pockets.get(w.ward) ?? 0,
      activeSpots: water.get(w.ward)?.active ?? 0,
    };
  });
  const prevention = preventionIndex(prevInputs);
  const noCases = db.cases.length === 0;

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
      standingWaterIndex: water.get(w.ward)!.index,
    }, cfg);
    const ytd = completeWeeks.reduce((a, wk, i) => a + (wk >= mondayOf(ytdStart) ? series[i] : 0), 0) + (currentWeekCases.get(w.ward) ?? 0);
    stats.set(w.ward, {
      ward: w.ward, borough: w.borough, population: w.population, weekly: series,
      last2w: last2, prev2w: prev2, ytd,
      bi: idx ? idx.BI : null, hi: idx ? idx.HI : null, ci: idx ? idx.CI : null,
      openSites: sitesOpen.get(w.ward) ?? 0,
      openTasks: openTasks.get(w.ward) ?? 0,
      overdueTasks: overdueTasks.get(w.ward) ?? 0,
      water: water.get(w.ward)!,
      risk,
      prevention: prevention.get(w.ward)!,
      candidates: cand.get(w.ward) ?? {},
    });
    const ex = exceedance(w.ward, series, cfg); if (ex) signals.push(ex);
    const en = entomological(w.ward, idx ? idx.BI : null, idx ? idx.HI : null, cfg); if (en) signals.push(en);
    if (noCases) {
      const pv = prevention.get(w.ward)!;
      if (pv.score >= cfg.alerts.predictedRiskScore) {
        const top = [...pv.components].filter((c) => c.key !== 'weather').sort((x, y) => y.value - x.value).slice(0, 2).map((c) => c.label.toLowerCase()).join('; ');
        signals.push({ ward: w.ward, type: 'predicted', level: 'Watch', title: `Very high breeding pressure (${pv.score}/100)`, detail: `Prevention index from open data. Main drivers: ${top}.` });
      }
    } else {
      const pr = predicted(risk, cfg); if (pr) signals.push(pr);
    }
    const wa = water.get(w.ward)!;
    const ws = waterSignal(w.ward, wa.urgent, wa.pastWindow, cfg); if (ws) signals.push(ws);
  }
  signals.push(...clusters(points, todayIndex, cfg));

  const cityWeekly = new Array(n).fill(0);
  const boroughWeekly = new Map<BoroughCode, number[]>(BOROUGHS.map((b) => [b, new Array(n).fill(0)]));
  for (const s of stats.values()) {
    const bw = boroughWeekly.get(s.borough)!;
    s.weekly.forEach((v, i) => { cityWeekly[i] += v; bw[i] += v; });
  }
  return { completeWeeks, currentWeek, stats, currentWeekCases, signals, cityWeekly, boroughWeekly, rainWeekly, config: cfg, meanTempC: meanT, devDays: aedesDevelopmentDays(meanT), prevention, noCases };
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
    maxPrevention: Math.max(...wards.map((s) => s.prevention.score)),
    highPrevention: wards.filter((s) => s.prevention.score >= 50).length,
    candidates: sum((s) => Object.values(s.candidates).reduce((x, y) => x + y, 0)),
    meanBi: hv.length ? hv.reduce((acc, s) => acc + (s.bi ?? 0), 0) / hv.length : null,
    openSites: sum((s) => s.openSites),
    openTasks: sum((s) => s.openTasks),
    overdueTasks: sum((s) => s.overdueTasks),
    waterActive: sum((s) => s.water.active),
    waterUrgent: sum((s) => s.water.urgent),
    waterPast: sum((s) => s.water.pastWindow),
    weekly: a.boroughWeekly.get(b)!,
  };
}

export const LEVEL_ORDER = { Low: 0, Moderate: 1, High: 2, 'Very high': 3 } as const;
