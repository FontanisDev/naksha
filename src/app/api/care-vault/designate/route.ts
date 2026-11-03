/**
 * POST /api/care-vault/designate — the explicit ON/OFF switch that lets
 * CareSpace write .md notes into the connected real directory.
 *
 * Body: { on: boolean }
 *  - on=true  requires a connected, available vault; writes db/care-vault.json
 *             pointing at THAT root. A previous designation for another root
 *             is replaced (one designated vault at a time).
 *  - on=false clears the designation file. Connected files are untouched.
 *
 * Turning this on is an explicit user action everywhere (panel toggle or
 * `vault designate on`); nothing designates itself.
 */

import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { readConfig } from '@/lib/server/vault';
import { writeCareConfig } from '@/lib/server/care-vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: { on?: boolean };
  try {
    body = (await req.json()) as { on?: boolean };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body.on !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'body must be { on: boolean }' }, { status: 400 });
  }

  if (!body.on) {
    await writeCareConfig(null);
    return NextResponse.json({ ok: true, designated: false });
  }

  const cfg = await readConfig();
  if (!cfg) {
    return NextResponse.json({ ok: false, error: 'no vault connected — connect a directory first' }, { status: 400 });
  }
  const st = await fs.stat(cfg.root).catch(() => null);
  if (!st?.isDirectory?.()) {
    return NextResponse.json({ ok: false, error: 'connected directory is unavailable' }, { status: 400 });
  }
  await writeCareConfig({ root: cfg.root, name: cfg.name, designatedAt: Date.now() });
  return NextResponse.json({ ok: true, designated: true, root: cfg.root, name: cfg.name });
}
