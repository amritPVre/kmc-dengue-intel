import type { AlertLevel, AlertType, RiskResult, TaskType } from '@shared/risk-engine';

export type BoroughCode =
  | 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | 'VII' | 'VIII'
  | 'IX' | 'X' | 'XI' | 'XII' | 'XIII' | 'XIV' | 'XV' | 'XVI';

export const BOROUGHS: BoroughCode[] = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI'];

export interface Ward {
  ward: number;
  borough: BoroughCode;
  centroid: [number, number]; // [lng, lat]
  areaKm2: number;
  bbox: [number, number, number, number];
  neighbours: number[];
  boundary: 'datameet' | 'pending' | 'official';
  population: number;
}

export interface WeatherWeek {
  weekStart: string; // ISO date (Monday)
  rainMm: number;
  tMeanC: number;
  rhPct: number;
}

export type TestType = 'NS1' | 'IgM' | 'NS1 + IgM' | 'RT-PCR';
export type CaseSource = 'KMC lab' | 'Private lab' | 'Govt hospital' | 'Private hospital' | 'IHIP';
export type Severity = 'Dengue' | 'Dengue with warning signs' | 'Severe dengue';

export interface DengueCase {
  id: string;
  ward: number;
  reportedOn: string; // ISO date
  onsetOn: string;
  test: TestType;
  source: CaseSource;
  ageBand: string;
  sex: 'M' | 'F' | 'Other';
  lat: number;
  lng: number;
  hospitalised: boolean;
  severity: Severity;
  /** Salted hash of identity fields for de-duplication; no names or phone numbers are kept in analytics. */
  dedupeKey: string;
}

export interface LarvalSurvey {
  id: string;
  ward: number;
  date: string;
  team: string;
  housesVisited: number;
  housesPositive: number;
  containersInspected: number;
  containersPositive: number;
  notes?: string;
}

export type SiteType =
  | 'Construction site' | 'Overhead / roof tank' | 'Discarded tyres' | 'Vacant plot / garbage'
  | 'Waterlogging' | 'Abandoned building' | 'Drain / canal' | 'Pond / water body' | 'Flower pots / coolers';

export interface BreedingSite {
  id: string;
  ward: number;
  type: SiteType;
  lat: number;
  lng: number;
  status: 'Open' | 'Treated' | 'Closed';
  detectedBy: 'Field team' | 'Drone' | 'Citizen';
  firstSeen: string;
  lastActionOn?: string;
  description: string;
  photo?: string; // object URL (local preview only in demo)
}

export type TaskStatus = 'Open' | 'In progress' | 'Done' | 'Verified';

export interface FieldTask {
  id: string;
  ward: number;
  type: TaskType;
  title: string;
  priority: 'P1' | 'P2' | 'P3';
  status: TaskStatus;
  createdAt: string; // ISO datetime
  dueAt: string;
  completedAt?: string;
  source: 'Alert' | 'Manual' | 'Citizen';
  alertId?: string;
  team: string;
  notes?: string;
}

export interface Alert {
  id: string;
  ward: number;
  type: AlertType;
  level: AlertLevel;
  title: string;
  detail: string;
  createdAt: string;
  status: 'New' | 'Acknowledged' | 'Closed';
  clusterCentroid?: [number, number];
  caseIds?: string[];
}

export interface CitizenReport {
  id: string;
  ward: number;
  kind: 'Stagnant water' | 'Garbage dump' | 'Fever in neighbourhood' | 'Mosquito nuisance';
  reportedAt: string;
  status: 'New' | 'Task created' | 'Resolved';
  text: string;
}

export interface Db {
  mode: 'demo' | 'supabase';
  asOf: string; // ISO date of "today"
  weeks: string[]; // all week starts (Mondays) up to and including the current partial week
  wards: Ward[];
  weather: WeatherWeek[];
  cases: DengueCase[];
  surveys: LarvalSurvey[];
  sites: BreedingSite[];
  tasks: FieldTask[];
  alerts: Alert[];
  citizen: CitizenReport[];
  teams: Record<number, string[]>;
}

export interface WardStats {
  ward: number;
  borough: BoroughCode;
  population: number;
  weekly: number[]; // complete weeks only, aligned with Analytics.completeWeeks
  last2w: number;
  prev2w: number;
  ytd: number;
  bi: number | null;
  hi: number | null;
  ci: number | null;
  openSites: number;
  openTasks: number;
  overdueTasks: number;
  risk: RiskResult;
}

export type { AlertLevel, AlertType, RiskResult, TaskType };
