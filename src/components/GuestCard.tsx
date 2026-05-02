import { useState } from 'react';
import { AlertCircle, Camera, CheckCircle, PauseCircle, PlayCircle, Power, RotateCcw } from 'lucide-react';
import type { GuestInfo, GuestLifecycleResult, SnapResult } from '../types';
import {
  GUEST_STATE, OS_TYPE, ARCH_TYPE, DEV_TYPE_NAME,
  guestStateDot, guestStateColor,
} from '../types';
import { DeviceIcon } from './DeviceIcon';

interface Props {
  guest:      GuestInfo;
  onSnapshot: (handle: number) => Promise<SnapResult>;
  onRestore:  (handle: number, lo: number, hi: number) => Promise<void>;
  onSuspend:  (handle: number) => Promise<GuestLifecycleResult>;
  onResume:   (handle: number) => Promise<GuestLifecycleResult>;
  onDestroy:  (handle: number) => Promise<GuestLifecycleResult>;
  selected?: boolean;
  onSelect?: () => void;
}

export function GuestCard({
  guest,
  onSnapshot,
  onRestore,
  onSuspend,
  onResume,
  onDestroy,
  selected = false,
  onSelect,
}: Props) {
  const [snap, setSnap]   = useState<SnapResult | null>(null);
  const [busy, setBusy]   = useState(false);
  const [msg, setMsg]     = useState<string | null>(null);

  const devBits = (guest as any).device_flags as number | undefined;
  const isRunning = guest.state === 4;
  const isSuspended = guest.state === 5;
  const isDead = guest.state === 6;

  async function doSnapshot() {
    setBusy(true); setMsg(null);
    try {
      const s = await onSnapshot(guest.guest_handle);
      setSnap(s);
      setMsg(`snapshot 0x${s.snap_hi.toString(16)}:${s.snap_lo.toString(16)}`);
    } catch (e) { setMsg(`error: ${e}`); }
    finally { setBusy(false); }
  }

  async function doRestore() {
    if (!snap) return;
    setBusy(true); setMsg(null);
    try {
      await onRestore(guest.guest_handle, snap.snap_lo, snap.snap_hi);
      setMsg('restore queued');
    } catch (e) { setMsg(`error: ${e}`); }
    finally { setBusy(false); }
  }

  async function doLifecycle(
    action: 'suspend' | 'resume' | 'destroy',
    call: (handle: number) => Promise<GuestLifecycleResult>,
  ) {
    setBusy(true); setMsg(null);
    try {
      const result = await call(guest.guest_handle);
      const state = GUEST_STATE[result.state] ?? `state-${result.state}`;
      setMsg(`${action} ok: ${state}`);
    } catch (e) { setMsg(`error: ${e}`); }
    finally { setBusy(false); }
  }

  return (
    <div
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => {
        if ((e.key === 'Enter' || e.key === ' ') && onSelect) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`rounded-lg border bg-os-surface p-5 text-left transition
                    hover:border-os-accent/40 ${
                      selected ? 'border-os-accent/70 shadow-[0_0_0_1px_rgba(45,212,191,.25)]'
                      : 'border-os-border'
                    }`}
    >
      <div className="mb-4 flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <span className={`mt-0.5 h-2.5 w-2.5 flex-shrink-0 rounded-full ${guestStateDot(guest.state)}`} />
          <div>
            <p className="font-mono text-sm font-semibold text-os-text">
              {OS_TYPE[guest.os_type] ?? `type-${guest.os_type}`}
            </p>
            <p className="font-mono text-xs text-os-muted">
              handle 0x{guest.guest_handle.toString(16).padStart(8, '0')}
            </p>
          </div>
        </div>
        <span className={`font-mono text-xs font-medium ${guestStateColor(guest.state)}`}>
          {GUEST_STATE[guest.state] ?? `state-${guest.state}`}
        </span>
      </div>

      <div className="mb-4 flex gap-4 font-mono text-xs text-os-muted">
        <span>{ARCH_TYPE[guest.arch] ?? `arch-${guest.arch}`}</span>
        {devBits !== undefined && devBits > 0 && (
          <span className="flex gap-1.5">
            {[0, 1, 2, 3, 4].filter(i => devBits & (1 << i)).map(i => (
              <span key={i} title={DEV_TYPE_NAME[i]} className="text-os-text">
                <DeviceIcon devType={i} className="h-3.5 w-3.5" />
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <button
          onClick={e => { e.stopPropagation(); doSnapshot(); }}
          disabled={busy || isDead}
          className="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg border border-os-border px-3
                     font-mono text-xs text-os-muted transition
                     hover:border-os-accent/50 hover:text-os-accent
                     disabled:opacity-40"
        >
          <Camera aria-hidden="true" className="h-3.5 w-3.5" />
          Snapshot
        </button>
        <button
          onClick={e => { e.stopPropagation(); doRestore(); }}
          disabled={busy || !snap || isDead}
          className="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg border border-os-border px-3
                     font-mono text-xs text-os-muted transition
                     hover:border-sky-500/50 hover:text-sky-400
                     disabled:opacity-40"
        >
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          Restore
        </button>
        <button
          onClick={e => { e.stopPropagation(); doLifecycle('suspend', onSuspend); }}
          disabled={busy || !isRunning}
          className="flex h-8 items-center justify-center gap-2 rounded-lg border border-os-border px-3
                     font-mono text-xs text-os-muted transition
                     hover:border-sky-500/50 hover:text-sky-400
                     disabled:opacity-40"
        >
          <PauseCircle aria-hidden="true" className="h-3.5 w-3.5" />
          Suspend
        </button>
        <button
          onClick={e => { e.stopPropagation(); doLifecycle('resume', onResume); }}
          disabled={busy || !isSuspended}
          className="flex h-8 items-center justify-center gap-2 rounded-lg border border-os-border px-3
                     font-mono text-xs text-os-muted transition
                     hover:border-emerald-500/50 hover:text-emerald-400
                     disabled:opacity-40"
        >
          <PlayCircle aria-hidden="true" className="h-3.5 w-3.5" />
          Resume
        </button>
        <button
          onClick={e => { e.stopPropagation(); doLifecycle('destroy', onDestroy); }}
          disabled={busy || isDead}
          className="flex h-8 items-center justify-center gap-2 rounded-lg border border-red-500/35 px-3
                     font-mono text-xs text-red-300 transition hover:bg-red-500/10
                     disabled:opacity-40"
        >
          <Power aria-hidden="true" className="h-3.5 w-3.5" />
          Destroy
        </button>
      </div>

      {msg && (
        <p className={`mt-2 flex items-center gap-2 font-mono text-xs ${
          msg.startsWith('error:') ? 'text-red-400' : 'text-emerald-400'}`}>
          {msg.startsWith('error:')
            ? <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 flex-none" />
            : <CheckCircle aria-hidden="true" className="h-3.5 w-3.5 flex-none" />}
          {msg}
        </p>
      )}
    </div>
  );
}
