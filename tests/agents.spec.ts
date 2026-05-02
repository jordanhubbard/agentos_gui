import { test, expect } from '@playwright/test';
import { setupTauriMock } from './helpers/tauri';
import { connectApp, switchTab } from './helpers/app';

test.describe('Agent pool', () => {
  test('shows empty state when polecats returns zero totals', async ({ page }) => {
    await setupTauriMock(page, {
      cc_list_polecats: { total: 0, busy: 0, idle: 0 },
    });
    await page.goto('/');
    await connectApp(page);
    await switchTab(page, 'Agents');
    // Zero total means the slots grid is not rendered
    await expect(page.getByText('Slots')).not.toBeVisible();
  });

  test.describe('with 8 polecats (3 busy, 5 idle)', () => {
    test.beforeEach(async ({ page }) => {
      await setupTauriMock(page);
      await page.goto('/');
      await connectApp(page);
      await switchTab(page, 'Agents');
    });

    test('shows Total count card', async ({ page }) => {
      const totalCard = page.locator('.rounded-lg').filter({ hasText: 'Total' });
      await expect(totalCard.getByText('8')).toBeVisible();
    });

    test('shows Busy count card', async ({ page }) => {
      const busyCard = page.locator('.rounded-lg').filter({ hasText: 'Busy' });
      await expect(busyCard.getByText('3')).toBeVisible();
    });

    test('shows Idle count card', async ({ page }) => {
      const idleCard = page.locator('.rounded-lg').filter({ hasText: 'Idle' });
      await expect(idleCard.getByText('5')).toBeVisible();
    });

    test('shows correct utilization percentage (38%)', async ({ page }) => {
      // Math.round(3/8 * 100) = Math.round(37.5) = 38
      await expect(page.getByText('38%')).toBeVisible();
    });

    test('utilization bar is emerald at 37%', async ({ page }) => {
      const bar = page.locator('.h-full.rounded-full').first();
      await expect(bar).toHaveClass(/bg-emerald-400/);
    });

    test('shows slot grid with 8 slots', async ({ page }) => {
      await expect(page.locator('[title="busy"], [title="idle"]')).toHaveCount(8);
    });

    test('busy slots have amber highlight', async ({ page }) => {
      await expect(page.locator('[title="busy"]')).toHaveCount(3);
      await expect(
        page.locator('[title="busy"]').first(),
      ).toHaveClass(/bg-amber-400/);
    });

    test('idle slots have muted styling', async ({ page }) => {
      await expect(page.locator('[title="idle"]')).toHaveCount(5);
      await expect(
        page.locator('[title="idle"]').first(),
      ).not.toHaveClass(/bg-amber-400/);
    });
  });

  test('utilization bar is red when >80%', async ({ page }) => {
    await setupTauriMock(page, {
      cc_list_polecats: { total: 10, busy: 9, idle: 1 },
    });
    await page.goto('/');
    await connectApp(page);
    await switchTab(page, 'Agents');
    await expect(page.getByText('90%')).toBeVisible();
    const bar = page.locator('.h-full.rounded-full').first();
    await expect(bar).toHaveClass(/bg-red-500/);
  });

  test('utilization bar is amber when 50–80%', async ({ page }) => {
    await setupTauriMock(page, {
      cc_list_polecats: { total: 10, busy: 6, idle: 4 },
    });
    await page.goto('/');
    await connectApp(page);
    await switchTab(page, 'Agents');
    await expect(page.getByText('60%')).toBeVisible();
    const bar = page.locator('.h-full.rounded-full').first();
    await expect(bar).toHaveClass(/bg-amber-400/);
  });
});
