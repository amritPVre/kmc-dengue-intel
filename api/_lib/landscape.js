// Ward landscape layers from open global datasets on Planetary Computer, plus Census 2011 population.
//   ESA WorldCover 2021 (10 m land cover, CC BY 4.0)         → built-up, bare/vacant, grass, trees, water, wetland
//   JRC Global Surface Water 1984–2021 (30 m, Copernicus)    → permanent and seasonal water
//   Copernicus DEM GLO-30 (30 m surface model)                → ward elevation (includes buildings)
//   Census of India 2011 ward population (Primary Census Abstract, via Wikipedia ward articles)
import { KMC_BBOX, fetchJson, round } from './util.js';
import { searchItems, polygonStats, categoryShares } from './pc.js';
import { wardFeatures, wards } from './geo.js';

const WC = { 10: 'tree', 20: 'shrub', 30: 'grass', 40: 'crop', 50: 'built', 60: 'bare', 80: 'water', 90: 'wetland', 95: 'mangrove' };

async function firstItem(collection, extra = {}) {
  const items = await searchItems({ collection, bbox: KMC_BBOX, maxItems: 10, ...extra });
  if (!items.length) throw new Error(`no ${collection} item over Kolkata`);
  return items[0];
}

export async function worldCover() {
  const it = await firstItem('esa-worldcover', { datetime: '2021-01-01T00:00:00Z/2021-12-31T23:59:59Z' });
  const { stats, errors } = await polygonStats('esa-worldcover', it.id, { assets: 'map', categorical: 'true', c: Object.keys(WC) }, wardFeatures(), { batch: 12, concurrency: 5 });
  const out = {};
  for (const [id, s] of stats) {
    const sh = categoryShares(s);
    if (!sh) continue;
    const o = {};
    for (const [code, name] of Object.entries(WC)) o[name] = round(sh[code] ?? 0, 4);
    out[Number(String(id).slice(1))] = o;
  }
  return { item: it.id, wards: out, errors };
}

export async function surfaceWater() {
  const it = await firstItem('jrc-gsw');
  const edges = [0, 1, 10, 50, 75, 100.5];
  const { stats, errors } = await polygonStats('jrc-gsw', it.id, { assets: 'occurrence', histogram_bins: edges.join(','), nodata: 255 }, wardFeatures(), { batch: 12, concurrency: 5 });
  const out = {};
  for (const [id, s] of stats) {
    if (!s?.histogram) continue;
    const [counts] = s.histogram;
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    out[Number(String(id).slice(1))] = {
      seasonal: round((counts[1] + counts[2]) / total, 4), // water in 1–50 % of observations
      frequent: round(counts[3] / total, 4), // 50–75 %
      permanent: round(counts[4] / total, 4), // ≥ 75 %
    };
  }
  return { item: it.id, wards: out, errors };
}

export async function elevation() {
  const it = await firstItem('cop-dem-glo-30');
  const { stats, errors } = await polygonStats('cop-dem-glo-30', it.id, { assets: 'data', p: [10, 50] }, wardFeatures(), { batch: 12, concurrency: 5 });
  const out = {};
  for (const [id, s] of stats) {
    if (!s) continue;
    out[Number(String(id).slice(1))] = { mean: round(s.mean, 2), p10: round(s.percentile_10 ?? s.min, 2), p50: round(s.percentile_50 ?? s.median, 2) };
  }
  return { item: it.id, wards: out, errors };
}

/** Census 2011 ward population, read from each ward's Wikipedia infobox (source: Census PCA). */
export async function population() {
  const titles = wards().list.filter((w) => w.ward <= 141).map((w) => `Ward No. ${w.ward}, Kolkata Municipal Corporation`);
  const out = {};
  const missing = [];
  for (let i = 0; i < titles.length; i += 50) {
    const u = new URL('https://en.wikipedia.org/w/api.php');
    u.search = new URLSearchParams({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', format: 'json', formatversion: '2', redirects: '1', titles: titles.slice(i, i + 50).join('|') }).toString();
    const j = await fetchJson(u.toString(), {}, { label: 'Wikipedia API', timeoutMs: 30000 });
    for (const p of j.query?.pages || []) {
      const m = /Ward No\. (\d+)/.exec(p.title || '');
      if (!m) continue;
      const text = p.revisions?.[0]?.slots?.main?.content || '';
      const pm = /population_total\s*=\s*([\d,]+)/.exec(text) || /total population of ([\d,]+)/.exec(text);
      const n = pm ? Number(pm[1].replace(/,/g, '')) : null;
      if (n && n > 1000 && n < 300000) out[Number(m[1])] = n;
      else missing.push(Number(m[1]));
    }
  }
  return { source: 'Census of India 2011, Primary Census Abstract (ward-wise), as given in Wikipedia ward articles', wards: out, missing: missing.sort((a, b) => a - b) };
}

/** Geocodes the publicly reported waterlogging pockets and KMC rain-gauge stations (OpenStreetMap Nominatim, 1 request/second). */
export async function hotspots() {
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const { wardAt, wards: allWards } = await import('./geo.js');
  const root = process.cwd();
  const list = JSON.parse(fs.readFileSync(path.join(root, 'src/data/public-hotspots.json'), 'utf8'));
  const reports = JSON.parse(fs.readFileSync(path.join(root, 'src/data/public-reports.json'), 'utf8'));
  const geocode = async (queries) => {
    for (const q of queries) {
      const u = new URL('https://nominatim.openstreetmap.org/search');
      u.search = new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'in', viewbox: '88.22,22.66,88.51,22.44', bounded: '1' }).toString();
      let hit = null;
      try { hit = (await fetchJson(u.toString(), {}, { label: 'Nominatim', timeoutMs: 15000, retries: 1 }))[0] || null; } catch { hit = null; }
      await new Promise((r) => setTimeout(r, 1100));
      if (hit) return hit;
    }
    return null;
  };
  const W = allWards().byWard;
  const locate = async (queries, fixedWard) => {
    const hit = await geocode(queries);
    let lat = hit ? Number(hit.lat) : null;
    let lng = hit ? Number(hit.lon) : null;
    let ward = fixedWard ?? (lat != null ? wardAt(lng, lat) : null);
    let matched = hit?.display_name?.split(',').slice(0, 3).join(',') ?? null;
    if (lat == null && ward != null && W.get(ward)) { [lng, lat] = W.get(ward).centroid; matched = `centre of ward ${ward}`; }
    return { lat, lng, ward, matched };
  };
  const places = [];
  for (const p of list.places) places.push({ name: p.name, sources: p.sources, ...(await locate(p.queries ?? [p.query], p.ward)) });
  const gauges = [];
  const seen = new Set();
  for (const ev of reports.rainEvents ?? []) {
    for (const r of ev.readings) {
      if (seen.has(r.station)) continue;
      seen.add(r.station);
      const loc = await locate(r.queries ?? [r.query]);
      gauges.push({ station: r.station, ...loc, borough: loc.ward != null ? W.get(loc.ward)?.borough ?? null : null });
    }
  }
  return { source: 'Named in KMC statements and press reports; located with OpenStreetMap Nominatim', places, gauges, sources: list.sources };
}
