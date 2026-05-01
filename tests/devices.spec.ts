import { test, expect } from '@playwright/test';
import { setupTauriMock, getCallsFor } from './helpers/tauri';
import { connectApp, switchTab } from './helpers/app';

test.describe('Device panel', () => {
  test('shows empty state when no devices', async ({ page }) => {
    await setupTauriMock(page, { cc_list_devices: [] });
    await page.goto('/');
    await connectApp(page);
    await switchTab(page, 'Devices');
    await expect(page.getByText('No devices reported')).toBeVisible();
  });

  test.describe('with mock devices', () => {
    test.beforeEach(async ({ page }) => {
      await setupTauriMock(page);
      await page.goto('/');
      await connectApp(page);
      await switchTab(page, 'Devices');
    });

    test('shows Serial section', async ({ page }) => {
      await expect(page.getByText('Serial')).toBeVisible();
    });

    test('shows Network section', async ({ page }) => {
      await expect(page.getByText('Network')).toBeVisible();
    });

    test('shows Framebuffer section', async ({ page }) => {
      await expect(page.getByText('Framebuffer')).toBeVisible();
    });

    test('shows device handles in zero-padded hex', async ({ page }) => {
      await expect(page.getByText('handle 0x0001')).toBeVisible();
      await expect(page.getByText('handle 0x0002')).toBeVisible();
      await expect(page.getByText('handle 0x000a')).toBeVisible();
    });

    test('groups devices — Serial section has count 1', async ({ page }) => {
      // The count span is a sibling of the <h3> inside the section header row
      const serialH3 = page.getByRole('heading', { name: 'Serial' });
      await expect(serialH3).toBeVisible();
      // The count is the last span in the same flex row as the h3
      await expect(serialH3.locator('xpath=../span[last()]')).toHaveText('1');
    });

    test('does not show empty type sections', async ({ page }) => {
      // USB (type 3) has no devices — its section should not appear
      await expect(page.getByText('USB')).not.toBeVisible();
    });

    test('Probe calls cc_device_status for the selected device', async ({ page }) => {
      await page.getByRole('button', { name: 'Probe' }).first().click();
      const calls = await getCallsFor(page, 'cc_device_status');
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0].args as any).devType).toBe(0);
      expect((calls[0].args as any).devHandle).toBe(1);
    });
  });
});
