import { test, expect } from '@playwright/test';
import { setupTauriMock, getCallsFor } from './helpers/tauri';
import { connectApp, switchTab } from './helpers/app';

test.describe('Log viewer PD selector', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
    await connectApp(page);
    await switchTab(page, 'Logs');
  });

  test('shows slot and pd inputs', async ({ page }) => {
    await expect(page.getByLabel('slot')).toBeVisible();
    await expect(page.getByLabel('pd')).toBeVisible();
  });

  test('Drain uses default slot=0 pd=0', async ({ page }) => {
    await page.getByRole('button', { name: 'Drain' }).click();
    const calls = await getCallsFor(page, 'cc_log_stream');
    expect(calls.some(call => (call.args as any).slot === 0 && (call.args as any).pdId === 0)).toBe(true);
  });

  test('Drain uses user-selected slot and pd', async ({ page }) => {
    await page.getByLabel('slot').fill('2');
    await page.getByLabel('pd').fill('5');
    await page.getByRole('button', { name: 'Drain' }).click();
    const calls = await getCallsFor(page, 'cc_log_stream');
    // Auto-poll may have fired first — check the last Drain call
    const last = calls[calls.length - 1];
    expect((last.args as any).slot).toBe(2);
    expect((last.args as any).pdId).toBe(5);
  });
});
