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

    test('shows arch for FreeBSD guest (x86_64)', async ({ page }) => {
      await expect(page.getByText('x86_64')).toBeVisible();
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

    test('selecting a guest targets the console pane', async ({ page }) => {
      await page.getByText('FreeBSD').click();
      await expect(page.getByText('selected 0x00000002')).toBeVisible();
    });

    test('console Drain calls cc_log_stream and renders returned lines', async ({ page }) => {
      await page.getByRole('button', { name: 'Drain' }).click();
      const calls = await getCallsFor(page, 'cc_log_stream');
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0].args as any).slot).toBe(0);
      expect((calls[0].args as any).pdId).toBe(0);
    });

    test('console input buttons call cc_send_input for the selected guest', async ({ page }) => {
      await page.getByRole('button', { name: 'Enter' }).click();
      const calls = await getCallsFor(page, 'cc_send_input');
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0].args as any).handle).toBe(1);
      expect((calls[0].args as any).event.keycode).toBe(0x28);
    });

    test('terminal key presses send raw console bytes', async ({ page }) => {
      const terminal = page.getByRole('textbox', { name: 'Guest terminal' });
      await terminal.click();
      await terminal.press('r');
      await terminal.press('Enter');

      const calls = await getCallsFor(page, 'cc_send_input');
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect((calls.at(-2)!.args as any).event.keycode).toBe(0x100 | 'r'.charCodeAt(0));
      expect((calls.at(-1)!.args as any).event.keycode).toBe(0x100 | 0x0d);
    });

    test('console input sends line input to the selected guest', async ({ page }) => {
      const input = page.getByRole('textbox', { name: 'Console input' });
      await input.fill('ubuntu');
      await input.press('Enter');

      const calls = await getCallsFor(page, 'cc_send_input');
      const keycodes = calls.slice(-7).map(call => (call.args as any).event.keycode);
      expect(keycodes).toEqual([
        0x100 | 'u'.charCodeAt(0),
        0x100 | 'b'.charCodeAt(0),
        0x100 | 'u'.charCodeAt(0),
        0x100 | 'n'.charCodeAt(0),
        0x100 | 't'.charCodeAt(0),
        0x100 | 'u'.charCodeAt(0),
        0x100 | 0x0d,
      ]);
      expect((calls.at(-1)!.args as any).handle).toBe(1);
    });

    test('Start calls cc_create_guest with launch settings', async ({ page }) => {
      await page.getByRole('button', { name: 'Start' }).click();
      const calls = await getCallsFor(page, 'cc_create_guest');
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0].args as any).request).toMatchObject({
        os_type: 1,
        arch: 1,
        ram_mb: 512,
        device_flags: 7,
      });
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
