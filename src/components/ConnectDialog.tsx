import { useState } from 'react';

const SOCK_PATH_KEY    = 'cc_sock_path';
const SOCK_HISTORY_KEY = 'cc_sock_history';
const MAX_HISTORY      = 5;

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(SOCK_HISTORY_KEY) ?? '[]'); }
  catch { return []; }
}

function saveHistory(path: string) {
  const h = [path, ...loadHistory().filter(p => p !== path)].slice(0, MAX_HISTORY);
  localStorage.setItem(SOCK_HISTORY_KEY, JSON.stringify(h));
  localStorage.setItem(SOCK_PATH_KEY, path);
}

interface Props {
  onConnect: (path: string) => void;
  error:     string | null;
}

export function ConnectDialog({ onConnect, error }: Props) {
  const [path, setPath] = useState(
    () => localStorage.getItem(SOCK_PATH_KEY) ?? 'build/cc_pd.sock',
  );
  const [history] = useState<string[]>(loadHistory);

  function handleConnect() {
    const trimmed = path.trim();
    if (!trimmed) return;
    saveHistory(trimmed);
    onConnect(trimmed);
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
          Connect to a running agentOS instance via the CC-PD Unix socket.
        </p>

        <label className="mb-1 block text-xs font-medium uppercase tracking-widest text-os-muted">
          Socket path
        </label>
        <input
          className="mb-2 w-full rounded-lg border border-os-border bg-os-bg px-3 py-2
                     font-mono text-sm text-os-text placeholder:text-os-muted
                     focus:border-os-accent focus:outline-none"
          value={path}
          onChange={e => setPath(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleConnect()}
          placeholder="build/cc_pd.sock"
          spellCheck={false}
          autoFocus
        />

        {/* Recent paths */}
        {history.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-1.5">
            {history.map(p => (
              <button
                key={p}
                onClick={() => setPath(p)}
                className={`rounded border px-2 py-0.5 font-mono text-xs transition
                            ${p === path
                              ? 'border-os-accent/50 text-os-accent'
                              : 'border-os-border text-os-muted hover:border-os-accent/40 hover:text-os-text'}`}
              >
                {p.split('/').pop()}
              </button>
            ))}
          </div>
        )}

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
          Press <kbd className="rounded border border-os-border px-1 py-0.5">Enter</kbd> to connect
          &nbsp;·&nbsp;
          Set <code className="text-os-accent">CC_PD_SOCK</code> to override the default
        </p>
      </div>
    </div>
  );
}
