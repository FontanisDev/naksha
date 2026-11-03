/**
 * Naksha — Task 103: the arg-skeleton prefill for multi-slot verbs.
 *
 * Task 102's args chip taught the grammar BEFORE the click; this module
 * teaches it AFTER: picking a chipped row prefills not `verb ` but the
 * verb's POSITIONAL SKELETON — every `<slot>` becomes a two-space gap,
 * every literal (`to`, `as`) stays — so `measure <A> to <B> [as <name>]`
 * opens as `measure  to  ` with the caret in the first gap. The gaps are
 * the form fields; the chip's clause is the documentation.
 *
 * The SAME builder serves both consumers (the Task 102 hoisting lesson —
 * a contract read by two parties must live in one place):
 *   - CommandPalette.runCommand generates the prefill text + first caret;
 *   - TerminalPane's Tab handler reads `slotTokens` to know WHICH slot a
 *     gap is (Layer 2's token-counting heuristic cannot see empty slots)
 *     and navigates the gaps in order.
 *
 * Eligibility is deliberately conservative — the skeleton only exists
 * where the grammar is positional AND literal-anchored:
 *   - no pipe enums (`[tree|graph]` — Layer 2 already offers those);
 *   - no two slots adjacent (`mv <src> <dst>` — adjacent gaps merge into
 *     one three-space run and the gap↔slot mapping loses its anchor);
 *   - ≥2 slots (single-slot verbs keep today's exact `verb ` prefill);
 *   - only the REQUIRED portion (up to the first `[optional]` group) —
 *     a skeleton that forces an optional tail (`nodefrom  under  `)
 *     pushes the user through syntax they may not want; the chip and
 *     the usage receipt still document the optional part.
 *
 * Population (surveyed over all 127 registry usages): link, relabel,
 * caremove, mvnode, route, measure, rennet, rennode, save, unlink —
 * the `X ␣␣ to ␣␣` family whose word order is easy to forget.
 */

export interface ArgSkeleton {
  /** The prefill text, e.g. `link  to  ` (two trailing spaces = slot 2). */
  text: string;
  /** Fill-caret offset of each gap (the gap's SECOND space — the first
   * space is the separator, typing at the caret keeps one clean space). */
  slots: number[];
  /** The usage's `<slot>` tokens in gap order — gap k ↔ slotTokens[k]
   * while unfilled. Feeds Tab completion's candidate lookup. */
  slotTokens: string[];
}

const SLOT_RE = /^<[^<>]+>$/;

export function buildArgSkeleton(usage: string): ArgSkeleton | null {
  if (!usage || usage.includes('|')) return null;

  /* Required portion only: drop every [...]-optional group wholesale. */
  const required = usage.replace(/\[[^\]]*\]/g, ' ');
  const tokens = required.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const [verb, ...rest] = tokens;
  const slotTokens = rest.filter((t) => SLOT_RE.test(t));
  if (slotTokens.length < 2) return null;
  for (let i = 1; i < rest.length; i++) {
    if (SLOT_RE.test(rest[i]) && SLOT_RE.test(rest[i - 1])) return null; // adjacent slots
  }

  let text = verb;
  const slots: number[] = [];
  let prevWasSlot = false;
  for (const t of rest) {
    if (SLOT_RE.test(t)) {
      text += '  '; // separator space + the gap's fill space
      slots.push(text.length - 1);
      prevWasSlot = true;
    } else {
      if (!prevWasSlot) text += ' '; // a slot's trailing space already separates
      text += t;
      prevWasSlot = false;
    }
  }
  return { text, slots, slotTokens };
}
