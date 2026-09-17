import { test, expect } from '@playwright/test';
import { setupTauriMock, getCallsFor, mockError } from './helpers/tauri';
import { connectApp } from './helpers/app';

test('renders exact XRGB pixels and releases the immutable capture', async ({ page }, testInfo) => {
  await setupTauriMock(page, {
    cc_frame_capture: { token: '9007199254740993', sequence: '18446744073709551615', width: 2, height: 1, bytes: 8 },
    cc_frame_read: [3, 2, 1, 0, 30, 20, 10, 0],
    cc_frame_release: null,
  });
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: unknown) => {
      const result = await original(cmd, args);
      return cmd === 'cc_frame_read' ? new Uint8Array(result).buffer : result;
    };
  });
  await page.goto('/'); await connectApp(page);
  await page.getByRole('button', { name: 'Capture display' }).click();
  await expect(page.getByText(/frame 18446744073709551615/)).toBeVisible();
  expect(await page.getByLabel('Captured guest framebuffer').evaluate(el =>
    Array.from((el as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 2, 1).data)
  )).toEqual([1, 2, 3, 255, 10, 20, 30, 255]);
  expect((await getCallsFor(page, 'cc_frame_read'))[0].args).toEqual({ token: '9007199254740993', offset: 0, length: 8 });
  expect((await getCallsFor(page, 'cc_frame_release'))[0].args).toEqual({ token: '9007199254740993' });
  await page.getByRole('region', { name: 'Guest display' }).screenshot({ path: testInfo.outputPath('display.png') });
});

test('shows transfer errors and releases the capture', async ({ page }) => {
  await setupTauriMock(page, {
    cc_frame_capture: { token: '7', sequence: '2', width: 2, height: 1, bytes: 8 },
    cc_frame_read: mockError('socket closed'), cc_frame_release: null,
  });
  await page.goto('/'); await connectApp(page);
  await page.getByRole('button', { name: 'Capture display' }).click();
  await expect(page.getByRole('alert')).toContainText('socket closed');
  expect(await getCallsFor(page, 'cc_frame_release')).toHaveLength(1);
  expect(await getCallsFor(page, 'cc_frame_read')).toHaveLength(1);
});

test('cancellation stops at one bounded read and still releases', async ({ page }) => {
  await setupTauriMock(page, {
    cc_frame_capture: { token: '8', sequence: '3', width: 1024, height: 1, bytes: 4096 },
    cc_frame_read: null, cc_frame_release: null,
  });
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd !== 'cc_frame_read') return result;
      return new Promise(resolve => { (window as any).finishFrameRead = () => resolve(new ArrayBuffer(args.length)); });
    };
  });
  await page.goto('/'); await connectApp(page);
  await page.getByRole('button', { name: 'Capture display' }).click();
  await expect.poll(async () => (await getCallsFor(page, 'cc_frame_read')).length).toBe(1);
  await page.getByRole('button', { name: /Cancel capture/ }).click();
  await page.evaluate(() => (window as any).finishFrameRead());
  await expect(page.getByRole('button', { name: 'Capture display' })).toBeVisible();
  expect(await getCallsFor(page, 'cc_frame_read')).toHaveLength(1);
  expect((await getCallsFor(page, 'cc_frame_read'))[0].args).toEqual({ token: '8', offset: 0, length: 4056 });
  expect(await getCallsFor(page, 'cc_frame_release')).toHaveLength(1);
  await expect(page.getByText('No frame captured')).toBeVisible();
});

test('switching guests discards an in-flight frame and releases its token', async ({ page }) => {
  await setupTauriMock(page, {
    cc_frame_capture: { token: '9', sequence: '4', width: 2, height: 1, bytes: 8 },
    cc_frame_read: null, cc_frame_release: null,
  });
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd !== 'cc_frame_read') return result;
      return new Promise(resolve => { (window as any).finishFrameRead = () => resolve(new ArrayBuffer(args.length)); });
    };
  });
  await page.goto('/'); await connectApp(page);
  await page.getByRole('button', { name: 'Capture display' }).click();
  await expect.poll(async () => (await getCallsFor(page, 'cc_frame_read')).length).toBe(1);
  await page.getByText('FreeBSD', { exact: true }).click();
  await page.evaluate(() => (window as any).finishFrameRead());
  await expect.poll(async () => (await getCallsFor(page, 'cc_frame_release')).length).toBe(1);
  await expect(page.getByRole('button', { name: 'Capture display' })).toBeDisabled();
  expect(await page.getByLabel('Captured guest framebuffer').evaluate(el => (el as HTMLCanvasElement).width)).toBe(1);
});
