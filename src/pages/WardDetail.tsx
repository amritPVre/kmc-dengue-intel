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
import { daysLeft, isActiveWater } from '@/lib/analytics';
import { ClearBy, SpotActions, urgencyColor } from './Water';
import { passesUpTo } from '@/lib/liveDb';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';

const CAT_COLOR: Record<string, string> = { tyres: '#B91C1C', vehicle: '#EA580C', scrap: '#7C2D12', construction: '#CA8A04', market: '#9333EA', nursery: '#16A34A', vacant: '#A16207', pond: '#0284C7', drain: '#0E7490', depot: '#475569', health: '#DB2777', school: '#4F46E5' };

function PreventionBars({ comps }: { comps: { key: string; label: string; value: number; raw: string }[] }) {
  return (
    <ul className="space-y-2.5 text-sm">
      {comps.map((c) => (
        <li key={c.key}>
          <div className="flex items-center gap-2">
            <span className="w-56 shrink-0 text-slate-700">{c.label}</span>
            <span className="h-2.5 flex-1 overflow-hidden rounded bg-slate-100"><span className="block h-full rounded" style={{ width: `${Math.round(c.value * 100)}%`, background: c.value >= 0.75 ? '#9E1B32' : c.value >= 0.5 ? '#E25E3A' : c.value >= 0.25 ? '#F7AE57' : '#FBE7A1' }} /></span>
            <span className="w-10 text-right text-xs tabular-nums text-slate-600">{Math.round(c.value * 100)}</span>
          </div>
          <div className="ml-56 pl-2 text-[11px] text-slate-500">{c.raw}</div>
        </li>
      ))}
    </ul>
  );
}

const SITE_COLOR = { Open: '#C2410C', Treated: '#2563EB', Closed: '#64748B' } as const;

export function WardDetail({ ward }: { ward: number }) {
  const { db, a, scope, actionAlert, notify, pub, addTask } = useData();
  const [survey, setSurvey] = useState(false);
  const [site, setSite] = useState(false);
  const [showSites, setShowSites] = useState(true);
  const [imagery, setImagery] = useState(false);
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
    const water = db.detections.filter((d) => d.ward === ward && isActiveWater(d) && d.waterSince >= addDays(db.asOf, -30))
      .sort((x, y) => daysLeft(x, db.asOf, a.meanTempC) - daysLeft(y, db.asOf, a.meanTempC));
    const cands = (db.candidates ?? []).filter((c) => c.ward === ward);
    const radar = passesUpTo(pub ?? undefined, db.asOf).map((h) => ({ day: fmtDate(h.pass.date, false), ha: +(h.wards[ward]?.[1] ?? 0).toFixed(2) })).slice(-30);
    const points: MapPoint[] = [
      ...(showSites ? cands.filter((c) => c.cat !== 'school').map((c) => ({ id: c.id, lat: c.lat, lng: c.lng, color: CAT_COLOR[c.cat] ?? '#64748B', radius: 3.5, square: true, label: `${pub?.osm?.categories?.[c.cat] ?? c.cat}${c.name ? `: ${c.name}` : ''} (OpenStreetMap)` })) : []),
      ...water.map((d) => ({ id: d.id, lat: d.lat, lng: d.lng, color: urgencyColor(daysLeft(d, db.asOf, a.meanTempC)), radius: 6, ring: d.status === 'New', label: `Water: ${d.kind} (${d.source})` })),
      ...sites.map((x) => ({ id: x.id, lat: x.lat, lng: x.lng, color: SITE_COLOR[x.status], radius: 5, label: `${x.type} — ${x.status} (${x.detectedBy})` })),
      ...(scope.role === 'councillor' ? [] : cases.map((c) => ({ id: c.id, lat: c.lat, lng: c.lng, color: '#7C3AED', radius: 4, label: `Case reported ${fmtDate(c.reportedOn)} · ${c.ageBand} ${c.sex}` }))),
    ];
    return { cases, sites, tasks, alerts, clusterCircles, indices, points, water, cands, radar };
  }, [db, a, w, ward, scope.role, pub, showSites]);

  if (!db || !a) return null;
  if (!w || !s || !derived) return <Empty>Ward {ward} not found.</Empty>;
  const n = s.weekly.length;
  const editable = canEdit(scope.role);
  const latestByType = [...new Map([...derived.alerts].sort((x, y) => x.createdAt.localeCompare(y.createdAt)).map((x) => [x.type, x])).values()];
  const noCases = a.noCases;
  const pv = s.prevention;
  const recommended = latestByType.length
    ? latestByType
    : (noCases ? pv.score >= 50 : s.risk.level === 'High' || s.risk.level === 'Very high')
      ? [{ id: 'risk', type: 'predicted' as const, level: 'Watch' as const, title: 'Pre-emptive action recommended', detail: noCases ? `Breeding pressure is ${pv.level.toLowerCase()} (${pv.score}/100). Act before cases appear.` : 'Risk is high although no alert threshold has been crossed yet.' }]
      : [];

  return (
    <>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">Ward {ward} {noCases ? <><RiskBadge level={pv.level} score={pv.score} /><span className="text-xs font-normal text-slate-500">breeding pressure</span></> : <RiskBadge level={s.risk.level} score={s.risk.score} />}</span>}
        subtitle={<>
          <a className="text-kmc-700" href={href.borough(w.borough)}>Borough {w.borough}</a> · {fmtInt(w.population)} people ({w.populationSource === 'census2011' ? 'Census 2011' : w.populationSource === 'synthetic' ? 'simulated' : 'estimate'}) · {w.areaKm2.toFixed(2)} km²
          {w.boundary === 'pending' && <> · <span className="text-amber-700">boundary pending</span></>}
          {' '}· Neighbours: {w.neighbours.map((nb, i) => <span key={nb}>{i > 0 && ', '}<a className="text-kmc-700" href={href.ward(nb)}>{nb}</a></span>)}
        </>}
        actions={editable ? <>
          <Button variant="secondary" onClick={() => setSurvey(true)}>Log larval survey</Button>
          <Button variant="secondary" onClick={() => setSite(true)}>Report breeding site</Button>
        </> : undefined}
      />
      {noCases ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Breeding pressure" value={`${pv.score}/100`} tone={pv.score >= 50 ? 'bad' : pv.score >= 25 ? 'warn' : 'good'} sub={`structural ${Math.round(pv.structural * 100)}/100, weather adds the rest`} />
          <Kpi label="Active water spots" value={derived.water.length} tone={derived.water.length ? 'warn' : 'good'} sub={`${s.water.urgent} to clear within 2 days`} />
          <Kpi label="Radar, latest pass" value={`${(derived.radar[derived.radar.length - 1]?.ha ?? 0).toFixed(1)} ha`} sub={derived.radar.length ? `new water on ${derived.radar[derived.radar.length - 1].day}` : 'no pass'} />
          <Kpi label="Sites to inspect" value={derived.cands.filter((c) => !['health', 'school'].includes(c.cat)).length} sub="mapped in OpenStreetMap" />
          <Kpi label="Ponds and drains" value={(s.candidates.pond ?? 0) + (s.candidates.drain ?? 0)} sub={`${s.candidates.pond ?? 0} ponds · ${s.candidates.drain ?? 0} drain segments`} />
          <Kpi label="Field tasks" value={`${s.openTasks} open`} sub={`${s.overdueTasks} overdue`} tone={s.overdueTasks ? 'warn' : 'default'} />
        </div>
      ) : (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Cases last week" value={s.weekly[n - 1]} sub={<Trend now={s.weekly[n - 1]} before={s.weekly[n - 2]} />} />
        <Kpi label="Cases this year" value={s.ytd} sub={`${(s.ytd / w.population * 1e4).toFixed(1)} per 10,000`} />
        <Kpi label="Breteau Index" value={fmt1(s.bi)} tone={s.bi != null && s.bi >= a.config.alerts.breteauHigh ? 'bad' : 'default'} sub={`House Index ${fmt1(s.hi)}% · last 2 weeks`} />
        <Kpi label="Open breeding sites" value={s.openSites} tone={s.openSites > 5 ? 'warn' : 'default'} />
        <Kpi label="Field tasks" value={`${s.openTasks} open`} sub={`${s.overdueTasks} overdue`} tone={s.overdueTasks ? 'warn' : 'default'} />
        <Kpi label="Forecast, next 4 weeks" value={s.risk.forecast.reduce((x, f) => x + f.mean, 0).toFixed(0)} sub="expected cases" />
      </div>
      )}

      {noCases ? (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <Card title={`Why ward ${ward} scores ${pv.score}`} subtitle={`Each factor ranked against all 144 wards (0–100) · ${pv.version} · no case data used`}>
            <PreventionBars comps={pv.components} />
          </Card>
          <Card title="Radar: new water in this ward, pass by pass" subtitle="Sentinel-1, compared with the dry-season pass of the same orbit">
            {derived.radar.length === 0 ? <Empty>No processed radar pass yet.</Empty> : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={derived.radar} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="#E2E8F0" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#475569' }} interval={Math.max(0, Math.ceil(derived.radar.length / 8) - 1)} />
                  <YAxis tick={{ fontSize: 11, fill: '#475569' }} />
                  <RTooltip contentStyle={{ fontSize: 12 }} formatter={(v: number) => [`${v} ha`, 'New water']} />
                  <Bar isAnimationActive={false} dataKey="ha" fill="#0B5F59" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </div>
      ) : (
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Cases and 4-week forecast" subtitle="Bars: confirmed cases by week · dashed line and band: forecast with 90% range">
          <ForecastChart weeks={a.completeWeeks} cases={s.weekly} forecast={s.risk.forecast} />
        </Card>
        <Card title="Why this ward's risk is what it is" subtitle={`Contribution of each factor to the risk score · model ${s.risk.modelVersion}`}>
          <DriverBars drivers={s.risk.drivers} height={260} />
        </Card>
      </div>
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3" title="Ward map" subtitle={`Water spots by days left (dark red past window, red ≤ 2, amber ≤ 5, green later)${noCases ? ' · small squares: sites to inspect (OpenStreetMap)' : ' · purple: recent cases · dashed ring: case cluster'}`}
          action={<div className="flex gap-1">
            {noCases && <button onClick={() => setShowSites(!showSites)} className={`rounded-md border px-2 py-1 text-xs ${showSites ? 'border-kmc-600 bg-kmc-600 text-white' : 'border-slate-300 text-slate-600'}`}>Sites</button>}
            {pub && <button onClick={() => setImagery(!imagery)} className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">{imagery ? 'Street map' : 'Aerial photo'}</button>}
          </div>}>
          <WardMap stats={a.stats} wards={db.wards.filter((x) => x.ward === ward || w.neighbours.includes(x.ward))} focusWards={[ward]} highlight={ward}
            metric={noCases ? 'prevention' : 'risk'} noCases={noCases} basemap={pub ? (imagery ? 'imagery' : 'streets') : 'none'} wardOpacity={imagery ? 0.12 : undefined}
            points={derived.points} circles={derived.clusterCircles} height={420} />
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

      <Card className="mt-4" title={`Standing water — ${derived.water.length} active spot${derived.water.length === 1 ? '' : 's'}`}
        subtitle={`Clear each before Aedes can emerge (about ${a.devDays} days at ${a.meanTempC.toFixed(1)} °C)`} action={<a href={href.water} className="text-sm font-medium text-kmc-700">All water spots →</a>}>
        {derived.water.length === 0 ? <Empty>No active standing-water spots in this ward.</Empty> : (
          <Table head={['Clear by', 'What', 'Found by', 'Status', '']}>
            {derived.water.map((d) => (
              <tr key={d.id} className="align-top">
                <td className="px-2 py-2"><ClearBy left={daysLeft(d, db.asOf, a.meanTempC)} /></td>
                <td className="px-2 py-2"><div className="font-medium">{d.kind}</div>{d.ai?.recommendedAction && <div className="text-xs text-slate-500">{d.ai.recommendedAction}</div>}</td>
                <td className="px-2 py-2 text-xs">{d.source}{d.sensor ? ` · ${d.sensor}` : ''} · {Math.round(d.confidence * 100)}%</td>
                <td className="px-2 py-2"><Pill tone={d.status === 'New' ? 'slate' : 'amber'}>{d.status === 'New' ? 'Not checked' : d.status}</Pill></td>
                <td className="px-2 py-2"><SpotActions d={d} compact /></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {noCases && derived.cands.length > 0 && (
        <Card className="mt-4" title={`Sites to inspect — ${derived.cands.filter((c) => !['health', 'school'].includes(c.cat)).length} mapped in OpenStreetMap`}
          subtitle="Places that commonly hold water. Not confirmed breeding sites: a team visit decides." >
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            {Object.entries(s.candidates).sort((x, y) => y[1] - x[1]).map(([k, n]) => (
              <span key={k} className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: CAT_COLOR[k] }} />{pub?.osm?.categories?.[k] ?? k}: <b>{n}</b></span>
            ))}
          </div>
          <Table head={['Type', 'Name', 'Location', '']}>
            {derived.cands.filter((c) => ['tyres', 'scrap', 'construction', 'vehicle', 'market', 'nursery', 'vacant', 'depot'].includes(c.cat)).slice(0, 25).map((c) => (
              <tr key={c.id}>
                <td className="px-2 py-1.5">{pub?.osm?.categories?.[c.cat] ?? c.cat}</td>
                <td className="px-2 py-1.5">{c.name || <span className="text-slate-400">unnamed</span>}</td>
                <td className="px-2 py-1.5 text-xs tabular-nums"><a className="text-kmc-700" href={`https://www.openstreetmap.org/${c.id[0] === 'n' ? 'node' : c.id[0] === 'w' ? 'way' : 'relation'}/${c.id.slice(1)}`} target="_blank" rel="noreferrer">{c.lat.toFixed(5)}, {c.lng.toFixed(5)}</a></td>
                <td className="px-2 py-1.5">{editable && <Button small variant="secondary" onClick={async () => {
                  await addTask({ ward, type: c.cat === 'construction' ? 'Construction site inspection' : 'Source reduction drive', title: `Inspect ${(pub?.osm?.categories?.[c.cat] ?? c.cat).toLowerCase()}${c.name ? `: ${c.name}` : ''}`, priority: 'P2', status: 'Open', dueAt: new Date(Date.now() + 72 * 3600000).toISOString(), source: 'Manual', team: db.teams[ward]?.[0] ?? `VCT-${ward}-A`, notes: `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} (OSM ${c.id})` });
                  notify('Inspection task created');
                }}>Inspect</Button>}</td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-[11px] text-slate-500">© OpenStreetMap contributors (ODbL). Field teams can add missing sites; KMC's trade-licence list (tyre, scrap and garage licences) would complete it.</p>
        </Card>
      )}

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
          {scope.role === 'councillor' ? <Empty>Case details are restricted to health officers. Weekly counts appear in the charts above.</Empty> : noCases ? <Empty>Waiting for KMC's case feed (detection centres, labs, IHIP). Cases can also be entered or imported under Case reporting.</Empty> : derived.cases.length === 0 ? <Empty>No cases in the last 4 weeks.</Empty> : (
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
