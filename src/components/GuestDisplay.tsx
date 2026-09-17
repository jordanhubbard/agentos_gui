import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GuestInfo } from '../types';

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
  const available = guest.state === 4 || guest.state === 5;

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
      className="max-h-[32rem] w-full bg-black object-contain" />
    <p className="mt-2 font-mono text-xs text-os-muted">{details}</p>
    <p className="mt-1 text-xs text-os-muted">{live ? 'Live display updates after each complete transfer.' : 'Display updates are stopped.'} Keyboard input is available in the console below.</p>
    {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
  </section>;
}
