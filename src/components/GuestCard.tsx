import { useState } from 'react';
import type { GuestInfo, SnapResult } from '../types';
import {
  GUEST_STATE, OS_TYPE, ARCH_TYPE, DEV_TYPE_NAME, DEV_TYPE_ICON,
  guestStateDot, guestStateColor,
} from '../types';

interface Props {
  guest:      GuestInfo;
  onSnapshot: (handle: number) => Promise<SnapResult>;
  onRestore:  (handle: number, lo: number, hi: number) => Promise<void>;
}

export function GuestCard({ guest, onSnapshot, onRestore }: Props) {
  const [snap, setSnap]   = useState<SnapResult | null>(null);
  const [busy, setBusy]   = useState(false);
  const [msg, setMsg]     = useState<string | null>(null);

  const devBits = (guest as any).device_flags as number | undefined;

  async function doSnapshot() {
    setBusy(true); setMsg(null);
    try {
      const s = await onSnapshot(guest.guest_handle);
      setSnap(s);
      setMsg(`✓ snapshot 0x${s.snap_hi.toString(16)}:${s.snap_lo.toString(16)}`);
    } catch (e) { setMsg(`✗ ${e}`); }
    finally { setBusy(false); }
  }

  async function doRestore() {
    if (!snap) return;
    setBusy(true); setMsg(null);
    try {
      await onRestore(guest.guest_handle, snap.snap_lo, snap.snap_hi);
      setMsg('✓ restore queued');
    } catch (e) { setMsg(`✗ ${e}`); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-os-border bg-os-surface p-5 transition
                    hover:border-os-accent/40">
      {/* Header */}
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

      {/* Meta row */}
      <div className="mb-4 flex gap-4 font-mono text-xs text-os-muted">
        <span>{ARCH_TYPE[guest.arch] ?? `arch-${guest.arch}`}</span>
        {devBits !== undefined && devBits > 0 && (
          <span className="flex gap-1.5">
            {[0, 1, 2, 3, 4].filter(i => devBits & (1 << i)).map(i => (
              <span key={i} title={DEV_TYPE_NAME[i]} className="text-os-text">
                {DEV_TYPE_ICON[i]}
              </span>
            ))}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={doSnapshot}
          disabled={busy}
          className="flex-1 rounded-lg border border-os-border px-3 py-1.5
                     font-mono text-xs text-os-muted transition
                     hover:border-os-accent/50 hover:text-os-accent
                     disabled:opacity-40"
        >
          Snapshot
        </button>
        <button
          onClick={doRestore}
          disabled={busy || !snap}
          className="flex-1 rounded-lg border border-os-border px-3 py-1.5
                     font-mono text-xs text-os-muted transition
                     hover:border-sky-500/50 hover:text-sky-400
                     disabled:opacity-40"
        >
          Restore
        </button>
      </div>

      {msg && (
        <p className={`mt-2 font-mono text-xs ${
          msg.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>
          {msg}
        </p>
      )}
    </div>
  );
}
