import { useMemo, useState } from 'react';
import { CheckCircle2, Clock, Play, ShieldCheck } from 'lucide-react';
import { canEdit, useData, useScopedWards } from '@/lib/store';
import type { FieldTask, TaskStatus } from '@/lib/types';
import { fmtDateTime } from '@/lib/util';
import { href } from '@/lib/router';
import { PageHeader } from '@/components/Layout';
import { Button, Card, Empty, Pill, inputCls } from '@/components/ui';
import { SiteForm, SurveyForm, TaskForm } from './forms';

const STATUSES: TaskStatus[] = ['Open', 'In progress', 'Done', 'Verified'];
const NEXT: Partial<Record<TaskStatus, { to: TaskStatus; label: string; icon: JSX.Element }>> = {
  Open: { to: 'In progress', label: 'Start', icon: <Play size={13} /> },
  'In progress': { to: 'Done', label: 'Mark done', icon: <CheckCircle2 size={13} /> },
  Done: { to: 'Verified', label: 'Verify', icon: <ShieldCheck size={13} /> },
};
const isOverdue = (t: FieldTask) => (t.status === 'Open' || t.status === 'In progress') && Date.parse(t.dueAt) < Date.now();

export function TaskCard({ t }: { t: FieldTask }) {
  const { scope, setTaskStatus, notify } = useData();
  const next = NEXT[t.status];
  // field teams start and complete; supervisors (ward/borough/HQ) verify
  const allowed = canEdit(scope.role) && next && !(next.to === 'Verified' && scope.role === 'field');
  const overdue = isOverdue(t);
  return (
    <div className={`rounded-lg border bg-white p-3 text-sm shadow-sm ${overdue ? 'border-amber-400' : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium leading-snug">{t.title}</span>
        <Pill tone={t.priority === 'P1' ? 'red' : t.priority === 'P2' ? 'amber' : 'slate'}>{t.priority}</Pill>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-slate-500">
        <a href={href.ward(t.ward)} className="font-medium text-kmc-700">Ward {t.ward}</a>
        <span>{t.team}</span>
        <span>{t.source === 'Alert' ? 'from alert' : t.source.toLowerCase()}</span>
      </div>
      <div className={`mt-1 flex items-center gap-1 text-xs ${overdue ? 'font-semibold text-amber-700' : 'text-slate-600'}`}>
        <Clock size={12} /> {t.completedAt ? `Completed ${fmtDateTime(t.completedAt)}` : `${overdue ? 'Overdue — was due' : 'Due'} ${fmtDateTime(t.dueAt)}`}
      </div>
      {allowed && (
        <div className="mt-2">
          <Button small variant="secondary" onClick={async () => { await setTaskStatus(t.id, next.to); notify(`Task moved to ${next.to}`); }}>{next.icon}{next.label}</Button>
        </div>
      )}
    </div>
  );
}

export function TaskList({ tasks, compact }: { tasks: FieldTask[]; compact?: boolean }) {
  if (!tasks.length) return <Empty>No tasks.</Empty>;
  return <div className={`grid gap-2 ${compact ? '' : 'sm:grid-cols-2'}`}>{tasks.map((t) => <TaskCard key={t.id} t={t} />)}</div>;
}

export function FieldOps() {
  const { db, scope } = useData();
  const wards = useScopedWards();
  const [ward, setWard] = useState<number | 'all'>(scope.role === 'hq' || scope.role === 'borough' ? 'all' : scope.ward);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [modal, setModal] = useState<'survey' | 'site' | 'task' | null>(null);
  const wardSet = useMemo(() => new Set(wards.map((w) => w.ward)), [wards]);
  const tasks = useMemo(() => {
    if (!db) return [];
    return db.tasks
      .filter((t) => wardSet.has(t.ward) && (ward === 'all' || t.ward === ward) && (!overdueOnly || isOverdue(t)))
      .filter((t) => t.status !== 'Verified' || Date.now() - Date.parse(t.completedAt ?? t.createdAt) < 14 * 86400000)
      .sort((x, y) => (isOverdue(y) ? 1 : 0) - (isOverdue(x) ? 1 : 0) || x.priority.localeCompare(y.priority) || x.dueAt.localeCompare(y.dueAt));
  }, [db, wardSet, ward, overdueOnly]);
  if (!db) return null;
  const formWard = ward === 'all' ? wards[0]?.ward ?? 1 : ward;
  const counts = STATUSES.map((s) => tasks.filter((t) => t.status === s).length);
  const field = scope.role === 'field';

  return (
    <>
      <PageHeader
        title={field ? `Today's work — Ward ${scope.ward}` : 'Field operations'}
        subtitle={field ? 'Start a task when you reach the site; mark it done with the survey or site report.' : 'Tasks from alerts, citizen reports and manual assignment, by status'}
        actions={canEdit(scope.role) ? <>
          <Button variant="secondary" onClick={() => setModal('survey')}>Log larval survey</Button>
          <Button variant="secondary" onClick={() => setModal('site')}>Report breeding site</Button>
          {!field && <Button onClick={() => setModal('task')}>New task</Button>}
        </> : undefined}
      />
      {!field && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select className={`${inputCls} w-auto`} value={ward} onChange={(e) => setWard(e.target.value === 'all' ? 'all' : Number(e.target.value))} aria-label="Filter by ward">
            <option value="all">All wards in scope ({wards.length})</option>
            {wards.map((w) => <option key={w.ward} value={w.ward}>Ward {w.ward}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only</label>
          <span className="text-xs text-slate-500">{tasks.filter(isOverdue).length} overdue</span>
        </div>
      )}
      {field ? (
        <div className="space-y-4">
          {(['In progress', 'Open'] as TaskStatus[]).map((s) => (
            <Card key={s} title={s === 'Open' ? 'To do' : 'In progress'}><TaskList tasks={tasks.filter((t) => t.status === s)} compact /></Card>
          ))}
          <Card title="Completed (awaiting supervisor check)"><TaskList tasks={tasks.filter((t) => t.status === 'Done')} compact /></Card>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {STATUSES.map((s, i) => (
            <div key={s} className="rounded-xl bg-slate-100 p-2">
              <div className="mb-2 flex items-center justify-between px-1 text-sm font-semibold"><span>{s}</span><span className="text-slate-500">{counts[i]}</span></div>
              <div className="max-h-[70vh] space-y-2 overflow-y-auto">
                {tasks.filter((t) => t.status === s).slice(0, 60).map((t) => <TaskCard key={t.id} t={t} />)}
                {counts[i] > 60 && <p className="px-1 text-xs text-slate-500">+{counts[i] - 60} more — filter by ward to see all</p>}
                {counts[i] === 0 && <p className="px-1 py-4 text-center text-xs text-slate-400">None</p>}
              </div>
            </div>
          ))}
        </div>
      )}
      <SurveyForm open={modal === 'survey'} onClose={() => setModal(null)} ward={formWard} />
      <SiteForm open={modal === 'site'} onClose={() => setModal(null)} ward={formWard} />
      <TaskForm open={modal === 'task'} onClose={() => setModal(null)} ward={formWard} />
    </>
  );
}
