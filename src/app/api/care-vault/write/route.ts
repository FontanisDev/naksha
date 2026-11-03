/**
 * POST /api/care-vault/write — create-or-overwrite ONE .md note inside the
 * designated CareSpace vault. The only creation surface CareSpace has.
 *
 * Body: { rel: string, content: string }
 * Gated by the care-vault gate (connected + available + designated + same
 * root) and the shared safeResolve jail. Parent directories are created as
 * needed (mkdir -p semantics) — that is part of the note-writing contract,
 * not a separate capability.
 */

import { NextResponse } from 'next/server';
import { careVaultGate, writeNote, VaultPathError } from '@/lib/server/care-vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const gate = await careVaultGate();
  if (!gate.ok) {
    return NextResponse.json({ ok: false, error: gate.error }, { status: 403 });
  }
  let body: { rel?: string; content?: string };
  try {
    body = (await req.json()) as { rel?: string; content?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body.rel !== 'string' || typeof body.content !== 'string') {
    return NextResponse.json({ ok: false, error: 'body must be { rel, content }' }, { status: 400 });
  }
  try {
    const r = await writeNote(gate.root!, body.rel, body.content);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    if (err instanceof VaultPathError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    const msg = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'parent directory missing' : 'write failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
