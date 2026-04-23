import { test, expect } from '@playwright/test';
import { setupTauriMock } from './helpers/tauri';
import { connectApp, switchTab } from './helpers/app';

test.describe('Sidebar navigation', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
    await connectApp(page);
  });

  test('sidebar shows agentOS branding', async ({ page }) => {
    await expect(page.locator('aside').getByText('agentOS')).toBeVisible();
  });

  test('sidebar shows connected socket filename', async ({ page }) => {
    // Shows last path segment of the socket path
    await expect(page.locator('aside').getByText('cc_pd.sock')).toBeVisible();
  });

  test('default active tab is Guests', async ({ page }) => {
    const header = page.locator('header h2');
    await expect(header).toHaveText('guests');
  });

  test('clicking Devices tab shows device panel', async ({ page }) => {
    await switchTab(page, 'Devices');
    await expect(page.locator('header h2')).toHaveText('devices');
  });

  test('clicking Logs tab shows log viewer', async ({ page }) => {
    await switchTab(page, 'Logs');
    await expect(page.locator('header h2')).toHaveText('logs');
    await expect(page.getByRole('button', { name: 'Drain' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear' })).toBeVisible();
  });

  test('clicking Agents tab shows agent pool', async ({ page }) => {
    await switchTab(page, 'Agents');
    await expect(page.locator('header h2')).toHaveText('agents');
  });

  test('active tab button has accent styling', async ({ page }) => {
    // The active tab should have os-accent class applied
    const guestsBtn = page.getByRole('button', { name: 'Guests' });
    await expect(guestsBtn).toHaveClass(/text-os-accent/);
    await switchTab(page, 'Devices');
    await expect(page.getByRole('button', { name: 'Devices' })).toHaveClass(
      /text-os-accent/,
    );
    await expect(guestsBtn).not.toHaveClass(/text-os-accent/);
  });

  test('sidebar shows agent pool stats after load', async ({ page }) => {
    await expect(page.locator('aside').getByText('8 total')).toBeVisible();
    await expect(page.locator('aside').getByText('3 busy')).toBeVisible();
    await expect(page.locator('aside').getByText('5 idle')).toBeVisible();
  });

  test('disconnect button returns to ConnectDialog', async ({ page }) => {
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible();
  });
});
