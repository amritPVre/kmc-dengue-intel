// Exports the synthetic demo data as the CSVs the training pipeline expects, so the
// pipeline can be exercised before real KMC data arrives.
// Run: npx vite-node scripts/export-demo-csv.ts   →  ml/data/*.csv
// With real data, export the same columns from Supabase (see ml/README.md).
import fs from 'node:fs';
import { generateDemo } from '../src/lib/demo/generator';
import { mondayOf, todayIso } from '../src/lib/util';

const db = generateDemo(todayIso());
fs.mkdirSync('ml/data', { recursive: true });
const csv = (rows: (string | number | null)[][]) => rows.map((r) => r.join(',')).join('\n') + '\n';

fs.writeFileSync('ml/data/wards.csv', csv([['ward_no', 'borough', 'population', 'neighbours'],
  ...db.wards.map((w) => [w.ward, w.borough, w.population, `"${w.neighbours.join(' ')}"`])]));
const weekly = new Map<string, number>();
for (const c of db.cases) { const k = `${c.ward}|${mondayOf(c.reportedOn)}`; weekly.set(k, (weekly.get(k) ?? 0) + 1); }
const thisMonday = mondayOf(db.asOf);
const rows: (string | number)[][] = [['ward_no', 'week_start', 'cases']];
for (const w of db.wards) for (const wk of db.weeks) if (wk < thisMonday) rows.push([w.ward, wk, weekly.get(`${w.ward}|${wk}`) ?? 0]);
fs.writeFileSync('ml/data/cases_weekly.csv', csv(rows));
const lv = new Map<string, { hv: number; hp: number; cp: number }>();
for (const s of db.surveys) {
  const k = `${s.ward}|${mondayOf(s.date)}`;
  const a = lv.get(k) ?? { hv: 0, hp: 0, cp: 0 };
  a.hv += s.housesVisited; a.hp += s.housesPositive; a.cp += s.containersPositive; lv.set(k, a);
}
fs.writeFileSync('ml/data/larval_weekly.csv', csv([['ward_no', 'week_start', 'houses_visited', 'houses_positive', 'containers_positive'],
  ...[...lv.entries()].map(([k, a]) => [...k.split('|'), a.hv, a.hp, a.cp])]));
fs.writeFileSync('ml/data/weather_weekly.csv', csv([['week_start', 'rain_mm', 't_mean_c', 'rh_pct'], ...db.weather.map((w) => [w.weekStart, w.rainMm, w.tMeanC, w.rhPct])]));
console.log('wrote ml/data/*.csv');
