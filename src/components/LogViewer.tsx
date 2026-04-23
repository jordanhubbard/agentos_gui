import { useEffect, useRef } from 'react';

interface Props {
  lines:    string[];
  onClear:  () => void;
  onFetch:  (slot: number, pdId: number) => void;
}

export function LogViewer({ lines, onClear, onFetch }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={() => onFetch(0, 0)}
            className="rounded-lg border border-os-border px-3 py-1.5
                       font-mono text-xs text-os-muted transition
                       hover:border-os-accent/50 hover:text-os-accent"
          >
            Drain
          </button>
          <button
            onClick={onClear}
            className="rounded-lg border border-os-border px-3 py-1.5
                       font-mono text-xs text-os-muted transition
                       hover:border-red-500/40 hover:text-red-400"
          >
            Clear
          </button>
        </div>
        <span className="font-mono text-xs text-os-muted">{lines.length} lines</span>
      </div>

      <div className="flex-1 overflow-y-auto rounded-xl border border-os-border
                      bg-black/40 p-4 font-mono text-xs leading-relaxed">
        {lines.length === 0 ? (
          <p className="text-os-muted">No log output yet — click Drain or wait for auto-poll.</p>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={`${
                line.includes('ERROR') || line.includes('FAULT') || line.includes('✗')
                  ? 'text-red-400'
                  : line.includes('WARN')
                  ? 'text-amber-400'
                  : line.includes('✓') || line.includes('ready') || line.includes('ok')
                  ? 'text-emerald-400'
                  : 'text-os-text/80'
              }`}
            >
              {line}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
