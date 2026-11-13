import { useState } from 'react';
import { DEFAULT_CONFIG, FEATURE_LABELS, MODEL_VERSION, type EngineConfig, type FeatureKey } from '@shared/risk-engine';
import { useData } from '@/lib/store';
import { PageHeader } from '@/components/Layout';
import { Button, Card, Field, Pill, Table, inputCls } from '@/components/ui';

export function Settings() {
  const { db, config, setConfig, notify } = useData();
  const [draft, setDraft] = useState<EngineConfig['alerts']>(config.alerts);
  if (!db) return null;
  const num = (k: keyof EngineConfig['alerts']) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: Number(e.target.value) });
  return (
    <>
      <PageHeader title="Settings & model" subtitle="Thresholds, model transparency, geography and integrations" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Alert thresholds" subtitle="Changes apply immediately to risk levels, alerts and reports">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Breteau Index alert level"><input type="number" className={inputCls} value={draft.breteauHigh} onChange={num('breteauHigh')} /></Field>
            <Field label="House Index alert level (%)"><input type="number" className={inputCls} value={draft.houseIndexHigh} onChange={num('houseIndexHigh')} /></Field>
            <Field label="Cluster radius (metres)" hint="Aedes flight range is typically 100–200 m"><input type="number" className={inputCls} value={draft.clusterRadiusM} onChange={num('clusterRadiusM')} /></Field>
            <Field label="Cluster window (days)"><input type="number" className={inputCls} value={draft.clusterDays} onChange={num('clusterDays')} /></Field>
            <Field label="Minimum cases for a cluster"><input type="number" className={inputCls} value={draft.clusterMinCases} onChange={num('clusterMinCases')} /></Field>
            <Field label="Exceedance: SDs above baseline"><input type="number" step="0.5" className={inputCls} value={draft.exceedanceSd} onChange={num('exceedanceSd')} /></Field>
            <Field label="Exceedance: minimum cases"><input type="number" className={inputCls} value={draft.exceedanceMin} onChange={num('exceedanceMin')} /></Field>
            <Field label="Predicted-risk alert score"><input type="number" className={inputCls} value={draft.predictedRiskScore} onChange={num('predictedRiskScore')} /></Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => { setConfig({ ...config, alerts: draft }); notify('Thresholds updated'); }}>Apply</Button>
            <Button variant="secondary" onClick={() => { setDraft(DEFAULT_CONFIG.alerts); setConfig(DEFAULT_CONFIG); notify('Defaults restored'); }}>Restore defaults</Button>
          </div>
        </Card>
        <Card title="Risk model" subtitle={<>Version <b>{MODEL_VERSION}</b> · logistic score over 10 factors · <Pill tone="amber">baseline, not yet trained on KMC data</Pill></>}>
          <Table head={['Factor', 'Weight']}>
            {(Object.keys(config.weights) as FeatureKey[]).map((k) => (
              <tr key={k}><td className="px-2 py-1.5">{FEATURE_LABELS[k]}</td><td className="px-2 py-1.5 tabular-nums">{config.weights[k].toFixed(2)}</td></tr>
            ))}
          </Table>
          <p className="mt-3 text-xs leading-relaxed text-slate-600">
            The weights are an expert-set starting point. Once KMC shares 3–5 seasons of ward-level case, larval-survey and weather records,
            the training pipeline (ml/train_baseline.py) fits the weights and is validated on a held-out season before the model is used operationally.
            The same engine runs in the browser and in the nightly server job, so every number on screen can be traced to its inputs.
          </p>
        </Card>
        <Card title="Geography">
          <ul className="space-y-2 text-sm">
            <li className="flex items-center justify-between gap-2"><span>KMC — 144 wards, 16 boroughs (current)</span><Pill tone="green">Active</Pill></li>
            <li className="flex items-center justify-between gap-2"><span>KMC — 209 wards (2026 delimitation)</span><Pill tone="amber">Awaiting official boundaries</Pill></li>
          </ul>
          <p className="mt-3 text-xs text-slate-600">Ward boundaries are versioned. When KMC publishes the 209-ward map, it is loaded as a new version and historical cases are re-assigned by location, so trend lines stay comparable across the change. 141 boundaries currently come from DataMeet open data; wards 142–144 use approximate locations.</p>
        </Card>
        <Card title="Integrations">
          <Table head={['Source', 'Use', 'Status']}>
            {[
              ['KMC labs and ward health units', 'Confirmed cases (form, CSV)', db.mode === 'supabase' ? 'Live' : 'Demo'],
              ['Private labs and hospitals', 'Daily line lists (CSV / API)', 'Planned'],
              ['IDSP-IHIP', 'National surveillance exchange', 'Planned'],
              ['Weather (IMD / open data)', 'Rainfall, temperature, humidity', db.mode === 'supabase' ? 'Live' : 'Demo'],
              ['KMC drone surveys', 'Rooftop and inaccessible-site images', 'Planned'],
              ['Citizen channels (WhatsApp, app, helpline)', 'Complaints and fever reports', 'Planned'],
            ].map(([a, b, c]) => <tr key={a}><td className="px-2 py-1.5">{a}</td><td className="px-2 py-1.5">{b}</td><td className="px-2 py-1.5"><Pill tone={c === 'Live' ? 'green' : c === 'Demo' ? 'blue' : 'slate'}>{c}</Pill></td></tr>)}
          </Table>
        </Card>
        <Card className="xl:col-span-2" title="Data protection">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>Analytics tables hold no names, phone numbers or street addresses. Identity fields are hashed server-side with a secret salt for de-duplication only.</li>
            <li>Case locations are kept to the precision needed for cluster detection and are visible only to the ward, borough and HQ health roles; councillors see aggregates.</li>
            <li>Row-level security restricts every user to their borough or ward. All writes are logged in an audit table.</li>
            <li>Designed for hosting in India (West Bengal State Data Centre or an India-region cloud) and for the obligations of the Digital Personal Data Protection Act, 2023 and its Rules, which come fully into force in May 2027.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
