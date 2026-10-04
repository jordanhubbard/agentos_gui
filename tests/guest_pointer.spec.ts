import { test, expect, type Page } from '@playwright/test';
import { setupTauriMock, getCallsFor } from './helpers/tauri';
import { connectApp } from './helpers/app';
import { wheelAxisSteps } from '../src/guestInput';

test('native wheel ticks preserve detents without rounding fractional sources', () => {
  expect(wheelAxisSteps(-84, 0, 120, true)).toBe(-1);
  expect(wheelAxisSteps(84, 0, -120, true)).toBe(1);
  expect(wheelAxisSteps(-168, 0, 240, true)).toBe(-2);
  expect(wheelAxisSteps(-84, 0, 120, false)).toBe(-0.84);
  expect(wheelAxisSteps(-25, 0, 30, true)).toBe(-0.25);
  expect(wheelAxisSteps(25, 0, undefined, true)).toBe(0.25);
  expect(wheelAxisSteps(-84, 0, -120, true)).toBe(-0.84);
  expect(wheelAxisSteps(-84, 0, NaN, true)).toBe(-0.84);
  expect(wheelAxisSteps(0, 0, 120, true)).toBe(0);
  expect(wheelAxisSteps(-3, 1, 120, true)).toBe(-1);
  expect(wheelAxisSteps(-1, 2, 120, true)).toBe(-1);
});

async function prepare(page: Page) {
  await setupTauriMock(page, {
    cc_frame_capture: { token: '30', sequence: '1', width: 2, height: 1, bytes: 8 },
    cc_frame_read: [3, 2, 1, 0, 30, 20, 10, 0], cc_frame_release: null, cc_input_submit: null,
  });
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd === 'cc_frame_read') return new Uint8Array(result).buffer;
      if (cmd === 'cc_input_submit') return { status: 0, accepted: args.events.length };
      return result;
    };
    let locked: Element | null = null;
    Object.defineProperty(document, 'pointerLockElement', { get: () => locked, configurable: true });
    HTMLElement.prototype.requestPointerLock = function () {
      locked = this; document.dispatchEvent(new Event('pointerlockchange')); return Promise.resolve();
    };
    document.exitPointerLock = () => { locked = null; document.dispatchEvent(new Event('pointerlockchange')); };
  });
}
async function capture(page: Page) {
  await page.goto('/'); await connectApp(page);
  await page.getByRole('button', { name: 'Capture display' }).click();
  await expect(page.getByRole('button', { name: 'Capture pointer' })).toBeEnabled();
  await page.getByRole('button', { name: 'Capture pointer' }).click();
  await expect(page.getByText('Pointer captured. Escape releases it.')).toBeVisible();
}
async function payloads(page: Page) {
  return (await getCallsFor(page, 'cc_input_submit')).flatMap(call => {
    const args = call.args as any;
    return args.events.filter((event: any) => event.event_type !== 0).map((event: any) => ({ device: args.device, ...event }));
  });
}
const event = (device: number, event_type: number, code: number, value: number) => ({ device, event_type, code, value });

test('captured motion, buttons and normalized wheels use the pointer device', async ({ page }) => {
  await prepare(page); await capture(page);
  await page.getByLabel('Captured guest framebuffer').evaluate(el => {
    el.dispatchEvent(new MouseEvent('mousemove', { movementX: 17, movementY: -9 }));
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, deltaX: 100 }));
    el.dispatchEvent(new MouseEvent('mousedown', { button: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup', { button: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
    el.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
  });
  await expect.poll(() => payloads(page)).toEqual([
    event(1,2,0,17), event(1,2,1,-9), event(1,1,272,1), event(1,1,272,0),
    event(1,2,6,1), event(1,2,8,1), event(1,1,274,1), event(1,1,274,0), event(1,1,273,1), event(1,1,273,0),
  ]);
});

test('modifier and click ordering survives a pending keyboard acknowledgment', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    let first = true;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd === 'cc_input_submit' && first) {
        first = false;
        return new Promise(resolve => { (window as any).ackInput = () => resolve(result); });
      }
      return result;
    };
  });
  await capture(page);
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.getByLabel('Captured guest framebuffer').evaluate(el => {
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
  });
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  expect(await getCallsFor(page, 'cc_input_submit')).toHaveLength(1);
  await page.evaluate(() => (window as any).ackInput());
  await expect.poll(() => payloads(page)).toEqual([
    event(0,1,29,1), event(0,1,42,1), event(1,1,272,1), event(1,1,272,0), event(0,1,42,0), event(0,1,29,0),
  ]);
});

test('capture loss releases a held button and discards further motion', async ({ page }) => {
  await prepare(page); await capture(page);
  await page.getByLabel('Captured guest framebuffer').evaluate(el => {
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    document.exitPointerLock();
    el.dispatchEvent(new MouseEvent('mousemove', { movementX: 90 }));
  });
  await expect.poll(() => payloads(page)).toEqual([event(1,1,272,1), event(1,1,272,0)]);
  await expect(page.getByText('Pointer is outside the guest.')).toBeVisible();
});

test('lost pointer reply never replays motion or presses during recovery', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    let first = true;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd === 'cc_input_submit' && first) { first = false; throw new Error('pointer reply lost'); }
      return result;
    };
  });
  await capture(page);
  await page.getByLabel('Captured guest framebuffer').evaluate(el => el.dispatchEvent(new MouseEvent('mousedown', { button: 0 })));
  await expect(page.getByRole('alert')).toContainText('pointer reply lost');
  await expect(page.getByText('Pointer is outside the guest.')).toBeVisible();
  await page.getByRole('button', { name: 'Release guest keys and buttons' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await payloads(page)).toEqual([event(1,1,272,1), event(1,1,272,0)]);
});

test('denied capture is visible and emits no guest input', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    HTMLElement.prototype.requestPointerLock = () => Promise.reject(new Error('denied'));
  });
  await page.goto('/'); await connectApp(page);
  await page.getByRole('button', { name: 'Capture display' }).click();
  await page.getByRole('button', { name: 'Capture pointer' }).click();
  await expect(page.getByRole('status')).toContainText('denied');
  expect(await getCallsFor(page, 'cc_input_submit')).toHaveLength(0);
});

test('motion bursts coalesce without crossing a button boundary or losing displacement', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    let first = true;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd === 'cc_input_submit' && first) {
        first = false;
        return new Promise(resolve => { (window as any).ackInput = () => resolve(result); });
      }
      return result;
    };
  });
  await capture(page);
  await page.getByLabel('Captured guest framebuffer').evaluate(el => {
    for (let i = 0; i < 300; i++) el.dispatchEvent(new MouseEvent('mousemove', { movementX: 1, movementY: 2 }));
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    el.dispatchEvent(new MouseEvent('mousemove', { movementX: -7 }));
    el.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
  });
  expect(await getCallsFor(page, 'cc_input_submit')).toHaveLength(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => (window as any).ackInput());
  await expect.poll(() => payloads(page)).toEqual([
    event(1,2,0,1), event(1,2,1,600), event(1,2,0,299), event(1,1,272,1), event(1,2,0,-7), event(1,1,272,0),
  ]);
});

test('fractional wheel deltas accumulate and capture reset discards the remainder', async ({ page }) => {
  await prepare(page); await capture(page);
  await page.getByLabel('Captured guest framebuffer').evaluate(el => {
    for (let i = 0; i < 5; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: 25 }));
    document.exitPointerLock();
  });
  await expect.poll(() => payloads(page)).toEqual([event(1,2,8,-1)]);
  await page.getByRole('button', { name: 'Capture pointer' }).click();
  await page.getByLabel('Captured guest framebuffer').evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 75 }));
    document.exitPointerLock();
  });
  expect(await payloads(page)).toEqual([event(1,2,8,-1)]);
});
