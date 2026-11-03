/**
 * POST /api/vault/revisions/content — read ONE archived revision's
 * content (v138 T7 round 4: powers the panel's revision viewer and the
 * terminal's diff; the TriliumNext revisions-port part 2 — upstream's
 * revisions tab serves note content per revision the same way).
 *
 * READ-ONLY on the vault: the blob lives in Naksha's own db/revisions
 * store. Connected-vault verb (like the history listing). Client sends
 * `{ rel: string, id: string }`; answers `{ ok, content, ts, kind,
 * reason }` or an honest error (unknown id / erased / hostile rel).
 */

import { NextResponse } from 'next/server';
import { readConfig } from '@/lib/server/vault';
import { readRevisionContent } from '@/lib/server/revisions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const cfg = await readConfig();
  if (!cfg) {
    return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as { rel?: unknown; id?: unknown };
  if (typeof body.rel !== 'string' || typeof body.id !== 'string') {
    return NextResponse.json({ ok: false, error: 'body must be { rel, id }' }, { status: 400 });
  }
  try {
    const content = await readRevisionContent(cfg.root, body.rel, body.id);
    if (content === null) {
      return NextResponse.json(
        { ok: false, error: `no such revision: ${body.id} (erased, or from another vault)` },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true, rel: body.rel, id: body.id, content });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
