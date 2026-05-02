import {
  Activity,
  Braces,
  Cpu,
  HardDrive,
  Logs,
  Server,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import type { PoecatStatus } from '../types';

export type Tab = 'guests' | 'devices' | 'logs' | 'agents' | 'api';

interface Props {
  tab:       Tab;
  onTab:     (t: Tab) => void;
  connected: boolean;
  sockPath:  string;
  polecats:  PoecatStatus | null;
  onDisconnect: () => void;
}

const TABS: { id: Tab; label: string; icon: LucideIcon; shortcut: string }[] = [
  { id: 'guests',  label: 'Guests',  icon: Server,    shortcut: 'Cmd+1' },
  { id: 'devices', label: 'Devices', icon: HardDrive, shortcut: 'Cmd+2' },
  { id: 'logs',    label: 'Logs',    icon: Logs,      shortcut: 'Cmd+3' },
  { id: 'agents',  label: 'Agents',  icon: Cpu,       shortcut: 'Cmd+4' },
  { id: 'api',     label: 'API',     icon: Braces,    shortcut: 'Cmd+5' },
];

export function Sidebar({ tab, onTab, connected, sockPath, polecats, onDisconnect }: Props) {
  return (
    <aside className="flex h-full w-16 flex-none flex-col border-r border-os-border bg-os-surface sm:w-56">
      <div className="flex items-center justify-center gap-2.5 border-b border-os-border px-3 py-4 sm:justify-start sm:px-5">
        <div className="flex gap-1">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
        </div>
        <span className="hidden font-mono text-sm font-bold text-os-text sm:inline">
          agentOS
        </span>
      </div>

      <div className="border-b border-os-border px-3 py-3 sm:px-5">
        <div className="flex items-center justify-center gap-2 sm:justify-start">
          <span className={`h-2 w-2 rounded-full ${connected
            ? 'bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]'
            : 'bg-slate-600'}`}
          />
          <span className="hidden truncate font-mono text-xs text-os-muted sm:inline" title={sockPath}>
            {connected ? sockPath.split('/').pop() : 'disconnected'}
          </span>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-2 py-3">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              aria-label={t.label}
              onClick={() => onTab(t.id)}
              title={`${t.label} (${t.shortcut})`}
              className={`flex h-9 w-full items-center justify-center gap-3 rounded-lg px-3 text-left sm:justify-start
                          font-mono text-sm transition-colors
                          ${tab === t.id
                            ? 'bg-os-accent/15 text-os-accent'
                            : 'text-os-muted hover:bg-os-border/50 hover:text-os-text'}`}
            >
              <Icon aria-hidden="true" className="h-4 w-4 flex-none" strokeWidth={1.8} />
              <span className="hidden min-w-0 flex-1 truncate sm:block">{t.label}</span>
            </button>
          );
        })}
      </nav>

      {polecats && (
        <div className="hidden border-t border-os-border px-5 py-3 sm:block">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase text-os-muted">
            <Activity aria-hidden="true" className="h-3.5 w-3.5" />
            <span>Agent pool</span>
          </div>
          <div className="flex items-center gap-3 font-mono text-xs tabular-nums">
            <span className="text-emerald-400">{polecats.idle} idle</span>
            <span className="text-amber-400">{polecats.busy} busy</span>
            <span className="text-os-muted">{polecats.total} total</span>
          </div>
        </div>
      )}

      {connected && (
        <div className="border-t border-os-border p-3">
          <button
            onClick={onDisconnect}
            aria-label="Disconnect"
            className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-os-border px-3
                       font-mono text-xs text-os-muted transition
                       hover:border-red-500/40 hover:text-red-400"
          >
            <Unplug aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Disconnect</span>
          </button>
        </div>
      )}
    </aside>
  );
}
