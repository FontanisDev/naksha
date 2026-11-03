/**
 * Naksha — Vault revisions (v138 T7 round 3: the TriliumNext port, part 3)
 *
 * Ported from Trilium's note-revisions system (TriliumNext/Notes — the
 * note_revisions table + its restore/erase routes; studied in earlier
 * rounds via https://deepwiki.com/TriliumNext/Notes). The battle-tested
 * semantics this port keeps:
 *   - a revision is created when a note's content is OVERWRITTEN (never
 *     for a no-op save);
 *   - RESTORING is reversible: restoring first snapshots the current
 *     content, so the restore itself has an undo;
 *   - revisions can be erased one-by-one or all at once;
 *   - an auto-policy caps how many revisions one note accumulates
 *     (upstream's "keep N revisions" setting → KEEP_LAST here).
 *
 * The file-backed analog: this app's designated writes (care notes, shape
 * records) snapshot the PREVIOUS content before overwriting; external
 * saves (real nano, Obsidian) are observed by the change watcher and
 * archived as "observed" revisions. Nobody can archive content that no
 * longer exists before we ever saw it — so the FIRST state of a file
 * enters history when it is first seen changing, exactly the honest
 * boundary of a file-backed system.
 *
 * STORAGE — deliberately OUTSIDE the vault: revisions live in the
 * runtime db/revisions/ folder (index.json + content blobs). The vault
 * itself must stay pristine (connecting a vault never writes a single
 * byte into it — the Phase 2 contract). Keyed by the vault root so two
 * different directories never share (or leak) histories.
 *
 * PATH SAFETY — every rel passes safeResolve (normalize + root jail +
 * realpath containment), the reader's own jail. The store root is
 * Naksha-internal (db/revisions) and never user-addressable.
 *
 * Import-cycle note: vault.ts (the watcher) calls observeExternalChange
 * through a DYNAMIC import (see diffOnce) because this module statically
 * imports safeResolve from vault.ts. The cycle is runtime-only and
 * lazily resolved; static imports here stay one-directional.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeResolve, VaultPathError } from './vault';
import { diffLines, diffStatsOf, type DiffLine, type DiffStats } from './text-diff';

/* ── Store layout ──────────────────────────────────────────────────────
 * db/revisions/
 *   index.json                    { version: 1, [rootAbs]: { [rel]: Entry[] } }
 *   blobs/<hash12>/<id>.md        content blobs (hash = sha1(root::rel))
 * An Entry: { id, ts, size, kind, reason, head? } — newest last in the
 * array, listed newest-first to the user (upstream sorts desc too). */

const STORE_DIR = path.join(process.cwd(), 'db', 'revisions');
const INDEX_PATH = path.join(STORE_DIR, 'index.json');

export type RevisionKind = 'app' | 'observed';
export type RevisionReason = 'overwrite' | 'restore-shield' | 'external-change';

export interface RevisionEntry {
  id: string; // `${ts}-${seq}` — stable handle for restore/erase
  ts: number;
  size: number;
  kind: RevisionKind;
  reason: RevisionReason;
  /** First line preview (≤64 chars) taken from the archived content. */
  head?: string;
  /** Line delta vs the PREVIOUS chronological revision (+a −b) —
   * computed server-side from the same LCS the diff view renders;
   * absent for the oldest entry (nothing to compare against) and for
   * entries whose neighbor blob is missing (erased). */
  delta?: DiffStats;
}

type RevisionIndex = { version: 1; roots: Record<string, Record<string, RevisionEntry[]>> };

const INDEX_VERSION = 1;
/** Auto-policy (upstream's "keep N revisions" analog): the newest 20
 * revisions survive per path; older ones are erased on write. */
const KEEP_LAST = 20;
/** Files bigger than this are never archived (storage discipline —
 * mirrors the write path's 2MB note cap). */
const SNAPSHOT_CAP_BYTES = 2 * 1024 * 1024;
/** Observed-revision throttle: at most one external-change archive per
 * path per 5 minutes (upstream throttles revision creation on rapid
 * saves too). App-mediated snapshots are NEVER throttled — they are
 * deliberate and would otherwise be lost. */
const OBSERVE_THROTTLE_MS = 5 * 60 * 1000;
/** App-write suppression window: watcher diffs lag the write (up to the
 * 4s poll), so a just-written path+size pair is remembered briefly and
 * the resulting "change" event is not re-archived as observed. */
const SUPPRESS_TTL_MS = 30 * 1000;

/* ── Index plumbing (serialized read-modify-write) ──────────────────── */

let indexChain: Promise<unknown> = Promise.resolve();

/** Serialize every index mutation — the watcher, the write route and a
 * restore can all fire in the same tick; last-writer-wins on a shared
 * JSON file would silently drop entries. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexChain.then(fn, fn);
  indexChain = run.catch(() => {});
  return run;
}

async function readIndex(): Promise<RevisionIndex> {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw) as RevisionIndex;
    if (parsed && parsed.version === INDEX_VERSION && parsed.roots && typeof parsed.roots === 'object') {
      return parsed;
    }
  } catch {
    /* absent or corrupt index → start fresh (blobs orphaned by a corrupt
     * index are garbage-collected by erase-all; acceptable for a
     * metadata cache — the VAULT was never the thing at risk) */
  }
  return { version: INDEX_VERSION, roots: {} };
}

async function writeIndex(index: RevisionIndex): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  const tmp = `${INDEX_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(index), 'utf8');
  await fs.rename(tmp, INDEX_PATH);
}

function blobDir(root: string, rel: string): string {
  const hash = crypto.createHash('sha1').update(`${root}::${rel}`).digest('hex').slice(0, 12);
  return path.join(STORE_DIR, 'blobs', hash);
}

let seqCounter = 0;
function nextId(ts: number): string {
  seqCounter = (seqCounter + 1) % 1000;
  return `${ts}-${String(seqCounter).padStart(3, '0')}`;
}

function firstLineHead(content: string): string | undefined {
  const line = content.split('\n').find((l) => l.trim().length > 0);
  if (!line) return undefined;
  const trimmed = line.trim();
  return trimmed.length > 64 ? `${trimmed.slice(0, 63)}…` : trimmed;
}

/** Archive `content` as one revision of (root, rel). Returns the entry
 * or null when the content was over the snapshot cap. Caller MUST
 * already hold the serialized chain (this fn touches index+blob). */
async function storeRevision(
  root: string,
  rel: string,
  content: string,
  kind: RevisionKind,
  reason: RevisionReason,
): Promise<RevisionEntry | null> {
  const body = Buffer.from(content, 'utf8');
  if (body.length > SNAPSHOT_CAP_BYTES) return null; // honest skip — too big to archive
  const index = await readIndex();
  const rootIdx = (index.roots[root] ??= {});
  const list = (rootIdx[rel] ??= []);
  const ts = Date.now();
  const head = firstLineHead(content);
  const entry: RevisionEntry = {
    id: nextId(ts),
    ts,
    size: body.length,
    kind,
    reason,
    ...(head ? { head } : {}),
  };
  const dir = blobDir(root, rel);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${entry.id}.md`), body);
  list.push(entry);
  // Auto-policy: cap the pile (upstream's revision-count policy).
  const overflow = list.length - KEEP_LAST;
  if (overflow > 0) {
    const doomed = list.splice(0, overflow);
    await Promise.all(
      doomed.map((e) => fs.rm(path.join(dir, `${e.id}.md`), { force: true }).catch(() => {})),
    );
  }
  await writeIndex(index);
  return entry;
}

/* ── App-write suppression (watcher ↔ writer handshake) ───────────────
 * DISK-BACKED ON PURPOSE: Next.js bundles each route's module graph
 * separately, so an in-memory Map set by the write route is INVISIBLE
 * to the watcher living in the events route's copy of this module
 * (QA-caught: app writes kept being re-archived as "observed"). The
 * registry is a tiny JSON file next to the index — shared by every
 * bundle and every server generation.
 * SYNCHRONOUS on purpose as well: the mark must be DURABLE before the
 * write's bytes land, or the watcher's poller can diff inside the
 * mark-write window and resurrect the suppressed entry (QA-caught:
 * photo-finish race → one spurious "observed" entry). A sync write of
 * a ≤few-hundred-byte file costs microseconds. */

const APPWRITES_PATH = path.join(STORE_DIR, 'app-writes.json');

function readAppWritesSync(): Record<string, { size: number; at: number }> {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(APPWRITES_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* absent/corrupt → empty */
  }
  return {};
}

/** Called by the write paths (care-vault writeNote, restore) BEFORE and
 * AFTER the bytes land, so the watcher's next 'changed' diff for this
 * path is recognized as our own and not re-archived as "observed". */
export function markAppWriteSync(rel: string, size: number): void {
  try {
    const map = readAppWritesSync();
    const now = Date.now();
    map[rel] = { size, at: now };
    // Opportunistic prune — honest hygiene, tiny file.
    for (const [k, v] of Object.entries(map)) {
      if (now - v.at > SUPPRESS_TTL_MS * 2) delete map[k];
    }
    fsSync.mkdirSync(STORE_DIR, { recursive: true });
    const tmp = `${APPWRITES_PATH}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(map), 'utf8');
    fsSync.renameSync(tmp, APPWRITES_PATH);
  } catch {
    /* a lost suppression mark costs one throttled observed entry at
     * worst — never fail a user write for it */
  }
}

export function isSuppressedAppWriteSync(rel: string, size: number): boolean {
  const hit = readAppWritesSync()[rel];
  if (!hit) return false;
  if (Date.now() - hit.at > SUPPRESS_TTL_MS) return false;
  return hit.size === size;
}

/* ── Public capture API ─────────────────────────────────────────────── */

/** Called by care-vault.renameNote: a rename moves the file, not its
 * past — upstream keys revisions by note identity (which survives
 * renames), so the file-backed analog re-keys the history under the new
 * path. Best-effort; metadata-only (blob dir follows via the same
 * hash-of-rel keying, so blobs are re-linked by rewriting the index and
 * renaming the blob directory). */
export async function migrateRevisionPath(root: string, from: string, to: string): Promise<void> {
  try {
    await serialized(async () => {
      const index = await readIndex();
      const rootIdx = index.roots[root];
      const list = rootIdx?.[from];
      if (!rootIdx || !list || list.length === 0) return;
      const fromDir = blobDir(root, from);
      const toDir = blobDir(root, to);
      try {
        await fs.rename(fromDir, toDir);
      } catch {
        /* dir absent or raced — the index rewrite below stays consistent
         * (entries without blobs restore-refuse honestly) */
      }
      rootIdx[to] = list;
      delete rootIdx[from];
      await writeIndex(index);
    });
  } catch {
    /* best-effort by contract */
  }
}

/** Called by care-vault.writeNote BEFORE overwriting an existing note:
 * archives the content that is about to disappear and returns the entry
 * (so restoreRevision can name the shield it created). Best-effort — a
 * snapshot failure must never fail the user's write (the write is the
 * user's intent; the archive is our courtesy). Errors are swallowed by
 * design and the caller proceeds. `reason` lets restoreRevision label
 * its own pre-restore archive honestly ('restore-shield' vs the plain
 * 'overwrite' the write path produces). */
export async function snapshotBeforeOverwrite(
  root: string,
  rel: string,
  reason: RevisionReason = 'overwrite',
): Promise<RevisionEntry | null> {
  try {
    const abs = await safeResolve(root, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile() || st.size === 0 || st.size > SNAPSHOT_CAP_BYTES) return null;
    const content = await fs.readFile(abs, 'utf8');
    return await serialized(() => storeRevision(root, rel, content, 'app', reason));
  } catch {
    return null; /* best-effort by contract — see block comment */
  }
}

/** Called by the watcher (vault.ts diffOnce) for 'changed' events: the
 * watcher can only ever see content AFTER an external save, so the
 * archived revision IS the new state as first observed (documented
 * honestly in the history listing). Suppressed for our own writes;
 * throttled per path. Never throws. */
export async function observeExternalChange(root: string, rel: string): Promise<void> {
  try {
    const abs = await safeResolve(root, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile() || !/\.(md|markdown)$/i.test(rel)) return;
    /* isSuppressedAppWriteSync is SYNC by design (see block comment) —
     * keep it that way; an async version here invites unawaited-Promise
     * truthiness bugs (QA-caught once already). */
    if (isSuppressedAppWriteSync(rel, st.size)) return;
    const throttled = await serialized(async () => {
      const index = await readIndex();
      const list = index.roots[root]?.[rel];
      if (!list || list.length === 0) return false;
      const newest = list[list.length - 1];
      return newest.kind === 'observed' && Date.now() - newest.ts < OBSERVE_THROTTLE_MS;
    });
    if (throttled) return;
    const content = await fs.readFile(abs, 'utf8');
    await serialized(() => storeRevision(root, rel, content, 'observed', 'external-change'));
  } catch {
    /* observation is best-effort — the watcher's events remain the
     * source of truth regardless */
  }
}

/* ── Listing / restore / erase ──────────────────────────────────────── */

export interface RevisionPathSummary {
  rel: string;
  count: number;
  latestTs: number;
  latestKind: RevisionKind;
}

/** No rel → per-path summary for this root (newest activity first). */
export async function listRevisionPaths(root: string): Promise<{ paths: RevisionPathSummary[] }> {
  const index = await readIndex();
  const rootIdx = index.roots[root] ?? {};
  const paths: RevisionPathSummary[] = Object.entries(rootIdx)
    .filter(([, list]) => list.length > 0)
    .map(([rel, list]) => {
      const newest = list[list.length - 1];
      return { rel, count: list.length, latestTs: newest.ts, latestKind: newest.kind };
    })
    .sort((a, b) => b.latestTs - a.latestTs)
    .slice(0, 200);
  return { paths };
}

/** With rel → the full entry list for one path, newest first. The rel is
 * jailed (safeResolve) even though we only consult metadata — a hostile
 * rel must fail with the SAME refusal the reader gives, not a quiet
 * "no revisions". Each entry carries its line delta vs the previous
 * chronological revision (same LCS as the diff view — the listing's
 * numbers never disagree with the diff). */
export async function listRevisions(root: string, rel: string): Promise<{ rel: string; entries: RevisionEntry[] }> {
  if (typeof rel !== 'string' || !rel.trim()) throw new VaultPathError('missing note path');
  if (rel.split('/').some((seg) => seg.startsWith('.') && seg !== '..')) {
    throw new VaultPathError('hidden files stay out of the vault reader');
  }
  await safeResolve(root, rel); // jail probe — throws VaultPathError on escape
  const index = await readIndex();
  const list = index.roots[root]?.[rel] ?? [];
  const entries: RevisionEntry[] = [...list].reverse(); // newest first — upstream's sort
  // Line deltas: chronological neighbor pair (j-1 → j). Reads stay
  // bounded (≤KEEP_LAST small blobs; the DP itself is cell-capped).
  for (let j = 0; j < list.length; j++) {
    const entry = list[j];
    const idxInNewestFirst = list.length - 1 - j;
    if (j === 0) continue; // oldest — nothing to compare against
    try {
      const prev = await readRevisionContent(root, rel, list[j - 1].id);
      const cur = await readRevisionContent(root, rel, entry.id);
      if (prev !== null && cur !== null) entries[idxInNewestFirst].delta = diffStatsOf(prev, cur);
    } catch {
      /* blob missing (erased) — delta stays absent, honestly */
    }
  }
  return { rel, entries };
}

export interface RestoreResult {
  rel: string;
  restoredId: string;
  restoredSize: number;
  /** The pre-restore content was snapshotted under this id — restoring
   * IT undoes the restore (upstream's reversible-restore semantics). */
  shieldId: string | null;
}

/** Restore revision `id` of `rel`: write its blob back into the vault.
 * The CURRENT content is archived first ('restore-shield'), so the
 * operation is reversible by construction. The caller (route) enforces
 * the designated-vault gate — this is a WRITE into the vault and follows
 * the same discipline as every other write verb. */
export async function restoreRevision(root: string, rel: string, id: string): Promise<RestoreResult> {
  if (typeof rel !== 'string' || !rel.trim()) throw new VaultPathError('missing note path');
  if (typeof id !== 'string' || !/^[\d]+-\d{3}$/.test(id)) throw new VaultPathError('unknown revision id');
  const abs = await safeResolve(root, rel);
  const blobPath = path.join(blobDir(root, rel), `${id}.md`);
  const content = await fs.readFile(blobPath, 'utf8').catch(() => null);
  if (content === null) throw new VaultPathError('no such revision (erased, or from another vault)');
  // Reversible by construction: shield the present before resurrecting the past.
  const shield = await snapshotBeforeOverwrite(root, rel, 'restore-shield');
  markAppWriteSync(rel, Buffer.byteLength(content, 'utf8')); // suppress BEFORE the bytes land (race, see markAppWriteSync)
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const body = Buffer.from(content, 'utf8');
  await fs.writeFile(abs, body);
  markAppWriteSync(rel, body.length); // refresh the window post-write
  return { rel, restoredId: id, restoredSize: body.length, shieldId: shield?.id ?? null };
}

/** Erase one revision (id) or all revisions of a path ('all' / empty
 * id). Metadata + blob hygiene on Naksha's own store — the vault file
 * itself is never touched by an erase. */
export async function eraseRevisions(
  root: string,
  rel: string,
  which: 'all' | string,
): Promise<{ erased: number }> {
  if (typeof rel !== 'string' || !rel.trim()) throw new VaultPathError('missing note path');
  const abs = await safeResolve(root, rel); // jail probe
  void abs;
  return serialized(async () => {
    const index = await readIndex();
    const rootIdx = index.roots[root];
    const list = rootIdx?.[rel];
    if (!rootIdx || !list || list.length === 0) return { erased: 0 };
    const dir = blobDir(root, rel);
    let erased = 0;
    if (which === 'all') {
      await Promise.all(list.map((e) => fs.rm(path.join(dir, `${e.id}.md`), { force: true }).catch(() => {})));
      erased = list.length;
      delete rootIdx[rel];
    } else {
      if (!/^[\d]+-\d{3}$/.test(which)) throw new VaultPathError('unknown revision id');
      const at = list.findIndex((e) => e.id === which);
      if (at === -1) throw new VaultPathError('no such revision (erased, or from another vault)');
      await fs.rm(path.join(dir, `${which}.md`), { force: true }).catch(() => {});
      list.splice(at, 1);
      erased = 1;
      if (list.length === 0) delete rootIdx[rel];
    }
    await writeIndex(index);
    return { erased };
  });
}

/* ── Content + diff (T7 round 4 — Trilium's revision-diff view) ─────── */

/** Read one archived revision's content. Jailed like every other
 * accessor; null = the blob is gone (erased, or another vault's id) —
 * callers surface that as an honest refusal, never a silent empty. */
export async function readRevisionContent(root: string, rel: string, id: string): Promise<string | null> {
  if (typeof rel !== 'string' || !rel.trim()) throw new VaultPathError('missing note path');
  if (!/^[\d]+-\d{3}$/.test(id ?? '')) throw new VaultPathError('unknown revision id');
  await safeResolve(root, rel); // jail probe
  const blobPath = path.join(blobDir(root, rel), `${id}.md`);
  return fs.readFile(blobPath, 'utf8').catch(() => null);
}

export interface RevisionDiff {
  rel: string;
  /** null id = the live file. */
  a: { id: string | null; label: string };
  b: { id: string | null; label: string };
  lines: DiffLine[];
  stats: DiffStats;
}

function revisionLabel(id: string | null, ts: number | null): string {
  return id === null
    ? 'live file'
    : `revision ${id}${ts ? ` (${new Date(ts).toLocaleTimeString()})` : ''}`;
}

/**
 * Line diff between two points of a path's history. Argument forms:
 *   (rel)                    → newest revision  → live file
 *   (rel, aId)               → revision aId     → live file
 *   (rel, aId, bId)          → revision aId     → revision bId
 * Direction: '+' lines exist in b but not a; '−' lines in a but not b.
 * The rel is jailed; unknown ids refuse loudly (VaultPathError).
 */
export async function diffRevisions(root: string, rel: string, aId?: string, bId?: string): Promise<RevisionDiff> {
  if (typeof rel !== 'string' || !rel.trim()) throw new VaultPathError('missing note path');
  await safeResolve(root, rel); // jail probe — traversal refuses loudly
  const index = await readIndex();
  const list = index.roots[root]?.[rel] ?? [];

  const resolveSide = async (
    id: string | undefined,
    which: 'a' | 'b',
  ): Promise<{ id: string | null; label: string; content: string }> => {
    if (id === undefined || id === null || id === '') {
      // live side
      const abs = await safeResolve(root, rel);
      const st = await fs.stat(abs).catch(() => null);
      if (!st?.isFile()) {
        return { id: null, label: 'live file (absent)', content: '' };
      }
      return { id: null, label: 'live file', content: await fs.readFile(abs, 'utf8') };
    }
    if (!/^[\d]+-\d{3}$/.test(id)) throw new VaultPathError(`unknown revision id: ${id}`);
    const meta = list.find((e) => e.id === id);
    const content = await readRevisionContent(root, rel, id);
    if (content === null) {
      throw new VaultPathError(`no such revision: ${id} (erased, or from another vault)`);
    }
    void which;
    return { id, label: revisionLabel(id, meta?.ts ?? null), content };
  };

  const aSpec = await resolveSide(aId, 'a');
  const bSpec = await resolveSide(bId, 'b');
  const lines = diffLines(aSpec.content, bSpec.content);
  const stats = diffStatsOf(aSpec.content, bSpec.content);
  return {
    rel,
    a: { id: aSpec.id, label: aSpec.label },
    b: { id: bSpec.id, label: bSpec.label },
    lines,
    stats,
  };
}
