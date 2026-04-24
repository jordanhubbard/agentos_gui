import { useState, useEffect } from 'react';
import { useAgentOS } from './hooks/useAgentOS';
import { ConnectDialog } from './components/ConnectDialog';
import { Sidebar, type Tab } from './components/Sidebar';
import { GuestCard } from './components/GuestCard';
import { DevicePanel } from './components/DevicePanel';
import { LogViewer } from './components/LogViewer';
import { AgentPool } from './components/AgentPool';

export default function App() {
  const { state, connect, disconnect, refresh, fetchLogs, snapshot, restore, clearLogs } =
    useAgentOS();
  const [tab, setTab] = useState<Tab>('guests');

  useEffect(() => {
    if (!state.connected) return;
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === 'r') { e.preventDefault(); refresh(); }
      if (meta && e.key === '1') { e.preventDefault(); setTab('guests'); }
      if (meta && e.key === '2') { e.preventDefault(); setTab('devices'); }
      if (meta && e.key === '3') { e.preventDefault(); setTab('logs'); }
      if (meta && e.key === '4') { e.preventDefault(); setTab('agents'); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state.connected, refresh]);

  if (!state.connected) {
    return <ConnectDialog onConnect={connect} error={state.error} />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-os-bg text-os-text">
      <Sidebar
        tab={tab}
        onTab={setTab}
        connected={state.connected}
        sockPath={state.sockPath}
        polecats={state.polecats}
        onDisconnect={disconnect}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center justify-between border-b border-os-border
                           bg-os-surface px-6 py-3">
          <h2 className="font-mono text-sm font-semibold capitalize text-os-text">
            {tab}
          </h2>
          <div className="flex items-center gap-3">
            {state.error && (
              <p className="max-w-xs truncate font-mono text-xs text-red-400" title={state.error}>
                {state.error}
              </p>
            )}
            <button
              onClick={refresh}
              disabled={state.refreshing}
              title="Refresh (⌘R)"
              className="rounded-lg border border-os-border px-3 py-1 font-mono text-xs
                         text-os-muted transition hover:border-os-accent/50 hover:text-os-accent
                         disabled:opacity-40"
            >
              {state.refreshing ? '⟳ refreshing…' : '⟳ refresh'}
            </button>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === 'guests' && (
            state.guests.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-os-muted">
                <p className="font-mono text-sm">No guest OS instances running</p>
                <p className="font-mono text-xs opacity-60">
                  Use <code className="text-os-accent">VOS_CREATE</code> via the CC-PD API to launch a guest
                </p>
                <button
                  onClick={refresh}
                  className="mt-2 rounded-lg border border-os-border px-4 py-2 font-mono text-xs
                             text-os-muted transition hover:border-os-accent/50 hover:text-os-accent"
                >
                  ⟳ Refresh
                </button>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {state.guests.map(g => (
                  <GuestCard
                    key={g.guest_handle}
                    guest={g}
                    onSnapshot={snapshot}
                    onRestore={restore}
                  />
                ))}
              </div>
            )
          )}

          {tab === 'devices' && <DevicePanel devices={state.devices} />}

          {tab === 'logs' && (
            <LogViewer
              lines={state.logLines}
              onClear={clearLogs}
              onFetch={fetchLogs}
            />
          )}

          {tab === 'agents' && <AgentPool polecats={state.polecats} />}
        </div>
      </main>
    </div>
  );
}
