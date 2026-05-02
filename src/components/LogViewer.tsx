import { useEffect, useRef, useState } from 'react';
import { Download, Trash2 } from 'lucide-react';

interface Props {
  lines:    string[];
  onClear:  () => void;
  onFetch:  (slot: number, pdId: number) => Promise<string>;
}

export function LogViewer({ lines, onClear, onFetch }: Props) {
  const bottomRef  = useRef<HTMLDivElement>(null);
  const [slot, setSlot]   = useState(0);
  const [pdId, setPdId]   = useState(0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* PD selector */}
        <div className="flex items-center gap-1.5">
          <label htmlFor="log-slot" className="font-mono text-xs text-os-muted">slot</label>
          <input
            id="log-slot"
            type="number"
            min={0}
            value={slot}
            onChange={e => setSlot(Math.max(0, Number(e.target.value)))}
            className="w-14 rounded border border-os-border bg-os-bg px-2 py-1
                       font-mono text-xs text-os-text focus:border-os-accent focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="log-pd" className="font-mono text-xs text-os-muted">pd</label>
          <input
            id="log-pd"
            type="number"
            min={0}
            value={pdId}
            onChange={e => setPdId(Math.max(0, Number(e.target.value)))}
            className="w-14 rounded border border-os-border bg-os-bg px-2 py-1
                       font-mono text-xs text-os-text focus:border-os-accent focus:outline-none"
          />
        </div>

        <button
          onClick={() => onFetch(slot, pdId)}
          className="flex h-8 items-center gap-2 rounded-lg border border-os-border px-3
                     font-mono text-xs text-os-muted transition
                     hover:border-os-accent/50 hover:text-os-accent"
        >
          <Download aria-hidden="true" className="h-3.5 w-3.5" />
          Drain
        </button>
        <button
          onClick={onClear}
          className="flex h-8 items-center gap-2 rounded-lg border border-os-border px-3
                     font-mono text-xs text-os-muted transition
                     hover:border-red-500/40 hover:text-red-400"
        >
          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          Clear
        </button>

        <span className="ml-auto font-mono text-xs text-os-muted">{lines.length} lines</span>
      </div>

      <div className="flex-1 overflow-y-auto rounded-lg border border-os-border
                      bg-black/40 p-4 font-mono text-xs leading-relaxed">
        {lines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-os-muted">
            <p>No log output yet</p>
          </div>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={`${
                line.includes('ERROR') || line.includes('FAULT') || line.includes('error:')
                  ? 'text-red-400'
                  : line.includes('WARN')
                  ? 'text-amber-400'
                  : line.includes('ready') || line.includes('ok')
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
