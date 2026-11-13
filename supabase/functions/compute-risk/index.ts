// Supabase Edge Function: compute-risk
// Recomputes ward risk scores with the shared engine and (optionally) raises alerts.
// Scheduled daily (scores) and weekly on Monday 09:00 IST (alerts) — see migrations/…_schedule.sql.
//
// POST body: { "raiseAlerts": boolean }   Auth: service-role bearer token.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  DEFAULT_CONFIG, clusters, daysToClear, entomological, exceedance, predicted, scoreWard, waterSignal, type CasePoint, type Signal,
} from '../_shared/risk-engine.ts';

const DAY = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s + 'T00:00:00Z') + n * DAY));
const monday = (s: string) => { const d = new Date(s + 'T00:00:00Z'); return addDays(s, -((d.getUTCDay() + 6) % 7)); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

Deno.serve(async (req) => {
  const { raiseAlerts = false } = await req.json().catch(() => ({}));
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  async function all<T>(table: string, select: string, f?: (q: any) => any): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select(select).range(from, from + 999);
      if (f) q = f(q);
      const { data, error } = await q;
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...(data as T[]));
      if (!data || data.length < 1000) break;
    }
    return out;
  }

  const asOf = iso(new Date(Date.now() + 5.5 * 3600000)); // IST date
  const thisMonday = monday(asOf);
  const weeks: string[] = [];
  for (let w = addDays(thisMonday, -7 * 100); w < thisMonday; w = addDays(w, 7)) weeks.push(w);
  const n = weeks.length;
  const idx = new Map(weeks.map((w, i) => [w, i]));

  const [wards, cases, surveys, sites, weather, water] = await Promise.all([
    all<any>('v_wards_active', 'ward_no, neighbours, population, area_km2'),
    all<any>('dengue_cases', 'id, ward_no, reported_on, lat, lng', (q) => q.gte('reported_on', weeks[0])),
    all<any>('larval_surveys', 'ward_no, houses_visited, houses_positive, containers_inspected, containers_positive', (q) => q.gte('survey_date', addDays(asOf, -13))),
    all<any>('breeding_sites', 'ward_no', (q) => q.eq('status', 'Open')),
    all<any>('weather_weekly', 'week_start, rain_mm, t_mean_c, rh_pct', (q) => q.gte('week_start', weeks[0])),
    all<any>('water_detections', 'ward_no, status, confidence, water_since', (q) => q.in('status', ['New', 'Confirmed']).gte('water_since', addDays(asOf, -30))),
  ]);

  const weekly = new Map<number, number[]>(wards.map((w) => [w.ward_no, new Array(n).fill(0)]));
  const points: CasePoint[] = [];
  for (const c of cases) {
    const i = idx.get(monday(c.reported_on));
    const series = weekly.get(c.ward_no);
    if (i != null && series) series[i] += 1;
    if (c.lat != null && c.lng != null) points.push({ id: c.id, ward: c.ward_no, lat: c.lat, lng: c.lng, dayIndex: daysBetween(weeks[0], c.reported_on) });
  }
  const larv = new Map<number, { hv: number; hp: number; cp: number }>();
  for (const s of surveys) {
    const a = larv.get(s.ward_no) ?? { hv: 0, hp: 0, cp: 0 };
    a.hv += s.houses_visited; a.hp += s.houses_positive; a.cp += s.containers_positive;
    larv.set(s.ward_no, a);
  }
  const openSites = new Map<number, number>();
  for (const s of sites) openSites.set(s.ward_no, (openSites.get(s.ward_no) ?? 0) + 1);
  const wx = new Map(weather.map((w) => [w.week_start, w]));
  const rain = weeks.map((w) => Number(wx.get(w)?.rain_mm ?? 0));
  const rainLag = rain.slice(n - 6, n - 1).reduce((a, b) => a + b, 0);
  const last2 = weeks.slice(-2).map((w) => wx.get(w)).filter(Boolean);
  const meanT = last2.length ? last2.reduce((a, w) => a + Number(w.t_mean_c), 0) / last2.length : 28;
  const meanRh = last2.length ? last2.reduce((a, w) => a + Number(w.rh_pct), 0) / last2.length : 75;
  const pop = new Map(wards.map((w) => [w.ward_no, Number(w.population ?? 31000)]));
  const area = new Map(wards.map((w) => [w.ward_no, Math.max(Number(w.area_km2 ?? 1), 0.5)]));
  const wet = new Map<number, { index: number; urgent: number; past: number }>();
  for (const d of water) {
    const acc = wet.get(d.ward_no) ?? { index: 0, urgent: 0, past: 0 };
    const left = daysToClear(d.water_since, asOf, meanT);
    acc.index += (d.status === 'Confirmed' ? 1 : Number(d.confidence)) / (area.get(d.ward_no) ?? 1);
    if (left >= 0 && left <= 2) acc.urgent++;
    if (left < 0) acc.past++;
    wet.set(d.ward_no, acc);
  }
  const hist = wards.map((w) => ({ ward: w.ward_no, r: weekly.get(w.ward_no)!.slice(0, n - 8).reduce((a, b) => a + b, 0) / pop.get(w.ward_no)! }))
    .sort((a, b) => a.r - b.r);
  const pct = new Map(hist.map((h, i) => [h.ward, i / Math.max(1, hist.length - 1)]));

  const scores = [];
  const signals: Signal[] = [];
  for (const w of wards) {
    const series = weekly.get(w.ward_no)!;
    const nb: number[] = w.neighbours ?? [];
    const L = larv.get(w.ward_no);
    const bi = L && L.hv ? (L.cp / L.hv) * 100 : null;
    const hi = L && L.hv ? (L.hp / L.hv) * 100 : null;
    const r = scoreWard({
      ward: w.ward_no, population: pop.get(w.ward_no)!, weeklyCases: series,
      neighbourCases2w: nb.reduce((a, x) => a + (weekly.get(x)?.[n - 1] ?? 0) + (weekly.get(x)?.[n - 2] ?? 0), 0),
      neighbourPopulation: nb.reduce((a, x) => a + (pop.get(x) ?? 0), 0),
      breteauIndex: bi, houseIndex: hi, openBreedingSites: openSites.get(w.ward_no) ?? 0,
      rainLagMm: rainLag, meanTempC: meanT, meanRhPct: meanRh, historicalPercentile: pct.get(w.ward_no) ?? 0.5,
      standingWaterIndex: wet.get(w.ward_no)?.index ?? 0,
    }, DEFAULT_CONFIG);
    scores.push({ ward_no: w.ward_no, as_of: asOf, score: r.score, level: r.level, drivers: r.drivers, forecast: r.forecast, model_version: r.modelVersion });
    const wa = wet.get(w.ward_no);
    for (const s of [exceedance(w.ward_no, series), entomological(w.ward_no, bi, hi), predicted(r), waterSignal(w.ward_no, wa?.urgent ?? 0, wa?.past ?? 0)]) if (s) signals.push(s);
  }
  signals.push(...clusters(points, daysBetween(weeks[0], asOf)));

  const up = await sb.from('risk_scores').upsert(scores, { onConflict: 'ward_no,as_of' });
  if (up.error) return Response.json({ error: up.error.message }, { status: 500 });

  let raised = 0;
  if (raiseAlerts) {
    const { data: open } = await sb.from('alerts').select('ward_no, alert_type').neq('status', 'Closed').gte('created_at', addDays(asOf, -7));
    const active = new Set((open ?? []).map((a: any) => `${a.ward_no}:${a.alert_type}`));
    const fresh = signals.filter((s) => !active.has(`${s.ward}:${s.type}`)).map((s) => ({
      ward_no: s.ward, alert_type: s.type, level: s.level, title: s.title, detail: s.detail,
      cluster_lng: s.clusterCentroid?.[0] ?? null, cluster_lat: s.clusterCentroid?.[1] ?? null, case_ids: s.caseIds ?? null,
    }));
    if (fresh.length) {
      const ins = await sb.from('alerts').insert(fresh);
      if (ins.error) return Response.json({ error: ins.error.message }, { status: 500 });
    }
    raised = fresh.length;
  }
  return Response.json({ asOf, wards: wards.length, scored: scores.length, signals: signals.length, alertsRaised: raised });
});
