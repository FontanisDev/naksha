'use client';

/**
 * Naksha — PerfPanel
 *
 * A visual performance-tier picker: three side-by-side cards (LOW /
 * STABLE_60 / HIGH) that explain exactly what each rendering tier does,
 * with the active tier highlighted. Clicking a card switches the tier live.
 *
 * Why a GUI: until now the tier was CLI-only (`settings perf low|high`),
 * which hid the single most important knob for CPU-only machines behind
 * a command nobody knows exists. The StatusBar PERF chip, the
 * `perfpanel` command, and the command palette all open this panel.
 *
 * What each tier controls (the honest list — same knobs the code reads):
 *  LOW      — zero backdrop-filter (opaque settled glass), no CSS animations
 *             (breath/sky killed), no transitions on hot surfaces, no
 *             will-change layer pinning, workspace canvas capped at 20fps
 *             with 2s idle sleep, dot-grid hover redraw throttled to ~20fps,
 *             force-graph settles in ≤25 ticks then auto-pauses redraws.
 *  STABLE_60— the Phase 1 balanced tier: opaque settled glass and no
 *             ambience loops (LOW's static economics) BUT full-rate
 *             interaction — the 20/30fps canvas caps and the 50ms dot-grid
 *             throttle do NOT apply. Rendering locks to 60 FPS through the
 *             shared FrameScheduler (no unbounded rendering on 120/144Hz
 *             displays), and this panel shows live frame diagnostics: FPS,
 *             per-loop average/worst frame time, dropped frames, limiter
 *             skips, and a bottleneck hint when 60 cannot be held.
 *  HIGH     — full frosted glass, breath/sky ambience, transitions, 30fps
 *             workspace cap, unthrottled dot-grid hover, full graph sim.
 *
 * Performance: only mounts when open. Pure DOM, no canvas. The probe and
 * diagnostics write via refs at 2Hz (never per frame, never re-renders)
 * and cancel cleanly on close. Static cards (no hover animations beyond
 * color), so even opening this panel on a CPU-only box costs nothing.
 */

import { useEffect, useRef } from 'react';
import { useNaksha } from '@/lib/naksha/store';
import { FrameScheduler } from '@/lib/naksha/frame-scheduler';
import { applyPerfDocumentAttr, type PerfMode } from '@/lib/naksha/perf-tier';
import { t } from '@/lib/naksha/i18n';
import { ScrimDialog, PanelHeader } from '@/components/naksha/PanelPrimitives';

const LOW_FEATURES = [
  'backdrop-filter: none — opaque settled glass, zero filter cost',
  'breath / sky ambience + term-line entrances disabled',
  'no will-change layer pinning, no hot-surface transitions',
  'workspace canvas ≤ 20 fps, sleeps after 2 s idle',
  'dot-grid hover glow throttled to ~20 fps',
  'force-graph settles in ≤ 25 ticks, then auto-pause',
];

const STABLE_60_FEATURES = [
  'locked 60 FPS — frame limiter aligned with requestAnimationFrame',
  'opaque settled glass: zero backdrop-filter cost (like LOW)',
  'NO 20/30fps canvas caps — dot-grid + workspace render full-rate',
  'framerate-independent glow smoothing (skips change speed, not feel)',
  'live diagnostics below: fps, frame times, dropped, limiter skips',
  'CPU-oriented: no GPU-heavy path, no busy-loop, idle still sleeps',
];

const HIGH_FEATURES = [
  'full frosted glass (blur + saturation on every pane)',
  '12 s breath + 28 s sky ambience layers active',
  'smooth transitions on glass, buttons and terminal lines',
  'workspace canvas 30 fps cap while interacting',
  'unthrottled dot-grid hover glow (rAF smoothing)',
  'force-graph runs to d3AlphaMin 0.1 with full cooldown',
];

/** The scheduler loops that feed diagnostics, in display order. */
const SCHEDULER_LOOPS = ['dotgrid', 'workspace'] as const;

export function PerfPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const perfMode = useNaksha((s) => s.settings.perfMode);
  /* Task 105 — provenance replaces the old `perfMode === 'low'` guess,
   * which told a user who CHOSE low that it was "auto-detected". The
   * store's detection stamps 'auto-hardware' / 'auto-reduced-motion';
   * every explicit write (command or panel card) stamps 'chosen'.
   * Pre-105 profiles carry no label and get the neutral line. */
  const perfProvenance = useNaksha((s) => s.settings.perfProvenance);
  /* Phase 8 — i18n-lite: subscription is the re-render trigger for the
   * Persian tier cards; t() reads the same slice on each render. */
  const uiLang = useNaksha((s) => s.settings.uiLang);
  void uiLang;

  // ── Live diagnostics (Phase 1) — refs + 2Hz writer, zero re-renders ──
  const fpsRef = useRef<HTMLSpanElement>(null);
  const worstRef = useRef<HTMLSpanElement>(null);
  const jankRef = useRef<HTMLSpanElement>(null);
  const lockRef = useRef<HTMLSpanElement>(null);
  const loopRowsRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const isStable60 = perfMode === 'stable60';

  useEffect(() => {
    if (!open) return;
    /* Frame probe — the same honest instrument PerfHud uses: a running
       rAF loop keeps the browser PRODUCING frames; the cadence read here
       is the cadence the app's surfaces force. Only mounted while the
       panel is open, cancelled on close. */
    let raf = 0;
    let last = performance.now();
    let framesThisSecond = 0;
    let secondStart = last;
    let fps = 0;
    let worst5s = 0;
    const dts: Array<{ t: number; dt: number }> = [];
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      dts.push({ t: now, dt });
      while (dts.length && now - dts[0].t > 5000) dts.shift();
      framesThisSecond++;
      if (now - secondStart >= 1000) {
        fps = Math.round((framesThisSecond * 1000) / (now - secondStart));
        framesThisSecond = 0;
        secondStart = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    /* 2Hz DOM writer — numbers only, ~10 span updates/s. */
    const writer = window.setInterval(() => {
      worst5s = dts.reduce((m, f) => Math.max(m, f.dt), 0);
      if (fpsRef.current) fpsRef.current.textContent = String(fps);
      if (worstRef.current) worstRef.current.textContent = `${Math.round(worst5s)}ms`;
      if (jankRef.current)
        jankRef.current.textContent = String(dts.filter((f) => f.dt > 50).length);
      if (lockRef.current) {
        lockRef.current.textContent = isStable60
          ? `engaged · 60 max${fps >= 55 ? ' · holding' : ''}`
          : 'n/a (stable60 only)';
      }
      if (isStable60 && loopRowsRef.current) {
        const rows = SCHEDULER_LOOPS.map((key) => {
          const s = FrameScheduler.stats(key);
          if (!s) return `${key} · idle (no draws yet)`;
          return `${key} · avg ${s.avgFrameMs.toFixed(1)}ms · worst ${s.worstFrameMs.toFixed(0)}ms · dropped ${s.dropped} · limiter-skipped ${s.skippedByLimiter}`;
        });
        loopRowsRef.current.textContent = rows.join('\n');
      }
      if (hintRef.current) {
        hintRef.current.textContent = !isStable60
          ? ''
          : fps >= 55
            ? ''
            : worst5s > 40
              ? `bottleneck: a ${Math.round(worst5s)}ms frame spike — open the workspace (ws) and dot-grid hover are the heaviest loops; HIGH tier's blur is already off in this tier.`
              : 'bottleneck: steady but below 60 — display may be 30/45Hz or the compositor is saturated; check the per-loop worst times below.';
      }
    }, 500);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(writer);
    };
  }, [open, isStable60]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const switchTier = (tier: PerfMode) => {
    if (tier === perfMode) return;
    useNaksha.getState().setSettings({ perfMode: tier, perfProvenance: 'chosen' });
    /* Phase 1 — one writer for the document state (attribute + scheduler
       counter reset), shared with the `settings perf` command. */
    applyPerfDocumentAttr(tier);
    if (tier === 'low') {
      useNaksha
        .getState()
        .print('Performance mode: LOW — zero blur, animations off, canvas throttled', 'info');
    } else if (tier === 'stable60') {
      useNaksha
        .getState()
        .print('Performance mode: STABLE_60 — locked 60 FPS, zero blur, full-rate interaction', 'info');
    } else {
      useNaksha.getState().print('Performance mode: HIGH — full effects enabled', 'info');
    }
  };

  const card = (tier: PerfMode, title: string, blurb: string, features: string[], accent: string) => {
    const active = perfMode === tier;
    return (
      <button
        onClick={() => switchTier(tier)}
        aria-pressed={active}
        className="perf-card"
        style={{
          flex: 1,
          minWidth: 168,
          textAlign: 'start',
          borderRadius: 10,
          border: active ? `1px solid ${accent}` : '1px solid var(--naksha-border)',
          background: active ? `${accent}14` : 'rgba(255,255,255,0.02)',
          padding: '14px 16px',
          cursor: active ? 'default' : 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          position: 'relative',
        }}
      >
        {active && (
          <span
            style={{
              position: 'absolute',
              top: 10,
              insetInlineEnd: 10,
              fontSize: 'var(--naksha-fs-xs)',
              letterSpacing: 1.2,
              color: accent,
              border: `1px solid ${accent}55`,
              borderRadius: 99,
              padding: '2px 8px',
            }}
          >
            active
          </span>
        )}
        <span
          style={{
            fontSize: 'var(--naksha-fs-md)',
            fontWeight: 600,
            color: active ? accent : 'var(--naksha-text)',
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 'var(--naksha-fs-xs)',
            color: 'var(--naksha-text-3)',
            lineHeight: 1.5,
          }}
        >
          {blurb}
        </span>
        <ul className="perf-list">
          {features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </button>
    );
  };

  return (
    /* Task 99 — naksha-scrim: same perf-low hook as the other scrims. */
    <ScrimDialog
      onClose={onClose}
      zIndex={4500}
      width="min(760px, 94vw)"
      maxHeight="88vh"
      label="Performance panel"
      panelClassName="perf-panel"
    >
      {/* Header */}
      <PanelHeader
        title="Performance Tier"
        meta={
          perfProvenance === 'chosen'
            ? 'your choice is saved · click a card to switch'
            : perfProvenance === 'auto-hardware'
              ? 'auto-detected for this device · click a card to override'
              : perfProvenance === 'auto-reduced-motion'
                ? 'matched to your OS reduce-motion setting · click a card to override'
                : 'click a card to switch the performance tier'
        }
        dot={
          perfMode === 'low'
            ? 'var(--naksha-purple)'
            : perfMode === 'stable60'
              ? 'var(--naksha-gold)'
              : 'var(--naksha-success)'
        }
        onClose={onClose}
        closeLabel="performance panel"
      />

      {/* Cards */}
        <div style={{ display: 'flex', gap: 12, padding: 20, flexWrap: 'wrap' }}>
          {card(
            'low',
            t('perf.low.name', 'LOW — CPU-only'),
            t('perf.low.desc', 'For software rendering / no GPU. Everything static that can be static.'),
            LOW_FEATURES,
            'var(--naksha-purple)',
          )}
          {card(
            'stable60',
            t('perf.stable60.name', 'STABLE_60 — locked 60'),
            t('perf.stable60.desc', 'The balanced tier: LOW\u2019s zero-blur economics, HIGH\u2019s full-rate interaction, 60 FPS lock.'),
            STABLE_60_FEATURES,
            'var(--naksha-gold)',
          )}
          {card(
            'high',
            t('perf.high.name', 'HIGH — full effects'),
            t('perf.high.desc', 'For real GPUs. The full glass-and-ambience experience.'),
            HIGH_FEATURES,
            'var(--naksha-success)',
          )}
        </div>

        {/* Diagnostics — the Phase 1 honesty block. Probe runs while the
            panel is open regardless of tier (it IS the measurement); the
            scheduler rows only exist for stable60, whose loops feed them. */}
        <div
          style={{
            margin: '0 20px 20px',
            border: '1px solid var(--naksha-border)',
            borderRadius: 10,
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <span
              style={{
                fontSize: 'var(--naksha-fs-xs)',
                fontWeight: 600,
                letterSpacing: 1,
                color: 'var(--naksha-gold-light)',
              }}
            >
              frame diagnostics
            </span>
            <span
              style={{
                fontSize: 'var(--naksha-fs-xs)',
                color: 'var(--naksha-text-4)',
              }}
            >
              live · 2Hz · probe cancels on close
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 18,
              flexWrap: 'wrap',
              fontSize: 'var(--naksha-fs-xs)',
              color: 'var(--naksha-text-2)',
            }}
          >
            <span>fps <span ref={fpsRef} style={{ color: 'var(--naksha-text)', fontVariantNumeric: 'tabular-nums' }}>—</span></span>
            <span>worst 5s <span ref={worstRef} style={{ color: 'var(--naksha-text)', fontVariantNumeric: 'tabular-nums' }}>—</span></span>
            <span>spikes &gt;50ms <span ref={jankRef} style={{ color: 'var(--naksha-text)', fontVariantNumeric: 'tabular-nums' }}>—</span></span>
            <span>60fps lock <span ref={lockRef} style={{ color: 'var(--naksha-gold)', fontVariantNumeric: 'tabular-nums' }}>—</span></span>
          </div>
          {isStable60 && (
            <div
              ref={loopRowsRef}
              style={{
                fontSize: 'var(--naksha-fs-xs)',
                lineHeight: 1.7,
                color: 'var(--naksha-text-2)',
                whiteSpace: 'pre-line',
              }}
            >
              dotgrid · idle (no draws yet)
              {'\n'}
              workspace · idle (no draws yet)
            </div>
          )}
          <div
            ref={hintRef}
            style={{
              fontSize: 'var(--naksha-fs-xs)',
              lineHeight: 1.5,
              color: 'var(--naksha-gold)',
              minHeight: isStable60 ? 14 : 0,
            }}
          />
        </div>

        {/* Footer hint */}
        <div
          style={{
            padding: '10px 20px 14px',
            borderTop: '1px solid var(--naksha-border)',
            fontSize: 'var(--naksha-fs-xs)',
            color: 'var(--naksha-text-4)',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span>terminal equivalent: settings perf low|stable60|high · status-bar chip opens this panel</span>
          <span>Esc close</span>
        </div>
      <PerfPanelStyles />
    </ScrimDialog>
  );
}

/** Component-scoped styles (the dev environment Turbopack CSS pipeline is frozen —
 *  globals.css edits never reach the served chunk; JS module styles do). */
function PerfPanelStyles() {
  return (
    <style>{`
      .perf-card { transition: border-color 0.15s ease, background 0.15s ease; }
      .perf-card:hover { border-color: var(--naksha-gold) !important; }
      .perf-card:active { transform: translateY(0.5px); }
      .perf-list {
        margin: 2px 0 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: var(--naksha-fs-xs);
        line-height: 1.5;
        color: var(--naksha-text-2);
      }
      .perf-list li { padding-inline-start: 14px; position: relative; }
      .perf-list li::before {
        content: '·';
        position: absolute;
        inset-inline-start: 2px;
        color: var(--naksha-gold);
        font-weight: 700;
      }
      html[data-perf="low"] .perf-card { transition: none !important; }
    `}</style>
  );
}

export default PerfPanel;
