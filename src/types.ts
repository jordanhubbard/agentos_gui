// Types mirroring cc_contract.h — keep in sync with agentOS contracts

export interface GuestInfo {
  guest_handle: number;
  state:        number;
  os_type:      number;
  arch:         number;
  device_flags?: number;
}

export interface GuestStatus extends GuestInfo {
  device_flags: number;
}

export interface DeviceInfo {
  dev_type:   number;
  dev_handle: number;
  state:      number;
}

export type DeviceStatusInfo = DeviceInfo;

export interface PoecatStatus {
  total: number;
  busy:  number;
  idle:  number;
}

export interface SnapResult {
  snap_lo: number;
  snap_hi: number;
}

export interface GuestCreateRequest {
  os_type:      number;
  arch:         number;
  ram_mb:       number;
  device_flags: number;
}

export interface GuestCreateResult {
  handle: number;
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
  1: 'Binding',
  2: 'Ready',
  3: 'Booting',
  4: 'Running',
  5: 'Suspended',
  6: 'Dead',
};

export const OS_TYPE: Record<number, string> = {
  1: 'Linux',
  2: 'FreeBSD',
};

export const ARCH_TYPE: Record<number, string> = {
  1: 'aarch64',
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

export const CC_DEV_TYPE_SERIAL = 0;
export const CC_DEV_TYPE_NET = 1;
export const CC_DEV_TYPE_BLOCK = 2;
export const CC_DEV_TYPE_USB = 3;
export const CC_DEV_TYPE_FB = 4;
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
export const CC_INPUT_RAW_BYTE_BASE = 0x100;

export function rawTerminalKeycode(byte: number): number {
  return CC_INPUT_RAW_BYTE_BASE | (byte & 0xff);
}

export function guestStateColor(state: number): string {
  switch (state) {
    case 4: return 'text-emerald-400';   // Running
    case 3: return 'text-amber-400';     // Booting
    case 2: return 'text-sky-400';       // Ready
    case 5: return 'text-sky-400';       // Suspended
    case 6: return 'text-red-400';       // Dead
    default: return 'text-slate-400';
  }
}

export function guestStateDot(state: number): string {
  switch (state) {
    case 4: return 'bg-emerald-400';
    case 3: return 'bg-amber-400 animate-pulse';
    case 2: return 'bg-sky-400';
    case 5: return 'bg-sky-400';
    case 6: return 'bg-red-500';
    default: return 'bg-slate-500';
  }
}
