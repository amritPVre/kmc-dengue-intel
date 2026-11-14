// Ward geography for the data functions: boundaries, point-in-ward, borough centres, grid cells.
import fs from 'node:fs';
import path from 'node:path';

let cache = null;

export function wards() {
  if (cache) return cache;
  const root = process.cwd();
  const geo = JSON.parse(fs.readFileSync(path.join(root, 'src/data/wards.geo.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'src/data/ward-meta.json'), 'utf8'));
  const geoms = new Map(geo.features.map((f) => [Number(f.properties.ward), f.geometry]));
  const list = Object.values(meta.wards).map((w) => ({ ...w, geometry: geoms.get(w.ward) || null })).sort((a, b) => a.ward - b.ward);
  cache = { list, byWard: new Map(list.map((w) => [w.ward, w])), boroughs: meta.boroughs };
  return cache;
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInGeom(x, y, g) {
  if (!g) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const poly of polys) {
    if (!inRing(x, y, poly[0])) continue;
    let hole = false;
    for (let k = 1; k < poly.length; k++) if (inRing(x, y, poly[k])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

/** Ward number containing the point, or null (outside the 141 mapped wards). */
export function wardAt(lng, lat) {
  for (const w of wards().list) {
    const [x0, y0, x1, y1] = w.bbox;
    if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
    if (pointInGeom(lng, lat, w.geometry)) return w.ward;
  }
  return null;
}

/** One representative point per borough (mean of its ward centroids) for weather. */
export function boroughPoints() {
  const { boroughs, byWard } = wards();
  return Object.entries(boroughs).map(([b, ws]) => {
    const cs = ws.map((w) => byWard.get(w)?.centroid).filter(Boolean);
    const lng = cs.reduce((a, c) => a + c[0], 0) / cs.length;
    const lat = cs.reduce((a, c) => a + c[1], 0) / cs.length;
    return { borough: b, lng: +lng.toFixed(4), lat: +lat.toFixed(4) };
  });
}

/** GeoJSON features for wards with mapped boundaries (optionally a subset). */
export function wardFeatures(subset) {
  const pick = subset ? new Set(subset) : null;
  return wards().list
    .filter((w) => w.geometry && (!pick || pick.has(w.ward)))
    .map((w) => ({ type: 'Feature', properties: { id: `w${w.ward}`, ward: w.ward }, geometry: w.geometry }));
}

/**
 * Square cells of `sizeM` metres covering a ward; keeps cells whose centre lies in the ward.
 * Used to pin-point where inside a flagged ward the satellite saw new water.
 */
export function wardCells(ward, sizeM = 200) {
  const w = wards().byWard.get(ward);
  if (!w || !w.geometry) return [];
  const [x0, y0, x1, y1] = w.bbox;
  const dLat = sizeM / 110540;
  const dLng = sizeM / (111320 * Math.cos(((y0 + y1) / 2) * Math.PI / 180));
  const out = [];
  let k = 0;
  for (let y = y0; y < y1; y += dLat) {
    for (let x = x0; x < x1; x += dLng) {
      const cx = x + dLng / 2;
      const cy = y + dLat / 2;
      if (!pointInGeom(cx, cy, w.geometry)) continue;
      out.push({
        type: 'Feature',
        properties: { id: `w${ward}c${k++}`, ward, lng: +cx.toFixed(5), lat: +cy.toFixed(5), areaHa: (sizeM * sizeM) / 1e4 },
        geometry: { type: 'Polygon', coordinates: [[[x, y], [x + dLng, y], [x + dLng, y + dLat], [x, y + dLat], [x, y]]] },
      });
    }
  }
  return out;
}

export function wardAreaKm2(ward) {
  return wards().byWard.get(ward)?.areaKm2 ?? null;
}
