// Supabase Edge Function: fetch-weather
// Pulls daily rainfall, mean temperature and humidity for Kolkata from Open-Meteo
// (free, no key) and stores weekly totals/means. Swap in IMD station data when KMC
// arranges access; the table shape stays the same.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const LAT = 22.5726, LNG = 88.3639; // Kolkata

Deno.serve(async () => {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}` +
    '&daily=precipitation_sum,temperature_2m_mean,relative_humidity_2m_mean&past_days=60&forecast_days=1&timezone=Asia%2FKolkata';
  const r = await fetch(url);
  if (!r.ok) return Response.json({ error: `open-meteo ${r.status}` }, { status: 502 });
  const j = await r.json();
  const d = j.daily as { time: string[]; precipitation_sum: number[]; temperature_2m_mean: number[]; relative_humidity_2m_mean: number[] };
  const weeks = new Map<string, { rain: number; t: number[]; rh: number[]; days: number }>();
  d.time.forEach((day, i) => {
    const dt = new Date(day + 'T00:00:00Z');
    const mon = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
    const w = weeks.get(mon) ?? { rain: 0, t: [], rh: [], days: 0 };
    w.rain += d.precipitation_sum[i] ?? 0;
    if (d.temperature_2m_mean[i] != null) w.t.push(d.temperature_2m_mean[i]);
    if (d.relative_humidity_2m_mean[i] != null) w.rh.push(d.relative_humidity_2m_mean[i]);
    w.days++;
    weeks.set(mon, w);
  });
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
  const rows = [...weeks.entries()].filter(([, w]) => w.days === 7).map(([week_start, w]) => ({
    week_start, rain_mm: +w.rain.toFixed(1), t_mean_c: +mean(w.t).toFixed(1), rh_pct: +mean(w.rh).toFixed(1), source: 'open-meteo',
  }));
  const up = await sb.from('weather_weekly').upsert(rows, { onConflict: 'week_start' });
  if (up.error) return Response.json({ error: up.error.message }, { status: 500 });
  return Response.json({ weeks: rows.length });
});
