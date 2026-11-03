/**
 * GET /api/vault/tree?p=<rel>&max=<n> — flat walk of the real directory
 * (dirs first, name-sorted), the same shape the internal `tree` command
 * prints. Capped to keep huge vaults honest.
 */

import { NextResponse } from 'next/server';
import { readConfig, walkTree, VaultPathError } from '@/lib/server/vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const cfg = await readConfig();
  if (!cfg) return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  const url = new URL(req.url);
  const rel = url.searchParams.get('p') ?? '';
  const max = Math.min(400, Math.max(1, parseInt(url.searchParams.get('max') ?? '200', 10) || 200));
  try {
    const entries = await walkTree(cfg.root, rel, max);
    return NextResponse.json({ ok: true, rel, entries, truncated: entries.length >= max });
  } catch (err) {
    const status = err instanceof VaultPathError ? 400 : 500;
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status });
  }
}
