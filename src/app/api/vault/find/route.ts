/**
 * POST /api/vault/find — the Trilium-style search surface behind
 * `vault find` (v138 T7 round 5: the search-parser port — see
 * lib/server/vault-search.ts for the upstream attribution and the
 * file-backed adaptation notes).
 *
 * READ-ONLY by construction: the walker uses the reader's machinery
 * (listDir + safeResolve + readFile caps) and writes nothing. Like
 * /api/vault/recent and /api/vault/audit, it answers for a
 * merely-CONNECTED vault — searching outside edits is the point.
 *
 * Client sends `{ query, dir?, limit?, fuzzy? }`; the server answers
 * `{ parsed, errors, highlighted, matches, total, scanned, truncated,
 * contentReads }`. A hostile dir (traversal / hidden / non-directory)
 * refuses loudly with 400 — never a silent empty answer; parse errors
 * ride the 200 with the `errors` array (upstream's partial-result
 * behavior: the fulltext half still runs).
 */

import { NextResponse } from 'next/server';
import { readConfig } from '@/lib/server/vault';
import { searchVault, assertSearchQuery } from '@/lib/server/vault-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const cfg = await readConfig();
  if (!cfg) {
    return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    query?: unknown;
    dir?: unknown;
    limit?: unknown;
    fuzzy?: unknown;
  };
  try {
    assertSearchQuery(body.query);
    const result = await searchVault(cfg.root, {
      query: body.query as string,
      dir: typeof body.dir === 'string' && body.dir ? body.dir : undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      fuzzyAttributeSearch: body.fuzzy === true,
    });
    return NextResponse.json({
      ok: true,
      root: cfg.root,
      name: cfg.name,
      ...result,
    });
  } catch (err) {
    const status = (err as Error).name === 'VaultPathError' ? 400 : 500;
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status });
  }
}
