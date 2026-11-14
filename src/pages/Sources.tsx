import { useEffect, useState } from 'react';
import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { useData } from '@/lib/store';
import { loadSources, PART_LABEL, type PartName, type SourceStatus } from '@/lib/live';
import { fmtDateTime } from '@/lib/util';
import { PageHeader } from '@/components/Layout';
import { Card, Pill, Table } from '@/components/ui';

type State = 'Live' | 'Live (KMC database)' | 'Needs KMC feed' | 'Phase 2';
const CATALOGUE: { source: string; gives: string; state: State; refresh: string; licence: string }[] = [
  { source: 'Open-Meteo (ECMWF, DWD and other models; ERA5 reanalysis)', gives: 'Daily rain, temperature, humidity per borough since May 2025 and a 16-day forecast', state: 'Live', refresh: 'Hourly', licence: 'CC BY 4.0 (non-commercial tier; commercial plan for production)' },
  { source: 'Copernicus Sentinel-1 radar (via Microsoft Planetary Computer)', gives: 'Water through cloud, 10 m, every 6–12 days; per-ward new water and 250 m spots', state: 'Live', refresh: 'Daily check for new passes', licence: 'Copernicus open licence' },
  { source: 'Copernicus Sentinel-2 optical', gives: 'True-colour views on clear days for visual checks', state: 'Live', refresh: 'Every 5 days (cloud permitting)', licence: 'Copernicus open licence' },
  { source: 'ESA WorldCover 2021', gives: 'Built-up, bare/vacant, grass, trees and water share of each ward', state: 'Live', refresh: 'Static (2021)', licence: 'CC BY 4.0' },
  { source: 'JRC Global Surface Water 1984–2021', gives: 'Where water appears seasonally — chronic pooling ground', state: 'Live', refresh: 'Static', licence: 'Copernicus / JRC open' },
  { source: 'Copernicus DEM GLO-30', gives: 'Ward elevation (surface model)', state: 'Live', refresh: 'Static', licence: 'Copernicus DEM licence' },
  { source: 'OpenStreetMap', gives: 'Tyre and repair shops, scrap yards, construction sites, markets, nurseries, ponds, drains, hospitals, schools', state: 'Live', refresh: 'Weekly', licence: '© OpenStreetMap contributors, ODbL' },
  { source: 'Census of India 2011 (ward Primary Census Abstract)', gives: 'Population of 141 wards', state: 'Live', refresh: 'Static', licence: 'Government of India open data' },
  { source: 'KMC statements and press reports', gives: 'Named waterlogging pockets, dengue hotspot wards 2022–2025, gauge readings', state: 'Live', refresh: 'Curated', licence: 'Cited per item' },
  { source: 'AI photo analysis (Claude vision)', gives: 'Standing water, containers, Aedes risk from any photo or drone frame', state: 'Live', refresh: 'On upload', licence: 'Anthropic API' },
  { source: 'KMC ward-wise dengue cases (15 detection centres, labs, IHIP)', gives: 'Outbreak risk, clusters, forecasts, back-testing', state: 'Needs KMC feed', refresh: 'Daily import or API', licence: 'KMC' },
  { source: 'KMC larval surveys (Breteau/House Index)', gives: 'Entomological alerts, model calibration', state: 'Needs KMC feed', refresh: 'Daily from field app', licence: 'KMC' },
  { source: 'KMC rain gauges and flood sensors (FFEWS)', gives: 'Real measured rain per locality, streets under water', state: 'Needs KMC feed', refresh: 'Real time', licence: 'KMC' },
  { source: 'KMC drone surveys', gives: 'Rooftop tanks, tyres, terraces — analysed frame by frame by AI', state: 'Needs KMC feed', refresh: 'Per flight', licence: 'KMC' },
  { source: 'NISAR L-band radar (NASA–ISRO)', gives: 'Water under trees and in mixed urban land', state: 'Phase 2', refresh: '12 days', licence: 'Open' },
];
const TONE: Record<State, 'green' | 'teal' | 'amber' | 'slate'> = { Live: 'green', 'Live (KMC database)': 'teal', 'Needs KMC feed': 'amber', 'Phase 2': 'slate' };

export function Sources() {
  const { pub, db } = useData();
  const [st, setSt] = useState<SourceStatus | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { loadSources().then(setSt).catch((e) => setErr(String(e.message || e))); }, []);
  const icon = (s?: 'loading' | 'ok' | 'error') => s === 'ok' ? <CheckCircle2 size={16} className="text-emerald-600" /> : s === 'error' ? <XCircle size={16} className="text-red-600" /> : <CircleDashed size={16} className="animate-spin text-slate-400" />;
  return (
    <>
      <PageHeader title="Data sources" subtitle="Everything on screen comes from the sources below. Nothing is simulated outside the outbreak drill." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Loaded in this session">
          <ul className="space-y-2 text-sm">
            {(Object.keys(PART_LABEL) as PartName[]).map((k) => (
              <li key={k} className="flex items-start gap-2">{icon(pub?.status[k])}<span><b>{PART_LABEL[k]}</b>{pub?.errors[k] && <span className="block text-xs text-red-700">{pub.errors[k]}</span>}</span></li>
            ))}
          </ul>
          {db?.pub && (
            <p className="mt-3 text-xs text-slate-500">
              {db.pub.history?.length ?? 0} radar passes processed · {db.pub.osm?.total ?? 0} OpenStreetMap candidates
              {db.pub.osm?.osmBase && <> (map data as of {fmtDateTime(db.pub.osm.osmBase)})</>} · {Object.keys(db.pub.landscape?.population?.wards ?? {}).length} ward census figures
            </p>
          )}
        </Card>
        <Card title="Live connection check" subtitle={st ? `Checked ${fmtDateTime(st.checkedAt)}` : 'Checking…'}>
          {err && <p className="text-sm text-red-700">{err}</p>}
          {st && (
            <ul className="space-y-2 text-sm">
              {st.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-2">{c.ok ? <CheckCircle2 size={16} className="text-emerald-600" /> : <XCircle size={16} className="text-red-600" />}
                  <span><b>{c.name}</b> <span className="text-xs text-slate-500">{c.ms} ms</span><span className="block text-xs text-slate-600">{c.detail}</span></span></li>
              ))}
              <li className="flex items-start gap-2">{st.database ? <CheckCircle2 size={16} className="text-emerald-600" /> : <CircleDashed size={16} className="text-slate-400" />}
                <span><b>Results database</b><span className="block text-xs text-slate-600">{st.database ? Object.entries(st.stored).map(([k, v]) => `${k}: ${v.count}`).join(' · ') : 'Not connected yet — results are cached by the server for now.'}</span></span></li>
            </ul>
          )}
        </Card>
      </div>
      <Card className="mt-4" title="Source catalogue">
        <Table head={['Source', 'What it gives the app', 'Status', 'Refresh', 'Licence']}>
          {CATALOGUE.map((c) => (
            <tr key={c.source} className="align-top">
              <td className="px-2 py-2 font-medium">{c.source}</td><td className="px-2 py-2">{c.gives}</td>
              <td className="px-2 py-2"><Pill tone={TONE[c.state]}>{c.state}</Pill></td>
              <td className="px-2 py-2 text-xs text-slate-600">{c.refresh}</td><td className="px-2 py-2 text-xs text-slate-600">{c.licence}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
