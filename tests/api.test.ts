// Tests for the server data functions with the upstream services mocked.
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module
import { wardAt, wardCells, boroughPoints, wardFeatures } from '../api/_lib/geo.js';
// @ts-expect-error plain JS module
import { fractionBelow, categoryShares } from '../api/_lib/pc.js';
// @ts-expect-error plain JS module
import { EDGES, processPass, listPasses } from '../api/_lib/s1.js';
// @ts-expect-error plain JS module
import { recentAndForecast, merge } from '../api/_lib/weather.js';
// @ts-expect-error plain JS module
import { fetchCandidates } from '../api/_lib/osm.js';

const KMC_POLY = { type: 'Polygon', coordinates: [[[87.9, 22.0], [89.0, 22.0], [89.0, 23.2], [87.9, 23.2], [87.9, 22.0]]] };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('ward geography', () => {
  it('finds the ward containing a point and splits a ward into cells', () => {
    expect(wardAt(88.38617, 22.53244)).toBe(66);
    expect(wardAt(88.0, 22.0)).toBeNull();
    const cells = wardCells(66, 250);
    expect(cells.length).toBeGreaterThan(20);
    expect(cells.length).toBeLessThan(45);
    expect(cells.every((c: { properties: { ward: number } }) => c.properties.ward === 66)).toBe(true);
    expect(boroughPoints()).toHaveLength(16);
    expect(wardFeatures()).toHaveLength(141);
  });
});

describe('raster statistics helpers', () => {
  it('reads water share and land-cover shares from TiTiler histograms', () => {
    const s = { valid_pixels: 100, histogram: [[5, 10, 15, 30, 20, 20], EDGES] };
    expect(fractionBelow(s, EDGES[3])).toBeCloseTo(0.3);
    expect(categoryShares({ histogram: [[60, 30, 10], [50, 30, 60]] })).toEqual({ 50: 0.6, 30: 0.3, 60: 0.1 });
  });
});

describe('Sentinel-1 pass processing', () => {
  it('flags wards with new water against the dry-season pass and pin-points cells', async () => {
    const wet = { id: 'S1A_WET_20250924', properties: { datetime: '2025-09-24T00:13:00Z', platform: 'SENTINEL-1A', 'sat:relative_orbit': 99, 'sat:orbit_state': 'ascending' }, geometry: KMC_POLY };
    const dry = { id: 'S1A_DRY_20250401', properties: { datetime: '2025-04-01T00:13:00Z', platform: 'SENTINEL-1A', 'sat:relative_orbit': 99, 'sat:orbit_state': 'ascending' }, geometry: KMC_POLY };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/search')) {
        const body = JSON.parse(String(init?.body));
        if (body.collections[0] === 'jrc-gsw') return json({ type: 'FeatureCollection', features: [{ id: 'JRC', properties: {}, geometry: KMC_POLY }], links: [] });
        return json({ type: 'FeatureCollection', features: body.datetime.startsWith('2025-02') ? [dry] : [wet], links: [] });
      }
      if (u.pathname.endsWith('/item/statistics')) {
        const item = u.searchParams.get('item');
        const fc = JSON.parse(String(init?.body));
        if (item === 'JRC') {
          // the southern half of ward 106's cells are a known pond: radar water there must be ignored
          return json({ type: 'FeatureCollection', features: fc.features.map((f: { properties: { lat: number } }) => ({ ...f, properties: { ...f.properties, statistics: { occurrence_b1: { histogram: [f.properties.lat < 22.504 ? [20, 80] : [100, 0], [0, 10, 101]] } } } })) });
        }
        return json({
          type: 'FeatureCollection',
          features: fc.features.map((f: { properties: { id: string; ward: number; lat?: number } }) => {
            const inFlooded = f.properties.ward === 106;
            const waterPx = item === wet.id && inFlooded ? 40 : 2; // 40 % of pixels dark after the rain
            return { ...f, properties: { ...f.properties, statistics: { vv_b1: { valid_pixels: 100, histogram: [[0, 0, waterPx, 10, 40, 50 - waterPx], EDGES] } } } };
          }),
        });
      }
      throw new Error('unexpected ' + url);
    }));
    const passes = await listPasses('2025-05-01', '2025-10-01');
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ date: '2025-09-24', orbit: 99, platform: 'Sentinel-1A' });
    const r = await processPass(passes[0]);
    expect(r.baseline.id).toBe(dry.id);
    expect(r.flaggedWards).toEqual([106]);
    expect(r.wards[106].newFrac).toBeCloseTo(0.38);
    expect(r.wards[66].newFrac).toBe(0);
    expect(r.spots.length).toBeGreaterThan(0);
    expect(r.spots.every((s: { ward: number }) => s.ward === 106)).toBe(true);
    expect(r.droppedKnownWater).toBeGreaterThan(0);
    expect(r.spots.every((s: { lat: number }) => s.lat >= 22.504)).toBe(true);
    expect(r.tiles.water).toContain('sentinel-1-rtc');
  });
});

describe('weather', () => {
  it('packs Open-Meteo multi-location responses per borough and merges history', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const n = new URL(url).searchParams.get('latitude')!.split(',').length;
      return json(Array.from({ length: n }, (_, i) => ({ daily: { time: ['2026-11-13', '2026-11-14'], precipitation_sum: [i, 0], temperature_2m_mean: [24, 23], temperature_2m_max: [29, 28], temperature_2m_min: [19, 18], relative_humidity_2m_mean: [70, 68], precipitation_probability_max: [10, 0] } })));
    }));
    const w = await recentAndForecast(2);
    expect(w.boroughs).toHaveLength(16);
    expect(w.boroughs[3].rain).toEqual([3, 0]);
    const older = { boroughs: w.boroughs.map((b: { date: string[] }) => ({ ...b, date: ['2026-11-12', '2026-11-13'], rain: [9, 9], tmean: [1, 1], tmax: [1, 1], tmin: [1, 1], rh: [1, 1] })) };
    const m = merge(older, w);
    expect(m[0].date).toEqual(['2026-11-12', '2026-11-13', '2026-11-14']);
    expect(m[0].rain).toEqual([9, 0, 0]);
  });
});

describe('OpenStreetMap candidates', () => {
  it('categorises Overpass elements and assigns them to wards', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      osm3s: { timestamp_osm_base: '2026-11-14T00:00:00Z' },
      elements: [
        { type: 'node', id: 1, lat: 22.53244, lon: 88.38617, tags: { shop: 'tyres', name: 'Ward 66 Tyres' } },
        { type: 'way', id: 2, center: { lat: 22.53244, lon: 88.38617 }, tags: { landuse: 'construction' } },
        { type: 'way', id: 3, center: { lat: 22.53244, lon: 88.38617 }, tags: { natural: 'water', water: 'pond' } },
        { type: 'node', id: 4, lat: 22.0, lon: 88.0, tags: { shop: 'tyres' } },
        { type: 'node', id: 5, lat: 22.53244, lon: 88.38617, tags: { shop: 'bakery' } },
      ],
    })));
    const r = await fetchCandidates();
    expect(r.total).toBe(3);
    expect(r.counts[66]).toEqual({ tyres: 1, construction: 1, pond: 1 });
  });
});
