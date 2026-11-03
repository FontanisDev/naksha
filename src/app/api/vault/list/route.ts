/**
 * GET /api/vault/list?p=<rel> — list a directory inside the vault.
 * Read-only; traversal outside the root is refused by safeResolve.
 */

import { NextResponse } from 'next/server';
import { readConfig, listDir, VaultPathError } from '@/lib/server/vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const cfg = await readConfig();
  if (!cfg) return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  const rel = new URL(req.url).searchParams.get('p') ?? '';
  try {
    const entries = await listDir(cfg.root, rel);
    return NextResponse.json({ ok: true, rel, entries });
  } catch (err) {
    const status = err instanceof VaultPathError ? 400 : 500;
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status });
  }
}
