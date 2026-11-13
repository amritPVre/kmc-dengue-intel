// AI vision for standing water and Aedes breeding sites.
// One prompt and one result shape, used by:
//   • the web app (Claude vision through the viewer's Claude account when the app runs inside Claude),
//   • the analyze-image Edge Function (Anthropic API, for KMC's own deployment),
//   • the drone pipeline (pipelines/drone), tile by tile.
// Dependency-free so it runs in the browser and in Deno.

export const WATER_KINDS = [
  'Street / open waterlogging', 'Rooftop water', 'Water-holding containers', 'Construction site water',
  'Discarded tyres', 'Stagnant drain / canal', 'Pond / water body edge', 'Vacant plot pooling', 'No standing water',
] as const;
export type WaterKind = (typeof WATER_KINDS)[number];

export type ImageSource = 'Field photo' | 'Citizen photo' | 'Drone image' | 'CCTV frame';

export interface VisionObject { label: string; count: number; holdsWater: 'yes' | 'no' | 'unclear' }
export interface VisionResult {
  standingWater: boolean;
  confidence: number; // 0–1
  kind: WaterKind;
  scene: string;
  objects: VisionObject[];
  larvaeVisible: 'yes' | 'no' | 'unclear';
  aedesRisk: 'High' | 'Medium' | 'Low';
  reasons: string[];
  recommendedAction: string;
  summary: string;
  imageQuality: 'good' | 'poor';
}

export function visionPrompt(source: ImageSource, context: { ward?: number; capturedOn?: string; note?: string } = {}): string {
  return [
    `You are a vector-control assistant for the Kolkata Municipal Corporation. Look at this ${source.toLowerCase()} and decide whether it shows standing water where Aedes mosquitoes (dengue vectors) could breed.`,
    context.ward ? `It was taken in KMC ward ${context.ward}${context.capturedOn ? ` on ${context.capturedOn}` : ''}.` : '',
    context.note ? `Reporter's note: ${context.note.slice(0, 300)}` : '',
    '',
    'What matters for Aedes: clean or lightly dirty water that has stood for days in artificial containers (tyres, buckets, drums, uncovered overhead tanks, flower-pot trays, coolers, plastic waste, tarpaulin folds, bottles, coconut shells), on rooftops and terraces, at construction sites (curing water, basements, lift pits), and shallow pooling on vacant plots or blocked drains. Large open waterlogging after rain matters if it is likely to stand for several days.',
    'Be conservative: report only what you can see. If you cannot tell whether something holds water, say "unclear". Never claim larvae are visible unless they clearly are. If the image is not a relevant outdoor or indoor scene, set standing_water to false and image_quality to "poor".',
    '',
    'Reply with ONLY one JSON object, no other text, in exactly this shape:',
    '{"standing_water": true, "confidence": 0.0, "kind": "<one of: ' + WATER_KINDS.join(' | ') + '>",',
    ' "scene": "rooftop | street | construction site | vacant plot | drain or canal | household | market | other",',
    ' "objects": [{"label": "tyre", "count": 3, "holds_water": "yes"}],',
    ' "larvae_visible": "yes | no | unclear", "aedes_risk": "High | Medium | Low",',
    ' "reasons": ["short reason", "short reason"], "recommended_action": "one instruction for the field team, under 20 words",',
    ' "summary": "one plain sentence", "image_quality": "good | poor"}',
  ].filter(Boolean).join('\n');
}

const pickEnum = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
  const s = String(v ?? '').trim().toLowerCase();
  return allowed.find((a) => a.toLowerCase() === s) ?? fallback;
};

/** Normalises whatever JSON the model returned into a safe VisionResult. */
export function normalizeVision(raw: unknown): VisionResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const standingWater = r.standing_water === true || String(r.standing_water).toLowerCase() === 'true';
  const conf = Number(r.confidence);
  const objects = Array.isArray(r.objects) ? r.objects.slice(0, 20).map((o) => {
    const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
    return {
      label: String(x.label ?? 'object').slice(0, 60),
      count: Math.max(0, Math.min(999, Math.round(Number(x.count) || 1))),
      holdsWater: pickEnum(x.holds_water, ['yes', 'no', 'unclear'] as const, 'unclear'),
    };
  }) : [];
  return {
    standingWater,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
    kind: standingWater ? pickEnum(r.kind, WATER_KINDS, 'Water-holding containers') : 'No standing water',
    scene: String(r.scene ?? 'other').slice(0, 40),
    objects,
    larvaeVisible: pickEnum(r.larvae_visible, ['yes', 'no', 'unclear'] as const, 'unclear'),
    aedesRisk: pickEnum(r.aedes_risk, ['High', 'Medium', 'Low'] as const, standingWater ? 'Medium' : 'Low'),
    reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 5).map((x) => String(x).slice(0, 140)) : [],
    recommendedAction: String(r.recommended_action ?? '').slice(0, 200),
    summary: String(r.summary ?? '').slice(0, 300),
    imageQuality: pickEnum(r.image_quality, ['good', 'poor'] as const, 'good'),
  };
}
