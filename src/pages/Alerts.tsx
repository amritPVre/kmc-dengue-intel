import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { SOP } from '@shared/risk-engine';
import { canEdit, useData, useScopedWards } from '@/lib/store';
import type { Alert } from '@/lib/types';
import { fmtDateTime } from '@/lib/util';
import { href } from '@/lib/router';
import { PageHeader } from '@/components/Layout';
import { Button, Card, Empty, Pill, inputCls } from '@/components/ui';
import { ALERT_TONE } from './Overview';

const TYPE_LABEL: Record<Alert['type'], string> = {
  cluster: 'Case cluster', exceedance: 'Cases above expected', entomological: 'Larval density', predicted: 'Predicted risk', water: 'Standing water',
};

export function Alerts() {
  const { db, scope, actionAlert, setAlertStatus, runAlerting, notify } = useData();
  const wards = useScopedWards();
  const [status, setStatus] = useState<'open' | 'all' | Alert['status']>('open');
  const [type, setType] = useState<'all' | Alert['type']>('all');
  const [busy, setBusy] = useState(false);
  const wardSet = useMemo(() => new Set(wards.map((w) => w.ward)), [wards]);
  const list = useMemo(() => (db ? db.alerts.filter((x) =>
    wardSet.has(x.ward) &&
    (status === 'all' || (status === 'open' ? x.status !== 'Closed' : x.status === status)) &&
    (type === 'all' || x.type === type)) : []), [db, wardSet, status, type]);
  if (!db) return null;
  const editable = canEdit(scope.role);
  const taskCount = (id: string) => db.tasks.filter((t) => t.alertId === id).length;

  return (
    <>
      <PageHeader title="Alerts" subtitle="Generated every Monday at 09:00 from case reports, larval surveys, clusters and the risk model — or on demand"
        actions={editable && scope.role !== 'field' ? (
          <Button disabled={busy} onClick={async () => { setBusy(true); const k = await runAlerting(); setBusy(false); notify(k ? `${k} new alerts raised` : 'No new signals since the last run'); }}>
            <RefreshCw size={15} /> Run alerting now
          </Button>
        ) : undefined} />
      <div className="mb-3 flex flex-wrap gap-2">
        <select className={`${inputCls} w-auto`} value={status} onChange={(e) => setStatus(e.target.value as never)} aria-label="Status">
          <option value="open">Open (new + acknowledged)</option><option value="New">New</option><option value="Acknowledged">Acknowledged</option><option value="Closed">Closed</option><option value="all">All</option>
        </select>
        <select className={`${inputCls} w-auto`} value={type} onChange={(e) => setType(e.target.value as never)} aria-label="Type">
          <option value="all">All types</option>
          {(Object.keys(TYPE_LABEL) as Alert['type'][]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <span className="self-center text-sm text-slate-600">{list.length} alerts</span>
      </div>
      {list.length === 0 ? <Empty>No alerts match these filters.</Empty> : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.slice(0, 120).map((x) => {
            const w = db.wards.find((y) => y.ward === x.ward);
            const n = taskCount(x.id);
            return (
              <Card key={x.id} title={<span className="flex flex-wrap items-center gap-2"><Pill tone={ALERT_TONE[x.level]}>{x.level}</Pill><Pill tone="teal">{TYPE_LABEL[x.type]}</Pill><a className="text-kmc-700" href={href.ward(x.ward)}>Ward {x.ward}</a><span className="text-xs font-normal text-slate-500">Borough {w?.borough}</span></span>}
                subtitle={`${fmtDateTime(x.createdAt)} · ${x.status}${n ? ` · ${n} tasks assigned` : ''}`}>
                <p className="font-medium">{x.title}</p>
                <p className="mt-1 text-sm text-slate-600">{x.detail}</p>
                <details className="mt-2 text-xs text-slate-600">
                  <summary className="cursor-pointer text-kmc-700">Playbook for this alert</summary>
                  <ul className="mt-1 list-disc pl-5">{SOP[x.type].map((t) => <li key={t.title}>{t.title} — within {t.slaHours} h ({t.priority})</li>)}</ul>
                </details>
                {editable && x.status !== 'Closed' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {n === 0 && <Button small onClick={async () => { const k = await actionAlert(x); notify(`${k} tasks assigned to ward ${x.ward}`); }}>Assign playbook tasks</Button>}
                    {x.status === 'New' && <Button small variant="secondary" onClick={() => setAlertStatus(x.id, 'Acknowledged')}>Acknowledge</Button>}
                    <Button small variant="ghost" onClick={() => setAlertStatus(x.id, 'Closed')}>Close</Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
