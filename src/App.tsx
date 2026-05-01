import { useState, useEffect } from 'react';
import { useAgentOS } from './hooks/useAgentOS';
import { ConnectDialog } from './components/ConnectDialog';
import { Sidebar, type Tab } from './components/Sidebar';
import { GuestCard } from './components/GuestCard';
import { GuestConsole } from './components/GuestConsole';
import { GuestLauncher } from './components/GuestLauncher';
import { DevicePanel } from './components/DevicePanel';
import { LogViewer } from './components/LogViewer';
import { AgentPool } from './components/AgentPool';

export default function App() {
  const {
    state, connect, disconnect, refresh, fetchLogs, snapshot, restore,
    sendInput, deviceStatus, createGuest, clearLogs,
  } =
    useAgentOS();
  const [tab, setTab] = useState<Tab>('guests');
  const [selectedGuestHandle, setSelectedGuestHandle] = useState<number | null>(null);

  const selectedGuest = state.guests.find(g => g.guest_handle === selectedGuestHandle)
    ?? state.guests[0]
    ?? null;

  useEffect(() => {
    if (state.guests.length === 0) {
      setSelectedGuestHandle(null);
      return;
    }
    if (!selectedGuest || !state.guests.some(g => g.guest_handle === selectedGuest.guest_handle)) {
      setSelectedGuestHandle(state.guests[0].guest_handle);
    }
  }, [state.guests, selectedGuest]);

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
    return (
      <ConnectDialog
        defaultPath={state.sockPath}
        onConnect={connect}
        error={state.error}
      />
    );
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
            <div className="space-y-5">
              <GuestLauncher onCreate={createGuest} onCreated={refresh} />

              {state.guests.length === 0 ? (
                <div className="flex min-h-[20rem] flex-col items-center justify-center gap-3 text-os-muted">
                  <p className="font-mono text-sm">No guest OS instances running</p>
                  <button
                    onClick={refresh}
                    className="mt-2 rounded-lg border border-os-border px-4 py-2 font-mono text-xs
                               text-os-muted transition hover:border-os-accent/50 hover:text-os-accent"
                  >
                    ⟳ Refresh
                  </button>
                </div>
              ) : (
                <div className="grid gap-5 xl:grid-cols-[minmax(22rem,32rem)_1fr]">
                  <div className="grid content-start gap-4">
                    {state.guests.map(g => (
                      <GuestCard
                        key={g.guest_handle}
                        guest={g}
                        selected={selectedGuest?.guest_handle === g.guest_handle}
                        onSelect={() => setSelectedGuestHandle(g.guest_handle)}
                        onSnapshot={snapshot}
                        onRestore={restore}
                      />
                    ))}
                  </div>
                  <GuestConsole
                    guest={selectedGuest}
                    lines={state.logLines}
                    onFetch={fetchLogs}
                    onSendInput={sendInput}
                  />
                </div>
              )}
            </div>
          )}

          {tab === 'devices' && <DevicePanel devices={state.devices} onStatus={deviceStatus} />}

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
