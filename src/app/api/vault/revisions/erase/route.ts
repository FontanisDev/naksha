/**
 * POST /api/vault/revisions/erase — erase ONE revision (by id) or ALL
 * revisions of a path (v138 T7 round 3: the TriliumNext port — upstream
 * offers per-revision and erase-all on the revisions tab; this keeps
 * both). Erase is metadata + blob hygiene on Naksha's OWN store
 * (db/revisions) — the vault file itself is never touched, so like
 * `vault check fix` it needs only a CONNECTED vault, not designation.
 *
 * Client sends `{ rel: string, id?: string }` — absent/empty id (or the
 * literal "all") erases every revision of that path. Answers
 * `{ ok: true, erased: number }` or an honest error.
 */

import { NextResponse } from 'next/server';
import { readConfig } from '@/lib/server/vault';
import { eraseRevisions } from '@/lib/server/revisions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const cfg = await readConfig();
  if (!cfg) {
    return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as { rel?: unknown; id?: unknown };
  if (typeof body.rel !== 'string') {
    return NextResponse.json({ ok: false, error: 'body must be { rel, id? }' }, { status: 400 });
  }
  const id = typeof body.id === 'string' && body.id && body.id !== 'all' ? body.id : 'all';
  try {
    const r = await eraseRevisions(cfg.root, body.rel, id);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
