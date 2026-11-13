import { useMemo, useState } from 'react';
import { canEdit, useData, useScopedWards } from '@/lib/store';
import type { CitizenReport } from '@/lib/types';
import { fmtDateTime } from '@/lib/util';
import { href } from '@/lib/router';
import { PageHeader } from '@/components/Layout';
import { Button, Card, Empty, Pill } from '@/components/ui';
import { TaskForm } from './forms';

export function Citizen() {
  const { db, scope, setCitizenStatus } = useData();
  const wards = useScopedWards();
  const [task, setTask] = useState<CitizenReport | null>(null);
  const wardSet = useMemo(() => new Set(wards.map((w) => w.ward)), [wards]);
  if (!db) return null;
  const list = db.citizen.filter((c) => wardSet.has(c.ward));
  return (
    <>
      <PageHeader title="Citizen reports" subtitle="Complaints about stagnant water, garbage and fever clusters. Intake channels planned: WhatsApp bot, KMC app and helpline." />
      {list.length === 0 ? <Empty>No citizen reports in your area.</Empty> : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Pill tone={c.kind === 'Fever in neighbourhood' ? 'red' : 'amber'}>{c.kind}</Pill>
                <a className="font-semibold text-kmc-700" href={href.ward(c.ward)}>Ward {c.ward}</a>
                <span className="text-xs text-slate-500">{fmtDateTime(c.reportedAt)}</span>
                <span className="ml-auto"><Pill tone={c.status === 'Resolved' ? 'green' : c.status === 'New' ? 'slate' : 'blue'}>{c.status}</Pill></span>
              </div>
              <p className="mt-2 text-sm text-slate-700">“{c.text}”</p>
              {canEdit(scope.role) && c.status !== 'Resolved' && (
                <div className="mt-3 flex gap-2">
                  {c.status === 'New' && <Button small onClick={() => setTask(c)}>Create field task</Button>}
                  <Button small variant="ghost" onClick={() => setCitizenStatus(c.id, 'Resolved')}>Mark resolved</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      <TaskForm open={!!task} ward={task?.ward ?? 1} preset={task ? { title: `Citizen report: ${task.kind.toLowerCase()} — inspect and clear`, source: 'Citizen' } : undefined}
        onSaved={() => { if (task) setCitizenStatus(task.id, 'Task created'); }} onClose={() => setTask(null)} />
    </>
  );
}
