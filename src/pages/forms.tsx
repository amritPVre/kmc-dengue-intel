import { useEffect, useState, type FormEvent } from 'react';
import { indices, SOP, type TaskType } from '@shared/risk-engine';
import geo from '@/data/wards.geo.json';
import { useData } from '@/lib/store';
import type { SiteType } from '@/lib/types';
import { pointInGeom, todayIso } from '@/lib/util';
import { Button, Field, Modal, inputCls } from '@/components/ui';

export function WardSelect({ value, onChange }: { value: number; onChange: (w: number) => void }) {
  const { db, scope } = useData();
  if (!db) return null;
  const wards = scope.role === 'hq' ? db.wards : scope.role === 'borough' ? db.wards.filter((w) => w.borough === scope.borough) : db.wards.filter((w) => w.ward === scope.ward);
  return (
    <select className={inputCls} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {wards.map((w) => <option key={w.ward} value={w.ward}>Ward {w.ward} · Borough {w.borough}</option>)}
    </select>
  );
}

type Feat = { properties: { ward: number }; geometry: { type: string; coordinates: unknown } };
/** Finds the ward containing a point (used when a lab or field worker enters coordinates). */
export function wardAt(lng: number, lat: number): number | null {
  for (const f of (geo as unknown as { features: Feat[] }).features) if (pointInGeom(lng, lat, f.geometry)) return f.properties.ward;
  return null;
}

export function SurveyForm({ open, onClose, ward }: { open: boolean; onClose: () => void; ward: number }) {
  const { db, addSurvey, notify } = useData();
  const [f, setF] = useState({ ward, date: todayIso(), team: '', housesVisited: 200, housesPositive: 0, containersInspected: 300, containersPositive: 0, notes: '' });
  useEffect(() => { if (open) setF((x) => ({ ...x, ward, team: db?.teams[ward]?.[0] ?? '' })); }, [open, ward, db]);
  const idx = indices(f.housesVisited, f.housesPositive, f.containersInspected, f.containersPositive);
  const invalid = f.housesPositive > f.housesVisited || f.containersPositive > f.containersInspected || f.housesVisited <= 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    await addSurvey({ ...f, notes: f.notes || undefined });
    notify(`Survey saved for ward ${f.ward}: BI ${idx.BI.toFixed(1)}, HI ${idx.HI.toFixed(1)}%`);
    onClose();
  };
  const num = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Math.max(0, Number(e.target.value)) });
  return (
    <Modal open={open} onClose={onClose} title="Log larval survey">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Ward"><WardSelect value={f.ward} onChange={(w) => setF({ ...f, ward: w, team: db?.teams[w]?.[0] ?? '' })} /></Field>
        <Field label="Survey date"><input type="date" className={inputCls} value={f.date} max={todayIso()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Team"><input className={inputCls} value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} /></Field>
        <div />
        <Field label="Houses visited"><input type="number" className={inputCls} value={f.housesVisited} onChange={num('housesVisited')} /></Field>
        <Field label="Houses with larvae"><input type="number" className={inputCls} value={f.housesPositive} onChange={num('housesPositive')} /></Field>
        <Field label="Containers inspected"><input type="number" className={inputCls} value={f.containersInspected} onChange={num('containersInspected')} /></Field>
        <Field label="Containers with larvae"><input type="number" className={inputCls} value={f.containersPositive} onChange={num('containersPositive')} /></Field>
        <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center sm:col-span-2">
          <div><div className="text-xs text-slate-500">House Index</div><div className="text-lg font-bold">{idx.HI.toFixed(1)}%</div></div>
          <div><div className="text-xs text-slate-500">Container Index</div><div className="text-lg font-bold">{idx.CI.toFixed(1)}%</div></div>
          <div><div className="text-xs text-slate-500">Breteau Index</div><div className={`text-lg font-bold ${idx.BI >= 20 ? 'text-red-700' : ''}`}>{idx.BI.toFixed(1)}</div></div>
        </div>
        <Field label="Notes"><textarea className={inputCls} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        {invalid && <p className="text-xs text-red-700 sm:col-span-2">Positive counts cannot exceed the number inspected.</p>}
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={invalid}>Save survey</Button></div>
      </form>
    </Modal>
  );
}

const SITE_TYPES: SiteType[] = ['Construction site', 'Overhead / roof tank', 'Discarded tyres', 'Vacant plot / garbage', 'Waterlogging', 'Abandoned building', 'Drain / canal', 'Pond / water body', 'Flower pots / coolers'];

export function SiteForm({ open, onClose, ward }: { open: boolean; onClose: () => void; ward: number }) {
  const { db, addSite, notify } = useData();
  const w0 = db?.wards.find((x) => x.ward === ward);
  const [f, setF] = useState({ ward, type: SITE_TYPES[0], lat: '', lng: '', description: '', detectedBy: 'Field team' as const, photo: '' });
  useEffect(() => { if (open) setF((x) => ({ ...x, ward, lat: '', lng: '', photo: '' })); }, [open, ward]);
  const lat = parseFloat(f.lat);
  const lng = parseFloat(f.lng);
  const hasPt = Number.isFinite(lat) && Number.isFinite(lng);
  const inWard = hasPt ? wardAt(lng, lat) : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const w = db?.wards.find((x) => x.ward === f.ward) ?? w0;
    if (!w) return;
    await addSite({
      ward: f.ward, type: f.type, status: 'Open', detectedBy: f.detectedBy,
      lat: hasPt ? lat : w.centroid[1], lng: hasPt ? lng : w.centroid[0],
      firstSeen: todayIso(), description: f.description || `${f.type} reported in ward ${f.ward}`, photo: f.photo || undefined,
    });
    notify(`Breeding site recorded in ward ${f.ward}`);
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="Report breeding site">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Ward"><WardSelect value={f.ward} onChange={(w) => setF({ ...f, ward: w })} /></Field>
        <Field label="Site type">
          <select className={inputCls} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as SiteType })}>{SITE_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Latitude" hint="From the phone's GPS when deployed; blank = ward centre"><input className={inputCls} inputMode="decimal" placeholder="22.53" value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} /></Field>
        <Field label="Longitude"><input className={inputCls} inputMode="decimal" placeholder="88.38" value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} /></Field>
        {hasPt && <p className={`text-xs sm:col-span-2 ${inWard === f.ward ? 'text-emerald-700' : 'text-amber-700'}`}>{inWard ? `Point falls in ward ${inWard}${inWard !== f.ward ? ' — check the ward selection' : ''}.` : 'Point is outside KMC ward boundaries.'}</p>}
        <Field label="Found by">
          <select className={inputCls} value={f.detectedBy} onChange={(e) => setF({ ...f, detectedBy: e.target.value as never })}>{['Field team', 'Drone', 'Citizen'].map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Photo" hint="Kept on this device in the demo">
          <input type="file" accept="image/*" className="text-xs" onChange={(e) => { const file = e.target.files?.[0]; if (file) setF({ ...f, photo: URL.createObjectURL(file) }); }} />
        </Field>
        {f.photo && <img src={f.photo} alt="Breeding site" className="h-32 w-full rounded-lg object-cover sm:col-span-2" />}
        <div className="sm:col-span-2"><Field label="Description"><textarea className={inputCls} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. water in 6 tyres behind the market, roof tank uncovered" /></Field></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit">Save site</Button></div>
      </form>
    </Modal>
  );
}

const TASK_TYPES = [...new Set(Object.values(SOP).flat().map((t) => t.type))] as TaskType[];

export function TaskForm({ open, onClose, ward, preset, onSaved }: { open: boolean; onClose: () => void; ward: number; preset?: { title?: string; source?: 'Manual' | 'Citizen' }; onSaved?: () => void }) {
  const { db, addTask, notify } = useData();
  const [f, setF] = useState({ ward, type: TASK_TYPES[0], title: '', priority: 'P2' as 'P1' | 'P2' | 'P3', hours: 72, team: '', notes: '' });
  useEffect(() => { if (open) setF((x) => ({ ...x, ward, title: preset?.title ?? '', team: db?.teams[ward]?.[0] ?? '' })); }, [open, ward, preset, db]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await addTask({
      ward: f.ward, type: f.type, title: f.title || f.type, priority: f.priority, status: 'Open',
      dueAt: new Date(Date.now() + f.hours * 3600000).toISOString(), source: preset?.source ?? 'Manual', team: f.team, notes: f.notes || undefined,
    });
    notify(`Task assigned to ${f.team || 'ward team'}`);
    onSaved?.();
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="New field task">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Ward"><WardSelect value={f.ward} onChange={(w) => setF({ ...f, ward: w, team: db?.teams[w]?.[0] ?? '' })} /></Field>
        <Field label="Task type"><select className={inputCls} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as TaskType })}>{TASK_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <div className="sm:col-span-2"><Field label="Title"><input className={inputCls} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={f.type} /></Field></div>
        <Field label="Priority"><select className={inputCls} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as never })}><option>P1</option><option>P2</option><option>P3</option></select></Field>
        <Field label="Due within (hours)"><input type="number" className={inputCls} value={f.hours} min={1} onChange={(e) => setF({ ...f, hours: Number(e.target.value) })} /></Field>
        <Field label="Team">
          <select className={inputCls} value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })}>{(db?.teams[f.ward] ?? []).map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Notes"><input className={inputCls} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit">Assign task</Button></div>
      </form>
    </Modal>
  );
}
