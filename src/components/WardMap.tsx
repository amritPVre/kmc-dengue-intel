import { useEffect, useMemo, useRef } from 'react';
import { CircleMarker, GeoJSON, MapContainer, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L, { type LatLngBoundsExpression, type PathOptions } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import geo from '@/data/wards.geo.json';
import type { Ward, WardStats } from '@/lib/types';
import { RISK_COLOR } from './ui';

export type MapMetric = 'risk' | 'water' | 'cases' | 'bi' | 'forecast';
export const METRIC_LABEL: Record<MapMetric, string> = {
  risk: 'Risk score (next 2–4 weeks)',
  water: 'Standing water (weighted spots per km²)',
  cases: 'Cases per 10,000 (last 2 weeks)',
  bi: 'Breteau Index (last 2 weeks)',
  forecast: 'Forecast cases (next 4 weeks)',
};

const SEQ = ['#FFF4CC', '#FBD38D', '#F6995C', '#DD5B3A', '#A3243A'];
const BREAKS: Record<Exclude<MapMetric, 'risk'>, number[]> = {
  water: [0.01, 0.5, 1, 2, 4],
  cases: [0.01, 0.5, 1.5, 3, 6],
  bi: [0.01, 5, 10, 20, 35],
  forecast: [0.5, 2, 5, 10, 20],
};
export function metricValue(s: WardStats, m: MapMetric): number | null {
  if (m === 'risk') return s.risk.score;
  if (m === 'cases') return (s.last2w / Math.max(s.population, 1)) * 1e4;
  if (m === 'bi') return s.bi;
  if (m === 'water') return s.water.index;
  return s.risk.forecast.reduce((a, f) => a + f.mean, 0);
}
export function metricColor(s: WardStats | undefined, m: MapMetric): string {
  if (!s) return '#E5E7EB';
  if (m === 'risk') return RISK_COLOR[s.risk.level];
  const v = metricValue(s, m);
  if (v == null) return '#E5E7EB';
  const br = BREAKS[m];
  let i = -1;
  for (let k = 0; k < br.length; k++) if (v >= br[k]) i = k;
  return i < 0 ? '#F8FAFC' : SEQ[i];
}
export function legendFor(m: MapMetric): { color: string; label: string }[] {
  if (m === 'risk') return (['Low', 'Moderate', 'High', 'Very high'] as const).map((l) => ({ color: RISK_COLOR[l], label: l }));
  const br = BREAKS[m];
  const fmt = (x: number) => (x < 1 && x > 0 ? x.toFixed(1) : String(x));
  return [{ color: '#F8FAFC', label: '0' }, ...br.map((b, i) => ({ color: SEQ[i], label: i < br.length - 1 ? `${fmt(b)}–${fmt(br[i + 1])}` : `${fmt(b)}+` }))];
}

function Fit({ bounds }: { bounds: LatLngBoundsExpression }) {
  const map = useMap();
  const key = JSON.stringify(bounds);
  useEffect(() => { map.fitBounds(bounds, { padding: [12, 12], animate: false }); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export interface MapPoint { id: string; lat: number; lng: number; color: string; radius?: number; label: string; ring?: boolean; onClick?: () => void }

export function WardMap({
  stats, wards, metric, onSelect, highlight, points = [], circles = [], height = 460, focusWards,
}: {
  stats: Map<number, WardStats>;
  wards: Ward[];
  metric: MapMetric;
  onSelect?: (ward: number) => void;
  highlight?: number;
  points?: MapPoint[];
  circles?: { lat: number; lng: number; label: string }[];
  height?: number;
  focusWards?: number[];
}) {
  const visible = useMemo(() => new Set(wards.map((w) => w.ward)), [wards]);
  const focus = focusWards ? new Set(focusWards) : visible;
  const fc = useMemo(() => {
    const g = geo as unknown as GeoJSON.FeatureCollection<GeoJSON.Geometry, { ward: number; borough: string }>;
    return { ...g, features: g.features.filter((f) => visible.has(f.properties.ward)) };
  }, [visible]);
  const bounds = useMemo<LatLngBoundsExpression>(() => {
    const ws = wards.filter((w) => focus.has(w.ward));
    const list = ws.length ? ws : wards;
    const lats = list.flatMap((w) => [w.bbox[1], w.bbox[3]]);
    const lngs = list.flatMap((w) => [w.bbox[0], w.bbox[2]]);
    return [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]];
  }, [wards, focusWards]); // eslint-disable-line react-hooks/exhaustive-deps
  const geoKey = `${metric}-${highlight}-${[...visible].join(',')}-${[...stats.values()].reduce((a, s) => a + s.risk.score + s.last2w, 0)}`;
  const pending = wards.filter((w) => w.boundary === 'pending');
  const tileUrl = import.meta.env.VITE_TILE_URL as string | undefined;
  const ref = useRef<L.Map | null>(null);

  const style = (f?: GeoJSON.Feature): PathOptions => {
    const ward = (f?.properties as { ward: number } | undefined)?.ward ?? 0;
    const hi = ward === highlight;
    return {
      fillColor: metricColor(stats.get(ward), metric),
      fillOpacity: focus.has(ward) ? 0.9 : 0.35,
      color: hi ? '#0F1B2D' : '#FFFFFF',
      weight: hi ? 3 : 0.8,
    };
  };

  return (
    <div className="relative overflow-hidden rounded-lg border border-slate-200" style={{ height }}>
      <MapContainer ref={ref} bounds={bounds} zoomSnap={0.25} scrollWheelZoom={false} fadeAnimation={false} markerZoomAnimation={false} style={{ height: '100%', width: '100%', background: '#EEF2F1' }} attributionControl={false}>
        {tileUrl && <TileLayer url={tileUrl} opacity={0.5} />}
        <Fit bounds={bounds} />
        <GeoJSON
          key={geoKey}
          data={fc}
          style={style}
          onEachFeature={(f, layer) => {
            const ward = (f.properties as { ward: number }).ward;
            const s = stats.get(ward);
            const v = s ? metricValue(s, metric) : null;
            const vtxt = v == null ? 'no data' : metric === 'risk' ? `${s!.risk.level} (${v}/100)` : v.toFixed(1);
            layer.bindTooltip(`<b>Ward ${ward}</b> · Borough ${s?.borough ?? ''}<br/>${METRIC_LABEL[metric]}: ${vtxt}<br/>Cases last 2 wks: ${s?.last2w ?? 0}`, { sticky: true });
            if (onSelect) layer.on('click', () => onSelect(ward));
          }}
        />
        {pending.map((w) => {
          const s = stats.get(w.ward);
          return (
            <CircleMarker key={`p${w.ward}`} center={[w.centroid[1], w.centroid[0]]} radius={11}
              pathOptions={{ color: '#475569', weight: 1.5, dashArray: '3 3', fillColor: metricColor(s, metric), fillOpacity: 0.9 }}
              eventHandlers={onSelect ? { click: () => onSelect(w.ward) } : undefined}>
              <Tooltip>Ward {w.ward} (boundary pending — approximate location)</Tooltip>
            </CircleMarker>
          );
        })}
        {circles.map((c, i) => (
          <CircleMarker key={`c${i}`} center={[c.lat, c.lng]} radius={16} pathOptions={{ color: '#0F1B2D', weight: 2.5, fillOpacity: 0, dashArray: '5 4' }}>
            <Tooltip>{c.label}</Tooltip>
          </CircleMarker>
        ))}
        {points.map((p) => (
          <CircleMarker key={p.id} center={[p.lat, p.lng]} radius={p.radius ?? 4}
            pathOptions={p.ring ? { color: p.color, weight: 2.5, fillColor: '#FFFFFF', fillOpacity: 0.9 } : { color: '#FFFFFF', weight: 1, fillColor: p.color, fillOpacity: 0.95 }}
            eventHandlers={p.onClick ? { click: p.onClick } : undefined}>
            <Tooltip>{p.label}</Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
      <div className="pointer-events-none absolute bottom-2 left-2 z-[500] rounded-md bg-white/95 px-2 py-1.5 text-[11px] shadow">
        <div className="mb-1 font-medium text-slate-700">{METRIC_LABEL[metric]}</div>
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          {legendFor(metric).map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm border border-slate-300" style={{ background: l.color }} />{l.label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MetricToggle({ value, onChange }: { value: MapMetric; onChange: (m: MapMetric) => void }) {
  const opts: [MapMetric, string][] = [['risk', 'Risk'], ['water', 'Water'], ['cases', 'Cases'], ['bi', 'Breteau'], ['forecast', 'Forecast']];
  return (
    <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs" role="tablist" aria-label="Map layer">
      {opts.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)}
          className={`rounded-md px-2.5 py-1 font-medium ${value === k ? 'bg-kmc-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{l}</button>
      ))}
    </div>
  );
}
