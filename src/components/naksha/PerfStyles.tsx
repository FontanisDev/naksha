'use client';

/**
 * Naksha — PerfStyles
 *
 * Global stylesheet for the CPU-ONLY performance tier, injected as a
 * component-scoped <style> tag. This deliberately duplicates (and hardens)
 * rules that also live in globals.css: the dev environment's Turbopack CSS pipeline
 * is frozen (new globals.css rules never reach the served chunk — verified
 * again in Task 31 with a sentinel probe), while JS module edits hot-reload
 * reliably. A <style> tag rendered anywhere applies document-wide, so this
 * component rides the live JS module graph and is immune to the freeze.
 *
 * The globals.css copy stays as documentation for production builds.
 *
 * What this tier does (perf=low, auto-detected on CPU-only hardware):
 *  1. ELIMINATES backdrop-filter entirely — blur(6-8px) still forces the
 *     compositor to sample and re-filter every pixel behind each pane on
 *     every repaint; on CPU-only machines that is the single largest
 *     constant cost in the app. The glass look is preserved by stacking
 *     the opaque page background UNDER the glass tint (same warm surface,
 *     zero filter cost) — "frosted glass that has fully settled".
 *  2. Drops `will-change` hints that no longer pay for themselves once
 *     the breath animations are disabled (each hint pins a layer).
 *  3. Kills residual transitions on surfaces that repaint often
 *     (glass panes repaint on every terminal append / tree redraw).
 *  4. (Task 32) RESTORES high-tier blur: the served globals.css chunk was
 *     minified to keep ONLY `-webkit-backdrop-filter` in the base glass
 *     rules — and modern Chromium no longer aliases the prefixed form
 *     (computed backdropFilter stays "none"), so HIGH tier silently had
 *     zero blur. These html:not([data-perf="low"]) rules re-assert the
 *     standard property; they ride the JS module graph so the frozen CSS
 *     pipeline cannot drop them. The LOW-tier zero-blur rules below still
 *     win in perf=low (they carry !important).
 *
 * STABLE_60 tier (Phase 1): a third data-perf value. It shares LOW's
 * zero-blur glass economics (the 1/1b/2 blocks) but KEEPS one-shot
 * transitions and term-line entrances (they are cheap, single paints —
 * killing them is what made LOW feel dead). The HIGH blur re-assertion
 * (block 0) now excludes BOTH low and stable60 — otherwise stable60
 * would silently inherit blur(12px) and pay the largest constant cost
 * the tier exists to avoid.
 */

export function PerfStyles() {
  return (
    <style>{`
      /* ── 0. HIGH-tier blur restoration (see header note 4) ──────────
         Task T1 (v138): 12px → 6px. The dot-grid star field must read
         through the glass — 12px of frost smears a 1.5px dot into
         nothing, 6px keeps it as a soft glow. Halves the constant
         backdrop cost on the high tier while it's at it. Keep in sync
         with the .naksha-glass rule in globals.css. */
      html:not([data-perf="low"]):not([data-perf="stable60"]) .naksha-glass {
        backdrop-filter: blur(6px) saturate(130%);
        -webkit-backdrop-filter: blur(6px) saturate(130%);
      }
      html:not([data-perf="low"]):not([data-perf="stable60"]) .naksha-glass-strong {
        backdrop-filter: blur(16px) saturate(130%);
        -webkit-backdrop-filter: blur(16px) saturate(130%);
      }

      /* ── 1. Zero-blur glass: opaque fallback stack (low + stable60) ── */
      html[data-perf="low"] .naksha-glass,
      html[data-perf="stable60"] .naksha-glass {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        /* A background shorthand's color may only sit in the LAST layer, so
           the glass tint is expressed as a solid-color gradient layer. */
        background:
          linear-gradient(180deg, rgba(245, 234, 208, 0.035) 0%, transparent 6%, transparent 100%),
          linear-gradient(var(--naksha-glass), var(--naksha-glass)),
          var(--naksha-bg) !important;
      }
      html[data-perf="low"] .naksha-glass-strong,
      html[data-perf="stable60"] .naksha-glass-strong {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        background:
          linear-gradient(180deg, rgba(245, 234, 208, 0.05) 0%, transparent 8%, transparent 100%),
          linear-gradient(var(--naksha-glass-strong), var(--naksha-glass-strong)),
          var(--naksha-bg) !important;
      }
      /* Modal dialogs inject their own blur(20px) with !important — the
         higher-specificity [data-slot] + !important pair wins over it. */
      html[data-perf="low"] [data-slot="dialog-content"],
      html[data-perf="stable60"] [data-slot="dialog-content"] {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        background: var(--naksha-bg-2) !important;
      }
      html[data-perf="low"] [data-slot="dialog-overlay"],
      html[data-perf="stable60"] [data-slot="dialog-overlay"] {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }

      /* ── 1b. Universal Tailwind-blur kill (Task 36) ─────────────────
         The main glass classes were covered above, but Tailwind's
         backdrop-blur* utilities slipped through on surfaces that sit
         ON THE MAP and repaint on every pan/zoom: the layer switcher,
         the info chips, plus NanoEditor's backdrop-blur-xl (98% opaque
         — the blur is invisible yet still filters every pixel behind it).
         This substring catch-all covers every current and future Tailwind
         blur class at the low and stable60 tiers. Opaque fallback
         backgrounds already exist on all these elements, so nothing
         becomes unreadable. */
      html[data-perf="low"] [class*="backdrop-blur"],
      html[data-perf="stable60"] [class*="backdrop-blur"] {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }

      /* ── 1c. STABLE_60 scrim family (Task 99 parity) ─────────────────
         The scrims and the status bar carry inline blur(8-10px); the
         low tier kills them via globals.css, but that file's served
         chunk is frozen in the dev environment, so the stable60 kill rides
         HERE — same selector set, same reasoning: a transient scrim
         blur over a full-screen surface is exactly the constant cost
         this tier trades away to hold 60 FPS during pointer motion. */
      html[data-perf="stable60"] .naksha-scrim,
      html[data-perf="stable60"] .naksha-statusbar,
      html[data-perf="stable60"] .care-tooltip {
        backdrop-filter: none !important;
      }
      html[data-perf="stable60"] .naksha-statusbar {
        /* UI-calm fix: was a hardcoded amber-night dark scrim (wrong on
         * every other theme); glass-strong is the theme's own dense
         * surface — same legibility, theme-correct. */
        background: var(--naksha-glass-strong) !important;
      }

      /* ── 2. Layer hints: nothing CONTINUOUS animates at these tiers, so
              no layer pinning is worth its memory on a 4GB box. The body
              ambience layers were REMOVED entirely (UI-calm pass) — these
              selectors are now inert no-ops kept only to avoid touching
              the tier contract. ──── */
      html[data-perf="low"] body::before,
      html[data-perf="low"] body::after,
      html[data-perf="stable60"] body::before,
      html[data-perf="stable60"] body::after {
        will-change: auto !important;
        animation: none !important;
      }
      html[data-perf="low"] .naksha-glass,
      html[data-perf="low"] .naksha-glass-strong,
      html[data-perf="stable60"] .naksha-glass,
      html[data-perf="stable60"] .naksha-glass-strong {
        will-change: auto !important;
      }

      /* ── 3. Residual transition kill — LOW ONLY. STABLE_60 KEEPS
              transitions and term-line entrances: they are one-shot
              single paints (≤200ms, once per open/append), not the
              continuous ambience loops, so they cost nothing while the
              pointer moves — and their absence is precisely what made
              LOW feel over-optimized (the Phase 1 complaint). ────── */
      html[data-perf="low"] .naksha-glass,
      html[data-perf="low"] .naksha-glass-strong,
      html[data-perf="low"] .naksha-mini-btn,
      html[data-perf="low"] .term-line {
        transition: none !important;
      }
      html[data-perf="low"] .term-line {
        animation: none !important;
        opacity: 1;
      }

      /* ── 4. Cascade fix: glass vs position utilities (Task 34) ────────
         The .naksha-glass* classes are UNLAYERED in globals.css, so their
         "position: relative" beats Tailwind's @layer utilities .absolute/
         .fixed (unlayered styles always win the cascade regardless of
         specificity). Any element combining a glass class with a position
         utility — the Reader panel — was forced in-flow: the hidden panel
         kept occupying a flex slot and squashed the map by its own height.
         These higher-specificity rules restore the utility's position. */
      .absolute.naksha-glass,
      .absolute.naksha-glass-strong {
        position: absolute;
      }
      .fixed.naksha-glass,
      .fixed.naksha-glass-strong {
        position: fixed;
      }
      .sticky.naksha-glass,
      .sticky.naksha-glass-strong {
        position: sticky;
      }
    `}</style>
  );
}

export default PerfStyles;
