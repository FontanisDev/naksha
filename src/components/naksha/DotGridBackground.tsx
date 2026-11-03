'use client';

import { useEffect, useRef, useCallback, useMemo } from 'react';
import { gsap } from 'gsap';
import { InertiaPlugin } from 'gsap/InertiaPlugin';

/**
 * DotGridBackground — the ReactBits DotGrid, mounted as the app's
 * fixed background star field.
 *
 * SOURCE (Task T1, v138 mission — golden rule: copy battle-tested code,
 * adapt lightly): https://reactbits.dev/backgrounds/dot-grid — ported
 * from DavidHDev/react-bits `src/content/Backgrounds/DotGrid/DotGrid.jsx`
 * (MIT). The mechanics are the upstream component verbatim: a canvas dot
 * grid whose dots tint toward an active color inside a proximity radius,
 * get thrown by the pointer's velocity with GSAP InertiaPlugin, elastically
 * return home, and receive a click shockwave.
 *
 * Adaptations (documented, minimal — "modify slightly to match the app"):
 *  1. TypeScript + the app's fixed-background mount (section is
 *     `position: fixed; inset: 0; z-index: 0; pointer-events: none`).
 *  2. Colors ride the theme system: base = `--naksha-dot-color`,
 *     active = `--naksha-dot-hover` (both pre-existing per-theme tokens),
 *     falling back to the props. The color parser handles hex AND
 *     rgb()/rgba() — the light themes carry alpha inside the token.
 *  3. Star configuration: dotSize 1.5 / gap 28 — the app's established
 *     grid geometry (Workspace.tsx's STAR_GAP 28 aligns with it), so the
 *     workspace overlay's stars sit on the same lattice.
 *  4. DPR capped at 2 (the previous static field did the same —
 *     huge-canvas guard on 3× retina).
 *  5. Perf tiers: `reactive={false}` (low / stable60 tiers) renders the
 *     STATIC field — one paint, zero idle cost, no listeners — honoring
 *     those tiers' documented contract ("eliminate all continuous
 *     animations"). The full reactive experience is the high tier's.
 *
 * UI-calm pass note (v128 history): that pass removed a DIFFERENT thing —
 * an always-on neon cursor-glow gradient. This is the ReactBits
 * interaction model the owner explicitly re-requested for v138: the dots
 * stay quiet until the pointer moves; only nearby stars react.
 */

gsap.registerPlugin(InertiaPlugin);

const throttle = (func: (...args: unknown[]) => void, limit: number) => {
  let lastCall = 0;
  return function (...args: unknown[]) {
    const now = performance.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      func.apply(this, args);
    }
  };
};

interface ParsedColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Upstream ReactBits ships `hexToRgb` (hex only). Naksha's theme tokens
 * are hex on dark themes but `rgba(r, g, b, a)` on the light themes, so
 * the parser extends the upstream one — same return contract, plus the
 * alpha channel (upstream implicitly assumes a = 1).
 */
function parseColor(color: string): ParsedColor {
  const hex = color.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (hex) {
    return {
      r: parseInt(hex[1], 16),
      g: parseInt(hex[2], 16),
      b: parseInt(hex[3], 16),
      a: 1,
    };
  }
  const rgb = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (rgb) {
    return {
      r: parseInt(rgb[1], 10),
      g: parseInt(rgb[2], 10),
      b: parseInt(rgb[3], 10),
      a: rgb[4] !== undefined ? parseFloat(rgb[4]) : 1,
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

export interface DotGridBackgroundProps {
  /**
   * Static dot color (base). Accepts any CSS color string (hex, rgba).
   * Falls back to the active theme's `--naksha-dot-color`.
   */
  color?: string;
  /** Active (proximity) star color. Falls back to `--naksha-dot-hover`. */
  activeColor?: string;
  /** Diameter of each dot in CSS pixels. Default: `1.5` (tiny, star-like). */
  dotSize?: number;
  /** Grid spacing (center-to-center) in CSS pixels. Default: `28`. */
  gap?: number;
  /** Proximity radius (px) — dots tint toward activeColor inside it. */
  proximity?: number;
  /**
   * Reactive experience (ReactBits mechanics). `false` renders the static
   * field (one paint, zero idle cost) — the low/stable60 perf tiers pass
   * this; the high tier (default) gets the full reactive stars.
   */
  reactive?: boolean;
}

interface GridDot {
  cx: number;
  cy: number;
  xOffset: number;
  yOffset: number;
  _inertiaApplied: boolean;
}

export function DotGridBackground({
  color = 'rgba(148, 163, 184, 0.12)',
  activeColor,
  dotSize = 1.5,
  gap = 28,
  proximity = 130,
  reactive = true,
}: DotGridBackgroundProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<GridDot[]>([]);
  const pointerRef = useRef({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    speed: 0,
    lastTime: 0,
    lastX: 0,
    lastY: 0,
  });
  /* Naksha adaptation — dirty-check for the paint loop. Upstream repaints
   * every dot on every frame unconditionally; the app's perf philosophy
   * (FrameScheduler, zero-idle-cost contracts) wants the loop to SKIP the
   * paint when the frame would be identical: pointer hasn't moved, no
   * dot is displaced or returning. The scan is O(n) property reads (~µs)
   * vs a full ~2.5k-dot canvas repaint. Interaction behavior is
   * pixel-identical to upstream. */
  const paintStateRef = useRef({ dirty: true, lastPx: -1, lastPy: -1 });
  /* DPR used by buildGrid — the batched paint loop composes it into
   * setTransform directly (see draw below). */
  const dprRef = useRef(1);
  /* Static-tier repaint hook: the grid-build effect calls it after every
   * buildGrid so the static field survives the ResizeObserver's initial
   * callback (observe() always fires once immediately — which resets the
   * canvas AFTER the first static paint and would otherwise leave the
   * low/stable60 tiers a BLANK sky; the reactive loop self-heals via the
   * dirty flag, the static path has no loop to notice). No-op when the
   * reactive loop owns the canvas. */
  const staticRepaintRef = useRef<() => void>(() => {});

  // Star colors — theme tokens first (the component remounts on theme
  // switch via key={themeId} in the shell, so these re-read), props as
  // the fallback path. speedTrigger/shock* keep the upstream defaults.
  const speedTrigger = 100;
  const shockRadius = 220;
  const shockStrength = 4;
  const maxSpeed = 5000;
  const resistance = 750;
  const returnDuration = 1.5;

  const baseColor = useMemo(() => {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--naksha-dot-color')
      .trim();
    if (!v || v.startsWith('var(')) return color;
    return v;
  }, [color]);

  const activeStarColor = useMemo(() => {
    if (activeColor) return activeColor;
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--naksha-dot-hover')
      .trim();
    if (!v || v.startsWith('var(')) return baseColor;
    return v;
  }, [activeColor, baseColor]);

  const baseParsed = useMemo(() => parseColor(baseColor), [baseColor]);
  const activeParsed = useMemo(() => parseColor(activeStarColor), [activeStarColor]);

  const circlePath = useMemo(() => {
    if (typeof window === 'undefined' || !window.Path2D) return null;

    const p = new window.Path2D();
    p.arc(0, 0, dotSize / 2, 0, Math.PI * 2);
    return p;
  }, [dotSize]);

  const buildGrid = useCallback(() => {
    const wrap = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const { width, height } = wrap.getBoundingClientRect();
    // DPR cap (upstream uses the raw devicePixelRatio; the cap mirrors
    // the previous static field and guards 3×-retina canvas memory).
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    dprRef.current = dpr;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(dpr, dpr);

    const cols = Math.floor((width + gap) / (dotSize + gap));
    const rows = Math.floor((height + gap) / (dotSize + gap));
    const cell = dotSize + gap;

    const gridW = cell * cols - gap;
    const gridH = cell * rows - gap;

    const extraX = width - gridW;
    const extraY = height - gridH;

    const startX = extraX / 2 + dotSize / 2;
    const startY = extraY / 2 + dotSize / 2;

    const dots: GridDot[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cx = startX + x * cell;
        const cy = startY + y * cell;
        dots.push({ cx, cy, xOffset: 0, yOffset: 0, _inertiaApplied: false });
      }
    }
    dotsRef.current = dots;
    // A fresh grid must be painted even if the pointer hasn't moved
    // since the last frame (resize path — the dirty-check would
    // otherwise skip the repaint and leave a blank sky).
    paintStateRef.current.dirty = true;
  }, [dotSize, gap]);

  /* ── Draw loop (upstream structure + two documented perf adaptations) ──
   * Proximity tint lerps all FOUR channels (upstream lerps rgb over hex;
   * the alpha lerp is what makes the light themes' faint rgba() base
   * dots bloom into full stars near the pointer — the intended
   * "stars react" feel on every theme).
   *
   * Naksha perf adaptations (pixel-identical output):
   *  · dirty-check — skip the whole repaint when nothing changed;
   *  · batched paint — far dots share ONE fillStyle assignment (upstream
   *    re-assigns per dot); per-dot tint strings are only built inside
   *    the proximity radius. Per-dot save/translate/restore becomes a
   *    single setTransform (same matrix the save/restore pair produced).
   *    Both pass through the same ~2.5k fill() calls — the batch trims
   *    the state churn around them, which is what software rasterizers
   *    (and weak iGPUs) feel. */
  /* ── Grid build + resize (upstream) — declared BEFORE the draw loop
   * effect so the first paint already sees the right DPR (dprRef). ── */
  useEffect(() => {
    buildGrid();
    staticRepaintRef.current();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && wrapperRef.current) {
      ro = new ResizeObserver(() => {
        buildGrid();
        staticRepaintRef.current();
      });
      ro.observe(wrapperRef.current);
    } else {
      window.addEventListener('resize', buildGrid);
    }
    return () => {
      if (ro) ro.disconnect();
      else window.removeEventListener('resize', buildGrid);
      staticRepaintRef.current = () => {};
    };
  }, [buildGrid]);

  useEffect(() => {
    if (!circlePath) return;

    let rafId: number;
    const proxSq = proximity * proximity;

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const { x: px, y: py } = pointerRef.current;

      /* Dirty-check (Naksha adaptation): repaint only when the pointer
       * moved, a mutation was flagged, or any dot is still displaced /
       * returning home. Otherwise the last paint is still the truth. */
      const ps = paintStateRef.current;
      let animating = false;
      for (const dot of dotsRef.current) {
        if (dot.xOffset !== 0 || dot.yOffset !== 0 || dot._inertiaApplied) {
          animating = true;
          break;
        }
      }
      if (!animating && !ps.dirty && px === ps.lastPx && py === ps.lastPy) {
        rafId = requestAnimationFrame(draw);
        return;
      }
      ps.dirty = false;
      ps.lastPx = px;
      ps.lastPy = py;

      const dpr = dprRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      /* Pass 1 — far dots: one fillStyle, per-dot setTransform + fill. */
      ctx.fillStyle = baseColor;
      const near: GridDot[] = [];
      for (const dot of dotsRef.current) {
        const dx = dot.cx - px;
        const dy = dot.cy - py;
        const dsq = dx * dx + dy * dy;
        if (dsq <= proxSq) {
          near.push(dot);
          continue;
        }
        const ox = dot.cx + dot.xOffset;
        const oy = dot.cy + dot.yOffset;
        ctx.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr);
        ctx.fill(circlePath);
      }

      /* Pass 2 — proximity dots: per-dot tinted rgba (built only here,
       * for the ~dozens of dots near the pointer, not the whole grid). */
      for (const dot of near) {
        const ox = dot.cx + dot.xOffset;
        const oy = dot.cy + dot.yOffset;
        const dist = Math.sqrt((dot.cx - px) ** 2 + (dot.cy - py) ** 2);
        const t = 1 - dist / proximity;
        const r = Math.round(baseParsed.r + (activeParsed.r - baseParsed.r) * t);
        const g = Math.round(baseParsed.g + (activeParsed.g - baseParsed.g) * t);
        const b = Math.round(baseParsed.b + (activeParsed.b - baseParsed.b) * t);
        const a = baseParsed.a + (activeParsed.a - baseParsed.a) * t;
        ctx.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr);
        ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
        ctx.fill(circlePath);
      }

      rafId = requestAnimationFrame(draw);
    };

    if (reactive) {
      draw();
      return () => cancelAnimationFrame(rafId);
    }

    /* Static tier (low / stable60): one paint at base color — every dot
     * is out of proximity, so this is exactly the old static field —
     * then sleep (the rAF chain is cancelled right after the one draw;
     * `draw` schedules a frame, the cancel reaps it). The grid-build
     * effect re-invokes paintStatic through staticRepaintRef after every
     * buildGrid (the RO's initial callback resets the canvas). */
    const paintStatic = () => {
      pointerRef.current.x = -99999;
      pointerRef.current.y = -99999;
      draw();
      cancelAnimationFrame(rafId);
    };
    staticRepaintRef.current = paintStatic;
    paintStatic();

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResizeStatic = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        buildGrid();
        paintStatic();
      }, 200);
    };
    window.addEventListener('resize', onResizeStatic, { passive: true });
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResizeStatic);
      cancelAnimationFrame(rafId);
    };
  }, [proximity, baseColor, activeParsed, baseParsed, circlePath, reactive, buildGrid]);

  /* ── Pointer mechanics (upstream verbatim) ──
   * Velocity-proximity inertia throw + elastic return, click shockwave.
   * Listeners sit on window with the canvas pointer-events:none, so the
   * stars react while the pointer travels OVER the glass panes — that is
   * the feel the mission asks for ("glass panels over a living sky"). */
  useEffect(() => {
    if (!reactive) return;

    const onMove = (e: MouseEvent) => {
      paintStateRef.current.dirty = true;
      const now = performance.now();
      const pr = pointerRef.current;
      const dt = pr.lastTime ? now - pr.lastTime : 16;
      const dx = e.clientX - pr.lastX;
      const dy = e.clientY - pr.lastY;
      let vx = (dx / dt) * 1000;
      let vy = (dy / dt) * 1000;
      let speed = Math.hypot(vx, vy);
      if (speed > maxSpeed) {
        const scale = maxSpeed / speed;
        vx *= scale;
        vy *= scale;
        speed = maxSpeed;
      }
      pr.lastTime = now;
      pr.lastX = e.clientX;
      pr.lastY = e.clientY;
      pr.vx = vx;
      pr.vy = vy;
      pr.speed = speed;

      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      pr.x = e.clientX - rect.left;
      pr.y = e.clientY - rect.top;

      for (const dot of dotsRef.current) {
        const dist = Math.hypot(dot.cx - pr.x, dot.cy - pr.y);
        if (speed > speedTrigger && dist < proximity && !dot._inertiaApplied) {
          dot._inertiaApplied = true;
          gsap.killTweensOf(dot);
          const pushX = dot.cx - pr.x + vx * 0.005;
          const pushY = dot.cy - pr.y + vy * 0.005;
          gsap.to(dot, {
            inertia: { xOffset: pushX, yOffset: pushY, resistance },
            onComplete: () => {
              gsap.to(dot, {
                xOffset: 0,
                yOffset: 0,
                duration: returnDuration,
                ease: 'elastic.out(1,0.75)',
              });
              dot._inertiaApplied = false;
            },
          });
        }
      }
    };

    const onClick = (e: MouseEvent) => {
      paintStateRef.current.dirty = true;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      for (const dot of dotsRef.current) {
        const dist = Math.hypot(dot.cx - cx, dot.cy - cy);
        if (dist < shockRadius && !dot._inertiaApplied) {
          dot._inertiaApplied = true;
          gsap.killTweensOf(dot);
          const falloff = Math.max(0, 1 - dist / shockRadius);
          const pushX = (dot.cx - cx) * shockStrength * falloff;
          const pushY = (dot.cy - cy) * shockStrength * falloff;
          gsap.to(dot, {
            inertia: { xOffset: pushX, yOffset: pushY, resistance },
            onComplete: () => {
              gsap.to(dot, {
                xOffset: 0,
                yOffset: 0,
                duration: returnDuration,
                ease: 'elastic.out(1,0.75)',
              });
              dot._inertiaApplied = false;
            },
          });
        }
      }
    };

    const throttledMove = throttle(onMove, 50);
    window.addEventListener('mousemove', throttledMove as EventListener, { passive: true });
    window.addEventListener('click', onClick as EventListener);

    return () => {
      window.removeEventListener('mousemove', throttledMove as EventListener);
      window.removeEventListener('click', onClick as EventListener);
    };
  }, [speedTrigger, proximity, resistance, returnDuration, shockRadius, shockStrength, reactive]);

  return (
    <section
      className="dot-grid"
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    >
      <div ref={wrapperRef} className="dot-grid__wrap">
        <canvas ref={canvasRef} className="dot-grid__canvas" />
      </div>
    </section>
  );
}

export default DotGridBackground;
