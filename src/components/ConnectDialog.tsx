import { useState } from 'react';

const SOCK_PATH_KEY = 'cc_sock_path';

interface Props {
  onConnect: (path: string) => void;
  error:     string | null;
}

export function ConnectDialog({ onConnect, error }: Props) {
  const [path, setPath] = useState(
    () => localStorage.getItem(SOCK_PATH_KEY) ?? 'build/cc_pd.sock',
  );

  function handleConnect() {
    localStorage.setItem(SOCK_PATH_KEY, path);
    onConnect(path);
  }

  return (
    <div className="flex h-full items-center justify-center bg-os-bg">
      <div className="w-[480px] rounded-2xl border border-os-border bg-os-surface p-8 shadow-2xl">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex gap-1.5">
            <span className="h-3 w-3 rounded-full bg-red-500/80" />
            <span className="h-3 w-3 rounded-full bg-amber-500/80" />
            <span className="h-3 w-3 rounded-full bg-emerald-500/80" />
          </div>
          <h1 className="font-mono text-lg font-semibold tracking-tight text-os-text">
            agentOS
          </h1>
        </div>

        <p className="mb-6 text-sm text-os-muted">
          Connect to a running agentOS instance via the CC-PD socket.
        </p>

        <label className="mb-1 block text-xs font-medium uppercase tracking-widest text-os-muted">
          Socket path
        </label>
        <input
          className="mb-4 w-full rounded-lg border border-os-border bg-os-bg px-3 py-2
                     font-mono text-sm text-os-text placeholder:text-os-muted
                     focus:border-os-accent focus:outline-none"
          value={path}
          onChange={e => setPath(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleConnect()}
          placeholder="build/cc_pd.sock"
          spellCheck={false}
        />

        {error && (
          <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2
                        font-mono text-xs text-red-400">
            {error}
          </p>
        )}

        <button
          onClick={handleConnect}
          className="w-full rounded-lg bg-os-accent px-4 py-2.5 font-mono text-sm
                     font-semibold text-white transition hover:bg-os-accent/80
                     active:scale-[0.98]"
        >
          Connect
        </button>

        <p className="mt-4 text-center font-mono text-xs text-os-muted">
          Set <code className="text-os-accent">CC_PD_SOCK</code> to override the default path
        </p>
      </div>
    </div>
  );
}
