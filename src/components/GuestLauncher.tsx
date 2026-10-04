import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import type { GuestCreateRequest, GuestCreateResult, GuestInfo } from '../types';
import {
  CC_DEV_TYPE_BLOCK, CC_DEV_TYPE_NET, CC_DEV_TYPE_SERIAL,
  DEV_TYPE_NAME,
} from '../types';
import { DeviceIcon } from './DeviceIcon';

interface Props {
  guests: GuestInfo[];
  selectedGuestHandle: number | null;
  onSelectGuest: (handle: number) => void;
  onCreate: (request: GuestCreateRequest) => Promise<GuestCreateResult>;
  onCreated: () => void;
}

const DEFAULT_FLAGS =
  (1 << CC_DEV_TYPE_SERIAL) |
  (1 << CC_DEV_TYPE_NET) |
  (1 << CC_DEV_TYPE_BLOCK);

export function GuestLauncher({
  guests,
  selectedGuestHandle,
  onSelectGuest,
  onCreate,
  onCreated,
}: Props) {
  const selected = guests.find(g => g.guest_handle === selectedGuestHandle) ?? null;
  const [osType, setOsType] = useState(selected?.os_type ?? 1);
  const [arch, setArch] = useState(selected?.arch ?? 1);
  const [ramDraft, setRamDraft] = useState('512');
  const [deviceFlags, setDeviceFlags] = useState(DEFAULT_FLAGS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (selected) {
      setOsType(selected.os_type);
      setArch(selected.arch);
    }
  }, [selected?.os_type, selected?.arch]);

  function pickOs(value: number) {
    setOsType(value);
    const match = guests.find(g => g.os_type === value && g.arch === arch)
      ?? guests.find(g => g.os_type === value);
    if (match) onSelectGuest(match.guest_handle);
  }

  function pickArch(value: number) {
    setArch(value);
    const match = guests.find(g => g.arch === value && g.os_type === osType)
      ?? guests.find(g => g.arch === value);
    if (match) onSelectGuest(match.guest_handle);
  }

  const hasGuestForOs = (value: number) => guests.some(g => g.os_type === value);
  const hasGuestForArch = (value: number) => guests.some(g => g.arch === value);

  function toggleDevice(devType: number) {
    setDeviceFlags(flags => flags ^ (1 << devType));
  }

  async function submit() {
    const ramMb = Number(ramDraft);
    if (!ramDraft.trim() || !Number.isInteger(ramMb) || ramMb < 128 || ramMb > 0xffffffff) {
      setMessage('RAM must be a whole number between 128 and 4294967295 MiB.');
      return;
    }
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
    <section className="rounded-lg border border-os-border bg-os-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-mono text-xs font-semibold uppercase text-os-muted">
          Launch
        </h3>
        <button
          onClick={submit}
          disabled={busy}
          className="flex h-8 items-center gap-2 rounded-lg border border-os-accent/40 px-3 font-mono text-xs
                     text-os-accent transition hover:border-os-accent hover:bg-os-accent/10
                     disabled:opacity-40"
        >
          <Play aria-hidden="true" className="h-3.5 w-3.5" />
          Start
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="flex rounded-lg border border-os-border p-1">
          {[
            { label: 'LNX', value: 1 },
            { label: 'BSD', value: 2 },
          ].map(option => {
            const running = hasGuestForOs(option.value);
            return (
              <button
                key={option.value}
                onClick={() => pickOs(option.value)}
                title={running ? 'Select running guest' : 'Set launch type'}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 font-mono text-xs transition ${
                  osType === option.value
                    ? 'bg-os-accent text-white'
                    : 'text-os-muted hover:text-os-text'
                }`}
              >
                {running && (
                  <span className={`h-1.5 w-1.5 rounded-full ${
                    osType === option.value ? 'bg-white' : 'bg-emerald-400'
                  }`} />
                )}
                {option.label}
              </button>
            );
          })}
        </div>

        <div className="flex rounded-lg border border-os-border p-1">
          {[
            { label: 'A64', value: 1 },
            { label: 'X64', value: 2 },
          ].map(option => {
            const running = hasGuestForArch(option.value);
            return (
              <button
                key={option.value}
                onClick={() => pickArch(option.value)}
                title={running ? 'Select running guest' : 'Set launch arch'}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 font-mono text-xs transition ${
                  arch === option.value
                    ? 'bg-os-accent text-white'
                    : 'text-os-muted hover:text-os-text'
                }`}
              >
                {running && (
                  <span className={`h-1.5 w-1.5 rounded-full ${
                    arch === option.value ? 'bg-white' : 'bg-emerald-400'
                  }`} />
                )}
                {option.label}
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-2 rounded-lg border border-os-border px-3 py-2">
          <span className="font-mono text-xs text-os-muted">RAM</span>
          <input
            type="number"
            min={128}
            max={0xffffffff}
            step={128}
            value={ramDraft}
            onChange={e => {
              setRamDraft(e.target.value);
              setMessage(null);
            }}
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
                className={`flex h-7 w-7 items-center justify-center rounded border transition ${
                  active
                    ? 'border-os-accent bg-os-accent/15 text-os-text'
                    : 'border-os-border text-os-muted hover:text-os-text'
                }`}
              >
                <DeviceIcon devType={devType} className="h-3.5 w-3.5" />
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
