import { useState } from 'react';
import type { GuestCreateRequest, GuestCreateResult } from '../types';
import {
  CC_DEV_TYPE_BLOCK, CC_DEV_TYPE_NET, CC_DEV_TYPE_SERIAL,
  DEV_TYPE_ICON, DEV_TYPE_NAME,
} from '../types';

interface Props {
  onCreate: (request: GuestCreateRequest) => Promise<GuestCreateResult>;
  onCreated: () => void;
}

const DEFAULT_FLAGS =
  (1 << CC_DEV_TYPE_SERIAL) |
  (1 << CC_DEV_TYPE_NET) |
  (1 << CC_DEV_TYPE_BLOCK);

export function GuestLauncher({ onCreate, onCreated }: Props) {
  const [osType, setOsType] = useState(1);
  const [arch, setArch] = useState(1);
  const [ramMb, setRamMb] = useState(512);
  const [deviceFlags, setDeviceFlags] = useState(DEFAULT_FLAGS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function toggleDevice(devType: number) {
    setDeviceFlags(flags => flags ^ (1 << devType));
  }

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await onCreate({
        os_type: osType,
        arch,
        ram_mb: ramMb,
        device_flags: deviceFlags,
      });
      setMessage(`created handle 0x${result.handle.toString(16).padStart(8, '0')}`);
      onCreated();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-os-border bg-os-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-os-muted">
          Launch
        </h3>
        <button
          onClick={submit}
          disabled={busy}
          className="rounded-lg border border-os-accent/40 px-3 py-1.5 font-mono text-xs
                     text-os-accent transition hover:border-os-accent hover:bg-os-accent/10
                     disabled:opacity-40"
        >
          Start
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="flex rounded-lg border border-os-border p-1">
          {[
            { label: 'LNX', value: 1 },
            { label: 'BSD', value: 2 },
          ].map(option => (
            <button
              key={option.value}
              onClick={() => setOsType(option.value)}
              className={`flex-1 rounded px-2 py-1.5 font-mono text-xs transition ${
                osType === option.value
                  ? 'bg-os-accent text-white'
                  : 'text-os-muted hover:text-os-text'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="flex rounded-lg border border-os-border p-1">
          {[
            { label: 'A64', value: 1 },
            { label: 'X64', value: 2 },
          ].map(option => (
            <button
              key={option.value}
              onClick={() => setArch(option.value)}
              className={`flex-1 rounded px-2 py-1.5 font-mono text-xs transition ${
                arch === option.value
                  ? 'bg-os-accent text-white'
                  : 'text-os-muted hover:text-os-text'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 rounded-lg border border-os-border px-3 py-2">
          <span className="font-mono text-xs text-os-muted">RAM</span>
          <input
            type="number"
            min={128}
            step={128}
            value={ramMb}
            onChange={e => setRamMb(Math.max(128, Number(e.target.value)))}
            className="min-w-0 flex-1 bg-transparent text-right font-mono text-xs text-os-text
                       focus:outline-none"
          />
          <span className="font-mono text-xs text-os-muted">MiB</span>
        </label>

        <div className="flex items-center gap-2 rounded-lg border border-os-border px-3 py-2">
          {[CC_DEV_TYPE_SERIAL, CC_DEV_TYPE_NET, CC_DEV_TYPE_BLOCK].map(devType => {
            const active = Boolean(deviceFlags & (1 << devType));
            return (
              <button
                key={devType}
                onClick={() => toggleDevice(devType)}
                title={DEV_TYPE_NAME[devType]}
                className={`h-7 w-7 rounded border font-mono text-xs transition ${
                  active
                    ? 'border-os-accent bg-os-accent/15 text-os-text'
                    : 'border-os-border text-os-muted hover:text-os-text'
                }`}
              >
                {DEV_TYPE_ICON[devType]}
              </button>
            );
          })}
        </div>
      </div>

      {message && (
        <p className={`mt-3 truncate font-mono text-xs ${
          message.startsWith('created') ? 'text-emerald-400' : 'text-amber-400'
        }`} title={message}>
          {message}
        </p>
      )}
    </section>
  );
}
