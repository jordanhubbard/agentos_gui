import { test, expect, type Page } from '@playwright/test';
import { setupTauriMock, getCallsFor } from './helpers/tauri';
import { connectApp } from './helpers/app';

async function prepare(page: Page) {
  await setupTauriMock(page, {
    cc_frame_capture: { token: '20', sequence: '1', width: 2, height: 1, bytes: 8 },
    cc_frame_read: [3, 2, 1, 0, 30, 20, 10, 0], cc_frame_release: null,
    cc_input_submit: null,
  });
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd === 'cc_frame_read') return new Uint8Array(result).buffer;
      if (cmd === 'cc_input_submit') return { status: 0, accepted: args.events.length };
      return result;
    };
  });
}
async function focusDisplay(page: Page) {
  await page.goto('/'); await connectApp(page);
  await page.getByRole('button', { name: 'Capture display' }).click();
  await expect(page.getByText(/Click the display to type/)).toBeVisible();
  await page.getByLabel('Captured guest framebuffer').focus();
}
const key = (code: number, value: number) => ({ event_type: 1, code, value });
const syn = { event_type: 0, code: 0, value: 0 };

async function events(page: Page) {
  return (await getCallsFor(page, 'cc_input_submit')).flatMap(call => (call.args as any).events)
    .filter((event: any) => event.event_type === 1);
}

test('physical keys, repeat and modifiers reach the displayed guest without host shortcuts', async ({ page }) => {
  await prepare(page); await focusDisplay(page);
  await page.keyboard.down('Control'); await page.keyboard.press('r'); await page.keyboard.up('Control');
  await page.keyboard.down('a'); await page.keyboard.down('a'); await page.keyboard.up('a');
  await expect.poll(() => events(page)).toEqual([
    key(29, 1), key(19, 1), key(19, 0), key(29, 0), key(30, 1), key(30, 2), key(30, 0),
  ]);
  for (const call of await getCallsFor(page, 'cc_input_submit')) {
    expect(call.args).toMatchObject({ handle: 1, device: 0 });
    expect((call.args as any).events.at(-1)).toEqual(syn);
  }
  await expect(page.getByRole('region', { name: 'Guest display' })).toBeVisible();
});

test('focus loss queues key release behind the outstanding acknowledgment', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    let first = true;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd === 'cc_input_submit' && first) {
        first = false;
        return new Promise(resolve => { (window as any).ackKey = () => resolve(result); });
      }
      return result;
    };
  });
  await focusDisplay(page);
  await page.keyboard.down('Shift');
  await expect.poll(async () => (await getCallsFor(page, 'cc_input_submit')).length).toBe(1);
  await page.getByRole('button', { name: 'Capture display' }).focus();
  expect(await getCallsFor(page, 'cc_input_submit')).toHaveLength(1);
  await page.evaluate(() => (window as any).ackKey());
  await expect.poll(() => events(page)).toEqual([key(42, 1), key(42, 0)]);
  await page.keyboard.up('Shift');
});

test('lost acknowledgment halts presses and recovery sends only key releases', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    let first = true;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd === 'cc_input_submit' && first) { first = false; throw new Error('reply lost'); }
      return result;
    };
  });
  await focusDisplay(page); await page.keyboard.press('a');
  await expect(page.getByRole('alert')).toContainText('reply lost');
  await page.keyboard.press('b');
  expect(await getCallsFor(page, 'cc_input_submit')).toHaveLength(1);
  await page.getByRole('button', { name: 'Release guest keys' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await events(page)).toEqual([key(30, 1), key(30, 0)]);
});

test('only zero-accepted would-block replies permit a bounded retry', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      return cmd === 'cc_input_submit' ? { status: 3, accepted: 0 } : result;
    };
  });
  await focusDisplay(page); await page.keyboard.press('a');
  await expect(page.getByRole('alert')).toContainText('status=3');
  const calls = await getCallsFor(page, 'cc_input_submit');
  expect(calls).toHaveLength(4);
  for (const call of calls) expect((call.args as any).events).toEqual([key(30, 1), syn]);
});

test('guest switch releases held keys to the original handle', async ({ page }) => {
  await prepare(page); await focusDisplay(page); await page.keyboard.down('a');
  await expect.poll(async () => (await getCallsFor(page, 'cc_input_submit')).length).toBe(1);
  await page.getByText('FreeBSD', { exact: true }).click();
  await expect.poll(() => events(page)).toEqual([key(30, 1), key(30, 0)]);
  for (const call of await getCallsFor(page, 'cc_input_submit')) expect(call.args).toMatchObject({ handle: 1 });
  await page.keyboard.up('a');
});

test('focus escape releases modifiers and never sends Escape to the guest', async ({ page }) => {
  await prepare(page); await focusDisplay(page);
  await page.keyboard.press('Control+Alt+Escape');
  await expect(page.getByLabel('Captured guest framebuffer')).not.toBeFocused();
  await expect.poll(() => events(page)).toEqual([key(29, 1), key(56, 1), key(29, 0), key(56, 0)]);
});

test('queue overflow halts unsent repeats while retaining recovery for an in-flight press', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    let first = true;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd === 'cc_input_submit' && first) {
        first = false;
        return new Promise(resolve => { (window as any).ackKey = () => resolve(result); });
      }
      return result;
    };
  });
  await focusDisplay(page);
  await page.getByLabel('Captured guest framebuffer').evaluate(el => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'KeyA' }));
    for (let i = 0; i < 150; i++) el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'KeyA', repeat: true }));
  });
  await expect(page.getByRole('alert')).toContainText('input queue full');
  expect(await getCallsFor(page, 'cc_input_submit')).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Release guest keys' })).toBeDisabled();
  await page.evaluate(() => (window as any).ackKey());
  await page.getByRole('button', { name: 'Release guest keys' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await events(page)).toEqual([key(30, 1), key(30, 0)]);
});

test('malformed partial acknowledgment is never retried', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      return cmd === 'cc_input_submit' ? { status: 0, accepted: 1 } : result;
    };
  });
  await focusDisplay(page); await page.keyboard.press('a');
  await expect(page.getByRole('alert')).toContainText('accepted=1');
  expect(await getCallsFor(page, 'cc_input_submit')).toHaveLength(1);
});

test('window blur releases keys even if canvas blur is not delivered', async ({ page }) => {
  await prepare(page); await focusDisplay(page); await page.keyboard.down('a');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(() => events(page)).toEqual([key(30, 1), key(30, 0)]);
  await page.keyboard.up('a');
});
