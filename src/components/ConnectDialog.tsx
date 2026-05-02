import { useEffect, useState } from 'react';
import { PlugZap } from 'lucide-react';

const SOCK_PATH_KEY    = 'cc_sock_path';
const SOCK_HISTORY_KEY = 'cc_sock_history';
const MAX_HISTORY      = 5;
const FALLBACK_SOCK_PATH = 'build/cc_pd.sock';

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
  defaultPath: string;
  onConnect: (path: string) => void;
  error:     string | null;
}

export function ConnectDialog({ defaultPath, onConnect, error }: Props) {
  const [path, setPath] = useState(
    () => localStorage.getItem(SOCK_PATH_KEY) ?? defaultPath,
  );
  const [history] = useState<string[]>(loadHistory);

  useEffect(() => {
    const storedPath = localStorage.getItem(SOCK_PATH_KEY);
    if (defaultPath && (!storedPath || defaultPath !== FALLBACK_SOCK_PATH)) {
      setPath(defaultPath);
    }
  }, [defaultPath]);

  function handleConnect() {
    const trimmed = path.trim();
    if (!trimmed) return;
    saveHistory(trimmed);
    onConnect(trimmed);
  }

  return (
    <div className="flex h-full items-center justify-center bg-os-bg">
      <div className="w-[480px] rounded-lg border border-os-border bg-os-surface p-8 shadow-2xl">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex gap-1.5">
            <span className="h-3 w-3 rounded-full bg-red-500/80" />
            <span className="h-3 w-3 rounded-full bg-amber-500/80" />
            <span className="h-3 w-3 rounded-full bg-emerald-500/80" />
          </div>
          <h1 className="font-mono text-lg font-semibold text-os-text">
            agentOS
          </h1>
        </div>

        <label className="mb-1 block text-xs font-medium uppercase text-os-muted">
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
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-os-accent px-4
                     font-mono text-sm font-semibold text-slate-950 transition hover:bg-os-accent/80
                     active:scale-[0.98]"
        >
          <PlugZap aria-hidden="true" className="h-4 w-4" />
          Connect
        </button>
      </div>
    </div>
  );
}
