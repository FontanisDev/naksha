/**
 * Naksha — Phase 7 SECURITY PROBE (run: bun scripts/security-probe.ts)
 *
 * Live verification of the vault jail, against the REAL services:
 *   - Next.js API (http://127.0.0.1:3000/api/...)   — the reader + care-vault writer
 *   - nano-pty bridge (ws://127.0.0.1:3005)          — the only real-write surface
 *
 * Probe classes:
 *   A. traversal (`../`, encoded, absolute smuggle, tree/list/grep variants)
 *   B. symlink escape (file symlink + directory symlink, targets outside)
 *   C. hidden-dotfile policy (reads, writes, listing, WS jail)
 *   D. argv-option smuggling (leading `-` on every path-bearing surface)
 *   E. null bytes / exotic encodings
 *   F. capability gates (care-vault write requires designation; reader is
 *      GET-only — POST must 405; create-gate on the WS jail flips with it)
 *   G. positive controls (legit reads/writes/opens MUST still work —
 *      a jail that refuses everything is a bug, not a feature)
 *
 * The script builds its fixtures INSIDE the currently connected vault
 * (symlinks pointing outside, one control file) and RESTORES state:
 * designation flag, fixture files, nothing else. Exit 1 on any FAIL.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const NEXT = 'http://127.0.0.1:3000';
const PTY_WS = 'ws://127.0.0.1:3005';

const vaultCfg = JSON.parse(await fs.readFile('db/vault.json', 'utf8')) as { root: string; name: string };
const ROOT = vaultCfg.root;
const OUTSIDE_DIR = '/tmp/naksha-sec-outside';

let failures = 0;
let passes = 0;
const results: Array<{ id: string; ok: boolean; note: string }> = [];

function record(id: string, ok: boolean, note: string): void {
  if (ok) passes++;
  else failures++;
  results.push({ id, ok, note });
  console.log(`${ok ? '  PASS' : '✗ FAIL'}  ${id.padEnd(34)} ${note}`);
}

/* ── fixture setup ─────────────────────────────────────────────────── */

const careBefore = await fs
  .readFile('db/care-vault.json', 'utf8')
  .then((raw) => JSON.parse(raw) as { root: string })
  .catch(() => null);

await fs.mkdir(OUTSIDE_DIR, { recursive: true });
await fs.writeFile(path.join(OUTSIDE_DIR, 'secret.txt'), 'OUTSIDE-SECRET\n', 'utf8');
// file symlink pointing at a file OUTSIDE the vault
await fs.rm(path.join(ROOT, 'sec-link-file.md'), { force: true });
await fs.symlink('/etc/hostname', path.join(ROOT, 'sec-link-file.md'));
// directory symlink pointing OUTSIDE the vault
await fs.rm(path.join(ROOT, 'sec-link-dir'), { force: true, recursive: true });
await fs.symlink(OUTSIDE_DIR, path.join(ROOT, 'sec-link-dir'));
// a REAL dotfile so the hidden-refusal (not "no such file") is exercised
await fs.writeFile(path.join(ROOT, '.hidden-probe.md'), 'HIDDEN-CONTENT\n', 'utf8');

async function designate(on: boolean): Promise<void> {
  const res = await fetch(`${NEXT}/api/care-vault/designate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on }),
  });
  const j = (await res.json()) as { ok: boolean };
  if (!j.ok) throw new Error(`designate(${on}) failed — probe env broken`);
}

/* ── HTTP helper ───────────────────────────────────────────────────── */

async function get(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { cache: 'no-store' });
  return { status: res.status, body: await res.text() };
}

interface HttpCase {
  id: string;
  url: string;
  method?: string;
  body?: unknown;
  expect: (status: number, body: string) => boolean;
  why: string;
}

const httpCases: HttpCase[] = [
  {
    id: 'A1 read ../ traversal',
    url: `${NEXT}/api/vault/read?p=../../../../etc/passwd`,
    expect: (s, b) => s === 400 && b.includes('path escapes'),
    why: 'lexical `..` chain must be refused with the clear reason',
  },
  {
    id: 'A2 read %2e%2e encoded traversal',
    url: `${NEXT}/api/vault/read?p=%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
    expect: (s, b) => s === 400 && b.includes('path escapes'),
    why: 'percent-encoded traversal decodes to the same refusal',
  },
  {
    id: 'A3 read absolute smuggle /etc/passwd',
    url: `${NEXT}/api/vault/read?p=/etc/passwd`,
    expect: (s, b) => s === 400 && b.includes('path escapes'),
    why: 'path.resolve(root, "/abs") lands outside → refused',
  },
  {
    id: 'B1 read file-symlink outside',
    url: `${NEXT}/api/vault/read?p=sec-link-file.md`,
    expect: (s, b) => s === 400 && b.includes('path escapes'),
    why: 'realpath containment refuses symlinked file → /etc/hostname',
  },
  {
    id: 'B2 read dir-symlink child outside',
    url: `${NEXT}/api/vault/read?p=sec-link-dir/secret.txt`,
    expect: (s, b) => s === 400 && b.includes('path escapes'),
    why: 'realpath containment refuses symlinked dir → /tmp/…',
  },
  {
    id: 'C1 read hidden .hidden-probe.md',
    url: `${NEXT}/api/vault/read?p=.hidden-probe.md`,
    expect: (s, b) => s === 400 && b.toLowerCase().includes('hidden'),
    why: 'dotfile reads refuse with the shared message',
  },
  {
    id: 'D1 read leading-dash -dash.md',
    url: `${NEXT}/api/vault/read?p=-dash-probe.md`,
    expect: (s, b) => s === 400 && b.includes('option'),
    why: "leading '-' refused on every path surface (argv dialect)",
  },
  {
    id: 'E1 read null byte deep%00.md',
    url: `${NEXT}/api/vault/read?p=deep%00.md`,
    expect: (s, b) => s === 400 && (b.includes('invalid path') || b.includes('no such')),
    why: 'null bytes never reach the filesystem layer',
  },
  {
    id: 'A4 tree ../..',
    url: `${NEXT}/api/vault/tree?p=../..`,
    expect: (s, b) => s === 400 && b.includes('path escapes'),
    why: 'tree walk jailed like every other read verb',
  },
  {
    id: 'A5 list ..',
    url: `${NEXT}/api/vault/list?p=..`,
    expect: (s, b) => s === 400 && b.includes('path escapes'),
    why: 'list of the parent dir refused',
  },
  {
    id: 'A6 list hidden .git',
    url: `${NEXT}/api/vault/list?p=.git`,
    expect: (s, b) => s === 400 && b.toLowerCase().includes('hidden'),
    why: 'explicit probes of dot dirs refuse (listing never shows them)',
  },
  {
    id: 'A7 grep traversal pattern',
    url: `${NEXT}/api/vault/grep?q=root&p=../../../../etc/passwd`,
    expect: (s, b) => s === 400 && b.includes('path escapes'),
    why: 'grep target jailed',
  },
  {
    id: 'A8 grep single hidden file',
    url: `${NEXT}/api/vault/grep?q=x&p=.hidden-probe.md`,
    expect: (s, b) => s === 400 && b.toLowerCase().includes('hidden'),
    why: 'single-file grep surfaces the refusal (no silent 0 matches)',
  },
  {
    id: 'A9 resolve traversal query → null',
    url: `${NEXT}/api/vault/resolve?q=../../etc/passwd`,
    expect: (s, b) => s === 200 && /"rel":null/.test(b),
    why: 'wikilink resolver only ever returns indexed in-root files',
  },
  {
    id: 'F1 POST on GET-only reader → 405',
    url: `${NEXT}/api/vault/read?p=README.md`,
    method: 'POST',
    expect: (s) => s === 405,
    why: 'reader surface has no write capability anywhere',
  },
  {
    id: 'F2 POST on GET-only tree → 405',
    url: `${NEXT}/api/vault/tree?p=`,
    method: 'POST',
    expect: (s) => s === 405,
    why: 'same audit, tree route',
  },
  {
    id: 'F3 care write ../escape.md → refused',
    url: `${NEXT}/api/care-vault/write`,
    method: 'POST',
    body: { rel: '../escape.md', content: 'nope' },
    expect: (s, b) => s === 403 || (s === 400 && (b.includes('escapes') || b.toLowerCase().includes('hidden'))),
    why: 'writer jail refuses traversal (designation currently ON)',
  },
  {
    id: 'C2 care write .evil.md → refused',
    url: `${NEXT}/api/care-vault/write`,
    method: 'POST',
    body: { rel: '.evil.md', content: 'nope' },
    expect: (s, b) => s === 403 || (s === 400 && b.toLowerCase().includes('hidden')),
    why: 'writer refuses dotfiles like every other surface',
  },
  {
    id: 'D2 care write -x.md → refused',
    url: `${NEXT}/api/care-vault/write`,
    method: 'POST',
    body: { rel: '-x.md', content: 'nope' },
    expect: (s, b) => s === 403 || (s === 400 && b.includes('option')),
    why: "writer refuses leading '-' paths",
  },
  {
    id: 'F4 care write .txt ext → refused',
    url: `${NEXT}/api/care-vault/write`,
    method: 'POST',
    body: { rel: 'sec-write-control.txt', content: 'nope' },
    expect: (s, b) => s === 403 || (s === 400 && b.includes('.md')),
    why: 'writer is .md/.markdown-only',
  },
  {
    id: 'F5 care rename scratch.txt → refused',
    url: `${NEXT}/api/care-vault/rename`,
    method: 'POST',
    body: { from: 'scratch.txt', to: 'sec-renamed.md' },
    expect: (s, b) => s === 403 || (s === 400 && b.includes('.md')),
    why: 'rename is note-to-note, never cross-format',
  },
  /* positive controls — the jail must stay usable */
  {
    id: 'G1 read README.md (control)',
    url: `${NEXT}/api/vault/read?p=README.md`,
    expect: (s, b) => s === 200 && b.includes('"ok":true'),
    why: 'legit reads still work',
  },
  {
    id: 'G2 list root (control)',
    url: `${NEXT}/api/vault/list?p=`,
    expect: (s, b) => s === 200 && b.includes('"ok":true'),
    why: 'legit listing still works',
  },
  {
    id: 'G3 status carries watch info',
    url: `${NEXT}/api/vault/status`,
    expect: (s, b) => s === 200 && b.includes('"watch"'),
    why: 'doctor data source exists',
  },
];

console.log(`\n== Naksha Phase 7 security probe ==`);
console.log(`vault: ${ROOT}  (name=${vaultCfg.name})\n`);

for (const c of httpCases) {
  try {
    let body = '';
    let status = 0;
    if (c.method === 'POST') {
      const res = await fetch(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c.body ?? {}),
      });
      status = res.status;
      body = await res.text();
    } else {
      ({ status, body } = await get(c.url));
    }
    record(c.id, c.expect(status, body), c.why);
  } catch (err) {
    record(c.id, false, `transport error: ${(err as Error).message}`);
  }
}

/* care-vault write positive control (designation is ON per db state) */
try {
  const res = await fetch(`${NEXT}/api/care-vault/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rel: 'sec-write-control.md', content: 'phase 7 control\n' }),
  });
  const j = (await res.json()) as { ok: boolean; created?: boolean };
  record('G4 care write control .md → ok', j.ok === true, 'legit designated write works');
  await fs.rm(path.join(ROOT, 'sec-write-control.md'), { force: true }); // fixture cleanup
} catch (err) {
  record('G4 care write control .md → ok', false, (err as Error).message);
}

/* care-vault write gate probe with designation OFF (restored afterwards) */
await designate(false);
try {
  const res = await fetch(`${NEXT}/api/care-vault/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rel: 'sec-gate-off.md', content: 'nope' }),
  });
  const j = (await res.json()) as { ok: boolean; error?: string };
  record('F6 care write w/ designation OFF → 403', res.status === 403 && !j.ok, j.error ?? '');
} catch (err) {
  record('F6 care write w/ designation OFF → 403', false, (err as Error).message);
}
await designate(careBefore ? true : false); // restore BEFORE the WS section so the create-gate probes see the real state

/* ── WS jail probes (nano-pty :3005, the ONLY real-write surface) ──── */

interface WsVerdict { event: 'refused' | 'opened' | 'timeout'; detail: string }

function wsProbe(payload: Record<string, unknown>, extra: 'kill' | null = null, timeoutMs = 4000): Promise<WsVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: WsVerdict) => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch { /* already */ }
        resolve(v);
      }
    };
    const timer = setTimeout(() => done({ event: 'timeout', detail: 'no verdict in time' }), timeoutMs);
    const ws = new WebSocket(PTY_WS);
    ws.onopen = () => ws.send(JSON.stringify(payload));
    ws.onmessage = (ev) => {
      let msg: { type?: string; error?: string; existed?: boolean; killed?: boolean };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === 'refused') {
        clearTimeout(timer);
        done({ event: 'refused', detail: msg.error ?? '' });
      } else if (msg.type === 'opened') {
        clearTimeout(timer);
        if (extra === 'kill') {
          ws.send(JSON.stringify({ type: 'kill' }));
          // wait briefly for exited, then settle anyway
          setTimeout(() => done({ event: 'opened', detail: `exited:${msg.existed ? 'existing' : 'new'} (killed)` }), 600);
        } else {
          done({ event: 'opened', detail: `existed=${msg.existed}` });
        }
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done({ event: 'timeout', detail: 'socket error' });
    };
  });
}

async function wsCase(id: string, rel: string, want: 'refused' | 'opened', extra: 'kill' | null = null, note = ''): Promise<void> {
  const v = await wsProbe({ type: 'open', rel, cols: 80, rows: 24 }, extra);
  record(id, v.event === want, `${v.event}: ${v.detail || note}`);
}

console.log('\n-- WS jail (nano-pty :3005) --');
await wsCase('W1 ws ../../etc/passwd', '../../etc/passwd', 'refused');
await wsCase('W2 ws absolute /etc/passwd', '/etc/passwd', 'refused');
await wsCase('W3 ws hidden .hidden-probe.md', '.hidden-probe.md', 'refused');
await wsCase('W4 ws leading-dash -dash.md', '-dash-probe.md', 'refused');
await wsCase('W5 ws file-symlink outside', 'sec-link-file.md', 'refused');
await wsCase('W6 ws dir-symlink child', 'sec-link-dir/secret.txt', 'refused');
await wsCase('W7 ws null byte', 'deep\0.md', 'refused');
await wsCase('G5 ws open scratch.txt (control)', 'scratch.txt', 'opened', null, 'legit open works');
await wsCase('G6 ws create-gate ON: missing file opens', 'sec-new-create.md', 'opened', 'kill');

await designate(false);
await wsCase('F7 ws create-gate OFF: missing refused', 'sec-new-create-2.md', 'refused');
await designate(careBefore ? true : false); // restore the pre-probe designation state

/* ── cleanup + verdict ─────────────────────────────────────────────── */

await fs.rm(path.join(ROOT, 'sec-link-file.md'), { force: true });
await fs.rm(path.join(ROOT, 'sec-link-dir'), { force: true, recursive: true });
await fs.rm(path.join(ROOT, '.hidden-probe.md'), { force: true });
await fs.rm(path.join(ROOT, 'sec-new-create.md'), { force: true }); // in case nano flushed a buffer before the kill
await fs.rm(OUTSIDE_DIR, { force: true, recursive: true });

console.log(`\n== verdict: ${passes} passed, ${failures} failed ==`);
process.exit(failures ? 1 : 0);
