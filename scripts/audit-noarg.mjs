#!/usr/bin/env bun
/**
 * Naksha — Task 101 drift check: registry usage-grammar vs palette one-click.
 *
 * The palette's noArgCommands set is the ONE-CLICK contract; the registry's
 * usage strings are the DOCUMENTED contract (`[optional]` = bare works,
 * `<required>` = needs args). When the two drift, the palette either runs a
 * verb that documented itself as needing args, or prefills a verb whose
 * bare form was the whole point. Task 100 made the set audited; this script
 * keeps it honest forever.
 *
 * Verdicts:
 *  - CLICKED-REQUIRES  verb in noArgCommands but usage demands <args>
 *                      → fix the usage string or drop the verb from the set
 *  - OPTIONAL-PREFILL  usage is all-optional but verb prefills (not in set)
 *                      → deliberate two-step (demo/pin/…) or a missed verb
 *  - SKELETON-DRIFT    (Task 104) the arg-skeleton population changed — a
 *                      verb's usage drifted into/out of skeleton eligibility,
 *                      which silently changes its palette prefill. Update
 *                      SKELETON_BASELINE to acknowledge.
 *  - SKELETON-INVALID  a built skeleton broke a load-bearing invariant
 *                      (gap↔slot ordinal mapping, monotone carets) —
 *                      TerminalPane's Tab navigator would mis-navigate.
 * Exits 1 if any CLICKED-REQUIRES, GHOST, SKELETON-DRIFT or
 * SKELETON-INVALID (a lying one-click, a broken mapping, or an
 * unacknowledged behavior change), 0 otherwise.
 */
import { readFileSync } from 'node:fs';
import { buildArgSkeleton } from '../src/lib/naksha/arg-skeleton.ts';

const ROOT = process.cwd();
const src = readFileSync(`${ROOT}/src/lib/naksha/commands.ts`, 'utf8');
const pal = readFileSync(`${ROOT}/src/components/naksha/CommandPalette.tsx`, 'utf8');

// ── registry: name + usage (3rd quoted arg) ─────────────────────────────
const regRe = /this\.register\('([a-z][a-z0-9-]*)',\s*'([^']*)',\s*'([^']*)',\s*'([a-z]+)'/g;
const verbs = new Map(); // name -> usage
let m;
while ((m = regRe.exec(src))) verbs.set(m[1], m[3]);

// ── palette: the one-click set literal ─────────────────────────────
// Task 103 lesson, twice over: the const was renamed (noArgCommands →
// NO_ARG_COMMANDS) and the exact-name regex silently matched NOTHING —
// the audit ran "green" against an EMPTY set, blind to every
// CLICKED-REQUIRES drift. Worse, the first "tolerant" rewrite still
// missed: /noArg/i can never match NO_ARG because the UNDERSCORE breaks
// the letter run (n,o,_,a,r,g vs n,o,a,r,g). So the set is now located
// STRUCTURALLY (the file's only `const X = new Set([` literal — verified
// unique) and sanity-checked by content: an auditor that cannot see the
// set must FAIL, not bless the contract.
const setRe = /const\s+\w+\s*=\s*new Set\(\[([\s\S]*?)\]\);/g;
const setMatches = [...pal.matchAll(setRe)];
if (setMatches.length !== 1) {
  console.error(`AUDITOR BLIND: expected exactly 1 Set literal in CommandPalette.tsx, found ${setMatches.length}. `
    + 'Fix the structural regex before trusting any "Contract holds".');
  process.exit(1);
}
const setSrc = setMatches[0][1];
const noArg = new Set([...setSrc.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((x) => x[1]));
if (noArg.size === 0 || !noArg.has('help') || !noArg.has('stats')) {
  console.error('AUDITOR BLIND: the parsed Set is empty or lacks the stable one-click verbs (help, stats) — '
    + 'the regex grabbed the wrong literal or the set changed shape. Not trusting a green run.');
  process.exit(1);
}

// ── deliberate two-steps: bare is POSSIBLE but not one-click-worthy ─────
const deliberate = new Set([
  'demo', // mutates CareSpace — never one click
  'pin', // wants a label typed
  'palette', // opening the palette from the palette is a loop
  'snap', // context-gated: bare dead-ends ("No notes to snap") unless focus notes exist
]);

console.log(`registry verbs: ${verbs.size} · noArgCommands: ${noArg.size}`);

const clickedRequires = [];
const optionalPrefill = [];

for (const [name, usage] of verbs) {
  const requires = /<[^>]*>/.test(usage);
  const clicked = noArg.has(name);
  if (clicked && requires) clickedRequires.push(`${name} :: ${usage}`);
  if (!clicked && !requires && !deliberate.has(name)) optionalPrefill.push(`${name} :: ${usage}`);
}

// set members that no longer exist in the registry (ghost names)
const ghosts = [...noArg].filter((n) => !verbs.has(n));

console.log(`\nCLICKED-REQUIRES (one-click runs a verb that documents required args):`);
console.log(clickedRequires.length ? clickedRequires.map((s) => `  ✗ ${s}`).join('\n') : '  (none)');
console.log(`\nOPTIONAL-PREFILL (bare works but palette prefills; deliberate = ${[...deliberate].join('/') || '∅'}):`);
console.log(optionalPrefill.length ? optionalPrefill.map((s) => `  · ${s}`).join('\n') : '  (none)');
console.log(`\nGHOST set-members (in noArgCommands, absent from registry):`);
console.log(ghosts.length ? ghosts.map((s) => `  ✗ ${s}`).join('\n') : '  (none)');

// ── skeleton population (Task 104): the prefill contract is derived too ──
// CommandPalette.runCommand and TerminalPane's Tab navigator BOTH call
// buildArgSkeleton(usage) — eligibility is already a derived property of
// the usage strings. What derivation alone cannot give is VISIBILITY:
// an innocent-looking usage edit (`<A>` → `<A> <B>`, or dropping a
// literal anchor) silently moves a verb in or out of the skeleton
// population and changes what the palette prefills. The population is
// therefore diffed against this checked-in baseline; any change blocks
// until the baseline is updated — an acknowledged behavior change, not a
// silent one. (Same philosophy as the auditor-blind rule above.)
const SKELETON_BASELINE = new Set([
  'link', 'relabel', 'caremove', 'mvnode', 'route',
  'measure', 'rennet', 'rennode', 'save', 'unlink',
]);

const skeletonInvalid = [];
const skeletonPop = new Map(); // name -> skeleton
for (const [name, usage] of verbs) {
  const sk = buildArgSkeleton(usage);
  if (!sk) continue;
  skeletonPop.set(name, sk);
  /* Invariants TerminalPane's Tab navigator (Layer 1.5) leans on. */
  if (sk.slots.length !== sk.slotTokens.length) {
    skeletonInvalid.push(`${name} :: slots ${sk.slots.length} ≠ slotTokens ${sk.slotTokens.length} — the gap↔slot ordinal mapping would mis-complete`);
  }
  if (!sk.slots.every((off, i) => i === 0 || off > sk.slots[i - 1])) {
    skeletonInvalid.push(`${name} :: caret offsets not strictly increasing (${sk.slots.join(',')}) — Tab order is undefined`);
  }
  if (!sk.text.startsWith(name)) {
    skeletonInvalid.push(`${name} :: skeleton text ${JSON.stringify(sk.text)} does not start with the verb`);
  }
}

const entered = [...skeletonPop.keys()].filter((n) => !SKELETON_BASELINE.has(n));
const left = [...SKELETON_BASELINE].filter((n) => !skeletonPop.has(n));

console.log(`\nSKELETON POPULATION (derived from usage strings · baseline ${SKELETON_BASELINE.size}):`);
console.log(`  ${skeletonPop.size ? [...skeletonPop.keys()].map((n) => `${n} → ${JSON.stringify(skeletonPop.get(n).text)}`).join('\n  ') : '  (none)'}`);
console.log(`\nSKELETON-INVALID (built skeleton breaks a Tab-navigator invariant):`);
console.log(skeletonInvalid.length ? skeletonInvalid.map((s) => `  ✗ ${s}`).join('\n') : '  (none)');
console.log(`\nSKELETON-DRIFT (prefill population moved vs the acknowledged baseline):`);
if (!entered.length && !left.length) {
  console.log('  (none)');
} else {
  if (entered.length) console.log(entered.map((s) => `  ✗ ENTERED ${s} :: ${verbs.get(s)} — gained skeleton prefill; update SKELETON_BASELINE to acknowledge`));
  if (left.length) console.log(left.map((s) => `  ✗ LEFT     ${s} — lost skeleton prefill (usage edited or verb removed); update SKELETON_BASELINE to acknowledge`));
}

if (clickedRequires.length || ghosts.length || skeletonInvalid.length || entered.length || left.length) {
  console.log('\nDRIFT: the one-click contract, a skeleton mapping, or the acknowledged\nprefill population is out of date. Fix or acknowledge before ship.');
  process.exit(1);
}
console.log('\nContract holds: every clicked verb documents its bare form as real, and\nthe skeleton prefill population is exactly the acknowledged one.');
