// Small shared helpers: seeded randomness, dates, geometry, formatting.

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = () => number;

export function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(rng)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}
export function gauss(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function binomial(rng: Rng, n: number, p: number): number {
  if (n <= 0 || p <= 0) return 0;
  if (n > 60) return Math.max(0, Math.min(n, Math.round(n * p + Math.sqrt(n * p * (1 - p)) * gauss(rng))));
  let k = 0;
  for (let i = 0; i < n; i++) if (rng() < p) k++;
  return k;
}
export function pick<T>(rng: Rng, items: readonly T[], weights?: number[]): T {
  if (!weights) return items[Math.floor(rng() * items.length)];
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

// ---- dates (all ISO yyyy-mm-dd, UTC) ----
export const DAY = 86400000;
export const toIso = (d: Date) => d.toISOString().slice(0, 10);
export const parseIso = (s: string) => new Date(s + 'T00:00:00Z');
export const addDays = (s: string, n: number) => toIso(new Date(parseIso(s).getTime() + n * DAY));
export function mondayOf(s: string): string {
  const d = parseIso(s);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return toIso(new Date(d.getTime() - dow * DAY));
}
export const daysBetween = (a: string, b: string) => Math.round((parseIso(b).getTime() - parseIso(a).getTime()) / DAY);
export function todayIso(): string {
  const now = new Date();
  // India Standard Time date
  return toIso(new Date(now.getTime() + 5.5 * 3600000));
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(s: string, withYear = true) {
  const d = parseIso(s.slice(0, 10));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? ' ' + d.getUTCFullYear() : ''}`;
}
export function fmtWeek(s: string) {
  return `${fmtDate(s, false)}–${fmtDate(addDays(s, 6), false)}`;
}
export function fmtDateTime(s: string) {
  const d = new Date(s);
  const ist = new Date(d.getTime() + 5.5 * 3600000);
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${fmtDate(toIso(ist))}, ${hh}:${mm}`;
}

// ---- geometry ----
type Ring = number[][];
type Poly = Ring[];
export function geomPolys(g: { type: string; coordinates: unknown }): Poly[] {
  return g.type === 'Polygon' ? [g.coordinates as Poly] : (g.coordinates as Poly[]);
}
function inRing(x: number, y: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInGeom(lng: number, lat: number, g: { type: string; coordinates: unknown }) {
  for (const poly of geomPolys(g)) {
    if (!inRing(lng, lat, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) if (inRing(lng, lat, poly[h])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}
export function metresBetween(a: [number, number], b: [number, number]) {
  const R = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dx = rad(b[0] - a[0]) * Math.cos(rad((a[1] + b[1]) / 2)) * R;
  const dy = rad(b[1] - a[1]) * R;
  return Math.hypot(dx, dy);
}

// ---- formatting ----
export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-IN');
export const fmt1 = (n: number | null | undefined) => (n == null ? '—' : n.toFixed(1));
export function pctChange(now: number, before: number) {
  if (before === 0) return now === 0 ? 0 : 100;
  return ((now - before) / before) * 100;
}
export const roman = (b: string) => `Borough ${b}`;
export const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

export async function sha256Hex(text: string) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    return 'x' + (h >>> 0).toString(16);
  }
}

export function safeStorage() {
  try {
    const k = '__kmc_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    return null;
  }
}
