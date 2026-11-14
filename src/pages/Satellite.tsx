import { useMemo, useState } from 'react';
import { Layers, Radar } from 'lucide-react';
import { useData, useScopedWards } from '@/lib/store';
import { passesUpTo, sumRange } from '@/lib/liveDb';
import reports from '@/data/public-reports.json';
import { addDays, fmtDate } from '@/lib/util';
import { go, href } from '@/lib/router';
import { PageHeader } from '@/components/Layout';
import { Button, Card, Empty, Kpi, Table } from '@/components/ui';
import { WardMap, type Basemap, type MapOverlay, type MapPoint } from '@/components/WardMap';
import { RadarSeason } from '@/components/Charts';

type Layer = 'water' | 'radar' | 'baseline' | 'optical';
const LAYER_LABEL: Record<Layer, string> = { water: 'Water on this pass', radar: 'Radar image', baseline: 'Dry-season water (reference)', optical: 'Sentinel-2 true colour' };

export function Satellite() {
  const { db, a, pub } = useData();
  const wards = useScopedWards();
  const wardSet = useMemo(() => new Set(wards.map((w) => w.ward)), [wards]);
  const history = useMemo(() => (db ? passesUpTo(pub ?? undefined, db.asOf) : []), [db, pub]);
  const [sel, setSel] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ water: true, radar: false, baseline: false, optical: false });
  const [basemap, setBasemap] = useState<Basemap>('streets');
  const pass = history.find((h) => h.pass.id === sel) ?? history[history.length - 1] ?? null;

  const v = useMemo(() => {
    if (!db || !pass) return null;
    const city = pub?.weather?.city;
    const season = history.map((h) => ({ id: h.pass.id, date: h.pass.date, newHa: h.totals.newWaterHa, rain6: Math.round(sumRange(city, 'rain', addDays(h.pass.date, -6), h.pass.date)) }));
    const byWard = new Map<number, number | null>();
    for (const w of db.wards) byWard.set(w.ward, pass.wards[w.ward]?.[1] ?? null);
    const ranked = [...byWard.entries()].filter(([w, x]) => x != null && x > 0 && wardSet.has(w)).sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0)).slice(0, 15);
    const s2 = (pub?.sentinel2 ?? []).filter((s) => s.date <= addDays(pass.pass.date, 10) && s.date >= addDays(pass.pass.date, -20)).sort((x, y) => x.cloud - y.cloud)[0] ?? null;
    const rain6 = sumRange(city, 'rain', addDays(pass.pass.date, -6), pass.pass.date);
    return { season, byWard, ranked, s2, rain6 };
  }, [db, pass, pub, history, wardSet]);

  if (!db || !a) return null;
  const queued = (pub?.passes ?? []).filter((p) => p.date <= db.asOf && !history.some((h) => h.pass.id === p.id)).length;

  if (!pass || !v) {
    return (
      <>
        <PageHeader title="Satellite radar" subtitle="Copernicus Sentinel-1 radar sees water through monsoon cloud, day and night." />
        <Empty>{pub?.status.history === 'loading' ? 'Processing the latest radar pass on Planetary Computer… the first run takes about a minute.' : pub?.errors.history ? `Radar data could not be loaded: ${pub.errors.history}` : 'No radar pass processed for this date yet.'}</Empty>
      </>
    );
  }

  const overlays: MapOverlay[] = [];
  if (layers.optical && v.s2) v.s2.items.forEach((it) => overlays.push({ key: `s2-${it.id}`, url: it.trueColour, opacity: 1, attribution: 'Contains modified Copernicus Sentinel-2 data' }));
  if (layers.radar) overlays.push({ key: `r-${pass.pass.id}`, url: pass.tiles.radar, opacity: 0.85, attribution: 'Contains modified Copernicus Sentinel-1 data' });
  if (layers.baseline && pass.tiles.baselineWater) overlays.push({ key: `b-${pass.pass.id}`, url: pass.tiles.baselineWater, opacity: 0.8 });
  if (layers.water) overlays.push({ key: `w-${pass.pass.id}`, url: pass.tiles.water, opacity: 0.9, attribution: 'Contains modified Copernicus Sentinel-1 data' });

  const spots = pass.spots.filter((s) => wardSet.has(s.ward));
  const points: MapPoint[] = spots.map((s, i) => ({
    id: `sp${i}`, lat: s.lat, lng: s.lng, color: '#F59E0B', radius: Math.min(10, 4 + s.areaHa * 2), square: true,
    label: `Ward ${s.ward}: about ${s.areaHa.toFixed(2)} ha new water in this 250 m cell (${Math.round(s.newFrac * 100)}% of the cell)`, onClick: () => go(href.ward(s.ward)),
  }));
  const after = history.find((h) => h.pass.date >= '2025-09-23' && h.pass.date <= '2025-09-30');
  const pockets = (pub?.landscape?.hotspots?.places ?? []).filter((p) => p.ward != null);

  return (
    <>
      <PageHeader title="Satellite radar"
        subtitle="Copernicus Sentinel-1 radar sees water through monsoon cloud, day and night. Each pass is compared with a dry-season pass from the same orbit, so ponds, the river and smooth roads cancel out and only new water remains." />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Pass shown" value={fmtDate(pass.pass.date, false)} sub={`${pass.pass.platform}, ${pass.pass.state ?? ''} orbit ${pass.pass.orbit ?? ''}`} />
        <Kpi label="New water (city)" value={`${pass.totals.newWaterHa.toFixed(1)} ha`} sub={`across ${pass.totals.wardsMeasured} wards measured`} />
        <Kpi label="Wards flagged" value={pass.flaggedWards.length} tone={pass.flaggedWards.length ? 'warn' : 'good'} sub="≥ 2 ha new water" />
        <Kpi label="Spots located" value={pass.spots.length} sub="250 m cells to inspect" />
        <Kpi label="Rain before pass" value={`${v.rain6.toFixed(0)} mm`} sub="city mean, 6 days" />
        <Kpi label="Passes processed" value={history.length} sub={queued ? `${queued} more queued` : 'since May 2025'} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3" title={<span className="flex items-center gap-2"><Layers size={17} /> Radar map</span>}
          subtitle="Ward colour = new water (ha). Orange squares = 250 m cells where the radar saw new water — send a team to check."
          action={<div className="flex flex-wrap justify-end gap-1">
            {(Object.keys(LAYER_LABEL) as Layer[]).filter((l) => l !== 'optical' || v.s2).map((l) => (
              <button key={l} onClick={() => setLayers((x) => ({ ...x, [l]: !x[l] }))}
                className={`rounded-md border px-2 py-1 text-xs ${layers[l] ? 'border-kmc-600 bg-kmc-600 text-white' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>{LAYER_LABEL[l]}</button>
            ))}
            <button onClick={() => setBasemap(basemap === 'streets' ? 'imagery' : 'streets')} className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">{basemap === 'streets' ? 'Aerial photo base' : 'Street map base'}</button>
          </div>}>
          <WardMap stats={a.stats} wards={wards.length < 20 ? db.wards.filter((w) => wardSet.has(w.ward) || wards.some((x) => x.neighbours.includes(w.ward))) : db.wards} focusWards={[...wardSet]}
            metric="water" noCases basemap={basemap} overlays={overlays} wardOpacity={layers.radar || layers.optical ? 0.15 : 0.45}
            values={{ label: 'New water on this pass (ha)', byWard: v.byWard, breaks: [0.5, 1, 2, 5, 10], fmt: (x) => `${x.toFixed(2)} ha` }}
            points={points} onSelect={(w) => go(href.ward(w))} height={540} />
          <p className="mt-2 text-[11px] text-slate-500">
            Blue = radar backscatter below −16 dB on {fmtDate(pass.pass.date)}{pass.baseline ? `; orange = the same on the dry-season pass of ${fmtDate(pass.baseline.date)}` : ''}.
            {v.s2 && <> Sentinel-2 view: {fmtDate(v.s2.date)}, {v.s2.cloud}% cloud.</>} Radar is strongest on open ground, vacant plots, construction sites and the added areas; it can miss water in narrow lanes between tall buildings, where drones and photos take over.
          </p>
        </Card>
        <div className="space-y-4 xl:col-span-2">
          <Card title="Wards with the most new water" subtitle={`Pass of ${fmtDate(pass.pass.date)}`}>
            {v.ranked.length === 0 ? <Empty>No new water above the noise level on this pass.</Empty> : (
              <Table head={['Ward', 'Borough', 'New water', 'Share', 'Spots']}>
                {v.ranked.map(([w, ha]) => (
                  <tr key={w} className="cursor-pointer hover:bg-slate-50" onClick={() => go(href.ward(w))}>
                    <td className="px-2 py-1.5 font-semibold text-kmc-700">{w}</td>
                    <td className="px-2 py-1.5">{db.wards.find((x) => x.ward === w)?.borough}</td>
                    <td className="px-2 py-1.5 tabular-nums">{(ha ?? 0).toFixed(2)} ha</td>
                    <td className="px-2 py-1.5 tabular-nums">{((pass.wards[w]?.[0] ?? 0) * 100).toFixed(1)}%</td>
                    <td className="px-2 py-1.5 tabular-nums">{pass.spots.filter((s) => s.ward === w).length}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title="Passes" subtitle="Click a bar to view that pass">
            <RadarSeason points={v.season} selected={pass.pass.id} onPick={setSel} height={220} />
            <div className="mt-2 flex flex-wrap gap-1">
              {history.slice(-12).reverse().map((h) => (
                <Button key={h.pass.id} small variant={h.pass.id === pass.pass.id ? 'primary' : 'secondary'} onClick={() => setSel(h.pass.id)}>{fmtDate(h.pass.date, false)}</Button>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {after && (
        <Card className="mt-4" title={<span className="flex items-center gap-2"><Radar size={17} /> Check against a real event: the 22–23 September 2025 cloudburst</span>}
          subtitle="KMC gauges recorded up to 332 mm overnight. What did the radar see on the next pass, and does it match the pockets KMC and the press reported?">
          <CloudburstCheck pass={after} pockets={pockets} />
        </Card>
      )}

      <Card className="mt-4" title="How it works">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
          <li>Every Sentinel-1 pass over Kolkata (about every 6–12 days) is fetched from Microsoft Planetary Computer as soon as it is published.</li>
          <li>For each ward, the share of 10 m pixels darker than −16 dB is measured — open water reflects the radar away from the satellite.</li>
          <li>The same is measured on a dry-season pass (February–April) from the same orbit; the difference is new water.</li>
          <li>Wards with 2 ha or more of new water are split into 250 m cells to locate it, and each cell becomes a water spot with a clear-by date.</li>
          <li>Ward teams confirm or reject each spot; those answers tune the thresholds for Kolkata.</li>
        </ol>
        <p className="mt-2 text-xs text-slate-500">Data: Copernicus Sentinel-1 RTC (ESA, processed by Microsoft Planetary Computer), free and open. Optional upgrade: NASA–ISRO NISAR L-band for water under trees.</p>
      </Card>
    </>
  );
}

function CloudburstCheck({ pass, pockets }: { pass: ReturnType<typeof passesUpTo>[number]; pockets: { name: string; ward: number | null }[] }) {
  const { pub } = useData();
  const flagged = new Set(pass.flaggedWards);
  const wet = new Set(Object.entries(pass.wards).filter(([, v]) => (v?.[1] ?? 0) > 0.5).map(([w]) => Number(w)));
  const hit = pockets.filter((p) => p.ward != null && wet.has(p.ward));
  const g = reports.rainGauges;
  const city = pub?.weather?.city;
  const modelled = (d: string) => { const i = city?.date.indexOf(d) ?? -1; return i >= 0 ? city!.rain[i] ?? 0 : null; };
  const maxB = (d: string) => Math.max(...(pub?.weather?.boroughs ?? []).map((b) => { const i = b.date.indexOf(d); return i >= 0 ? b.rain[i] ?? 0 : 0; }));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="text-sm">
        <p><b>{fmtDate(pass.pass.date)} pass ({pass.pass.platform}):</b> {pass.totals.newWaterHa.toFixed(1)} ha of new water across the city, {pass.flaggedWards.length} wards flagged, {pass.spots.length} spots located.</p>
        <p className="mt-2"><b>{hit.length} of {pockets.length}</b> publicly reported waterlogging pockets lie in wards where the radar measured more than 0.5 ha of new water{hit.length ? ':' : '.'} {hit.slice(0, 12).map((p) => p.name).join(', ')}{hit.length > 12 ? '…' : ''}</p>
        <p className="mt-2 text-xs text-slate-500">Radar passes come every 6–12 days, so water that drained within a day or two is not seen. Agreement with reported pockets is a sanity check, not a measure of accuracy; field confirmation is.</p>
        {flagged.size > 0 && <p className="mt-2 text-xs text-slate-600">Flagged wards: {[...flagged].sort((a, b) => a - b).join(', ')}</p>}
      </div>
      <div>
        <Table head={['KMC gauge', 'Reported', 'Weather model, same day']}>
          {g.readings.map((r) => (
            <tr key={r.station}><td className="px-2 py-1.5">{r.station}</td><td className="px-2 py-1.5 tabular-nums">{r.mm} mm</td><td className="px-2 py-1.5 text-slate-500">—</td></tr>
          ))}
          <tr className="bg-slate-50"><td className="px-2 py-1.5 font-medium">Model city mean / wettest borough</td><td className="px-2 py-1.5" />
            <td className="px-2 py-1.5 tabular-nums">{modelled('2025-09-23')?.toFixed(0) ?? '—'} / {Number.isFinite(maxB('2025-09-23')) ? maxB('2025-09-23').toFixed(0) : '—'} mm</td></tr>
        </Table>
        <p className="mt-1 text-[11px] text-slate-500">Gauge readings as reported by <a className="underline" href={g.url} target="_blank" rel="noreferrer">{g.publisher}</a>. Weather models smooth out cloudbursts, which is why KMC's own 39+ rain gauges should feed the system in production.</p>
      </div>
    </div>
  );
}
