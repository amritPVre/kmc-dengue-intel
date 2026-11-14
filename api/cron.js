// Daily refresh (Vercel Cron, see vercel.json): weather, new Sentinel-1 passes, OpenStreetMap weekly.
// Also callable by an administrator: /api/cron?key=<CRON_SECRET>
import { isAdmin, isoDate, send } from './_lib/util.js';
import { cached, getLayer, putLayer } from './_lib/store.js';
import { recentAndForecast } from './_lib/weather.js';
import { listPasses, processPass, processedIds, defaultFrom } from './_lib/s1.js';
import { fetchCandidates } from './_lib/osm.js';


export default async function handler(req, res) {
  if (!isAdmin(req)) { send(res, { error: 'unauthorised' }, { sMaxAge: 0, status: 401 }); return; }
  const t0 = Date.now();
  const log = [];
  const step = async (name, fn) => {
    try { log.push({ step: name, ok: true, result: await fn() }); } catch (e) { log.push({ step: name, ok: false, error: String(e.message || e).slice(0, 300) }); }
  };
  await step('weather', async () => {
    const w = await recentAndForecast(92);
    await putLayer('weather:recent', w, 'Open-Meteo');
    return `${w.boroughs.length} boroughs, ${w.boroughs[0]?.date?.length ?? 0} days`;
  });
  let list = [];
  await step('sentinel-1 passes', async () => {
    list = await listPasses(defaultFrom(), isoDate());
    await putLayer('s1passes', list, 'Planetary Computer STAC');
    return `${list.length} passes, latest ${list[0]?.date ?? 'none'}`;
  });
  const done = await processedIds();
  for (const p of list.filter((x) => !done.has(x.id)).slice(0, 2)) {
    if (Date.now() - t0 > 150000) break;
    await step(`process ${p.date} ${p.platform}`, async () => {
      const r = await processPass(p);
      return `${r.totals.newWaterHa} ha new water, ${r.flaggedWards.length} wards flagged, ${r.spots.length} spots`;
    });
  }
  const osm = await getLayer('osm:candidates');
  if (!osm || Date.now() - Date.parse(osm.updatedAt) > 7 * 86400000) {
    if (Date.now() - t0 < 120000) await step('openstreetmap', async () => {
      const r = await cached('osm:candidates', 0, fetchCandidates, 'OpenStreetMap Overpass');
      return `${r.data.total} candidates`;
    });
  }
  send(res, { ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), log }, { sMaxAge: 0 });
}
