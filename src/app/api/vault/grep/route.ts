/**
 * GET /api/vault/grep?q=<pattern>&p=<rel>&max=<n> — search the REAL
 * files of the connected directory (Phase 4: `grep` joins the vault-
 * routed read verbs). Semantics mirror the internal FileSystem.grep:
 * case-insensitive regex over file lines, 1-based line numbers.
 *
 * Read-only by construction: walks with the same walkTree machinery
 * the tree uses, reads through readFile (which refuses binary and
 * >2MB files), and never writes anything.
 */

import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import {
  readConfig,
  safeResolve,
  readFile,
  listDir,
  walkTree,
  VaultPathError,
} from '@/lib/server/vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_MAX = 100;
const HARD_MAX = 200;
const GREP_FILE_CAP = 400; // entries walked per search

interface GrepMatch {
  rel: string;
  line: number;
  text: string;
}

export async function GET(req: Request) {
  const cfg = await readConfig();
  if (!cfg) return NextResponse.json({ ok: false, error: 'no vault connected' }, { status: 409 });
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const rel = url.searchParams.get('p') ?? '';
  const max = Math.min(HARD_MAX, Math.max(1, parseInt(url.searchParams.get('max') ?? String(DEFAULT_MAX), 10) || DEFAULT_MAX));
  if (!q) return NextResponse.json({ ok: false, error: 'q (pattern) required' }, { status: 400 });

  let regex: RegExp;
  try {
    regex = new RegExp(q, 'i');
  } catch (err) {
    return NextResponse.json({ ok: false, error: `Invalid pattern: ${(err as Error).message}` }, { status: 400 });
  }

  try {
    const root = cfg.root;
    const abs = await safeResolve(root, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st) throw new VaultPathError('no such file or directory');

    const matches: GrepMatch[] = [];
    let truncated = false;

    const scanFile = async (fileRel: string, surfaceError = false): Promise<void> => {
      if (matches.length >= max) { truncated = true; return; }
      try {
        const result = await readFile(root, fileRel);
        const lines = result.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({ rel: fileRel, line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (matches.length >= max) { truncated = true; return; }
          }
        }
      } catch (err) {
        /* binary / over-cap / unreadable — skipped honestly, never faked;
         * a REFUSAL on the directly-named file is surfaced (Phase 7: the
         * user asked for THAT path — a silent "0 matches" would lie). */
        if (surfaceError && err instanceof VaultPathError) throw err;
      }
    };

    if (st.isFile()) {
      await scanFile(rel, true);
    } else {
      // Directory walk: the flat tree (dirs first, capped) is the scan order.
      const entries = await walkTree(root, rel, GREP_FILE_CAP);
      for (const e of entries) {
        if (matches.length >= max) break;
        if (e.isDir) continue;
        await scanFile(e.rel);
      }
      truncated = truncated || entries.length >= GREP_FILE_CAP;
      // A miss on a NON-directory path should say so honestly — listDir
      // throws 'not a directory' for files-as-dirs; an empty real dir
      // legitimately yields zero matches.
      if (matches.length === 0) await listDir(root, rel);
    }

    return NextResponse.json({ ok: true, q, p: rel, matches, truncated });
  } catch (err) {
    const status = err instanceof VaultPathError ? 400 : 500;
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status });
  }
}
