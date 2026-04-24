import { test, expect } from '@playwright/test';
import { setupTauriMock } from './helpers/tauri';
import { connectApp } from './helpers/app';

test.describe('Keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
    await connectApp(page);
  });

  test('⌘1 switches to Guests tab', async ({ page }) => {
    // Start on devices
    await page.getByRole('button', { name: 'Devices' }).click();
    await expect(page.locator('header h2')).toHaveText('devices');
    // Press ⌘1
    await page.keyboard.press('Meta+1');
    await expect(page.locator('header h2')).toHaveText('guests');
  });

  test('⌘2 switches to Devices tab', async ({ page }) => {
    await page.keyboard.press('Meta+2');
    await expect(page.locator('header h2')).toHaveText('devices');
  });

  test('⌘3 switches to Logs tab', async ({ page }) => {
    await page.keyboard.press('Meta+3');
    await expect(page.locator('header h2')).toHaveText('logs');
  });

  test('⌘4 switches to Agents tab', async ({ page }) => {
    await page.keyboard.press('Meta+4');
    await expect(page.locator('header h2')).toHaveText('agents');
  });

  test('tab buttons show shortcut hints', async ({ page }) => {
    await expect(page.getByTitle('⌘1')).toBeVisible();
    await expect(page.getByTitle('⌘2')).toBeVisible();
    await expect(page.getByTitle('⌘3')).toBeVisible();
    await expect(page.getByTitle('⌘4')).toBeVisible();
  });

  test('refresh button shows shortcut hint', async ({ page }) => {
    await expect(page.getByTitle('Refresh (⌘R)')).toBeVisible();
  });
});
