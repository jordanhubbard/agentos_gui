import type { PoecatStatus } from '../types';

export type Tab = 'guests' | 'devices' | 'logs' | 'agents';

interface Props {
  tab:       Tab;
  onTab:     (t: Tab) => void;
  connected: boolean;
  sockPath:  string;
  polecats:  PoecatStatus | null;
  onDisconnect: () => void;
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'guests',  label: 'Guests',  icon: '⬡' },
  { id: 'devices', label: 'Devices', icon: '◈' },
  { id: 'logs',    label: 'Logs',    icon: '≡' },
  { id: 'agents',  label: 'Agents',  icon: '◎' },
];

export function Sidebar({ tab, onTab, connected, sockPath, polecats, onDisconnect }: Props) {
  return (
    <aside className="flex h-full w-56 flex-col border-r border-os-border bg-os-surface">
      {/* Logo */}
      <div className="flex items-center gap-2.5 border-b border-os-border px-5 py-4">
        <div className="flex gap-1">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
        </div>
        <span className="font-mono text-sm font-bold tracking-tight text-os-text">
          agentOS
        </span>
      </div>

      {/* Connection badge */}
      <div className="border-b border-os-border px-5 py-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${connected
            ? 'bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]'
            : 'bg-slate-600'}`}
          />
          <span className="font-mono text-xs text-os-muted truncate" title={sockPath}>
            {connected ? sockPath.split('/').pop() : 'disconnected'}
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 px-2 py-3">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left
                        font-mono text-sm transition-colors
                        ${tab === t.id
                          ? 'bg-os-accent/15 text-os-accent'
                          : 'text-os-muted hover:bg-os-border/50 hover:text-os-text'}`}
          >
            <span className="text-base leading-none">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>

      {/* Agent pool mini-stat */}
      {polecats && (
        <div className="border-t border-os-border px-5 py-3">
          <p className="mb-1 text-xs font-medium uppercase tracking-widest text-os-muted">
            Agent pool
          </p>
          <div className="flex items-center gap-3 font-mono text-xs">
            <span className="text-emerald-400">{polecats.idle} idle</span>
            <span className="text-amber-400">{polecats.busy} busy</span>
            <span className="text-os-muted">{polecats.total} total</span>
          </div>
        </div>
      )}

      {/* Disconnect */}
      {connected && (
        <div className="border-t border-os-border p-3">
          <button
            onClick={onDisconnect}
            className="w-full rounded-lg border border-os-border px-3 py-1.5
                       font-mono text-xs text-os-muted transition
                       hover:border-red-500/40 hover:text-red-400"
          >
            Disconnect
          </button>
        </div>
      )}
    </aside>
  );
}
