/**
 * POST /api/vault/recent — the recent-changes surface behind
 * `vault recent` (v138 T7 round 2: the TriliumNext recent_changes port —
 * see listRecentChanges in lib/server/vault.ts for the upstream
 * attribution and the pattern study note).
 *
 * READ-ONLY by construction: it walks with the reader's own machinery
 * (listDir + safeResolve + ≤limit 1KB heads) and writes nothing. Like
 * /api/vault/audit, it answers for a merely-CONNECTED vault — recent
 * edits made outside the app (Obsidian, nano) are exactly what this
 * surface exists to show, no designation required.
 *
 * Client sends `{ limit?: number, dir?: string }`; the server answers
 * `{ changes: [{rel, mtimeMs, size, kind, tombstone, name?}], scanned,
 * truncated }` sorted newest-first, capped at 100.
 */

import { NextResponse } from 'next/server';
import { readConfig, listRecentChanges } from '@/lib/server/vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const cfg = await readConfig();
  if (!cfg) {
    return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as { limit?: unknown; dir?: unknown };
  const limit = typeof body.limit === 'number' ? body.limit : undefined;
  const dir = typeof body.dir === 'string' ? body.dir : undefined;
  try {
    const recent = await listRecentChanges(cfg.root, { limit, dir });
    return NextResponse.json({
      ok: true,
      root: cfg.root,
      name: cfg.name,
      ...recent,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
