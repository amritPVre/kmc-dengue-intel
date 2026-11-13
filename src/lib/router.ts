import { useEffect, useState } from 'react';

// Plain hash routes (#overview, #borough-vii, #ward-66 …) so the app works when hosted
// as static files anywhere, including sandboxed previews.
export type Route =
  | { page: 'overview' } | { page: 'boroughs' } | { page: 'borough'; code: string } | { page: 'ward'; ward: number }
  | { page: 'water' } | { page: 'alerts' } | { page: 'field' } | { page: 'cases' } | { page: 'citizen' } | { page: 'sitrep' } | { page: 'settings' };

export function parseHash(h: string): Route {
  const s = h.replace(/^#/, '').toLowerCase();
  const b = s.match(/^borough-([ivx]+)$/);
  if (b) return { page: 'borough', code: b[1].toUpperCase() };
  const w = s.match(/^ward-(\d{1,3})$/);
  if (w) return { page: 'ward', ward: Number(w[1]) };
  if (s === 'config') return { page: 'settings' }; // '#settings' is reserved by some hosts
  const simple = ['overview', 'water', 'boroughs', 'alerts', 'field', 'cases', 'citizen', 'sitrep'] as const;
  if ((simple as readonly string[]).includes(s)) return { page: s as (typeof simple)[number] } as Route;
  return { page: 'overview' };
}

export const href = {
  overview: '#overview',
  boroughs: '#boroughs',
  borough: (code: string) => `#borough-${code.toLowerCase()}`,
  ward: (n: number) => `#ward-${n}`,
  water: '#water',
  alerts: '#alerts',
  field: '#field',
  cases: '#cases',
  citizen: '#citizen',
  sitrep: '#sitrep',
  settings: '#config',
};

export function useRoute(): Route {
  const [r, setR] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => { setR(parseHash(window.location.hash)); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

export const go = (h: string) => { window.location.hash = h; };
