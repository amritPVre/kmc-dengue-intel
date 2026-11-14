// Microsoft Planetary Computer: STAC search + per-polygon raster statistics (TiTiler).
// No account needed. Raster maths runs on Planetary Computer's servers, so the functions
// only exchange small JSON documents.
import { chunk, fetchJson, pool } from './util.js';

export const PC_STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1';
export const PC_DATA = 'https://planetarycomputer.microsoft.com/api/data/v1';

/** STAC item search with pagination. Returns raw STAC items. */
export async function searchItems({ collection, bbox, datetime, query, limit = 100, maxItems = 400, sortDesc = true }) {
  const body = { collections: [collection], bbox, datetime, limit, ...(query ? { query } : {}), ...(sortDesc ? { sortby: [{ field: 'datetime', direction: 'desc' }] } : {}) };
  const items = [];
  let url = `${PC_STAC}/search`;
  let payload = body;
  for (let page = 0; page < 10 && items.length < maxItems; page++) {
    const fc = await fetchJson(url, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }, { label: 'Planetary Computer STAC' });
    items.push(...(fc.features || []));
    const next = (fc.links || []).find((l) => l.rel === 'next');
    if (!next || !(fc.features || []).length) break;
    url = next.href;
    payload = next.body ? { ...payload, ...next.body } : payload;
    if ((next.method || 'GET').toUpperCase() === 'GET') {
      const fc2 = await fetchJson(next.href, {}, { label: 'Planetary Computer STAC' });
      items.push(...(fc2.features || []));
      break;
    }
  }
  return items.slice(0, maxItems);
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => u.append(k, String(x)));
    else u.append(k, String(v));
  }
  return u.toString();
}

/** Picks the band statistics object from a TiTiler statistics response. */
function bandStats(props) {
  const s = props && props.statistics;
  if (!s) return null;
  const k = Object.keys(s)[0];
  return k ? s[k] : null;
}

async function statsOnce(collection, item, params, features) {
  const url = `${PC_DATA}/item/statistics?${qs({ collection, item, ...params })}`;
  const fc = await fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'FeatureCollection', features }),
  }, { timeoutMs: 90000, retries: 2, label: `Planetary Computer statistics (${collection})` });
  const out = new Map();
  const feats = fc.type === 'FeatureCollection' ? fc.features : [fc];
  feats.forEach((f, i) => {
    const id = f.properties?.id ?? features[i]?.properties?.id;
    out.set(id, bandStats(f.properties));
  });
  return out;
}

/**
 * Statistics for many polygons on one item. Batches the polygons; if a batch fails (for example a
 * polygon outside the image footprint), retries its polygons one by one and records null for failures.
 */
export async function polygonStats(collection, item, params, features, { batch = 12, concurrency = 4 } = {}) {
  const result = new Map();
  const errors = [];
  await pool(chunk(features, batch), concurrency, async (group) => {
    try {
      for (const [k, v] of await statsOnce(collection, item, params, group)) result.set(k, v);
    } catch (e) {
      await pool(group, 2, async (f) => {
        try {
          for (const [k, v] of await statsOnce(collection, item, params, [f])) result.set(k, v);
        } catch (e2) {
          result.set(f.properties.id, null);
          errors.push(String(e2.message || e2).slice(0, 160));
        }
      });
      // The batch error is not recorded when every ward succeeded on its own retry.
    }
  });
  return { stats: result, errors: errors.slice(0, 5) };
}

/** Fraction of valid pixels in histogram bins whose upper edge is <= `upTo`. */
export function fractionBelow(s, upTo) {
  if (!s || !s.histogram) return null;
  const [counts, edges] = s.histogram;
  const valid = s.valid_pixels ?? counts.reduce((a, b) => a + b, 0);
  if (!valid) return null;
  let n = 0;
  for (let i = 0; i < counts.length; i++) if (edges[i + 1] <= upTo * (1 + 1e-5) + 1e-12) n += counts[i];
  return n / valid;
}

/** Category shares from a categorical histogram: { [category]: share }. */
export function categoryShares(s) {
  if (!s || !s.histogram) return null;
  const [counts, cats] = s.histogram;
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const out = {};
  cats.forEach((c, i) => { out[String(Math.round(Number(c)))] = counts[i] / total; });
  return out;
}

/** Tile URL template for Leaflet (rendered by Planetary Computer). */
export function tileUrl(collection, item, params) {
  return `${PC_DATA}/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?${qs({ collection, item, ...params })}`;
}
