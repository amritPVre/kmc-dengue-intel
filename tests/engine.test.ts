import { describe, expect, it } from 'vitest';
import { clusters, exceedance, forecastWard, indices, scoreWard, entomological } from '@shared/risk-engine';
import { generateDemo } from '@/lib/demo/generator';
import { analyse, boroughSummary } from '@/lib/analytics';
import { BOROUGHS } from '@/lib/types';

const quiet = {
  ward: 1, population: 30000, weeklyCases: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], neighbourCases2w: 0, neighbourPopulation: 120000,
  breteauIndex: 2, houseIndex: 1, openBreedingSites: 0, rainLagMm: 10, meanTempC: 20, meanRhPct: 64, historicalPercentile: 0.2,
};
const hot = { ...quiet, weeklyCases: [1, 1, 2, 2, 3, 3, 4, 5, 6, 8], neighbourCases2w: 20, breteauIndex: 28, houseIndex: 12, openBreedingSites: 8, rainLagMm: 380, meanTempC: 29.5, meanRhPct: 85, historicalPercentile: 0.9 };

describe('risk engine', () => {
  it('scores a quiet winter ward low and a hot monsoon ward very high', () => {
    const q = scoreWard(quiet);
    const h = scoreWard(hot);
    expect(q.level).toBe('Low');
    expect(h.level).toBe('Very high');
    expect(h.drivers[0].contribution).toBeGreaterThan(h.drivers[9].contribution);
  });
  it('forecast band contains the mean and grows with risk', () => {
    const f = forecastWard([2, 3, 4, 5], 0.9);
    expect(f).toHaveLength(4);
    for (const p of f) expect(p.lo <= p.mean && p.mean <= p.hi).toBe(true);
    expect(f[3].mean).toBeGreaterThan(f[0].mean);
  });
  it('flags exceedance only above mean + 2 SD', () => {
    expect(exceedance(1, [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1])).toBeNull();
    expect(exceedance(1, [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 7])?.type).toBe('exceedance');
  });
  it('finds a 3-case cluster within 200 m and ignores scattered cases', () => {
    const pts = [
      { id: 'a', ward: 66, lat: 22.5324, lng: 88.3861, dayIndex: 100 },
      { id: 'b', ward: 66, lat: 22.5330, lng: 88.3866, dayIndex: 103 },
      { id: 'c', ward: 66, lat: 22.5320, lng: 88.3858, dayIndex: 105 },
      { id: 'd', ward: 10, lat: 22.60, lng: 88.37, dayIndex: 104 },
    ];
    const c = clusters(pts, 106);
    expect(c).toHaveLength(1);
    expect(c[0].caseIds?.sort()).toEqual(['a', 'b', 'c']);
    expect(clusters(pts, 130)).toHaveLength(0);
  });
  it('computes WHO larval indices', () => {
    const r = indices(200, 20, 300, 45);
    expect(r.HI).toBeCloseTo(10);
    expect(r.CI).toBeCloseTo(15);
    expect(r.BI).toBeCloseTo(22.5);
    expect(entomological(1, r.BI, r.HI)?.level).toBe('Warning');
  });
});

describe('demo data + analytics', () => {
  const db = generateDemo('2026-11-13');
  const a = analyse(db);
  it('covers 144 wards in 16 boroughs', () => {
    expect(db.wards).toHaveLength(144);
    expect(new Set(db.wards.map((w) => w.borough)).size).toBe(16);
  });
  it('prints a summary', () => {
    const y2025 = db.cases.filter((c) => c.reportedOn.startsWith('2025')).length;
    const y2026 = db.cases.filter((c) => c.reportedOn.startsWith('2026')).length;
    const levels: Record<string, number> = {};
    for (const s of a.stats.values()) levels[s.risk.level] = (levels[s.risk.level] ?? 0) + 1;
    const sigTypes: Record<string, number> = {};
    for (const s of a.signals) sigTypes[s.type] = (sigTypes[s.type] ?? 0) + 1;
    console.log({ cases: db.cases.length, y2025, y2026, surveys: db.surveys.length, sites: db.sites.length, alerts: db.alerts.length, tasks: db.tasks.length,
      lastWeeks: a.cityWeekly.slice(-12), levels, sigTypes, completeWeeks: a.completeWeeks.length, current: a.currentWeek });
    const top = [...a.stats.values()].sort((x, y) => y.risk.score - x.risk.score).slice(0, 5).map((s) => [s.ward, s.risk.score, s.last2w, s.bi?.toFixed(1)]);
    console.log('top wards', top);
    console.log(BOROUGHS.map((b) => { const s = boroughSummary(a, b); return `${b}:${s.last2w}/${s.highRisk}`; }).join(' '));
    expect(y2025).toBeGreaterThan(600);
  });
});
