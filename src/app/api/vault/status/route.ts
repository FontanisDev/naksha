/**
 * GET /api/vault/status — the vault's live state: connected?, root exists?,
 * counts. Every UI surface that shows vault context reads THIS, so a
 * vault deleted externally flips to "unavailable" everywhere.
 */

import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { readConfig, watcherInfo, getCachedCounts, refreshCountsInBackground, COUNT_TTL } from '@/lib/server/vault';
import { readCareConfig } from '@/lib/server/care-vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* Task 120 — counts never block this endpoint. Status polls (45s heartbeat
 * × every open panel, plus doctor checks) serve the LAST-KNOWN counts
 * instantly and re-arm a single shared background walk when the TTL has
 * lapsed. The pre-Task-120 design walked the whole tree on the request
 * path whenever the cache was cold/stale — cycle 11's /home incident
 * rendered this route at 14–20s and the churn OOM-killed the dev server.
 * Counts are advisory chrome — availability/careVault stay live on every
 * call; external writes surface within one poll tick. */

export async function GET() {
  const cfg = await readConfig();
  if (!cfg) {
    return NextResponse.json({
      ok: true,
      connected: false,
      available: false,
      root: null,
      name: null,
      mdCount: 0,
      fileCount: 0,
      careVault: false,
    });
  }
  const st = await fs.stat(cfg.root).catch(() => null);
  const available = !!st?.isDirectory?.();
  /* Phase 5 — the designation counts only when it points at THIS root
   * and the directory is actually there (same rule as the write gate). */
  const careCfg = await readCareConfig();
  const careVault = available && !!careCfg && careCfg.root === cfg.root;
  let mdCount = 0;
  let fileCount = 0;
  if (available) {
    const cached = getCachedCounts(cfg.root);
    if (cached) {
      mdCount = cached.mdCount;
      fileCount = cached.fileCount;
    }
    /* Stale or first-ever poll → one shared background walk. The request
     * itself never waits on it; the next poll (or the panel's refresh)
     * serves the landed numbers. */
    if (!cached || Date.now() - cached.at >= COUNT_TTL) {
      refreshCountsInBackground(cfg.root);
    }
  }
  return NextResponse.json({
    ok: true,
    connected: true,
    available,
    root: cfg.root,
    name: cfg.name,
    mdCount,
    fileCount,
    careVault,
    connectedAt: cfg.connectedAt,
    /* Phase 7 — `vault doctor` and the panel read the watcher's honest
     * live state from the same status call. */
    watch: watcherInfo(),
  });
}
