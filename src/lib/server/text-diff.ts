/**
 * Naksha — dependency-free line diff (T7 round 4, the TriliumNext
 * revisions port part 2: upstream renders note-revision diffs; this is
 * the file-backed engine behind `vault diff` and the panel's revision
 * viewer).
 *
 * Algorithm: trim the common prefix/suffix first (the overwhelmingly
 * common "edit in the middle" case costs almost nothing), then an LCS
 * dynamic program on the remainder. The DP is BOUNDED (CELL_CAP): a
 * pathological pair (thousands of changed lines on both sides) degrades
 * honestly to a coarse "whole middle replaced" hunk instead of eating
 * memory — the summary stats stay exact either way, only the hunk
 * granularity coarsens.
 *
 * Server-side only for now (revisions routes); pure and importable by
 * the client later if the GUI ever needs local diffing.
 */

export type DiffKind = 'same' | 'add' | 'del';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** DP cell budget — beyond this the middle section coarsens. */
const CELL_CAP = 1_000_000;

/** Split without the trailing-newline bookkeeping noise: one string →
 * lines. A trailing newline does NOT produce a phantom empty line. */
function toLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  return normalized.split('\n');
}

/**
 * Line diff of a → b, in document order. `same` lines carry the
 * unchanged text; `del` lines are a-only; `add` lines are b-only.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const A = toLines(a);
  const B = toLines(b);
  const out: DiffLine[] = [];

  // 1 · common prefix
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  for (let i = 0; i < start; i++) out.push({ kind: 'same', text: A[i] });

  // 2 · common suffix
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA--;
    endB--;
  }

  // 3 · LCS on the (trimmed) middle — bounded
  const midA = A.slice(start, endA);
  const midB = B.slice(start, endB);
  pushMidDiff(midA, midB, out);

  // 4 · common suffix (in order)
  for (let i = endA; i < A.length; i++) out.push({ kind: 'same', text: A[i] });

  return out;
}

function pushMidDiff(X: string[], Y: string[], out: DiffLine[]): void {
  if (X.length === 0 && Y.length === 0) return;
  if (X.length === 0) {
    for (const t of Y) out.push({ kind: 'add', text: t });
    return;
  }
  if (Y.length === 0) {
    for (const t of X) out.push({ kind: 'del', text: t });
    return;
  }
  if (X.length * Y.length > CELL_CAP) {
    // Degrade honestly: one coarse replace hunk, exact stats preserved.
    for (const t of X) out.push({ kind: 'del', text: t });
    for (const t of Y) out.push({ kind: 'add', text: t });
    return;
  }
  // LCS length table
  const m = X.length;
  const n = Y.length;
  const width = n + 1;
  const dp = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * width + j] =
        X[i] === Y[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  // Walk the table
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (X[i] === Y[j]) {
      out.push({ kind: 'same', text: X[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ kind: 'del', text: X[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: Y[j] });
      j++;
    }
  }
  while (i < m) out.push({ kind: 'del', text: X[i++] });
  while (j < n) out.push({ kind: 'add', text: Y[j++] });
}

/** +added / −removed counts from the SAME LCS the diff view renders —
 * the listing's numbers must never disagree with the diff itself. */
export function diffStatsOf(a: string, b: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diffLines(a, b)) {
    if (line.kind === 'add') added++;
    else if (line.kind === 'del') removed++;
  }
  return { added, removed };
}
