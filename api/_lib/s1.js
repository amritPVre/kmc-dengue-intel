// Sentinel-1 radar water detection over KMC, computed on Planetary Computer (sentinel-1-rtc).
//
// Method (per pass):
//   1. For every ward, the share of 10 m pixels with VV backscatter below -16 dB (open water and
//      waterlogged ground return very little radar energy).
//   2. The same share on a dry-season pass from the same orbit (Feb–Apr). Ponds, lakes, the river,
//      smooth roads and radar shadow are dark in both and cancel out.
//   3. New water = wet share − dry share. Wards with ≥ 2 ha of new water are flagged.
//   4. Flagged wards are split into 250 m cells and steps 1–3 are repeated per cell, which gives the
//      locations field teams are sent to.
// Limits: radar under-detects water in narrow streets between tall buildings (it can even brighten);
// the method is strongest on open ground, vacant plots, construction sites, parks and the added areas.
import { KMC_BBOX, addDays, round } from './util.js';
import { searchItems, polygonStats, fractionBelow, tileUrl } from './pc.js';
import { pointInGeom, wardFeatures, wardCells, wards } from './geo.js';
import { getLayer, putLayer, listLayers } from './store.js';

export const COLLECTION = 'sentinel-1-rtc';
export const WATER_DB = -16;
const lin = (db) => 10 ** (db / 10);
export const EDGES = [0, lin(-20), lin(-18), lin(-16), lin(-14), lin(-12), 1000].map((x) => +x.toPrecision(6));
const PARAMS = { assets: 'vv', histogram_bins: EDGES.join(','), nodata: -32768 };
export const RULES = { wardMinHa: 2, wardMinFrac: 0.01, maxWards: 6, cellM: 250, cellMinFrac: 0.12, cellMinWet: 0.2, maxSpots: 40 };
const KMC_CENTRE = [88.36, 22.55];

const passOf = (it) => ({
  id: it.id,
  datetime: it.properties.datetime,
  date: it.properties.datetime.slice(0, 10),
  platform: (it.properties.platform || '').replace('SENTINEL-', 'Sentinel-').replace('sentinel-', 'Sentinel-'),
  orbit: it.properties['sat:relative_orbit'] ?? null,
  state: it.properties['sat:orbit_state'] ?? null,
});

/** Sentinel-1 passes whose footprint contains central Kolkata, newest first. */
export async function listPasses(from, to) {
  const items = await searchItems({ collection: COLLECTION, bbox: KMC_BBOX, datetime: `${from}T00:00:00Z/${to}T23:59:59Z`, maxItems: 300 });
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!pointInGeom(KMC_CENTRE[0], KMC_CENTRE[1], it.geometry)) continue;
    const p = passOf(it);
    const k = `${p.date}:${p.orbit}:${p.state}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** A dry-season (Feb–Apr) pass from the same orbit, for the year of the given date. */
export async function baselineFor(pass) {
  const yr = Number(pass.date.slice(0, 4));
  const years = Number(pass.date.slice(5, 7)) <= 4 ? [yr - 1] : [yr, yr - 1];
  for (const y of years) {
    const key = `s1base:${pass.orbit}:${pass.state}:${y}`;
    const hit = await getLayer(key);
    if (hit?.data?.id) return hit.data;
    const query = {};
    if (pass.orbit != null) query['sat:relative_orbit'] = { eq: pass.orbit };
    if (pass.state) query['sat:orbit_state'] = { eq: pass.state };
    const items = await searchItems({ collection: COLLECTION, bbox: KMC_BBOX, datetime: `${y}-02-01T00:00:00Z/${y}-04-30T23:59:59Z`, query, maxItems: 40 });
    const cands = items.filter((it) => pointInGeom(KMC_CENTRE[0], KMC_CENTRE[1], it.geometry)).map(passOf);
    if (!cands.length) continue;
    // late March–April is the driest stretch before pre-monsoon storms; take the one nearest 1 April
    cands.sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(`${y}-04-01`)) - Math.abs(Date.parse(b.date) - Date.parse(`${y}-04-01`)));
    const base = cands[0];
    await putLayer(key, base, 'Planetary Computer sentinel-1-rtc');
    return base;
  }
  return null;
}

async function wardShares(itemId) {
  const { stats, errors } = await polygonStats(COLLECTION, itemId, PARAMS, wardFeatures(), { batch: 12, concurrency: 5 });
  const out = {};
  for (const [id, s] of stats) {
    const w = Number(String(id).slice(1));
    out[w] = s ? { wet: round(fractionBelow(s, lin(WATER_DB)), 5), deep: round(fractionBelow(s, lin(-18)), 5), px: s.valid_pixels ?? null } : null;
  }
  return { shares: out, errors };
}

async function baselineShares(base) {
  const key = `s1basestats:${base.id}`;
  const hit = await getLayer(key);
  if (hit?.data?.shares) return hit.data.shares;
  const { shares } = await wardShares(base.id);
  await putLayer(key, { shares }, 'Planetary Computer sentinel-1-rtc');
  return shares;
}

async function cellShares(itemId, ward, cells) {
  const { stats } = await polygonStats(COLLECTION, itemId, PARAMS, cells, { batch: 20, concurrency: 6 });
  const out = new Map();
  for (const c of cells) out.set(c.properties.id, fractionBelow(stats.get(c.properties.id), lin(WATER_DB)));
  return out;
}

/** Full processing of one pass; result is stored under `s1pass:<date>:<id>`. */
export async function processPass(pass) {
  const t0 = Date.now();
  const base = await baselineFor(pass);
  const [{ shares: wet, errors }, dry] = await Promise.all([wardShares(pass.id), base ? baselineShares(base) : Promise.resolve({})]);
  const W = wards().byWard;
  const wardOut = {};
  const flagged = [];
  for (const [k, v] of Object.entries(wet)) {
    const ward = Number(k);
    if (!v || v.wet == null) { wardOut[ward] = null; continue; }
    const d = dry?.[ward]?.wet ?? null;
    const newFrac = d == null ? null : Math.max(0, v.wet - d);
    const area = W.get(ward)?.areaKm2 ?? 0;
    const newHa = newFrac == null ? null : newFrac * area * 100;
    wardOut[ward] = { wet: v.wet, dry: d, newFrac: round(newFrac, 5), newHa: round(newHa, 2) };
    if (newHa != null && newHa >= RULES.wardMinHa && newFrac >= RULES.wardMinFrac) flagged.push({ ward, newHa });
  }
  flagged.sort((a, b) => b.newHa - a.newHa);
  const spots = [];
  if (base) {
    for (const { ward } of flagged.slice(0, RULES.maxWards)) {
      if (Date.now() - t0 > 200000) break; // keep inside the function time limit
      const cells = wardCells(ward, RULES.cellM);
      if (!cells.length) continue;
      const [cw, cd] = await Promise.all([cellShares(pass.id, ward, cells), cellShares(base.id, ward, cells)]);
      for (const c of cells) {
        const a = cw.get(c.properties.id);
        const b = cd.get(c.properties.id);
        if (a == null || b == null) continue;
        const nf = a - b;
        if (nf >= RULES.cellMinFrac && a >= RULES.cellMinWet) {
          spots.push({ ward, lat: c.properties.lat, lng: c.properties.lng, newFrac: round(nf, 3), wet: round(a, 3), areaHa: round(nf * c.properties.areaHa, 2) });
        }
      }
    }
  }
  spots.sort((a, b) => b.areaHa - a.areaHa);
  const result = {
    pass, baseline: base, thresholdDb: WATER_DB, rules: RULES,
    wards: wardOut,
    flaggedWards: flagged.map((f) => f.ward),
    spots: spots.slice(0, RULES.maxSpots),
    totals: {
      wardsMeasured: Object.values(wardOut).filter(Boolean).length,
      newWaterHa: round(Object.values(wardOut).reduce((a, v) => a + (v?.newHa ?? 0), 0), 1),
    },
    tiles: {
      radar: tileUrl(COLLECTION, pass.id, { assets: 'vv', rescale: '0,0.3' }),
      water: tileUrl(COLLECTION, pass.id, { assets: 'vv', colormap: JSON.stringify([[[0, lin(WATER_DB)], [0, 120, 255, 210]], [[lin(WATER_DB), 1000], [0, 0, 0, 0]]]) }),
      baselineWater: base ? tileUrl(COLLECTION, base.id, { assets: 'vv', colormap: JSON.stringify([[[0, lin(WATER_DB)], [255, 140, 0, 160]], [[lin(WATER_DB), 1000], [0, 0, 0, 0]]]) }) : null,
    },
    errors,
    seconds: Math.round((Date.now() - t0) / 1000),
    processedAt: new Date().toISOString(),
  };
  await putLayer(`s1pass:${pass.date}:${pass.id}`, result, 'Planetary Computer sentinel-1-rtc');
  return result;
}

export async function processedIds() {
  const rows = await listLayers('s1pass:', { meta: true, limit: 1000 });
  return new Set(rows.map((r) => r.key.split(':').slice(2).join(':')));
}

/** Compact per-pass history for charts and chronic-pooling statistics. */
export async function history() {
  const rows = await listLayers('s1pass:', { limit: 1000 });
  return rows.map((r) => {
    const d = r.data;
    const wardsCompact = {};
    for (const [w, v] of Object.entries(d.wards || {})) if (v) wardsCompact[w] = [v.newFrac, v.newHa, v.wet];
    return { pass: d.pass, baseline: d.baseline ? { id: d.baseline.id, date: d.baseline.date } : null, totals: d.totals, flaggedWards: d.flaggedWards, spots: d.spots, wards: wardsCompact, tiles: d.tiles, processedAt: d.processedAt };
  }).sort((a, b) => a.pass.date.localeCompare(b.pass.date));
}

export const seasonStart = (today) => (today.slice(5) >= '06-01' ? `${today.slice(0, 4)}-06-01` : `${Number(today.slice(0, 4)) - 1}-06-01`);
export const defaultFrom = () => '2025-05-01';
export { addDays };
