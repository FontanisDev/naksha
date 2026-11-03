/**
 * POST /api/care-vault/check — existence probe for bound note paths
 * (the broken-note detector behind the tree/graph ⚠ markers).
 *
 * Body: { rels: string[] } (≤200 — capped server-side)
 * Returns { exists: Record<rel, boolean> }. Read-only; runs through the
 * same safeResolve jail as every other route. Missing paths report false —
 * the UI must never invent content for them.
 */

import { NextResponse } from 'next/server';
import { careVaultGate, checkPaths } from '@/lib/server/care-vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const gate = await careVaultGate();
  if (!gate.ok) {
    // Not designated → nothing is "checked"; the UI clears its markers.
    return NextResponse.json({ ok: false, error: gate.error, exists: {} }, { status: 403 });
  }
  let body: { rels?: string[] };
  try {
    body = (await req.json()) as { rels?: string[] };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body', exists: {} }, { status: 400 });
  }
  const r = await checkPaths(gate.root!, body.rels ?? []);
  return NextResponse.json({ ok: true, ...r });
}
