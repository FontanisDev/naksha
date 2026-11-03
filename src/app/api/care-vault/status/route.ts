/**
 * GET /api/care-vault/status — CareSpace writable-vault state.
 *
 * `designated` is only true when the designation points at the CURRENTLY
 * connected vault's root: connecting a different directory never inherits
 * an old designation. One-shot answer for the panel toggle, the receipts
 * and the command gate.
 */

import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { readConfig } from '@/lib/server/vault';
import { readCareConfig } from '@/lib/server/care-vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const vaultCfg = await readConfig();
  const careCfg = await readCareConfig();
  let vaultAvailable = false;
  if (vaultCfg) {
    const st = await fs.stat(vaultCfg.root).catch(() => null);
    vaultAvailable = !!st?.isDirectory?.();
  }
  const sameRoot = !!vaultCfg && !!careCfg && careCfg.root === vaultCfg.root;
  return NextResponse.json({
    ok: true,
    designated: sameRoot && vaultAvailable,
    designatedFlag: !!careCfg, // raw flag, even when it points elsewhere
    root: sameRoot ? vaultCfg!.root : null,
    name: sameRoot ? vaultCfg!.name : null,
    designatedAt: sameRoot ? careCfg!.designatedAt : undefined,
    vaultConnected: !!vaultCfg,
    vaultAvailable,
  });
}
