// Aedes breeding-site candidates mapped in OpenStreetMap (© OpenStreetMap contributors, ODbL).
// These are places to INSPECT, not confirmed breeding sites: tyre and vehicle-repair shops,
// scrap yards and recycling centres, construction sites, markets, plant nurseries, vacant land,
// ponds and drains. Hospitals/clinics and schools are included for case reporting and awareness.
import { fetchJson, KMC_BBOX } from './util.js';
import { wardAt } from './geo.js';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

export const CATEGORIES = {
  tyres: 'Tyre shop / tyre repair',
  vehicle: 'Vehicle repair / garage',
  scrap: 'Scrap yard / recycling / dump',
  construction: 'Construction site',
  market: 'Market',
  nursery: 'Plant nursery',
  vacant: 'Vacant / brownfield land',
  pond: 'Pond / water body',
  drain: 'Drain / canal',
  depot: 'Bus / truck depot',
  health: 'Hospital / clinic',
  school: 'School / college',
};

function categorise(t) {
  if (t.shop === 'tyres' || t.craft === 'tyre_repair' || /tyre|tire/i.test(t.service || '')) return 'tyres';
  if (t.shop === 'car_repair' || t.shop === 'motorcycle_repair' || t.amenity === 'vehicle_inspection') return 'vehicle';
  if (t.industrial === 'scrap_yard' || t.landuse === 'landfill' || t.amenity === 'waste_disposal' || (t.amenity === 'recycling' && t.recycling_type === 'centre') || t.shop === 'scrap') return 'scrap';
  if (t.landuse === 'construction' || t.building === 'construction' || t.construction) return 'construction';
  if (t.amenity === 'marketplace' || t.shop === 'marketplace') return 'market';
  if (t.shop === 'garden_centre' || t.landuse === 'plant_nursery') return 'nursery';
  if (t.landuse === 'brownfield' || t.landuse === 'greenfield' || t.landuse === 'vacant') return 'vacant';
  if (t.natural === 'water' || t.water === 'pond' || t.landuse === 'reservoir' || t.landuse === 'basin') return 'pond';
  if (t.waterway === 'canal' || t.waterway === 'drain' || t.waterway === 'ditch') return 'drain';
  if (t.amenity === 'bus_station' || t.landuse === 'depot' || t.amenity === 'bus_depot') return 'depot';
  if (t.amenity === 'hospital' || t.amenity === 'clinic' || t.healthcare === 'hospital' || t.healthcare === 'clinic' || t.healthcare === 'laboratory') return 'health';
  if (t.amenity === 'school' || t.amenity === 'college') return 'school';
  return null;
}

function query() {
  const [w, s, e, n] = KMC_BBOX;
  const b = `(${s},${w},${n},${e})`;
  return `[out:json][timeout:120];(
nwr["shop"="tyres"]${b};nwr["craft"="tyre_repair"]${b};
nwr["shop"~"^(car_repair|motorcycle_repair)$"]${b};
nwr["industrial"="scrap_yard"]${b};nwr["landuse"="landfill"]${b};nwr["amenity"="waste_disposal"]${b};nwr["amenity"="recycling"]["recycling_type"="centre"]${b};
nwr["landuse"="construction"]${b};way["building"="construction"]${b};
nwr["amenity"="marketplace"]${b};
nwr["shop"="garden_centre"]${b};nwr["landuse"="plant_nursery"]${b};
nwr["landuse"~"^(brownfield|greenfield)$"]${b};
nwr["natural"="water"]${b};nwr["landuse"~"^(reservoir|basin)$"]${b};
way["waterway"~"^(canal|drain|ditch)$"]${b};
nwr["amenity"="bus_station"]${b};nwr["landuse"="depot"]${b};
nwr["amenity"~"^(hospital|clinic)$"]${b};nwr["healthcare"~"^(hospital|clinic|laboratory)$"]${b};
nwr["amenity"~"^(school|college)$"]${b};
);out center tags qt;`;
}

export async function fetchCandidates() {
  let data = null;
  let lastErr = null;
  for (const ep of ENDPOINTS) {
    try {
      data = await fetchJson(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query()), headers: { 'content-type': 'application/x-www-form-urlencoded' } }, { timeoutMs: 150000, retries: 0, label: 'OpenStreetMap Overpass' });
      if (data && Array.isArray(data.elements)) break;
    } catch (e) { lastErr = e; data = null; }
  }
  if (!data) throw lastErr || new Error('Overpass unavailable');
  const points = [];
  const counts = {};
  const seen = new Set();
  for (const el of data.elements) {
    const t = el.tags || {};
    const cat = categorise(t);
    if (!cat) continue;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    const id = `${el.type[0]}${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const ward = wardAt(lng, lat);
    if (ward == null) continue;
    points.push([cat, +lat.toFixed(5), +lng.toFixed(5), ward, (t.name || t['name:en'] || '').slice(0, 60), id]);
    counts[ward] = counts[ward] || {};
    counts[ward][cat] = (counts[ward][cat] || 0) + 1;
  }
  return { source: 'OpenStreetMap via Overpass API', osmBase: data.osm3s?.timestamp_osm_base ?? null, categories: CATEGORIES, total: points.length, counts, points };
}
