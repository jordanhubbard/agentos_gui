// Previously this spec covered ConnectDialog's free-text input + localStorage
// history of recently typed socket paths. That feature let the frontend send
// cc_connect an arbitrary path string, which src-tauri/src/commands.rs
// (validate_sock_path) now rejects outright: cc_connect only accepts a path
// the backend itself resolved (CC_PD_SOCK, the sibling agentos build
// directory, or whatever the backend is currently using). Free-text entry
// was replaced with a picker over the backend-reported candidate list
// (cc_allowed_sock_paths) — these tests cover that picker instead.
import { test, expect } from '@playwright/test';
import { setupTauriMock } from './helpers/tauri';

test.describe('ConnectDialog known-locations picker', () => {
  const CANDIDATES = [
    'build/cc_pd.sock',
    '../agentos/build/cc_pd.sock',
    '/tmp/custom/cc_pd.sock',
  ];

  test('lists every backend-resolved candidate as a picker option', async ({ page }) => {
    await setupTauriMock(page, { cc_allowed_sock_paths: CANDIDATES });
    await page.goto('/');

    const picker = page.getByLabel('Known locations');
    await expect(picker).toBeVisible();
    for (const candidate of CANDIDATES) {
      await expect(picker.getByRole('option', { name: candidate, exact: true })).toHaveCount(1);
    }
  });

  test('selecting a candidate updates the read-only socket path field', async ({ page }) => {
    await setupTauriMock(page, { cc_allowed_sock_paths: CANDIDATES });
    await page.goto('/');

    await page.getByLabel('Known locations').selectOption('/tmp/custom/cc_pd.sock');
    await expect(page.getByLabel('Socket path')).toHaveValue('/tmp/custom/cc_pd.sock');
  });

  test('the backend-resolved default is preselected', async ({ page }) => {
    await setupTauriMock(page, { cc_allowed_sock_paths: CANDIDATES });
    await page.goto('/');

    await expect(page.getByLabel('Known locations')).toHaveValue('build/cc_pd.sock');
    await expect(page.getByLabel('Socket path')).toHaveValue('build/cc_pd.sock');
  });

  test('the socket path field cannot be typed into', async ({ page }) => {
    await setupTauriMock(page, { cc_allowed_sock_paths: CANDIDATES });
    await page.goto('/');

    const field = page.getByLabel('Socket path');
    await expect(field).toHaveAttribute('readonly', '');
  });
});
