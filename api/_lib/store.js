// Persistence for computed public-data layers (Supabase table `public_layers`).
// Two ways in, whichever is configured:
//   • SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY: direct table access;
//   • SUPABASE_URL + SUPABASE_ANON_KEY + LAYER_WRITE_TOKEN: the layer_get / layer_list / layer_put
//     database functions (migration 0006), so the service key never has to leave Supabase.
// With neither, the functions still work and results are only cached by the CDN.

const URL_ = () => process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = () => process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const TOKEN = () => process.env.LAYER_WRITE_TOKEN;

export const hasStore = () => Boolean(URL_() && (SERVICE() || (ANON() && TOKEN())));
const viaRpc = () => !SERVICE();

function headers(extra = {}) {
  const k = SERVICE() || ANON();
  return { apikey: k, authorization: `Bearer ${k}`, 'content-type': 'application/json', ...extra };
}
async function rpc(fn, args, timeout = 15000) {
  const r = await fetch(`${URL_()}/rest/v1/rpc/${fn}`, { method: 'POST', headers: headers(), body: JSON.stringify(args), signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function getLayer(key) {
  if (!hasStore()) return null;
  try {
    let rows;
    if (viaRpc()) rows = await rpc('layer_get', { p_key: key });
    else {
      const r = await fetch(`${URL_()}/rest/v1/public_layers?key=eq.${encodeURIComponent(key)}&select=data,updated_at`, { headers: headers(), signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      rows = await r.json();
    }
    return rows[0] ? { data: rows[0].data, updatedAt: rows[0].updated_at } : null;
  } catch (e) { console.error('getLayer', key, e.message); return null; }
}

/** Rows whose key starts with prefix; returns [{key, data, updatedAt}] (data omitted when meta=true). */
export async function listLayers(prefix, { meta = false, limit = 500 } = {}) {
  if (!hasStore()) return [];
  try {
    let rows;
    if (viaRpc()) rows = await rpc('layer_list', { p_prefix: prefix, p_meta: meta, p_limit: limit }, 25000);
    else {
      const sel = meta ? 'key,updated_at' : 'key,data,updated_at';
      const r = await fetch(`${URL_()}/rest/v1/public_layers?key=like.${encodeURIComponent(prefix)}*&select=${sel}&order=key.asc&limit=${limit}`, { headers: headers(), signal: AbortSignal.timeout(25000) });
      if (!r.ok) return [];
      rows = await r.json();
    }
    return rows.map((x) => ({ key: x.key, data: x.data, updatedAt: x.updated_at }));
  } catch (e) { console.error('listLayers', prefix, e.message); return []; }
}

export async function putLayer(key, data, source) {
  if (!hasStore()) return false;
  try {
    if (viaRpc()) { await rpc('layer_put', { p_key: key, p_data: data, p_source: source || null, p_token: TOKEN() }, 30000); return true; }
    const r = await fetch(`${URL_()}/rest/v1/public_layers?on_conflict=key`, {
      method: 'POST',
      headers: headers({ prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ key, data, source: source || null, updated_at: new Date().toISOString() }]),
      signal: AbortSignal.timeout(30000),
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
