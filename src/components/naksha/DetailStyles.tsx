'use client';

/**
 * Naksha — DetailStyles
 *
 * The "mandatory styling details" layer, injected as a component-scoped
 * <style> tag (document-wide effect). Lives outside globals.css because the
 * dev Turbopack CSS pipeline is frozen (see Task 29/30/31); this rides
 * the JS module graph and hot-reloads reliably. The globals.css copy is the
 * production/documentation source of truth.
 *
 * Details in this round (Task 32):
 *  1. Glass catch-light — a 1px gradient highlight across the top edge of
 *     every glass pane. Reads as light from above settling on the frame;
 *     pure static paint, no animation, safe for the perf-low tier.
 *  2. Terminal line hover — a faint warm background while scanning output
 *     with the mouse; helps the eye track a row across wide wrapped lines.
 *  3. Tabular numerals — all terminal text uses fixed-width digits so the
 *     [NN] ledger gutter, timestamps and columnar command output align in
 *     perfect columns (expert-programmer typography).
 *  4. Section-header rule — `header`-type terminal lines (Settings,
 *     whereis, help categories…) get a fading gold hairline under the
 *     text, like a ruled ledger. Static paint, zero cost.
 *  5. Themed text selection — ::selection uses the app's warm gold instead
 *     of the browser default blue, so copy actions feel native to the
 *     surface (and stay readable in BOTH warm themes).
 *  6. Keyboard focus ring — :focus-visible draws a 1px gold outline on
 *     buttons/inputs only when navigating by keyboard (mouse clicks stay
 *     clean). Expert a11y without visual noise.
 * All rules are static (no animation/transition) — they cost nothing at
 * rest and remain active under data-perf="low".
 */

export function DetailStyles() {
  return (
    <style>{`
      /* ── 1. Glass catch-light (top edge, light-from-above) ─────────── */
      .naksha-glass::before,
      .naksha-glass-strong::before {
        content: '';
        position: absolute;
        top: 0;
        left: 6%;
        right: 6%;
        height: 1px;
        background: linear-gradient(
          90deg,
          transparent,
          rgba(245, 234, 208, 0.16) 30%,
          rgba(245, 234, 208, 0.22) 50%,
          rgba(245, 234, 208, 0.16) 70%,
          transparent
        );
        pointer-events: none;
        border-radius: 1px;
      }

      /* ── 2. Terminal line hover — reading aid while scanning output ── */
      .naksha-term-history .term-line:hover {
        background: rgba(245, 234, 208, 0.035);
      }

      /* ── 3. Tabular numerals — aligned ledger + columnar output ────── */
      .term-line {
        font-variant-numeric: tabular-nums;
      }

      /* ── 4. Section-header rule — ledger hairline under headers ────── */
      .naksha-term-history .term-line.header {
        position: relative;
        padding-bottom: 5px;
      }
      .naksha-term-history .term-line.header::after {
        content: '';
        position: absolute;
        left: 0;
        right: 18%;
        bottom: 1px;
        height: 1px;
        background: linear-gradient(
          90deg,
          color-mix(in srgb, var(--naksha-gold) 40%, transparent),
          color-mix(in srgb, var(--naksha-gold) 12%, transparent) 60%,
          transparent
        );
        pointer-events: none;
      }

      /* ── 5. Themed text selection — warm gold, both themes ─────────── */
      ::selection {
        background: color-mix(in srgb, var(--naksha-gold) 32%, transparent);
        color: var(--naksha-text);
      }

      /* ── 6. Keyboard-only focus ring (mouse clicks stay clean) ─────── */
      .naksha-mini-btn:focus-visible,
      .naksha-perf-chip:focus-visible,
      #naksha-terminal-input:focus-visible {
        outline: 1px solid color-mix(in srgb, var(--naksha-gold) 65%, transparent);
        outline-offset: 2px;
        border-radius: 3px;
      }
    `}</style>
  );
}

export default DetailStyles;
