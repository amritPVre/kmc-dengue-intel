import { useMemo } from 'react';
import { Copy, Printer } from 'lucide-react';
import { useData, useScopedWards } from '@/lib/store';
import { boroughSummary, LEVEL_ORDER } from '@/lib/analytics';
import { BOROUGHS } from '@/lib/types';
import { fmt1, fmtDate, fmtWeek } from '@/lib/util';
import { PageHeader } from '@/components/Layout';
import { Button, Card, RiskBadge, Table } from '@/components/ui';

/** Auto-generated situation report for the user's scope, ready to paste into email or WhatsApp. */
export function SitRep() {
  const { db, a, scope, notify } = useData();
  const wards = useScopedWards();
  const r = useMemo(() => {
    if (!db || !a) return null;
    const set = new Set(wards.map((w) => w.ward));
    const stats = [...a.stats.values()].filter((s) => set.has(s.ward));
    const n = a.completeWeeks.length;
    const sumW = (k: number) => stats.reduce((x, s) => x + (s.weekly[n - 1 - k] ?? 0), 0);
    const lastWeek = sumW(0), prevWeek = sumW(1);
    const ytd = stats.reduce((x, s) => x + s.ytd, 0);
    const high = stats.filter((s) => LEVEL_ORDER[s.risk.level] >= 2).sort((x, y) => y.risk.score - x.risk.score);
    const alerts = db.alerts.filter((x) => set.has(x.ward) && x.status !== 'Closed');
    const tasks = db.tasks.filter((t) => set.has(t.ward));
    const open = tasks.filter((t) => t.status === 'Open' || t.status === 'In progress');
    const overdue = open.filter((t) => Date.parse(t.dueAt) < Date.now());
    const week = a.completeWeeks[n - 1];
    const scopeName = scope.role === 'hq' ? 'Kolkata Municipal Corporation (all 16 boroughs)' : scope.role === 'borough' ? `Borough ${scope.borough}` : `Ward ${scope.ward}`;
    const boroughRows = scope.role === 'hq' ? BOROUGHS.map((b) => boroughSummary(a, b)) : [];
    const change = prevWeek ? Math.round(((lastWeek - prevWeek) / prevWeek) * 100) : 0;
    const text = [
      `DENGUE SITUATION REPORT — ${scopeName}`,
      `Prepared ${fmtDate(db.asOf)} · reporting week ${fmtWeek(week)}${db.mode === 'demo' ? ' · DEMO DATA (synthetic)' : ''}`,
      '',
      `1. Cases: ${lastWeek} confirmed last week (${prevWeek} the week before, ${change >= 0 ? '+' : ''}${change}%). ${ytd} so far this year.`,
      `2. Risk outlook (2–4 weeks): ${high.length} ward(s) at high or very high risk${high.length ? ': ' + high.slice(0, 10).map((s) => `${s.ward} (${s.risk.score})`).join(', ') : ''}.`,
      `3. Alerts open: ${alerts.length} — ${['cluster', 'exceedance', 'entomological', 'predicted'].map((t) => `${alerts.filter((x) => x.type === t).length} ${t}`).join(', ')}.`,
      `4. Field response: ${open.length} tasks open, ${overdue.length} overdue.`,
      `5. Larval surveillance: mean Breteau Index ${fmt1(stats.filter((s) => s.bi != null).reduce((x, s) => x + (s.bi ?? 0), 0) / Math.max(1, stats.filter((s) => s.bi != null).length))}; ${stats.filter((s) => (s.bi ?? 0) >= a.config.alerts.breteauHigh).length} ward(s) at or above BI ${a.config.alerts.breteauHigh}.`,
      '',
      'Priority actions for this week:',
      ...(high.length ? high.slice(0, 5).map((s) => `- Ward ${s.ward}: ${s.risk.drivers.slice(0, 2).map((d) => d.label.toLowerCase()).join('; ')}`) : ['- Continue routine weekly surveillance.']),
      ...(overdue.length ? [`- Clear ${overdue.length} overdue field task(s).`] : []),
    ].join('\n');
    return { text, high, boroughRows, lastWeek, prevWeek, alerts, overdue, scopeName, week };
  }, [db, a, wards, scope]);
  if (!r || !db) return null;
  return (
    <>
      <PageHeader title="Situation report" subtitle={`${r.scopeName} · week ${fmtWeek(r.week)}`}
        actions={<>
          <Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(r.text); notify('Report copied'); } catch { notify('Copy blocked here: select the text and copy manually'); } }}><Copy size={15} /> Copy text</Button>
          <Button variant="secondary" onClick={() => { try { window.print(); } catch { notify('Printing is not available in this preview'); } }}><Printer size={15} /> Print</Button>
        </>} />
      <Card title="Summary (plain text for email or WhatsApp)">
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 font-mono text-[13px] leading-relaxed text-slate-800">{r.text}</pre>
      </Card>
      {r.boroughRows.length > 0 && (
        <Card className="mt-4" title="Borough table">
          <Table head={['Borough', 'Cases last 2 wks', 'Previous 2 wks', 'This year', 'High-risk wards', 'Mean BI', 'Overdue tasks']}>
            {r.boroughRows.map((b) => (
              <tr key={b.borough}>
                <td className="px-2 py-1.5 font-medium">Borough {b.borough}</td><td className="px-2 py-1.5">{b.last2w}</td><td className="px-2 py-1.5">{b.prev2w}</td>
                <td className="px-2 py-1.5">{b.ytd}</td><td className="px-2 py-1.5">{b.highRisk}</td><td className="px-2 py-1.5">{fmt1(b.meanBi)}</td><td className="px-2 py-1.5">{b.overdueTasks}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      <Card className="mt-4" title="Wards needing attention">
        {r.high.length === 0 ? <p className="text-sm text-slate-600">No ward is at high risk.</p> : (
          <Table head={['Ward', 'Risk', 'Cases last 2 wks', 'Top drivers']}>
            {r.high.slice(0, 15).map((s) => (
              <tr key={s.ward}><td className="px-2 py-1.5 font-medium">Ward {s.ward}</td><td className="px-2 py-1.5"><RiskBadge level={s.risk.level} score={s.risk.score} /></td><td className="px-2 py-1.5">{s.last2w}</td><td className="px-2 py-1.5 text-xs">{s.risk.drivers.slice(0, 3).map((d) => d.label).join(' · ')}</td></tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
