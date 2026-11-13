import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_CONFIG, SOP, type EngineConfig } from '@shared/risk-engine';
import { analyse, type Analytics } from './analytics';
import { generateDemo } from './demo/generator';
import { currentSession, isSupabaseConfigured, loadFromSupabase, myProfile, repo, sb } from './supabase';
import type { Alert, BoroughCode, BreedingSite, CitizenReport, Db, DengueCase, FieldTask, LarvalSurvey, TaskStatus } from './types';
import { safeStorage, todayIso, uid } from './util';

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
  needsLogin: boolean;
  signIn: (email: string) => Promise<void>;
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
}

const C = createContext<Ctx | null>(null);
const SCOPE_KEY = 'kmc-dengue-scope';

export function DataProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<Db | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<EngineConfig>(DEFAULT_CONFIG);
  const [toast, setToast] = useState<string | null>(null);
  const [scope, setScopeState] = useState<Scope>(() => {
    try {
      const raw = safeStorage()?.getItem(SCOPE_KEY);
      if (raw) return JSON.parse(raw) as Scope;
    } catch { /* ignore */ }
    return { role: 'hq', borough: 'VII', ward: 66 };
  });
  const setScope = (s: Scope) => {
    setScopeState(s);
    try { safeStorage()?.setItem(SCOPE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  };

  const [needsLogin, setNeedsLogin] = useState(false);
  const live0 = isSupabaseConfigured();
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        if (!live0) { setDb(generateDemo(todayIso())); return; }
        if (!(await currentSession())) { if (alive) setNeedsLogin(true); return; }
        const p = await myProfile();
        if (!p) throw new Error('Your account has no KMC role yet. Ask the HQ administrator to add your profile.');
        setScopeState({ role: p.role as Role, borough: (p.borough ?? 'I') as BoroughCode, ward: p.ward_no ?? 1 });
        const data = await loadFromSupabase(todayIso());
        if (alive) { setNeedsLogin(false); setDb(data); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const sub = live0 ? sb().auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_IN') load(); }) : null;
    return () => { alive = false; sub?.data.subscription.unsubscribe(); };
  }, [live0]);
  const signIn = async (email: string) => {
    const { error } = await sb().auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href.split('#')[0] } });
    if (error) throw new Error(error.message);
  };
  const signOut = async () => { if (live0) await sb().auth.signOut(); window.location.reload(); };

  const a = useMemo(() => (db ? analyse(db, { config }) : null), [db, config]);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }, []);

  const mutate = useCallback((f: (d: Db) => Db) => setDb((d) => (d ? f(d) : d)), []);
  const live = db?.mode === 'supabase';

  const addCase: Ctx['addCase'] = async (c) => {
    const row = { ...c, id: uid('C') };
    if (live) row.id = await repo.insertCase(row);
    mutate((d) => ({ ...d, cases: [...d.cases, row] }));
  };
  const importCases: Ctx['importCases'] = async (rows) => {
    const withIds = rows.map((r) => ({ ...r, id: uid('C') }));
    if (live) await repo.insertCases(withIds);
    mutate((d) => {
      const seen = new Set(d.cases.map((c) => c.dedupeKey));
      const fresh = withIds.filter((r) => !seen.has(r.dedupeKey));
      return { ...d, cases: [...d.cases, ...fresh] };
    });
    return withIds.length;
  };
  const addSurvey: Ctx['addSurvey'] = async (s) => {
    const row = { ...s, id: uid('S') };
    if (live) row.id = await repo.insertSurvey(row);
    mutate((d) => ({ ...d, surveys: [...d.surveys, row] }));
  };
  const addSite: Ctx['addSite'] = async (s) => {
    const row = { ...s, id: uid('B') };
    if (live) row.id = await repo.insertSite(row);
    mutate((d) => ({ ...d, sites: [...d.sites, row] }));
  };
  const addTask: Ctx['addTask'] = async (t) => {
    const row: FieldTask = { ...t, id: uid('T'), createdAt: new Date().toISOString() };
    if (live) row.id = (await repo.insertTasks([row]))[0];
    mutate((d) => ({ ...d, tasks: [...d.tasks, row] }));
  };
  const setTaskStatus: Ctx['setTaskStatus'] = async (id, status) => {
    const completedAt = status === 'Done' || status === 'Verified' ? new Date().toISOString() : undefined;
    if (live) await repo.updateTask(id, { status, completedAt });
    mutate((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, status, completedAt: completedAt ?? t.completedAt } : t)) }));
  };
  const setAlertStatus: Ctx['setAlertStatus'] = async (id, status) => {
    if (live) await repo.updateAlert(id, { status });
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
    if (live) {
      const ids = await repo.insertTasks(rows);
      ids.forEach((id, i) => { rows[i].id = id; });
      await repo.updateAlert(alert.id, { status: 'Acknowledged' });
    }
    mutate((d) => ({
      ...d,
      tasks: [...d.tasks, ...rows],
      alerts: d.alerts.map((x) => (x.id === alert.id ? { ...x, status: 'Acknowledged' } : x)),
    }));
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
    if (live && fresh.length) {
      const ids = await repo.insertAlerts(fresh);
      ids.forEach((id, i) => { fresh[i].id = id; });
    }
    mutate((d) => ({ ...d, alerts: [...fresh, ...d.alerts] }));
    return fresh.length;
  };
  const setCitizenStatus: Ctx['setCitizenStatus'] = async (id, status) => {
    if (live) await repo.updateCitizen(id, { status });
    mutate((d) => ({ ...d, citizen: d.citizen.map((x) => (x.id === id ? { ...x, status } : x)) }));
  };

  const value: Ctx = {
    db, needsLogin, signIn, signOut, roleLocked: live0, a, error, scope, setScope, config, setConfig, toast, notify,
    addCase, addSurvey, addSite, addTask, setTaskStatus, setAlertStatus, actionAlert, runAlerting, setCitizenStatus, importCases,
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
