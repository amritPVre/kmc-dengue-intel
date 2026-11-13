import { useEffect, useState, type FormEvent } from 'react';
import { DataProvider, useData } from './lib/store';
import { href, useRoute } from './lib/router';
import { Layout, homeFor } from './components/Layout';
import { Overview } from './pages/Overview';
import { BoroughDetail, Boroughs } from './pages/Boroughs';
import { WardDetail } from './pages/WardDetail';
import { Alerts } from './pages/Alerts';
import { FieldOps } from './pages/FieldOps';
import { CaseReport } from './pages/CaseReport';
import { Citizen } from './pages/Citizen';
import { SitRep } from './pages/SitRep';
import { Settings } from './pages/Settings';
import { Water } from './pages/Water';

function Login() {
  const { signIn } = useData();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sent' | string>('idle');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { await signIn(email); setState('sent'); } catch (err) { setState(err instanceof Error ? err.message : String(err)); }
  };
  return (
    <div className="grid min-h-screen place-items-center bg-paper p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-lg bg-kmc-600 font-bold text-white">D</span><b>KMC Dengue Intelligence</b></div>
        <label className="block text-sm font-medium text-slate-700">Official email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <button className="mt-4 w-full rounded-lg bg-kmc-600 py-2 text-sm font-medium text-white">Send sign-in link</button>
        {state === 'sent' && <p className="mt-3 text-sm text-emerald-700">Check your inbox for the sign-in link.</p>}
        {state !== 'idle' && state !== 'sent' && <p className="mt-3 text-sm text-red-700">{state}</p>}
        <p className="mt-4 text-xs text-slate-500">Access is limited to KMC health staff, labs and councillors registered by the HQ administrator.</p>
      </form>
    </div>
  );
}

function Pages() {
  const route = useRoute();
  const { db, a, error, scope, needsLogin } = useData();

  // keep each role inside its own area
  useEffect(() => {
    if (!db) return;
    const home = homeFor(scope.role, scope.borough, scope.ward);
    if (!window.location.hash) { window.location.hash = home; return; }
    const r = route;
    const wardOf = (n: number) => db.wards.find((w) => w.ward === n);
    const blocked =
      (scope.role !== 'hq' && (r.page === 'overview' || r.page === 'settings')) ||
      (scope.role !== 'hq' && r.page === 'borough' && (scope.role !== 'borough' || r.code !== scope.borough)) ||
      (scope.role === 'borough' && r.page === 'ward' && wardOf(r.ward)?.borough !== scope.borough) ||
      ((scope.role === 'ward' || scope.role === 'councillor' || scope.role === 'field') && r.page === 'ward' && r.ward !== scope.ward) ||
      ((scope.role === 'ward' || scope.role === 'councillor' || scope.role === 'field') && r.page === 'boroughs') ||
      (scope.role === 'field' && !['field', 'ward', 'water'].includes(r.page)) ||
      (scope.role === 'lab' && r.page !== 'cases') ||
      (scope.role === 'councillor' && ['field', 'cases', 'citizen'].includes(r.page));
    if (blocked) window.location.hash = home;
  }, [route, scope, db]);

  if (needsLogin) return <Login />;
  if (error) return <div className="p-6 text-red-700">Could not load data: {error}</div>;
  if (!db || !a) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-slate-600">
        <div className="text-center"><div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-4 border-kmc-100 border-t-kmc-600" />Loading ward data…</div>
      </div>
    );
  }
  let page;
  switch (route.page) {
    case 'overview': page = <Overview />; break;
    case 'water': page = <Water />; break;
    case 'boroughs': page = <Boroughs />; break;
    case 'borough': page = <BoroughDetail code={route.code} />; break;
    case 'ward': page = <WardDetail key={route.ward} ward={route.ward} />; break;
    case 'alerts': page = <Alerts />; break;
    case 'field': page = <FieldOps />; break;
    case 'cases': page = <CaseReport />; break;
    case 'citizen': page = <Citizen />; break;
    case 'sitrep': page = <SitRep />; break;
    case 'settings': page = <Settings />; break;
    default: page = <a href={href.overview}>Go to overview</a>;
  }
  return <Layout route={route}>{page}</Layout>;
}

export default function App() {
  return <DataProvider><Pages /></DataProvider>;
}
