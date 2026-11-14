// Shared helpers for the data functions (Vercel Node runtime, ESM).

export const KMC_BBOX = [88.22, 22.44, 88.51, 22.66]; // lon/lat, covers all 144 wards
export const UA = 'KMC-Dengue-Intelligence/0.3 (BAESS Labs; public-data prototype)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isoDate = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
export const addDays = (iso, n) => isoDate(Date.parse(iso) + n * 86400000);

/** fetch → JSON with timeout and retries on 429/5xx/network errors. */
export async function fetchJson(url, init = {}, { timeoutMs = 45000, retries = 2, label = '' } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, {
        ...init,
        headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await r.text();
      if (r.ok) {
        try { return JSON.parse(text); } catch { throw new Error(`${label || url}: response is not JSON: ${text.slice(0, 200)}`); }
      }
      last = new Error(`${label || new URL(url).host} HTTP ${r.status}: ${text.slice(0, 300)}`);
      last.status = r.status;
      if (r.status !== 429 && r.status < 500) throw last;
    } catch (e) {
      last = e;
      if (e && e.status && e.status !== 429 && e.status < 500) throw e;
    }
    await sleep(800 * (attempt + 1) ** 2);
  }
  throw last;
}

/** Runs fn over items with at most n in flight; keeps order. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

export function chunk(a, n) {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/** JSON response with CDN caching. sMaxAge in seconds. */
export function send(res, body, { sMaxAge = 3600, swr = 86400, status = 200 } = {}) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', sMaxAge > 0 ? `public, max-age=60, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}` : 'no-store');
  res.status(status).send(JSON.stringify(body));
}

export function sendError(res, e, source) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[${source}]`, msg);
  send(res, { error: msg, source }, { sMaxAge: 0, status: 502 });
}

/** Admin / cron authorisation: Vercel cron sends `Authorization: Bearer $CRON_SECRET`. */
export function isAdmin(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = req.headers?.authorization || '';
  return h === `Bearer ${secret}` || req.query?.key === secret;
}

export const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));
