import { test, expect } from '@playwright/test';
import { setupTauriMock, getCallsFor } from './helpers/tauri';
import { connectApp, switchTab } from './helpers/app';

test.describe('CC API panel', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto('/');
    await connectApp(page);
    await switchTab(page, 'API');
  });

  test('shows the complete CC opcode surface', async ({ page }) => {
    await expect(page.getByText('CONNECT', { exact: true })).toBeVisible();
    await expect(page.getByText('SEND', { exact: true })).toBeVisible();
    await expect(page.getByText('RECV', { exact: true })).toBeVisible();
    await expect(page.getByText('ATTACH_FRAMEBUFFER', { exact: true })).toBeVisible();
    await expect(page.getByText('FAULT_INJECT', { exact: true })).toBeVisible();
    await expect(page.getByText('SUSPEND_GUEST', { exact: true })).toBeVisible();
    await expect(page.getByText('TRACE_DUMP', { exact: true })).toBeVisible();
  });

  test('Status probes the selected session', async ({ page }) => {
    await page.getByLabel('Session id').fill('0');
    await page.getByRole('button', { name: 'Status' }).click();
    const calls = await getCallsFor(page, 'cc_session_status');
    expect((calls.at(-1)!.args as any).sessionId).toBe(0);
  });

  test('Send and Recv exercise the legacy session API', async ({ page }) => {
    await page.getByLabel('Session command').fill('show guests');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Recv' }).click();

    const sendCalls = await getCallsFor(page, 'cc_session_send');
    const recvCalls = await getCallsFor(page, 'cc_session_recv');
    expect((sendCalls.at(-1)!.args as any).cmdType).toBe(1);
    expect((sendCalls.at(-1)!.args as any).command).toBe('show guests');
    expect((recvCalls.at(-1)!.args as any).max).toBe(4096);
  });

  test('Attach wires a framebuffer handle to a guest handle', async ({ page }) => {
    await expect(page.getByLabel('Framebuffer device')).toHaveValue('10');
    await page.getByRole('button', { name: 'Attach' }).click();
    const calls = await getCallsFor(page, 'cc_attach_framebuffer');
    expect((calls.at(-1)!.args as any).guestHandle).toBe(1);
    expect((calls.at(-1)!.args as any).fbHandle).toBe(10);
  });

  test('Inject calls cc_fault_inject with numeric fields', async ({ page }) => {
    await page.getByLabel('Fault slot').fill('2');
    await page.getByLabel('Fault kind').fill('7');
    await page.getByLabel('Fault flags').fill('1');
    await page.getByRole('button', { name: 'Inject' }).click();
    const calls = await getCallsFor(page, 'cc_fault_inject');
    expect((calls.at(-1)!.args as any)).toMatchObject({
      slotId: 2,
      faultKind: 7,
      flags: 1,
    });
  });

  test('TraceRecorder controls call the trace relay surface', async ({ page }) => {
    await page.getByLabel('Trace flags').fill('1');
    await page.getByLabel('Trace limit').fill('64');
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('button', { name: 'Query' }).click();
    await page.getByRole('button', { name: 'Dump' }).click();
    await page.getByRole('button', { name: 'Stop' }).click();

    const starts = await getCallsFor(page, 'cc_trace_start');
    const dumps = await getCallsFor(page, 'cc_trace_dump');
    expect((starts.at(-1)!.args as any).flags).toBe(1);
    expect((dumps.at(-1)!.args as any).maxEvents).toBe(64);
    await expect(page.getByText('TraceRecorder')).toBeVisible();
    await expect(page.getByText('linux_vmm')).toBeVisible();
  });
});
