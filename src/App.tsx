import { useState } from 'react';
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
              <p className="font-mono text-xs text-red-400">{state.error}</p>
            )}
            <button
              onClick={refresh}
              disabled={state.refreshing}
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
              <div className="flex h-full items-center justify-center">
                <p className="font-mono text-sm text-os-muted">No guest OS instances running</p>
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
