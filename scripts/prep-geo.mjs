// Prepares ward geography for the app and for database seeding.
// Input : data-raw/wards-ui.geojson (simplified DataMeet KMC ward boundaries, 141 wards)
// Output: src/data/wards.geo.json  (UI geometry + properties)
//         src/data/ward-meta.json  (ward → borough, centroid, area, neighbours)
// Wards 142–144 (Joka) are missing from the open dataset; they get an approximate
// centroid and a flag so the UI can show them as "boundary pending".
import fs from 'node:fs';

const BOROUGH_WARDS = {
  I: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  II: [10, 11, 12, 15, 16, 17, 18, 19, 20],
  III: [13, 14, 29, 30, 31, 32, 33, 34, 35],
  IV: [21, 22, 23, 24, 25, 26, 27, 28, 38, 39],
  V: [36, 37, 40, 41, 42, 43, 44, 45, 48, 49, 50],
  VI: [46, 47, 51, 52, 53, 54, 55, 60, 61, 62],
  VII: [56, 57, 58, 59, 63, 64, 65, 66, 67],
  VIII: [68, 69, 70, 72, 83, 84, 85, 86, 87, 88, 90],
  IX: [71, 73, 74, 75, 76, 77, 78, 79, 80, 82],
  X: [81, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100],
  XI: [103, 104, 110, 111, 112, 113, 114],
  XII: [101, 102, 105, 106, 107, 108, 109],
  XIII: [115, 116, 117, 118, 119, 120, 122],
  XIV: [121, 127, 128, 129, 130, 131, 132],
  XV: [133, 134, 135, 136, 137, 138, 139, 140, 141],
  XVI: [123, 124, 125, 126, 142, 143, 144],
};
const wardToBorough = {};
for (const [b, ws] of Object.entries(BOROUGH_WARDS)) for (const w of ws) {
  if (wardToBorough[w]) throw new Error(`ward ${w} in two boroughs`);
  wardToBorough[w] = b;
}
for (let w = 1; w <= 144; w++) if (!wardToBorough[w]) throw new Error(`ward ${w} has no borough`);

const PENDING = { // approximate centroids for Joka wards absent from the open dataset
  142: [88.3035, 22.4635],
  143: [88.2955, 22.4475],
  144: [88.3170, 22.4520],
};

const src = JSON.parse(fs.readFileSync('data-raw/wards-ui.geojson', 'utf8'));
const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

function rings(geom) {
  return geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
}
// planar area/centroid in a local equirectangular projection (fine at ward scale)
function areaCentroid(geom) {
  const lat0 = toRad(22.55);
  let A = 0, cx = 0, cy = 0;
  for (const poly of rings(geom)) {
    poly.forEach((ring, ri) => {
      const sign = ri === 0 ? 1 : -1;
      let a = 0, x = 0, y = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = [toRad(ring[i][0]) * Math.cos(lat0) * R, toRad(ring[i][1]) * R];
        const [x2, y2] = [toRad(ring[i + 1][0]) * Math.cos(lat0) * R, toRad(ring[i + 1][1]) * R];
        const f = x1 * y2 - x2 * y1;
        a += f; x += (x1 + x2) * f; y += (y1 + y2) * f;
      }
      a /= 2;
      const aa = Math.abs(a) * sign;
      if (a !== 0) { cx += (x / (6 * a)) * aa; cy += (y / (6 * a)) * aa; }
      A += aa;
    });
  }
  const lon = (cx / A / R / Math.cos(lat0)) * 180 / Math.PI;
  const lat = (cy / A / R) * 180 / Math.PI;
  return { areaKm2: A / 1e6, centroid: [lon, lat] };
}
function bbox(geom) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of rings(geom)) for (const ring of poly) for (const [x, y] of ring) {
    b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  }
  return b;
}
function verts(geom) {
  const out = [];
  for (const poly of rings(geom)) for (const ring of poly) for (const p of ring) out.push(p);
  return out;
}
const metersApprox = (a, b) => {
  const dx = toRad(b[0] - a[0]) * Math.cos(toRad(22.55)) * R;
  const dy = toRad(b[1] - a[1]) * R;
  return Math.hypot(dx, dy);
};

const features = src.features.map((f) => {
  const ward = Number(f.properties.WARD);
  const { areaKm2, centroid } = areaCentroid(f.geometry);
  return {
    type: 'Feature',
    properties: { ward, borough: wardToBorough[ward] },
    geometry: f.geometry,
    _bbox: bbox(f.geometry),
    _verts: verts(f.geometry),
    _area: areaKm2,
    _centroid: centroid,
  };
});

// adjacency: bboxes overlap (with ~40 m slack) and at least 2 vertices within 40 m
const slack = 0.0004;
const neighbours = {};
for (const f of features) neighbours[f.properties.ward] = new Set();
for (let i = 0; i < features.length; i++) {
  for (let j = i + 1; j < features.length; j++) {
    const a = features[i], b = features[j];
    if (a._bbox[0] - slack > b._bbox[2] || b._bbox[0] - slack > a._bbox[2] ||
        a._bbox[1] - slack > b._bbox[3] || b._bbox[1] - slack > a._bbox[3]) continue;
    let hits = 0;
    outer: for (const p of a._verts) {
      for (const q of b._verts) {
        if (Math.abs(p[0] - q[0]) > slack || Math.abs(p[1] - q[1]) > slack) continue;
        if (metersApprox(p, q) < 40) { hits++; if (hits >= 2) break outer; break; }
      }
    }
    if (hits >= 2) {
      neighbours[a.properties.ward].add(b.properties.ward);
      neighbours[b.properties.ward].add(a.properties.ward);
    }
  }
}
// Joka wards: neighbours by centroid distance (< 2.5 km)
for (const [w, c] of Object.entries(PENDING)) {
  neighbours[w] = new Set();
  for (const f of features) if (metersApprox(c, f._centroid) < 2500) {
    neighbours[w].add(f.properties.ward); neighbours[f.properties.ward].add(Number(w));
  }
  for (const [w2, c2] of Object.entries(PENDING)) if (w2 !== w && metersApprox(c, c2) < 2500) neighbours[w].add(Number(w2));
}

const meta = {};
for (const f of features) {
  meta[f.properties.ward] = {
    ward: f.properties.ward,
    borough: f.properties.borough,
    centroid: f._centroid.map((v) => +v.toFixed(5)),
    areaKm2: +f._area.toFixed(3),
    bbox: f._bbox.map((v) => +v.toFixed(5)),
    neighbours: [...neighbours[f.properties.ward]].sort((x, y) => x - y),
    boundary: 'datameet',
  };
}
for (const [w, c] of Object.entries(PENDING)) {
  meta[w] = {
    ward: Number(w), borough: wardToBorough[w], centroid: c, areaKm2: 1.6,
    bbox: [c[0] - 0.006, c[1] - 0.006, c[0] + 0.006, c[1] + 0.006],
    neighbours: [...neighbours[w]].sort((x, y) => x - y), boundary: 'pending',
  };
}

const ui = { type: 'FeatureCollection', features: features.map(({ type, properties, geometry }) => ({ type, properties, geometry })) };
fs.writeFileSync('src/data/wards.geo.json', JSON.stringify(ui));
fs.writeFileSync('src/data/ward-meta.json', JSON.stringify({ boroughs: BOROUGH_WARDS, wards: meta }));
const isolated = Object.values(meta).filter((m) => m.neighbours.length === 0).map((m) => m.ward);
console.log('wards:', Object.keys(meta).length, 'polygons:', features.length, 'isolated:', isolated);
const deg = Object.values(meta).map((m) => m.neighbours.length);
console.log('neighbour count min/avg/max', Math.min(...deg), (deg.reduce((a, b) => a + b, 0) / deg.length).toFixed(1), Math.max(...deg));
console.log('total area km2', Object.values(meta).reduce((a, m) => a + m.areaKm2, 0).toFixed(1));
