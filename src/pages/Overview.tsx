import { useMemo, useState } from 'react';
import { CloudRain, Database, Droplets, Radar, ThermometerSun } from 'lucide-react';
import { daysLeft, isActiveWater } from '@/lib/analytics';
import { addDays } from '@/lib/util';
import { useData } from '@/lib/store';
import { boroughSummary, LEVEL_ORDER } from '@/lib/analytics';
import { passesUpTo, sumRange, meanRange } from '@/lib/liveDb';
import { BOROUGHS } from '@/lib/types';
import { fmtDate, fmtDateTime, fmtInt, fmtWeek, fmt1 } from '@/lib/util';
import { go, href } from '@/lib/router';
import { PageHeader } from '@/components/Layout';
import { Card, Kpi, Pill, RiskBadge, Table, Trend } from '@/components/ui';
import { MetricToggle, WardMap, type MapMetric, type MapPoint } from '@/components/WardMap';
import { EpiCurve, RainChart, Spark } from '@/components/Charts';
import { urgencyColor } from './Water';

export const ALERT_TONE = { Watch: 'amber', Warning: 'red', Outbreak: 'red' } as const;

export function Overview() {
  const { db, a, pub } = useData();
  const [metric, setMetric] = useState<MapMetric>('prevention');
  const data = useMemo(() => {
    if (!db || !a) return null;
    const n = a.cityWeekly.length;
    const stats = [...a.stats.values()];
    const withBi = stats.filter((s) => s.bi != null);
    const weekAgo = Date.now() - 7 * 86400000;
    const waterActive = db.detections.filter((d) => isActiveWater(d) && d.waterSince >= addDays(db.asOf, -30));
    const city = pub?.weather?.city;
    const hist = passesUpTo(pub ?? undefined, db.asOf);
    const lastPass = hist[hist.length - 1] ?? null;
    const lastAny = (pub?.passes ?? []).find((p) => p.date <= db.asOf) ?? null;
    return {
      lastWeek: a.cityWeekly[n - 1], prevWeek: a.cityWeekly[n - 2],
      thisWeek: [...a.currentWeekCases.values()].reduce((x, y) => x + y, 0),
      high: stats.filter((s) => LEVEL_ORDER[s.risk.level] >= 2).length,
      prevHigh: stats.filter((s) => s.prevention.score >= 50).length,
      activeAlerts: db.alerts.filter((x) => x.status !== 'Closed' && Date.parse(x.createdAt) > weekAgo).length,
      newAlerts: db.alerts.filter((x) => x.status === 'New').length,
      openSites: stats.reduce((x, s) => x + s.openSites, 0),
      overdue: stats.reduce((x, s) => x + s.overdueTasks, 0),
      openTasks: stats.reduce((x, s) => x + s.openTasks, 0),
      cityBi: withBi.length ? withBi.reduce((x, s) => x + (s.bi ?? 0), 0) / withBi.length : null,
      waterActive,
      urgent: waterActive.filter((d) => { const l = daysLeft(d, db.asOf, a.meanTempC); return l >= 0 && l <= 2; }).length,
      boroughs: BOROUGHS.map((b) => boroughSummary(a, b)).sort((x, y) => (a.noCases ? y.maxPrevention - x.maxPrevention : y.maxRisk - x.maxRisk) || y.waterActive - x.waterActive),
      top: [...stats].sort((x, y) => (a.noCases ? y.prevention.score - x.prevention.score : y.risk.score - x.risk.score)).slice(0, 10),
      rain7: sumRange(city, 'rain', addDays(db.asOf, -6), db.asOf),
      rain28: sumRange(city, 'rain', addDays(db.asOf, -27), db.asOf),
      next3: db.live ? sumRange(city, 'rain', addDays(db.asOf, 1), addDays(db.asOf, 3)) : null,
      next16: db.live ? sumRange(city, 'rain', addDays(db.asOf, 1), addDays(db.asOf, 16)) : null,
      t7: meanRange(city, 'tmean', addDays(db.asOf, -6), db.asOf),
      lastPass, lastAny,
      candidates: (db.candidates ?? []).filter((c) => !['health', 'school'].includes(c.cat)).length,
      chart: (() => {
        if (!city) return null;
        const from = addDays(db.asOf, -59);
        const to = db.live ? addDays(db.asOf, 16) : db.asOf;
        const ix = city.date.map((d, i) => (d >= from && d <= to ? i : -1)).filter((i) => i >= 0);
        return { dates: ix.map((i) => city.date[i]), rain: ix.map((i) => city.rain[i]), tmean: ix.map((i) => city.tmean[i]), rainMax: ix.map((i) => city.rainMax[i]) };
      })(),
    };
  }, [db, a, pub]);
  if (!db || !a || !data) return null;
  const lastWeekStart = a.completeWeeks[a.completeWeeks.length - 1];
  const points: MapPoint[] = data.waterActive.map((d) => {
    const l = daysLeft(d, db.asOf, a.meanTempC);
    return { id: d.id, lat: d.lat, lng: d.lng, color: urgencyColor(l), radius: 4, ring: d.status === 'New', label: `${d.source}: ${d.kind} · ${l < 0 ? 'past window' : `${l} days left`}`, onClick: () => go(href.ward(d.ward)) };
  });

  return (
    <>
      <PageHeader title="City overview"
        subtitle={a.noCases ? `Kolkata on ${fmtDate(db.asOf)} — where water is standing and where mosquitoes are most likely to breed next, from live open data` : `Latest complete week: ${fmtWeek(lastWeekStart)} · risk outlook for the next 2–4 weeks`} />

      <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm">
          <CloudRain className="mt-0.5 shrink-0 text-sky-700" size={20} />
          <div><b>Rain:</b> {data.rain7.toFixed(0)} mm in the last 7 days, {data.rain28.toFixed(0)} mm in 28.
            {data.next3 != null && <> Forecast: {data.next3.toFixed(0)} mm in the next 3 days, {data.next16!.toFixed(0)} mm in 16.</>}</div>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm">
          <ThermometerSun className="mt-0.5 shrink-0 text-rose-700" size={20} />
          <div><b>Breeding window:</b> at {(data.t7 ?? a.meanTempC).toFixed(1)} °C, Aedes go from egg to adult in about <b>{a.devDays} days</b> — water must be cleared within that time.</div>
        </div>
        <a href={href.satellite} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm hover:border-kmc-500">
          <Radar className="mt-0.5 shrink-0 text-kmc-600" size={20} />
          <div><b>Radar:</b> {data.lastPass ? <>{data.lastPass.pass.platform} pass on {fmtDate(data.lastPass.pass.date, false)} — {data.lastPass.totals.newWaterHa.toFixed(1)} ha new water, {data.lastPass.flaggedWards.length} wards flagged.</> : data.lastAny ? <>latest pass {fmtDate(data.lastAny.date, false)}, processing…</> : 'loading passes…'}</div>
        </a>
        <a href={a.noCases ? href.sources : href.cases} className={`flex items-start gap-3 rounded-xl border p-3 text-sm ${a.noCases ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
          <Database className={`mt-0.5 shrink-0 ${a.noCases ? 'text-amber-700' : 'text-kmc-600'}`} size={20} />
          <div>{a.noCases ? <><b>Ward case data:</b> waiting for KMC's feed (detection centres, labs, IHIP). Prevention runs without it; outbreak alerts start once it is connected.</> : <><b>Cases:</b> {fmtInt(data.lastWeek)} last week, {fmtInt(data.thisWeek)} so far this week.</>}</div>
        </a>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {a.noCases ? <>
          <Kpi label="High breeding pressure" value={`${data.prevHigh} / ${db.wards.length}`} tone={data.prevHigh > 20 ? 'bad' : data.prevHigh > 0 ? 'warn' : 'good'} sub="wards at High or Very high" />
          <Kpi label="Active water spots" value={data.waterActive.length} sub={`${data.waterActive.filter((d) => d.status === 'New').length} not yet checked`} />
          <Kpi label="Clear within 2 days" value={data.urgent} tone={data.urgent ? 'bad' : 'good'} sub="before adults emerge" />
          <Kpi label="Radar new water" value={data.lastPass ? `${data.lastPass.totals.newWaterHa.toFixed(0)} ha` : '—'} sub={data.lastPass ? `pass ${fmtDate(data.lastPass.pass.date, false)}` : 'no pass yet'} />
          <Kpi label="Sites to inspect" value={fmtInt(data.candidates)} sub="tyre shops, scrap, construction, ponds… (OSM)" />
          <Kpi label="Open field tasks" value={data.openTasks} tone={data.overdue ? 'warn' : 'default'} sub={`${data.overdue} overdue`} />
        </> : <>
          <Kpi label="Cases last week" value={fmtInt(data.lastWeek)} sub={<Trend now={data.lastWeek} before={data.prevWeek} />} />
          <Kpi label="This week so far" value={fmtInt(data.thisWeek)} sub="Reports received since Monday" />
          <Kpi label="High-risk wards" value={`${data.high} / ${db.wards.length}`} tone={data.high > 10 ? 'bad' : data.high > 0 ? 'warn' : 'good'} sub="High or very high risk" />
          <Kpi label="Active alerts" value={data.activeAlerts} tone={data.newAlerts ? 'bad' : 'default'} sub={`${data.newAlerts} not yet actioned`} />
          <Kpi label="Overdue tasks" value={data.overdue} tone={data.overdue ? 'warn' : 'good'} sub={`${data.openTasks} open in total`} />
          <Kpi label="City Breteau Index" value={fmt1(data.cityBi)} sub={`${data.openSites} open breeding sites`} />
        </>}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3" title="Ward map" subtitle={metric === 'prevention' ? 'Breeding pressure from weather, radar, land cover, mapped sites and population. Dots: active water spots. Click a ward.' : 'Click a ward to open it'}
          action={<MetricToggle value={metric} onChange={setMetric} noCases={a.noCases} />}>
          <WardMap stats={a.stats} wards={db.wards} metric={metric} noCases={a.noCases} points={points} onSelect={(w) => go(href.ward(w))} height={520} />
          <p className="mt-2 text-[11px] text-slate-500">Ward boundaries: DataMeet open data (141 wards). Wards 142–144 shown at approximate locations until KMC supplies official boundaries.</p>
        </Card>
        <Card className="xl:col-span-2" title="Boroughs" subtitle={a.noCases ? 'Ranked by highest ward breeding pressure' : 'Ranked by highest ward risk'}>
          <Table head={a.noCases ? ['Borough', 'Highest ward', 'High wards', 'Water spots', 'Sites'] : ['Borough', 'Cases 2 wks', '12-wk trend', 'High-risk', 'BI', 'Overdue']}>
            {data.boroughs.map((b) => (
              <tr key={b.borough} className="cursor-pointer hover:bg-slate-50" onClick={() => go(href.borough(b.borough))}>
                <td className="whitespace-nowrap px-2 py-1.5 font-medium text-kmc-700">{b.borough}</td>
                {a.noCases ? <>
                  <td className="px-2 py-1.5 tabular-nums">{b.maxPrevention}</td>
                  <td className="px-2 py-1.5 tabular-nums">{b.highPrevention} / {b.wards.length}</td>
                  <td className="px-2 py-1.5 tabular-nums">{b.waterActive}{b.waterUrgent ? <span className="text-red-700"> ({b.waterUrgent} urgent)</span> : ''}</td>
                  <td className="px-2 py-1.5 tabular-nums">{b.candidates}</td>
                </> : <>
                  <td className="px-2 py-1.5 tabular-nums">{b.last2w}</td>
                  <td className="px-2 py-1.5"><Spark values={b.weekly.slice(-12)} width={80} /></td>
                  <td className="px-2 py-1.5 tabular-nums">{b.highRisk} / {b.wards.length}</td>
                  <td className="px-2 py-1.5 tabular-nums">{fmt1(b.meanBi)}</td>
                  <td className={`px-2 py-1.5 tabular-nums ${b.overdueTasks ? 'font-semibold text-amber-700' : ''}`}>{b.overdueTasks}</td>
                </>}
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3" title={a.noCases ? 'Rain and temperature' : 'Weekly confirmed cases — city'}
          subtitle={a.noCases ? `Last 60 days${db.live ? ' and 16-day forecast' : ''}, mean of 16 boroughs (Open-Meteo). Heavy rain → water spots 1–3 days later → adults ${a.devDays} days after that.` : 'Last 52 weeks against the same weeks a year earlier, with rainfall'}>
          {a.noCases ? (data.chart ? <RainChart dates={data.chart.dates} rain={data.chart.rain} rainMax={data.chart.rainMax} tmean={data.chart.tmean} today={db.asOf} height={280} /> : null)
            : <EpiCurve weeks={a.completeWeeks} cases={a.cityWeekly} rain={a.rainWeekly} height={280} />}
        </Card>
        <Card className="xl:col-span-2" title={a.noCases ? 'Wards to act on first' : 'Highest-risk wards'} subtitle={a.noCases ? 'Highest breeding pressure, with the main reason' : 'Model outlook for the next 2–4 weeks'}>
          <ul className="divide-y divide-slate-100">
            {data.top.map((s) => {
              const top = [...s.prevention.components].filter((c) => c.key !== 'weather').sort((x, y) => y.value - x.value)[0];
              return (
                <li key={s.ward} className="flex cursor-pointer items-center gap-3 py-2 hover:bg-slate-50" onClick={() => go(href.ward(s.ward))}>
                  <span className="w-20 whitespace-nowrap text-sm font-semibold text-kmc-700">Ward {s.ward}</span>
                  <span className="w-20 whitespace-nowrap text-xs text-slate-500">Borough {s.borough}</span>
                  {a.noCases ? <RiskBadge level={s.prevention.level} score={s.prevention.score} /> : <RiskBadge level={s.risk.level} score={s.risk.score} />}
                  <span className="ml-auto truncate text-xs text-slate-600" title={a.noCases ? top?.raw : undefined}>{a.noCases ? top?.label : s.risk.drivers[0].label}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card className="mt-4" title="Latest alerts" action={<a className="text-sm font-medium text-kmc-700" href={href.alerts}>All alerts →</a>}>
        {db.alerts.length === 0 ? (
          <p className="text-sm text-slate-600">{a.signals.length ? <>{a.signals.length} signals ready — open <a className="text-kmc-700 underline" href={href.alerts}>Alerts</a> and run the alert check to issue them.</> : 'No alerts.'}</p>
        ) : (
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
        )}
      </Card>
      {a.noCases && <p className="mt-3 flex items-center gap-1 text-[11px] text-slate-500"><Droplets size={12} /> The prevention index uses no case data; its weights are an expert baseline until fitted on KMC's records. See the Evidence check for how it lines up with publicly reported hotspot wards.</p>}
    </>
  );
}
