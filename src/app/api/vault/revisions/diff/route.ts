/**
 * POST /api/vault/revisions/diff — line diff between two points of a
 * path's history (v138 T7 round 4: the TriliumNext revisions-port part
 * 2 — upstream's revisions tab diffs note revisions; see diffRevisions
 * in lib/server/revisions.ts + lib/server/text-diff.ts for the engine).
 *
 * READ-ONLY on the vault; connected-vault verb (like the history
 * listing). Client sends `{ rel, a?, b? }`:
 *   - no a/b   → newest revision → live file
 *   - a only   → revision a      → live file
 *   - a and b  → revision a      → revision b
 * Answers `{ ok, a, b, lines: [{kind, text}], stats: {added, removed} }`
 * where kind ∈ 'same' | 'add' | 'del'; '+' = present in b, '−' = in a.
 */

import { NextResponse } from 'next/server';
import { readConfig } from '@/lib/server/vault';
import { diffRevisions } from '@/lib/server/revisions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const cfg = await readConfig();
  if (!cfg) {
    return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as { rel?: unknown; a?: unknown; b?: unknown };
  if (typeof body.rel !== 'string') {
    return NextResponse.json({ ok: false, error: 'body must be { rel, a?, b? }' }, { status: 400 });
  }
  const a = typeof body.a === 'string' && body.a ? body.a : undefined;
  const b = typeof body.b === 'string' && body.b ? body.b : undefined;
  try {
    const diff = await diffRevisions(cfg.root, body.rel, a, b);
    return NextResponse.json({ ok: true, ...diff });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
