import { test, expect } from '@playwright/test';
import { setupTauriMock, mockError, getCallsFor } from './helpers/tauri';
import { connectApp, switchTab } from './helpers/app';

test.describe('Refresh', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
    await connectApp(page);
    await expect(page.getByText('Linux')).toBeVisible();
  });

  test('refresh button triggers cc_list_guests', async ({ page }) => {
    const before = (await getCallsFor(page, 'cc_list_guests')).length;
    await page.getByRole('button', { name: /refresh/i }).click();
    await expect(
      page.getByRole('button', { name: /refresh/i }),
    ).not.toContainText(/refreshing/i, { timeout: 3000 });
    const after = (await getCallsFor(page, 'cc_list_guests')).length;
    expect(after).toBeGreaterThan(before);
  });

  test('shows refreshing spinner text while loading', async ({ page }) => {
    // Just verify the button returns to idle state — the spinner is too brief
    // to reliably catch in a test
    await page.getByRole('button', { name: /refresh/i }).click();
    await expect(
      page.getByRole('button', { name: /refresh/i }),
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
    await page.getByRole('button', { name: /refresh/i }).click();
    await expect(
      page.getByRole('button', { name: /refresh/i }),
    ).not.toContainText(/refreshing/i, { timeout: 3000 });
    expect((await getCallsFor(page, 'cc_list_guests')).length).toBeGreaterThan(gBefore);
    expect((await getCallsFor(page, 'cc_list_devices')).length).toBeGreaterThan(dBefore);
    expect((await getCallsFor(page, 'cc_list_polecats')).length).toBeGreaterThan(pBefore);
  });

  test('a refused trace relay does not fail the rest of refresh', async ({ page }) => {
    // cc_pd's operator authority envelope may refuse trace (and only
    // trace) with CC_ERR_NOT_PERMITTED. cc_trace_query/cc_trace_dump used
    // to sit inside the same Promise.all as every other refresh call, so
    // this refusal took guests/devices/polecats/sessions/traffic down with
    // it on every single poll. They must now be fetched independently.
    await setupTauriMock(page, {
      cc_trace_query: mockError(
        'NOT_PERMITTED: trace_query refused by the operator authority envelope (CC_ERR_NOT_PERMITTED)',
      ),
      cc_trace_dump: mockError(
        'NOT_PERMITTED: trace_dump refused by the operator authority envelope (CC_ERR_NOT_PERMITTED)',
      ),
    });
    await page.reload();
    await connectApp(page);

    // Everything else in a refresh cycle still loads.
    await expect(page.getByText('Linux')).toBeVisible();
    const before = (await getCallsFor(page, 'cc_list_guests')).length;
    await page.getByRole('button', { name: /refresh/i }).click();
    await expect(
      page.getByRole('button', { name: /refresh/i }),
    ).not.toContainText(/refreshing/i, { timeout: 3000 });
    const after = (await getCallsFor(page, 'cc_list_guests')).length;
    expect(after).toBeGreaterThan(before);

    // And the refused trace call does not surface as a generic header error.
    await expect(page.getByText(/refused by the operator authority envelope/)).not.toBeVisible();
    await expect(page.getByText(/^error:/)).not.toBeVisible();
  });

  test('an ordinary trace transport failure does not render stale trace data as current', async ({ page }) => {
    // Distinct from the NOT_PERMITTED case above: this is a plain transport
    // failure (no "NOT_PERMITTED: " prefix), which useAgentOS used to
    // swallow by keeping the previous cycle's traceStatus/traceEvents with
    // no indication anything was wrong. The fix clears both on any trace
    // failure and surfaces a reason instead of leaving old data rendering
    // as if it were current.
    await setupTauriMock(page, {
      cc_trace_query: mockError('CC-PD socket connected, but cc_pd did not reply within 5s.'),
      cc_trace_dump: mockError('CC-PD socket connected, but cc_pd did not reply within 5s.'),
    });
    await page.reload();
    await connectApp(page);

    // The rest of refresh is unaffected (same independence guarantee as
    // the NOT_PERMITTED case).
    await expect(page.getByText('Linux')).toBeVisible();
    await expect(page.getByText(/^error:/)).not.toBeVisible();

    await switchTab(page, 'API');
    await expect(page.getByText(/last background trace fetch failed/)).toBeVisible();
    await expect(page.getByText(/did not reply within 5s/)).toBeVisible();
    // Not the refusal banner -- this is a different failure class.
    await expect(page.getByText(/refused by the operator authority envelope/)).not.toBeVisible();
    // No trace rows rendered as if they were current data.
    await expect(page.getByText('No trace events')).toBeVisible();
  });
});
