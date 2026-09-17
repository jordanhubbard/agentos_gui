import type { DesktopInputEvent, InputBatchAck } from './types';

// KeyboardEvent.code describes physical positions, matching Linux evdev keys.
// Text composition and host keyboard layout translation are not sent as keys.
export const evdevKeys: Readonly<Record<string, number>> = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11, Minus: 12,
  Equal: 13, Backspace: 14, Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18,
  KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35,
  KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41,
  ShiftLeft: 42, Backslash: 43, KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47,
  KeyB: 48, KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66,
  F9: 67, F10: 68, NumLock: 69, ScrollLock: 70, Numpad7: 71, Numpad8: 72,
  Numpad9: 73, NumpadSubtract: 74, Numpad4: 75, Numpad5: 76, Numpad6: 77,
  NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82,
  NumpadDecimal: 83, IntlBackslash: 86, F11: 87, F12: 88,
  NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99,
  AltRight: 100, Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105,
  ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109, Insert: 110,
  Delete: 111, Pause: 119, MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
};

export interface InputStatus { error: string | null; busy: boolean; batches: number }
type Submit = (events: DesktopInputEvent[], device: number) => Promise<InputBatchAck>;
type QueuedEvent = DesktopInputEvent & { device: number };
const key = (code: number, value: number): DesktopInputEvent => ({ event_type: 1, code, value });
const sync = (): DesktopInputEvent => ({ event_type: 0, code: 0, value: 0 });

export class GuestInput {
  private pending: QueuedEvent[] = [];
  private physical = new Set<number>();
  private possible = new Set<number>();
  private running = false;
  private closed = false;
  private error: string | null = null;
  private batches = 0;

  constructor(private submit: Submit, private report: (status: InputStatus) => void,
    private label = 'Input') {}

  private publish() { this.report({ error: this.error, busy: this.running, batches: this.batches }); }
  private fail(reason: unknown) {
    this.error = `${this.label} stopped: ${String(reason)}. Guest keys or buttons may remain pressed; release them before continuing.`;
    this.pending = []; this.physical.clear(); this.publish();
  }

  transition(code: number, down: boolean, repeat: boolean, device = 0) {
    if (this.closed || this.error) return;
    const id = device * 65536 + code;
    if (down) {
      if (repeat && !this.physical.has(id)) return;
      if (!repeat && this.physical.has(id)) return;
      this.physical.add(id);
    } else if (!this.physical.delete(id)) return;
    this.enqueue({ ...key(code, down ? (repeat ? 2 : 1) : 0), device });
  }

  private enqueue(event: QueuedEvent) {
    if (this.pending.length >= 128) { this.fail('input queue full'); return; }
    this.pending.push(event);
    void this.pump();
  }

  relative(code: number, value: number) {
    if (this.closed || this.error || value === 0) return;
    if (![0, 1, 6, 8].includes(code) || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
      this.fail('invalid relative input'); return;
    }
    // Coalesce unsent X/Y motion, but never cross a button or wheel transition.
    if (code === 0 || code === 1) {
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const event = this.pending[i];
        if (event.device !== 1 || event.event_type !== 2 || event.code > 1) break;
        if (event.code === code) {
          const sum = event.value + value;
          if (sum < -2147483648 || sum > 2147483647) { this.fail('relative input overflow'); return; }
          event.value = sum; return;
        }
      }
    }
    this.enqueue({ event_type: 2, code, value, device: 1 });
  }

  release(device?: number) {
    const keys = [...this.physical].filter(id => device === undefined || Math.floor(id / 65536) === device);
    for (const id of keys) this.physical.delete(id);
    for (const id of keys) {
      if (this.error) break;
      this.enqueue({ ...key(id % 65536, 0), device: Math.floor(id / 65536) });
    }
  }

  dispose() { this.closed = true; this.release(); }

  private async send(events: DesktopInputEvent[], device: number) {
    for (let retry = 0; ; retry++) {
      const ack = await this.submit(events, device);
      if (ack.status === 0 && ack.accepted === events.length) { this.batches++; return; }
      if (ack.status === 3 && ack.accepted === 0 && retry < 3) {
        await new Promise(resolve => setTimeout(resolve, 20));
        continue;
      }
      throw new Error(`input acknowledgment status=${ack.status}, accepted=${ack.accepted}`);
    }
  }

  private async pump() {
    if (this.running || this.error) return;
    this.running = true; this.publish();
    try {
      while (this.pending.length && !this.error) {
        const device = this.pending[0].device;
        let count = 1;
        while (count < 63 && count < this.pending.length && this.pending[count].device === device) count++;
        const events = this.pending.splice(0, count).map(({ event_type, code, value }) => ({ event_type, code, value }));
        // A lost reply may follow a consumed press. Retain it for explicit recovery.
        for (const event of events) if (event.event_type === 1 && event.value !== 0) this.possible.add(device * 65536 + event.code);
        await this.send([...events, sync()], device);
        for (const event of events) {
          if (event.event_type !== 1) continue;
          if (event.value === 0) this.possible.delete(device * 65536 + event.code);
          else this.possible.add(device * 65536 + event.code);
        }
      }
    } catch (e) { this.fail(e); }
    finally { this.running = false; this.publish(); }
  }

  async recover() {
    if (this.running || this.closed || !this.error) return;
    this.running = true; this.publish();
    try {
      for (const device of [0, 1]) {
        const codes = [...this.possible].filter(id => Math.floor(id / 65536) === device);
        for (let offset = 0; offset < codes.length; offset += 63) {
          const chunk = codes.slice(offset, offset + 63);
          await this.send([...chunk.map(id => key(id % 65536, 0)), sync()], device);
          for (const id of chunk) this.possible.delete(id);
        }
      }
      this.error = null;
    } catch (e) { this.fail(e); }
    finally { this.running = false; this.publish(); }
  }
}
