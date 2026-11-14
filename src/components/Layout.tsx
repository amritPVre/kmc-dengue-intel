import { useState, type ReactNode } from 'react';
import { AlertTriangle, Bell, CalendarClock, ClipboardList, Database, Droplets, FileText, FlaskConical, LayoutDashboard, Map, Megaphone, Menu, Radar, Radio, Scale, Settings, Stethoscope, X } from 'lucide-react';
import { ROLE_LABEL, useData, type Role } from '@/lib/store';
import { href, type Route } from '@/lib/router';
import { BOROUGHS, type BoroughCode } from '@/lib/types';
import { fmtDate } from '@/lib/util';
import { inputCls } from './ui';

interface NavItem { key: Route['page']; label: string; href: string; icon: ReactNode; roles: Role[] }
const NAV: NavItem[] = [
  { key: 'overview', label: 'City overview', href: href.overview, icon: <LayoutDashboard size={18} />, roles: ['hq'] },
  { key: 'water', label: 'Standing water', href: href.water, icon: <Droplets size={18} />, roles: ['hq', 'borough', 'ward', 'field', 'councillor'] },
  { key: 'satellite', label: 'Satellite radar', href: href.satellite, icon: <Radar size={18} />, roles: ['hq', 'borough', 'ward', 'councillor'] },
  { key: 'evidence', label: 'Evidence check', href: href.evidence, icon: <Scale size={18} />, roles: ['hq', 'borough'] },
  { key: 'boroughs', label: 'Boroughs', href: href.boroughs, icon: <Map size={18} />, roles: ['hq', 'borough'] },
  { key: 'alerts', label: 'Alerts', href: href.alerts, icon: <Bell size={18} />, roles: ['hq', 'borough', 'ward', 'councillor'] },
  { key: 'field', label: 'Field operations', href: href.field, icon: <ClipboardList size={18} />, roles: ['hq', 'borough', 'ward', 'field'] },
  { key: 'cases', label: 'Case reporting', href: href.cases, icon: <Stethoscope size={18} />, roles: ['hq', 'borough', 'ward', 'lab'] },
  { key: 'citizen', label: 'Citizen reports', href: href.citizen, icon: <Megaphone size={18} />, roles: ['hq', 'borough', 'ward'] },
  { key: 'sitrep', label: 'Situation report', href: href.sitrep, icon: <FileText size={18} />, roles: ['hq', 'borough', 'ward', 'councillor'] },
  { key: 'sources', label: 'Data sources', href: href.sources, icon: <Database size={18} />, roles: ['hq', 'borough', 'ward', 'councillor'] },
  { key: 'settings', label: 'Settings & model', href: href.settings, icon: <Settings size={18} />, roles: ['hq'] },
];

export function homeFor(role: Role, borough: BoroughCode, ward: number) {
  if (role === 'hq') return href.overview;
  if (role === 'borough') return href.borough(borough);
  if (role === 'field') return href.field;
  if (role === 'lab') return href.cases;
  return href.ward(ward);
}

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const { db, a, scope, setScope, toast, roleLocked, signOut, drill, setDrill, viewDate, setViewDate, today, pub } = useData();
  const [open, setOpen] = useState(false);
  const newAlerts = db ? db.alerts.filter((x) => x.status === 'New' && (scope.role === 'hq' || (scope.role === 'borough' ? db.wards.find((w) => w.ward === x.ward)?.borough === scope.borough : x.ward === scope.ward))).length : 0;
  const myHome = { key: scope.role === 'borough' ? 'borough' : 'ward', label: scope.role === 'borough' ? `Borough ${scope.borough}` : `Ward ${scope.ward}`, href: scope.role === 'borough' ? href.borough(scope.borough) : href.ward(scope.ward) };
  const items = NAV.filter((n) => n.roles.includes(scope.role));
  const active = (k: string) => route.page === k || (k === 'boroughs' && route.page === 'borough' && scope.role === 'hq');

  const changeRole = (role: Role) => {
    const s = { ...scope, role };
    setScope(s);
    window.location.hash = homeFor(role, s.borough, s.ward);
  };

  const nav = (
    <nav className="flex flex-col gap-0.5 p-2">
      {scope.role !== 'hq' && scope.role !== 'lab' && (
        <a href={myHome.href} onClick={() => setOpen(false)}
          className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium ${route.page === myHome.key ? 'bg-kmc-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}>
          <Map size={18} /> {myHome.label}
        </a>
      )}
      {items.map((n) => (
        <a key={n.key} href={n.href} onClick={() => setOpen(false)}
          className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium ${active(n.key) ? 'bg-kmc-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}>
          {n.icon}<span className="flex-1">{n.label}</span>
          {n.key === 'alerts' && newAlerts > 0 && <span className={`rounded-full px-1.5 text-[11px] font-bold ${active('alerts') ? 'bg-white text-kmc-700' : 'bg-red-600 text-white'}`}>{newAlerts}</span>}
        </a>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen">
      <ModeBanner />
      <header className="sticky top-0 z-[1000] border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="flex items-center gap-3 px-3 py-2.5 lg:px-5">
          <button className="rounded p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
          <a href={homeFor(scope.role, scope.borough, scope.ward)} className="flex shrink-0 items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-kmc-600 text-sm font-bold text-white">D</span>
            <span className="leading-tight">
              <span className="block whitespace-nowrap text-sm font-bold text-ink">KMC Dengue Intelligence</span>
              <span className="hidden text-[11px] text-slate-500 sm:block">Kolkata Municipal Corporation · 16 boroughs · {db?.wards.length ?? 144} wards</span>
            </span>
          </a>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {a && !drill && pub?.weather && (
              <label className="hidden items-center gap-1 text-xs text-slate-500 md:flex" title="Replay the real data as it stood on a past date">
                <CalendarClock size={14} />
                <select aria-label="View date" className={`${inputCls} w-auto py-1 text-xs`} value={viewDate ?? ''} onChange={(e) => setViewDate(e.target.value || null)}>
                  <option value="">Today ({fmtDate(today, false)})</option>
                  {REPLAY_PRESETS.filter((p) => p.date < today).map((p) => <option key={p.date} value={p.date}>{p.label}</option>)}
                  {viewDate && !REPLAY_PRESETS.some((p) => p.date === viewDate) && <option value={viewDate}>{fmtDate(viewDate)}</option>}
                </select>
                <input type="date" aria-label="Pick a date" className={`${inputCls} w-auto py-1 text-xs`} min="2025-06-01" max={today} value={viewDate ?? today} onChange={(e) => setViewDate(e.target.value && e.target.value < today ? e.target.value : null)} />
              </label>
            )}
            {a && drill && <span className="hidden text-xs text-slate-500 md:inline">Drill data as of {fmtDate(db!.asOf)}</span>}
            {scope.role === 'hq' && (
              <button onClick={() => setDrill(!drill)} title={drill ? 'Back to live open data' : 'Practise outbreak response on simulated cases'}
                className={`hidden items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs sm:flex ${drill ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
                {drill ? <><Radio size={13} /> Back to live</> : <><FlaskConical size={13} /> Outbreak drill</>}
              </button>
            )}
            {roleLocked ? (
              <button onClick={signOut} className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50">Sign out</button>
            ) : (
              <select aria-label="Role" className={`${inputCls} w-auto max-w-[13rem] py-1.5 text-xs`} value={scope.role} onChange={(e) => changeRole(e.target.value as Role)}>
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            )}
            {!roleLocked && scope.role === 'borough' && (
              <select aria-label="Borough" className={`${inputCls} w-auto py-1.5 text-xs`} value={scope.borough}
                onChange={(e) => { const b = e.target.value as BoroughCode; setScope({ ...scope, borough: b }); window.location.hash = href.borough(b); }}>
                {BOROUGHS.map((b) => <option key={b} value={b}>Borough {b}</option>)}
              </select>
            )}
            {!roleLocked && (scope.role === 'ward' || scope.role === 'field' || scope.role === 'councillor') && db && (
              <select aria-label="Ward" className={`${inputCls} w-auto py-1.5 text-xs`} value={scope.ward}
                onChange={(e) => { const w = Number(e.target.value); const b = db.wards.find((x) => x.ward === w)!.borough; setScope({ ...scope, ward: w, borough: b }); window.location.hash = scope.role === 'field' ? href.field : href.ward(w); }}>
                {db.wards.map((w) => <option key={w.ward} value={w.ward}>Ward {w.ward} (Borough {w.borough})</option>)}
              </select>
            )}
          </div>
        </div>
      </header>
      <div className="flex">
        <aside className="sticky top-[57px] hidden h-[calc(100vh-57px)] w-60 shrink-0 overflow-y-auto border-r border-slate-200 bg-white lg:block">
          {nav}
          <div className="mx-3 mt-4 rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-500">
            Signed in as <b className="text-slate-700">{ROLE_LABEL[scope.role]}</b>
            {scope.role === 'borough' && <> · Borough {scope.borough}</>}
            {(scope.role === 'ward' || scope.role === 'field' || scope.role === 'councillor') && <> · Ward {scope.ward}</>}
          </div>
        </aside>
        {open && (
          <div className="fixed inset-0 z-[1500] bg-slate-900/40 lg:hidden" onClick={() => setOpen(false)}>
            <div className="h-full w-72 bg-white" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b px-3 py-3"><b className="text-sm">Menu</b><button onClick={() => setOpen(false)} aria-label="Close menu"><X size={18} /></button></div>
              {nav}
            </div>
          </div>
        )}
        <main className="min-w-0 flex-1 px-3 py-4 lg:px-6 lg:py-6">{children}</main>
      </div>
      {toast && <div className="fixed bottom-4 left-1/2 z-[3000] -translate-x-1/2 rounded-lg bg-ink px-4 py-2 text-sm text-white shadow-lg" role="status">{toast}</div>}
    </div>
  );
}

/** Dates worth replaying with real data. */
export const REPLAY_PRESETS = [
  { date: '2025-09-24', label: '24 Sep 2025 — day after the cloudburst' },
  { date: '2025-10-06', label: '6 Oct 2025 — two weeks after the cloudburst' },
  { date: '2026-07-20', label: '20 Jul 2026 — monsoon' },
  { date: '2026-09-15', label: '15 Sep 2026 — before the 2026 rise' },
  { date: '2026-10-07', label: '7 Oct 2026 — 2026 season rise' },
];

function ModeBanner() {
  const { db, drill, setDrill, viewDate, setViewDate, pub, a } = useData();
  if (!db) return null;
  if (drill) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 bg-amber-100 px-3 py-1.5 text-center text-xs font-medium text-amber-900">
        <AlertTriangle size={14} className="shrink-0" /> Outbreak drill — cases, surveys and alerts are simulated for training. Not real KMC data.
        {pub && <button className="underline" onClick={() => setDrill(false)}>Back to live data</button>}
      </div>
    );
  }
  if (viewDate) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 bg-indigo-100 px-3 py-1.5 text-center text-xs font-medium text-indigo-900">
        <CalendarClock size={14} className="shrink-0" /> Replay: real weather, radar and map data as they stood on {fmtDate(db.asOf)}. Rain forecasts are not used in replay.
        <button className="underline" onClick={() => setViewDate(null)}>Back to today</button>
      </div>
    );
  }
  const loading = pub ? Object.values(pub.status).filter((s) => s === 'loading').length : 0;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-emerald-50 px-3 py-1.5 text-center text-xs text-emerald-900">
      <span className="inline-flex items-center gap-1 font-semibold"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-600" /> Live open data</span>
      <span>Weather: Open-Meteo · Radar: Copernicus Sentinel-1 · Land cover: ESA, JRC · Sites: OpenStreetMap · Population: Census 2011</span>
      {a?.noCases && <span className="font-medium text-amber-800">Ward case data: waiting for KMC feed</span>}
      {loading > 0 && <span className="text-slate-600">· loading {loading} more source{loading > 1 ? 's' : ''}…</span>}
      <a href={href.sources} className="underline">Sources</a>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-ink lg:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
