/* Task 93 — the terminal's live char capacity.
 *
 * The mono face made the sheet columns truly align (a padEnd is now a
 * visual column, not a suggestion) — but it also made every fixed pad
 * a LIE: the sheets were authored against a proportional font's
 * narrower metrics and an optimistic pane width. At the default layout
 * the terminal is ~35 columns, and a padEnd(34) help sheet wrapped
 * every single row.
 *
 * The fix is not smaller literals — it's a live budget. TerminalPane
 * measures the history element with a ResizeObserver and reports the
 * char capacity here; sheets read it at print time and reflow like man
 * pages: two-column when the row fits, usage-then-indented-description
 * when it doesn't. Wide panes keep the roomy sheets; the 316px default
 * gets honest ones.
 *
 * 46 is the pre-measure default (a comfortable desktop median). The
 * first ResizeObserver callback fires synchronously after observe(),
 * before any user command can print — the welcome banner may print
 * before it, and its prose wraps harmlessly either way. */

let cols = 46;

/** TerminalPane calls this from its ResizeObserver (and once on mount).
 *  Clamped to a sane band: 20 so a squeezed pane still renders columns
 *  (they wrap, but predictably), 110 so a maximized pane can't inflate
 *  the sheets into horizon-wide lines. */
export function setTermCols(c: number): void {
  if (Number.isFinite(c) && c >= 20) cols = Math.min(Math.round(c), 110);
}

/** The live char capacity. Sheets read this at print time. */
export function termCols(): number {
  return cols;
}
