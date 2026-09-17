import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GuestInfo, InputBatchAck } from '../types';
import { evdevKeys, GuestInput, type InputStatus } from '../guestInput';
import { useGuestPointer } from '../hooks/useGuestPointer';

interface FrameInfo {
  token: string;
  sequence: string;
  width: number;
  height: number;
  bytes: number;
}

export function GuestDisplay({ guest }: { guest: GuestInfo }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cancel = useRef(false);
  const active = useRef(false);
  const mounted = useRef(true);
  const watching = useRef(false);
  const nextCapture = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [details, setDetails] = useState('No frame captured');
  const [error, setError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [focused, setFocused] = useState(false);
  const [keyStatus, setKeyStatus] = useState<InputStatus>({ error: null, busy: false, batches: 0 });
  const [keyNotice, setKeyNotice] = useState<string | null>(null);
  const keyboard = useRef<GuestInput | null>(null);
  const available = guest.state === 4 || guest.state === 5;
  const canType = guest.state === 4 && hasFrame;
  const pointer = useGuestPointer(canvas, keyboard, canType, keyStatus.error);

  useEffect(() => {
    let alive = true;
    const input = new GuestInput((events, device) => invoke<InputBatchAck>('cc_input_submit', {
      handle: guest.guest_handle, device, events,
    }), status => { if (alive) setKeyStatus(status); });
    keyboard.current = input;
    const release = () => { input.release(); canvas.current?.blur(); };
    const visibility = () => { if (document.hidden) release(); };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      alive = false;
      input.dispose();
      keyboard.current = null;
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [guest.guest_handle]);

  useEffect(() => {
    if (!canType) { keyboard.current?.release(); canvas.current?.blur(); }
  }, [canType]);

  function sendKey(event: KeyboardEvent<HTMLCanvasElement>, down: boolean) {
    event.stopPropagation();
    if (down && event.code === 'Escape' && ((event.ctrlKey && event.altKey) || pointer.captured)) {
      event.preventDefault(); pointer.release(); event.currentTarget.blur(); return;
    }
    if (!canType) return;
    event.preventDefault();
    if (event.nativeEvent.isComposing) { setKeyNotice('Text composition is unavailable; use physical keys.'); return; }
    const code = evdevKeys[event.code];
    if (!code) { setKeyNotice(`Unsupported physical key: ${event.code}`); return; }
    setKeyNotice(null);
    keyboard.current?.transition(code, down, event.repeat);
  }

  function stopWatching() {
    watching.current = false;
    cancel.current = true;
    if (nextCapture.current !== null) clearTimeout(nextCapture.current);
    nextCapture.current = null;
    if (mounted.current) setLive(false);
  }

  useEffect(() => {
    mounted.current = true;
    const visibility = () => { if (document.hidden) stopWatching(); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false;
      stopWatching();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useEffect(() => {
    if (!available) {
      stopWatching();
      const target = canvas.current;
      target?.getContext('2d')?.clearRect(0, 0, target.width, target.height);
      setDetails('Guest display unavailable');
    }
  }, [available]);

  async function capture() {
    if (active.current || !available) return;
    active.current = true;
    cancel.current = false;
    setBusy(true); setProgress(0); setError(null);
    let frame: FrameInfo | null = null;
    let failure: string | null = null;
    const started = performance.now();
    try {
      frame = await invoke<FrameInfo>('cc_frame_capture', { handle: guest.guest_handle });
      if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
          frame.width < 1 || frame.width > 1024 || frame.height < 1 || frame.height > 768 ||
          frame.bytes !== frame.width * frame.height * 4) throw new Error('Invalid frame dimensions');
      const pixels = new Uint8ClampedArray(frame.bytes);
      for (let offset = 0; offset < frame.bytes; ) {
        if (cancel.current) return;
        const length = Math.min(4056, frame.bytes - offset);
        const data = await invoke<ArrayBuffer>('cc_frame_read', { token: frame.token, offset, length });
        const bytes = new Uint8Array(data);
        if (bytes.length !== length) throw new Error('Incomplete frame transfer');
        pixels.set(bytes, offset);
        offset += length;
        if (mounted.current) setProgress(Math.floor(offset * 100 / frame.bytes));
      }
      if (cancel.current || !mounted.current) return;
      // Little-endian XRGB8888 bytes are B,G,R,X; canvas requires R,G,B,A.
      for (let i = 0; i < pixels.length; i += 4) {
        const blue = pixels[i]; pixels[i] = pixels[i + 2]; pixels[i + 2] = blue; pixels[i + 3] = 255;
      }
      const target = canvas.current;
      if (!target) return;
      target.width = frame.width; target.height = frame.height;
      const context = target.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      context.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
      setHasFrame(true);
      const seconds = (performance.now() - started) / 1000;
      setDetails(`${frame.width} × ${frame.height} · frame ${frame.sequence} · ${(frame.bytes / 1024).toFixed(0)} KiB in ${seconds.toFixed(1)} s · captured ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      failure = String(e);
    } finally {
      if (frame) {
        try { await invoke('cc_frame_release', { token: frame.token }); }
        catch (e) { failure = [failure, `Frame release: ${e}`].filter(Boolean).join('; '); }
      }
      active.current = false;
      if (mounted.current) {
        setBusy(false);
        if (failure) { setError(failure); stopWatching(); }
        else if (watching.current && !cancel.current) {
          // Release has completed. Never queue captures behind a slow transfer.
          nextCapture.current = setTimeout(() => {
            nextCapture.current = null;
            if (watching.current) void capture();
          }, 250);
        }
      }
    }
  }

  return <section aria-label="Guest display" className="rounded-lg border border-os-border bg-os-surface p-4">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="font-mono text-sm text-os-text">Guest display</h2>
      <div className="flex gap-2">
      <button className="rounded border border-os-border px-3 py-1 text-xs text-os-text disabled:opacity-50"
        disabled={!canType || !!keyStatus.error} onClick={() => void pointer.capture()}>
        Capture pointer
      </button>
      <button className="rounded border border-os-border px-3 py-1 text-xs text-os-text disabled:opacity-50"
        disabled={!available || (!live && busy)} aria-pressed={live}
        onClick={() => {
          if (live) stopWatching();
          else { watching.current = true; setLive(true); void capture(); }
        }}>
        {live ? 'Stop live display' : 'Start live display'}
      </button>
      <button className="rounded border border-os-border px-3 py-1 text-xs text-os-text disabled:opacity-50"
        disabled={!available || live} onClick={() => { if (busy) stopWatching(); else void capture(); }}>
        {busy ? `Cancel capture (${progress}%)` : 'Capture display'}
      </button>
      </div>
    </div>
    <canvas ref={canvas} width={1} height={1} aria-label="Captured guest framebuffer"
      tabIndex={canType ? 0 : -1}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); keyboard.current?.release(); }}
      onKeyDown={event => sendKey(event, true)} onKeyUp={event => sendKey(event, false)}
      className="max-h-[32rem] w-full bg-black object-contain focus:outline focus:outline-2 focus:outline-os-accent" />
    <p className="mt-2 font-mono text-xs text-os-muted">{details}</p>
    <p className="mt-1 text-xs text-os-muted">{live ? 'Live display updates after each complete transfer.' : 'Display updates are stopped.'}</p>
    <p className="mt-1 text-xs text-os-muted">{canType
      ? `Click the display to type in the guest. Ctrl+Alt+Escape releases focus. ${keyStatus.batches} input batches acknowledged.`
      : 'Capture a running guest display to enable graphical keyboard input.'}</p>
    <p className="mt-1 text-xs text-os-muted">{focused ? 'Keyboard focused on guest.' : 'Keyboard focus is outside the guest.'}</p>
    <p className="mt-1 text-xs text-os-muted">{pointer.captured
      ? 'Pointer captured. Escape releases it.' : 'Pointer is outside the guest.'}</p>
    {pointer.notice && <p role="status" className="mt-1 text-xs text-os-muted">{pointer.notice}</p>}
    {keyNotice && <p className="mt-1 text-xs text-os-muted">{keyNotice}</p>}
    {keyStatus.error && <div role="alert" className="mt-2 text-xs text-red-400">
      <p>{keyStatus.error}</p>
      <button disabled={keyStatus.busy} onClick={() => void keyboard.current?.recover()}
        className="mt-1 rounded border border-os-border px-3 py-1 disabled:opacity-50">Release guest keys and buttons</button>
    </div>}
    {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
  </section>;
}
