/**
 * Naksha — Direction context (Phase 8)
 *
 * The single module that decides and applies TEXT DIRECTION for the app:
 *
 *  1. DETECTION — RTL scripts (Persian/Arabic/Hebrew/…) are found by a
 *     strong-character regex over the first non-empty lines of a text
 *     (the standard first-strong-character rule of the Unicode bidi
 *     algorithm, applied per note/file rather than per page).
 *  2. RESOLUTION — settings.direction is 'auto' | 'ltr' | 'rtl'. 'auto'
 *     samples the app's own content (CareSpace node labels + note texts)
 *     and follows its first strong character; explicit choices win.
 *  3. APPLICATION — the resolved direction lands on the document root
 *     (`<html dir>` + `data-direction`), so the chrome's flex rows, the
 *     logical-property CSS, and the `[dir="rtl"]` stylesheet hooks all
 *     read one truth. Per-surface rules stay local (the terminal keeps
 *     LTR input syntax and marks only its OUTPUT rows dir="auto"; the
 *     reader detects per note) — the root attribute is for the CHROME.
 *
 * Like perf-tier.ts this is a pure TS module: no React, no store
 * subscription — callers hand it values and it touches the DOM once.
 */

import { CareSpace } from './carespace';
import type { NakshaSettings } from './types';

export type DirectionMode = NonNullable<NakshaSettings['direction']>;
export type EffectiveDirection = 'ltr' | 'rtl';

/** Strong RTL characters: Hebrew block, Arabic block (+ supplements and
 *  presentation forms). These are the scripts the auto-detector names:
 *  Persian/Arabic/Hebrew and close relatives. Global flag: the detector
 *  COUNTS matches (strong-character majority). */
const RTL_STRONG_RE =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;

/** Strong LTR characters — anything clearly left-to-right (Latin, Greek,
 *  Cyrillic, CJK is neutral-ish in bidi but counted as LTR here so a
 *  Japanese-first vault does not flip the chrome). Global flag: counting. */
const LTR_STRONG_RE = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF]/g;

/** How many non-empty lines the detector reads before deciding
 *  (spec: "regex over first non-empty lines" — a bounded prefix, not a
 *  whole-file scan), and the per-line character cap that keeps a huge
 *  single line from dominating the scan. */
const DETECT_MAX_LINES = 24;
const DETECT_MAX_CHARS_PER_LINE = 400;

/**
 * Detect the base direction of a TEXT (raw note/file content, not HTML)
 * by STRONG-CHARACTER MAJORITY over the first non-empty lines: count
 * RTL-script vs LTR-script letters; the side with more letters wins.
 *
 * Why majority, not first-strong: a Persian note that OPENS with an
 * English heading (`# Roadmap ۱۴۰۳`) would lock LTR under a
 * first-strong rule while every body line is Persian — the chrome would
 * refuse to mirror and the reader would align the wrong way. Majority
 * answers "what script does this text mostly speak", which is the
 * question both surfaces actually ask. Ties (and strong-character-free
 * text) return null so callers fall back to LTR or stay neutral.
 */
export function detectDirection(text: string | null | undefined): EffectiveDirection | null {
  if (!text) return null;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let rtl = 0;
  let ltr = 0;
  let seen = 0;
  for (const raw of lines) {
    const line = raw.trim().slice(0, DETECT_MAX_CHARS_PER_LINE);
    if (!line) continue;
    /* Count strong characters: the global regexes match every RTL /
     * LTR letter in the line (match(null) → 0). Bounded by the caps
     * above, so the whole scan stays cheap on mutation events. */
    rtl += (line.match(RTL_STRONG_RE) ?? []).length;
    ltr += (line.match(LTR_STRONG_RE) ?? []).length;
    if (++seen >= DETECT_MAX_LINES) break;
  }
  if (rtl === 0 && ltr === 0) return null;
  return rtl > ltr ? 'rtl' : 'ltr';
}

/**
 * Build the AUTO sample: the app's own writing. CareSpace node labels
 * and the first line of each note are the content the user actually
 * authors (a vault file can be anything, so vault content never flips
 * the CHROME — the reader handles its own files per note). Capped so a
 * large tree costs the same small scan.
 */
export function sampleAppContent(): string {
  try {
    const parts: string[] = [];
    let budget = 4000;
    for (const net of CareSpace.networks()) {
      for (const node of Object.values(net.nodes ?? {})) {
        if (budget <= 0) break;
        if (node.label) {
          parts.push(node.label);
          budget -= node.label.length;
        }
        const note = node.notes?.[0]?.text;
        if (note) {
          const head = note.slice(0, 240);
          parts.push(head);
          budget -= head.length;
        }
      }
      if (budget <= 0) break;
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

/**
 * Resolve the effective direction: explicit 'ltr'/'rtl' wins; 'auto'
 * (or an undefined legacy profile) follows the sampled content's first
 * strong character, defaulting to LTR when nothing strong exists.
 */
export function effectiveDirection(mode: DirectionMode | undefined, sample: string): EffectiveDirection {
  if (mode === 'rtl' || mode === 'ltr') return mode;
  return detectDirection(sample) ?? 'ltr';
}

/**
 * Apply the resolved direction to the document root. Idempotent (two
 * attribute writes); safe to call on every settings/revision change.
 * `mode` rides `data-direction` so CSS can style the AUTO state apart
 * from a forced one, while `<html dir>` carries the effective truth.
 */
export function applyDirectionDocumentAttr(mode: DirectionMode | undefined, effective: EffectiveDirection): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('dir', effective);
  root.setAttribute('data-direction', mode ?? 'auto');
  /* Convenience hook for one-line CSS rules (html[data-rtl="true"]).
   * Removed for LTR so old saves with a stale attribute heal themselves. */
  if (effective === 'rtl') root.setAttribute('data-rtl', 'true');
  else root.removeAttribute('data-rtl');
}

/** Honest label for receipts and chips: what the mode resolves to. */
export function describeDirection(mode: DirectionMode | undefined, sample: string): string {
  const effective = effectiveDirection(mode, sample);
  const label = mode ?? 'auto';
  return mode === 'auto' ? `auto → ${effective}` : `${label} (${effective})`;
}
