import { test, expect } from '@playwright/test';
import { setupTauriMock, getCallsFor } from './helpers/tauri';
import { connectApp, switchTab } from './helpers/app';

test.describe('Log viewer', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
    await connectApp(page);
    await switchTab(page, 'Logs');
  });

  test('shows empty state placeholder initially', async ({ page }) => {
    await expect(
      page.getByText('No log output yet'),
    ).toBeVisible();
  });

  test('shows 0 lines count initially', async ({ page }) => {
    await expect(page.getByText('0 lines')).toBeVisible();
  });

  test('Drain button calls cc_log_stream', async ({ page }) => {
    await page.getByRole('button', { name: 'Drain' }).click();
    const calls = await getCallsFor(page, 'cc_log_stream');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some(call => (call.args as any).slot === 0 && (call.args as any).pdId === 0)).toBe(true);
  });

  test('log lines appear after Drain returns content', async ({ page }) => {
    await setupTauriMock(page, {
      cc_log_stream: '[boot] serial_pd: ready\n[boot] ok: init complete',
    });
    await page.reload();
    await connectApp(page);
    await switchTab(page, 'Logs');
    await page.getByRole('button', { name: 'Drain' }).click();
    await expect(page.getByText('[boot] serial_pd: ready')).toBeVisible();
    await expect(page.getByText('[boot] ok: init complete')).toBeVisible();
  });

  test('line count updates after Drain', async ({ page }) => {
    await setupTauriMock(page, {
      cc_log_stream: 'line one\nline two\nline three',
    });
    await page.reload();
    await connectApp(page);
    await switchTab(page, 'Logs');
    await page.getByRole('button', { name: 'Drain' }).click();
    await expect(page.getByText('3 lines')).toBeVisible();
  });

  test('Clear button removes all log lines', async ({ page }) => {
    await setupTauriMock(page, { cc_log_stream: 'some log line' });
    await page.reload();
    await connectApp(page);
    await switchTab(page, 'Logs');
    await page.getByRole('button', { name: 'Drain' }).click();
    await expect(page.getByText('some log line')).toBeVisible();
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText('0 lines')).toBeVisible();
    await expect(page.getByText('No log output yet')).toBeVisible();
  });

  test('ERROR lines are shown in red', async ({ page }) => {
    await setupTauriMock(page, {
      cc_log_stream: 'ERROR: guest fault at 0xdeadbeef',
    });
    await page.reload();
    await connectApp(page);
    await switchTab(page, 'Logs');
    await page.getByRole('button', { name: 'Drain' }).click();
    await expect(page.getByText('ERROR: guest fault at 0xdeadbeef')).toHaveClass(
      /text-red-400/,
    );
  });

  test('WARN lines are shown in amber', async ({ page }) => {
    await setupTauriMock(page, { cc_log_stream: 'WARN: memory pressure' });
    await page.reload();
    await connectApp(page);
    await switchTab(page, 'Logs');
    await page.getByRole('button', { name: 'Drain' }).click();
    await expect(page.getByText('WARN: memory pressure')).toHaveClass(
      /text-amber-400/,
    );
  });

  test('ok/ready lines are shown in green', async ({ page }) => {
    await setupTauriMock(page, { cc_log_stream: 'serial_pd: ready' });
    await page.reload();
    await connectApp(page);
    await switchTab(page, 'Logs');
    await page.getByRole('button', { name: 'Drain' }).click();
    await expect(page.getByText('serial_pd: ready')).toHaveClass(
      /text-emerald-400/,
    );
  });
});
