/**
 * Naksha — Server-side CareSpace vault writer (Phase 5)
 *
 * The ONLY write path from CareSpace into the real filesystem. Deliberately
 * a SEPARATE module from lib/server/vault.ts: the read-only vault module
 * still contains no write primitive at all (Phase 2's contract, still true),
 * and everything here is gated behind an explicit, server-side
 * "designated CareSpace vault" flag.
 *
 * Gating model (every write call re-validates all of it):
 *   1. A vault is connected (lib/server/vault config exists, dir available).
 *   2. That same vault is DESIGNATED for CareSpace use (db/care-vault.json
 *      points at the SAME root). Connecting a different directory never
 *      silently inherits a previous designation — the roots must match.
 *   3. Every path resolves inside the root through the read-only module's
 *      safeResolve (normalize + root-jail + realpath symlink containment).
 *
 * Capability surface (narrow by design):
 *   - writeNote:  create-or-overwrite one .md/.markdown file (≤2MB),
 *                 auto-creating parent directories (mkdir -p semantics).
 *   - renameNote: rename one .md/.markdown file to a non-existing target.
 *   - checkPaths: existence probe for bound paths (broken-note detection).
 *
 * NO delete. NO arbitrary file write. NO directory listing (the read-only
 * module already serves that). Removing a bound node leaves its file on
 * disk — a real directory must never lose user data through CareSpace.
 *
 * Frontmatter policy (Phase 5 spec): CareSpace never writes frontmatter
 * into files it did not create. When CareSpace itself creates a note file,
 * a MINIMAL frontmatter block (naksha node id + created timestamp) is
 * allowed and documented. The CONTENT is built client-side; this module
 * only enforces the size cap and the .md extension rule.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { readConfig, safeResolve, VaultPathError } from './vault';
import {
  snapshotBeforeOverwrite,
  markAppWriteSync,
  migrateRevisionPath,
} from './revisions';

/* ── Designation persistence ──────────────────────────────────────────
 * One JSON file inside the runtime db/ folder, next to vault.json.
 * Server-side on purpose: the writable flag describes the SERVER's
 * directory, exactly like the connection itself. */

export interface CareVaultConfig {
  root: string; // absolute path — must match the connected vault's root
  name: string;
  designatedAt: number;
}

const CARE_CONFIG_PATH = path.join(process.cwd(), 'db', 'care-vault.json');

export async function readCareConfig(): Promise<CareVaultConfig | null> {
  try {
    const raw = await fs.readFile(CARE_CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw) as CareVaultConfig;
    if (cfg && typeof cfg.root === 'string' && cfg.root.startsWith('/')) return cfg;
    return null;
  } catch {
    return null;
  }
}

export async function writeCareConfig(cfg: CareVaultConfig | null): Promise<void> {
  if (!cfg) {
    await fs.rm(CARE_CONFIG_PATH, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(CARE_CONFIG_PATH), { recursive: true });
  await fs.writeFile(CARE_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

export interface CareVaultGate {
  ok: boolean;
  error?: string;
  root?: string;
  name?: string;
}

/**
 * The gate every write/probe passes through: connected + available vault,
 * designation on, and the designation pointing at THIS root.
 */
export async function careVaultGate(): Promise<CareVaultGate> {
  const vaultCfg = await readConfig();
  if (!vaultCfg) return { ok: false, error: 'no vault connected' };
  const st = await fs.stat(vaultCfg.root).catch(() => null);
  if (!st?.isDirectory?.()) {
    return { ok: false, error: 'connected directory is unavailable', root: vaultCfg.root, name: vaultCfg.name };
  }
  const careCfg = await readCareConfig();
  if (!careCfg || careCfg.root !== vaultCfg.root) {
    return {
      ok: false,
      error: 'this vault is not designated for CareSpace — designate it first (vault designate on)',
      root: vaultCfg.root,
      name: vaultCfg.name,
    };
  }
  return { ok: true, root: vaultCfg.root, name: vaultCfg.name };
}

/* ── Capability surface ─────────────────────────────────────────────── */

const WRITE_CAP_BYTES = 2 * 1024 * 1024; // mirrors the reader cap
const NOTE_EXT = /\.(md|markdown)$/i;

function assertNotePath(rel: string): void {
  if (typeof rel !== 'string' || !rel.trim()) throw new VaultPathError('missing note path');
  if (rel.includes('\0')) throw new VaultPathError('invalid path');
  if (rel.trimStart().startsWith('-')) {
    throw new VaultPathError("path looks like an option — leading '-' is refused");
  }
  if (rel.split('/').some((seg) => seg === '..')) {
    throw new VaultPathError('path escapes the connected directory');
  }
  if (rel.split('/').some((seg) => seg.startsWith('.'))) {
    throw new VaultPathError('hidden files stay out of the vault');
  }
  if (rel.endsWith('/')) throw new VaultPathError('note path must be a file, not a directory');
  if (!NOTE_EXT.test(rel)) {
    throw new VaultPathError('only .md / .markdown notes are written by CareSpace');
  }
}

export interface CareWriteResult {
  rel: string;
  size: number;
  created: boolean; // false = overwrote an existing note
}

export async function writeNote(
  root: string,
  rel: string,
  content: string,
): Promise<CareWriteResult> {
  assertNotePath(rel);
  if (typeof content !== 'string') throw new VaultPathError('note content must be text');
  const body = Buffer.from(content, 'utf8');
  if (body.length > WRITE_CAP_BYTES) {
    throw new VaultPathError(`note exceeds the ${Math.round(WRITE_CAP_BYTES / 1048576)}MB cap`);
  }
  const abs = await safeResolve(root, rel);
  const existed = await fs
    .stat(abs)
    .then((s) => s.isFile())
    .catch(() => false);
  if (existed) {
    const st = await fs.stat(abs);
    if (st.size > 0 && !NOTE_EXT.test(rel)) throw new VaultPathError('refusing to overwrite a non-note file');
  }
  /* T7 round 3 — the Trilium note-revisions analog: overwriting an
   * existing note archives the content that is about to disappear
   * (best-effort; a snapshot failure never blocks the user's write).
   * New files have no past to archive — history starts at the first
   * observed change, exactly the honest boundary of a file-backed vault. */
  if (existed) await snapshotBeforeOverwrite(root, rel);
  /* Suppress BEFORE the bytes land: the watcher's poller can diff at any
   * tick, and marking only after writeFile leaves a photo-finish race
   * where the diff reads the registry before our mark does (QA-caught:
   * one spurious "observed" entry per race hit). A phantom mark from a
   * failed write is harmless — 30s TTL, size-scoped. The post-write mark
   * refreshes the window. */
  markAppWriteSync(rel, body.length); // suppress BEFORE the bytes land (race, see markAppWriteSync)
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
  markAppWriteSync(rel, body.length); // refresh the window post-write
  return { rel, size: body.length, created: !existed };
}

export async function renameNote(root: string, from: string, to: string): Promise<{ from: string; to: string }> {
  assertNotePath(from);
  assertNotePath(to);
  const absFrom = await safeResolve(root, from);
  const absTo = await safeResolve(root, to);
  const st = await fs.stat(absFrom).catch(() => null);
  if (!st?.isFile?.()) throw new VaultPathError(`no such note: ${from}`);
  const exists = await fs.stat(absTo).then(() => true).catch(() => false);
  if (exists) throw new VaultPathError(`target already exists: ${to}`);
  await fs.mkdir(path.dirname(absTo), { recursive: true });
  await fs.rename(absFrom, absTo);
  /* A rename moves the file, not its past — re-key the revision history
   * under the new path (upstream: note identity survives renames). */
  await migrateRevisionPath(root, from, to);
  return { from, to };
}

export interface CareCheckResult {
  /** rel → exists. Absent from the map = not probed (cap). */
  exists: Record<string, boolean>;
}

const CHECK_CAP = 200;

export async function checkPaths(root: string, rels: string[]): Promise<CareCheckResult> {
  const exists: Record<string, boolean> = {};
  const list = Array.isArray(rels) ? rels.filter((r): r is string => typeof r === 'string').slice(0, CHECK_CAP) : [];
  await Promise.all(
    list.map(async (rel) => {
      try {
        const abs = await safeResolve(root, rel);
        const st = await fs.stat(abs);
        exists[rel] = st.isFile();
      } catch {
        exists[rel] = false;
      }
    }),
  );
  return { exists };
}

export { VaultPathError };
