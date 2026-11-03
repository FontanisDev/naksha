/**
 * Naksha — FrameScheduler (STABLE_60 tier engine)
 *
 * A shared, allocation-free frame limiter + diagnostics recorder for every
 * canvas/render loop in the app. It exists for exactly one tier:
 * `stable60` — the "locked 60 FPS" mode (LOW < STABLE_60 < HIGH).
 *
 * What it does:
 *  1. FRAME LIMIT — `shouldDraw(key, now, targetFps)` admits at most one
 *     draw per frame budget (16.67ms at 60fps). On a 60Hz display this is a
 *     no-op (rAF already fires at 60); on 120/144Hz displays it prevents
 *     unbounded rendering above the 60 FPS lock target. Suppressed ticks are
 *     counted (`skippedByLimiter`) so the UI can prove the lock is engaged.
 *  2. DIAGNOSTICS — `noteDraw(key, now)` records the real draw cadence:
 *     average frame time, worst frame time (rolling 120-frame window), and
 *     a dropped-frame count (delta > 1.5× budget = a genuinely missed 60fps
 *     frame). `diagnostics()` returns a snapshot per loop so the PerfPanel /
 *     PerfHud can name the bottleneck instead of silently accepting poor FPS.
 *  3. NO BUSY-LOOPS — every consumer still rides its own requestAnimationFrame
 *     cadence; the scheduler only decides whether the expensive draw runs on
 *     a given tick. Ticks that don't draw do ~10ns of arithmetic.
 *
 * Design constraints honored:
 *  - Zero allocations on the hot path (fixed Float64Array ring per loop).
 *  - No module-level timers, no observers — purely passive, called from
 *    consumer rAF callbacks. Off-tier consumers call nothing at all.
 *  - The tier is read LIVE by consumers (`settings perf` flips instantly,
 *    the same contract every other perf knob in Naksha honors).
 */

/** Default lock target of the stable60 tier. 60 is the spec, the cap and the promise. */
export const STABLE_60_TARGET_FPS = 60;

/** Budget in ms for one 60fps frame (16.67). */
export const FRAME_BUDGET_MS = 1000 / STABLE_60_TARGET_FPS;

/** A draw is "dropped" when its delta exceeds 1.5× the 60fps budget (~25fps momentary). */
const DROP_THRESHOLD_MS = FRAME_BUDGET_MS * 1.5;

/** Rolling window size for avg/worst frame-time stats (2s at 60fps). */
const DELTA_WINDOW = 120;

interface LoopState {
  /** Last admitted draw timestamp (ms, performance.now clock). */
  lastDrawTs: number;
  /** Fixed ring of the last DELTA_WINDOW draw deltas. */
  deltas: Float64Array;
  deltaIdx: number;
  deltaCount: number;
  /** Lifetime counters since last reset (per page load). */
  frames: number;
  skippedByLimiter: number;
  dropped: number;
}

export interface FrameLoopStats {
  key: string;
  /** Draws actually admitted through the limiter. */
  frames: number;
  /** Ticks suppressed to hold the 60fps lock (0 when unlocked/no-op). */
  skippedByLimiter: number;
  /** Draw deltas above the 1.5× budget — real missed frames. */
  dropped: number;
  /** Average delta across the rolling window (ms). */
  avgFrameMs: number;
  /** Worst delta across the rolling window (ms). */
  worstFrameMs: number;
  /** The loop's configured budget (ms). */
  budgetMs: number;
  /** ms since the loop's last admitted draw (useful for staleness). */
  sinceLastDrawMs: number;
}

const loops = new Map<string, LoopState>();

function stateFor(key: string): LoopState {
  let s = loops.get(key);
  if (!s) {
    s = {
      lastDrawTs: 0,
      deltas: new Float64Array(DELTA_WINDOW),
      deltaIdx: 0,
      deltaCount: 0,
      frames: 0,
      skippedByLimiter: 0,
      dropped: 0,
    };
    loops.set(key, s);
  }
  return s;
}

export const FrameScheduler = {
  /**
   * Frame limiter. Returns true when the caller should draw NOW for loop
   * `key` (at most one admission per `1000/targetFps` ms). Call this on
   * every rAF tick while the tier is stable60; on false, skip the draw.
   */
  shouldDraw(key: string, now: number, targetFps = STABLE_60_TARGET_FPS): boolean {
    const s = stateFor(key);
    const budget = 1000 / targetFps;
    // Small epsilon keeps 60Hz displays exactly on cadence (rAF jitter).
    if (s.lastDrawTs !== 0 && now - s.lastDrawTs < budget - 0.5) {
      s.skippedByLimiter++;
      return false;
    }
    return true;
  },

  /**
   * Record an admitted draw. Call immediately AFTER the draw completes'
   * scheduling point (same tick, `now` = the rAF timestamp). Maintains the
   * rolling avg/worst window and the dropped-frame counter.
   */
  noteDraw(key: string, now: number): void {
    const s = stateFor(key);
    if (s.lastDrawTs !== 0) {
      const delta = now - s.lastDrawTs;
      s.deltas[s.deltaIdx] = delta;
      s.deltaIdx = (s.deltaIdx + 1) % DELTA_WINDOW;
      if (s.deltaCount < DELTA_WINDOW) s.deltaCount++;
      if (delta > DROP_THRESHOLD_MS) s.dropped++;
    }
    s.lastDrawTs = now;
    s.frames++;
  },

  /** Snapshot for one loop (or null if that loop never drew). */
  stats(key: string, targetFps = STABLE_60_TARGET_FPS): FrameLoopStats | null {
    const s = loops.get(key);
    if (!s || s.frames === 0) return null;
    let sum = 0;
    let worst = 0;
    for (let i = 0; i < s.deltaCount; i++) {
      const d = s.deltas[i];
      sum += d;
      if (d > worst) worst = d;
    }
    return {
      key,
      frames: s.frames,
      skippedByLimiter: s.skippedByLimiter,
      dropped: s.dropped,
      avgFrameMs: s.deltaCount ? sum / s.deltaCount : 0,
      worstFrameMs: worst,
      budgetMs: 1000 / targetFps,
      sinceLastDrawMs: s.lastDrawTs ? Math.max(0, performance.now() - s.lastDrawTs) : 0,
    };
  },

  /** Snapshots for every known loop, sorted by worst frame time (bottleneck first). */
  diagnostics(): FrameLoopStats[] {
    return Array.from(loops.keys())
      .map((k) => FrameScheduler.stats(k))
      .filter((x): x is FrameLoopStats => x !== null)
      .sort((a, b) => b.worstFrameMs - a.worstFrameMs);
  },

  /** Clear counters (used when a tier switches, so diagnostics describe the current tier). */
  resetAll(): void {
    for (const s of loops.values()) {
      s.frames = 0;
      s.skippedByLimiter = 0;
      s.dropped = 0;
      s.deltaIdx = 0;
      s.deltaCount = 0;
      s.lastDrawTs = 0;
    }
  },

  /** True when `mode` is the frame-locked tier. Shared predicate for consumers. */
  isLockedTier(mode: string | undefined): boolean {
    return mode === 'stable60';
  },

  /**
   * Frame-rate-independent smoothing factor. Converts a per-frame (60fps)
   * lerp factor like 0.15 into the equivalent factor for a tick of `dt` ms,
   * so skipped/extra ticks change speed, not feel. `1 - 0.85^(dt/16.67)`.
   */
  smoothingAlpha(dtMs: number, baseFactorAt60 = 0.15): number {
    if (dtMs <= 0) return 0;
    if (dtMs > 250) dtMs = 250; // tab was hidden — snap, don't lerp a second of motion
    const decay = 1 - baseFactorAt60;
    return 1 - Math.pow(decay, dtMs / FRAME_BUDGET_MS);
  },
};
