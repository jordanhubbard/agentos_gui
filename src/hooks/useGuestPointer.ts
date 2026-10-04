import { useEffect, useRef, useState, type RefObject } from 'react';
import { wheelAxisSteps, type GuestInput } from '../guestInput';

// DOM left/middle/right/back/forward to Linux BTN_LEFT/MIDDLE/RIGHT/SIDE/EXTRA.
const buttons = [0x110, 0x112, 0x111, 0x113, 0x114];

export function useGuestPointer(canvas: RefObject<HTMLCanvasElement>, input: RefObject<GuestInput>,
  enabled: boolean, error: string | null) {
  const allowed = useRef(enabled); allowed.current = enabled;
  const [captured, setCaptured] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function release() {
    input.current?.release();
    if (document.pointerLockElement === canvas.current) document.exitPointerLock();
  }

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    let dx = 0, dy = 0, wx = 0, wy = 0;
    const locked = () => allowed.current && document.pointerLockElement === target;
    const changed = () => {
      const active = locked();
      setCaptured(active);
      dx = dy = wx = wy = 0;
      if (active) { target.focus(); setNotice(null); }
      else input.current?.release();
      if (!allowed.current && document.pointerLockElement === target) document.exitPointerLock();
    };
    const lockError = () => setNotice('Pointer capture was denied or is unavailable in this window.');
    const move = (event: MouseEvent) => {
      if (!locked()) return;
      dx += event.movementX; dy += event.movementY;
      const x = Math.trunc(dx), y = Math.trunc(dy);
      dx -= x; dy -= y;
      input.current?.relative(0, x); input.current?.relative(1, y);
    };
    const button = (event: MouseEvent) => {
      if (!locked()) return;
      event.preventDefault(); event.stopPropagation();
      const code = buttons[event.button];
      if (code !== undefined) input.current?.transition(code, event.type === 'mousedown', false, 1);
    };
    const wheel = (event: WheelEvent) => {
      if (!locked()) return;
      event.preventDefault(); event.stopPropagation();
      // Convert high-resolution browser deltas to integral evdev wheel detents.
      const native = event as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
      wx += wheelAxisSteps(event.deltaX, event.deltaMode, native.wheelDeltaX, event.isTrusted);
      wy -= wheelAxisSteps(event.deltaY, event.deltaMode, native.wheelDeltaY, event.isTrusted);
      const x = Math.trunc(wx), y = Math.trunc(wy);
      wx -= x; wy -= y;
      input.current?.relative(6, x); input.current?.relative(8, y);
    };
    const context = (event: Event) => { if (locked()) event.preventDefault(); };
    const blur = () => release();
    const visibility = () => { if (document.hidden) release(); };
    document.addEventListener('pointerlockchange', changed);
    document.addEventListener('pointerlockerror', lockError);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', blur);
    target.addEventListener('blur', blur);
    target.addEventListener('mousemove', move);
    target.addEventListener('mousedown', button);
    target.addEventListener('mouseup', button);
    target.addEventListener('wheel', wheel, { passive: false });
    target.addEventListener('contextmenu', context);
    return () => {
      input.current?.release();
      if (document.pointerLockElement === target) document.exitPointerLock();
      document.removeEventListener('pointerlockchange', changed);
      document.removeEventListener('pointerlockerror', lockError);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', blur);
      target.removeEventListener('blur', blur);
      target.removeEventListener('mousemove', move);
      target.removeEventListener('mousedown', button);
      target.removeEventListener('mouseup', button);
      target.removeEventListener('wheel', wheel);
      target.removeEventListener('contextmenu', context);
    };
  }, [canvas, input]);

  useEffect(() => { if (!enabled || error) release(); }, [enabled, error]);

  async function capture() {
    if (!enabled || error) return;
    const target = canvas.current;
    if (!target?.requestPointerLock) { setNotice('Pointer capture is unavailable in this window.'); return; }
    setNotice(null);
    try { await target.requestPointerLock(); }
    catch (failure) { setNotice(`Pointer capture failed: ${String(failure)}`); }
  }

  return { captured, notice, capture, release };
}
