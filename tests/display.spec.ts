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

test('assembles bounded batch prefixes without skipping pixels', async ({ page }) => {
  await setupTauriMock(page, {
    cc_frame_capture: { token: 'batch', sequence: '8', width: 1024, height: 8, bytes: 32768 },
    cc_frame_read: null, cc_frame_release: null,
  });
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd !== 'cc_frame_read') return result;
      const length = args.offset === 0 ? 4056 : args.length;
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 4) {
        bytes[i] = 9; bytes[i + 1] = 7;
        bytes[i + 2] = ((args.offset + i) / 4) % 251;
      }
      return bytes.buffer;
    };
  });
  await page.goto('/'); await connectApp(page);
  await page.getByRole('button', { name: 'Capture display' }).click();
  await expect(page.getByText(/frame 8 ·/)).toBeVisible();
  const reads = await getCallsFor(page, 'cc_frame_read');
  expect(reads.map(call => call.args)).toEqual([
    { token: 'batch', offset: 0, length: 32448 },
    { token: 'batch', offset: 4056, length: 28712 },
  ]);
  expect(await page.getByLabel('Captured guest framebuffer').evaluate(el => {
    const data = (el as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1024, 8).data;
    return [Array.from(data.slice(4052, 4064)), Array.from(data.slice(-4))];
  })).toEqual([
    [1013 % 251, 7, 9, 255, 1014 % 251, 7, 9, 255, 1015 % 251, 7, 9, 255],
    [8191 % 251, 7, 9, 255],
  ]);
  expect(await getCallsFor(page, 'cc_frame_release')).toHaveLength(1);
});

for (const length of [0, 9]) {
  test(`rejects invalid batch response length ${length}`, async ({ page }) => {
    await setupTauriMock(page, {
      cc_frame_capture: { token: 'bad', sequence: '9', width: 2, height: 1, bytes: 8 },
      cc_frame_read: null, cc_frame_release: null,
    });
    await page.addInitScript((size) => {
      const original = (window as any).__TAURI_INTERNALS__.invoke;
      (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
        const result = await original(cmd, args);
        return cmd === 'cc_frame_read' ? new ArrayBuffer(size) : result;
      };
    }, length);
    await page.goto('/'); await connectApp(page);
    await page.getByRole('button', { name: 'Capture display' }).click();
    await expect(page.getByRole('alert')).toContainText('Invalid frame transfer length');
    expect(await getCallsFor(page, 'cc_frame_release')).toHaveLength(1);
    await expect(page.getByText('No frame captured')).toBeVisible();
  });
}

test('cancellation stops at one bounded read and still releases', async ({ page }) => {
  await setupTauriMock(page, {
    cc_frame_capture: { token: '8', sequence: '3', width: 1024, height: 16, bytes: 65536 },
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
  expect((await getCallsFor(page, 'cc_frame_read'))[0].args).toEqual({ token: '8', offset: 0, length: 32448 });
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

test('live display waits for release and stops without another capture', async ({ page }) => {
  await setupTauriMock(page, {
    cc_frame_capture: { token: '10', sequence: '5', width: 2, height: 1, bytes: 8 },
    cc_frame_read: [3, 2, 1, 0, 30, 20, 10, 0], cc_frame_release: null,
  });
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: unknown) => {
      const result = await original(cmd, args);
      if (cmd === 'cc_frame_read') return new Uint8Array(result).buffer;
      if (cmd === 'cc_frame_release') return new Promise(resolve => {
        (window as any).finishRelease = () => resolve(null);
      });
      return result;
    };
  });
  await page.goto('/'); await connectApp(page);
  await page.getByRole('button', { name: 'Start live display' }).click();
  await expect.poll(async () => (await getCallsFor(page, 'cc_frame_release')).length).toBe(1);
  await page.waitForTimeout(600);
  expect(await getCallsFor(page, 'cc_frame_capture')).toHaveLength(1);
  await page.evaluate(() => (window as any).finishRelease());
  await expect.poll(async () => (await getCallsFor(page, 'cc_frame_release')).length).toBe(2);
  await page.getByRole('button', { name: 'Stop live display' }).click();
  await page.evaluate(() => (window as any).finishRelease());
  await expect(page.getByRole('button', { name: 'Capture display' })).toBeEnabled();
  await page.waitForTimeout(600);
  expect(await getCallsFor(page, 'cc_frame_capture')).toHaveLength(2);
});

test('live display stops on release failure without retrying', async ({ page }) => {
  await setupTauriMock(page, {
    cc_frame_capture: { token: '11', sequence: '6', width: 2, height: 1, bytes: 8 },
    cc_frame_read: mockError('read failed'), cc_frame_release: mockError('release failed'),
  });
  await page.goto('/'); await connectApp(page);
  await page.getByRole('button', { name: 'Start live display' }).click();
  await expect(page.getByRole('alert')).toContainText('release failed');
  await expect(page.getByRole('button', { name: 'Start live display' })).toBeVisible();
  await page.waitForTimeout(600);
  expect(await getCallsFor(page, 'cc_frame_capture')).toHaveLength(1);
  expect(await getCallsFor(page, 'cc_frame_release')).toHaveLength(1);
});

test('hiding the window cancels live capture and releases without presenting', async ({ page }) => {
  await setupTauriMock(page, {
    cc_frame_capture: { token: '12', sequence: '7', width: 2, height: 1, bytes: 8 },
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
  await page.getByRole('button', { name: 'Start live display' }).click();
  await expect.poll(async () => (await getCallsFor(page, 'cc_frame_read')).length).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    (window as any).finishFrameRead();
  });
  await expect.poll(async () => (await getCallsFor(page, 'cc_frame_release')).length).toBe(1);
  await expect(page.getByText('No frame captured')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start live display' })).toBeVisible();
  await page.waitForTimeout(600);
  expect(await getCallsFor(page, 'cc_frame_capture')).toHaveLength(1);
});
