/**
 * Naksha — Server-side Vault manager (Phase 2)
 *
 * The REAL filesystem bridge behind the Obsidian-like read-only reader.
 * A vault is ONE real directory the user explicitly connected. Everything
 * here runs server-side (Node) — the browser never touches paths directly;
 * it speaks to the /api/vault/* routes which delegate to this module.
 *
 * READ-ONLY BY CONSTRUCTION: this module exposes no write primitives at
 * all. Phase 2's acceptance ("Reader UI cannot write to the connected
 * directory") is enforced here first — even a hostile client cannot make
 * these routes write, because no such capability exists server-side.
 * (Phase 5 will add a narrowly-scoped, separately-gated write path for a
 * designated CareSpace vault; it will NOT live in this module.)
 *
 * Path safety (Phase 7 rules, implemented up front):
 *  - `safeResolve` normalizes the relative path and rejects any result
 *    that escapes the configured root (including `..` chains and
 *    absolute-path smuggling), then verifies containment again through
 *    realpath so an on-disk symlink can't hop outside the vault.
 *
 * External-change detection: a change watcher that combines
 *  1. fs.watch on the root + first-level subdirectories (instant events
 *     where the platform supports them — best-effort, never fatal), and
 *  2. a 4s mtime/size snapshot poller that is the source of truth
 *     (portable, catches nano-style saves in any depth).
 * Events are fanned out to SSE clients (/api/vault/events) and kept in a
 * small ring for the manual-refresh receipt. The poller only runs while
 * at least one SSE client is connected — zero idle cost.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

/* ── Vault configuration persistence ─────────────────────────────────
 * One JSON file inside the runtime db/ folder. Deliberately NOT in
 * localStorage: the config describes a SERVER-side resource and must be
 * readable before/independent of any browser profile. */

export interface VaultConfig {
  root: string; // absolute path
  name: string; // display name (basename)
  connectedAt: number;
}

const CONFIG_PATH = path.join(process.cwd(), 'db', 'vault.json');

export async function readConfig(): Promise<VaultConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw) as VaultConfig;
    if (cfg && typeof cfg.root === 'string' && cfg.root.startsWith('/')) return cfg;
    return null;
  } catch {
    return null;
  }
}

export async function writeConfig(cfg: VaultConfig | null): Promise<void> {
  if (!cfg) {
    await fs.rm(CONFIG_PATH, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

/* ── Path safety ──────────────────────────────────────────────────── */

export class VaultPathError extends Error {}

/** Segments that start with a dot never enter the vault reader — the
 *  reader never lists them (listDir) and never reads them (readFile).
 *  One shared rule, one shared message (Phase 7: consistent refusals).
 *  `..` segments are NOT claimed here: they belong to safeResolve, whose
 *  "path escapes" message is the honest reason for a traversal attempt. */
export const HIDDEN_REFUSAL = 'hidden files stay out of the vault reader';

function assertNoHiddenSegments(rel: string): void {
  if (rel.split('/').some((seg) => seg.startsWith('.') && seg !== '..')) {
    throw new VaultPathError(HIDDEN_REFUSAL);
  }
}

/**
 * Validate a user-supplied root for CONNECTING (Phase 7): must be an
 * absolute path, must not be the filesystem root itself (turning `/`
 * into a vault — and worse, a designated-writable one — is never a
 * legitimate move; every real vault is a subdirectory). Returns the
 * resolved absolute path or throws VaultPathError with a clear reason.
 */
export function validateVaultRoot(input: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new VaultPathError('path required');
  }
  if (!input.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(input)) {
    throw new VaultPathError('path must be ABSOLUTE (e.g. /home/you/vault)');
  }
  const root = path.resolve(input);
  if (root === path.parse(root).root) {
    throw new VaultPathError('refusing to connect the filesystem root — connect a subdirectory');
  }
  return root;
}

/**
 * Live watcher state for `vault doctor` / status: honest numbers about
 * the change-detection machinery (it idles to zero cost when no SSE
 * client is listening — doctor says exactly that).
 */
export function watcherInfo(): {
  armed: boolean;
  clients: number;
  snapshotEntries: number;
  lastEventAt: number | null;
} {
  return {
    armed: W.pollTimer !== null || W.accelWatchers.length > 0,
    clients: W.clients.size,
    snapshotEntries: W.snapshot.size,
    lastEventAt: W.lastEvents.length ? W.lastEvents[W.lastEvents.length - 1].ts : null,
  };
}

/**
 * Resolve `rel` inside `root`, refusing anything that escapes it.
 * Returns the absolute path or throws VaultPathError.
 */

/* Phase 8 run — REAL PERF BUG (found when the connected root was /home
 * and every status/tree call rendered in 18-29s): safeResolve re-ran
 * fs.realpath(root) on EVERY call, and the walks (buildIndex,
 * takeSnapshot, walkTree) call listDir → safeResolve per directory —
 * thousands of realpath syscalls per request on a FUSE-backed FS. The
 * root's REAL location only changes if the vault itself is
 * renamed/remounted, so a short-TTL cache keyed by the root path keeps
 * the jail exactly as strong (a moved vault re-resolves within seconds)
 * while making deep walks ~50× cheaper. The per-request TOCTOU window
 * documented in Phase 7 is unchanged in spirit: it now names 2s, not
 * per-call. */
const REAL_ROOT_TTL_MS = 2000;
const realRootCache = new Map<string, { real: string; at: number }>();

async function realRootCached(root: string): Promise<string> {
  const hit = realRootCache.get(root);
  if (hit && Date.now() - hit.at < REAL_ROOT_TTL_MS) return hit.real;
  const real = await fs.realpath(root);
  realRootCache.set(root, { real, at: Date.now() });
  /* Bound the cache (roots are few, but a long session can connect many). */
  if (realRootCache.size > 16) {
    const oldest = realRootCache.keys().next().value;
    if (oldest !== undefined) realRootCache.delete(oldest);
  }
  return real;
}

export async function safeResolve(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string') throw new VaultPathError('invalid path');
  // Null bytes are never legitimate in filesystem paths.
  if (rel.includes('\0')) throw new VaultPathError('invalid path');
  // A rel that begins with `-` reads as an OPTION in spawned-command
  // contexts; the reader treats it as the filename it is, but refusing
  // here keeps every surface's dialect identical (Phase 7 consistency).
  if (rel.trimStart().startsWith('-')) {
    throw new VaultPathError("path looks like an option — leading '-' is refused");
  }
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new VaultPathError('path escapes the connected directory');
  }
  // Symlink containment: the REAL location of the target (or its nearest
  // existing ancestor) must stay inside the vault's real root.
  try {
    const realRoot = await realRootCached(root);
    let probe = abs;
    for (let i = 0; i < 8; i++) {
      try {
        const real = await fs.realpath(probe);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          throw new VaultPathError('path escapes the connected directory');
        }
        return abs; // real target contained
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          const parent = path.dirname(probe);
          if (parent === probe) break;
          probe = parent; // target itself may not exist yet; check ancestor
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof VaultPathError) throw err;
    // realpath on root failed — the vault itself vanished; callers report it.
  }
  return abs;
}

/* ── FS operations (read-only) ─────────────────────────────────────── */

const READ_CAP_BYTES = 2 * 1024 * 1024; // 2MB per file
const LIST_CAP = 1000;
const TREE_CAP = 400;
const INDEX_CAP = 4000;

export interface VaultEntry {
  name: string;
  rel: string;
  type: 'dir' | 'file';
  size: number;
  mtimeMs: number;
  /* v138 T7 round 5 — birthtime from the SAME lstat call (free):
   * note.dateCreated for the Trilium-style search dialect. */
  birthtimeMs: number;
  ext: string;
}

export async function listDir(root: string, rel: string): Promise<VaultEntry[]> {
  // Explicit probes of dot paths refuse with the shared message —
  // listing never shows hidden entries anyway (Phase 7 consistency).
  if (rel) assertNoHiddenSegments(rel);
  const abs = await safeResolve(root, rel);
  const st = await fs.stat(abs).catch(() => null);
  if (!st) throw new VaultPathError('no such file or directory');
  if (!st.isDirectory()) throw new VaultPathError('not a directory');
  const names = (await fs.readdir(abs)).slice(0, LIST_CAP);
  const entries: VaultEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue; // hidden files stay out of the reader
    const childAbs = path.join(abs, name);
    const cst = await fs.lstat(childAbs).catch(() => null);
    if (!cst) continue;
    entries.push({
      name,
      rel: rel ? `${rel}/${name}` : name,
      type: cst.isDirectory() ? 'dir' : 'file',
      size: cst.size,
      mtimeMs: cst.mtimeMs,
      birthtimeMs: cst.birthtimeMs,
      ext: path.extname(name).slice(1).toLowerCase(),
    });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
  }
  return false;
}

export interface VaultReadResult {
  content: string;
  rel: string;
  size: number;
  mtimeMs: number;
}

export async function readFile(root: string, rel: string): Promise<VaultReadResult> {
  // Direct reads of dotfiles refuse — same dialect as listDir, the
  // care-vault writer and the nano jail (Phase 7 consistency).
  assertNoHiddenSegments(rel);
  const abs = await safeResolve(root, rel);
  const st = await fs.stat(abs).catch(() => null);
  if (!st) throw new VaultPathError('no such file');
  if (st.isDirectory()) throw new VaultPathError('is a directory');
  if (st.size > READ_CAP_BYTES) {
    throw new VaultPathError(
      `file exceeds the ${Math.round(READ_CAP_BYTES / 1048576)}MB reader cap (${st.size} bytes)`,
    );
  }
  const fh = await fs.open(abs, 'r');
  try {
    const head = Buffer.alloc(Math.min(st.size, 4096));
    await fh.read(head, 0, head.length, 0);
    if (looksBinary(head)) throw new VaultPathError('binary file — the reader shows text only');
    const buf = Buffer.alloc(st.size);
    await fh.read(buf, 0, buf.length, 0);
    return { content: buf.toString('utf8'), rel, size: st.size, mtimeMs: st.mtimeMs };
  } finally {
    await fh.close();
  }
}

export interface VaultTreeEntry {
  rel: string;
  name: string;
  isDir: boolean;
  depth: number;
}

export async function walkTree(
  root: string,
  rel: string,
  maxEntries = TREE_CAP,
): Promise<VaultTreeEntry[]> {
  const out: VaultTreeEntry[] = [];
  /* Phase 7: the REQUESTED path is validated up front — a traversal,
   * hidden or non-directory probe refuses loudly (VaultPathError → the
   * route answers 400). Without this, the per-directory catch below
   * degraded an outside path into a silent ok:true / 0-entries walk —
   * a dishonest answer the probe suite caught. */
  if (rel) assertNoHiddenSegments(rel);
  const topAbs = await safeResolve(root, rel);
  const topSt = await fs.stat(topAbs).catch(() => null);
  if (!topSt) throw new VaultPathError('no such file or directory');
  if (!topSt.isDirectory()) throw new VaultPathError('not a directory');
  const walk = async (dirRel: string, depth: number): Promise<void> => {
    if (out.length >= maxEntries) return;
    let entries: VaultEntry[];
    try {
      entries = await listDir(root, dirRel);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      out.push({ rel: e.rel, name: e.name, isDir: e.type === 'dir', depth });
      if (e.type === 'dir') await walk(e.rel, depth + 1);
    }
  };
  await walk(rel, 0);
  return out;
}

/* ── Title index (wikilink resolution) ─────────────────────────────── */

export interface VaultIndex {
  files: string[];
  builtAt: number;
}

export async function buildIndex(root: string): Promise<VaultIndex> {
  const files: string[] = [];
  const walk = async (dirRel: string): Promise<void> => {
    if (files.length >= INDEX_CAP) return;
    let entries: VaultEntry[];
    try {
      entries = await listDir(root, dirRel);
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= INDEX_CAP) return;
      if (e.type === 'dir') await walk(e.rel);
      else if (['md', 'markdown', 'txt', 'rst'].includes(e.ext)) files.push(e.rel);
    }
  };
  await walk('');
  return { files, builtAt: Date.now() };
}

/* ── Task 120 — count cache: the walk left the request path entirely ──
 * Cycle 11's /home incident was the failure mode: a big root re-walked
 * on every stale status poll rendered /api/vault/status at 14–20s and
 * the churn OOM-killed the dev server. Counts are advisory chrome, so
 * they now serve LAST-KNOWN values instantly (even stale), refresh in
 * the background, and share ONE in-flight walk no matter how many
 * panels poll. Keyed by root — a vault swap reads as a miss and
 * re-arms. Lives here (not in the status route) so connect and status
 * share the same cache in one server process. */
const COUNT_TTL_MS = 10_000;
let countCache: { root: string; mdCount: number; fileCount: number; at: number } | null = null;
let countInflight: Promise<void> | null = null;

/** Fire-and-forget index walk; concurrent callers share the one walk. */
export function refreshCountsInBackground(root: string): void {
  if (countInflight) return;
  countInflight = buildIndex(root)
    .then((index) => {
      countCache = {
        root,
        mdCount: index.files.filter((f) => /\.md$|\.markdown$/i.test(f)).length,
        fileCount: index.files.length,
        at: Date.now(),
      };
    })
    .catch(() => {
      /* counts stay at last-known/0 — availability already reports truth */
    })
    .finally(() => {
      countInflight = null;
    });
}

/** Last-known counts for a root (never blocks, never walks). Stale data
 * is served as-is; freshness is the caller's concern (compare at/TTL). */
export function getCachedCounts(root: string): { mdCount: number; fileCount: number; at: number } | null {
  return countCache && countCache.root === root
    ? { mdCount: countCache.mdCount, fileCount: countCache.fileCount, at: countCache.at }
    : null;
}

/** Task 120 — immediate honest counts from the watcher's OWN snapshot
 * (startWatching walked the whole tree at connect/re-arm; deriving two
 * numbers from that Map is free). Same extension filter as buildIndex,
 * so the receipt after `vault connect` shows real counts on its very
 * first status read instead of racing the background walk. The canonical
 * buildIndex warm still follows in the background (caps can differ). */
export function warmCountsFromSnapshot(): void {
  const cfg = W.config;
  const snap = W.snapshot;
  if (!cfg || !snap) return;
  let mdCount = 0;
  let fileCount = 0;
  for (const rel of snap.keys()) {
    if (/\.(md|markdown|txt|rst)$/i.test(rel)) {
      fileCount++;
      if (/\.md$|\.markdown$/i.test(rel)) mdCount++;
    }
  }
  countCache = { root: cfg.root, mdCount, fileCount, at: Date.now() };
}

export const COUNT_TTL = COUNT_TTL_MS;

/**
 * Resolve an Obsidian-style link to a real file inside the vault.
 * `[[Folder/Note]]` and `[[Note Name]]` match by path-without-extension
 * or by basename; `q` may also be a direct relative path to a file.
 * Returns the winning rel path (shortest = best match) or null.
 */
export async function resolveLink(
  root: string,
  q: string,
  index?: VaultIndex,
): Promise<string | null> {
  const query = q.trim().replace(/^\.?\//, '');
  if (!query) return null;
  const idx = index ?? (await buildIndex(root));
  const lower = query.toLowerCase();
  // 1. Direct relative path hit.
  if (idx.files.includes(query)) return query;
  // 2. Path-without-extension match (covers Folder/Note).
  const byPath = idx.files.find(
    (f) =>
      f.toLowerCase() === lower ||
      f.replace(/\.(md|markdown|txt|rst)$/i, '').toLowerCase() === lower,
  );
  if (byPath) return byPath;
  // 3. Basename match (covers [[Note Name]] from anywhere); ties → shallowest path.
  const base = lower.split('/').pop() ?? lower;
  const candidates = idx.files.filter((f) => {
    const fb = f.split('/').pop() ?? f;
    return (
      fb.toLowerCase() === base ||
      fb.replace(/\.(md|markdown|txt|rst)$/i, '').toLowerCase() === base
    );
  });
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
    return candidates[0];
  }
  return null;
}

/* ── Naksha-backed file inventory (v138 T7 — the TriliumNext
 *    consistency-check port) ──────────────────────────────────────────
 * Ported pattern: TriliumNext/Notes runs services/consistency_checks.ts
 * at startup + hourly, finding orphaned notes, invalid parent references
 * and broken branches so they can be reported (and safely repaired)
 * before they confuse anyone. Study source (owner's golden reference):
 * https://deepwiki.com/TriliumNext/Notes — "Data Model and Persistence /
 * Entity Changes".
 *
 * Naksha's vault is a real directory bridged by METADATA only
 * (CareNode.vaultPath bindings + workspace shape records), so the same
 * failure class exists in a file-shaped form:
 *  - a file renamed/deleted OUTSIDE the app leaves a broken binding;
 *  - a node/shape deleted IN the app leaves its file orphaned on disk
 *    (by design — the vault writer has no delete).
 * `findNakshaFiles` is the honest, budget-capped read that powers
 * `vault check`: inventory every .md whose FRONTMATTER carries Naksha
 * markers (care notes: `naksha-node:` · shape records: `naksha: shape`)
 * by reading a small head per file (1KB, see NAKSHA_HEAD_BYTES) — never a
 * whole file, never a
 * write. Same walk discipline as buildIndex (listDir hides dotfiles,
 * safeResolve jails every step, hard cap keeps big roots bounded). */
export interface NakshaFileInfo {
  rel: string;
  kind: 'node' | 'shape';
  id: string;
  /** Vault shape tombstone (`deleted: yes` — no delete route exists;
   * restore skips these). Care notes are never tombstones. */
  tombstone: boolean;
}

const NAKSHA_SCAN_CAP = 800;
/* 1024-byte head: the frontmatter must fit ENTIRELY in the head for the
 * tombstone probe to see `deleted: yes` (it sits at the block's END, after
 * coords/board — QA-caught: a 256-byte head once missed it on a 3-point
 * shape whose rgba color line pushed the flag past byte 256). 1024 covers
 * hand-drawn shapes (~13 bytes/point for coords) with wide margin. */
const NAKSHA_HEAD_BYTES = 1024;

export async function findNakshaFiles(
  root: string,
): Promise<{ files: NakshaFileInfo[]; scanned: number; truncated: boolean }> {
  const files: NakshaFileInfo[] = [];
  let scanned = 0;
  let truncated = false;
  const walk = async (dirRel: string): Promise<void> => {
    if (scanned >= NAKSHA_SCAN_CAP) {
      truncated = true;
      return;
    }
    let entries: VaultEntry[];
    try {
      entries = await listDir(root, dirRel);
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned >= NAKSHA_SCAN_CAP) {
        truncated = true;
        return;
      }
      if (e.type === 'dir') {
        await walk(e.rel);
        continue;
      }
      if (!/\.(md|markdown)$/i.test(e.name)) continue;
      scanned++;
      const abs = await safeResolve(root, e.rel);
      let head = '';
      try {
        const fh = await fs.open(abs, 'r');
        try {
          const len = Math.min(NAKSHA_HEAD_BYTES, Math.max(0, e.size));
          const buf = Buffer.alloc(len);
          if (len > 0) await fh.read(buf, 0, len, 0);
          head = buf.toString('utf8');
        } finally {
          await fh.close();
        }
      } catch {
        continue; // unreadable file — counted as scanned, skipped honestly
      }
      if (!head.startsWith('---')) continue; // no frontmatter → not ours
      const nodeM = head.match(/^naksha-node:\s*(\S+)/m);
      if (nodeM) {
        files.push({ rel: e.rel, kind: 'node', id: nodeM[1], tombstone: false });
        continue;
      }
      if (/^naksha:[ \t]*shape[ \t]*$/m.test(head)) {
        const idM = head.match(/^id:[ \t]*"?([^"\n]*)"?[ \t]*$/m);
        files.push({
          rel: e.rel,
          kind: 'shape',
          id: idM?.[1]?.trim() ?? '',
          tombstone: /^deleted:[ \t]*yes[ \t]*$/m.test(head),
        });
      }
    }
  };
  await walk('');
  return { files, scanned, truncated };
}

/* ── Recent changes (v138 T7 round 2 — the TriliumNext port, part 2) ──
 *
 * Ported from Trilium's routes/api/recent_changes.ts (TriliumNext/Notes,
 * develop branch, studied via https://deepwiki.com/TriliumNext/Notes —
 * Attribution: upstream getRecentChanges). The battle-tested shape of the
 * pattern: collect change points from every source → sort by UTC date
 * descending → cap the list (500 there) → surface DELETIONS visibly
 * (deleted notes appear with canBeUndeleted) so nothing disappears
 * silently. Trilium's sources are the revisions table + creation +
 * deletion timestamps; a file-backed vault has exactly one honest source
 * — the filesystem's own mtime — and "deletion" is our tombstone
 * dialect (`deleted: yes`), which shows up muted, same spirit.
 *
 * Budget discipline (same as findNakshaFiles): walk with the reader's own
 * machinery (listDir hides dotfiles, safeResolve jails every step,
 * NAKSHA_SCAN_CAP bounds the walk). The 1KB head-read happens ONLY for
 * the returned window (≤ limit files) AFTER mtime sorting — so a 800-file
 * vault costs 800 directory stats + ≤100 small head reads, never 800
 * file reads. */
export interface VaultRecentChange {
  rel: string;
  mtimeMs: number;
  size: number;
  /** Naksha frontmatter classification: `node` (care note), `shape`
   * (workspace shape record), or `none` (plain markdown). */
  kind: 'node' | 'shape' | 'none';
  /** Shape tombstone (`deleted: yes`) — shown muted, restorable via
   * workspace Restore MD. Never true for kind !== 'shape'. */
  tombstone: boolean;
  /** Shape records carry their display name in the head — surfaced so
   * the terminal can label the row like the app does. */
  name?: string;
}

export async function listRecentChanges(
  root: string,
  opts?: { limit?: number; dir?: string },
): Promise<{ changes: VaultRecentChange[]; scanned: number; truncated: boolean }> {
  const limit = Math.max(1, Math.min(100, Math.floor(opts?.limit ?? 20)));
  const startDir = opts?.dir ?? '';
  /* The REQUESTED path is validated up front — traversal, hidden or
   * non-directory probes refuse loudly (VaultPathError → route 400).
   * Without this, the per-directory catch below would degrade an outside
   * path into a silent ok / 0-changes answer — the same dishonest-answer
   * class walkTree's probe suite already caught once (see walkTree). */
  if (startDir) assertNoHiddenSegments(startDir);
  const startAbs = await safeResolve(root, startDir);
  const startSt = await fs.stat(startAbs).catch(() => null);
  if (!startSt) throw new VaultPathError('no such file or directory');
  if (!startSt.isDirectory()) throw new VaultPathError('not a directory');
  const found: Array<{ rel: string; mtimeMs: number; size: number }> = [];
  let scanned = 0;
  let truncated = false;
  const walk = async (dirRel: string): Promise<void> => {
    if (scanned >= NAKSHA_SCAN_CAP) {
      truncated = true;
      return;
    }
    let entries: VaultEntry[];
    try {
      entries = await listDir(root, dirRel);
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned >= NAKSHA_SCAN_CAP) {
        truncated = true;
        return;
      }
      if (e.type === 'dir') {
        await walk(e.rel);
        continue;
      }
      if (!/\.(md|markdown)$/i.test(e.name)) continue;
      scanned++;
      found.push({ rel: e.rel, mtimeMs: e.mtimeMs, size: e.size });
    }
  };
  await walk(startDir);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first — upstream's sort step
  const window = found.slice(0, Math.min(limit, found.length));
  const changes: VaultRecentChange[] = [];
  for (const f of window) {
    const change: VaultRecentChange = { rel: f.rel, mtimeMs: f.mtimeMs, size: f.size, kind: 'none', tombstone: false };
    // Head classification is deferred to the visible window (see block
    // comment): kind + tombstone + shape name from the same 1KB head that
    // findNakshaFiles reads — never a whole-file read.
    try {
      const abs = await safeResolve(root, f.rel);
      const fh = await fs.open(abs, 'r');
      try {
        const len = Math.min(NAKSHA_HEAD_BYTES, Math.max(0, f.size));
        const buf = Buffer.alloc(len);
        if (len > 0) await fh.read(buf, 0, len, 0);
        const head = buf.toString('utf8');
        if (head.startsWith('---')) {
          const nodeM = head.match(/^naksha-node:\s*(\S+)/m);
          if (nodeM) {
            change.kind = 'node';
          } else if (/^naksha:[ \t]*shape[ \t]*$/m.test(head)) {
            change.kind = 'shape';
            change.tombstone = /^deleted:[ \t]*yes[ \t]*$/m.test(head);
            const nameM = head.match(/^name:[ \t]*"?([^"\n]*)"?[ \t]*$/m);
            const name = nameM?.[1]?.trim();
            if (name) change.name = name;
          }
        }
      } finally {
        await fh.close();
      }
    } catch {
      // Unreadable since the walk (deleted mid-request, permission) — the
      // row still shows (the mtime was real), just unclassified. Honest.
    }
    changes.push(change);
  }
  return { changes, scanned, truncated };
}

/* ── Naksha head classification (shared dialect, v138 T7 round 5) ──────
 * The exact 1KB-head classifier listRecentChanges uses inline (see its
 * window loop), exported so the Trilium-style search surface
 * (lib/server/vault-search.ts) labels its match rows with the SAME
 * glyphs the recent list shows (● note · ◆ shape · · plain · †
 * tombstone). recent keeps its inline copy this round — dedup candidate
 * for a review pass; the dialect itself must never drift, so any change
 * here is a change to BOTH call sites. */
export interface VaultHeadClass {
  kind: 'node' | 'shape' | 'none';
  tombstone: boolean;
  name?: string;
}

export async function classifyVaultHead(root: string, rel: string, size: number): Promise<VaultHeadClass> {
  const cls: VaultHeadClass = { kind: 'none', tombstone: false };
  try {
    const abs = await safeResolve(root, rel);
    const fh = await fs.open(abs, 'r');
    try {
      const len = Math.min(NAKSHA_HEAD_BYTES, Math.max(0, size));
      const buf = Buffer.alloc(len);
      if (len > 0) await fh.read(buf, 0, len, 0);
      const head = buf.toString('utf8');
      if (head.startsWith('---')) {
        const nodeM = head.match(/^naksha-node:\s*(\S+)/m);
        if (nodeM) {
          cls.kind = 'node';
        } else if (/^naksha:[ \t]*shape[ \t]*$/m.test(head)) {
          cls.kind = 'shape';
          cls.tombstone = /^deleted:[ \t]*yes[ \t]*$/m.test(head);
          const nameM = head.match(/^name:[ \t]*"?([^"\n]*)"?[ \t]*$/m);
          const name = nameM?.[1]?.trim();
          if (name) cls.name = name;
        }
      }
    } finally {
      await fh.close();
    }
  } catch {
    // Unreadable since the walk (deleted mid-request, permission) — the
    // row still shows (the mtime was real), just unclassified. Honest.
  }
  return cls;
}

/* ── Change watcher (poller = source of truth; fs.watch = accelerator) ── */

export interface VaultChangeEvent {
  path: string; // rel ("" = the vault root itself)
  kind: 'changed' | 'added' | 'removed';
  ts: number;
}

type Client = (event: VaultChangeEvent | { kind: 'hello'; path: string; ts: number }) => void;

interface WatcherState {
  config: VaultConfig | null;
  clients: Set<Client>;
  snapshot: Map<string, { mtimeMs: number; size: number }>;
  lastEvents: VaultChangeEvent[];
  pollTimer: NodeJS.Timeout | null;
  nudgeTimer: NodeJS.Timeout | null;
  accelWatchers: fsSync.FSWatcher[];
  dirty: boolean;
}

const W: WatcherState = {
  config: null,
  clients: new Set(),
  snapshot: new Map(),
  lastEvents: [],
  pollTimer: null,
  nudgeTimer: null,
  accelWatchers: [],
  dirty: false,
};

const POLL_MS = 4000;
const EVENT_RING = 30;

async function takeSnapshot(
  root: string,
): Promise<Map<string, { mtimeMs: number; size: number }>> {
  const snap = new Map<string, { mtimeMs: number; size: number }>();
  let budget = INDEX_CAP * 2;
  const walk = async (dirRel: string): Promise<void> => {
    if (budget <= 0) return;
    let entries: VaultEntry[];
    try {
      entries = await listDir(root, dirRel);
    } catch {
      return;
    }
    for (const e of entries) {
      budget--;
      if (budget <= 0) return;
      if (e.type === 'dir') await walk(e.rel);
      else snap.set(e.rel, { mtimeMs: e.mtimeMs, size: e.size });
    }
  };
  await walk('');
  return snap;
}

async function diffOnce(): Promise<void> {
  const cfg = W.config;
  if (!cfg) return;
  const st = await fs.stat(cfg.root).catch(() => null);
  if (!st || !st.isDirectory()) {
    // Vault vanished — surface as a synthetic removal so the UI can react.
    push({ path: '', kind: 'removed', ts: Date.now() });
    return;
  }
  const prev = W.snapshot;
  const next = await takeSnapshot(cfg.root);
  W.snapshot = next;
  const events: VaultChangeEvent[] = [];
  for (const [p, meta] of next) {
    const was = prev.get(p);
    if (!was) events.push({ path: p, kind: 'added', ts: Date.now() });
    else if (was.mtimeMs !== meta.mtimeMs || was.size !== meta.size)
      events.push({ path: p, kind: 'changed', ts: Date.now() });
  }
  for (const p of prev.keys()) if (!next.has(p)) events.push({ path: p, kind: 'removed', ts: Date.now() });
  for (const ev of events) push(ev);
  /* T7 round 3 — the revisions hook: every externally-caused 'changed'
   * event archives the just-seen content as an "observed" revision (the
   * revisions module re-checks the app-write suppression + throttle, so
   * this call is cheap for our own writes). Dynamic import ON PURPOSE:
   * revisions.ts statically imports safeResolve from this module, and a
   * static back-import would close a module-init cycle. Fire-and-forget:
   * observation is best-effort and must never break the watcher. */
  for (const ev of events) {
    if (ev.kind !== 'changed') continue;
    void import('./revisions')
      .then((m) => m.observeExternalChange(cfg.root, ev.path))
      .catch(() => {});
  }
}

function push(ev: VaultChangeEvent): void {
  W.lastEvents.push(ev);
  if (W.lastEvents.length > EVENT_RING) W.lastEvents.shift();
  for (const client of W.clients) {
    try {
      client(ev);
    } catch {
      /* a client write raced its own cleanup — the Set prune handles it */
    }
  }
}

function startPoller(): void {
  if (W.pollTimer) return;
  W.pollTimer = setInterval(() => {
    void diffOnce().catch(() => {});
  }, POLL_MS);
  // Kick an immediate first diff so clients see state fast.
  void diffOnce().catch(() => {});
}

function stopPoller(): void {
  if (W.pollTimer) {
    clearInterval(W.pollTimer);
    W.pollTimer = null;
  }
}

/** Best-effort instant events: watch root + first-level dirs (non-recursive watch). */
async function startAccelerator(root: string): Promise<void> {
  stopAccelerator();
  const dirs: string[] = [root];
  try {
    const names = await fs.readdir(root);
    for (const name of names.slice(0, 40)) {
      const p = path.join(root, name);
      try {
        if ((await fs.stat(p)).isDirectory()) dirs.push(p);
      } catch {
        /* raced removal */
      }
    }
  } catch {
    return;
  }
  const onFsEvent = () => {
    // Coalesce burst events; a 400ms nudge diffs immediately.
    W.dirty = true;
  };
  for (const dir of dirs) {
    try {
      const w = fsSync.watch(dir, { persistent: false }, onFsEvent);
      W.accelWatchers.push(w);
    } catch {
      /* platform may refuse — the poller remains the source of truth */
    }
  }
  W.nudgeTimer = setInterval(() => {
    if (W.dirty) {
      W.dirty = false;
      void diffOnce().catch(() => {});
    }
  }, 400);
}

function stopAccelerator(): void {
  for (const w of W.accelWatchers) {
    try {
      w.close();
    } catch {
      /* already closed */
    }
  }
  W.accelWatchers = [];
  if (W.nudgeTimer) {
    clearInterval(W.nudgeTimer);
    W.nudgeTimer = null;
  }
}

export async function startWatching(): Promise<VaultConfig | null> {
  const cfg = await readConfig();
  if (!cfg) {
    stopWatching();
    return null;
  }
  if (W.config?.root !== cfg.root) {
    // Different (or first) vault: full re-arm — fresh snapshot, fresh ring.
    stopWatching();
    W.config = cfg;
    W.snapshot = await takeSnapshot(cfg.root).catch(() => new Map());
    W.lastEvents = [];
    await startAccelerator(cfg.root);
  } else if (W.accelWatchers.length === 0) {
    // Same vault re-armed after a full stop: the fs.watch accelerators
    // died with it — re-create them (the snapshot survives, which is
    // exactly what makes the first diff honest).
    await startAccelerator(cfg.root);
  }
  /* BUGFIX (found by Phase 5's details-panel SSE): this used to
   * early-return when W.config.root already matched, so after the LAST
   * SSE client disconnected (stopPoller) a reconnecting client got a
   * DEAD watcher — hello + stale ring replay, zero new events forever.
   * startPoller is idempotent (no-op while the timer lives), so calling
   * it unconditionally restarts the poller whenever clients exist. */
  startPoller();
  return cfg;
}

export function stopWatching(): void {
  stopPoller();
  stopAccelerator();
  W.config = null;
  W.snapshot = new Map();
  W.lastEvents = [];
}

export function addClient(client: Client): void {
  W.clients.add(client);
}

export function removeClient(client: Client): void {
  W.clients.delete(client);
  if (W.clients.size === 0) {
    // No listeners → no idle cost. The next client restarts everything.
    stopPoller();
    stopAccelerator();
  }
}

export function recentEvents(): VaultChangeEvent[] {
  return [...W.lastEvents];
}
