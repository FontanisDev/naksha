'use client';

/**
 * Naksha — PerfHud
 *
 * Task 74 — the frame-rate instrument. Five review rounds listed
 * "real-hardware perf verification" as the standing blind spot: the
 * dev cannot feel smoothness, and no amount of reasoning about
 * backdrop-filter counts answers "is it smooth on MY machine?".
 * So the app now carries its own measuring device.
 *
 * What it reads (all local, no network, no observers beyond rAF):
 *   fps   — frames produced in the last full second (integer)
 *   worst — the slowest frame in a rolling 5 s window (ms)
 *   jank  — frames slower than 50 ms since the meter opened (count)
 *   tier  — the active perf tier (drives blur/animations/canvas caps)
 *   dpr·cores·heap — display density, hardwareConcurrency, JS heap
 *           (heap only where performance.memory exists — Chromium)
 *
 * Honesty rules the design:
 *   - A running rAF loop keeps the browser PRODUCING frames — that is
 *     the measurement, not overhead: the cadence you see is the cadence
 *     the app's surfaces force. Load the app (pan the map, drag graph
 *     nodes, switch panes) and watch fps hold or sag.
 *   - The HUD itself is the cheapest thing on screen: text-only, zero
 *     canvas, zero backdrop-filter (an instrument with blur is a liar),
 *     DOM writes via refs at 2 Hz — never per frame, never re-renders.
 *   - It mounts only while open and cancels its loop on close — off
 *     means OFF, no residual cost.
 *
 * Usage: `perf` toggles; `perf on|off` is explicit. Leave it open while
 * you do a day's work and read the receipt: steady fps ≈ refresh rate,
 * worst < 50 ms, jank 0 = the machine is comfortable.
 */

import { useEffect, useRef } from 'react';
import { useNaksha } from '@/lib/naksha/store';
import { FrameScheduler } from '@/lib/naksha/frame-scheduler';

export function PerfHud() {
  const open = useNaksha((s) => s.perfHudOpen);
  const perfMode = useNaksha((s) => s.settings.perfMode);
  const isStable60 = perfMode === 'stable60';
  /* Chromium-only JS heap probe — capability is static per session, so
     it decides ONCE whether the heap row exists (writer looks the object
     up again per write; a stale reference would leak a detached heap). */
  const memSupported =
    typeof performance !== 'undefined' &&
    !!(performance as unknown as { memory?: unknown }).memory;

  const fpsRef = useRef<HTMLSpanElement>(null);
  const worstRef = useRef<HTMLSpanElement>(null);
  const jankRef = useRef<HTMLSpanElement>(null);
  const memRef = useRef<HTMLSpanElement>(null);
  const lockRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let last = performance.now();
    /* rolling (timestamp, delta) log — pruned to a 5 s worst-frame window */
    const dts: Array<{ t: number; dt: number }> = [];
    let jank = 0;
    let framesThisSecond = 0;
    let secondStart = last;
    let fps = 0;
    const readMem = () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;

    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      dts.push({ t: now, dt });
      while (dts.length && now - dts[0].t > 5000) dts.shift();
      framesThisSecond++;
      if (dt > 50) jank++;
      if (now - secondStart >= 1000) {
        fps = Math.round((framesThisSecond * 1000) / (now - secondStart));
        framesThisSecond = 0;
        secondStart = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    /* 2 Hz DOM writer — the rAF loop only fills numbers; the meter's own
       writes are ~10 span updates/s, invisible next to the app's work. */
    const writer = window.setInterval(() => {
      if (fpsRef.current) fpsRef.current.textContent = String(fps);
      if (worstRef.current) worstRef.current.textContent = String(Math.round(dts.reduce((m, f) => Math.max(m, f.dt), 0)));
      if (jankRef.current) jankRef.current.textContent = String(jank);
      if (memRef.current) {
        const mem = readMem();
        if (mem) memRef.current.textContent = `${Math.round(mem.usedJSHeapSize / 1048576)}MB`;
      }
      /* Phase 1 — stable60 lock row: proves the limiter is alive and how
         hard it is working (skips = ticks suppressed to hold 60fps on
         120/144Hz displays; 0 skips on a 60Hz panel is CORRECT — there is
         nothing to skip). */
      if (lockRef.current) {
        if (isStable60) {
          const rows = FrameScheduler.diagnostics();
          const skips = rows.reduce((m, r) => m + r.skippedByLimiter, 0);
          const dropped = rows.reduce((m, r) => m + r.dropped, 0);
          lockRef.current.textContent =
            `60Hz lock${fps >= 55 ? ' ✓' : fps >= 40 ? ' ~' : ' ✗'} · skips ${skips} · dropped ${dropped}`;
        } else {
          lockRef.current.textContent = '—';
        }
      }
    }, 500);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(writer);
    };
  }, [open]);

  if (!open) return null;

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;

  const cell: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
  };
  const key: React.CSSProperties = {
    color: 'var(--naksha-text-4, #8a8172)',
  };
  const val: React.CSSProperties = {
    color: 'var(--naksha-text, #d6cbb4)',
    fontVariantNumeric: 'tabular-nums',
  };

  return (
    <div
      aria-label="Frame rate meter"
      style={{
        position: 'fixed',
        right: 10,
        bottom: 34,
        zIndex: 2600,
        fontFamily: 'var(--naksha-font-mono, monospace)',
        fontSize: 9,
        lineHeight: 1.7,
        padding: '7px 10px',
        borderRadius: 6,
        border: '1px solid var(--naksha-border-2, rgba(214, 203, 180, 0.18))',
        background: 'var(--naksha-bg-2, rgba(20, 17, 13, 0.94))',
        color: 'var(--naksha-text, #d6cbb4)',
        pointerEvents: 'none',
        userSelect: 'none',
        minWidth: 128,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ color: 'var(--naksha-gold-light, #ffe55c)' }}>frame meter</span>
        <span style={{ color: 'var(--naksha-text-4, #8a8172)' }}>{perfMode ?? 'high'}</span>
      </div>
      <div style={cell}>
        <span style={key}>fps</span>
        <span ref={fpsRef} style={val}>—</span>
      </div>
      <div style={cell}>
        <span style={key}>worst 5s</span>
        <span ref={worstRef} style={val}>—</span>
      </div>
      <div style={cell}>
        <span style={key}>jank &gt;50ms</span>
        <span ref={jankRef} style={val}>0</span>
      </div>
      <div style={cell}>
        <span style={key}>dpr · cores</span>
        <span style={val}>{dpr} · {cores || '?'}</span>
      </div>
      <div style={cell}>
        <span style={key}>60fps lock</span>
        <span ref={lockRef} style={val}>—</span>
      </div>
      {memSupported && (
        <div style={cell}>
          <span style={key}>heap</span>
          <span ref={memRef} style={val}>—</span>
        </div>
      )}
      <div style={{ marginTop: 3, color: 'var(--naksha-text-4, #8a8172)', maxWidth: 150 }}>
        meter keeps frames flowing (that is the measurement) — load the app and watch fps hold
      </div>
    </div>
  );
}

export default PerfHud;
