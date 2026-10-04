import { test, expect } from '@playwright/test';
import { setupTauriMock, mockError } from './helpers/tauri';
import { connectApp } from './helpers/app';

// The topology view renders MSG_CC_AUTHORITY, the boot-time ledger of what
// the root task granted each protection domain -- never a hardcoded
// diagram. These tests cover both states the task brief requires: data
// populated, and data unavailable (for each of the three ways the Rust
// backend can distinguish failure -- see src/lib/ccErrors.ts).

test.describe('Authority / topology view', () => {
  test('renders the populated authority snapshot, not a drawn diagram', async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
    await connectApp(page);

    await expect(page.getByText('Topology')).toBeVisible();

    // Honesty label: this must never be presented as live state, an audit,
    // or a verification.
    await expect(page.getByText(/not live kernel state/)).toBeVisible();
    await expect(page.getByText(/does not verify the subsetting invariant/)).toBeVisible();

    // Root sentinel (pd_index 0xFFFFFFFF) rendered as "root task", not as a
    // domain with an absurd numeric index.
    await expect(page.getByText('root task', { exact: true })).toBeVisible();
    await expect(page.getByText('pd_index 0xFFFFFFFF (root sentinel)')).toBeVisible();

    // Named domains from the snapshot, with their recorded capability kinds.
    await expect(page.getByText('nameserver', { exact: true })).toBeVisible();
    await expect(page.getByText('vibe_engine', { exact: true })).toBeVisible();
    await expect(page.getByText('4 domains recorded')).toBeVisible();
  });

  test('shows an explicit unavailable state on a transport failure, with no diagram fallback', async ({ page }) => {
    await setupTauriMock(page, {
      cc_authority: mockError('CC-PD socket connected, but cc_pd did not reply within 5s.'),
    });
    await page.goto('/');
    await connectApp(page);

    await expect(page.getByText('Authority data unavailable')).toBeVisible();
    await expect(page.getByText(/did not reply within 5s/)).toBeVisible();
    // No stand-in diagram node labels should appear.
    await expect(page.getByText('root task', { exact: true })).toHaveCount(0);
  });

  test('distinguishes an unsupported opcode (older cc_pd) from other failures', async ({ page }) => {
    await setupTauriMock(page, {
      cc_authority: mockError(
        'NOT_SUPPORTED: cc_pd did not recognize MSG_CC_AUTHORITY; the connected cc_pd likely predates this opcode',
      ),
    });
    await page.goto('/');
    await connectApp(page);

    await expect(page.getByText('Authority data unavailable')).toBeVisible();
    await expect(page.getByText(/not supported by this cc_pd/)).toBeVisible();
    await expect(page.getByText(/predates this opcode/)).toBeVisible();
  });

  test('distinguishes an operator-envelope refusal from other failures', async ({ page }) => {
    await setupTauriMock(page, {
      cc_authority: mockError(
        'NOT_PERMITTED: authority refused by the operator authority envelope (CC_ERR_NOT_PERMITTED)',
      ),
    });
    await page.goto('/');
    await connectApp(page);

    await expect(page.getByText('Authority data unavailable')).toBeVisible();
    await expect(page.getByText(/refused by the operator authority envelope/)).toBeVisible();
  });
});
