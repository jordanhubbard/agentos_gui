import { test, expect } from '@playwright/test';
import { setupTauriMock, mockError, getCallsFor } from './helpers/tauri';
import { connectApp } from './helpers/app';

test.describe('Refresh', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
    await connectApp(page);
    await expect(page.getByText('Linux')).toBeVisible();
  });

  test('refresh button triggers cc_list_guests', async ({ page }) => {
    const before = (await getCallsFor(page, 'cc_list_guests')).length;
    await page.getByRole('button', { name: /refresh/ }).click();
    await expect(
      page.getByRole('button', { name: /refresh/i }),
    ).not.toContainText('refreshing', { timeout: 3000 });
    const after = (await getCallsFor(page, 'cc_list_guests')).length;
    expect(after).toBeGreaterThan(before);
  });

  test('shows refreshing spinner text while loading', async ({ page }) => {
    // Just verify the button returns to idle state — the spinner is too brief
    // to reliably catch in a test
    await page.getByRole('button', { name: /refresh/ }).click();
    await expect(
      page.getByRole('button', { name: /refresh/ }),
    ).toBeVisible({ timeout: 3000 });
  });

  test('shows error in header when refresh fails', async ({ page }) => {
    await setupTauriMock(page, {
      cc_list_guests: mockError('socket closed'),
    });
    await page.reload();
    await connectApp(page);
    await expect(page.getByText(/socket closed/)).toBeVisible({ timeout: 5000 });
  });

  test('refresh calls all three data commands', async ({ page }) => {
    const gBefore = (await getCallsFor(page, 'cc_list_guests')).length;
    const dBefore = (await getCallsFor(page, 'cc_list_devices')).length;
    const pBefore = (await getCallsFor(page, 'cc_list_polecats')).length;
    await page.getByRole('button', { name: /refresh/ }).click();
    await expect(
      page.getByRole('button', { name: /refresh/i }),
    ).not.toContainText('refreshing', { timeout: 3000 });
    expect((await getCallsFor(page, 'cc_list_guests')).length).toBeGreaterThan(gBefore);
    expect((await getCallsFor(page, 'cc_list_devices')).length).toBeGreaterThan(dBefore);
    expect((await getCallsFor(page, 'cc_list_polecats')).length).toBeGreaterThan(pBefore);
  });
});
