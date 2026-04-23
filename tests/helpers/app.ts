import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Fill in the socket path and click Connect, then wait for the main app. */
export async function connectApp(
  page: Page,
  path = 'build/cc_pd.sock',
): Promise<void> {
  const input = page.getByPlaceholder('build/cc_pd.sock');
  await input.fill(path);
  await page.getByRole('button', { name: 'Connect' }).click();
  // Sidebar nav is the reliable signal that the app has transitioned
  await expect(page.getByRole('button', { name: 'Guests' })).toBeVisible();
}

/** Click a sidebar tab and wait for content to switch. */
export async function switchTab(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name }).click();
}
