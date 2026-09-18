import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Download } from 'lucide-react';
import type { GuestInfo, InputEvent } from '../types';
import {
  CC_INPUT_KEY_DOWN,
  rawTerminalKeycode,
} from '../types';

interface Props {
  guest: GuestInfo | null;
  chunks: string[];
  onFetch: () => Promise<string>;
  onSendInput: (handle: number, event: InputEvent) => Promise<void>;
}

const encoder = new TextEncoder();

export function GuestConsole({ guest, chunks, onFetch, onSendInput }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const chunkIndexRef = useRef(0);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const guestRef = useRef<GuestInfo | null>(guest);
  const onSendInputRef = useRef(onSendInput);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    guestRef.current = guest;
  }, [guest]);

  useEffect(() => {
    onSendInputRef.current = onSendInput;
  }, [onSendInput]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 8000,
      theme: {
        background: '#0b0d10',
        foreground: '#e7edf2',
        cursor: '#2dd4bf',
        selectionBackground: '#2dd4bf44',
        black: '#101112',
        red: '#f87171',
        green: '#6ee7b7',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#2dd4bf',
        white: '#e7edf2',
        brightBlack: '#7b8491',
        brightRed: '#fca5a5',
        brightGreen: '#a7f3d0',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#99f6e4',
        brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.focus();

    termRef.current = term;
    setReady(true);

    const dataDisposable = term.onData(data => queueTerminalData(data));
    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => fit.fit());
    });
    resizeObserver.observe(host);
    window.requestAnimationFrame(() => fit.fit());

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      setReady(false);
      termRef.current = null;
      term.dispose();
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !ready) return;

    if (chunks.length < chunkIndexRef.current) {
      term.clear();
      chunkIndexRef.current = 0;
    }

    while (chunkIndexRef.current < chunks.length) {
      term.write(chunks[chunkIndexRef.current]);
      chunkIndexRef.current += 1;
    }
  }, [chunks, ready]);

  async function drain() {
    setBusy(true);
    setStatus(null);
    try {
      const text = await onFetch();
      setStatus(text ? `${text.length} bytes` : '0 bytes');
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
      termRef.current?.focus();
    }
  }

  function queueTerminalData(data: string) {
    const bytes = encoder.encode(data);
    if (bytes.length === 0) return;

    sendQueueRef.current = sendQueueRef.current
      .then(async () => {
        const selectedGuest = guestRef.current;
        if (!selectedGuest) return;

        for (const byte of bytes) {
          await onSendInputRef.current(selectedGuest.guest_handle, {
            event_type: CC_INPUT_KEY_DOWN,
            keycode: rawTerminalKeycode(byte),
            dx: 0,
            dy: 0,
            btn_mask: 0,
          });
        }
      })
      .catch(err => setStatus(String(err)));
  }

  return (
    <section className="flex min-h-[32rem] flex-col overflow-hidden rounded-lg border border-os-border bg-os-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-os-border px-4 py-3">
        <div className="mr-auto min-w-0">
          <h3 className="font-mono text-xs font-semibold uppercase text-os-muted">
            Console
          </h3>
          {guest && (
            <p className="truncate font-mono text-xs text-os-text">
              selected 0x{guest.guest_handle.toString(16).padStart(8, '0')}
            </p>
          )}
        </div>
        {status && (
          <span className="font-mono text-xs text-os-muted">{status}</span>
        )}
        <button
          onClick={drain}
          disabled={busy || !guest}
          title="Drain"
          className="flex h-8 items-center gap-2 rounded-lg border border-os-border px-3 font-mono text-xs
                     text-os-muted transition hover:border-os-accent/50 hover:text-os-accent
                     disabled:opacity-40"
        >
          <Download aria-hidden="true" className="h-3.5 w-3.5" />
          Drain
        </button>
      </div>

      <div
        ref={hostRef}
        role="application"
        aria-label="Guest terminal"
        data-testid="guest-terminal"
        onClick={() => termRef.current?.focus()}
        className="guest-terminal-host min-h-0 flex-1 bg-[#0b0d10] p-2 outline-none focus-within:ring-1 focus-within:ring-os-accent/60"
      />
    </section>
  );
}
