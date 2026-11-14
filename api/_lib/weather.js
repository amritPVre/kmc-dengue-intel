// Weather for the 16 boroughs from Open-Meteo (no key; CC BY 4.0).
// Forecast API: last 92 days + next 16 days. Archive API (ERA5): older season history.
// Model rainfall smooths out cloudbursts; KMC's own rain gauges should replace it in production.
import { fetchJson, addDays, isoDate } from './util.js';
import { boroughPoints } from './geo.js';

const DAILY = ['precipitation_sum', 'temperature_2m_mean', 'temperature_2m_max', 'temperature_2m_min', 'relative_humidity_2m_mean'];
const FORECAST_EXTRA = ['precipitation_probability_max'];

function pack(points, res) {
  const list = Array.isArray(res) ? res : [res];
  return points.map((p, i) => {
    const d = list[i]?.daily || {};
    return {
      borough: p.borough, lat: p.lat, lng: p.lng,
      date: d.time || [],
      rain: d.precipitation_sum || [],
      tmean: d.temperature_2m_mean || [],
      tmax: d.temperature_2m_max || [],
      tmin: d.temperature_2m_min || [],
      rh: d.relative_humidity_2m_mean || [],
      rainProb: d.precipitation_probability_max || null,
    };
  });
}

async function call(base, params, daily) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  u.searchParams.set('daily', daily.join(','));
  try {
    return await fetchJson(u.toString(), {}, { label: 'Open-Meteo', timeoutMs: 30000 });
  } catch (e) {
    // older model mixes may lack a variable; retry with the core set
    if (e.status === 400 && daily.length > 3) {
      u.searchParams.set('daily', 'precipitation_sum,temperature_2m_mean,temperature_2m_max,temperature_2m_min');
      return fetchJson(u.toString(), {}, { label: 'Open-Meteo', timeoutMs: 30000 });
    }
    throw e;
  }
}

/** Last `pastDays` days and next 16 days for every borough. */
export async function recentAndForecast(pastDays = 92) {
  const pts = boroughPoints();
  const res = await call('https://api.open-meteo.com/v1/forecast', {
    latitude: pts.map((p) => p.lat).join(','),
    longitude: pts.map((p) => p.lng).join(','),
    past_days: pastDays, forecast_days: 16, timezone: 'Asia/Kolkata',
  }, [...DAILY, ...FORECAST_EXTRA]);
  return { source: 'Open-Meteo forecast API (best-match models)', today: isoDate(Date.now() + 5.5 * 3600000), boroughs: pack(pts, res) };
}

/**
 * Daily history between two dates for every borough. Prefers Open-Meteo's archived high-resolution
 * forecasts (closer to convective downpours than reanalysis); falls back to ERA5 reanalysis.
 */
export async function archive(from, to) {
  const pts = boroughPoints();
  const params = { latitude: pts.map((p) => p.lat).join(','), longitude: pts.map((p) => p.lng).join(','), start_date: from, end_date: to, timezone: 'Asia/Kolkata' };
  try {
    const res = await call('https://historical-forecast-api.open-meteo.com/v1/forecast', params, DAILY);
    return { source: 'Open-Meteo historical forecast API (archived high-resolution forecasts)', from, to, boroughs: pack(pts, res) };
  } catch (e) {
    const res = await call('https://archive-api.open-meteo.com/v1/archive', params, DAILY);
    return { source: 'Open-Meteo historical weather API (ERA5 reanalysis)', from, to, boroughs: pack(pts, res), note: `historical forecast unavailable: ${e.message}` };
  }
}

/** Joins archive (older) and recent series per borough on date. */
export function merge(older, recent) {
  const by = new Map(older.boroughs.map((b) => [b.borough, b]));
  return recent.boroughs.map((r) => {
    const o = by.get(r.borough);
    if (!o) return r;
    const first = r.date[0];
    const keep = o.date.map((d, i) => (d < first ? i : -1)).filter((i) => i >= 0);
    const take = (arr) => keep.map((i) => arr?.[i] ?? null);
    return {
      ...r,
      date: [...take(o.date), ...r.date],
      rain: [...take(o.rain), ...r.rain],
      tmean: [...take(o.tmean), ...r.tmean],
      tmax: [...take(o.tmax), ...r.tmax],
      tmin: [...take(o.tmin), ...r.tmin],
      rh: [...take(o.rh), ...r.rh],
      rainProb: r.rainProb ? [...keep.map(() => null), ...r.rainProb] : null,
    };
  });
}

export const seasonFrom = (today) => addDays(today, -400) < '2025-05-01' ? '2025-05-01' : addDays(today, -400);
