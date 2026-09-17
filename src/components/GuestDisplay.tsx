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
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [details, setDetails] = useState('No frame captured');
  const [error, setError] = useState<string | null>(null);
  const available = guest.state === 4 || guest.state === 5;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel.current = true; };
  }, []);
  useEffect(() => {
    if (!available) {
      cancel.current = true;
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
        if (failure) setError(failure);
      }
    }
  }

  return <section aria-label="Guest display" className="rounded-lg border border-os-border bg-os-surface p-4">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="font-mono text-sm text-os-text">Guest display</h2>
      <button className="rounded border border-os-border px-3 py-1 text-xs text-os-text disabled:opacity-50"
        disabled={!available} onClick={() => { if (busy) cancel.current = true; else void capture(); }}>
        {busy ? `Cancel capture (${progress}%)` : 'Capture display'}
      </button>
    </div>
    <canvas ref={canvas} width={1} height={1} aria-label="Captured guest framebuffer"
      className="max-h-[32rem] w-full bg-black object-contain" />
    <p className="mt-2 font-mono text-xs text-os-muted">{details}</p>
    <p className="mt-1 text-xs text-os-muted">Still frame; keyboard input is available in the console below.</p>
    {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
  </section>;
}
