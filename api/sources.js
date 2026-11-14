// GET /api/sources → live status of every data source the app depends on.
import { fetchJson, send, KMC_BBOX } from './_lib/util.js';
import { hasStore, listLayers } from './_lib/store.js';

async function probe(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - t0, detail };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, detail: String(e.message || e).slice(0, 200) };
  }
}


export default async function handler(req, res) {
  const checks = await Promise.all([
    probe('Open-Meteo weather', async () => {
      const j = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=22.57&longitude=88.36&daily=precipitation_sum&forecast_days=1&timezone=Asia/Kolkata', {}, { timeoutMs: 10000, retries: 0 });
      return `today's forecast rain ${j.daily?.precipitation_sum?.[0] ?? '?'} mm`;
    }),
    probe('Planetary Computer (Sentinel-1/2, land cover)', async () => {
      const j = await fetchJson('https://planetarycomputer.microsoft.com/api/stac/v1/search', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collections: ['sentinel-1-rtc'], bbox: KMC_BBOX, limit: 1, sortby: [{ field: 'datetime', direction: 'desc' }] }),
      }, { timeoutMs: 15000, retries: 0 });
      const d = j.features?.[0]?.properties?.datetime;
      return d ? `latest Sentinel-1 pass over Kolkata: ${d.slice(0, 10)}` : 'no Sentinel-1 items found';
    }),
    probe('OpenStreetMap Overpass', async () => {
      const r = await fetch('https://overpass-api.de/api/status', { headers: { 'user-agent': 'KMC-Dengue-Intelligence/0.3 (BAESS Labs)', accept: 'text/plain' }, signal: AbortSignal.timeout(10000) });
      const t = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return /slots? available/i.test(t) ? 'query slots available' : t.split('\n').slice(0, 3).join(' ').slice(0, 120);
    }),
    probe('Wikipedia (Census 2011 ward population)', async () => {
      const j = await fetchJson('https://en.wikipedia.org/w/api.php?action=query&titles=Ward_No._66,_Kolkata_Municipal_Corporation&format=json&formatversion=2', {}, { timeoutMs: 10000, retries: 0 });
      return j.query?.pages?.[0]?.missing ? 'page missing' : 'reachable';
    }),
  ]);
  const stored = hasStore() ? await listLayers('', { meta: true, limit: 1000 }) : [];
  const groups = {};
  for (const s of stored) {
    const g = s.key.split(':')[0];
    groups[g] = groups[g] || { count: 0, latest: null };
    groups[g].count++;
    if (!groups[g].latest || s.updatedAt > groups[g].latest) groups[g].latest = s.updatedAt;
  }
  send(res, { checkedAt: new Date().toISOString(), database: hasStore(), checks, stored: groups }, { sMaxAge: 120, swr: 600 });
}
