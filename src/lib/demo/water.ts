// SYNTHETIC standing-water detections for the demo: satellite radar and optical passes, drone
// missions, field and citizen photos, flood sensors and the rain + terrain model. Shaped to behave
// like the real pipelines (more open-water patches after heavy rain, rooftop and container finds
// from drones), but every record is invented.
import { aedesDevelopmentDays, daysToClear } from '@shared/risk-engine';
import type { WaterKind } from '@shared/vision';
import type { BoroughCode, DetectionSource, FieldTask, RainDay, SatellitePass, Ward, WaterDetection } from '../types';
import { addDays, gauss, pick, type Rng } from '../util';

const SUSC_BOOST: Partial<Record<BoroughCode, number>> = { VII: 0.15, XI: 0.15, XII: 0.1, XIII: 0.2, XIV: 0.2, XV: 0.15, XVI: 0.25 };

interface Ctx {
  rng: Rng;
  asOf: string;
  wards: Ward[];
  rainDaily: RainDay[];
  meanTempC: number;
  teams: Record<number, string[]>;
  pointIn: (w: Ward) => [number, number];
}

const OBJECTS: Record<string, { label: string; holdsWater: 'yes' | 'unclear' }[]> = {
  'Rooftop water': [{ label: 'water pooled on terrace', holdsWater: 'yes' }, { label: 'uncovered overhead tank', holdsWater: 'yes' }, { label: 'plastic drum', holdsWater: 'yes' }],
  'Water-holding containers': [{ label: 'bucket', holdsWater: 'yes' }, { label: 'flower-pot tray', holdsWater: 'yes' }, { label: 'plastic container', holdsWater: 'unclear' }, { label: 'cooler', holdsWater: 'yes' }],
  'Discarded tyres': [{ label: 'tyre', holdsWater: 'yes' }],
  'Construction site water': [{ label: 'curing water in slab', holdsWater: 'yes' }, { label: 'flooded basement / lift pit', holdsWater: 'yes' }, { label: 'drum', holdsWater: 'yes' }],
};

export function generateWater(c: Ctx) {
  const { rng, asOf, wards } = c;
  const susceptibility: Record<number, number> = {};
  for (const w of wards) susceptibility[w.ward] = Math.min(1, Math.max(0.05, 0.2 + 0.45 * rng() + (SUSC_BOOST[w.borough] ?? 0)));
  const rain = new Map(c.rainDaily.map((r) => [r.date, r.mm]));
  const rainBetween = (from: string, to: string) => { let s = 0; for (let d = from; d <= to; d = addDays(d, 1)) s += rain.get(d) ?? 0; return s; };
  const wettestDay = (from: string, to: string) => { let best = from, mm = -1; for (let d = from; d <= to; d = addDays(d, 1)) if ((rain.get(d) ?? 0) > mm) { mm = rain.get(d) ?? 0; best = d; } return { date: best, mm }; };
  const weighted = wards.map((w) => susceptibility[w.ward] ** 2);
  const pickWard = (pool = wards, weights = weighted) => pick(rng, pool, weights);

  const detections: WaterDetection[] = [];
  const passes: SatellitePass[] = [];
  let n = 0;
  const add = (w: Ward, source: DetectionSource, kind: WaterKind, detectedOn: string, waterSince: string, confidence: number, extra: Partial<WaterDetection> = {}) => {
    const [lng, lat] = c.pointIn(w);
    n++;
    detections.push({
      id: `W${n}`, ward: w.ward, lat: +lat.toFixed(6), lng: +lng.toFixed(6), source, kind,
      detectedAt: new Date(Date.parse(detectedOn) + (6 + rng() * 10) * 3600000).toISOString(),
      waterSince, confidence: +confidence.toFixed(2), status: 'New',
      aedesRisk: kind === 'Rooftop water' || kind === 'Water-holding containers' || kind === 'Discarded tyres' || kind === 'Construction site water' ? 'High'
        : kind === 'Street / open waterlogging' ? 'Low' : 'Medium',
      ...extra,
    });
  };

  // Sentinel-1 radar: every 6 days (1C and 1D alternate); sees open water through cloud
  for (let back = 4, i = 0; back <= 48; back += 6, i++) {
    const date = addDays(asOf, -back);
    const r3 = rainBetween(addDays(date, -3), date);
    const k = Math.round(2 + r3 * 0.45 + rng() * 3);
    const wet = wettestDay(addDays(date, -3), date);
    for (let j = 0; j < k; j++) {
      const w = pickWard();
      const kind = pick(rng, ['Street / open waterlogging', 'Vacant plot pooling', 'Construction site water', 'Stagnant drain / canal'] as const, [35, 40, 15, 10]);
      add(w, 'Satellite radar', kind, date, wet.mm > 10 ? wet.date : addDays(date, -Math.floor(rng() * 4)), 0.55 + rng() * 0.37,
        { sensor: i % 2 ? 'Sentinel-1D' : 'Sentinel-1C', areaM2: Math.round(300 * Math.exp(Math.abs(gauss(rng)) * 1.3)) });
    }
    passes.push({ id: `P-S1-${back}`, sensor: 'Sentinel-1', platform: i % 2 ? 'Sentinel-1D' : 'Sentinel-1C', date, detections: k, status: 'Processed' });
  }
  // Sentinel-2 optical: every 5 days, usable only when clouds allow
  for (let back = 2; back <= 47; back += 5) {
    const date = addDays(asOf, -back);
    const cloud = Math.round(Math.min(95, 5 + rng() * 45 + (rainBetween(addDays(date, -1), date) > 5 ? 40 : 0)));
    let k = 0;
    if (cloud < 35) {
      k = 3 + Math.floor(rng() * 6);
      for (let j = 0; j < k; j++) {
        add(pickWard(), 'Satellite optical', pick(rng, ['Vacant plot pooling', 'Pond / water body edge', 'Stagnant drain / canal'] as const, [50, 30, 20]),
          date, addDays(date, -Math.floor(rng() * 5)), 0.5 + rng() * 0.35, { sensor: rng() < 0.5 ? 'Sentinel-2B' : 'Sentinel-2C', areaM2: Math.round(400 * Math.exp(Math.abs(gauss(rng)))) });
      }
    }
    passes.push({ id: `P-S2-${back}`, sensor: 'Sentinel-2', platform: 'Sentinel-2', date, cloudPct: cloud, detections: k, status: cloud < 35 ? 'Processed' : 'Too cloudy' });
  }
  // NISAR L-band: every 12 days (calibrated products ~72 h after acquisition)
  for (let back = 6; back <= 42; back += 12) {
    const date = addDays(asOf, -back);
    const k = back < 8 ? 0 : 2 + Math.floor(rng() * 4);
    for (let j = 0; j < k; j++) add(pickWard(), 'Satellite radar', pick(rng, ['Vacant plot pooling', 'Pond / water body edge'] as const), date, addDays(date, -1), 0.55 + rng() * 0.3, { sensor: 'NISAR', areaM2: Math.round(600 * Math.exp(Math.abs(gauss(rng)))) });
    passes.push({ id: `P-NI-${back}`, sensor: 'NISAR', platform: 'NISAR (L-band)', date, detections: k, status: back < 8 ? 'Awaiting data' : 'Processed' });
  }
  // Rain + terrain model: after any day with ≥ 40 mm, pockets that usually pool are flagged at once
  for (const r of c.rainDaily) {
    if (r.mm < 40 || r.date < addDays(asOf, -40)) continue;
    const pool = [...wards].sort((x, y) => susceptibility[y.ward] - susceptibility[x.ward]).slice(0, 30);
    for (const w of pool) {
      if (rng() < 0.35) continue;
      add(w, 'Rain + terrain model', pick(rng, ['Street / open waterlogging', 'Vacant plot pooling'] as const, [55, 45]), r.date, r.date, 0.35 + 0.4 * susceptibility[w.ward], { sensor: `${r.mm} mm rain` });
    }
  }
  // KMC flood sensors (FFEWS) at known waterlogging pockets
  for (const r of c.rainDaily) {
    if (r.mm < 40 || r.date < addDays(asOf, -40)) continue;
    for (let j = 0; j < 6; j++) add(pickWard(), 'Flood sensor', 'Street / open waterlogging', r.date, r.date, 0.95, { sensor: `FFEWS node ${100 + Math.floor(rng() * 300)}` });
  }
  // Drone missions: rooftops, tanks, tyres and construction sites in three boroughs
  const missions: { borough: BoroughCode; back: number }[] = [{ borough: 'VII', back: 2 }, { borough: 'X', back: 5 }, { borough: 'XII', back: 9 }, { borough: 'VIII', back: 16 }];
  for (const m of missions) {
    const pool = wards.filter((w) => w.borough === m.borough);
    const date = addDays(asOf, -m.back);
    const k = 8 + Math.floor(rng() * 9);
    for (let j = 0; j < k; j++) {
      const kind = pick(rng, ['Rooftop water', 'Water-holding containers', 'Discarded tyres', 'Construction site water'] as const, [40, 25, 20, 15]);
      const objs = OBJECTS[kind];
      const o = objs[Math.floor(rng() * objs.length)];
      const count = kind === 'Discarded tyres' ? 2 + Math.floor(rng() * 9) : 1 + Math.floor(rng() * 3);
      add(pick(rng, pool), 'Drone AI', kind, date, addDays(date, -(1 + Math.floor(rng() * 5))), 0.6 + rng() * 0.35, {
        sensor: `Drone mission B-${m.borough}-${date.slice(5)}`,
        ai: { model: 'vision', summary: `${count} ${o.label}${count > 1 ? 's' : ''} seen from the air`, objects: [{ label: o.label, count, holdsWater: o.holdsWater }], larvaeVisible: 'unclear', recommendedAction: kind === 'Discarded tyres' ? 'Remove tyres or puncture and stack them under cover' : 'Empty, scrub and cover; larvicide if water must stay', reasons: ['Water visible in an open container', 'Location hard to reach on foot'] },
      });
    }
  }
  // Field and citizen photos analysed by AI
  for (let j = 0; j < 34; j++) {
    const citizen = j % 5 < 2;
    const kind = pick(rng, ['Water-holding containers', 'Rooftop water', 'Construction site water', 'Discarded tyres', 'Vacant plot pooling', 'Stagnant drain / canal'] as const, [30, 15, 15, 12, 15, 13]);
    const date = addDays(asOf, -Math.floor(rng() * 14));
    add(pickWard(wards, wards.map(() => 1)), citizen ? 'Citizen photo AI' : 'Field photo AI', kind, date, addDays(date, -Math.floor(rng() * 3)), 0.55 + rng() * 0.4, {
      ai: { model: 'vision', summary: `${kind} in a ${citizen ? 'resident' : 'field team'} photo`, objects: OBJECTS[kind] ? [{ ...OBJECTS[kind][0], count: 1 + Math.floor(rng() * 4) }] : [], larvaeVisible: rng() < 0.15 ? 'yes' : 'unclear', recommendedAction: 'Inspect within 24 hours and remove the water source', reasons: ['Standing water in an artificial container'] },
    });
  }

  // statuses from age relative to the breeding window
  const dev = aedesDevelopmentDays(c.meanTempC);
  const tasks: FieldTask[] = [];
  let t = 0;
  for (const d of detections) {
    const left = daysToClear(d.waterSince, asOf, c.meanTempC);
    const r = rng();
    const fa = d.source === 'Rain + terrain model' ? 0.3 : d.source === 'Satellite optical' ? 0.18 : d.source === 'Satellite radar' ? 0.14 : 0.08;
    if (d.source === 'Flood sensor') d.status = left < dev - 3 ? 'Cleared' : 'Confirmed';
    else if (left < -3) d.status = r < fa ? 'False alarm' : r < 0.95 ? 'Cleared' : 'Confirmed';
    else if (left < 0) d.status = r < fa ? 'False alarm' : r < 0.78 ? 'Cleared' : r < 0.96 ? 'Confirmed' : 'New';
    else d.status = r < fa ? 'False alarm' : r < 0.12 + fa ? 'Cleared' : r < 0.45 + fa ? 'Confirmed' : 'New';
    if (d.status !== 'New') d.verifiedAt = new Date(Date.parse(d.detectedAt) + (4 + rng() * 30) * 3600000).toISOString();
    if (d.status === 'Cleared') d.clearedOn = addDays(d.waterSince, Math.min(Math.max(1, Math.round(rng() * dev)), Math.max(1, Math.round((Date.parse(asOf) - Date.parse(d.waterSince)) / 86400000))));
    if (d.status === 'Confirmed' && d.source !== 'Flood sensor') {
      t++;
      const clearBy = addDays(d.waterSince, dev - 1);
      const task: FieldTask = {
        id: `TW${t}`, ward: d.ward, type: 'Clear standing water', title: `Clear ${d.kind.toLowerCase()} (${d.source})`, priority: left <= 2 ? 'P1' : 'P2',
        status: rng() < 0.45 ? 'In progress' : 'Open', createdAt: d.verifiedAt!, dueAt: new Date(Date.parse(clearBy) + 12 * 3600000).toISOString(),
        source: 'Alert', team: c.teams[d.ward]?.[0] ?? `VCT-${d.ward}-A`, notes: `Water spot ${d.id}`,
      };
      d.taskId = task.id;
      tasks.push(task);
    }
  }
  passes.sort((a, b) => b.date.localeCompare(a.date));
  detections.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  return { detections, passes, susceptibility, tasks };
}
