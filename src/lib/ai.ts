// AI vision for standing water. Ways to reach the model, tried in this order:
//   1. Web deployment with a vision key: photo (resized) → /api/vision → Claude vision.
//   2. KMC deployment with Supabase: photo → Storage → analyze-image Edge Function → Claude vision.
//   3. Inside Claude (the published demo): Claude vision through the viewer's own Claude account.
//   4. None of these: the feature is shown as unavailable.
import { normalizeVision, visionPrompt, type ImageSource, type VisionResult } from '@shared/vision';
import { isSupabaseConfigured, repo, sb } from './supabase';
import { apiAvailable } from './live';

let apiVision: Promise<boolean> | null = null;
function apiVisionEnabled(): Promise<boolean> {
  if (!apiAvailable()) return Promise.resolve(false);
  apiVision ??= fetch('/api/vision', { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).then((j) => Boolean(j.enabled)).catch(() => false);
  return apiVision;
}

/** Downscales a photo to at most `max` px on the long side as JPEG (keeps uploads small and fast). */
async function toJpegBase64(file: File, max = 1600): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85);
  return url.slice(url.indexOf(',') + 1);
}

declare global {
  interface Window { claude?: { use: (name: string) => Promise<unknown> } }
}
type SampleFn = { json: (input: string, opts?: Record<string, unknown>) => Promise<unknown>; limits: () => Promise<{ images?: { maxCount: number; mediaTypes: string[] } }> };

let samplePromise: Promise<SampleFn | null> | null = null;
function getSample(): Promise<SampleFn | null> {
  if (!window.claude?.use) return Promise.resolve(null);
  samplePromise ??= (window.claude.use('sample') as Promise<SampleFn | null>).catch(() => null);
  return samplePromise;
}

export type VisionChannel = 'api' | 'server' | 'claude' | 'none';
export async function visionChannel(): Promise<{ channel: VisionChannel; accept: string }> {
  if (await apiVisionEnabled()) return { channel: 'api', accept: 'image/*' };
  if (isSupabaseConfigured()) return { channel: 'server', accept: 'image/*' };
  const s = await getSample();
  if (!s) return { channel: 'none', accept: '' };
  try {
    const lim = await s.limits();
    return lim?.images ? { channel: 'claude', accept: lim.images.mediaTypes.join(',') } : { channel: 'none', accept: '' };
  } catch {
    return { channel: 'none', accept: '' };
  }
}

export interface VisionOutcome { result: VisionResult; model: string; photoPath?: string }

export async function analyzeImage(file: File, source: ImageSource, ctx: { ward?: number; capturedOn?: string; note?: string }): Promise<VisionOutcome> {
  if (await apiVisionEnabled()) {
    let authz: Record<string, string> = {};
    if (isSupabaseConfigured()) {
      const { data } = await sb().auth.getSession();
      if (data.session) authz = { authorization: `Bearer ${data.session.access_token}` };
    }
    const r = await fetch('/api/vision', {
      method: 'POST', headers: { 'content-type': 'application/json', ...authz },
      body: JSON.stringify({ image: await toJpegBase64(file), mediaType: 'image/jpeg', prompt: visionPrompt(source, ctx) }),
      signal: AbortSignal.timeout(70000),
    });
    const j = await r.json();
    if (!r.ok) throw { code: r.status === 429 ? 'rate_limited' : 'error', message: j.error ?? `HTTP ${r.status}` };
    const text = String(j.text ?? '');
    let parsed: unknown;
    try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { throw { code: 'invalid_json', message: 'reply was not JSON' }; }
    return { result: normalizeVision(parsed), model: String(j.model ?? 'Claude vision') };
  }
  if (isSupabaseConfigured()) {
    const r = (await repo.analyzeImage(file, { source, ...ctx })) as { result?: unknown; model?: string; photoPath: string };
    return { result: normalizeVision(r.result), model: String(r.model ?? 'server model'), photoPath: String(r.photoPath) };
  }
  const s = await getSample();
  if (!s) throw { code: 'unavailable', message: 'AI vision is not available here' };
  const raw = await s.json(visionPrompt(source, ctx), { images: [file], modelTier: 'default' });
  return { result: normalizeVision(raw), model: 'Claude vision' };
}

export function visionError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  switch (code) {
    case 'not_granted': return 'AI analysis was not allowed. Allow it when asked to use this feature.';
    case 'rate_limited': return 'Too many analyses just now. Try again in a minute.';
    case 'image_rejected': return 'This file could not be read. Use a JPEG or PNG photo under 20 MB.';
    case 'invalid_json': return 'The AI reply could not be read. Try again.';
    case 'refused': return 'The AI declined this image. Try a different photo.';
    case 'unavailable': case 'images_unavailable': case 'sampling_disabled': return 'AI vision is not available in this view.';
    default: return (e as { message?: string })?.message ?? 'Analysis failed. Try again.';
  }
}
