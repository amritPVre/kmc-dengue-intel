// GET /api/weather → daily rain, temperature and humidity for the 16 boroughs:
// season history (ERA5 reanalysis) + last 92 days and next 16 days (forecast models).
import { send, sendError, addDays } from './_lib/util.js';
import { cached } from './_lib/store.js';
import { archive, merge, recentAndForecast } from './_lib/weather.js';


export default async function handler(req, res) {
  try {
    const recent = await cached('weather:recent', 3, () => recentAndForecast(92), 'Open-Meteo');
    const r = recent.data;
    const firstRecent = r.boroughs[0]?.date?.[0];
    let boroughs = r.boroughs;
    let historySource = null;
    if (firstRecent && firstRecent > '2025-05-01') {
      try {
        const to = addDays(firstRecent, -1);
        const hist = await cached(`weather:hist:2025-05-01:${to.slice(0, 7)}`, 24 * 20, () => archive('2025-05-01', to), 'Open-Meteo ERA5');
        boroughs = merge(hist.data, r);
        historySource = hist.data.source;
      } catch (e) {
        console.error('archive', e.message);
      }
    }
    // city series: mean across boroughs per day
    const dates = boroughs[0]?.date ?? [];
    const meanAt = (key, i) => {
      const v = boroughs.map((b) => b[key]?.[i]).filter((x) => x != null);
      return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
    };
    const city = {
      date: dates,
      rain: dates.map((_, i) => meanAt('rain', i)),
      rainMax: dates.map((_, i) => { const v = boroughs.map((b) => b.rain?.[i]).filter((x) => x != null); return v.length ? Math.max(...v) : null; }),
      tmean: dates.map((_, i) => meanAt('tmean', i)),
      tmax: dates.map((_, i) => meanAt('tmax', i)),
      tmin: dates.map((_, i) => meanAt('tmin', i)),
      rh: dates.map((_, i) => meanAt('rh', i)),
      rainProb: dates.map((_, i) => meanAt('rainProb', i)),
    };
    send(res, {
      source: r.source, historySource, today: r.today, fetchedAt: recent.updatedAt, stale: Boolean(recent.stale),
      licence: 'Weather data by Open-Meteo.com (CC BY 4.0)', boroughs, city,
    }, { sMaxAge: 1800, swr: 6 * 3600 });
  } catch (e) {
    sendError(res, e, 'weather');
  }
}
