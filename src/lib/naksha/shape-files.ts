/**
 * Naksha — Workspace shape ⇄ MD file bridge (v138 T4)
 *
 * Every NAMED or ANNOTATED workspace constellation gets a real markdown
 * file — in the designated CareSpace vault when one is gated on, otherwise
 * in the internal virtual FS (`~/workspace/`). The file is the shape's
 * record: name, note, color, binding, creation/update stamps AND the
 * geometry (star ids + absolute px coords + board size), so a cleared
 * board can be RESTORED to its original positions.
 *
 * Assembled from the app's battle-tested pieces (golden rule 2 — nothing
 * here invents a new dialect):
 *  - `noteBasename` + the minimal-frontmatter dialect + the gated write /
 *    read / rename wrappers come from `care-vault.ts` (Phase 5 policy:
 *    frontmatter only into files WE create; text lives in the body).
 *  - Internal writes go through `FileSystem` (the same engine `nano` /
 *    `echo >` use), so the terminal can `ls ~/workspace`, `cat`, `nano`
 *    and `grep` shape files natively.
 *  - Vault reads reuse the read-only `/api/vault/list` + `/api/vault/read`
 *    surface (the exact pair `careVaultReadNote` already rides).
 *
 * File format (human / Obsidian friendly — the note IS the body):
 *
 *   ---
 *   naksha: shape
 *   id: 12-13-14
 *   name: "Gold Cluster"
 *   color: "rgba(212, 160, 23, 0.12)"
 *   colorName: gold
 *   bound: node-123
 *   created: 2026-01-01T00:00:00.000Z
 *   updated: 2026-01-01T00:00:00.000Z
 *   points: 4
 *   stars: "12,13,14"
 *   coords: "112,84 140,84 140,112"
 *   board: "1512x982"
 *   deleted: yes          ← only on vault tombstones (no delete route)
 *   ---
 *
 *   # Gold Cluster
 *
 *   The note text, free-form.
 *
 * No React / store imports — the caller (Workspace) passes the storage
 * target in, exactly like care-vault.ts stays fetch-only.
 */

import { FileSystem } from './filesystem';
import { noteBasename, careVaultWriteNote, careVaultRenameNote, careVaultReadNote } from './care-vault';
import type { CareVaultStatus } from './types';

/** Internal-FS folder the shape files live in (created on demand). */
export const SHAPE_DIR_INTERNAL = '/home/workspace';
/** Vault-relative folder for shape files (care-vault write = mkdir -p). */
export const SHAPE_DIR_VAULT = 'workspace';

/* ── storage target ──────────────────────────────────────────────────── */

export type ShapeStorage = { kind: 'internal' } | { kind: 'vault'; name: string };

/** Same gate the care verbs speak (commands.ts careGate), as pure data:
 *  a designated + connected + available vault wins; internal otherwise. */
export function pickShapeStorage(st: CareVaultStatus | null): ShapeStorage {
  if (st && st.vaultConnected && st.designatedFlag && st.designated) {
    return { kind: 'vault', name: st.name ?? 'vault' };
  }
  return { kind: 'internal' };
}

/** Display prefix for receipts: `~/workspace/x.md` vs `[vault:name] workspace/x.md`. */
export function shapePathLabel(storage: ShapeStorage, rel: string): string {
  if (storage.kind === 'vault') return `[vault:${storage.name}] ${rel}`;
  return rel.replace(/^\/home/, '~');
}

/* ── the serialized shape ────────────────────────────────────────────── */

export interface ShapeFileData {
  id: string;
  name: string;
  note: string;
  color: string; // the fill rgba (SHAPE_COLORS contract)
  bound: string; // CareSpace nodeId or ''
  created: string; // ISO
  updated: string; // ISO
  stars: number[];
  coords: Array<{ x: number; y: number }>;
  board: string; // "WxH" the coords were measured on (advisory)
  deleted?: boolean; // vault tombstones only
}

/** Quote a frontmatter value (always quoted — safe for spaces, commas,
 *  `#`, colons). Escapes only what our own parser unescapes. */
function fmQuote(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function fmUnquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

/** Stable, human-safe file basename for a shape (noteBasename contract:
 *  Unicode kept, separators stripped, Windows-hostile tails removed). */
export function shapeFileBase(name: string, fallback: string, taken: Set<string>): string {
  let base = noteBasename(name || fallback).replace(/\.(md|markdown)$/i, '');
  if (!base || base === 'untitled') base = noteBasename(fallback);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} ${n}`;
    n++;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

export function buildShapeMarkdown(d: ShapeFileData): string {
  const fm: string[] = [
    '---',
    'naksha: shape',
    `id: ${d.id}`,
    `name: ${fmQuote(d.name)}`,
    `color: ${fmQuote(d.color)}`,
    `colorName: ${d.color in SHAPE_COLOR_LABELS ? SHAPE_COLOR_LABELS[d.color] : 'custom'}`,
    `bound: ${d.bound}`,
    `created: ${d.created}`,
    `updated: ${d.updated}`,
    `points: ${d.stars.length}`,
    `stars: ${fmQuote(d.stars.join(','))}`,
    `coords: ${fmQuote(d.coords.map((c) => `${Math.round(c.x)},${Math.round(c.y)}`).join(' '))}`,
    `board: ${fmQuote(d.board)}`,
  ];
  if (d.deleted) fm.push('deleted: yes');
  fm.push('---', '', '');
  const body = `# ${d.name || 'Shape'}\n\n${d.note.trim()}${d.note.trim() ? '\n' : ''}`;
  return `${fm.join('\n')}\n${body}`;
}

/** Color-name labels — mirrors Workspace's SHAPE_COLOR_NAMES provenance
 *  map (kept here so the markdown layer stays import-cycle-free). */
export const SHAPE_COLOR_LABELS: Record<string, string> = {
  'rgba(212, 160, 23, 0.12)': 'gold',
  'rgba(99, 179, 237, 0.12)': 'blue',
  'rgba(155, 126, 200, 0.12)': 'violet',
  'rgba(125, 186, 106, 0.12)': 'green',
  'rgba(232, 93, 117, 0.12)': 'red',
};

/** Parse a shape markdown file. Returns null for anything that is not a
 *  naksha shape file (foreign notes in the folder are ignored, never
 *  invented into shapes). Tolerates hand edits: missing optional fields
 *  degrade, geometry is required. */
export function parseShapeMarkdown(text: string): Omit<ShapeFileData, 'note'> & { note: string } | null {
  if (!text.startsWith('---')) return null;
  const close = text.indexOf('\n---', 3);
  if (close < 0) return null;
  const fmText = text.slice(3, close);
  const body = text.slice(close + 4).replace(/^\r?\n/, '');

  const fm: Record<string, string> = {};
  for (const line of fmText.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    fm[line.slice(0, idx).trim()] = fmUnquote(line.slice(idx + 1));
  }
  if (fm['naksha'] !== 'shape') return null;
  const stars = (fm['stars'] ?? '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  const coords = (fm['coords'] ?? '')
    .split(' ')
    .map((pair) => {
      const [x, y] = pair.split(',').map((v) => parseFloat(v.trim()));
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    })
    .filter((v): v is { x: number; y: number } => v !== null);
  if (stars.length < 3 || coords.length < 3) return null;

  // Body → note: drop the `# heading` line, the rest is the note.
  const bodyLines = body.split('\n');
  let start = 0;
  while (start < bodyLines.length && bodyLines[start].trim() === '') start++;
  if (start < bodyLines.length && bodyLines[start].trim().startsWith('# ')) start++;
  const note = bodyLines
    .slice(start)
    .join('\n')
    .replace(/\n+$/, '')
    .trim();

  return {
    id: fm['id'] ?? '',
    name: fm['name'] ?? '',
    note,
    color: fm['color'] ?? '',
    bound: fm['bound'] ?? '',
    created: fm['created'] ?? '',
    updated: fm['updated'] ?? '',
    stars,
    coords,
    board: fm['board'] ?? '',
    deleted: fm['deleted'] === 'yes' || fm['deleted'] === 'true',
  };
}

/* ── IO (internal FS + gated vault) ──────────────────────────────────── */

export interface ShapeWriteResult {
  ok: boolean;
  where: ShapeStorage;
  rel: string; // context-prefixed: "internal:/home/workspace/x.md" | "vault:workspace/x.md"
  label: string; // receipt-ready path
  error?: string;
}

/** Ensure `~/workspace` exists in the internal FS (idempotent). */
function ensureInternalDir(): void {
  if (!FileSystem.getNode(['home', 'workspace'])) {
    FileSystem.makeDirectory(SHAPE_DIR_INTERNAL); // may report "Already exists" — harmless
  }
}

export async function writeShapeFile(
  storage: ShapeStorage,
  relBare: string,
  data: ShapeFileData,
): Promise<ShapeWriteResult> {
  const md = buildShapeMarkdown(data);
  if (storage.kind === 'internal') {
    ensureInternalDir();
    const abs = internalAbs(relBare);
    const r = FileSystem.writeFile(abs, md);
    const rel = `internal:${abs}`;
    return r.success
      ? { ok: true, where: storage, rel, label: shapePathLabel(storage, abs) }
      : { ok: false, where: storage, rel, label: shapePathLabel(storage, abs), error: r.error ?? 'write failed' };
  }
  const rel = `vault:${vaultRel(relBare)}`;
  const w = await careVaultWriteNote(vaultRel(relBare), md);
  return w.ok
    ? { ok: true, where: storage, rel, label: shapePathLabel(storage, vaultRel(relBare)) }
    : { ok: false, where: storage, rel, label: shapePathLabel(storage, vaultRel(relBare)), error: w.error ?? 'write failed' };
}

/** Move a shape file (rename path — the content is rewritten right after
 *  by the caller). Internal = FileSystem.move; vault = the gated rename. */
export async function moveShapeFile(
  storage: ShapeStorage,
  fromBare: string,
  toBare: string,
): Promise<{ ok: boolean; error?: string }> {
  if (storage.kind === 'internal') {
    ensureInternalDir();
    const r = FileSystem.move(internalAbs(fromBare), internalAbs(toBare));
    return { ok: r.success, error: r.error };
  }
  const r = await careVaultRenameNote(vaultRel(fromBare), vaultRel(toBare));
  return { ok: r.ok, error: r.error };
}

/** Remove a shape's file. Internal deletes outright; the vault has NO
 *  delete route (read/write/rename only), so it tombstones the file
 *  (`deleted: yes`) — restore skips tombstones, the human-visible file
 *  stays as history. `current` is the file's live content for tombstones. */
export async function removeShapeFile(
  storage: ShapeStorage,
  relBare: string,
  current: ShapeFileData,
): Promise<{ ok: boolean; tombstoned?: boolean; error?: string }> {
  if (storage.kind === 'internal') {
    const r = FileSystem.remove(internalAbs(relBare));
    return { ok: r.success, error: r.error };
  }
  const w = await writeShapeFile(storage, relBare, { ...current, deleted: true, updated: new Date().toISOString() });
  return { ok: w.ok, tombstoned: true, error: w.error };
}

/** Bare rel (no context prefix) + storage kind of a stored shape.file. */
export function splitShapeRel(rel: string): { kind: 'internal' | 'vault'; bare: string } | null {
  if (rel.startsWith('internal:')) return { kind: 'internal', bare: rel.slice('internal:'.length) };
  if (rel.startsWith('vault:')) return { kind: 'vault', bare: rel.slice('vault:'.length) };
  return null;
}

/* Internal rels are ABSOLUTE FS paths (FileSystem speaks absolute);
 * vault rels are folder-relative (`workspace/<file>.md`). Callers may
 * hand either form back — normalize both ways here. */
function internalAbs(relBare: string): string {
  return relBare.startsWith('/') ? relBare : `${SHAPE_DIR_INTERNAL}/${relBare}`;
}
function vaultRel(relBare: string): string {
  return relBare.startsWith(`${SHAPE_DIR_VAULT}/`) ? relBare : `${SHAPE_DIR_VAULT}/${relBare}`;
}

/* ── listing + restore ───────────────────────────────────────────────── */

export interface ShapeFileEntry {
  bare: string; // basename within the shapes folder
  data: ReturnType<typeof parseShapeMarkdown>;
}

/** List + parse the shape files in the CURRENT storage target. Internal
 *  walks `~/workspace` for `*.md`; vault lists `workspace/` through the
 *  read-only API. Unparseable / foreign files come back with data:null
 *  (caller skips them honestly). */
export async function listShapeFiles(storage: ShapeStorage): Promise<{ ok: boolean; files: ShapeFileEntry[]; error?: string }> {
  const files: ShapeFileEntry[] = [];
  if (storage.kind === 'internal') {
    const node = FileSystem.getNode(['home', 'workspace']);
    if (!node || node.type !== 'dir') return { ok: true, files };
    for (const [name, child] of Object.entries(node.contents)) {
      if (child.type !== 'file' || !/\.(md|markdown)$/i.test(name)) continue;
      const text = (child as { content?: string }).content ?? '';
      files.push({ bare: name, data: parseShapeMarkdown(text) });
    }
    return { ok: true, files };
  }
  try {
    const res = await fetch(`/api/vault/list?p=${encodeURIComponent(SHAPE_DIR_VAULT)}`, { cache: 'no-store' });
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      entries?: Array<{ name: string; type: string }>;
    };
    if (!data.ok) {
      // A missing folder simply means "no shapes saved there yet".
      if (/no such|not found|exist/i.test(data.error ?? '')) return { ok: true, files };
      return { ok: false, files, error: data.error ?? 'list failed' };
    }
    for (const e of data.entries ?? []) {
      if (e.type !== 'file' || !/\.(md|markdown)$/i.test(e.name)) continue;
      const r = await careVaultReadNote(`${SHAPE_DIR_VAULT}/${e.name}`);
      files.push({ bare: e.name, data: r.ok && typeof r.content === 'string' ? parseShapeMarkdown(r.content) : null });
    }
    return { ok: true, files };
  } catch (err) {
    return { ok: false, files, error: (err as Error).message };
  }
}
