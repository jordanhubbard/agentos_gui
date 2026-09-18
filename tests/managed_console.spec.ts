import { test, expect } from '@playwright/test';
import { setupTauriMock, getCallsFor } from './helpers/tauri';
import { connectApp } from './helpers/app';

test('console keeps repeated chunks after retention rollover and resets on clear/reconnect', async ({ page }) => {
  test.setTimeout(90_000);
  await setupTauriMock(page);
  await page.addInitScript(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__nextConsole = '';
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd !== 'cc_log_stream') return result;
      const text = w.__nextConsole;
      w.__nextConsole = '';
      return text;
    };
  });
  await page.goto('/');
  await connectApp(page);
  const terminal = page.getByTestId('guest-terminal');
  const rows = terminal.locator('.xterm-rows');
  const drain = page.getByRole('button', { name: 'Drain', exact: true });
  await terminal.scrollIntoViewIfNeeded();
  for (let i = 0; i < 310; i++) {
    await page.evaluate(() => { (window as any).__nextConsole = 'r'; });
    await drain.click();
  }
  await expect.poll(async () => (await rows.innerText()).replace(/\s/g, '')).toBe('r'.repeat(310));
  await page.evaluate(() => { (window as any).__nextConsole = '\r\nAFTER-ROLLOVER\r\n'; });
  await drain.click();
  await expect(rows).toContainText('AFTER-ROLLOVER');

  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('button', { name: 'Guests', exact: true }).click();
  await terminal.scrollIntoViewIfNeeded();
  await expect(rows).not.toContainText('AFTER-ROLLOVER');
  await page.evaluate(() => { (window as any).__nextConsole = 'AFTER-CLEAR\r\n'; });
  await drain.click();
  await expect(rows).toContainText('AFTER-CLEAR');

  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await connectApp(page);
  await terminal.scrollIntoViewIfNeeded();
  await expect(rows).not.toContainText('AFTER-CLEAR');
  await page.evaluate(() => { (window as any).__nextConsole = 'AFTER-RECONNECT\r\n'; });
  await drain.click();
  await expect(rows).toContainText('AFTER-RECONNECT');
});

test('managed console selection keeps delayed output with its original guest', async ({ page }) => {
  await setupTauriMock(page);
  await page.addInitScript(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    let pending = true;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd !== 'cc_log_stream') return result;
      if (args.slot === 1 && args.byHandle && pending) {
        pending = false;
        return new Promise(resolve => { w.__releasePrimary = () => resolve('PRIMARY-ONLY\r\n'); });
      }
      if (args.slot === 2 && args.byHandle) return 'SECONDARY-ONLY\r\n';
      return '';
    };
  });
  await page.goto('/');
  await connectApp(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releasePrimary)).toBe('function');
  await page.getByText('FreeBSD', { exact: true }).click();
  await page.evaluate(() => (window as any).__releasePrimary());
  await page.getByTestId('guest-terminal').scrollIntoViewIfNeeded();
  const rows = page.getByTestId('guest-terminal').locator('.xterm-rows');
  await expect(rows).toContainText('SECONDARY-ONLY');
  await expect(rows).not.toContainText('PRIMARY-ONLY');
  await page.getByRole('button', { name: 'Drain', exact: true }).click();
  const calls = await getCallsFor(page, 'cc_log_stream');
  expect(calls.every(call => (call.args as any).slot !== 0)).toBe(true);
  expect(calls.some(call => (call.args as any).slot === 2 && (call.args as any).byHandle)).toBe(true);
  await page.getByText('Linux', { exact: true }).click();
  await page.getByTestId('guest-terminal').scrollIntoViewIfNeeded();
  await expect(rows).toContainText('PRIMARY-ONLY');
  await expect(rows).not.toContainText('SECONDARY-ONLY');
});

test('automatic boot guest still uses the boot console stream', async ({ page }) => {
  const guest = { guest_handle: 0, state: 4, os_type: 1, arch: 1 };
  await setupTauriMock(page, { cc_list_guests: [guest], cc_guest_status: { ...guest, device_flags: 7 }, cc_log_stream: 'BOOT-CONSOLE\r\n' });
  await page.goto('/');
  await connectApp(page);
  await page.getByTestId('guest-terminal').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('guest-terminal').locator('.xterm-rows')).toContainText('BOOT-CONSOLE');
  const calls = await getCallsFor(page, 'cc_log_stream');
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(call => (call.args as any).slot === 0 && (call.args as any).pdId === 0)).toBe(true);
});
