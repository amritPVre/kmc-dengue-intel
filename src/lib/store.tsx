import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_CONFIG, SOP, type EngineConfig } from '@shared/risk-engine';
import { aedesDevelopmentDays } from '@shared/risk-engine';
import { analyse, type Analytics } from './analytics';
import { generateDemo } from './demo/generator';
import { currentSession, isSupabaseConfigured, loadFromSupabase, myProfile, repo, sb } from './supabase';
import { apiAvailable, loadPublic, type PublicData } from './live';
import { applyGauges, buildPublicDb, EMPTY_OPS, type Operational } from './liveDb';
import type { Alert, BoroughCode, BreedingSite, CitizenReport, Db, DengueCase, FieldTask, LarvalSurvey, TaskStatus, WaterDetection } from './types';
import { addDays, safeStorage, todayIso, uid } from './util';

export type Role = 'hq' | 'borough' | 'ward' | 'field' | 'councillor' | 'lab';
export interface Scope { role: Role; borough: BoroughCode; ward: number }
export const ROLE_LABEL: Record<Role, string> = {
  hq: 'KMC HQ — Health Department',
  borough: 'Borough Executive Health Officer',
  ward: 'Ward Health Officer',
  field: 'Field vector-control team',
  councillor: 'Councillor (view only)',
  lab: 'Lab / hospital reporter',
};

interface Ctx {
  db: Db | null;
  pub: PublicData | null;
  needsLogin: boolean;
  signIn: (email: string, password?: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** In live mode the role comes from the user's profile and cannot be switched. */
  roleLocked: boolean;
  a: Analytics | null;
  error: string | null;
  scope: Scope;
  setScope: (s: Scope) => void;
  config: EngineConfig;
  setConfig: (c: EngineConfig) => void;
  toast: string | null;
  notify: (msg: string) => void;
  /** Drill: synthetic outbreak data for training. Off = live open data. */
  drill: boolean;
  setDrill: (on: boolean) => void;
  /** Date being viewed (null = today). Past dates replay the real data as it stood then. */
  viewDate: string | null;
  setViewDate: (d: string | null) => void;
  today: string;
  addCase: (c: Omit<DengueCase, 'id'>) => Promise<void>;
  addSurvey: (s: Omit<LarvalSurvey, 'id'>) => Promise<void>;
  addSite: (s: Omit<BreedingSite, 'id'>) => Promise<void>;
  addTask: (t: Omit<FieldTask, 'id' | 'createdAt'>) => Promise<void>;
  setTaskStatus: (id: string, status: TaskStatus) => Promise<void>;
  setAlertStatus: (id: string, status: Alert['status']) => Promise<void>;
  actionAlert: (alert: Alert) => Promise<number>;
  runAlerting: () => Promise<number>;
  setCitizenStatus: (id: string, status: CitizenReport['status']) => Promise<void>;
  importCases: (rows: Omit<DengueCase, 'id'>[]) => Promise<number>;
  addDetection: (d: Omit<WaterDetection, 'id'>) => Promise<string>;
  setDetectionStatus: (id: string, status: WaterDetection['status']) => Promise<void>;
  /** Confirms a water spot and assigns a 'Clear standing water' task due before its breeding window closes. */
  dispatchDetection: (d: WaterDetection) => Promise<void>;
}

const C = createContext<Ctx | null>(null);
const SCOPE_KEY = 'kmc-dengue-scope';
const OVERRIDE_KEY = 'kmc-dengue-water-status';
const DRILL_KEY = 'kmc-dengue-drill';

function loadJson<T>(key: string, fallback: T): T {
  try { const raw = safeStorage()?.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function saveJson(key: string, v: unknown) { try { safeStorage()?.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }

const opsFromDb = (d: Db): Operational => ({ cases: d.cases, surveys: d.surveys, sites: d.sites, tasks: d.tasks, alerts: d.alerts, citizen: d.citizen, detections: d.detections, teams: d.teams });

export function DataProvider({ children }: { children: ReactNode }) {
  const today = todayIso();
  const hasApi = apiAvailable();
  const live0 = isSupabaseConfigured();
  const [pub, setPub] = useState<PublicData | null>(null);
  const [ops, setOps] = useState<Operational>(EMPTY_OPS);
  const [opsLoaded, setOpsLoaded] = useState(!live0);
  const [overrides, setOverrides] = useState<Record<string, Partial<WaterDetection>>>(() => loadJson(OVERRIDE_KEY, {}));
  const [drill, setDrillState] = useState<boolean>(() => !hasApi || loadJson(DRILL_KEY, false));
  const [drillDb, setDrillDb] = useState<Db | null>(null);
  const [viewDate, setViewDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<EngineConfig>(DEFAULT_CONFIG);
  const [toast, setToast] = useState<string | null>(null);
  const [scope, setScopeState] = useState<Scope>(() => loadJson(SCOPE_KEY, { role: 'hq', borough: 'XII', ward: 106 } as Scope));
  const setScope = (s: Scope) => { setScopeState(s); saveJson(SCOPE_KEY, s); };
  const setDrill = (on: boolean) => { if (!hasApi && !on) return; setDrillState(on); saveJson(DRILL_KEY, on); };

  // live open data
  useEffect(() => { if (hasApi) loadPublic(setPub); }, [hasApi]);

  // KMC database (cases, surveys, tasks…) when configured
  const [needsLogin, setNeedsLogin] = useState(false);
  useEffect(() => {
    if (!live0) return;
    let alive = true;
    const load = async () => {
      try {
        if (!(await currentSession())) { if (alive) setNeedsLogin(true); return; }
        const p = await myProfile();
        if (!p) throw new Error('Your account has no KMC role yet. Ask the HQ administrator to add your profile.');
        setScopeState({ role: p.role as Role, borough: (p.borough ?? 'I') as BoroughCode, ward: p.ward_no ?? 1 });
        const data = await loadFromSupabase(today);
        if (alive) { setNeedsLogin(false); setOps(opsFromDb(data)); setOpsLoaded(true); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const sub = sb().auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_IN') load(); });
    return () => { alive = false; sub.data.subscription.unsubscribe(); };
  }, [live0, today]);

  useEffect(() => { if (drill && !drillDb) setDrillDb(generateDemo(today)); }, [drill, drillDb, today]);

  const signIn = async (email: string, password?: string) => {
    if (password) {
      const { error } = await sb().auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      return;
    }
    const { error } = await sb().auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href.split('#')[0] } });
    if (error) throw new Error(error.message);
  };
  const signOut = async () => { if (live0) await sb().auth.signOut(); window.location.reload(); };

  // KMC gauge readings replace modelled rain on the days they were published
  const pubAdj = useMemo(() => (pub ? applyGauges(pub) : null), [pub]);
  const db = useMemo<Db | null>(() => {
    if (drill) return drillDb;
    if (!pubAdj?.weather || !opsLoaded) return null;
    const asOf = viewDate && viewDate < pubAdj.weather.today ? viewDate : pubAdj.weather.today;
    return buildPublicDb(pubAdj, asOf, ops, live0 ? 'supabase' : 'public', overrides);
  }, [drill, drillDb, pubAdj, ops, opsLoaded, viewDate, overrides, live0]);

  const a = useMemo(() => (db ? analyse(db, { config }) : null), [db, config]);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }, []);

  /** Writes go to the drill dataset, or to the operational records (and KMC's database when connected). */
  const mutate = useCallback((f: (o: Operational) => Operational) => {
    if (drill) setDrillDb((d) => (d ? { ...d, ...f(opsFromDb(d)) } : d));
    else setOps((o) => f(o));
  }, [drill]);
  const persist = !drill && live0;

  const addCase: Ctx['addCase'] = async (c) => {
    const row = { ...c, id: uid('C') };
    if (persist) row.id = await repo.insertCase(row);
    mutate((d) => ({ ...d, cases: [...d.cases, row] }));
  };
  const importCases: Ctx['importCases'] = async (rows) => {
    const withIds = rows.map((r) => ({ ...r, id: uid('C') }));
    if (persist) await repo.insertCases(withIds);
    mutate((d) => {
      const seen = new Set(d.cases.map((c) => c.dedupeKey));
      return { ...d, cases: [...d.cases, ...withIds.filter((r) => !seen.has(r.dedupeKey))] };
    });
    return withIds.length;
  };
  const addSurvey: Ctx['addSurvey'] = async (s) => {
    const row = { ...s, id: uid('S') };
    if (persist) row.id = await repo.insertSurvey(row);
    mutate((d) => ({ ...d, surveys: [...d.surveys, row] }));
  };
  const addSite: Ctx['addSite'] = async (s) => {
    const row = { ...s, id: uid('B') };
    if (persist) row.id = await repo.insertSite(row);
    mutate((d) => ({ ...d, sites: [...d.sites, row] }));
  };
  const addTask: Ctx['addTask'] = async (t) => {
    const row: FieldTask = { ...t, id: uid('T'), createdAt: new Date().toISOString() };
    if (persist) row.id = (await repo.insertTasks([row]))[0];
    mutate((d) => ({ ...d, tasks: [...d.tasks, row] }));
  };
  const setTaskStatus: Ctx['setTaskStatus'] = async (id, status) => {
    const completedAt = status === 'Done' || status === 'Verified' ? new Date().toISOString() : undefined;
    if (persist) await repo.updateTask(id, { status, completedAt });
    mutate((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, status, completedAt: completedAt ?? t.completedAt } : t)) }));
  };
  const setAlertStatus: Ctx['setAlertStatus'] = async (id, status) => {
    if (persist) await repo.updateAlert(id, { status });
    mutate((d) => ({ ...d, alerts: d.alerts.map((x) => (x.id === id ? { ...x, status } : x)) }));
  };
  const actionAlert: Ctx['actionAlert'] = async (alert) => {
    if (!db) return 0;
    const now = Date.now();
    const team = db.teams[alert.ward]?.[0] ?? `VCT-${alert.ward}-A`;
    const rows: FieldTask[] = SOP[alert.type].map((tpl) => ({
      id: uid('T'), ward: alert.ward, type: tpl.type, title: tpl.title, priority: tpl.priority, status: 'Open',
      createdAt: new Date(now).toISOString(), dueAt: new Date(now + tpl.slaHours * 3600000).toISOString(),
      source: 'Alert', alertId: alert.id, team,
    }));
    if (persist) {
      const ids = await repo.insertTasks(rows);
      ids.forEach((id, i) => { rows[i].id = id; });
      await repo.updateAlert(alert.id, { status: 'Acknowledged' });
    }
    mutate((d) => ({ ...d, tasks: [...d.tasks, ...rows], alerts: d.alerts.map((x) => (x.id === alert.id ? { ...x, status: 'Acknowledged' } : x)) }));
    return rows.length;
  };
  const runAlerting: Ctx['runAlerting'] = async () => {
    if (!db || !a) return 0;
    const weekAgo = Date.now() - 7 * 86400000;
    const active = new Set(db.alerts.filter((x) => x.status !== 'Closed' && Date.parse(x.createdAt) > weekAgo).map((x) => `${x.ward}:${x.type}`));
    const now = new Date().toISOString();
    const fresh: Alert[] = a.signals
      .filter((s) => !active.has(`${s.ward}:${s.type}`))
      .map((s) => ({ id: uid('A'), ward: s.ward, type: s.type, level: s.level, title: s.title, detail: s.detail, createdAt: now, status: 'New', clusterCentroid: s.clusterCentroid, caseIds: s.caseIds }));
    if (persist && fresh.length) {
      const ids = await repo.insertAlerts(fresh);
      ids.forEach((id, i) => { fresh[i].id = id; });
    }
    mutate((d) => ({ ...d, alerts: [...fresh, ...d.alerts] }));
    return fresh.length;
  };
  const setCitizenStatus: Ctx['setCitizenStatus'] = async (id, status) => {
    if (persist) await repo.updateCitizen(id, { status });
    mutate((d) => ({ ...d, citizen: d.citizen.map((x) => (x.id === id ? { ...x, status } : x)) }));
  };

  const isOwn = (id: string) => drill || ops.detections.some((d) => d.id === id);
  const override = (id: string, patch: Partial<WaterDetection>) => {
    setOverrides((o) => { const n = { ...o, [id]: { ...(o[id] ?? {}), ...patch } }; saveJson(OVERRIDE_KEY, n); return n; });
  };
  const addDetection: Ctx['addDetection'] = async (d) => {
    const row: WaterDetection = { ...d, id: uid('W') };
    if (persist) row.id = await repo.insertDetection(row);
    mutate((x) => ({ ...x, detections: [row, ...x.detections] }));
    return row.id;
  };
  const setDetectionStatus: Ctx['setDetectionStatus'] = async (id, status) => {
    const clearedOn = status === 'Cleared' ? (db?.asOf ?? today) : undefined;
    const verifiedAt = new Date().toISOString();
    if (!isOwn(id)) { override(id, { status, clearedOn, verifiedAt }); return; }
    if (persist) await repo.updateDetection(id, { status, clearedOn });
    mutate((x) => ({ ...x, detections: x.detections.map((d) => (d.id === id ? { ...d, status, clearedOn: clearedOn ?? d.clearedOn, verifiedAt: d.verifiedAt ?? verifiedAt } : d)) }));
  };
  const dispatchDetection: Ctx['dispatchDetection'] = async (d) => {
    if (!db || !a) return;
    const clearBy = addDays(d.waterSince, aedesDevelopmentDays(a.meanTempC) - 1);
    const due = Math.max(Date.now() + 6 * 3600000, Date.parse(clearBy) + 12 * 3600000);
    const task: FieldTask = {
      id: uid('T'), ward: d.ward, type: 'Clear standing water', title: `Clear ${d.kind.toLowerCase()} (${d.source})`,
      priority: Date.parse(clearBy) - Date.now() < 2 * 86400000 ? 'P1' : 'P2', status: 'Open', createdAt: new Date().toISOString(),
      dueAt: new Date(due).toISOString(), source: 'Alert', team: db.teams[d.ward]?.[0] ?? `VCT-${d.ward}-A`,
      notes: `Water spot ${d.id} at ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}${d.sensor ? ` — ${d.sensor}` : ''}`,
    };
    if (persist) task.id = (await repo.insertTasks([task]))[0];
    if (!isOwn(d.id)) {
      override(d.id, { status: 'Confirmed', taskId: task.id, verifiedAt: new Date().toISOString() });
      mutate((x) => ({ ...x, tasks: [...x.tasks, task] }));
      return;
    }
    if (persist) await repo.updateDetection(d.id, { status: 'Confirmed', taskId: task.id });
    mutate((x) => ({
      ...x,
      tasks: [...x.tasks, task],
      detections: x.detections.map((y) => (y.id === d.id ? { ...y, status: 'Confirmed', taskId: task.id, verifiedAt: y.verifiedAt ?? new Date().toISOString() } : y)),
    }));
  };

  const value: Ctx = {
    db, pub: pubAdj, needsLogin, signIn, signOut, roleLocked: live0 && !drill, a, error, scope, setScope, config, setConfig, toast, notify,
    drill, setDrill, viewDate, setViewDate, today: pub?.weather?.today ?? today,
    addCase, addSurvey, addSite, addTask, setTaskStatus, setAlertStatus, actionAlert, runAlerting, setCitizenStatus, importCases,
    addDetection, setDetectionStatus, dispatchDetection,
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useData() {
  const v = useContext(C);
  if (!v) throw new Error('useData outside DataProvider');
  return v;
}

/** Wards visible to the current role. */
export function useScopedWards() {
  const { db, scope } = useData();
  return useMemo(() => {
    if (!db) return [];
    if (scope.role === 'hq' || scope.role === 'lab') return db.wards;
    if (scope.role === 'borough') return db.wards.filter((w) => w.borough === scope.borough);
    return db.wards.filter((w) => w.ward === scope.ward);
  }, [db, scope]);
}

export const canEdit = (role: Role) => role !== 'councillor';
