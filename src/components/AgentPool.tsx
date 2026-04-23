import type { PoecatStatus } from '../types';

interface Props { polecats: PoecatStatus | null }

export function AgentPool({ polecats }: Props) {
  if (!polecats) {
    return (
      <div className="flex h-full items-center justify-center text-os-muted">
        <p className="font-mono text-sm">No agent pool data</p>
      </div>
    );
  }

  const usedPct = polecats.total > 0
    ? Math.round((polecats.busy / polecats.total) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total',  value: polecats.total, color: 'text-os-text',     border: 'border-os-border' },
          { label: 'Busy',   value: polecats.busy,  color: 'text-amber-400',   border: 'border-amber-500/30' },
          { label: 'Idle',   value: polecats.idle,  color: 'text-emerald-400', border: 'border-emerald-500/30' },
        ].map(c => (
          <div key={c.label}
            className={`rounded-xl border ${c.border} bg-os-surface p-5 text-center`}>
            <p className={`font-mono text-3xl font-bold ${c.color}`}>{c.value}</p>
            <p className="mt-1 font-mono text-xs uppercase tracking-widest text-os-muted">
              {c.label}
            </p>
          </div>
        ))}
      </div>

      {/* Utilization bar */}
      <div className="rounded-xl border border-os-border bg-os-surface p-5">
        <div className="mb-2 flex justify-between font-mono text-xs text-os-muted">
          <span>Pool utilization</span>
          <span>{usedPct}%</span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-os-bg">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              usedPct > 80 ? 'bg-red-500' :
              usedPct > 50 ? 'bg-amber-400' : 'bg-emerald-400'
            }`}
            style={{ width: `${usedPct}%` }}
          />
        </div>
      </div>

      {/* Agent slots */}
      {polecats.total > 0 && (
        <div className="rounded-xl border border-os-border bg-os-surface p-5">
          <p className="mb-3 font-mono text-xs font-semibold uppercase tracking-widest text-os-muted">
            Slots
          </p>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: polecats.total }, (_, i) => (
              <div
                key={i}
                title={i < polecats.busy ? 'busy' : 'idle'}
                className={`h-5 w-5 rounded ${
                  i < polecats.busy
                    ? 'bg-amber-400 shadow-[0_0_6px_theme(colors.amber.400)]'
                    : 'bg-emerald-400/30 border border-emerald-400/30'
                }`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
