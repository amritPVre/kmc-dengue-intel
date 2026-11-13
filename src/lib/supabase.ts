// Supabase data access. Used only when VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set;
// otherwise the app runs in demo mode on synthetic data.
// Row-level security (supabase/migrations/0002_rls.sql) limits each signed-in user to
// their borough or ward, so the same queries serve HQ, borough and ward roles.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Alert, BreedingSite, CitizenReport, Db, DengueCase, FieldTask, LarvalSurvey, SatellitePass, Ward, WaterDetection, WeatherWeek } from './types';
import { addDays, mondayOf } from './util';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
let client: SupabaseClient | null = null;

export const isSupabaseConfigured = () => Boolean(url && key);
export function sb(): SupabaseClient {
  if (!client) {
    if (!url || !key) throw new Error('Supabase is not configured');
    client = createClient(url, key, { auth: { persistSession: true } });
  }
  return client;
}

async function all<T>(table: string, select = '*', filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = sb().from(table).select(select).range(from, from + page - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < page) break;
  }
  return out;
}

export interface Profile { role: 'hq' | 'borough' | 'ward' | 'field' | 'councillor' | 'lab'; borough: string | null; ward_no: number | null; display_name: string }

export async function currentSession() {
  const { data } = await sb().auth.getSession();
  return data.session;
}
export async function myProfile(): Promise<Profile | null> {
  const uid = (await currentSession())?.user.id;
  if (!uid) return null;
  const { data, error } = await sb().from('profiles').select('role, borough, ward_no, display_name').eq('user_id', uid).maybeSingle();
  if (error) throw new Error(error.message);
  return data as Profile | null;
}

/** Loads the analysis window (default: 100 weeks) for the signed-in user's scope. */
export async function loadFromSupabase(asOf: string, weeksBack = 100): Promise<Db> {
  const since = addDays(mondayOf(asOf), -7 * weeksBack);
  const profile = await myProfile();
  const [wards, weather, cases, surveys, sites, tasks, alerts, citizen, teams, detections, passes, rain, susc] = await Promise.all([
    all<any>('v_wards_active', 'ward_no, borough, centroid_lng, centroid_lat, area_km2, bbox, neighbours, boundary_source, population'),
    all<any>('weather_weekly', 'week_start, rain_mm, t_mean_c, rh_pct', (q) => q.gte('week_start', since)),
    all<any>('dengue_cases', 'id, ward_no, reported_on, onset_on, test_type, source, age_band, sex, lat, lng, hospitalised, severity, dedupe_key', (q) => q.gte('reported_on', since)),
    all<any>('larval_surveys', 'id, ward_no, survey_date, team, houses_visited, houses_positive, containers_inspected, containers_positive, notes', (q) => q.gte('survey_date', addDays(asOf, -120))),
    all<any>('breeding_sites', 'id, ward_no, site_type, lat, lng, status, detected_by, first_seen, last_action_on, description'),
    all<any>('field_tasks', 'id, ward_no, task_type, title, priority, status, created_at, due_at, completed_at, source, alert_id, team, notes', (q) => q.gte('created_at', addDays(asOf, -90))),
    all<any>('alerts', 'id, ward_no, alert_type, level, title, detail, created_at, status, cluster_lng, cluster_lat, case_ids', (q) => q.gte('created_at', addDays(asOf, -90))),
    all<any>('citizen_reports', 'id, ward_no, kind, reported_at, status, text', (q) => q.gte('reported_at', addDays(asOf, -30))),
    all<any>('teams', 'ward_no, name'),
    all<any>('water_detections', 'id, ward_no, lat, lng, area_m2, source, sensor, kind, detected_at, water_since, confidence, status, aedes_risk, ai, photo_path, task_id, verified_at, cleared_on',
      (q) => q.gte('water_since', addDays(asOf, -60))),
    all<any>('satellite_passes', 'id, sensor, platform, pass_date, cloud_pct, detections, status', (q) => q.gte('pass_date', addDays(asOf, -60))),
    all<any>('rain_daily_city', 'day, rain_mm', (q) => q.gte('day', addDays(asOf, -120))),
    all<any>('ward_susceptibility', 'ward_no, susceptibility'),
  ]);
  const weeks: string[] = [];
  for (let w = since; w <= mondayOf(asOf); w = addDays(w, 7)) weeks.push(w);
  // Councillors may not read the case line list; RLS returns no rows. Rebuild weekly counts from the
  // aggregate view as location-less placeholders so trends and risk still compute for their ward.
  if (profile?.role === 'councillor' && cases.length === 0) {
    const agg = await all<any>('v_ward_weekly', 'ward_no, week_start, cases', (q) => q.gte('week_start', since));
    for (const r of agg) for (let i = 0; i < r.cases; i++) {
      const w = wards.find((x) => x.ward_no === r.ward_no);
      cases.push({ id: `agg-${r.ward_no}-${r.week_start}-${i}`, ward_no: r.ward_no, reported_on: r.week_start, onset_on: r.week_start, test_type: 'NS1', source: 'KMC lab',
        age_band: null, sex: null, lat: w?.centroid_lat, lng: w?.centroid_lng, hospitalised: false, severity: null, dedupe_key: `agg-${r.ward_no}-${r.week_start}-${i}` });
    }
  }
  const teamMap: Record<number, string[]> = {};
  for (const t of teams) (teamMap[t.ward_no] ??= []).push(t.name);
  return {
    mode: 'supabase',
    asOf,
    weeks,
    wards: wards.map((w): Ward => ({
      ward: w.ward_no, borough: w.borough, centroid: [w.centroid_lng, w.centroid_lat], areaKm2: w.area_km2,
      bbox: w.bbox, neighbours: w.neighbours ?? [], boundary: w.boundary_source, population: w.population,
    })),
    weather: weather.map((r): WeatherWeek => ({ weekStart: r.week_start, rainMm: r.rain_mm, tMeanC: r.t_mean_c, rhPct: r.rh_pct })),
    cases: cases.map((r): DengueCase => ({
      id: r.id, ward: r.ward_no, reportedOn: r.reported_on, onsetOn: r.onset_on, test: r.test_type, source: r.source,
      ageBand: r.age_band, sex: r.sex, lat: r.lat, lng: r.lng, hospitalised: r.hospitalised, severity: r.severity, dedupeKey: r.dedupe_key,
    })),
    surveys: surveys.map((r): LarvalSurvey => ({
      id: r.id, ward: r.ward_no, date: r.survey_date, team: r.team, housesVisited: r.houses_visited, housesPositive: r.houses_positive,
      containersInspected: r.containers_inspected, containersPositive: r.containers_positive, notes: r.notes ?? undefined,
    })),
    sites: sites.map((r): BreedingSite => ({
      id: r.id, ward: r.ward_no, type: r.site_type, lat: r.lat, lng: r.lng, status: r.status, detectedBy: r.detected_by,
      firstSeen: r.first_seen, lastActionOn: r.last_action_on ?? undefined, description: r.description ?? '',
    })),
    tasks: tasks.map((r): FieldTask => ({
      id: r.id, ward: r.ward_no, type: r.task_type, title: r.title, priority: r.priority, status: r.status, createdAt: r.created_at,
      dueAt: r.due_at, completedAt: r.completed_at ?? undefined, source: r.source, alertId: r.alert_id ?? undefined, team: r.team, notes: r.notes ?? undefined,
    })),
    alerts: alerts.map((r): Alert => ({
      id: r.id, ward: r.ward_no, type: r.alert_type, level: r.level, title: r.title, detail: r.detail, createdAt: r.created_at, status: r.status,
      clusterCentroid: r.cluster_lng != null ? [r.cluster_lng, r.cluster_lat] : undefined, caseIds: r.case_ids ?? undefined,
    })).sort((x, y) => y.createdAt.localeCompare(x.createdAt)),
    citizen: citizen.map((r): CitizenReport => ({ id: r.id, ward: r.ward_no, kind: r.kind, reportedAt: r.reported_at, status: r.status, text: r.text })),
    teams: teamMap,
    detections: detections.map((r): WaterDetection => ({
      id: r.id, ward: r.ward_no, lat: r.lat, lng: r.lng, areaM2: r.area_m2 ?? undefined, source: r.source, sensor: r.sensor ?? undefined, kind: r.kind,
      detectedAt: r.detected_at, waterSince: r.water_since, confidence: Number(r.confidence), status: r.status, aedesRisk: r.aedes_risk,
      ai: r.ai ?? undefined, photo: r.photo_path ?? undefined, taskId: r.task_id ?? undefined, verifiedAt: r.verified_at ?? undefined, clearedOn: r.cleared_on ?? undefined,
    })),
    passes: passes.map((r): SatellitePass => ({ id: r.id, sensor: r.sensor, platform: r.platform, date: r.pass_date, cloudPct: r.cloud_pct ?? undefined, detections: r.detections, status: r.status })),
    rainDaily: rain.map((r) => ({ date: r.day, mm: Number(r.rain_mm) })),
    susceptibility: Object.fromEntries(susc.map((r) => [r.ward_no, Number(r.susceptibility)])),
  };
}

const caseRow = (c: DengueCase) => ({
  ward_no: c.ward, reported_on: c.reportedOn, onset_on: c.onsetOn, test_type: c.test, source: c.source, age_band: c.ageBand,
  sex: c.sex, lat: c.lat, lng: c.lng, hospitalised: c.hospitalised, severity: c.severity, dedupe_key: c.dedupeKey,
});
const taskRow = (t: FieldTask) => ({
  ward_no: t.ward, task_type: t.type, title: t.title, priority: t.priority, status: t.status, created_at: t.createdAt, due_at: t.dueAt,
  completed_at: t.completedAt ?? null, source: t.source, alert_id: t.alertId && /^[0-9a-f-]{36}$/.test(t.alertId) ? t.alertId : null, team: t.team, notes: t.notes ?? null,
});
const check = (r: { error: { message: string } | null }) => { if (r.error) throw new Error(r.error.message); };
async function insertReturningIds(table: string, rows: object[]): Promise<string[]> {
  const r = await sb().from(table).insert(rows).select('id');
  check(r);
  return ((r.data ?? []) as { id: string }[]).map((x) => x.id);
}

/** Write operations. Inserts return the database ids so later updates address the right rows. */
export const repo = {
  insertCase: async (c: DengueCase) => (await insertReturningIds('dengue_cases', [caseRow(c)]))[0],
  insertCases: async (cs: DengueCase[]) => check(await sb().from('dengue_cases').upsert(cs.map(caseRow), { onConflict: 'dedupe_key', ignoreDuplicates: true })),
  insertSurvey: async (s: LarvalSurvey) => (await insertReturningIds('larval_surveys', [{
    ward_no: s.ward, survey_date: s.date, team: s.team, houses_visited: s.housesVisited, houses_positive: s.housesPositive,
    containers_inspected: s.containersInspected, containers_positive: s.containersPositive, notes: s.notes ?? null,
  }]))[0],
  insertSite: async (s: BreedingSite) => (await insertReturningIds('breeding_sites', [{
    ward_no: s.ward, site_type: s.type, lat: s.lat, lng: s.lng, status: s.status, detected_by: s.detectedBy, first_seen: s.firstSeen, description: s.description,
  }]))[0],
  insertTasks: async (ts: FieldTask[]) => insertReturningIds('field_tasks', ts.map(taskRow)),
  updateTask: async (id: string, p: { status: string; completedAt?: string }) => check(await sb().from('field_tasks').update({ status: p.status, completed_at: p.completedAt ?? null }).eq('id', id)),
  insertAlerts: async (as: Alert[]) => insertReturningIds('alerts', as.map((x) => ({
    ward_no: x.ward, alert_type: x.type, level: x.level, title: x.title, detail: x.detail, status: x.status,
    cluster_lng: x.clusterCentroid?.[0] ?? null, cluster_lat: x.clusterCentroid?.[1] ?? null, case_ids: x.caseIds ?? null,
  }))),
  updateAlert: async (id: string, p: { status: string }) => check(await sb().from('alerts').update(p).eq('id', id)),
  updateCitizen: async (id: string, p: { status: string }) => check(await sb().from('citizen_reports').update(p).eq('id', id)),
  insertDetection: async (d: WaterDetection) => (await insertReturningIds('water_detections', [{
    ward_no: d.ward, lat: d.lat, lng: d.lng, area_m2: d.areaM2 ?? null, source: d.source, sensor: d.sensor ?? null, kind: d.kind,
    water_since: d.waterSince, confidence: d.confidence, status: d.status, aedes_risk: d.aedesRisk, ai: d.ai ?? null, photo_path: d.photo && !d.photo.startsWith('blob:') ? d.photo : null,
  }]))[0],
  updateDetection: async (id: string, p: { status: string; taskId?: string; clearedOn?: string }) => check(await sb().from('water_detections').update({
    status: p.status, task_id: p.taskId && /^[0-9a-f-]{36}$/.test(p.taskId) ? p.taskId : undefined, cleared_on: p.clearedOn ?? undefined, verified_at: new Date().toISOString(),
  }).eq('id', id)),
  /** Uploads a photo to Storage and asks the analyze-image Edge Function to run AI vision on it. */
  analyzeImage: async (file: Blob, body: Record<string, unknown>) => {
    const path = `uploads/${crypto.randomUUID()}.${(file.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`;
    const up = await sb().storage.from('detection-photos').upload(path, file, { contentType: file.type || 'image/jpeg' });
    if (up.error) throw new Error(up.error.message);
    const { data, error } = await sb().functions.invoke('analyze-image', { body: { ...body, photoPath: path } });
    if (error) throw new Error(error.message);
    return { ...(data as Record<string, unknown>), photoPath: path };
  },
};
