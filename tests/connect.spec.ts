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

  test('shows the backend-resolved socket path, read-only', async ({ page }) => {
    const field = page.getByLabel('Socket path');
    await expect(field).toHaveValue('build/cc_pd.sock');
    await expect(field).toHaveAttribute('readonly', '');
  });

  test('documents CC_PD_SOCK as the way to use a different socket', async ({ page }) => {
    await expect(page.getByText('CC_PD_SOCK', { exact: false })).toBeVisible();
  });

  test('does not offer a picker when only one socket path is known', async ({ page }) => {
    // Default mock's cc_allowed_sock_paths has exactly one entry.
    await expect(page.getByLabel('Known locations')).toHaveCount(0);
  });

  test('transitions to main app after successful connect', async ({ page }) => {
    await connectApp(page);
    await expect(page.getByRole('button', { name: 'Guests' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).not.toBeVisible();
  });

  test('calls cc_connect with the backend-resolved default path', async ({ page }) => {
    await connectApp(page);
    const calls = await getCallsFor(page, 'cc_connect');
    expect(calls).toHaveLength(1);
    expect((calls[0].args as any).path).toBe('build/cc_pd.sock');
  });

  test('offers every backend-resolved candidate in the picker and connects with the one chosen', async ({ page }) => {
    await setupTauriMock(page, {
      cc_allowed_sock_paths: ['build/cc_pd.sock', '../agentos/build/cc_pd.sock'],
    });
    await page.reload();

    const picker = page.getByLabel('Known locations');
    await expect(picker).toBeVisible();
    await picker.selectOption('../agentos/build/cc_pd.sock');
    await expect(page.getByLabel('Socket path')).toHaveValue('../agentos/build/cc_pd.sock');

    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('button', { name: 'Guests' })).toBeVisible();

    const calls = await getCallsFor(page, 'cc_connect');
    expect((calls.at(-1)!.args as any).path).toBe('../agentos/build/cc_pd.sock');
  });

  test('pressing Enter also connects', async ({ page }) => {
    await page.getByLabel('Socket path').press('Enter');
    await expect(page.getByRole('button', { name: 'Guests' })).toBeVisible();
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
