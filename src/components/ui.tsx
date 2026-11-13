import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RiskLevel } from '@shared/risk-engine';

export function Card({ title, subtitle, action, children, className = '' }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div>
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub, tone = 'default' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'default' | 'warn' | 'bad' | 'good' }) {
  const toneCls = tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-emerald-700' : 'text-ink';
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${toneCls}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-600">{sub}</div>}
    </div>
  );
}

export const RISK_COLOR: Record<RiskLevel, string> = {
  Low: '#FBE7A1',
  Moderate: '#F7AE57',
  High: '#E25E3A',
  'Very high': '#9E1B32',
};
export const RISK_TEXT: Record<RiskLevel, string> = { Low: '#5B4A00', Moderate: '#5A2E00', High: '#FFFFFF', 'Very high': '#FFFFFF' };

export function RiskBadge({ level, score }: { level: RiskLevel; score?: number }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: RISK_COLOR[level], color: RISK_TEXT[level] }}>
      {level}{score != null && <span className="tabular-nums opacity-90">· {score}</span>}
    </span>
  );
}

export function Pill({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'red' | 'amber' | 'green' | 'teal' | 'blue' }) {
  const map = {
    slate: 'bg-slate-100 text-slate-700', red: 'bg-red-100 text-red-800', amber: 'bg-amber-100 text-amber-900',
    green: 'bg-emerald-100 text-emerald-800', teal: 'bg-kmc-50 text-kmc-700', blue: 'bg-sky-100 text-sky-800',
  } as const;
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${map[tone]}`}>{children}</span>;
}

export function Button({ children, onClick, variant = 'primary', type = 'button', disabled, small, title }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; type?: 'button' | 'submit'; disabled?: boolean; small?: boolean; title?: string }) {
  const v = {
    primary: 'bg-kmc-600 text-white hover:bg-kmc-700 disabled:bg-slate-300',
    secondary: 'border border-slate-300 bg-white text-ink hover:bg-slate-50 disabled:text-slate-400',
    ghost: 'text-kmc-700 hover:bg-kmc-50',
    danger: 'bg-red-700 text-white hover:bg-red-800',
  }[variant];
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition ${small ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm'} ${v}`}>
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}
export const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-kmc-500 focus:ring-2 focus:ring-kmc-100';

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[2000] flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className={`max-h-[92vh] w-full overflow-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-4 py-3">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">{children}</div>;
}

export function Trend({ now, before }: { now: number; before: number }) {
  if (now === before) return <span className="text-slate-500">no change</span>;
  const up = now > before;
  const pct = before === 0 ? null : Math.round(((now - before) / before) * 100);
  return (
    <span className={up ? 'text-red-700' : 'text-emerald-700'}>
      {up ? '▲' : '▼'} {pct == null ? `+${now}` : `${Math.abs(pct)}%`} vs previous
    </span>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            {head.map((h, i) => <th key={i} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}
