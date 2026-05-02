import { test, expect } from '@playwright/test';
import { setupTauriMock, mockError, getCallsFor } from './helpers/tauri';
import { connectApp } from './helpers/app';

test.describe('ConnectDialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
  });

  test('shows connect dialog on initial load', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'agentOS' })).toBeVisible();
    await expect(page.getByText('Socket path')).toBeVisible();
  });

  test('input has default socket path', async ({ page }) => {
    const input = page.getByPlaceholder('build/cc_pd.sock');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('build/cc_pd.sock');
  });

  test('restores saved socket path from localStorage', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('cc_sock_path', 'custom/agent.sock');
    });
    await page.reload();
    await expect(page.getByPlaceholder('build/cc_pd.sock')).toHaveValue(
      'custom/agent.sock',
    );
  });

  test('transitions to main app after successful connect', async ({ page }) => {
    await connectApp(page);
    await expect(page.getByRole('button', { name: 'Guests' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).not.toBeVisible();
  });

  test('calls cc_connect with the entered path', async ({ page }) => {
    await connectApp(page, 'run/cc.sock');
    const calls = await getCallsFor(page, 'cc_connect');
    expect(calls).toHaveLength(1);
    expect((calls[0].args as any).path).toBe('run/cc.sock');
  });

  test('pressing Enter also connects', async ({ page }) => {
    await page.getByPlaceholder('build/cc_pd.sock').press('Enter');
    await expect(page.getByRole('button', { name: 'Guests' })).toBeVisible();
  });

  test('saves socket path to localStorage on connect', async ({ page }) => {
    await connectApp(page, 'saved/path.sock');
    const stored = await page.evaluate(() =>
      localStorage.getItem('cc_sock_path'),
    );
    expect(stored).toBe('saved/path.sock');
  });

  test('shows error message when cc_connect fails', async ({ page }) => {
    await setupTauriMock(page, {
      cc_connect: mockError('connection refused'),
    });
    await page.reload();
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText(/connection refused/)).toBeVisible();
  });

  test('keeps connect dialog visible after failed connect', async ({ page }) => {
    await setupTauriMock(page, { cc_connect: mockError('no socket') });
    await page.reload();
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible();
  });
});
