import { test, expect } from '@playwright/test';
import { setupTauriMock } from './helpers/tauri';

test.describe('ConnectDialog recent paths', () => {
  test('shows recent paths as quick-pick buttons', async ({ page }) => {
    await setupTauriMock(page);
    await page.addInitScript(() => {
      localStorage.setItem(
        'cc_sock_history',
        JSON.stringify(['build/cc_pd.sock', 'run/custom.sock']),
      );
    });
    await page.goto('/');
    // The filename portion of the saved paths should appear as pills
    await expect(page.getByRole('button', { name: 'cc_pd.sock' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'custom.sock' })).toBeVisible();
  });

  test('clicking a recent path fills the input', async ({ page }) => {
    await setupTauriMock(page);
    await page.addInitScript(() => {
      localStorage.setItem(
        'cc_sock_history',
        JSON.stringify(['run/custom.sock']),
      );
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'custom.sock' }).click();
    await expect(page.getByPlaceholder('build/cc_pd.sock')).toHaveValue(
      'run/custom.sock',
    );
  });

  test('saves path to history on connect', async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
    const input = page.getByPlaceholder('build/cc_pd.sock');
    await input.fill('my/new.sock');
    await page.getByRole('button', { name: 'Connect' }).click();
    const history = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('cc_sock_history') ?? '[]'),
    );
    expect(history).toContain('my/new.sock');
  });
});
