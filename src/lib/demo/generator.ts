// Synthetic demo dataset for KMC's 144 wards / 16 boroughs.
// Every number produced here is SYNTHETIC. It is shaped to look like urban dengue
// seasonality in Kolkata (monsoon-lagged peak in Sep–Oct) so the platform can be
// demonstrated end to end; it is not KMC data and must never be presented as such.
import meta from '@/data/ward-meta.json';
import geo from '@/data/wards.geo.json';
import { SOP, type AlertType } from '@shared/risk-engine';
import { analyse } from '../analytics';
import type {
  Alert, BoroughCode, BreedingSite, CaseSource, CitizenReport, Db, DengueCase, FieldTask,
  LarvalSurvey, Severity, SiteType, TestType, Ward, WeatherWeek,
} from '../types';
import { addDays, binomial, gauss, mondayOf, mulberry32, pick, poisson, pointInGeom, type Rng } from '../util';
import { generateWater } from './water';
import type { RainDay } from '../types';

type GeoFeature = { properties: { ward: number }; geometry: { type: string; coordinates: unknown } };
const GEOMS = new Map<number, GeoFeature['geometry']>(
  (geo as unknown as { features: GeoFeature[] }).features.map((f) => [f.properties.ward, f.geometry]),
);

const START_WEEK = '2025-01-06';
const RAIN = [11, 25, 32, 47, 130, 260, 330, 330, 300, 150, 20, 5]; // Kolkata monthly climatology, mm
const TEMP = [20, 23, 28, 31, 31, 30.5, 29.5, 29.5, 29.5, 28, 24.5, 20.5];
const RH = [65, 62, 62, 68, 73, 82, 86, 86, 84, 78, 70, 67];
const PRONE = new Set([66, 67, 69, 70, 77, 93, 108]); // wards reported as dengue-prone in 2025 press coverage
const BOROUGH_BOOST: Partial<Record<BoroughCode, number>> = { VII: 1.5, VIII: 1.25, IX: 1.2, X: 1.35, XI: 1.2, XII: 1.35 };
const SURGE_2026 = new Set([58, 66, 93, 101, 108, 112]); // synthetic late-season surge wards

export function randomPointInWard(rng: Rng, w: Ward): [number, number] {
  const g = GEOMS.get(w.ward);
  if (!g) {
    return [w.centroid[0] + gauss(rng) * 0.003, w.centroid[1] + gauss(rng) * 0.003];
  }
  const [x0, y0, x1, y1] = w.bbox;
  for (let k = 0; k < 60; k++) {
    const x = x0 + rng() * (x1 - x0);
    const y = y0 + rng() * (y1 - y0);
    if (pointInGeom(x, y, g)) return [x, y];
  }
  return w.centroid;
}

function jitterNear(rng: Rng, lng: number, lat: number, metres: number): [number, number] {
  const r = metres * Math.sqrt(rng());
  const t = 2 * Math.PI * rng();
  return [lng + (r * Math.cos(t)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (r * Math.sin(t)) / 110540];
}

export function generateDemo(asOf: string, seed = 20261113): Db {
  const rng = mulberry32(seed);
  const m = meta as unknown as { wards: Record<string, Omit<Ward, 'population'>> };
  const wards: Ward[] = Object.values(m.wards)
    .map((w) => ({ ...w, population: Math.round((16000 + rng() * 30000) / 10) * 10 }))
    .sort((a, b) => a.ward - b.ward);

  // weeks up to and including the current partial week
  const weeks: string[] = [];
  const lastMonday = mondayOf(asOf);
  for (let w = START_WEEK; w <= lastMonday; w = addDays(w, 7)) weeks.push(w);

  const weather: WeatherWeek[] = weeks.map((w) => {
    const mo = Number(addDays(w, 3).slice(5, 7)) - 1;
    const rain = (RAIN[mo] * 7) / 30.4 * Math.exp(gauss(rng) * 0.6 - 0.18);
    return {
      weekStart: w,
      rainMm: +Math.max(0, rain).toFixed(1),
      tMeanC: +(TEMP[mo] + gauss(rng) * 0.8).toFixed(1),
      rhPct: Math.round(Math.min(97, RH[mo] + gauss(rng) * 3)),
    };
  });
  // synthetic recent rain events (a late-season low-pressure spell), added to the weekly totals
  const EVENTS = [{ back: 9, mm: 64 }, { back: 3, mm: 21 }];
  for (const e of EVENTS) {
    const d = addDays(asOf, -e.back);
    const wk = weather.find((w) => w.weekStart === mondayOf(d));
    if (wk) wk.rainMm = +(wk.rainMm + e.mm).toFixed(1);
  }
  // daily rain for the last 120 days: weekly totals spread over the days, plus the events
  const rainDaily: RainDay[] = [];
  const wxByWeek = new Map(weather.map((w) => [w.weekStart, w]));
  const eventMm = new Map(EVENTS.map((e) => [addDays(asOf, -e.back), e.mm]));
  for (let back = 119; back >= 0; back--) {
    const d = addDays(asOf, -back);
    const wk = wxByWeek.get(mondayOf(d));
    const weekBase = wk ? wk.rainMm - EVENTS.filter((e) => mondayOf(addDays(asOf, -e.back)) === wk.weekStart).reduce((x, e) => x + e.mm, 0) : 0;
    const share = Math.exp(gauss(rng) * 0.9) / 7 / Math.exp(0.405); // mean-preserving lognormal share
    rainDaily.push({ date: d, mm: +Math.max(0, weekBase * share + (eventMm.get(d) ?? 0)).toFixed(1) });
  }

  // transmission suitability, driven by lagged rain and temperature
  const S = weeks.map((_, t) => {
    let lag = 0;
    for (let k = 2; k <= 6; k++) lag += t - k >= 0 ? weather[t - k].rainMm : 0;
    const temp = Math.exp(-(((weather[t].tMeanC - 29) / 4.5) ** 2));
    return 0.12 + 1.6 * Math.pow(lag / 400, 1.4) * temp;
  });

  const prop = new Map<number, number>();
  for (const w of wards) {
    let p = Math.exp(gauss(rng) * 0.55);
    if (PRONE.has(w.ward)) p *= 2.2;
    p *= BOROUGH_BOOST[w.borough] ?? 1;
    prop.set(w.ward, p);
  }
  const yearFactor = (t: number, ward: number) => {
    const wk = weeks[t];
    if (wk < '2026-01-01') return 1;
    const surge = SURGE_2026.has(ward) && wk >= '2026-09-07' ? 1.7 : 1;
    return 0.92 * surge;
  };

  // calibrate so that 2025 has ~1,250 synthetic cases
  let expected2025 = 0;
  weeks.forEach((wk, t) => {
    if (wk >= '2026-01-01') return;
    for (const w of wards) expected2025 += prop.get(w.ward)! * (w.population / 30000) * S[t];
  });
  const base = 1250 / (expected2025 * 1.25);

  const elapsedFrac = (Math.min(6, Math.max(0, (Date.parse(asOf) - Date.parse(lastMonday)) / 86400000)) + 1) / 7;
  const cases: DengueCase[] = [];
  const prevWeek = new Map<number, number>(wards.map((w) => [w.ward, 0]));
  const recentPts = new Map<number, [number, number][]>(wards.map((w) => [w.ward, []]));
  const TESTS: TestType[] = ['NS1', 'IgM', 'NS1 + IgM', 'RT-PCR'];
  const SOURCES: CaseSource[] = ['Private lab', 'KMC lab', 'Govt hospital', 'Private hospital', 'IHIP'];
  const AGES = ['0–4', '5–14', '15–24', '25–44', '45–59', '60+'];
  const SEV: Severity[] = ['Dengue', 'Dengue with warning signs', 'Severe dengue'];
  let caseNo = 0;
  weeks.forEach((wk, t) => {
    const thisWeek = new Map<number, number>();
    for (const w of wards) {
      const nbPrev = w.neighbours.reduce((a, nb) => a + (prevWeek.get(nb) ?? 0), 0);
      let lambda = base * prop.get(w.ward)! * (w.population / 30000) * S[t] * yearFactor(t, w.ward) *
        (1 + 0.18 * Math.min(prevWeek.get(w.ward) ?? 0, 8)) * (1 + 0.03 * Math.min(nbPrev, 20));
      if (wk === lastMonday) lambda *= elapsedFrac;
      const k = poisson(rng, Math.min(lambda, 9));
      thisWeek.set(w.ward, k);
      const pts = recentPts.get(w.ward)!;
      for (let i = 0; i < k; i++) {
        const maxDay = wk === lastMonday ? Math.max(0, Math.round((Date.parse(asOf) - Date.parse(wk)) / 86400000)) : 6;
        const day = Math.floor(rng() * (maxDay + 1));
        const reportedOn = addDays(wk, day);
        let pt: [number, number];
        if (pts.length && rng() < 0.55) {
          const anchor = pts[Math.floor(rng() * pts.length)];
          pt = jitterNear(rng, anchor[0], anchor[1], 120);
        } else pt = randomPointInWard(rng, w);
        pts.push(pt);
        caseNo++;
        cases.push({
          id: `C${String(caseNo).padStart(5, '0')}`,
          ward: w.ward,
          reportedOn,
          onsetOn: addDays(reportedOn, -(2 + Math.floor(rng() * 5))),
          test: pick(rng, TESTS, [45, 25, 25, 5]),
          source: pick(rng, SOURCES, [35, 25, 15, 20, 5]),
          ageBand: pick(rng, AGES, [6, 16, 22, 32, 15, 9]),
          sex: pick(rng, ['M', 'F', 'Other'] as const, [53, 46.5, 0.5]),
          lng: +pt[0].toFixed(6), lat: +pt[1].toFixed(6),
          hospitalised: rng() < 0.18,
          severity: pick(rng, SEV, [80, 17, 3]),
          dedupeKey: `demo-${caseNo}`,
        });
      }
      if (pts.length > 12) pts.splice(0, pts.length - 12);
    }
    for (const [w, k] of thisWeek) prevWeek.set(w, k);
  });

  // weekly larval surveys, one per ward
  const surveys: LarvalSurvey[] = [];
  let sNo = 0;
  weeks.forEach((wk, t) => {
    for (const w of wards) {
      const date = addDays(wk, 1 + Math.floor(rng() * 4));
      if (date > asOf) continue;
      const houses = 150 + Math.floor(rng() * 200);
      const hiTrue = Math.min(40, (1.2 + 6.5 * Math.pow(S[Math.max(0, t - 1)], 0.9) * Math.pow(prop.get(w.ward)!, 0.45)) * Math.exp(gauss(rng) * 0.25));
      const hp = binomial(rng, houses, hiTrue / 100);
      const ci = Math.round(houses * (1.4 + rng() * 0.6));
      const cp = Math.min(ci, Math.round(hp * (1.2 + rng() * 0.8)));
      sNo++;
      surveys.push({ id: `S${sNo}`, ward: w.ward, date, team: `VCT-${w.ward}-A`, housesVisited: houses, housesPositive: hp, containersInspected: ci, containersPositive: cp });
    }
  });

  // breeding sites currently on record
  const SITE_TYPES: SiteType[] = ['Construction site', 'Overhead / roof tank', 'Discarded tyres', 'Vacant plot / garbage', 'Waterlogging', 'Abandoned building', 'Drain / canal', 'Pond / water body', 'Flower pots / coolers'];
  const sites: BreedingSite[] = [];
  const sNow = S[S.length - 1];
  let bNo = 0;
  for (const w of wards) {
    const k = poisson(rng, 1.5 + 5 * sNow * Math.sqrt(prop.get(w.ward)!));
    for (let i = 0; i < k; i++) {
      const [lng, lat] = randomPointInWard(rng, w);
      const type = pick(rng, SITE_TYPES, [18, 14, 10, 16, 10, 8, 10, 6, 8]);
      const status = pick(rng, ['Open', 'Treated', 'Closed'] as const, [55, 35, 10]);
      const firstSeen = addDays(asOf, -Math.floor(rng() * 60));
      bNo++;
      sites.push({
        id: `B${bNo}`, ward: w.ward, type, lat: +lat.toFixed(6), lng: +lng.toFixed(6), status,
        detectedBy: pick(rng, ['Field team', 'Drone', 'Citizen'] as const, [70, 15, 15]),
        firstSeen,
        lastActionOn: status === 'Open' ? undefined : addDays(firstSeen, 1 + Math.floor(rng() * 7)),
        description: `${type} reported in ward ${w.ward}`,
      });
    }
  }

  const teams: Record<number, string[]> = {};
  for (const w of wards) teams[w.ward] = [`VCT-${w.ward}-A`, `VCT-${w.ward}-B`];

  const KINDS = ['Stagnant water', 'Garbage dump', 'Fever in neighbourhood', 'Mosquito nuisance'] as const;
  const citizen: CitizenReport[] = Array.from({ length: 28 }, (_, i) => {
    const w = pick(rng, wards);
    const kind = pick(rng, KINDS, [45, 25, 15, 15]);
    return {
      id: `R${i + 1}`, ward: w.ward, kind,
      reportedAt: new Date(Date.parse(asOf) - Math.floor(rng() * 10 * 86400000) + 4 * 3600000).toISOString(),
      status: pick(rng, ['New', 'Task created', 'Resolved'] as const, [45, 35, 20]),
      text: kind === 'Stagnant water' ? 'Water collected on roof / open plot for several days' :
        kind === 'Garbage dump' ? 'Garbage and containers dumped near lane' :
        kind === 'Fever in neighbourhood' ? 'Several people with fever in our para' : 'Heavy mosquito presence in the evenings',
    };
  }).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));

  const lastWx = weather.filter((w) => w.weekStart < lastMonday).slice(-2);
  const water = generateWater({
    rng, asOf, wards, rainDaily, teams, pointIn: (w) => randomPointInWard(rng, w),
    meanTempC: lastWx.reduce((x, w) => x + w.tMeanC, 0) / Math.max(1, lastWx.length),
  });
  const db: Db = {
    mode: 'demo', asOf, weeks, wards, weather, cases, surveys, sites, tasks: [], alerts: [], citizen, teams,
    detections: water.detections, passes: water.passes, rainDaily, susceptibility: water.susceptibility,
  };

  // back-fill alerts and tasks for the last three complete weeks
  const thisMonday = lastMonday;
  const nComplete = weeks.filter((w) => w < thisMonday).length;
  const alerts: Alert[] = [];
  const tasks: FieldTask[] = [];
  let aNo = 0;
  let tNo = 0;
  for (let back = 2; back >= 0; back--) {
    const endIndex = nComplete - 1 - back;
    const a = analyse(db, { endIndex });
    const issued = addDays(a.completeWeeks[endIndex], 7); // Monday after the analysed week
    const createdAt = new Date(Date.parse(issued) + 3.5 * 3600000).toISOString(); // 09:00 IST
    for (const s of a.signals) {
      if (s.type === 'predicted' && back > 0) continue;
      aNo++;
      const id = `A${aNo}`;
      // a fresh signal supersedes last week's alert of the same kind in the same ward
      for (const prev of alerts) if (prev.ward === s.ward && prev.type === s.type && prev.status !== 'Closed') prev.status = 'Closed';
      const ageDays = (Date.parse(asOf) - Date.parse(issued)) / 86400000;
      alerts.push({
        id, ward: s.ward, type: s.type, level: s.level, title: s.title, detail: s.detail, createdAt,
        status: back >= 2 ? 'Closed' : back === 1 ? (rng() < 0.35 ? 'Acknowledged' : 'Closed') : (rng() < 0.45 ? 'New' : 'Acknowledged'),
        clusterCentroid: s.clusterCentroid, caseIds: s.caseIds,
      });
      if (back === 0 && alerts[alerts.length - 1].status === 'New') continue; // not yet actioned
      for (const tpl of SOP[s.type as AlertType]) {
        tNo++;
        const due = new Date(Date.parse(createdAt) + tpl.slaHours * 3600000).toISOString();
        let status: FieldTask['status'];
        const r = rng();
        const pastDue = Date.parse(due) < Date.parse(asOf) + 12 * 3600000;
        if (ageDays > 12) status = r < 0.8 ? 'Verified' : r < 0.97 ? 'Done' : 'In progress';
        else if (pastDue) status = r < 0.4 ? 'Verified' : r < 0.86 ? 'Done' : r < 0.96 ? 'In progress' : 'Open';
        else status = r < 0.15 ? 'Done' : r < 0.6 ? 'In progress' : 'Open';
        const done = status === 'Done' || status === 'Verified';
        tasks.push({
          id: `T${tNo}`, ward: s.ward, type: tpl.type, title: tpl.title, priority: tpl.priority, status,
          createdAt, dueAt: due, source: 'Alert', alertId: id, team: teams[s.ward][0],
          completedAt: done ? new Date(Math.min(Date.parse(due) + (rng() - 0.6) * 48 * 3600000, Date.parse(asOf))).toISOString() : undefined,
        });
      }
    }
  }
  db.alerts = alerts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  db.tasks = [...tasks, ...water.tasks];
  return db;
}
