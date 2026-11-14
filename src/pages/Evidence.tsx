import { useMemo } from 'react';
import { aucNamed } from '@shared/prevention';
import reports from '@/data/public-reports.json';
import { useData } from '@/lib/store';
import { BOROUGHS } from '@/lib/types';
import { fmtDate, fmtInt } from '@/lib/util';
import { href } from '@/lib/router';
import { PageHeader } from '@/components/Layout';
import { Card, Empty, Kpi, Pill, Table } from '@/components/ui';

/** Spearman rank correlation. */
function spearman(x: number[], y: number[]): number | null {
  if (x.length < 4) return null;
  const rank = (v: number[]) => { const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); o.forEach(([, i], k) => { r[i] = k; }); return r as number[]; };
  const rx = rank(x), ry = rank(y);
  const n = x.length;
  const d2 = rx.reduce((s, r, i) => s + (r - ry[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const verdict = (auc: number | null) => auc == null ? <Pill>—</Pill> : auc >= 0.7 ? <Pill tone="green">Strong match</Pill> : auc >= 0.6 ? <Pill tone="teal">Moderate match</Pill> : auc > 0.52 ? <Pill tone="amber">Weak match</Pill> : <Pill tone="red">No match</Pill>;

export function Evidence() {
  const { db, a, pub } = useData();
  const v = useMemo(() => {
    if (!db || !a) return null;
    const structural = new Map([...a.prevention.entries()].map(([w, p]) => [w, p.structural]));
    const rows = reports.dengueHotspotReports.map((r) => {
      const named = new Set<number>(r.wards.length ? r.wards : db.wards.filter((w) => (r as { boroughList?: string[] }).boroughList?.includes(w.borough)).map((w) => w.ward));
      const res = aucNamed(structural, named);
      const pcts = [...named].map((w) => structural.get(w)).filter((x): x is number => x != null);
      const rankOf = (w: number) => [...structural.values()].filter((x) => x > (structural.get(w) ?? 0)).length + 1;
      return { r, named, ...res, topThird: [...named].filter((w) => rankOf(w) <= Math.ceil(structural.size / 3)).length, mean: pcts.length ? pcts.reduce((x, y) => x + y, 0) / pcts.length : null };
    });
    const union = new Set<number>(reports.dengueHotspotReports.flatMap((r) => r.wards));
    const overall = aucNamed(structural, union);
    // borough-level: 2022 week-42 counts vs mean structural score of the borough
    const b42 = reports.dengueHotspotReports[0].boroughs as Record<string, number>;
    const bs = BOROUGHS.filter((b) => b42[b] != null);
    const bMean = bs.map((b) => { const ws = db.wards.filter((w) => w.borough === b).map((w) => structural.get(w.ward) ?? 0); return ws.reduce((x, y) => x + y, 0) / ws.length; });
    const rho = spearman(bMean, bs.map((b) => b42[b]));
    const ranked = [...structural.entries()].sort((x, y) => y[1] - x[1]);
    return { rows, union, overall, rho, bs, bMean, b42, ranked };
  }, [db, a]);
  if (!db || !a || !v) return null;
  const landReady = Boolean(pub?.landscape?.worldcover?.wards && pub?.osm?.points?.length);
  const hs = pub?.landscape?.hotspots;

  return (
    <>
      <PageHeader title="Evidence check"
        subtitle="Does the prevention index — built only from satellite, map, census and weather data — point at the wards that KMC and the press have named as dengue hotspots? The index never sees these reports, so this is an independent check." />
      {!landReady && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Land cover or OpenStreetMap layers are still loading; results below will change when they arrive.</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Wards named in reports" value={v.union.size} sub={`in ${reports.dengueHotspotReports.length} public reports, 2022–2025`} />
        <Kpi label="Match (all reports)" value={v.overall.auc == null ? '—' : v.overall.auc.toFixed(2)} tone={v.overall.auc != null && v.overall.auc >= 0.6 ? 'good' : 'warn'} sub="0.5 = chance · 1.0 = perfect (ROC AUC)" />
        <Kpi label="Borough check (2022)" value={v.rho == null ? '—' : v.rho.toFixed(2)} tone={v.rho != null && v.rho >= 0.4 ? 'good' : 'warn'} sub="rank correlation with reported cases" />
        <Kpi label="Case data used" value="None" tone="good" sub="ward cases are only in KMC's records" />
      </div>

      <Card className="mt-4" title="Report by report" subtitle="AUC: the chance that a ward named in the report scores higher on the structural index than a ward not named">
        <Table head={['Report', 'Named', 'In top third', 'AUC', '']}>
          {v.rows.map(({ r, named, auc, topThird }) => (
            <tr key={r.id} className="align-top">
              <td className="px-2 py-2">
                <a className="font-medium text-kmc-700 hover:underline" href={r.url} target="_blank" rel="noreferrer">{r.title}</a>
                <div className="text-xs text-slate-500">{r.publisher}{r.date ? `, ${fmtDate(r.date)}` : ' (undated)'}</div>
                <div className="mt-0.5 text-xs text-slate-600">{r.claim}</div>
              </td>
              <td className="px-2 py-2 text-xs">{r.wards.length ? r.wards.map((w) => <a key={w} href={href.ward(w)} className="mr-1 text-kmc-700">{w}</a>) : `${named.size} wards (boroughs ${(r as { boroughList?: string[] }).boroughList?.join(', ')})`}</td>
              <td className="px-2 py-2 tabular-nums">{topThird} / {named.size}</td>
              <td className="px-2 py-2 tabular-nums">{auc == null ? '—' : auc.toFixed(2)}</td>
              <td className="px-2 py-2">{verdict(auc)}</td>
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-xs text-slate-500">Reports name the wards with the most cases, which also depends on testing and reporting, so a perfect match is not expected. The real test is against KMC's ward-level case records, which would also let the weights be fitted instead of set by hand.</p>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Borough check — week 42 of 2022" subtitle="New cases reported by the state health department vs the borough's average structural index">
          <Table head={['Borough', 'New cases (week 42)', 'Structural index']}>
            {v.bs.map((b, i) => ({ b, c: v.b42[b], s: v.bMean[i] })).sort((x, y) => y.c - x.c).map(({ b, c, s }) => (
              <tr key={b}><td className="px-2 py-1.5 font-medium"><a className="text-kmc-700" href={href.borough(b)}>{b}</a></td><td className="px-2 py-1.5 tabular-nums">{fmtInt(c)}</td>
                <td className="px-2 py-1.5"><span className="inline-block h-2 rounded bg-kmc-600 align-middle" style={{ width: `${Math.round(s * 120)}px` }} /> <span className="ml-1 text-xs tabular-nums">{s.toFixed(2)}</span></td></tr>
            ))}
          </Table>
        </Card>
        <Card title="What KMC and the state have published" subtitle="Public dengue numbers for context">
          <ul className="space-y-2 text-sm">
            {reports.cityTotals.map((t) => (
              <li key={t.period}><b className="tabular-nums">{fmtInt(t.cases)}</b> dengue cases in KMC, {t.period} <span className="text-xs text-slate-500">— {t.source}, <a className="underline" href={t.url} target="_blank" rel="noreferrer">{t.publisher}</a></span></li>
            ))}
            {reports.stateTotals.map((t) => (
              <li key={t.period}><b className="tabular-nums">{fmtInt(t.cases)}</b> cases in West Bengal {t.period}, against {fmtInt(t.previous)} in the {t.previousPeriod} <span className="text-xs text-slate-500">— {t.source}, <a className="underline" href={t.url} target="_blank" rel="noreferrer">{t.publisher}</a></span></li>
            ))}
            <li>{reports.context2026.text} <span className="text-xs text-slate-500">— <a className="underline" href={reports.context2026.url} target="_blank" rel="noreferrer">{reports.context2026.publisher}</a>, {fmtDate(reports.context2026.date)}</span></li>
          </ul>
          <p className="mt-3 text-xs text-slate-500">Ward-level case numbers are not published anywhere. With KMC's records, this page becomes a proper back-test: train on 2023–2024, predict 2025, compare.</p>
        </Card>
      </div>

      <Card className="mt-4" title="Waterlogging pockets named by KMC and the press" subtitle="Used by the rain trigger: when 40 mm or more falls on a borough, its pockets become water spots to check">
        {!hs ? <Empty>Loading the geocoded list…</Empty> : (
          <Table head={['Place', 'Ward', 'Located as', 'Reported by']}>
            {hs.places.map((p) => (
              <tr key={p.name} className="align-top">
                <td className="px-2 py-1.5 font-medium">{p.name}</td>
                <td className="px-2 py-1.5">{p.ward ? <a className="text-kmc-700" href={href.ward(p.ward)}>{p.ward}</a> : <span className="text-xs text-slate-400">not found</span>}</td>
                <td className="px-2 py-1.5 text-xs text-slate-500">{p.matched ?? '—'}</td>
                <td className="px-2 py-1.5 text-xs">{p.sources.map((s) => { const src = hs.sources[s]; return src ? <a key={s} className="mr-2 underline" href={src.url} target="_blank" rel="noreferrer">{src.publisher}{src.date ? ` ${src.date.slice(0, 4)}` : ''}</a> : null; })}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
