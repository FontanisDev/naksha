/**
 * GET /api/vault/resolve?q=<wikilink or rel path> — map an Obsidian-style
 * link ([[Note]], [[Folder/Note]], [[Note|alias]]) to a REAL file inside
 * the vault, or null. Never resolves outside the root.
 */

import { NextResponse } from 'next/server';
import { readConfig, resolveLink, VaultPathError } from '@/lib/server/vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const cfg = await readConfig();
  if (!cfg) return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  const q = new URL(req.url).searchParams.get('q') ?? '';
  if (!q) return NextResponse.json({ ok: false, error: 'q required' }, { status: 400 });
  try {
    const rel = await resolveLink(cfg.root, q);
    return NextResponse.json({ ok: true, q, rel });
  } catch (err) {
    const status = err instanceof VaultPathError ? 400 : 500;
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status });
  }
}
