import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Click Connect and wait for the main app.
 *
 * The socket path field is read-only (the backend only ever connects to a
 * path it resolved itself — see src-tauri/src/commands.rs::validate_sock_path),
 * so there's nothing to fill in for the common case. Pass `path` to pick a
 * different entry from the "Known locations" selector first — the mock's
 * `cc_allowed_sock_paths` must list it, or there's nothing to select.
 */
export async function connectApp(
  page: Page,
  path?: string,
): Promise<void> {
  if (path) {
    await page.getByLabel('Known locations').selectOption(path);
  }
  await page.getByRole('button', { name: 'Connect' }).click();
  // Sidebar nav is the reliable signal that the app has transitioned
  await expect(page.getByRole('button', { name: 'Guests' })).toBeVisible();
}

/** Click a sidebar tab and wait for content to switch. */
export async function switchTab(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name }).click();
}
