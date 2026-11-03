/**
 * Naksha — Storage context (Phase 3)
 *
 * The SINGLE RESOLVER for "which storage world is active": the internal
 * browser-side virtual FS, or the explicitly connected real directory.
 *
 * Design contract (Phase 3 spec):
 *  - One source of truth. Every indicator (StatusBar chip, VaultPanel
 *    header, terminal receipts) calls `resolveStorageContext` with the
 *    same two inputs — the saved settings pref + the live VaultStatus —
 *    so no surface can drift into telling its own story.
 *  - No silent mapping. This module NEVER copies, merges, or migrates
 *    data between worlds; it only NAMES the active world. Internal FS
 *    and vault APIs stay separate modules by construction.
 *  - Server-validated persistence. A saved 'connected' pref is honored
 *    only while the server reports a connected + available directory;
 *    anything else resolves to 'internal' with reason
 *    'fallback-unavailable' so callers can surface a VISIBLE notice.
 *  - Pure module: no React, no store import — safe for store.ts to
 *    import (the React derivation lives in the components, 3 lines).
 */

import type { StorageContext, StorageContextPref, VaultStatus } from './types';

/** Resolve the active storage context from the saved pref + live status.
 *
 *  Truth table:
 *   pref 'connected' + vault connected & available → connected ('chosen')
 *   pref 'connected' + vault missing / unavailable / unknown →
 *       internal ('fallback-unavailable')  ← visible fallback, not silent
 *   pref 'internal'                                 → internal ('chosen')
 *   pref undefined (old profiles / never chosen)    → internal ('default')
 *
 *  `status === null` means "server never answered yet" — treated as the
 *  unavailable branch so early renders never claim a connection they
 *  cannot prove. */
export function resolveStorageContext(
  pref: StorageContextPref | undefined,
  status: VaultStatus | null,
): StorageContext {
  if (pref === 'connected') {
    if (status?.connected && status.available && status.root) {
      return { kind: 'connected', root: status.root, name: status.name, reason: 'chosen' };
    }
    return {
      kind: 'internal',
      root: null,
      name: status?.name ?? null,
      reason: 'fallback-unavailable',
    };
  }
  if (pref === 'internal') {
    return { kind: 'internal', root: null, name: null, reason: 'chosen' };
  }
  return { kind: 'internal', root: null, name: null, reason: 'default' };
}

/** Short chip label for the active context: `internal` or
 *  `connected:<name>`. Rendered inside the StatusBar `CTX:` chip and
 *  the VaultPanel context strip. */
export function contextChipLabel(ctx: StorageContext): string {
  return ctx.kind === 'connected' ? `connected:${ctx.name ?? '?'}` : 'internal';
}

/** Honest long-form tooltip / aria text for the chip. States exactly
 *  what routes where TODAY (T7 copy re-sync: the old text still claimed
 *  "the vault is read-only" and listed nano among the internal-stay
 *  verbs — both stale since Phase 5's designated writes and Phase 6's
 *  real nano on the PTY bridge. The built-in fs write verbs DO stay
 *  internal; the real nano edits the vault; CareSpace's designated
 *  verbs write it when gated on). */
export function contextChipTitle(ctx: StorageContext, forAria = false): string {
  if (ctx.kind === 'connected') {
    const base =
      `storage context connected:${ctx.name ?? '?'} — the connected real directory ` +
      `(${ctx.root}) backs the vault panel, 'vault open/tree' and the terminal's ` +
      `read verbs (ls/cd/pwd/tree/cat/grep); the built-in write verbs ` +
      `(mkdir/touch/rm/echo>/cp/mv) stay on the internal FS — the vault is edited ` +
      `with real nano (nano <file> — PTY bridge) and, when designated, by CareSpace's gated commands`;
    return forAria
      ? `storage context connected to ${ctx.name ?? 'vault'} — press to open the vault panel`
      : base;
  }
  const fallback =
    ctx.reason === 'fallback-unavailable'
      ? `the saved 'connected' preference could not be honored${
          ctx.name ? ` (${ctx.name} is unavailable)` : ''
        } — fell back to internal (visible, never silent)`
      : `nothing is connected — the browser-side virtual FS is the whole story`;
  const base =
    `storage context internal — the browser-side virtual FS; no real directory is backing any surface. ${fallback}`;
  return forAria
    ? ctx.reason === 'fallback-unavailable'
      ? `storage context internal — the saved connected vault ${ctx.name ?? ''} is unavailable, fell back to internal — press to open the vault panel`
      : `storage context internal, no connected directory — press to open the vault panel`
    : base;
}

/** One-line routing truth used by receipts (context/vault/settings).
 *  T7 copy re-sync (see contextChipTitle): the vault is no longer
 *  write-forbidden — real nano + designated CareSpace commands write it;
 *  the BUILT-IN fs write verbs are what stay internal. */
export function contextRoutingLine(ctx: StorageContext): string {
  return ctx.kind === 'connected'
    ? `vault surfaces + ls/cd/pwd/tree/cat/grep → ${ctx.root ?? '?'} · real nano + designated CareSpace writes → the vault · built-in write verbs (mkdir/touch/rm/…) → internal FS`
    : `all surfaces → internal FS (browser-side) · nothing reads your real disk`;
}

/** The world tag printed on receipts and echoed commands so every
 *  line NAMES the world that answered it: `[internal]` or
 *  `[vault:<name>]`. One builder — the prompt chip, the cmd echo and
 *  the per-command receipts can never drift into two dialects. */
export function contextReceiptTag(ctx: StorageContext): string {
  return ctx.kind === 'connected' ? `[vault:${ctx.name ?? '?'}]` : '[internal]';
}
