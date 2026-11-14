// POST /api/vision  { image: <base64 JPEG/PNG>, mediaType, prompt }  → { text, model }
// GET  /api/vision → { enabled } (whether a vision key is configured)
// Relays one photo + the app's standing-water prompt to Claude vision. The browser builds the
// prompt (supabase/functions/_shared/vision.ts) and normalises the reply, so there is one copy of
// both. Only that prompt is accepted, so the key cannot be used for anything else.
// Env: ANTHROPIC_API_KEY (required), VISION_MODEL (default claude-sonnet-5-5).
import { send } from './_lib/util.js';

const PREFIX = 'You are a vector-control assistant for the Kolkata Municipal Corporation.';
const MODEL = () => process.env.VISION_MODEL || 'claude-sonnet-5-5';

export default async function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') { send(res, { enabled: Boolean(key), model: key ? MODEL() : null }, { sMaxAge: 60 }); return; }
  if (req.method !== 'POST') { send(res, { error: 'POST only' }, { sMaxAge: 0, status: 405 }); return; }
  if (!key) { send(res, { error: 'AI vision is not configured on this deployment' }, { sMaxAge: 0, status: 503 }); return; }
  const origin = req.headers.origin || '';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (origin && !origin.endsWith(host)) { send(res, { error: 'cross-origin requests are not allowed' }, { sMaxAge: 0, status: 403 }); return; }
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { image, mediaType = 'image/jpeg', prompt } = body;
  if (typeof prompt !== 'string' || !prompt.startsWith(PREFIX) || prompt.length > 4000) { send(res, { error: 'unsupported prompt' }, { sMaxAge: 0, status: 400 }); return; }
  if (typeof image !== 'string' || image.length < 100 || image.length > 4_200_000) { send(res, { error: 'image missing or too large (resize to under 3 MB)' }, { sMaxAge: 0, status: 413 }); return; }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) { send(res, { error: 'use a JPEG, PNG or WebP image' }, { sMaxAge: 0, status: 415 }); return; }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL(), max_tokens: 900,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: image } }, { type: 'text', text: prompt }] }],
      }),
      signal: AbortSignal.timeout(55000),
    });
    const j = await r.json();
    if (!r.ok) { send(res, { error: `vision model ${r.status}: ${JSON.stringify(j).slice(0, 300)}` }, { sMaxAge: 0, status: 502 }); return; }
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    send(res, { text, model: j.model || MODEL() }, { sMaxAge: 0 });
  } catch (e) {
    send(res, { error: String(e.message || e) }, { sMaxAge: 0, status: 502 });
  }
}
