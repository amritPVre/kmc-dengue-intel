// Satellite water detection.
//   GET /api/satellite?op=passes          Sentinel-1 passes over Kolkata since May 2025 (+ which are processed) and recent Sentinel-2 scenes
//   GET /api/satellite?op=history         processed passes: per-ward new water, flagged spots, tile URLs
//   GET /api/satellite?op=pass&id=<item>  one processed pass (processes it if it is the latest and not yet done)
//   GET /api/satellite?op=process-next&key=<CRON_SECRET>[&order=oldest]  processes one unprocessed pass (backfill)
import { send, sendError, isAdmin, isoDate, KMC_BBOX } from './_lib/util.js';
import { cached, getLayer, hasStore } from './_lib/store.js';
import { history, listPasses, processPass, processedIds, defaultFrom } from './_lib/s1.js';
import { searchItems, tileUrl } from './_lib/pc.js';


async function passes(force = false) {
  return cached('s1passes', force ? 0 : 6, () => listPasses(defaultFrom(), isoDate()), 'Planetary Computer STAC');
}

async function s2Scenes() {
  return cached('s2scenes', 6, async () => {
    const from = isoDate(Date.now() - 75 * 86400000);
    const items = await searchItems({ collection: 'sentinel-2-l2a', bbox: KMC_BBOX, datetime: `${from}T00:00:00Z/${isoDate()}T23:59:59Z`, query: { 'eo:cloud_cover': { lt: 40 } }, maxItems: 40 });
    const byDate = new Map();
    for (const it of items) {
      const d = it.properties.datetime.slice(0, 10);
      const e = byDate.get(d) || { date: d, platform: it.properties.platform, cloud: [], items: [] };
      e.cloud.push(it.properties['eo:cloud_cover']);
      e.items.push({ id: it.id, tile: it.properties['s2:mgrs_tile'] ?? null, bbox: it.bbox, cloud: it.properties['eo:cloud_cover'] });
      byDate.set(d, e);
    }
    return [...byDate.values()].map((e) => ({
      date: e.date, platform: e.platform, cloud: Math.round(Math.max(...e.cloud)),
      items: e.items.map((i) => ({ ...i, trueColour: tileUrl('sentinel-2-l2a', i.id, { assets: 'visual', asset_bidx: 'visual|1,2,3', nodata: 0 }) })),
    })).sort((a, b) => b.date.localeCompare(a.date));
  }, 'Planetary Computer STAC');
}

export default async function handler(req, res) {
  const op = String(req.query?.op || 'passes');
  try {
    if (op === 'passes') {
      const p = await passes(false);
      const done = await processedIds();
      let s2 = null;
      try { s2 = (await s2Scenes()).data; } catch (e) { s2 = { error: e.message }; }
      send(res, {
        source: 'Copernicus Sentinel-1 RTC (Microsoft Planetary Computer)', fetchedAt: p.updatedAt, store: hasStore(),
        passes: p.data.map((x) => ({ ...x, processed: done.has(x.id) })), sentinel2: s2,
      }, { sMaxAge: 1800, swr: 6 * 3600 });
      return;
    }
    if (op === 'history') {
      send(res, { store: hasStore(), passes: await history() }, { sMaxAge: 900, swr: 3600 });
      return;
    }
    if (op === 'pass') {
      const id = String(req.query.id || '');
      const list = (await passes(false)).data;
      const pass = id ? list.find((x) => x.id === id) : list[0];
      if (!pass) { send(res, { error: 'unknown pass' }, { sMaxAge: 0, status: 404 }); return; }
      const hit = await getLayer(`s1pass:${pass.date}:${pass.id}`);
      if (hit) { send(res, hit.data, { sMaxAge: 86400 * 7 }); return; }
      if (!isAdmin(req) && pass.id !== list[0].id) { send(res, { error: 'pass not processed yet', pass }, { sMaxAge: 0, status: 404 }); return; }
      send(res, await processPass(pass), { sMaxAge: hasStore() ? 86400 * 7 : 3600 * 6 });
      return;
    }
    if (op === 'process-next') {
      if (!isAdmin(req)) { send(res, { error: 'admin key required' }, { sMaxAge: 0, status: 401 }); return; }
      const list = (await passes(req.query.refresh === '1')).data;
      const done = await processedIds();
      const order = req.query.order === 'oldest' ? [...list].reverse() : list;
      const next = order.find((x) => !done.has(x.id));
      if (!next) { send(res, { done: true, processed: done.size, total: list.length }, { sMaxAge: 0 }); return; }
      const r = await processPass(next);
      send(res, { done: false, processed: done.size + 1, total: list.length, pass: next, totals: r.totals, flaggedWards: r.flaggedWards, spots: r.spots.length, errors: r.errors, seconds: r.seconds }, { sMaxAge: 0 });
      return;
    }
    send(res, { error: `unknown op ${op}` }, { sMaxAge: 0, status: 400 });
  } catch (e) {
    sendError(res, e, `satellite:${op}`);
  }
}
