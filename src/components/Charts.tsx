import {
  Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, BarChart, Cell, ReferenceLine,
} from 'recharts';
import type { Driver, ForecastPoint } from '@shared/risk-engine';
import { addDays, fmtDate } from '@/lib/util';

const AXIS = { fontSize: 11, fill: '#475569' };

/** Weekly cases this season vs the same weeks a year earlier, with rainfall bars. */
export function EpiCurve({ weeks, cases, rain, height = 260, title }: { weeks: string[]; cases: number[]; rain?: number[]; height?: number; title?: string }) {
  const n = weeks.length;
  const show = Math.min(52, n);
  const data = weeks.slice(n - show).map((w, i) => {
    const idx = n - show + i;
    return {
      week: fmtDate(w, false),
      cases: cases[idx],
      lastYear: idx - 52 >= 0 ? cases[idx - 52] : null,
      rain: rain ? Math.round(rain[idx]) : undefined,
    };
  });
  return (
    <div aria-label={title ?? 'Weekly cases chart'} role="img">
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid stroke="#E2E8F0" vertical={false} />
          <XAxis dataKey="week" tick={AXIS} interval={Math.ceil(show / 8)} />
          <YAxis yAxisId="c" tick={AXIS} allowDecimals={false} />
          {rain && <YAxis yAxisId="r" orientation="right" tick={AXIS} />}
          <Tooltip contentStyle={{ fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {rain && <Bar isAnimationActive={false} yAxisId="r" dataKey="rain" name="Rainfall (mm/week)" fill="#BFDBFE" />}
          <Line isAnimationActive={false} yAxisId="c" dataKey="lastYear" name="Same week last year" stroke="#94A3B8" strokeDasharray="4 3" dot={false} strokeWidth={1.5} />
          <Line isAnimationActive={false} yAxisId="c" dataKey="cases" name="Confirmed cases" stroke="#0B5F59" dot={false} strokeWidth={2.5} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Last 12 weeks of actual cases plus the 4-week forecast with its 90% band. */
export function ForecastChart({ weeks, cases, forecast, height = 240 }: { weeks: string[]; cases: number[]; forecast: ForecastPoint[]; height?: number }) {
  const n = weeks.length;
  const hist = weeks.slice(-12).map((w, i) => ({ week: fmtDate(w, false), actual: cases[n - 12 + i], mean: null as number | null, band: null as [number, number] | null }));
  const lastWeek = weeks[n - 1];
  const fut = forecast.map((f) => ({ week: fmtDate(addDays(lastWeek, 7 * f.step), false), actual: null as number | null, mean: f.mean, band: [f.lo, f.hi] as [number, number] }));
  if (hist.length) { hist[hist.length - 1].mean = hist[hist.length - 1].actual; hist[hist.length - 1].band = [hist[hist.length - 1].actual ?? 0, hist[hist.length - 1].actual ?? 0]; }
  const data = [...hist, ...fut];
  return (
    <div role="img" aria-label="Actual cases and 4-week forecast">
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="#E2E8F0" vertical={false} />
          <XAxis dataKey="week" tick={AXIS} interval={1} />
          <YAxis tick={AXIS} allowDecimals={false} />
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v: unknown) => (Array.isArray(v) ? `${(+v[0]).toFixed(1)}–${(+v[1]).toFixed(1)}` : typeof v === 'number' ? v.toFixed(1) : String(v))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar isAnimationActive={false} dataKey="actual" name="Actual cases" fill="#0B5F59" barSize={14} />
          <Area isAnimationActive={false} dataKey="band" name="Forecast 90% range" fill="#F7AE57" fillOpacity={0.3} stroke="none" />
          <Line isAnimationActive={false} dataKey="mean" name="Forecast (expected)" stroke="#C2410C" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3 }} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Contribution of each factor to the ward's risk score. */
export function DriverBars({ drivers, height = 300 }: { drivers: Driver[]; height?: number }) {
  const data = drivers.map((d) => ({ label: d.label, value: +d.contribution.toFixed(2) }));
  const max = Math.max(...data.map((d) => d.value), 0.1);
  return (
    <div role="img" aria-label="What drives this ward's risk">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#E2E8F0" horizontal={false} />
          <XAxis type="number" tick={AXIS} domain={[0, Math.ceil(max * 10) / 10]} />
          <YAxis type="category" dataKey="label" width={210} tick={{ fontSize: 11, fill: '#334155' }} />
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v: unknown) => [`${v}`, 'Contribution to risk (log-odds)']} />
          <Bar isAnimationActive={false} dataKey="value" barSize={14}>
            {data.map((_, i) => <Cell key={i} fill={i < 3 ? '#C2410C' : '#94A3B8'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** House and Breteau index trend for a ward, with the alert thresholds. */
export function IndicesChart({ data, biHigh, hiHigh, height = 220 }: { data: { week: string; HI: number | null; BI: number | null }[]; biHigh: number; hiHigh: number; height?: number }) {
  return (
    <div role="img" aria-label="Larval indices over time">
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="#E2E8F0" vertical={false} />
          <XAxis dataKey="week" tick={AXIS} interval={1} />
          <YAxis tick={AXIS} />
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v: unknown) => (typeof v === 'number' ? v.toFixed(1) : String(v))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine y={biHigh} stroke="#9E1B32" strokeDasharray="4 3" label={{ value: `BI ${biHigh}`, fontSize: 10, fill: '#9E1B32', position: 'right' }} />
          <ReferenceLine y={hiHigh} stroke="#B45309" strokeDasharray="2 3" label={{ value: `HI ${hiHigh}%`, fontSize: 10, fill: '#B45309', position: 'right' }} />
          <Line isAnimationActive={false} dataKey="BI" name="Breteau Index" stroke="#9E1B32" strokeWidth={2} dot={false} />
          <Line isAnimationActive={false} dataKey="HI" name="House Index (%)" stroke="#B45309" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Spark({ values, color = '#0B5F59', width = 120 }: { values: number[]; color?: string; width?: number }) {
  const w = width, h = 32;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${h - (v / max) * (h - 4) - 2}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} />
    </svg>
  );
}
