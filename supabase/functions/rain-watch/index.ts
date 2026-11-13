// Supabase Edge Function: rain-watch
// Runs after each rain-gauge update (hourly in monsoon). When a gauge records heavy rain, it flags the
// low-lying pockets that usually pool there (from ward_susceptibility.pockets, built by the satellite
// pipeline from past monsoons) as 'Rain + terrain model' water spots, so ward teams can check and drain
// them inside the breeding window — days before the next satellite pass.
// POST { "thresholdMm": 40 }   Auth: service-role bearer token.
import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const { thresholdMm = 40, radiusKm = 3 } = await req.json().catch(() => ({}));
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() + 5.5 * 3600000 - 86400000).toISOString().slice(0, 10);
  const { data: rain, error } = await sb.from('rain_daily').select('gauge, day, rain_mm, lat, lng').in('day', [yesterday, today]).gte('rain_mm', thresholdMm);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!rain?.length) return Response.json({ heavyRain: false, flagged: 0 });

  const { data: susc } = await sb.from('ward_susceptibility').select('ward_no, susceptibility, pockets');
  const { data: already } = await sb.from('water_detections').select('lat, lng').eq('source', 'Rain + terrain model').gte('water_since', yesterday);
  const near = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, m: number) =>
    Math.hypot((a.lat - b.lat) * 110540, (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180)) < m;
  const rows: Record<string, unknown>[] = [];
  for (const w of susc ?? []) {
    for (const p of (w.pockets ?? []) as { lat: number; lng: number; wet_frequency: number }[]) {
      const g = rain.find((r) => r.lat != null && near(p, r, radiusKm * 1000)) ?? (rain.some((r) => r.lat == null) ? rain[0] : null);
      if (!g || p.wet_frequency < 0.2) continue;
      if ((already ?? []).some((x) => near(p, x, 30)) || rows.some((x) => near(p, x as { lat: number; lng: number }, 30))) continue;
      rows.push({
        ward_no: w.ward_no, lat: p.lat, lng: p.lng, source: 'Rain + terrain model', sensor: `${g.rain_mm} mm at ${g.gauge}`,
        kind: 'Street / open waterlogging', water_since: g.day, status: 'New', aedes_risk: 'Medium',
        confidence: Math.min(0.85, +(0.3 + 0.5 * p.wet_frequency + Math.min(0.15, (Number(g.rain_mm) - thresholdMm) / 400)).toFixed(2)),
      });
    }
  }
  if (rows.length) {
    const ins = await sb.from('water_detections').insert(rows);
    if (ins.error) return Response.json({ error: ins.error.message }, { status: 500 });
  }
  return Response.json({ heavyRain: true, gauges: rain.length, flagged: rows.length });
});
