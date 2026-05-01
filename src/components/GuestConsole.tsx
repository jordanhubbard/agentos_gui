import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { GuestInfo, InputEvent } from '../types';
import {
  CC_INPUT_KEY_DOWN,
  rawTerminalKeycode,
} from '../types';

interface Props {
  guest: GuestInfo | null;
  lines: string[];
  onFetch: (slot: number, pdId: number) => Promise<string>;
  onSendInput: (handle: number, event: InputEvent) => Promise<void>;
}

const KEY_ENTER = 0x28;
const KEY_ESCAPE = 0x29;
const KEY_CTRL_C = rawTerminalKeycode(0x03);

export function GuestConsole({ guest, lines, onFetch, onSendInput }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [slot, setSlot] = useState(0);
  const [pdId, setPdId] = useState(0);
  const [inputValue, setInputValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  async function drain() {
    setBusy(true);
    setStatus(null);
    try {
      const text = await onFetch(slot, pdId);
      setStatus(text ? `${text.length} bytes` : '0 bytes');
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendKey(keycode: number, label?: string) {
    if (!guest) return;
    setStatus(null);
    try {
      await onSendInput(guest.guest_handle, {
        event_type: CC_INPUT_KEY_DOWN,
        keycode,
        dx: 0,
        dy: 0,
        btn_mask: 0,
      });
      if (label) setStatus(`${label} sent`);
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function sendTerminalByte(byte: number) {
    await sendKey(rawTerminalKeycode(byte));
  }

  async function sendConsoleLine(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!guest || inputValue.length === 0) return;

    const text = inputValue;
    setInputValue('');
    try {
      for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (code <= 0xff) await sendTerminalByte(code);
      }
      await sendTerminalByte(0x0d);
      setStatus(`${text.length + 1} bytes sent`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      inputRef.current?.focus();
    }
  }

  function keyToTerminalByte(e: KeyboardEvent<HTMLDivElement>): number | null {
    if (e.metaKey || e.altKey) return null;
    if (e.ctrlKey) {
      const key = e.key.toLowerCase();
      if (key.length === 1 && key >= 'a' && key <= 'z') {
        return key.charCodeAt(0) - 96;
      }
      return null;
    }
    switch (e.key) {
      case 'Enter': return 0x0d;
      case 'Backspace': return 0x7f;
      case 'Tab': return 0x09;
      case 'Escape': return 0x1b;
      default:
        if (e.key.length === 1) {
          const code = e.key.charCodeAt(0);
          return code <= 0xff ? code : null;
        }
        return null;
    }
  }

  function handleTerminalKey(e: KeyboardEvent<HTMLDivElement>) {
    const byte = keyToTerminalByte(e);
    if (byte === null) return;
    e.preventDefault();
    e.stopPropagation();
    void sendTerminalByte(byte);
  }

  return (
    <section className="flex min-h-[24rem] flex-col rounded-xl border border-os-border bg-os-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-os-border px-4 py-3">
        <div className="mr-auto">
          <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-os-muted">
            Console
          </h3>
          {guest && (
            <p className="font-mono text-xs text-os-text">
              selected 0x{guest.guest_handle.toString(16).padStart(8, '0')}
            </p>
          )}
        </div>

        <label htmlFor="console-slot" className="font-mono text-xs text-os-muted">slot</label>
        <input
          id="console-slot"
          type="number"
          min={0}
          value={slot}
          onChange={e => setSlot(Math.max(0, Number(e.target.value)))}
          className="w-14 rounded border border-os-border bg-os-bg px-2 py-1
                     font-mono text-xs text-os-text focus:border-os-accent focus:outline-none"
        />
        <label htmlFor="console-pd" className="font-mono text-xs text-os-muted">pd</label>
        <input
          id="console-pd"
          type="number"
          min={0}
          value={pdId}
          onChange={e => setPdId(Math.max(0, Number(e.target.value)))}
          className="w-14 rounded border border-os-border bg-os-bg px-2 py-1
                     font-mono text-xs text-os-text focus:border-os-accent focus:outline-none"
        />
        <button
          onClick={drain}
          disabled={busy}
          className="rounded-lg border border-os-border px-3 py-1.5 font-mono text-xs
                     text-os-muted transition hover:border-os-accent/50 hover:text-os-accent
                     disabled:opacity-40"
        >
          Drain
        </button>
      </div>

      <div className="flex gap-2 border-b border-os-border px-4 py-2">
        <button
          onClick={() => sendKey(KEY_ENTER, 'Enter')}
          disabled={!guest}
          className="rounded border border-os-border px-2.5 py-1 font-mono text-xs text-os-muted
                     hover:border-os-accent/50 hover:text-os-accent disabled:opacity-40"
        >
          Enter
        </button>
        <button
          onClick={() => sendKey(KEY_ESCAPE, 'Esc')}
          disabled={!guest}
          className="rounded border border-os-border px-2.5 py-1 font-mono text-xs text-os-muted
                     hover:border-os-accent/50 hover:text-os-accent disabled:opacity-40"
        >
          Esc
        </button>
        <button
          onClick={() => sendKey(KEY_CTRL_C, '^C')}
          disabled={!guest}
          className="rounded border border-os-border px-2.5 py-1 font-mono text-xs text-os-muted
                     hover:border-os-accent/50 hover:text-os-accent disabled:opacity-40"
        >
          ^C
        </button>
        {status && (
          <span className="ml-auto self-center font-mono text-xs text-os-muted">{status}</span>
        )}
      </div>

      <div
        ref={scrollRef}
        role="textbox"
        aria-label="Guest terminal"
        tabIndex={0}
        onClick={() => inputRef.current?.focus()}
        onKeyDown={handleTerminalKey}
        className="flex-1 overflow-y-auto bg-black/40 p-4 font-mono text-xs leading-relaxed
                   outline-none focus:ring-1 focus:ring-os-accent/60"
      >
        {lines.length === 0 ? (
          <p className="text-os-muted">No console bytes returned</p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="text-os-text/80">{line}</div>
          ))
        )}
      </div>

      <form
        onSubmit={sendConsoleLine}
        className="flex items-center gap-2 border-t border-os-border bg-os-bg/70 px-4 py-3"
      >
        <label htmlFor="console-input" className="font-mono text-xs text-os-muted">
          ttyAMA0
        </label>
        <input
          ref={inputRef}
          id="console-input"
          aria-label="Console input"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          disabled={!guest}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-os-border bg-black/30 px-3 py-2
                     font-mono text-xs text-os-text outline-none focus:border-os-accent
                     disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={!guest || inputValue.length === 0}
          className="rounded border border-os-accent/60 px-3 py-2 font-mono text-xs
                     text-os-accent transition hover:bg-os-accent/10 disabled:border-os-border
                     disabled:text-os-muted disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}
