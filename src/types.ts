// Types mirroring cc_contract.h — keep in sync with agentOS contracts

export interface GuestInfo {
  guest_handle: number;
  state:        number;
  os_type:      number;
  arch:         number;
}

export interface GuestStatus extends GuestInfo {
  device_flags: number;
}

export interface DeviceInfo {
  dev_type:   number;
  dev_handle: number;
  state:      number;
}

export interface PoecatStatus {
  total: number;
  busy:  number;
  idle:  number;
}

export interface SnapResult {
  snap_lo: number;
  snap_hi: number;
}

export interface InputEvent {
  event_type: number;
  keycode:    number;
  dx:         number;
  dy:         number;
  btn_mask:   number;
}

// ── Enum decoders ─────────────────────────────────────────────────────────────

export const GUEST_STATE: Record<number, string> = {
  0: 'Creating',
  1: 'Booting',
  2: 'Running',
  3: 'Paused',
  4: 'Stopping',
  5: 'Stopped',
  6: 'Snapshotting',
  7: 'Restoring',
  8: 'Error',
};

export const OS_TYPE: Record<number, string> = {
  0: 'Linux',
  1: 'FreeBSD',
  2: 'NixOS',
  3: 'Custom',
};

export const ARCH_TYPE: Record<number, string> = {
  0: 'aarch64',
  1: 'riscv64',
  2: 'x86_64',
};

export const DEV_TYPE_NAME: Record<number, string> = {
  0: 'Serial',
  1: 'Network',
  2: 'Block',
  3: 'USB',
  4: 'Framebuffer',
};

export const DEV_TYPE_ICON: Record<number, string> = {
  0: '⎍',  // serial
  1: '⏁',  // network
  2: '▤',  // block
  3: '⍾',  // usb
  4: '▣',  // framebuffer
};

export const CC_DEV_TYPE_COUNT = 5;

export const DEV_STATE: Record<number, string> = {
  0: 'Idle',
  1: 'Active',
  2: 'Error',
  3: 'Suspended',
};

export function devStateColor(state: number): string {
  switch (state) {
    case 0: return 'text-slate-400';
    case 1: return 'text-emerald-400';
    case 2: return 'text-red-400';
    case 3: return 'text-sky-400';
    default: return 'text-slate-400';
  }
}

// Input event types
export const CC_INPUT_KEY_DOWN   = 0x01;
export const CC_INPUT_KEY_UP     = 0x02;
export const CC_INPUT_MOUSE_MOVE = 0x03;
export const CC_INPUT_MOUSE_BTN  = 0x04;

export function guestStateColor(state: number): string {
  switch (state) {
    case 2: return 'text-emerald-400';   // Running
    case 1: return 'text-amber-400';     // Booting
    case 3: return 'text-sky-400';       // Paused
    case 8: return 'text-red-400';       // Error
    default: return 'text-slate-400';
  }
}

export function guestStateDot(state: number): string {
  switch (state) {
    case 2: return 'bg-emerald-400';
    case 1: return 'bg-amber-400 animate-pulse';
    case 3: return 'bg-sky-400';
    case 8: return 'bg-red-500';
    default: return 'bg-slate-500';
  }
}
