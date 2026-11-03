/**
 * Naksha — CareSpace vault client helpers (Phase 5)
 *
 * The browser-side half of the CareSpace ↔ real-files bridge: typed
 * wrappers around the narrowly-gated /api/care-vault/* routes plus the
 * pure mapping rules (label → file basename, frontmatter dialect).
 *
 * Everything here goes through the API — the browser never touches paths
 * or files directly, and the server re-validates the designation + jail
 * on every call regardless of what this layer allows.
 *
 * Metadata policy (Phase 5 spec, implemented):
 *  - Note TEXT lives in the real .md file.
 *  - App metadata (node id, tags, links, location) stays in internal
 *    storage keyed by the stable vault-relative path (`CareNode.vaultPath`).
 *  - Frontmatter is written ONLY into files CareSpace itself creates
 *    (minimal: naksha node id + created timestamp). Binding to a user
 *    file never rewrites its content.
 */

import type { CareVaultStatus } from './types';

/* ── status / designation ──────────────────────────────────────────── */

export async function fetchCareVaultStatus(): Promise<CareVaultStatus | null> {
  try {
    const res = await fetch('/api/care-vault/status', { cache: 'no-store' });
    const data = (await res.json()) as CareVaultStatus & { ok: boolean };
    if (data.ok) return data;
  } catch {
    /* server unreachable — caller keeps its previous view */
  }
  return null;
}

export async function designateCareVault(on: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/care-vault/designate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    return data;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* ── gated write surface ───────────────────────────────────────────── */

export async function careVaultWriteNote(rel: string, content: string): Promise<{ ok: boolean; error?: string; created?: boolean; size?: number }> {
  try {
    const res = await fetch('/api/care-vault/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel, content }),
    });
    return (await res.json()) as { ok: boolean; error?: string; created?: boolean; size?: number };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function careVaultRenameNote(from: string, to: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/care-vault/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function careVaultCheck(rels: string[]): Promise<Record<string, boolean>> {
  try {
    const res = await fetch('/api/care-vault/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rels }),
    });
    const data = (await res.json()) as { ok: boolean; exists?: Record<string, boolean> };
    if (data.ok && data.exists) return data.exists;
  } catch {
    /* caller keeps previous markers */
  }
  return {};
}

/** Read a bound note's content through the (read-only) vault API. */
export async function careVaultReadNote(rel: string): Promise<{ ok: boolean; content?: string; mtimeMs?: number; size?: number; error?: string }> {
  try {
    const res = await fetch(`/api/vault/read?p=${encodeURIComponent(rel)}`, { cache: 'no-store' });
    return (await res.json()) as { ok: boolean; content?: string; mtimeMs?: number; size?: number; error?: string };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* ── pure mapping rules ────────────────────────────────────────────── */

/**
 * Label → safe file basename. Keeps Unicode (Persian labels bind to
 * Persian filenames — identity, not transliteration); strips path
 * separators, control chars and trailing dots/spaces; caps length.
 */
export function noteBasename(label: string): string {
  let base = label
    .replace(/[\0/\\]/g, '-') // separators never survive
    .replace(/[\u0000-\u001f\u007f]/g, '') // control chars
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, ''); // Windows-hostile tails
  if (base.length > 80) base = base.slice(0, 80).trim();
  return base || 'untitled';
}

/**
 * A child node's bound path: next to its parent's FILE but inside the
 * parent's FOLDER. Parent bound to `Projects/Roadmap.md` → child
 * `Projects/Roadmap/<Child>.md`. An unbound parent yields null — the
 * caller refuses to invent a location (explicit binding only).
 */
export function deriveChildVaultPath(parentVaultPath: string | null | undefined, childLabel: string): string | null {
  if (!parentVaultPath) return null;
  const dir = parentVaultPath.replace(/\.(md|markdown)$/i, '');
  return `${dir}/${noteBasename(childLabel)}.md`;
}

/**
 * The path a node gets during `care export <folder>`: the whole label
 * path becomes the file path — `Projects/Roadmap.md` — mirroring how
 * Obsidian folders of notes already look. Root's own file sits directly
 * in the export folder.
 */
export function deriveExportVaultPath(folder: string, labelPath: string[]): string {
  const cleanFolder = folder.replace(/^\/+|\/+$/g, '');
  const segs = labelPath.map(noteBasename);
  const rel = segs.length > 0 ? segs.join('/') : 'note';
  return cleanFolder ? `${cleanFolder}/${rel}.md` : `${rel}.md`;
}

/**
 * Minimal frontmatter for files CARESPACE ITSELF creates (the allowed
 * case in the Phase 5 policy). Never prepended to a user file.
 */
export function careNoteFrontmatter(nodeId: string): string {
  return [
    '---',
    `naksha-node: ${nodeId}`,
    `created: ${new Date().toISOString()}`,
    '---',
    '',
    '',
  ].join('\n');
}

/** The skeleton content of a CareSpace-created note. */
export function newNoteContent(nodeId: string, label: string): string {
  return `${careNoteFrontmatter(nodeId)}# ${label}\n`;
}

/**
 * Append a timestamped care note to a bound file's content — the
 * `save <text> to <node>` dialect for bound thoughts. Markdown list
 * item with the same `_(time)_` suffix `careout`'s outline uses, so
 * exports and appends read as one voice.
 */
export function appendNoteLine(content: string, text: string, timeString: string): string {
  const line = `- ${text} _(${timeString})_`;
  if (!content.trim()) return `${line}\n`;
  const needsNl = !content.endsWith('\n');
  return `${content}${needsNl ? '\n' : ''}\n${line}\n`;
}
