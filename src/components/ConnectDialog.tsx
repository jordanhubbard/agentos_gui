import { useEffect, useState } from 'react';
import { PlugZap } from 'lucide-react';

interface Props {
  defaultPath: string;
  // Every socket path the backend will actually accept (see
  // cc_allowed_sock_paths / allowed_sock_paths() in src-tauri/src/
  // commands.rs), with the currently resolved default first. The backend
  // rejects anything else, so this dialog only ever offers paths drawn from
  // this list rather than free text it would have to reject.
  sockPathOptions: string[];
  onConnect: (path: string) => void;
  error:     string | null;
}

export function ConnectDialog({ defaultPath, sockPathOptions, onConnect, error }: Props) {
  const options = sockPathOptions.length > 0 ? sockPathOptions : [defaultPath];
  const [selected, setSelected] = useState(defaultPath || options[0]);

  // The backend resolves its default once at startup and reports it (and
  // every other candidate) asynchronously after mount — pick it up once it
  // arrives instead of sticking with the initial placeholder value.
  useEffect(() => {
    if (defaultPath) setSelected(defaultPath);
  }, [defaultPath]);

  function handleConnect() {
    const trimmed = selected.trim();
    if (!trimmed) return;
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

        <label htmlFor="cc-sock-path" className="mb-1 block text-xs font-medium uppercase text-os-muted">
          Socket path
        </label>
        <input
          id="cc-sock-path"
          className="mb-2 w-full cursor-not-allowed rounded-lg border border-os-border bg-os-bg px-3 py-2
                     font-mono text-sm text-os-muted"
          value={selected}
          readOnly
          spellCheck={false}
          onKeyDown={e => e.key === 'Enter' && handleConnect()}
        />

        {options.length > 1 && (
          <div className="mb-2">
            <label htmlFor="cc-sock-path-picker" className="mb-1 block text-xs font-medium uppercase text-os-muted">
              Known locations
            </label>
            <select
              id="cc-sock-path-picker"
              value={selected}
              onChange={e => setSelected(e.target.value)}
              className="w-full rounded-lg border border-os-border bg-os-bg px-3 py-2
                         font-mono text-sm text-os-text focus:border-os-accent focus:outline-none"
            >
              {options.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        )}

        <p className="mb-4 font-mono text-[11px] leading-relaxed text-os-muted">
          This client only connects to an agentOS-resolved socket location — it cannot
          be pointed at an arbitrary path. To use a different one, relaunch with{' '}
          <code className="text-os-text">CC_PD_SOCK=/path/to/cc_pd.sock</code>.
        </p>

        {error && (
          <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2
                        font-mono text-xs text-red-400">
            {error}
          </p>
        )}

        <button
          onClick={handleConnect}
          autoFocus
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
