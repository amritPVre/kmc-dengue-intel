import { useMemo, useState } from 'react';
import { useData } from '@/lib/store';
import { boroughSummary } from '@/lib/analytics';
import { BOROUGHS, type BoroughCode, type WardStats } from '@/lib/types';
import { fmt1, fmtDateTime, fmtInt } from '@/lib/util';
import { go, href } from '@/lib/router';
import { PageHeader } from '@/components/Layout';
import { Card, Empty, Kpi, Pill, RiskBadge, Table, Trend } from '@/components/ui';
import { MetricToggle, WardMap, type MapMetric } from '@/components/WardMap';
import { EpiCurve, Spark } from '@/components/Charts';
import { ALERT_TONE } from './Overview';

export function Boroughs() {
  const { a, scope } = useData();
  if (!a) return null;
  const list = BOROUGHS.filter((b) => scope.role === 'hq' || b === scope.borough).map((b) => boroughSummary(a, b));
  return (
    <>
      <PageHeader title="Boroughs" subtitle="16 boroughs · cases over the last two complete weeks and the highest ward risk in each" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {list.map((b) => {
          const worst = b.wards.reduce((x, y) => (y.risk.score > x.risk.score ? y : x));
          return (
            <button key={b.borough} onClick={() => go(href.borough(b.borough))} className="rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-kmc-500">
              <div className="flex items-center justify-between">
                <span className="text-base font-bold text-ink">Borough {b.borough}</span>
                <RiskBadge level={worst.risk.level} score={worst.risk.score} />
              </div>
              <div className="mt-1 text-xs text-slate-500">{b.wards.length} wards · {fmtInt(b.population)} people (approx.)</div>
              <div className="mt-3 flex items-end justify-between">
                <div>
                  <div className="text-2xl font-bold tabular-nums">{b.last2w}</div>
                  <div className="text-xs text-slate-600">cases, last 2 weeks · <Trend now={b.last2w} before={b.prev2w} /></div>
                </div>
                <Spark values={b.weekly.slice(-16)} />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                <Pill tone={b.highRisk ? 'red' : 'slate'}>{b.highRisk} high-risk wards</Pill>
                <Pill>BI {fmt1(b.meanBi)}</Pill>
                <Pill tone={b.overdueTasks ? 'amber' : 'slate'}>{b.overdueTasks} overdue tasks</Pill>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

type SortKey = 'risk' | 'cases' | 'bi' | 'sites' | 'tasks';
export function WardTable({ wards }: { wards: WardStats[] }) {
  const [sort, setSort] = useState<SortKey>('risk');
  const rows = useMemo(() => {
    const k: Record<SortKey, (s: WardStats) => number> = {
      risk: (s) => s.risk.score, cases: (s) => s.last2w, bi: (s) => s.bi ?? -1, sites: (s) => s.openSites, tasks: (s) => s.overdueTasks * 100 + s.openTasks,
    };
    return [...wards].sort((x, y) => k[sort](y) - k[sort](x));
  }, [wards, sort]);
  const H = ({ k, children }: { k: SortKey; children: string }) => (
    <button className={`uppercase ${sort === k ? 'text-kmc-700 underline' : ''}`} onClick={() => setSort(k)}>{children}</button>
  );
  return (
    <Table head={['Ward', <H k="risk">Risk</H>, <H k="cases">Cases 2 wks</H>, 'Forecast 4 wks', <H k="bi">BI</H>, 'HI %', <H k="sites">Open sites</H>, <H k="tasks">Tasks open / overdue</H>]}>
      {rows.map((s) => (
        <tr key={s.ward} className="cursor-pointer hover:bg-slate-50" onClick={() => go(href.ward(s.ward))}>
          <td className="px-2 py-1.5 font-semibold text-kmc-700">Ward {s.ward}</td>
          <td className="px-2 py-1.5"><RiskBadge level={s.risk.level} score={s.risk.score} /></td>
          <td className="px-2 py-1.5 tabular-nums">{s.last2w} <span className="text-xs text-slate-500">({s.prev2w} before)</span></td>
          <td className="px-2 py-1.5 tabular-nums">{s.risk.forecast.reduce((x, f) => x + f.mean, 0).toFixed(1)}</td>
          <td className={`px-2 py-1.5 tabular-nums ${s.bi != null && s.bi >= 20 ? 'font-semibold text-red-700' : ''}`}>{fmt1(s.bi)}</td>
          <td className="px-2 py-1.5 tabular-nums">{fmt1(s.hi)}</td>
          <td className="px-2 py-1.5 tabular-nums">{s.openSites}</td>
          <td className="px-2 py-1.5 tabular-nums">{s.openTasks} / <span className={s.overdueTasks ? 'font-semibold text-amber-700' : ''}>{s.overdueTasks}</span></td>
        </tr>
      ))}
    </Table>
  );
}

export function BoroughDetail({ code }: { code: string }) {
  const { db, a } = useData();
  const [metric, setMetric] = useState<MapMetric>('risk');
  if (!db || !a) return null;
  if (!BOROUGHS.includes(code as BoroughCode)) return <Empty>Borough {code} not found.</Empty>;
  const b = boroughSummary(a, code as BoroughCode);
  const wardSet = new Set(b.wards.map((w) => w.ward));
  const wards = db.wards.filter((w) => wardSet.has(w.ward));
  const alerts = db.alerts.filter((x) => wardSet.has(x.ward) && x.status !== 'Closed');
  const tasks = db.tasks.filter((t) => wardSet.has(t.ward));
  const n = b.weekly.length;
  const done = tasks.filter((t) => t.status === 'Done' || t.status === 'Verified');
  const onTime = done.filter((t) => t.completedAt && t.completedAt <= t.dueAt).length;
  return (
    <>
      <PageHeader title={`Borough ${code}`} subtitle={`${b.wards.length} wards · ${fmtInt(b.population)} people (approx.)`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Cases last week" value={b.weekly[n - 1]} sub={<Trend now={b.weekly[n - 1]} before={b.weekly[n - 2]} />} />
        <Kpi label="Cases this year" value={fmtInt(b.ytd)} />
        <Kpi label="High-risk wards" value={`${b.highRisk} / ${b.wards.length}`} tone={b.highRisk ? 'bad' : 'good'} />
        <Kpi label="Open alerts" value={alerts.length} tone={alerts.some((x) => x.status === 'New') ? 'bad' : 'default'} />
        <Kpi label="Tasks on time" value={done.length ? `${Math.round((onTime / done.length) * 100)}%` : '—'} sub={`${b.overdueTasks} overdue now`} tone={b.overdueTasks ? 'warn' : 'good'} />
        <Kpi label="Mean Breteau Index" value={fmt1(b.meanBi)} sub={`${b.openSites} open breeding sites`} />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3" title="Wards in this borough" action={<MetricToggle value={metric} onChange={setMetric} />}>
          <WardMap stats={a.stats} wards={wards} metric={metric} onSelect={(w) => go(href.ward(w))} height={440} />
        </Card>
        <Card className="xl:col-span-2" title="Weekly cases — borough">
          <EpiCurve weeks={a.completeWeeks} cases={b.weekly} rain={a.rainWeekly} height={300} />
        </Card>
      </div>
      <Card className="mt-4" title="Ward ranking" subtitle="Click a column to sort; click a ward to open it">
        <WardTable wards={b.wards} />
      </Card>
      <Card className="mt-4" title="Open alerts in this borough">
        {alerts.length === 0 ? <Empty>No open alerts.</Empty> : (
          <ul className="divide-y divide-slate-100">
            {alerts.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <Pill tone={ALERT_TONE[x.level]}>{x.level}</Pill>
                <a href={href.ward(x.ward)} className="font-semibold text-kmc-700">Ward {x.ward}</a>
                <span>{x.title}</span>
                <span className="ml-auto text-xs text-slate-500">{fmtDateTime(x.createdAt)} · {x.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

