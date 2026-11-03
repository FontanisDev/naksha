/**
 * POST /api/vault/connect — explicitly connect a REAL directory as the
 * read-only vault. The only route that accepts a user-supplied absolute
 * path, and it validates hard through validateVaultRoot (Phase 7):
 * absolute, not the filesystem root, exists, is a directory.
 */

import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { readConfig, writeConfig, startWatching, validateVaultRoot, VaultPathError, refreshCountsInBackground, warmCountsFromSnapshot } from '@/lib/server/vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { path?: string };
    const input = typeof body.path === 'string' ? body.path : '';
    const root = validateVaultRoot(input); // throws VaultPathError with the clear reason
    const st = await fs.stat(root).catch(() => null);
    if (!st) {
      return NextResponse.json({ ok: false, error: `no such directory: ${root}` }, { status: 400 });
    }
    if (!st.isDirectory()) {
      return NextResponse.json({ ok: false, error: `not a directory: ${root}` }, { status: 400 });
    }
    const cfg = { root, name: root.split('/').filter(Boolean).pop() || root, connectedAt: Date.now() };
    await writeConfig(cfg);
    await startWatching();
    /* Task 120 — the watcher's fresh snapshot yields honest counts for
     * free (the receipt's first status read must not race a walk); the
     * canonical buildIndex warm follows in the background. */
    warmCountsFromSnapshot();
    refreshCountsInBackground(root);
    return NextResponse.json({ ok: true, vault: cfg });
  } catch (err) {
    if (err instanceof VaultPathError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'connect failed' },
      { status: 500 },
    );
  }
}

export async function GET() {
  const cfg = await readConfig();
  return NextResponse.json({ ok: true, vault: cfg });
}
