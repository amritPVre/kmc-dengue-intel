// Live open-data layers, served by the app's own /api functions (see api/).
// Every number here comes from a public source; nothing is synthetic.

export interface WeatherSeries {
  date: string[];
  rain: (number | null)[];
  tmean: (number | null)[];
  tmax: (number | null)[];
  tmin: (number | null)[];
  rh: (number | null)[];
  rainProb?: (number | null)[] | null;
}
export interface PublicWeather {
  source: string;
  historySource: string | null;
  today: string;
  fetchedAt: string;
  licence: string;
  boroughs: (WeatherSeries & { borough: string; lat: number; lng: number })[];
  city: WeatherSeries & { rainMax: (number | null)[] };
}
export interface S1Pass { id: string; datetime: string; date: string; platform: string; orbit: number | null; state: string | null; processed?: boolean }
export interface S1Spot { ward: number; lat: number; lng: number; newFrac: number; wet: number; areaHa: number }
export interface S1Processed {
  pass: S1Pass;
  baseline: { id: string; date: string } | null;
  totals: { wardsMeasured: number; newWaterHa: number };
  flaggedWards: number[];
  spots: S1Spot[];
  /** ward → [new-water fraction, new-water ha, wet fraction] */
  wards: Record<string, [number | null, number | null, number | null]>;
  tiles: { radar: string; water: string; baselineWater: string | null };
  processedAt: string;
}
export interface S2Scene { date: string; platform: string; cloud: number; items: { id: string; tile: string | null; bbox: number[]; cloud: number; trueColour: string }[] }
export interface Hotspot { name: string; sources: string[]; lat: number | null; lng: number | null; ward: number | null; matched: string | null }
export interface LayerPart { source: string; updatedAt?: string; error?: string; item?: string }
export interface Landscape {
  worldcover?: LayerPart & { wards: Record<string, Record<'tree' | 'shrub' | 'grass' | 'crop' | 'built' | 'bare' | 'water' | 'wetland' | 'mangrove', number>> };
  water?: LayerPart & { wards: Record<string, { seasonal: number; frequent: number; permanent: number }> };
  elevation?: LayerPart & { wards: Record<string, { mean: number; p10: number; p50: number }> };
  population?: LayerPart & { wards: Record<string, number>; missing: number[] };
  hotspots?: LayerPart & { places: Hotspot[]; sources: Record<string, { publisher: string; date: string | null; title: string; url: string }> };
}
export interface OsmData {
  source: string; licence: string; osmBase: string | null; updatedAt: string; total: number;
  categories: Record<string, string>;
  counts: Record<string, Record<string, number>>;
  /** [category, lat, lng, ward, name, osm id] */
  points: [string, number, number, number, string, string][];
}
export interface SourceStatus { checkedAt: string; database: boolean; checks: { name: string; ok: boolean; ms: number; detail: string }[]; stored: Record<string, { count: number; latest: string | null }> }

export interface PublicData {
  weather?: PublicWeather;
  passes?: S1Pass[];
  sentinel2?: S2Scene[];
  history?: S1Processed[];
  landscape?: Landscape;
  osm?: OsmData;
  /** Part → error message for parts that failed to load. */
  errors: Record<string, string>;
  /** Part → 'loading' | 'ok' | 'error'. */
  status: Record<PartName, 'loading' | 'ok' | 'error'>;
  loadedAt: string;
}
export type PartName = 'weather' | 'satellite' | 'history' | 'landscape' | 'osm';
export const PART_LABEL: Record<PartName, string> = {
  weather: 'Weather — Open-Meteo',
  satellite: 'Sentinel-1 / Sentinel-2 passes — Planetary Computer',
  history: 'Radar water detections — Planetary Computer',
  landscape: 'Land cover, surface water, Census 2011 — ESA, JRC, Census',
  osm: 'Breeding-site candidates — OpenStreetMap',
};

const API = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function getJson<T>(path: string, timeoutMs: number): Promise<T> {
  const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error(`${path}: not JSON (${r.status})`); }
  if (!r.ok || (j && typeof j === 'object' && 'error' in j && !(j as { parts?: unknown }).parts)) {
    throw new Error((j as { error?: string })?.error ?? `${path}: HTTP ${r.status}`);
  }
  return j as T;
}

export const apiAvailable = () => typeof window !== 'undefined' && !/claudeusercontent|claude\.ai/.test(window.location.host);

/**
 * Loads every layer in parallel; calls onUpdate as each part arrives so the app can render
 * with partial data (a cold first request to land cover or OpenStreetMap can take a minute).
 */
export function loadPublic(onUpdate: (p: PublicData) => void): void {
  let state: PublicData = {
    errors: {}, loadedAt: new Date().toISOString(),
    status: { weather: 'loading', satellite: 'loading', history: 'loading', landscape: 'loading', osm: 'loading' },
  };
  const set = (patch: Partial<PublicData>, part: PartName, err?: string) => {
    state = { ...state, ...patch, status: { ...state.status, [part]: err ? 'error' : 'ok' }, errors: err ? { ...state.errors, [part]: err } : state.errors };
    onUpdate(state);
  };
  const fail = (part: PartName) => (e: unknown) => set({}, part, e instanceof Error ? e.message : String(e));

  getJson<PublicWeather>('/api/weather', 60000).then((weather) => set({ weather }, 'weather')).catch(fail('weather'));
  getJson<{ passes: S1Pass[]; sentinel2: S2Scene[] | { error: string } | null }>('/api/satellite?op=passes', 90000)
    .then((r) => set({ passes: r.passes, sentinel2: Array.isArray(r.sentinel2) ? r.sentinel2 : [] }, 'satellite'))
    .catch(fail('satellite'));
  getJson<{ store: boolean; passes: S1Processed[] }>('/api/satellite?op=history', 60000)
    .then(async (r) => {
      if (r.passes.length) { set({ history: r.passes }, 'history'); return; }
      // no database yet: process the latest pass on demand (cached by the CDN)
      const latest = await getJson<S1Processed & { wards: Record<string, { newFrac: number | null; newHa: number | null; wet: number | null } | null> }>('/api/satellite?op=pass', 280000);
      const wards: S1Processed['wards'] = {};
      for (const [w, v] of Object.entries(latest.wards || {})) if (v) wards[w] = [v.newFrac, v.newHa, v.wet];
      set({ history: [{ ...latest, wards }] }, 'history');
    })
    .catch(fail('history'));
  getJson<{ parts: Landscape }>('/api/landscape', 290000)
    .then((r) => {
      const errs = Object.entries(r.parts).filter(([, p]) => (p as LayerPart).error).map(([k, p]) => `${k}: ${(p as LayerPart).error}`);
      set({ landscape: r.parts }, 'landscape', errs.length === Object.keys(r.parts).length ? errs.join('; ') : undefined);
    })
    .catch(fail('landscape'));
  getJson<OsmData>('/api/osm', 290000).then((osm) => set({ osm }, 'osm')).catch(fail('osm'));
}

export async function loadSources(): Promise<SourceStatus> {
  return getJson<SourceStatus>('/api/sources', 30000);
}
