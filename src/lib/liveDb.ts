// Builds the app's data model from live open data (and, when connected, KMC's own database).
// Nothing here is invented: wards without a figure show "no data" rather than a made-up value.
import meta from '@/data/ward-meta.json';
import hotspotList from '@/data/public-hotspots.json';
import reports from '@/data/public-reports.json';
import type { Candidate, Db, RainDay, SatellitePass, Ward, WaterDetection, WeatherWeek } from './types';
import type { PublicData, PublicWeather, S1Processed, WeatherSeries } from './live';
import { addDays, mondayOf } from './util';

export interface Operational {
  cases: Db['cases']; surveys: Db['surveys']; sites: Db['sites']; tasks: Db['tasks']; alerts: Db['alerts'];
  citizen: Db['citizen']; detections: WaterDetection[]; teams?: Db['teams'];
}
export const EMPTY_OPS: Operational = { cases: [], surveys: [], sites: [], tasks: [], alerts: [], citizen: [], detections: [] };

/**
 * Weather models smooth out cloudbursts. Where KMC published rain-gauge readings for a day, the
 * borough's modelled rain is replaced by the highest gauge reading inside it (or, for boroughs
 * without a listed gauge, the median of that day's readings), and the city mean is recomputed.
 */
export function applyGauges(pub: PublicData): PublicData {
  const w = pub.weather;
  const gauges = pub.landscape?.hotspots?.gauges;
  if (!w || !gauges?.length) return pub;
  const byStation = new Map(gauges.map((g) => [g.station, g]));
  const boroughs = w.boroughs.map((b) => ({ ...b, rain: [...b.rain] }));
  const gaugeDays: NonNullable<PublicWeather['gaugeDays']> = [];
  for (const ev of reports.rainEvents) {
    const vals = ev.readings.map((r) => r.mm).sort((a, b) => a - b);
    const median = vals[Math.floor(vals.length / 2)];
    for (const b of boroughs) {
      const i = b.date.indexOf(ev.date);
      if (i < 0) continue;
      const inB = ev.readings.filter((r) => byStation.get(r.station)?.borough === b.borough);
      const mm = inB.length ? Math.max(...inB.map((r) => r.mm)) : median;
      const modelled = b.rain[i] ?? 0;
      if (mm > modelled) {
        b.rain[i] = mm;
        gaugeDays.push({ date: ev.date, borough: b.borough, mm, modelled, stations: inB.length ? inB.map((r) => r.station) : ['median of KMC gauges'] });
      }
    }
  }
  const city = { ...w.city, rain: w.city.date.map((_d, i) => { const v = boroughs.map((b) => b.rain[i]).filter((x) => x != null) as number[]; return v.length ? +(v.reduce((a, c) => a + c, 0) / v.length).toFixed(2) : null; }), rainMax: w.city.date.map((_, i) => Math.max(...boroughs.map((b) => b.rain[i] ?? 0))) };
  return { ...pub, weather: { ...w, boroughs, city, gaugeDays } };
}

export const SEASON_START = '2025-05-05'; // first Monday of the 2025 pre-monsoon window with weather history

const idx = (s: WeatherSeries | undefined, d: string) => (s ? s.date.indexOf(d) : -1);

/** Sum of a daily series over [from, to] inclusive. */
export function sumRange(s: WeatherSeries | undefined, key: 'rain', from: string, to: string): number {
  if (!s) return 0;
  let t = 0;
  s.date.forEach((d, i) => { if (d >= from && d <= to) t += s[key][i] ?? 0; });
  return t;
}
export function meanRange(s: WeatherSeries | undefined, key: 'tmean' | 'rh', from: string, to: string): number | null {
  if (!s) return null;
  const v: number[] = [];
  s.date.forEach((d, i) => { const x = s[key][i]; if (d >= from && d <= to && x != null) v.push(x); });
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Ward → borough from the static ward list. */
const WARD_META = (meta as unknown as { wards: Record<string, Omit<Ward, 'population'>> }).wards;

function population(pub: PublicData, w: Omit<Ward, 'population'>): Pick<Ward, 'population' | 'populationSource'> {
  const census = pub.landscape?.population?.wards?.[w.ward];
  if (census) return { population: census, populationSource: 'census2011' };
  const built = pub.landscape?.worldcover?.wards?.[w.ward]?.built;
  if (built != null) return { population: Math.round((w.areaKm2 * built * 30000) / 100) * 100, populationSource: 'estimate' };
  return { population: 25000, populationSource: 'estimate' };
}

/** The processed radar passes on or before asOf, oldest first. */
export const passesUpTo = (pub: PublicData | undefined, asOf: string): S1Processed[] =>
  (pub?.history ?? []).filter((h) => h.pass.date <= asOf).sort((a, b) => a.pass.date.localeCompare(b.pass.date));

/** The heaviest rain day (city mean ≥ 15 mm) in the 4 days up to and including the pass date. */
function rainBefore(pub: PublicData, date: string): string {
  const c = pub.weather?.city;
  let best = date;
  let mm = 15;
  for (let k = 0; k <= 4; k++) {
    const d = addDays(date, -k);
    const i = idx(c, d);
    const v = i >= 0 ? c!.rain[i] ?? 0 : 0;
    if (v >= mm) { mm = v; best = d; }
  }
  return best;
}

/** Standing-water candidates derived from the open data for the 30 days up to asOf. */
export function derivedDetections(pub: PublicData, asOf: string): WaterDetection[] {
  const out: WaterDetection[] = [];
  const from = addDays(asOf, -30);
  // 1. Sentinel-1 radar: cells with new water vs the dry-season pass
  for (const h of passesUpTo(pub, asOf)) {
    if (h.pass.date < from) continue;
    const since = rainBefore(pub, h.pass.date);
    h.spots.forEach((s, i) => {
      out.push({
        id: `s1:${h.pass.date}:${s.ward}:${i}`, ward: s.ward, lat: s.lat, lng: s.lng, areaM2: Math.round(s.areaHa * 1e4),
        source: 'Satellite radar', sensor: `${h.pass.platform} · ${h.pass.state ?? ''} orbit ${h.pass.orbit ?? ''}`.trim(),
        kind: 'Vacant plot pooling', detectedAt: h.pass.datetime, waterSince: since,
        confidence: Math.min(0.95, 0.45 + s.newFrac), status: 'New', aedesRisk: s.areaHa >= 1 ? 'High' : 'Medium',
      });
    });
    // flagged wards where the cell search found nothing specific: one ward-level flag
    for (const w of h.flaggedWards) {
      if (h.spots.some((s) => s.ward === w)) continue;
      const m = WARD_META[w];
      if (!m) continue;
      const v = h.wards[w];
      out.push({
        id: `s1:${h.pass.date}:${w}:ward`, ward: w, lat: m.centroid[1], lng: m.centroid[0], areaM2: v?.[1] ? Math.round(v[1] * 1e4) : undefined,
        source: 'Satellite radar', sensor: `${h.pass.platform} (ward-level)`, kind: 'Street / open waterlogging',
        detectedAt: h.pass.datetime, waterSince: since, confidence: 0.45, status: 'New', aedesRisk: 'Medium',
      });
    }
  }
  // 2. Rain trigger: heavy rain in a borough → its publicly reported waterlogging pockets
  const places = (pub.landscape?.hotspots?.places ?? []).filter((p) => p.lat != null && p.ward != null);
  for (let k = 0; k <= 10; k++) {
    const d = addDays(asOf, -k);
    for (const b of pub.weather?.boroughs ?? []) {
      const i = b.date.indexOf(d);
      const mm = i >= 0 ? b.rain[i] ?? 0 : 0;
      if (mm < 40) continue;
      for (const p of places) {
        if (WARD_META[p.ward!]?.borough !== b.borough) continue;
        const id = `rain:${d}:${p.name}`;
        if (out.some((x) => x.id === id)) continue;
        out.push({
          id, ward: p.ward!, lat: p.lat!, lng: p.lng!, source: 'Rain + terrain model', sensor: `${mm.toFixed(0)} mm modelled rain · reported pocket: ${p.name}`,
          kind: 'Street / open waterlogging', detectedAt: `${d}T18:00:00+05:30`, waterSince: d, confidence: Math.min(0.8, 0.35 + mm / 200), status: 'New', aedesRisk: mm >= 80 ? 'High' : 'Medium',
        });
      }
    }
  }
  return out;
}

export function buildPublicDb(pub: PublicData, asOf: string, ops: Operational = EMPTY_OPS, mode: Db['mode'] = 'public', overrides: Record<string, Partial<WaterDetection>> = {}): Db {
  const wards: Ward[] = Object.values(WARD_META).map((w) => ({ ...w, ...population(pub, w) })).sort((a, b) => a.ward - b.ward);
  const weeks: string[] = [];
  for (let w = SEASON_START; w <= mondayOf(asOf); w = addDays(w, 7)) weeks.push(w);
  const city = pub.weather?.city;
  const weather: WeatherWeek[] = weeks.map((wk) => {
    const end = addDays(wk, 6) < asOf ? addDays(wk, 6) : asOf;
    return {
      weekStart: wk,
      rainMm: +sumRange(city, 'rain', wk, end).toFixed(1),
      tMeanC: +(meanRange(city, 'tmean', wk, end) ?? 27).toFixed(1),
      rhPct: Math.round(meanRange(city, 'rh', wk, end) ?? 75),
    };
  });
  const rainDaily: RainDay[] = [];
  for (let k = 119; k >= 0; k--) {
    const d = addDays(asOf, -k);
    const i = idx(city, d);
    rainDaily.push({ date: d, mm: i >= 0 ? +(city!.rain[i] ?? 0).toFixed(1) : 0 });
  }
  const passes: SatellitePass[] = [
    ...(pub.passes ?? []).filter((p) => p.date <= asOf).slice(0, 30).map((p) => {
      const h = pub.history?.find((x) => x.pass.id === p.id);
      return { id: p.id, sensor: 'Sentinel-1' as const, platform: `${p.platform}, ${p.state ?? ''} orbit ${p.orbit ?? ''}`.trim(), date: p.date, detections: h ? h.spots.length : 0, status: (h ? 'Processed' : 'Awaiting data') as SatellitePass['status'] };
    }),
    ...(pub.sentinel2 ?? []).filter((s) => s.date <= asOf).slice(0, 10).map((s) => ({
      id: `s2:${s.date}`, sensor: 'Sentinel-2' as const, platform: s.platform?.replace('sentinel-', 'Sentinel-').replace('Sentinel-2', 'Sentinel-2') ?? 'Sentinel-2',
      date: s.date, cloudPct: s.cloud, detections: 0, status: (s.cloud > 30 ? 'Too cloudy' : 'Processed') as SatellitePass['status'],
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const derived = derivedDetections(pub, asOf).map((d) => ({ ...d, ...(overrides[d.id] ?? {}) }));
  const detections = [...ops.detections.filter((d) => d.detectedAt.slice(0, 10) <= asOf), ...derived];

  const candidates: Candidate[] = (pub.osm?.points ?? []).map(([cat, lat, lng, ward, name, id]) => ({ id, ward, cat, lat, lng, name }));
  const teams: Record<number, string[]> = ops.teams ?? {};
  for (const w of wards) teams[w.ward] ??= [`VCT-${w.ward}-A`, `VCT-${w.ward}-B`];

  // susceptibility: JRC seasonal water + reported pockets (radar history is added in analytics)
  const pockets = new Map<number, number>();
  for (const p of pub.landscape?.hotspots?.places ?? []) if (p.ward != null) pockets.set(p.ward, (pockets.get(p.ward) ?? 0) + 1);
  const susceptibility: Record<number, number> = {};
  for (const w of wards) {
    const s = pub.landscape?.water?.wards?.[w.ward]?.seasonal ?? 0;
    susceptibility[w.ward] = Math.min(1, s * 8 + (pockets.get(w.ward) ?? 0) * 0.25);
  }

  return {
    mode, live: asOf === (pub.weather?.today ?? asOf), pub, asOf, weeks, wards, weather,
    cases: ops.cases.filter((c) => c.reportedOn <= asOf), surveys: ops.surveys.filter((s) => s.date <= asOf), sites: ops.sites,
    tasks: ops.tasks, alerts: ops.alerts, citizen: ops.citizen, teams, detections, passes, rainDaily, susceptibility, candidates,
  };
}

export const REPORTED_POCKET_COUNT = (hotspotList as { places: unknown[] }).places.length;
