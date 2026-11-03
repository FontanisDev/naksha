/**
 * POST /api/vault/audit — the consistency-check probe behind `vault check`
 * (v138 T7: the TriliumNext consistency_checks port — see findNakshaFiles
 * in lib/server/vault.ts and the DeepWiki study note there).
 *
 * READ-ONLY by construction, on two axes:
 *  1. The existence probe reuses `checkPaths` from the care-vault server
 *     module. The WRITE gate deliberately lives in the care-vault ROUTES
 *     (careVaultGate), not in the probe function — this route does the
 *     same probing for a merely-CONNECTED vault (no designation needed:
 *     bindings from a previously-designated session must stay auditable),
 *     and `checkPaths` itself contains no write primitive.
 *  2. The Naksha-file inventory walks with the reader's own machinery
 *     (listDir + safeResolve + 1KB heads — no whole-file reads).
 *
 * Client sends `{ rels: string[] }` — the app-side half of the bridge
 * (CareNode.vaultPath values + vault shape records); the server answers
 * `exists[rel]` per path plus the Naksha-frontmatter inventory, so the
 * terminal can report broken bindings, duplicate bindings and orphaned
 * files — Trilium's findIssues, adapted to a file-backed world.
 */

import { NextResponse } from 'next/server';
import { readConfig, findNakshaFiles } from '@/lib/server/vault';
import { checkPaths } from '@/lib/server/care-vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const cfg = await readConfig();
  if (!cfg) {
    return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as { rels?: unknown };
  const rels = Array.isArray(body.rels)
    ? body.rels.filter((r): r is string => typeof r === 'string')
    : [];
  try {
    const [check, naksha] = await Promise.all([checkPaths(cfg.root, rels), findNakshaFiles(cfg.root)]);
    return NextResponse.json({
      ok: true,
      root: cfg.root,
      name: cfg.name,
      /* checkPaths returns the WRAPPED CareCheckResult ({ exists: {...} }) —
       * unwrap here so the client's `exists[rel]` reads the map directly
       * (QA-caught: the double nesting once made every binding read as
       * "absent from the map", i.e. a false ✓-consistent verdict). */
      exists: check.exists,
      nakshaFiles: naksha.files,
      scanned: naksha.scanned,
      truncated: naksha.truncated,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
