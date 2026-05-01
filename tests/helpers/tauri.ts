import type { Page } from '@playwright/test';

// Default mock responses matching the real CC-PD contract shapes.
export const DEFAULT_MOCKS: Record<string, unknown> = {
  cc_connect:            'connected',
  cc_disconnect:         null,
  cc_is_connected:       true,
  cc_get_sock_path:      'build/cc_pd.sock',
  cc_should_autoconnect: false,
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
  cc_send_input:         null,
  cc_device_status:      { dev_type: 0, dev_handle: 1, state: 1 },
  cc_attach_framebuffer: 1,
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
