// Supabase Edge Function: analyze-image
// Runs AI vision on a photo already uploaded to Storage (bucket: detection-photos) and returns
// the normalised result. The browser then saves the water spot under the user's own RLS scope.
//
// POST { photoPath, source: 'Field photo' | 'Citizen photo' | 'Drone image' | 'CCTV frame', ward?, capturedOn?, note? }
// Secrets: ANTHROPIC_API_KEY; optional VISION_MODEL (default claude-sonnet-5-5).
// Called with the user's JWT (supabase.functions.invoke), so Storage access follows their policies.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { normalizeVision, visionPrompt, type ImageSource } from '../_shared/vision.ts';

const MODEL = Deno.env.get('VISION_MODEL') ?? 'claude-sonnet-5-5';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { photoPath, source = 'Field photo', ward, capturedOn, note } = await req.json();
    if (!photoPath || typeof photoPath !== 'string') return Response.json({ error: 'photoPath required' }, { status: 400, headers: cors });
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: blob, error } = await sb.storage.from('detection-photos').download(photoPath);
    if (error || !blob) return Response.json({ error: `photo not found: ${error?.message}` }, { status: 404, headers: cors });
    if (blob.size > 5 * 1024 * 1024) return Response.json({ error: 'photo larger than 5 MB; resize on the device first' }, { status: 413, headers: cors });
    const mediaType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(blob.type) ? blob.type : 'image/jpeg';

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: toBase64(new Uint8Array(await blob.arrayBuffer())) } },
            { type: 'text', text: visionPrompt(source as ImageSource, { ward, capturedOn, note }) },
          ],
        }],
      }),
    });
    if (!r.ok) return Response.json({ error: `vision model ${r.status}: ${(await r.text()).slice(0, 300)}` }, { status: 502, headers: cors });
    const msg = await r.json();
    const text: string = (msg.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    let parsed: unknown = {};
    try { parsed = JSON.parse(json); } catch { return Response.json({ error: 'model reply was not JSON', raw: text.slice(0, 500) }, { status: 502, headers: cors }); }
    return Response.json({ result: normalizeVision(parsed), model: msg.model ?? MODEL }, { headers: cors });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500, headers: cors });
  }
});
