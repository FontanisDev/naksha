/**
 * GET /api/vault/read?p=<rel> — read a REAL file's text content.
 * GET-only: the reader has no write capability anywhere in the stack.
 */

import { NextResponse } from 'next/server';
import { readConfig, readFile, VaultPathError } from '@/lib/server/vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const cfg = await readConfig();
  if (!cfg) return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  const rel = new URL(req.url).searchParams.get('p') ?? '';
  if (!rel) return NextResponse.json({ ok: false, error: 'p required' }, { status: 400 });
  try {
    const result = await readFile(cfg.root, rel);
    return NextResponse.json({ ok: true, ...result, vault: cfg.name });
  } catch (err) {
    const status = err instanceof VaultPathError ? 400 : 500;
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status });
  }
}
