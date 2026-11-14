// Persistence for computed public-data layers (Supabase table `public_layers`).
// Without SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY the functions still work: results are
// then only cached by the CDN.

const URL_ = () => process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

export const hasStore = () => Boolean(URL_() && KEY());

function headers(extra = {}) {
  return { apikey: KEY(), authorization: `Bearer ${KEY()}`, 'content-type': 'application/json', ...extra };
}

export async function getLayer(key) {
  if (!hasStore()) return null;
  try {
    const r = await fetch(`${URL_()}/rest/v1/public_layers?key=eq.${encodeURIComponent(key)}&select=data,updated_at`, { headers: headers(), signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] ? { data: rows[0].data, updatedAt: rows[0].updated_at } : null;
  } catch { return null; }
}

/** Rows whose key starts with prefix; returns [{key, data, updatedAt}] (data omitted when meta=true). */
export async function listLayers(prefix, { meta = false, limit = 500 } = {}) {
  if (!hasStore()) return [];
  try {
    const sel = meta ? 'key,updated_at' : 'key,data,updated_at';
    const r = await fetch(`${URL_()}/rest/v1/public_layers?key=like.${encodeURIComponent(prefix)}*&select=${sel}&order=key.asc&limit=${limit}`, { headers: headers(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    return (await r.json()).map((x) => ({ key: x.key, data: x.data, updatedAt: x.updated_at }));
  } catch { return []; }
}

export async function putLayer(key, data, source) {
  if (!hasStore()) return false;
  try {
    const r = await fetch(`${URL_()}/rest/v1/public_layers?on_conflict=key`, {
      method: 'POST',
      headers: headers({ prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ key, data, source: source || null, updated_at: new Date().toISOString() }]),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) console.error('putLayer', key, r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error('putLayer', key, e.message); return false; }
}

/** Returns the stored layer if younger than maxAgeHours, else computes, stores and returns it. */
export async function cached(key, maxAgeHours, compute, source) {
  const hit = await getLayer(key);
  if (hit && Date.now() - Date.parse(hit.updatedAt) < maxAgeHours * 3600000) return { ...hit, fromStore: true };
  try {
    const data = await compute();
    await putLayer(key, data, source);
    return { data, updatedAt: new Date().toISOString(), fromStore: false };
  } catch (e) {
    if (hit) return { ...hit, fromStore: true, stale: true, refreshError: e.message };
    throw e;
  }
}
