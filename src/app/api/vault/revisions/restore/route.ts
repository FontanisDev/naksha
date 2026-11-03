/**
 * POST /api/vault/revisions/restore — write one archived revision back
 * into the vault (v138 T7 round 3: the TriliumNext note-revisions port;
 * upstream restores note content from the revisions table and the
 * restore itself is reversible — this port keeps exactly that: the
 * CURRENT content is snapshotted first, so restoring the shield entry
 * undoes the restore — see restoreRevision in lib/server/revisions.ts).
 *
 * THIS IS A WRITE into the vault → it goes through the designated
 * CareSpace gate (connected + available + designated + same root), the
 * same discipline every other write verb follows. History LISTING stays
 * a read verb (no designation); this route is where the line sits.
 *
 * Client sends `{ rel: string, id: string }`; answers
 * `{ ok: true, rel, restoredId, restoredSize }` or an honest error.
 */

import { NextResponse } from 'next/server';
import { careVaultGate } from '@/lib/server/care-vault';
import { restoreRevision } from '@/lib/server/revisions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const gate = await careVaultGate();
  if (!gate.ok) {
    return NextResponse.json({ ok: false, error: gate.error }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { rel?: unknown; id?: unknown };
  if (typeof body.rel !== 'string' || typeof body.id !== 'string') {
    return NextResponse.json({ ok: false, error: 'body must be { rel, id }' }, { status: 400 });
  }
  try {
    const r = await restoreRevision(gate.root!, body.rel, body.id);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
