// GET /api/osm → breeding-site candidates from OpenStreetMap, assigned to wards (refreshed weekly).
import { send, sendError } from './_lib/util.js';
import { cached } from './_lib/store.js';
import { fetchCandidates } from './_lib/osm.js';


export default async function handler(req, res) {
  try {
    const r = await cached('osm:candidates', 24 * 7, fetchCandidates, 'OpenStreetMap Overpass');
    send(res, { ...r.data, updatedAt: r.updatedAt, stale: Boolean(r.stale), licence: '© OpenStreetMap contributors, ODbL 1.0' }, { sMaxAge: 86400, swr: 86400 * 7 });
  } catch (e) {
    sendError(res, e, 'osm');
  }
}
