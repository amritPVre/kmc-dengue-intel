// GET /api/landscape → per-ward land cover, surface water, elevation and Census 2011 population.
// Each part is computed once on Planetary Computer / Wikipedia and stored for 30 days.
//   ?part=worldcover|water|elevation|population|hotspots  computes (or returns) only that part.
import { send, sendError } from './_lib/util.js';
import { cached } from './_lib/store.js';
import { elevation, hotspots, population, surfaceWater, worldCover } from './_lib/landscape.js';


const PARTS = {
  worldcover: { key: 'land:worldcover', fn: worldCover, source: 'ESA WorldCover 2021 v200 (CC BY 4.0) via Planetary Computer' },
  water: { key: 'land:jrc-gsw', fn: surfaceWater, source: 'JRC Global Surface Water 1984–2021 via Planetary Computer' },
  elevation: { key: 'land:cop-dem', fn: elevation, source: 'Copernicus DEM GLO-30 via Planetary Computer' },
  population: { key: 'land:population', fn: population, source: 'Census of India 2011 (ward PCA) via Wikipedia' },
  hotspots: { key: 'land:hotspots', fn: hotspots, source: 'KMC statements and press reports, geocoded with OpenStreetMap Nominatim' },
};

export default async function handler(req, res) {
  const only = req.query?.part ? String(req.query.part) : null;
  const names = only ? [only] : Object.keys(PARTS);
  const out = { parts: {} };
  try {
    await Promise.all(names.map(async (n) => {
      const p = PARTS[n];
      if (!p) return;
      try {
        const r = await cached(p.key, 24 * 30, p.fn, p.source);
        out.parts[n] = { source: p.source, updatedAt: r.updatedAt, ...r.data };
      } catch (e) {
        out.parts[n] = { source: p.source, error: e.message };
      }
    }));
    const failed = Object.values(out.parts).filter((p) => p.error).length;
    send(res, out, { sMaxAge: failed ? 300 : 86400, swr: 86400 * 7 });
  } catch (e) {
    sendError(res, e, 'landscape');
  }
}
