import type { Page } from '@playwright/test';

// Default mock responses matching the real CC-PD contract shapes.
export const DEFAULT_MOCKS: Record<string, unknown> = {
  cc_connect:            'connected',
  cc_disconnect:         null,
  cc_is_connected:       true,
  cc_get_sock_path:      'build/cc_pd.sock',
  cc_should_autoconnect: false,
  cc_list_sessions: [
    { session_id: 0, state: 0, client_badge: 0xa6e70002, ticks_since_active: 0 },
  ],
  cc_session_status:     { session_id: 0, state: 0, pending_responses: 0, ticks_since_active: 0 },
  cc_session_send:       { ok: 0, resp_pending: 1 },
  cc_session_recv:       { ok: 0, len: 0, text: '', hex: '' },
  cc_traffic_events: [
    {
      seq: 1,
      at_ms: 0,
      opcode: 0x2607,
      opcode_name: 'LIST_GUESTS',
      mr: [16, 0, 0],
      reply_mr: [2, 0, 0, 0],
      shmem_in_len: 0,
      shmem_out_len: 32,
      ok: true,
      error: null,
      duration_ms: 1,
    },
    {
      seq: 2,
      at_ms: 0,
      opcode: 0x2610,
      opcode_name: 'LOG_STREAM',
      mr: [0, 0, 0],
      reply_mr: [0, 128, 0, 0],
      shmem_in_len: 0,
      shmem_out_len: 128,
      ok: true,
      error: null,
      duration_ms: 2,
    },
  ],
  cc_list_guests: [
    { guest_handle: 1, state: 4, os_type: 1, arch: 1 },  // Linux aarch64 Running
    { guest_handle: 2, state: 3, os_type: 2, arch: 2 },  // FreeBSD x86_64 Booting
  ],
  cc_guest_status:       { guest_handle: 1, state: 4, os_type: 1, arch: 1, device_flags: 7 },
  cc_list_devices: [
    { dev_type: 0, dev_handle:  1, state: 1 },  // Serial
    { dev_type: 1, dev_handle:  2, state: 1 },  // Network
    { dev_type: 4, dev_handle: 10, state: 1 },  // Framebuffer
  ],
  cc_list_polecats:      { total: 8, busy: 3, idle: 5 },
  cc_log_stream:         '',
  cc_snapshot:           { snap_lo: 1, snap_hi: 2 },
  cc_restore:            null,
  cc_create_guest:       { handle: 3 },
  cc_suspend_guest:      { ok: 0, state: 5 },
  cc_resume_guest:       { ok: 0, state: 4 },
  cc_destroy_guest:      { ok: 0, state: 6 },
  cc_send_input:         null,
  cc_device_status:      { dev_type: 0, dev_handle: 1, state: 1 },
  cc_attach_framebuffer: 1,
  cc_fault_inject:       { result: 0, ticks_to_recovery: 0, trace_event_id: 0 },
  cc_trace_start:        { ok: 0, event_count: 0, bytes_used: 0, overflow_count: 0 },
  cc_trace_stop:         { ok: 0, event_count: 3, bytes_used: 0, overflow_count: 0 },
  cc_trace_query:        { ok: 0, event_count: 2, bytes_used: 32, overflow_count: 0 },
  cc_trace_dump: {
    ok: 0,
    events_written: 2,
    bytes_written: 32,
    overflow_count: 0,
    events: [
      { timestamp_ns: 1000, from_pd: 43, to_pd: 12, channel: 40, opcode: 0x2607, seq_lo: 0 },
      { timestamp_ns: 2000, from_pd: 43, to_pd: 41, channel: 75, opcode: 0x260d, seq_lo: 1 },
    ],
  },
};

export type MockOverrides = Partial<Record<string, unknown>>;

// Encode an error response — the mock will throw this string instead of returning.
export function mockError(message: string) {
  return { __error__: message };
}

/**
 * Install window.__TAURI_INTERNALS__ before page scripts run so that every
 * invoke() call hits our mock table.  Call before page.goto().
 */
export async function setupTauriMock(
  page: Page,
  overrides: MockOverrides = {},
): Promise<void> {
  const mocks = { ...DEFAULT_MOCKS, ...overrides };

  await page.addInitScript((m: Record<string, unknown>) => {
    const calls: Array<{ cmd: string; args: unknown }> = [];

    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: unknown) => {
        calls.push({ cmd, args });
        (window as any).__tauri_test_calls__ = calls;

        if (!(cmd in m)) {
          throw new Error(`unmocked Tauri command: ${cmd}`);
        }
        const val = m[cmd];
        if (
          val !== null &&
          typeof val === 'object' &&
          '__error__' in (val as object)
        ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          throw (val as any).__error__ as string;
        }
        return val;
      },
    };
  }, mocks);
}

/** Return a snapshot of all invoke() calls made so far in this page. */
export async function getCalls(
  page: Page,
): Promise<Array<{ cmd: string; args: unknown }>> {
  return page.evaluate(() => (window as any).__tauri_test_calls__ ?? []);
}

/** Return only the calls for a specific command. */
export async function getCallsFor(
  page: Page,
  cmd: string,
): Promise<Array<{ cmd: string; args: unknown }>> {
  const all = await getCalls(page);
  return all.filter(c => c.cmd === cmd);
}
