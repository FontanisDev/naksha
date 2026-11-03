/**
 * POST /api/vault/revisions — the history surface behind `vault history`
 * (v138 T7 round 3: the TriliumNext note-revisions port — see
 * lib/server/revisions.ts for the upstream attribution and semantics).
 *
 * READ-ONLY on the VAULT: the revision store lives in Naksha's own
 * db/revisions/ (the vault itself is never touched by a listing).
 * Answers for a merely-CONNECTED vault (same rule as `vault recent` /
 * `vault check`): history inspection is a read verb, no designation.
 *
 * Client sends `{ rel?: string }`:
 *   - no rel  → per-path summary for this root (rel, count, latestTs,
 *               latestKind), newest activity first, capped at 200 paths.
 *   - with rel → the full entry list for that path, newest first. A
 *               hostile rel (traversal / hidden segment) refuses loudly
 *               with the reader's own VaultPathError → 400.
 */

import { NextResponse } from 'next/server';
import { readConfig } from '@/lib/server/vault';
import { listRevisionPaths, listRevisions } from '@/lib/server/revisions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const cfg = await readConfig();
  if (!cfg) {
    return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as { rel?: unknown };
  const rel = typeof body.rel === 'string' && body.rel.trim() ? body.rel : undefined;
  try {
    if (rel === undefined) {
      const { paths } = await listRevisionPaths(cfg.root);
      return NextResponse.json({ ok: true, root: cfg.root, name: cfg.name, paths });
    }
    const { entries } = await listRevisions(cfg.root, rel);
    return NextResponse.json({ ok: true, root: cfg.root, name: cfg.name, rel, entries });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
