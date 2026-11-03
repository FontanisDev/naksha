/**
 * Naksha — Performance tier helper (Phase 1)
 *
 * One small module so every writer of the performance tier applies the
 * SAME document state. Three writers exist today: the PerfPanel cards,
 * the `settings perf` terminal command, and the store's init path
 * (re-applying a saved tier on reload). Before this module each wrote
 * the `data-perf` attribute by hand — with only two tiers that was a
 * set/remove pair; with three, the stable60 case (set a DIFFERENT
 * value, never remove) is exactly the kind of branch that drifts.
 *
 * The attribute drives the CSS tiers (`html[data-perf="stable60"]` in
 * PerfStyles.tsx + globals.css); the FrameScheduler counters reset on
 * every switch so diagnostics always describe the CURRENT tier, never
 * a blend of the previous one's frames.
 */

import type { NakshaSettings } from './types';
import { FrameScheduler } from './frame-scheduler';

export type PerfMode = NonNullable<NakshaSettings['perfMode']>;

/**
 * Apply the tier's document state.
 *  'low'      → data-perf="low"
 *  'stable60' → data-perf="stable60"
 *  'high'     → attribute removed (HIGH is the default/unhooked state)
 *  undefined  → attribute removed (no tier chosen — detection may later)
 * FrameScheduler counters reset whenever the attribute VALUE changes so
 * the diagnostics shown in PerfPanel/PerfHud are tier-pure.
 */
export function applyPerfDocumentAttr(mode: PerfMode | undefined): void {
  const html = document.documentElement;
  const prev = html.getAttribute('data-perf');
  const next =
    mode === 'low' ? 'low' : mode === 'stable60' ? 'stable60' : null;
  if (next) html.setAttribute('data-perf', next);
  else html.removeAttribute('data-perf');
  if (prev !== next) FrameScheduler.resetAll();
}

/**
 * Parse a user-typed tier name. Accepts the canonical ids plus the
 * natural aliases people actually type at a terminal (`stable`,
 * `60`, `balanced`). Returns null for anything else — the caller owns
 * the error message.
 */
export function normalizePerfMode(value: string): PerfMode | null {
  const v = value.trim().toLowerCase();
  if (v === 'low') return 'low';
  if (v === 'stable60' || v === 'stable' || v === '60' || v === 'balanced' || v === 'balanced60')
    return 'stable60';
  if (v === 'high') return 'high';
  return null;
}
