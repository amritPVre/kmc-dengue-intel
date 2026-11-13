import { useMemo, useState } from 'react';
import { SOP } from '@shared/risk-engine';
import { canEdit, useData } from '@/lib/store';
import { addDays, fmt1, fmtDate, fmtDateTime, fmtInt, mondayOf } from '@/lib/util';
import { href } from '@/lib/router';
import { PageHeader } from '@/components/Layout';
import { Button, Card, Empty, Kpi, Pill, RiskBadge, Table, Trend } from '@/components/ui';
import { WardMap, type MapPoint } from '@/components/WardMap';
import { DriverBars, ForecastChart, IndicesChart } from '@/components/Charts';
import { ALERT_TONE } from './Overview';
import { TaskList } from './FieldOps';
import { SiteForm, SurveyForm } from './forms';

const SITE_COLOR = { Open: '#C2410C', Treated: '#2563EB', Closed: '#64748B' } as const;

export function WardDetail({ ward }: { ward: number }) {
  const { db, a, scope, actionAlert, notify } = useData();
  const [survey, setSurvey] = useState(false);
  const [site, setSite] = useState(false);
  const w = db?.wards.find((x) => x.ward === ward);
  const s = a?.stats.get(ward);

  const derived = useMemo(() => {
    if (!db || !a || !w) return null;
    const since = addDays(db.asOf, -27);
    const cases = db.cases.filter((c) => c.ward === ward && c.reportedOn >= since).sort((x, y) => y.reportedOn.localeCompare(x.reportedOn));
    const sites = db.sites.filter((x) => x.ward === ward);
    const tasks = db.tasks.filter((t) => t.ward === ward).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    const alerts = db.alerts.filter((x) => x.ward === ward && x.status !== 'Closed');
    const clusterCircles = alerts.filter((x) => x.clusterCentroid).map((x) => ({ lng: x.clusterCentroid![0], lat: x.clusterCentroid![1], label: x.title }));
    const weeks = a.completeWeeks.slice(-12);
    const byWeek = new Map(weeks.map((wk) => [wk, { hv: 0, hp: 0, cp: 0 }]));
    for (const sv of db.surveys) {
      if (sv.ward !== ward) continue;
      const acc = byWeek.get(mondayOf(sv.date));
      if (!acc) continue;
      acc.hv += sv.housesVisited; acc.hp += sv.housesPositive; acc.cp += sv.containersPositive;
    }
    const indices = weeks.map((wk) => {
      const v = byWeek.get(wk)!;
      return { week: fmtDate(wk, false), HI: v.hv ? (v.hp / v.hv) * 100 : null, BI: v.hv ? (v.cp / v.hv) * 100 : null };
    });
    const points: MapPoint[] = [
      ...sites.map((x) => ({ id: x.id, lat: x.lat, lng: x.lng, color: SITE_COLOR[x.status], radius: 5, label: `${x.type} — ${x.status} (${x.detectedBy})` })),
      ...(scope.role === 'councillor' ? [] : cases.map((c) => ({ id: c.id, lat: c.lat, lng: c.lng, color: '#7C3AED', radius: 4, label: `Case reported ${fmtDate(c.reportedOn)} · ${c.ageBand} ${c.sex}` }))),
    ];
    return { cases, sites, tasks, alerts, clusterCircles, indices, points };
  }, [db, a, w, ward, scope.role]);

  if (!db || !a) return null;
  if (!w || !s || !derived) return <Empty>Ward {ward} not found.</Empty>;
  const n = s.weekly.length;
  const editable = canEdit(scope.role);
  const latestByType = [...new Map([...derived.alerts].sort((x, y) => x.createdAt.localeCompare(y.createdAt)).map((x) => [x.type, x])).values()];
  const recommended = latestByType.length
    ? latestByType
    : s.risk.level === 'High' || s.risk.level === 'Very high'
      ? [{ id: 'risk', type: 'predicted' as const, level: 'Watch' as const, title: 'Pre-emptive action recommended', detail: 'Risk is high although no alert threshold has been crossed yet.' }]
      : [];

  return (
    <>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">Ward {ward} <RiskBadge level={s.risk.level} score={s.risk.score} /></span>}
        subtitle={<>
          <a className="text-kmc-700" href={href.borough(w.borough)}>Borough {w.borough}</a> · {fmtInt(w.population)} people (approx.) · {w.areaKm2.toFixed(2)} km²
          {w.boundary === 'pending' && <> · <span className="text-amber-700">boundary pending</span></>}
          {' '}· Neighbours: {w.neighbours.map((nb, i) => <span key={nb}>{i > 0 && ', '}<a className="text-kmc-700" href={href.ward(nb)}>{nb}</a></span>)}
        </>}
        actions={editable ? <>
          <Button variant="secondary" onClick={() => setSurvey(true)}>Log larval survey</Button>
          <Button variant="secondary" onClick={() => setSite(true)}>Report breeding site</Button>
        </> : undefined}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Cases last week" value={s.weekly[n - 1]} sub={<Trend now={s.weekly[n - 1]} before={s.weekly[n - 2]} />} />
        <Kpi label="Cases this year" value={s.ytd} sub={`${(s.ytd / w.population * 1e4).toFixed(1)} per 10,000`} />
        <Kpi label="Breteau Index" value={fmt1(s.bi)} tone={s.bi != null && s.bi >= a.config.alerts.breteauHigh ? 'bad' : 'default'} sub={`House Index ${fmt1(s.hi)}% · last 2 weeks`} />
        <Kpi label="Open breeding sites" value={s.openSites} tone={s.openSites > 5 ? 'warn' : 'default'} />
        <Kpi label="Field tasks" value={`${s.openTasks} open`} sub={`${s.overdueTasks} overdue`} tone={s.overdueTasks ? 'warn' : 'default'} />
        <Kpi label="Forecast, next 4 weeks" value={s.risk.forecast.reduce((x, f) => x + f.mean, 0).toFixed(0)} sub="expected cases" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Cases and 4-week forecast" subtitle="Bars: confirmed cases by week · dashed line and band: forecast with 90% range">
          <ForecastChart weeks={a.completeWeeks} cases={s.weekly} forecast={s.risk.forecast} />
        </Card>
        <Card title="Why this ward's risk is what it is" subtitle={`Contribution of each factor to the risk score · model ${s.risk.modelVersion}`}>
          <DriverBars drivers={s.risk.drivers} height={260} />
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3" title="Ward map" subtitle="Purple: cases in the last 4 weeks · orange: open breeding sites · blue: treated · dashed ring: case cluster">
          <WardMap stats={a.stats} wards={db.wards.filter((x) => x.ward === ward || w.neighbours.includes(x.ward))} focusWards={[ward]} highlight={ward}
            metric="risk" points={derived.points} circles={derived.clusterCircles} height={400} />
        </Card>
        <Card className="xl:col-span-2" title="Recommended actions" subtitle="From KMC's response playbook (configurable)">
          {recommended.length === 0 ? <Empty>No action triggered. Continue routine weekly surveillance.</Empty> : (
            <div className="space-y-3">
              {recommended.map((al) => (
                <div key={al.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2"><Pill tone={ALERT_TONE[al.level]}>{al.level}</Pill><b className="text-sm">{al.title}</b></div>
                  <p className="mt-1 text-xs text-slate-600">{al.detail}</p>
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-700">
                    {SOP[al.type].map((t) => <li key={t.title}>{t.title} <span className="text-slate-500">(within {t.slaHours} h, {t.priority})</span></li>)}
                  </ul>
                  {editable && 'createdAt' in al && (al as { status: string }).status === 'New' && (
                    <div className="mt-2"><Button small onClick={async () => { const k = await actionAlert(al as never); notify(`${k} tasks assigned to ward ${ward} team`); }}>Assign these tasks</Button></div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Larval indices" subtitle="Weekly House Index and Breteau Index from field surveys">
          <IndicesChart data={derived.indices} biHigh={a.config.alerts.breteauHigh} hiHigh={a.config.alerts.houseIndexHigh} />
        </Card>
        <Card title="Field tasks" action={<a href={href.field} className="text-sm font-medium text-kmc-700">Field operations →</a>}>
          <TaskList tasks={derived.tasks.slice(0, 8)} compact />
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Breeding sites" subtitle={`${derived.sites.filter((x) => x.status === 'Open').length} open of ${derived.sites.length} on record`}>
          {derived.sites.length === 0 ? <Empty>No sites recorded.</Empty> : (
            <Table head={['Type', 'Status', 'Found by', 'First seen', 'Last action']}>
              {derived.sites.sort((x, y) => (x.status === 'Open' ? -1 : 1) - (y.status === 'Open' ? -1 : 1)).map((x) => (
                <tr key={x.id}>
                  <td className="px-2 py-1.5">{x.type}</td>
                  <td className="px-2 py-1.5"><Pill tone={x.status === 'Open' ? 'amber' : x.status === 'Treated' ? 'blue' : 'slate'}>{x.status}</Pill></td>
                  <td className="px-2 py-1.5">{x.detectedBy}</td>
                  <td className="px-2 py-1.5">{fmtDate(x.firstSeen)}</td>
                  <td className="px-2 py-1.5">{x.lastActionOn ? fmtDate(x.lastActionOn) : '—'}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Case line list — last 4 weeks" subtitle="Anonymised: no names, phone numbers or addresses are shown or stored in analytics">
          {scope.role === 'councillor' ? <Empty>Case details are restricted to health officers. Weekly counts appear in the charts above.</Empty> : derived.cases.length === 0 ? <Empty>No cases in the last 4 weeks.</Empty> : (
            <Table head={['Reported', 'Onset', 'Age', 'Sex', 'Test', 'Source', 'Severity']}>
              {derived.cases.map((c) => (
                <tr key={c.id}>
                  <td className="whitespace-nowrap px-2 py-1.5">{fmtDate(c.reportedOn, false)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{fmtDate(c.onsetOn, false)}</td>
                  <td className="px-2 py-1.5">{c.ageBand}</td>
                  <td className="px-2 py-1.5">{c.sex}</td>
                  <td className="px-2 py-1.5">{c.test}</td>
                  <td className="px-2 py-1.5">{c.source}</td>
                  <td className="px-2 py-1.5">{c.severity}{c.hospitalised && <span className="ml-1 text-xs text-red-700">(admitted)</span>}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      {derived.alerts.length > 0 && (
        <Card className="mt-4" title="Open alerts for this ward">
          <ul className="divide-y divide-slate-100 text-sm">
            {derived.alerts.map((x) => <li key={x.id} className="py-2"><Pill tone={ALERT_TONE[x.level]}>{x.level}</Pill> <b>{x.title}</b> <span className="text-xs text-slate-500">· {fmtDateTime(x.createdAt)} · {x.status}</span><p className="text-xs text-slate-600">{x.detail}</p></li>)}
          </ul>
        </Card>
      )}
      <SurveyForm open={survey} onClose={() => setSurvey(false)} ward={ward} />
      <SiteForm open={site} onClose={() => setSite(false)} ward={ward} />
    </>
  );
}
