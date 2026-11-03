/**
 * POST /api/vault/disconnect — drop the connected directory explicitly.
 * Removes the persisted config and stops the watcher. No filesystem
 * data is touched (read-only system).
 */

import { NextResponse } from 'next/server';
import { writeConfig, stopWatching, readConfig } from '@/lib/server/vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const was = await readConfig();
  await writeConfig(null);
  stopWatching();
  return NextResponse.json({ ok: true, previous: was });
}
