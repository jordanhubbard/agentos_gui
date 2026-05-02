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

export interface SessionInfo {
  session_id:          number;
  state:               number;
  client_badge:        number;
  ticks_since_active:  number;
}

export interface SessionStatus {
  session_id:          number;
  state:               number;
  pending_responses:   number;
  ticks_since_active:  number;
}

export interface SessionSendResult {
  ok:           number;
  resp_pending: number;
}

export interface SessionRecvResult {
  ok:   number;
  len:  number;
  text: string;
  hex:  string;
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

export interface GuestLifecycleResult {
  ok:    number;
  state: number;
}

export interface InputEvent {
  event_type: number;
  keycode:    number;
  dx:         number;
  dy:         number;
  btn_mask:   number;
}

export interface FaultInjectResult {
  result:            number;
  ticks_to_recovery: number;
  trace_event_id:    number;
}

export interface TraceStatus {
  ok:             number;
  event_count:    number;
  bytes_used:     number;
  overflow_count: number;
}

export interface TraceEntry {
  timestamp_ns: number;
  from_pd:      number;
  to_pd:        number;
  channel:      number;
  opcode:       number;
  seq_lo:       number;
}

export interface TraceDumpResult {
  ok:             number;
  events_written: number;
  bytes_written:  number;
  overflow_count: number;
  events:         TraceEntry[];
}

export interface TrafficEvent {
  seq:           number;
  at_ms:         number;
  opcode:        number;
  opcode_name:   string;
  mr:            [number, number, number];
  reply_mr:      [number, number, number, number];
  shmem_in_len:  number;
  shmem_out_len: number;
  ok:            boolean;
  error:         string | null;
  duration_ms:   number;
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

export const CC_DEV_TYPE_SERIAL = 0;
export const CC_DEV_TYPE_NET = 1;
export const CC_DEV_TYPE_BLOCK = 2;
export const CC_DEV_TYPE_USB = 3;
export const CC_DEV_TYPE_FB = 4;
export const CC_DEV_TYPE_COUNT = 5;

export const CC_CMD_TYPE_QUERY = 0x01;
export const CC_CMD_TYPE_ACTION = 0x02;
export const CC_CMD_TYPE_STREAM = 0x03;

export const CC_SESSION_STATE: Record<number, string> = {
  0: 'Connected',
  1: 'Idle',
  2: 'Busy',
  3: 'Expired',
};

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

export const CC_API_SURFACE = [
  { opcode: '0x2601', name: 'CONNECT', surface: 'connection' },
  { opcode: '0x2602', name: 'DISCONNECT', surface: 'connection' },
  { opcode: '0x2603', name: 'SEND', surface: 'api' },
  { opcode: '0x2604', name: 'RECV', surface: 'api' },
  { opcode: '0x2605', name: 'STATUS', surface: 'api' },
  { opcode: '0x2606', name: 'LIST', surface: 'api' },
  { opcode: '0x2607', name: 'LIST_GUESTS', surface: 'guests' },
  { opcode: '0x2608', name: 'LIST_DEVICES', surface: 'devices' },
  { opcode: '0x2609', name: 'LIST_POLECATS', surface: 'agents' },
  { opcode: '0x260a', name: 'GUEST_STATUS', surface: 'guests' },
  { opcode: '0x260b', name: 'DEVICE_STATUS', surface: 'devices' },
  { opcode: '0x260c', name: 'ATTACH_FRAMEBUFFER', surface: 'api' },
  { opcode: '0x260d', name: 'SEND_INPUT', surface: 'console' },
  { opcode: '0x260e', name: 'SNAPSHOT', surface: 'guests' },
  { opcode: '0x260f', name: 'RESTORE', surface: 'guests' },
  { opcode: '0x2610', name: 'LOG_STREAM', surface: 'logs' },
  { opcode: '0x2611', name: 'CREATE_GUEST', surface: 'guests' },
  { opcode: '0x2612', name: 'FAULT_INJECT', surface: 'api' },
  { opcode: '0x2613', name: 'SUSPEND_GUEST', surface: 'guests' },
  { opcode: '0x2614', name: 'RESUME_GUEST', surface: 'guests' },
  { opcode: '0x2615', name: 'DESTROY_GUEST', surface: 'guests' },
  { opcode: '0x2616', name: 'TRACE_START', surface: 'trace' },
  { opcode: '0x2617', name: 'TRACE_STOP', surface: 'trace' },
  { opcode: '0x2618', name: 'TRACE_QUERY', surface: 'trace' },
  { opcode: '0x2619', name: 'TRACE_DUMP', surface: 'trace' },
] as const;

export const TRACE_PD_NAME: Record<number, string> = {
  0: 'controller',
  12: 'vibe_engine',
  20: 'fault_handler',
  25: 'trace_recorder',
  41: 'linux_vmm',
  42: 'freebsd_vmm',
  43: 'cc_pd',
};

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
