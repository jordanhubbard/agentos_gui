import { test, expect } from '@playwright/test';
import { setupTauriMock } from './helpers/tauri';
import { connectApp } from './helpers/app';

test.describe('Keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
    await connectApp(page);
  });

  test('Meta+1 switches to Guests tab', async ({ page }) => {
    // Start on devices
    await page.getByRole('button', { name: 'Devices' }).click();
    await expect(page.locator('header h2')).toHaveText('devices');
    await page.keyboard.press('Meta+1');
    await expect(page.locator('header h2')).toHaveText('guests');
  });

  test('Meta+2 switches to Devices tab', async ({ page }) => {
    await page.keyboard.press('Meta+2');
    await expect(page.locator('header h2')).toHaveText('devices');
  });

  test('Meta+3 switches to Logs tab', async ({ page }) => {
    await page.keyboard.press('Meta+3');
    await expect(page.locator('header h2')).toHaveText('logs');
  });

  test('Meta+4 switches to Agents tab', async ({ page }) => {
    await page.keyboard.press('Meta+4');
    await expect(page.locator('header h2')).toHaveText('agents');
  });

  test('Meta+5 switches to API tab', async ({ page }) => {
    await page.keyboard.press('Meta+5');
    await expect(page.locator('header h2')).toHaveText('api');
  });

  test('tab buttons expose tooltip labels', async ({ page }) => {
    await expect(page.getByTitle('Guests (Cmd+1)')).toBeVisible();
    await expect(page.getByTitle('Devices (Cmd+2)')).toBeVisible();
    await expect(page.getByTitle('Logs (Cmd+3)')).toBeVisible();
    await expect(page.getByTitle('Agents (Cmd+4)')).toBeVisible();
    await expect(page.getByTitle('API (Cmd+5)')).toBeVisible();
  });

  test('refresh button exposes tooltip label', async ({ page }) => {
    await expect(page.getByTitle('Refresh')).toBeVisible();
  });
});
