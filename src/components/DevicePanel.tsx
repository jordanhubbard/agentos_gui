import { useState } from 'react';
import type { DeviceInfo } from '../types';
import { DEV_TYPE_NAME, DEV_TYPE_ICON, DEV_STATE, devStateColor, CC_DEV_TYPE_COUNT } from '../types';

const DEV_COLORS: Record<number, string> = {
  0: 'border-violet-500/30 bg-violet-500/5',
  1: 'border-sky-500/30 bg-sky-500/5',
  2: 'border-amber-500/30 bg-amber-500/5',
  3: 'border-emerald-500/30 bg-emerald-500/5',
  4: 'border-pink-500/30 bg-pink-500/5',
};

const DEV_ICON_COLOR: Record<number, string> = {
  0: 'text-violet-400',
  1: 'text-sky-400',
  2: 'text-amber-400',
  3: 'text-emerald-400',
  4: 'text-pink-400',
};

interface Props {
  devices: DeviceInfo[];
  onStatus: (devType: number, devHandle: number) => Promise<DeviceInfo>;
}

export function DevicePanel({ devices, onStatus }: Props) {
  const [messages, setMessages] = useState<Record<string, string>>({});
  const byType: Record<number, DeviceInfo[]> = {};
  for (let i = 0; i < CC_DEV_TYPE_COUNT; i++) byType[i] = [];
  for (const d of devices) (byType[d.dev_type] ??= []).push(d);

  if (devices.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-os-muted">
        <p className="font-mono text-sm">No devices reported</p>
      </div>
    );
  }

  async function probe(device: DeviceInfo) {
    const key = `${device.dev_type}:${device.dev_handle}`;
    setMessages(m => ({ ...m, [key]: 'probing...' }));
    try {
      const status = await onStatus(device.dev_type, device.dev_handle);
      setMessages(m => ({
        ...m,
        [key]: DEV_STATE[status.state] ?? `state-${status.state}`,
      }));
    } catch (e) {
      setMessages(m => ({ ...m, [key]: String(e) }));
    }
  }

  return (
    <div className="space-y-6">
      {Object.entries(byType).filter(([, list]) => list.length > 0).map(([typeStr, list]) => {
        const t = Number(typeStr);
        return (
          <div key={t}>
            <div className="mb-3 flex items-center gap-2">
              <span className={`text-lg ${DEV_ICON_COLOR[t]}`}>{DEV_TYPE_ICON[t]}</span>
              <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-os-muted">
                {DEV_TYPE_NAME[t] ?? `type-${t}`}
              </h3>
              <span className="ml-auto font-mono text-xs text-os-muted">{list.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {list.map(d => (
                <div
                  key={d.dev_handle}
                  className={`rounded-xl border p-4 ${DEV_COLORS[t] ?? 'border-os-border bg-os-surface'}`}
                >
                  <p className={`mb-1 text-2xl ${DEV_ICON_COLOR[t]}`}>{DEV_TYPE_ICON[t]}</p>
                  <p className="font-mono text-xs text-os-text">
                    handle 0x{d.dev_handle.toString(16).padStart(4, '0')}
                  </p>
                  <p className={`font-mono text-xs ${devStateColor(d.state)}`}>
                    {DEV_STATE[d.state] ?? `state-${d.state}`}
                  </p>
                  <button
                    onClick={() => probe(d)}
                    className="mt-3 rounded border border-os-border px-2 py-1 font-mono text-xs
                               text-os-muted transition hover:border-os-accent/50 hover:text-os-accent"
                  >
                    Probe
                  </button>
                  {messages[`${d.dev_type}:${d.dev_handle}`] && (
                    <p className="mt-2 truncate font-mono text-xs text-os-muted">
                      {messages[`${d.dev_type}:${d.dev_handle}`]}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
