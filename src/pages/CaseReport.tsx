import { useMemo, useState, type FormEvent } from 'react';
import Papa from 'papaparse';
import { useData, useScopedWards } from '@/lib/store';
import type { CaseSource, DengueCase, Severity, TestType } from '@/lib/types';
import { fmtDate, sha256Hex, todayIso } from '@/lib/util';
import { PageHeader } from '@/components/Layout';
import { Button, Card, Field, Table, inputCls } from '@/components/ui';
import { WardSelect, wardAt } from './forms';

const TESTS: TestType[] = ['NS1', 'IgM', 'NS1 + IgM', 'RT-PCR'];
const SOURCES: CaseSource[] = ['KMC lab', 'Private lab', 'Govt hospital', 'Private hospital', 'IHIP'];
const AGES = ['0–4', '5–14', '15–24', '25–44', '45–59', '60+'];
const SEV: Severity[] = ['Dengue', 'Dengue with warning signs', 'Severe dengue'];
const SALT = 'kmc-dengue-v1'; // in production the salt lives server-side, not in the browser bundle

const TEMPLATE = 'reported_on,onset_on,test_type,source,age_band,sex,ward_no,lat,lng,hospitalised,severity,patient_mobile_last4,patient_birth_year\n' +
  '2026-11-12,2026-11-09,NS1,Private lab,25–44,F,66,22.5321,88.3859,false,Dengue,4821,1991';

export function CaseReport() {
  const { db, scope, addCase, importCases, notify } = useData();
  const wards = useScopedWards();
  const [f, setF] = useState({
    reportedOn: todayIso(), onsetOn: todayIso(), test: TESTS[0], source: SOURCES[1], ageBand: '25–44', sex: 'F' as DengueCase['sex'],
    ward: wards[0]?.ward ?? scope.ward, lat: '', lng: '', hospitalised: false, severity: SEV[0], mobile4: '', birthYear: '',
  });
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<{ ok: Omit<DengueCase, 'id'>[]; errors: string[] } | null>(null);
  const lat = parseFloat(f.lat), lng = parseFloat(f.lng);
  const hasPt = Number.isFinite(lat) && Number.isFinite(lng);
  const ptWard = hasPt ? wardAt(lng, lat) : null;
  const wardSet = useMemo(() => new Set(wards.map((w) => w.ward)), [wards]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const w = db!.wards.find((x) => x.ward === (ptWard ?? f.ward))!;
    const dedupeKey = await sha256Hex(`${SALT}|${f.mobile4}|${f.birthYear}|${f.sex}|${w.ward}|${f.onsetOn}`);
    if (db!.cases.some((c) => c.dedupeKey === dedupeKey)) { notify('Possible duplicate: this case already exists'); return; }
    await addCase({
      ward: w.ward, reportedOn: f.reportedOn, onsetOn: f.onsetOn, test: f.test, source: f.source, ageBand: f.ageBand, sex: f.sex,
      lat: hasPt ? lat : w.centroid[1], lng: hasPt ? lng : w.centroid[0], hospitalised: f.hospitalised, severity: f.severity, dedupeKey,
    });
    notify(`Case recorded in ward ${w.ward}`);
    setF({ ...f, lat: '', lng: '', mobile4: '', birthYear: '' });
  };

  const parse = async (text: string) => {
    const res = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true });
    const ok: Omit<DengueCase, 'id'>[] = [];
    const errors: string[] = [];
    for (const [i, r] of res.data.entries()) {
      const line = i + 2;
      const wardNo = Number(r.ward_no) || (r.lat && r.lng ? wardAt(Number(r.lng), Number(r.lat)) : null);
      const w = db!.wards.find((x) => x.ward === wardNo);
      if (!w) { errors.push(`Line ${line}: ward not found`); continue; }
      if (!wardSet.has(w.ward)) { errors.push(`Line ${line}: ward ${w.ward} is outside your area`); continue; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.reported_on ?? '')) { errors.push(`Line ${line}: reported_on must be YYYY-MM-DD`); continue; }
      if (!TESTS.includes(r.test_type as TestType)) { errors.push(`Line ${line}: unknown test_type "${r.test_type}"`); continue; }
      const dedupeKey = await sha256Hex(`${SALT}|${r.patient_mobile_last4 ?? ''}|${r.patient_birth_year ?? ''}|${r.sex}|${w.ward}|${r.onset_on || r.reported_on}`);
      ok.push({
        ward: w.ward, reportedOn: r.reported_on, onsetOn: r.onset_on || r.reported_on, test: r.test_type as TestType,
        source: (SOURCES.includes(r.source as CaseSource) ? r.source : 'Private lab') as CaseSource,
        ageBand: AGES.includes(r.age_band) ? r.age_band : '25–44', sex: (['M', 'F', 'Other'].includes(r.sex) ? r.sex : 'Other') as DengueCase['sex'],
        lat: r.lat ? Number(r.lat) : w.centroid[1], lng: r.lng ? Number(r.lng) : w.centroid[0],
        hospitalised: /^(true|yes|1)$/i.test(r.hospitalised ?? ''), severity: (SEV.includes(r.severity as Severity) ? r.severity : 'Dengue') as Severity, dedupeKey,
      });
    }
    const existing = new Set(db!.cases.map((c) => c.dedupeKey));
    const dupes = ok.filter((c) => existing.has(c.dedupeKey)).length;
    if (dupes) errors.push(`${dupes} rows match cases already on record and will be skipped`);
    setPreview({ ok: ok.filter((c) => !existing.has(c.dedupeKey)), errors });
  };

  if (!db) return null;
  const recent = db.cases.filter((c) => wardSet.has(c.ward)).slice(-15).reverse();
  return (
    <>
      <PageHeader title="Case reporting" subtitle="For KMC labs, private labs and hospitals. Only lab-confirmed cases. Identity fields are hashed for de-duplication and never stored." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Report a confirmed case">
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
            <Field label="Reported on"><input type="date" className={inputCls} value={f.reportedOn} max={todayIso()} onChange={(e) => setF({ ...f, reportedOn: e.target.value })} /></Field>
            <Field label="Symptom onset"><input type="date" className={inputCls} value={f.onsetOn} max={f.reportedOn} onChange={(e) => setF({ ...f, onsetOn: e.target.value })} /></Field>
            <Field label="Test"><select className={inputCls} value={f.test} onChange={(e) => setF({ ...f, test: e.target.value as TestType })}>{TESTS.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Reporting facility"><select className={inputCls} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value as CaseSource })}>{SOURCES.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Age group"><select className={inputCls} value={f.ageBand} onChange={(e) => setF({ ...f, ageBand: e.target.value })}>{AGES.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Sex"><select className={inputCls} value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value as DengueCase['sex'] })}><option value="F">Female</option><option value="M">Male</option><option value="Other">Other</option></select></Field>
            <Field label="Ward of residence"><WardSelect value={f.ward} onChange={(w) => setF({ ...f, ward: w })} /></Field>
            <Field label="Severity"><select className={inputCls} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value as Severity })}>{SEV.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Residence latitude" hint="Optional; geocoded from address when deployed"><input className={inputCls} inputMode="decimal" value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} placeholder="22.5321" /></Field>
            <Field label="Residence longitude"><input className={inputCls} inputMode="decimal" value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} placeholder="88.3859" /></Field>
            {hasPt && <p className="text-xs text-slate-600 sm:col-span-2">{ptWard ? `Location falls in ward ${ptWard}; the case will be filed there.` : 'Location is outside KMC; the selected ward will be used.'}</p>}
            <Field label="Patient mobile, last 4 digits" hint="Hashed with birth year for duplicate checks"><input className={inputCls} inputMode="numeric" maxLength={4} value={f.mobile4} onChange={(e) => setF({ ...f, mobile4: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label="Patient birth year"><input className={inputCls} inputMode="numeric" maxLength={4} value={f.birthYear} onChange={(e) => setF({ ...f, birthYear: e.target.value.replace(/\D/g, '') })} /></Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.hospitalised} onChange={(e) => setF({ ...f, hospitalised: e.target.checked })} /> Admitted to hospital</label>
            <div className="sm:col-span-2"><Button type="submit">Submit case</Button></div>
          </form>
        </Card>
        <Card title="Bulk upload (CSV)" subtitle="For labs and hospitals sending daily line lists">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <input type="file" accept=".csv,text/csv" className="text-xs" onChange={async (e) => { const file = e.target.files?.[0]; if (file) { const t = await file.text(); setCsv(t); parse(t); } }} />
              <Button small variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(TEMPLATE); notify('Template copied'); } catch { setCsv(TEMPLATE); } }}>Copy CSV template</Button>
            </div>
            <textarea className={`${inputCls} font-mono text-xs`} rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={TEMPLATE} />
            <Button small variant="secondary" onClick={() => parse(csv)} disabled={!csv.trim()}>Validate</Button>
            {preview && (
              <div className="rounded-lg bg-slate-50 p-3 text-sm">
                <p><b>{preview.ok.length}</b> rows ready to import.</p>
                {preview.errors.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-amber-800">{preview.errors.slice(0, 8).map((er) => <li key={er}>{er}</li>)}</ul>}
                {preview.ok.length > 0 && <div className="mt-2"><Button small onClick={async () => { const k = await importCases(preview.ok); notify(`${k} cases imported`); setPreview(null); setCsv(''); }}>Import {preview.ok.length} cases</Button></div>}
              </div>
            )}
          </div>
        </Card>
      </div>
      <Card className="mt-4" title="Most recent cases in your area">
        <Table head={['Reported', 'Ward', 'Test', 'Source', 'Age', 'Sex', 'Severity']}>
          {recent.map((c) => (
            <tr key={c.id}>
              <td className="px-2 py-1.5">{fmtDate(c.reportedOn)}</td><td className="px-2 py-1.5">{c.ward}</td><td className="px-2 py-1.5">{c.test}</td>
              <td className="px-2 py-1.5">{c.source}</td><td className="px-2 py-1.5">{c.ageBand}</td><td className="px-2 py-1.5">{c.sex}</td><td className="px-2 py-1.5">{c.severity}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
