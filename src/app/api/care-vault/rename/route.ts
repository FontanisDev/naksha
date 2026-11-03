/**
 * POST /api/care-vault/rename — rename ONE .md note inside the designated
 * CareSpace vault (the file-identity half of `rennode` in designated mode).
 *
 * Body: { from: string, to: string }
 * Both paths go through the safeResolve jail; the target must not exist.
 * No cross-format renames: both sides must be .md/.markdown.
 */

import { NextResponse } from 'next/server';
import { careVaultGate, renameNote, VaultPathError } from '@/lib/server/care-vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const gate = await careVaultGate();
  if (!gate.ok) {
    return NextResponse.json({ ok: false, error: gate.error }, { status: 403 });
  }
  let body: { from?: string; to?: string };
  try {
    body = (await req.json()) as { from?: string; to?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body.from !== 'string' || typeof body.to !== 'string') {
    return NextResponse.json({ ok: false, error: 'body must be { from, to }' }, { status: 400 });
  }
  try {
    const r = await renameNote(gate.root!, body.from, body.to);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    if (err instanceof VaultPathError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: 'rename failed' }, { status: 500 });
  }
}
