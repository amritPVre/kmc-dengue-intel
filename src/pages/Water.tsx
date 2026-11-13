import { useEffect, useMemo, useState } from 'react';
import { CloudRain, Droplets, ImageUp, Radar, Satellite, ScanSearch } from 'lucide-react';
import type { ImageSource } from '@shared/vision';
import { canEdit, useData, useScopedWards } from '@/lib/store';
import { daysLeft, isActiveWater } from '@/lib/analytics';
import { analyzeImage, visionChannel, visionError, type VisionChannel, type VisionOutcome } from '@/lib/ai';
import { DETECTION_SOURCES, type DetectionSource, type WaterDetection } from '@/lib/types';
import { addDays, fmtDate, fmtDateTime, todayIso } from '@/lib/util';
import { go, href } from '@/lib/router';
import { PageHeader } from '@/components/Layout';
import { Button, Card, Empty, Field, Kpi, Pill, Table, inputCls } from '@/components/ui';
import { MetricToggle, WardMap, type MapMetric, type MapPoint } from '@/components/WardMap';
import { WardSelect, wardAt } from './forms';

export const urgencyColor = (left: number) => (left < 0 ? '#7F1D1D' : left <= 2 ? '#DC2626' : left <= 5 ? '#D97706' : '#0F766E');
export function ClearBy({ left }: { left: number }) {
  const tone = left < 0 ? 'red' : left <= 2 ? 'red' : left <= 5 ? 'amber' : 'green';
  const label = left < 0 ? `${-left} day${left === -1 ? '' : 's'} past window` : left === 0 ? 'Clear today' : `${left} day${left === 1 ? '' : 's'} left`;
  return <Pill tone={tone}>{label}</Pill>;
}

const SOURCE_ICON: Record<DetectionSource, JSX.Element> = {
  'Satellite radar': <Radar size={14} />, 'Satellite optical': <Satellite size={14} />, 'Drone AI': <ScanSearch size={14} />,
  'Field photo AI': <ImageUp size={14} />, 'Citizen photo AI': <ImageUp size={14} />, 'Rain + terrain model': <CloudRain size={14} />, 'Flood sensor': <Droplets size={14} />,
};

/** Actions on one water spot: verify, dispatch a clearance task, mark cleared. */
export function SpotActions({ d, compact }: { d: WaterDetection; compact?: boolean }) {
  const { scope, setDetectionStatus, dispatchDetection, notify } = useData();
  if (!canEdit(scope.role) || scope.role === 'lab') return null;
  if (d.status === 'Cleared' || d.status === 'False alarm') return <span className="text-xs text-slate-500">{d.status}{d.clearedOn ? ` ${fmtDate(d.clearedOn, false)}` : ''}</span>;
  return (
    <div className={`flex flex-wrap gap-1 ${compact ? '' : 'min-w-[220px]'}`}>
      {!d.taskId && scope.role !== 'field' && <Button small onClick={async () => { await dispatchDetection(d); notify(`Clearance task sent to ward ${d.ward} team`); }}>Dispatch</Button>}
      {d.status === 'New' && <Button small variant="secondary" onClick={() => setDetectionStatus(d.id, 'Confirmed')}>Confirm</Button>}
      <Button small variant="secondary" onClick={async () => { await setDetectionStatus(d.id, 'Cleared'); notify('Marked cleared'); }}>Cleared</Button>
      {d.status === 'New' && <Button small variant="ghost" onClick={() => setDetectionStatus(d.id, 'False alarm')}>False alarm</Button>}
    </div>
  );
}

function PhotoAnalyzer({ defaultWard }: { defaultWard: number }) {
  const { db, a, scope, addDetection, notify } = useData();
  const [ch, setCh] = useState<{ channel: VisionChannel; accept: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [source, setSource] = useState<ImageSource>(scope.role === 'field' ? 'Field photo' : 'Drone image');
  const [ward, setWard] = useState(defaultWard);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<VisionOutcome | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { let on = true; visionChannel().then((c) => { if (on) setCh(c); }); return () => { on = false; }; }, []);
  useEffect(() => setWard(defaultWard), [defaultWard]);
  const latN = parseFloat(lat), lngN = parseFloat(lng);
  const hasPt = Number.isFinite(latN) && Number.isFinite(lngN);

  const run = async () => {
    if (!file) return;
    setBusy(true); setErr(''); setOut(null);
    try {
      setOut(await analyzeImage(file, source, { ward, capturedOn: todayIso(), note: note || undefined }));
    } catch (e) {
      setErr(visionError(e));
    } finally { setBusy(false); }
  };
  const save = async () => {
    if (!out || !db || !a) return;
    const w = db.wards.find((x) => x.ward === (hasPt ? wardAt(lngN, latN) ?? ward : ward))!;
    const srcMap: Record<ImageSource, DetectionSource> = { 'Field photo': 'Field photo AI', 'Citizen photo': 'Citizen photo AI', 'Drone image': 'Drone AI', 'CCTV frame': 'Field photo AI' };
    await addDetection({
      ward: w.ward, lat: hasPt ? latN : w.centroid[1], lng: hasPt ? lngN : w.centroid[0], source: srcMap[source], kind: out.result.kind,
      detectedAt: new Date().toISOString(), waterSince: todayIso(), confidence: out.result.confidence,
      status: scope.role === 'field' ? 'Confirmed' : 'New', aedesRisk: out.result.aedesRisk, photo: out.photoPath ?? preview,
      ai: { model: out.model, summary: out.result.summary, objects: out.result.objects, larvaeVisible: out.result.larvaeVisible, recommendedAction: out.result.recommendedAction, reasons: out.result.reasons },
    });
    notify(`Water spot added to ward ${w.ward}`);
    setOut(null); setFile(null); setPreview(''); setNote('');
  };

  return (
    <Card title={<span className="flex items-center gap-2"><ScanSearch size={17} /> Analyse a photo with AI</span>}
      subtitle="Drone frame, field-team photo, citizen complaint or CCTV still. The AI finds standing water and the containers holding it.">
      {ch === null ? <p className="text-sm text-slate-500">Checking AI availability…</p> : ch.channel === 'none' ? (
        <Empty>AI photo analysis runs on the KMC server deployment (or inside Claude). It is not available in this view.</Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-3">
            <input type="file" accept={ch.accept || 'image/*'} className="block w-full text-xs" aria-label="Photo"
              onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setOut(null); setErr(''); setPreview(f ? URL.createObjectURL(f) : ''); }} />
            {preview && <img src={preview} alt="Selected photo" className="max-h-56 w-full rounded-lg bg-slate-100 object-contain" />}
            <div className="grid grid-cols-2 gap-2">
              <Field label="Image type">
                <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value as ImageSource)}>
                  {(['Drone image', 'Field photo', 'Citizen photo', 'CCTV frame'] as ImageSource[]).map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Ward"><WardSelect value={ward} onChange={setWard} /></Field>
              <Field label="Latitude (optional)"><input className={inputCls} inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="from photo GPS" /></Field>
              <Field label="Longitude (optional)"><input className={inputCls} inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} /></Field>
            </div>
            <Field label="Note (optional)"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. roof of abandoned building, Topsia Road" /></Field>
            <Button onClick={run} disabled={!file || busy}>{busy ? 'Analysing…' : 'Analyse photo'}</Button>
            {busy && <p className="text-xs text-slate-500">The AI is looking at the image. This usually takes 10–40 seconds.</p>}
            {err && <p className="text-sm text-red-700">{err}</p>}
          </div>
          <div>
            {out ? (
              <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={out.result.standingWater ? 'red' : 'green'}>{out.result.standingWater ? 'Standing water found' : 'No standing water'}</Pill>
                  {out.result.standingWater && <Pill tone={out.result.aedesRisk === 'High' ? 'red' : out.result.aedesRisk === 'Medium' ? 'amber' : 'slate'}>Aedes risk: {out.result.aedesRisk}</Pill>}
                  <Pill>Confidence {Math.round(out.result.confidence * 100)}%</Pill>
                </div>
                <p className="font-medium">{out.result.summary}</p>
                {out.result.standingWater && <p className="text-slate-600">Type: {out.result.kind} · Scene: {out.result.scene} · Larvae visible: {out.result.larvaeVisible}</p>}
                {out.result.objects.length > 0 && (
                  <ul className="list-disc pl-5 text-slate-700">{out.result.objects.map((o, i) => <li key={i}>{o.count} × {o.label} — holds water: {o.holdsWater}</li>)}</ul>
                )}
                {out.result.reasons.length > 0 && <p className="text-xs text-slate-500">Why: {out.result.reasons.join('; ')}</p>}
                {out.result.recommendedAction && <p className="rounded bg-kmc-50 px-2 py-1 text-kmc-700">Action: {out.result.recommendedAction}</p>}
                {out.result.imageQuality === 'poor' && <p className="text-xs text-amber-700">Image quality is poor; take a clearer photo if possible.</p>}
                <p className="text-[11px] text-slate-400">Analysed by {out.model}. AI findings are candidates until a ward team confirms them.</p>
                {out.result.standingWater && <Button small onClick={save}>Add to water spots</Button>}
              </div>
            ) : <Empty>Results appear here: water found or not, containers and counts, Aedes risk, and what the field team should do.</Empty>}
          </div>
        </div>
      )}
    </Card>
  );
}

type SourceStatus = 'Built in MVP' | 'Pipeline written' | 'Needs KMC feed' | 'Phase 2';
const SOURCE_INFO: { source: string; sees: string; detail: string; status: SourceStatus }[] = [
  { source: 'KMC drones', sees: 'Rooftop water, uncovered tanks, tyres, construction sites', detail: 'Centimetre imagery; AI scans every frame instead of manual review', status: 'Built in MVP' },
  { source: 'Field and citizen photos', sees: 'Containers, drains, premises the sky cannot see', detail: 'Phone photo → AI check in seconds → spot with GPS', status: 'Built in MVP' },
  { source: 'Rain + terrain model', sees: 'Pockets that usually pool after heavy rain', detail: 'Historical satellite water frequency + elevation; flags spots the day it rains', status: 'Built in MVP' },
  { source: 'Sentinel-1C/1D radar', sees: 'Open waterlogging, flooded vacant plots, overflowing ponds', detail: '10 m pixels, every 6 days, sees through monsoon cloud; free (Copernicus)', status: 'Pipeline written' },
  { source: 'Sentinel-2 optical', sees: 'Pools, ponds, waterlogged land on clear days', detail: '10 m, every 5 days, blocked by cloud', status: 'Pipeline written' },
  { source: 'NISAR L-band radar', sees: 'Water under vegetation and in mixed urban land', detail: 'NASA-ISRO, 12-day repeat, free; products within about 72 h', status: 'Phase 2' },
  { source: 'KMC rain gauges and flood sensors (FFEWS)', sees: 'Where and how much it rained; streets under water', detail: 'Real-time feed from the KMC control room', status: 'Needs KMC feed' },
  { source: 'Kolkata Police / KMC CCTV', sees: 'Street waterlogging at junctions', detail: 'AI on still frames from the integrated control room', status: 'Phase 2' },
];

export function Water() {
  const { db, a, scope } = useData();
  const wards = useScopedWards();
  const [metric, setMetric] = useState<MapMetric>('water');
  const [status, setStatus] = useState<'active' | 'all' | WaterDetection['status']>('active');
  const [source, setSource] = useState<'all' | DetectionSource>('all');
  const wardSet = useMemo(() => new Set(wards.map((w) => w.ward)), [wards]);

  const v = useMemo(() => {
    if (!db || !a) return null;
    const mine = db.detections.filter((d) => wardSet.has(d.ward));
    const active = mine.filter(isActiveWater).filter((d) => d.waterSince >= addDays(db.asOf, -30));
    const left = (d: WaterDetection) => daysLeft(d, db.asOf, a.meanTempC);
    const since30 = addDays(db.asOf, -30);
    const cleared = mine.filter((d) => d.status === 'Cleared' && (d.clearedOn ?? '') >= since30);
    const clearedInTime = cleared.filter((d) => d.clearedOn! <= addDays(d.waterSince, a.devDays - 1)).length;
    const verified = mine.filter((d) => d.status !== 'New' && d.source !== 'Flood sensor');
    const truePos = verified.filter((d) => d.status !== 'False alarm').length;
    const heavy = [...db.rainDaily].reverse().find((r) => r.mm >= 40);
    const lastS1 = db.passes.find((p) => p.sensor === 'Sentinel-1' && p.status === 'Processed');
    const lastS2 = db.passes.find((p) => p.sensor === 'Sentinel-2' && p.status === 'Processed');
    const lastNisar = db.passes.find((p) => p.sensor === 'NISAR');
    const bySource = DETECTION_SOURCES.map((s) => ({ s, n: active.filter((d) => d.source === s).length })).filter((x) => x.n > 0);
    const precisionBySource = DETECTION_SOURCES.map((s) => {
      const vs = verified.filter((d) => d.source === s);
      return { s, n: vs.length, p: vs.length ? vs.filter((d) => d.status !== 'False alarm').length / vs.length : null };
    }).filter((x) => x.n > 0);
    const list = mine
      .filter((d) => (status === 'active' ? active.includes(d) : status === 'all' ? true : d.status === status))
      .filter((d) => source === 'all' || d.source === source)
      .sort((x, y) => left(x) - left(y) || y.confidence - x.confidence);
    return {
      active, left, cleared: cleared.length, clearedInTime, precision: verified.length ? truePos / verified.length : null, verified: verified.length,
      urgent: active.filter((d) => left(d) >= 0 && left(d) <= 2).length, past: active.filter((d) => left(d) < 0).length,
      unverified: active.filter((d) => d.status === 'New').length, heavy, lastS1, lastS2, lastNisar, bySource, precisionBySource, list,
    };
  }, [db, a, wardSet, status, source]);
  if (!db || !a || !v) return null;

  const points: MapPoint[] = v.active.map((d) => {
    const l = v.left(d);
    return {
      id: d.id, lat: d.lat, lng: d.lng, color: urgencyColor(l), radius: d.areaM2 && d.areaM2 > 1500 ? 7 : 5, ring: d.status === 'New',
      label: `${d.kind} · ${d.source}${d.sensor ? ` (${d.sensor})` : ''} · ${l < 0 ? 'past window' : `${l} days left`} · ${d.status}`,
      onClick: () => go(href.ward(d.ward)),
    };
  });
  const homeWard = scope.role === 'hq' || scope.role === 'borough' ? (wards[0]?.ward ?? 1) : scope.ward;

  return (
    <>
      <PageHeader title="Standing water"
        subtitle={`Find it and clear it before mosquitoes emerge. At this week's ${a.meanTempC.toFixed(1)} °C, Aedes take about ${a.devDays} days to go from egg to adult.`} />

      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        <div className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm">
          <CloudRain className="mt-0.5 shrink-0 text-sky-700" size={20} />
          <div>{v.heavy ? <>
            <b>{v.heavy.mm} mm rain on {fmtDate(v.heavy.date, false)}.</b> Water left by it can produce adult mosquitoes from <b>{fmtDate(addDays(v.heavy.date, a.devDays), false)}</b>; clear flagged pockets by {fmtDate(addDays(v.heavy.date, a.devDays - 1), false)}.
          </> : <>No day with 40 mm or more of rain in the last 120 days.</>}</div>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <Radar className="mt-0.5 shrink-0 text-kmc-600" size={20} />
          <div>
            <b>Radar:</b> {v.lastS1 ? <>{v.lastS1.platform} pass {fmtDate(v.lastS1.date, false)} found {v.lastS1.detections} water patches; next pass about {fmtDate(addDays(v.lastS1.date, 6), false)}.</> : 'no pass yet.'}
            {v.lastNisar && <> NISAR {fmtDate(v.lastNisar.date, false)}: {v.lastNisar.status === 'Awaiting data' ? 'awaiting data' : `${v.lastNisar.detections} patches`}.</>}
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <Satellite className="mt-0.5 shrink-0 text-kmc-600" size={20} />
          <div><b>Optical:</b> {v.lastS2 ? <>last clear Sentinel-2 view {fmtDate(v.lastS2.date, false)} ({v.lastS2.cloudPct}% cloud), {v.lastS2.detections} patches.</> : 'no clear view in the last 6 weeks.'} Drones and photos cover rooftops and containers satellites cannot see.</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Active water spots" value={v.active.length} sub={`${v.unverified} not yet checked`} />
        <Kpi label="Clear within 2 days" value={v.urgent} tone={v.urgent ? 'bad' : 'good'} sub="before adults can emerge" />
        <Kpi label="Past breeding window" value={v.past} tone={v.past ? 'bad' : 'good'} sub="add adult-mosquito control" />
        <Kpi label="Cleared in time" value={v.cleared ? `${Math.round((v.clearedInTime / v.cleared) * 100)}%` : '—'} sub={`${v.cleared} cleared in 30 days`} />
        <Kpi label="AI detections confirmed" value={v.precision == null ? '—' : `${Math.round(v.precision * 100)}%`} sub={`of ${v.verified} checked by teams`} />
        <Kpi label="Sources reporting" value={v.bySource.length} sub={v.bySource.slice(0, 3).map((x) => `${x.s} ${x.n}`).join(' · ')} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3" title="Where the water is" subtitle="Dots: active spots (dark red past window, red ≤ 2 days, amber ≤ 5, green later; ringed = not yet checked). Click a dot for its ward."
          action={<MetricToggle value={metric} onChange={setMetric} />}>
          <WardMap stats={a.stats} wards={wards.length < 20 ? db.wards.filter((w) => wardSet.has(w.ward) || wards.some((x) => x.neighbours.includes(w.ward))) : db.wards} focusWards={[...wardSet]}
            metric={metric} points={points} onSelect={(w) => go(href.ward(w))} height={480} />
        </Card>
        <div className="space-y-4 xl:col-span-2">
          <Card title="How well each source works" subtitle="Share of checked detections that were real water">
            {v.precisionBySource.length === 0 ? <Empty>No verified detections yet.</Empty> : (
              <ul className="space-y-2 text-sm">
                {v.precisionBySource.map((x) => (
                  <li key={x.s} className="flex items-center gap-2">
                    <span className="flex w-44 items-center gap-1.5 text-slate-700">{SOURCE_ICON[x.s]}{x.s}</span>
                    <span className="h-2.5 flex-1 overflow-hidden rounded bg-slate-100"><span className="block h-full bg-kmc-600" style={{ width: `${Math.round((x.p ?? 0) * 100)}%` }} /></span>
                    <span className="w-24 text-right text-xs tabular-nums text-slate-600">{Math.round((x.p ?? 0) * 100)}% of {x.n}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[11px] text-slate-500">Every confirm or false-alarm click becomes a labelled example for retraining the detectors on Kolkata's own rooftops, lanes and plots.</p>
          </Card>
          <Card title="Wards with the most water" subtitle="Weighted spots per km²">
            <ul className="divide-y divide-slate-100 text-sm">
              {[...a.stats.values()].filter((s) => wardSet.has(s.ward) && s.water.active > 0).sort((x, y) => y.water.index - x.water.index).slice(0, 6).map((s) => (
                <li key={s.ward} className="flex cursor-pointer items-center gap-2 py-1.5 hover:bg-slate-50" onClick={() => go(href.ward(s.ward))}>
                  <b className="w-20 text-kmc-700">Ward {s.ward}</b>
                  <span className="flex-1 text-xs text-slate-600">{s.water.active} active · {s.water.urgent} due in 2 days{s.water.pastWindow ? ` · ${s.water.pastWindow} past window` : ''}</span>
                  <span className="tabular-nums text-xs">{s.water.index.toFixed(1)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <div className="mt-4"><PhotoAnalyzer defaultWard={homeWard} /></div>

      <Card className="mt-4" title="Water spots to clear" subtitle="Sorted by days left before the breeding window closes"
        action={<div className="flex flex-wrap gap-2">
          <select className={`${inputCls} w-auto py-1 text-xs`} value={status} onChange={(e) => setStatus(e.target.value as never)} aria-label="Status">
            <option value="active">Active (new + confirmed)</option><option value="New">Not yet checked</option><option value="Confirmed">Confirmed</option><option value="Cleared">Cleared</option><option value="False alarm">False alarm</option><option value="all">All</option>
          </select>
          <select className={`${inputCls} w-auto py-1 text-xs`} value={source} onChange={(e) => setSource(e.target.value as never)} aria-label="Source">
            <option value="all">All sources</option>{DETECTION_SOURCES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>}>
        {v.list.length === 0 ? <Empty>No water spots match these filters.</Empty> : (
          <Table head={['Clear by', 'Ward', 'What', 'Found by', 'Confidence', 'Water since', 'Status', '']}>
            {v.list.slice(0, 150).map((d) => {
              const l = v.left(d);
              return (
                <tr key={d.id} className="align-top">
                  <td className="px-2 py-2">{isActiveWater(d) ? <ClearBy left={l} /> : <span className="text-xs text-slate-400">—</span>}</td>
                  <td className="px-2 py-2"><a className="font-semibold text-kmc-700" href={href.ward(d.ward)}>{d.ward}</a></td>
                  <td className="px-2 py-2">
                    <div className="font-medium">{d.kind}</div>
                    {d.ai?.summary && <div className="text-xs text-slate-500">{d.ai.summary}</div>}
                    {d.areaM2 && <div className="text-xs text-slate-500">about {d.areaM2.toLocaleString('en-IN')} m²</div>}
                  </td>
                  <td className="px-2 py-2"><span className="flex items-center gap-1 whitespace-nowrap">{SOURCE_ICON[d.source]}{d.source}</span>{d.sensor && <span className="block text-xs text-slate-500">{d.sensor}</span>}</td>
                  <td className="px-2 py-2 tabular-nums">{Math.round(d.confidence * 100)}%</td>
                  <td className="whitespace-nowrap px-2 py-2">{fmtDate(d.waterSince, false)}<span className="block text-xs text-slate-500">seen {fmtDateTime(d.detectedAt).split(',')[0]}</span></td>
                  <td className="px-2 py-2"><Pill tone={d.status === 'New' ? 'slate' : d.status === 'Confirmed' ? 'amber' : d.status === 'Cleared' ? 'green' : 'blue'}>{d.status === 'New' ? 'Not checked' : d.status}</Pill>{d.taskId && <span className="block text-xs text-slate-500">task assigned</span>}</td>
                  <td className="px-2 py-2"><SpotActions d={d} /></td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card className="mt-4" title="Where the detections come from" subtitle="Each source sees a different part of the problem; together they cover open ground, rooftops and containers">
        <Table head={['Source', 'What it finds', 'How', 'Status']}>
          {SOURCE_INFO.map((s) => (
            <tr key={s.source}>
              <td className="px-2 py-2 font-medium">{s.source}</td><td className="px-2 py-2">{s.sees}</td><td className="px-2 py-2 text-slate-600">{s.detail}</td>
              <td className="px-2 py-2"><Pill tone={s.status === 'Built in MVP' ? 'green' : s.status === 'Pipeline written' ? 'blue' : s.status === 'Needs KMC feed' ? 'amber' : 'slate'}>{s.status}</Pill></td>
            </tr>
          ))}
        </Table>
        {db.mode === 'demo' && <p className="mt-2 text-xs text-amber-700">Demo: detections shown are synthetic. Photo analysis above is live.</p>}
      </Card>
    </>
  );
}
