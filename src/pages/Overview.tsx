import { useMemo, useState } from 'react';
import { useData } from '@/lib/store';
import { boroughSummary, LEVEL_ORDER } from '@/lib/analytics';
import { BOROUGHS } from '@/lib/types';
import { fmtDateTime, fmtInt, fmtWeek, fmt1 } from '@/lib/util';
import { go, href } from '@/lib/router';
import { PageHeader } from '@/components/Layout';
import { Card, Kpi, Pill, RiskBadge, Table, Trend } from '@/components/ui';
import { MetricToggle, WardMap, type MapMetric } from '@/components/WardMap';
import { EpiCurve, Spark } from '@/components/Charts';

export const ALERT_TONE = { Watch: 'amber', Warning: 'red', Outbreak: 'red' } as const;

export function Overview() {
  const { db, a } = useData();
  const [metric, setMetric] = useState<MapMetric>('risk');
  const data = useMemo(() => {
    if (!db || !a) return null;
    const n = a.cityWeekly.length;
    const stats = [...a.stats.values()];
    const withBi = stats.filter((s) => s.bi != null);
    const weekAgo = Date.now() - 7 * 86400000;
    return {
      lastWeek: a.cityWeekly[n - 1],
      prevWeek: a.cityWeekly[n - 2],
      thisWeek: [...a.currentWeekCases.values()].reduce((x, y) => x + y, 0),
      high: stats.filter((s) => LEVEL_ORDER[s.risk.level] >= 2).length,
      activeAlerts: db.alerts.filter((x) => x.status !== 'Closed' && Date.parse(x.createdAt) > weekAgo).length,
      newAlerts: db.alerts.filter((x) => x.status === 'New').length,
      openSites: stats.reduce((x, s) => x + s.openSites, 0),
      overdue: stats.reduce((x, s) => x + s.overdueTasks, 0),
      openTasks: stats.reduce((x, s) => x + s.openTasks, 0),
      cityBi: withBi.length ? withBi.reduce((x, s) => x + (s.bi ?? 0), 0) / withBi.length : null,
      boroughs: BOROUGHS.map((b) => boroughSummary(a, b)).sort((x, y) => y.maxRisk - x.maxRisk || y.last2w - x.last2w),
      top: stats.sort((x, y) => y.risk.score - x.risk.score).slice(0, 10),
    };
  }, [db, a]);
  if (!db || !a || !data) return null;
  const lastWeekStart = a.completeWeeks[a.completeWeeks.length - 1];

  return (
    <>
      <PageHeader title="City overview" subtitle={`Latest complete week: ${fmtWeek(lastWeekStart)} · risk outlook for the next 2–4 weeks`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Cases last week" value={fmtInt(data.lastWeek)} sub={<Trend now={data.lastWeek} before={data.prevWeek} />} />
        <Kpi label="This week so far" value={fmtInt(data.thisWeek)} sub="Reports received since Monday" />
        <Kpi label="High-risk wards" value={`${data.high} / ${db.wards.length}`} tone={data.high > 10 ? 'bad' : data.high > 0 ? 'warn' : 'good'} sub="High or very high risk" />
        <Kpi label="Active alerts" value={data.activeAlerts} tone={data.newAlerts ? 'bad' : 'default'} sub={`${data.newAlerts} not yet actioned`} />
        <Kpi label="Overdue tasks" value={data.overdue} tone={data.overdue ? 'warn' : 'good'} sub={`${data.openTasks} open in total`} />
        <Kpi label="City Breteau Index" value={fmt1(data.cityBi)} sub={`${data.openSites} open breeding sites`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3" title="Ward map" subtitle="Click a ward to open it" action={<MetricToggle value={metric} onChange={setMetric} />}>
          <WardMap stats={a.stats} wards={db.wards} metric={metric} onSelect={(w) => go(href.ward(w))} height={520} />
          <p className="mt-2 text-[11px] text-slate-500">Ward boundaries: DataMeet open data (141 wards). Wards 142–144 shown at approximate locations until KMC supplies official boundaries.</p>
        </Card>
        <Card className="xl:col-span-2" title="Boroughs" subtitle="Ranked by highest ward risk">
          <Table head={['Borough', 'Cases 2 wks', '12-wk trend', 'High-risk', 'BI', 'Overdue']}>
            {data.boroughs.map((b) => (
              <tr key={b.borough} className="cursor-pointer hover:bg-slate-50" onClick={() => go(href.borough(b.borough))}>
                <td className="whitespace-nowrap px-2 py-1.5 font-medium text-kmc-700">{b.borough}</td>
                <td className="px-2 py-1.5 tabular-nums">{b.last2w}</td>
                <td className="px-2 py-1.5"><Spark values={b.weekly.slice(-12)} width={80} /></td>
                <td className="px-2 py-1.5 tabular-nums">{b.highRisk} / {b.wards.length}</td>
                <td className="px-2 py-1.5 tabular-nums">{fmt1(b.meanBi)}</td>
                <td className={`px-2 py-1.5 tabular-nums ${b.overdueTasks ? 'font-semibold text-amber-700' : ''}`}>{b.overdueTasks}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3" title="Weekly confirmed cases — city" subtitle="Last 52 weeks against the same weeks a year earlier, with rainfall">
          <EpiCurve weeks={a.completeWeeks} cases={a.cityWeekly} rain={a.rainWeekly} height={280} />
        </Card>
        <Card className="xl:col-span-2" title="Highest-risk wards" subtitle="Model outlook for the next 2–4 weeks">
          <ul className="divide-y divide-slate-100">
            {data.top.map((s) => (
              <li key={s.ward} className="flex cursor-pointer items-center gap-3 py-2 hover:bg-slate-50" onClick={() => go(href.ward(s.ward))}>
                <span className="w-20 whitespace-nowrap text-sm font-semibold text-kmc-700">Ward {s.ward}</span>
                <span className="w-24 whitespace-nowrap text-xs text-slate-500">Borough {s.borough}</span>
                <RiskBadge level={s.risk.level} score={s.risk.score} />
                <span className="ml-auto truncate text-xs text-slate-600">{s.risk.drivers[0].label}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="mt-4" title="Latest alerts" action={<a className="text-sm font-medium text-kmc-700" href={href.alerts}>All alerts →</a>}>
        <ul className="divide-y divide-slate-100">
          {db.alerts.slice(0, 6).map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <Pill tone={ALERT_TONE[x.level]}>{x.level}</Pill>
              <a href={href.ward(x.ward)} className="font-semibold text-kmc-700">Ward {x.ward}</a>
              <span>{x.title}</span>
              <span className="ml-auto text-xs text-slate-500">{fmtDateTime(x.createdAt)} · {x.status}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
