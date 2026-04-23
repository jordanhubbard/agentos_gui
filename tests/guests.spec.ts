import { test, expect } from '@playwright/test';
import { setupTauriMock, mockError, getCallsFor } from './helpers/tauri';
import { connectApp } from './helpers/app';

test.describe('Guest list', () => {
  test('shows empty state when no guests', async ({ page }) => {
    await setupTauriMock(page, { cc_list_guests: [] });
    await page.goto('/');
    await connectApp(page);
    await expect(
      page.getByText('No guest OS instances running'),
    ).toBeVisible();
  });

  test.describe('with two mock guests', () => {
    test.beforeEach(async ({ page }) => {
      await setupTauriMock(page);
      await page.goto('/');
      await connectApp(page);
    });

    test('shows Linux guest card', async ({ page }) => {
      await expect(page.getByText('Linux')).toBeVisible();
    });

    test('shows FreeBSD guest card', async ({ page }) => {
      await expect(page.getByText('FreeBSD')).toBeVisible();
    });

    test('shows guest handle in hex', async ({ page }) => {
      await expect(page.getByText('handle 0x00000001')).toBeVisible();
      await expect(page.getByText('handle 0x00000002')).toBeVisible();
    });

    test('shows arch for Linux guest (aarch64)', async ({ page }) => {
      await expect(page.getByText('aarch64')).toBeVisible();
    });

    test('shows arch for FreeBSD guest (riscv64)', async ({ page }) => {
      await expect(page.getByText('riscv64')).toBeVisible();
    });

    test('Running state shown in emerald color', async ({ page }) => {
      const runningBadge = page.getByText('Running');
      await expect(runningBadge).toBeVisible();
      await expect(runningBadge).toHaveClass(/text-emerald-400/);
    });

    test('Booting state shown in amber color', async ({ page }) => {
      const bootingBadge = page.getByText('Booting');
      await expect(bootingBadge).toBeVisible();
      await expect(bootingBadge).toHaveClass(/text-amber-400/);
    });

    test('each guest card has a Snapshot button', async ({ page }) => {
      await expect(page.getByRole('button', { name: 'Snapshot' })).toHaveCount(2);
    });

    test('Restore button is disabled before snapshot', async ({ page }) => {
      const restoreButtons = page.getByRole('button', { name: 'Restore' });
      await expect(restoreButtons.first()).toBeDisabled();
    });
  });
});

test.describe('Snapshot / restore flow', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
    await connectApp(page);
    await expect(page.getByText('Linux')).toBeVisible();
  });

  test('clicking Snapshot calls cc_snapshot with guest handle', async ({ page }) => {
    await page.getByRole('button', { name: 'Snapshot' }).first().click();
    const calls = await getCallsFor(page, 'cc_snapshot');
    expect(calls.length).toBeGreaterThan(0);
    expect((calls[0].args as any).handle).toBe(1);
  });

  test('snapshot success message appears', async ({ page }) => {
    await page.getByRole('button', { name: 'Snapshot' }).first().click();
    await expect(page.getByText(/✓ snapshot/)).toBeVisible();
  });

  test('Restore button becomes enabled after snapshot', async ({ page }) => {
    const card = page.locator('.rounded-xl').filter({ hasText: 'Linux' });
    await card.getByRole('button', { name: 'Snapshot' }).click();
    await expect(card.getByText(/✓ snapshot/)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Restore' })).toBeEnabled();
  });

  test('clicking Restore calls cc_restore', async ({ page }) => {
    const card = page.locator('.rounded-xl').filter({ hasText: 'Linux' });
    await card.getByRole('button', { name: 'Snapshot' }).click();
    await expect(card.getByText(/✓ snapshot/)).toBeVisible();
    await card.getByRole('button', { name: 'Restore' }).click();
    const calls = await getCallsFor(page, 'cc_restore');
    expect(calls.length).toBeGreaterThan(0);
    expect((calls[0].args as any).handle).toBe(1);
    expect((calls[0].args as any).snapLo).toBe(1);
    expect((calls[0].args as any).snapHi).toBe(2);
  });

  test('restore success message appears', async ({ page }) => {
    const card = page.locator('.rounded-xl').filter({ hasText: 'Linux' });
    await card.getByRole('button', { name: 'Snapshot' }).click();
    await expect(card.getByText(/✓ snapshot/)).toBeVisible();
    await card.getByRole('button', { name: 'Restore' }).click();
    await expect(card.getByText('✓ restore queued')).toBeVisible();
  });

  test('snapshot failure shows error message', async ({ page }) => {
    await setupTauriMock(page, {
      cc_snapshot: mockError('snapshot failed: no storage'),
    });
    await page.reload();
    await connectApp(page);
    await expect(page.getByText('Linux')).toBeVisible();
    await page.getByRole('button', { name: 'Snapshot' }).first().click();
    await expect(page.getByText(/✗/)).toBeVisible();
  });
});
