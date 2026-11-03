/**
 * Naksha — nano PTY bridge (Phase 6 mini-service, port 3005)
 *
 * The REAL nano binary over a real PTY, spawned inside the CONNECTED
 * vault directory. One WebSocket connection = one nano session.
 *
 * RUNTIME NOTE (probed honestly, Phase 6): this service runs on NODE,
 * not bun. Evidence from this environment:
 *   - node-pty@1.1.0 + bun: spawn "succeeds" but interactive children
 *     are SIGHUPed within milliseconds (echo worked; nano died silently
 *     with signal=1 every time — probed with isolated scripts).
 *   - node-pty@1.0.0 + bun: native addon fails to load (V8 symbol
 *     lookup error).
 *   - node-pty@1.1.0 + node v24: nano paints its alt-screen and stays
 *     alive — the combo this service ships on.
 * `bun run dev` still works as the entry point (it executes the script
 * below, which is node); the keeper uses `node --watch` for file-change
 * restarts. Everything else follows the mini-service contract.
 *
 * Why this exists (Phase 6 spec, path 1): the terminal's `nano <file>`
 * must edit the REAL file when the connected context is active. The
 * browser never touches paths or bytes directly — it speaks this small
 * JSON protocol; the service is the only writer.
 *
 * Jail model (layered):
 *   1. The vault root comes from the app's own db/vault.json — the same
 *      file /api/vault/* reads. No config, no session.
 *   2. The rel path is normalized, resolved against the root and checked
 *      for containment (same semantics as lib/server/vault.ts
 *      safeResolve, INCLUDING the realpath containment of the nearest
 *      existing ancestor, so an on-disk symlink cannot hop outside).
 *      Deliberately re-implemented here instead of imported: this service
 *      is a standalone project by contract (mini-services), and the
 *      duplication is small and commented.
 *   3. nano is spawned as `nano -R <rel>` — RESTRICTED mode — with cwd
 *      = the vault root and a RELATIVE path argument. Restricted nano
 *      refuses reads/writes outside its working directory, refuses
 *      dotfiles, refuses suspension/spell. Even nano's own "save as"
 *      stays inside the jail.
 *   4. Hidden files (dot segments) are refused before spawn — consistent
 *      with the reader, which never lists them.
 *   5. CREATE-IF-MISSING is gated: a rel that does not exist yet may only
 *      be opened when the vault is DESIGNATED as the CareSpace vault
 *      (db/care-vault.json pointing at the SAME root) — the same writable
 *      flag every CareSpace write goes through (Phase 5).
 *
 * Session lifecycle (JSON text frames):
 *   C→S  {type:'open',   rel, cols, rows}   once per socket
 *   S→C  {type:'opened', rel, existed, name, root}
 *   S→C  {type:'data',   data}               terminal bytes (UTF-8 strings)
 *   C→S  {type:'data',   data}               keystrokes / paste
 *   C→S  {type:'resize', cols, rows}
 *   C→S  {type:'kill'}                       SIGKILL — buffer lost, honest
 *   S→C  {type:'exited', code, killed?}      then the socket closes
 *   S→C  {type:'refused', error}             before any spawn, then close
 *
 * If the socket dies mid-session (tab closed, network gone) the pty is
 * SIGKILLed: nano cannot save an unattended buffer anyway, and SIGKILL
 * cannot be intercepted, so no .save spill files appear.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const PORT = 3005;
// This file lives at <project>/mini-services/nano-pty/index.ts.
const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const ROOT_DB = path.join(PROJECT_ROOT, 'db');
const NANO_HOME = '/tmp/naksha-nano-home'; // nano rc/history stay OUT of the vault

/* ── the app's own vault config (db/vault.json + db/care-vault.json) ── */

interface VaultCfg { root: string; name?: string }
async function readJsonCfg(file: string): Promise<VaultCfg | null> {
  try {
    const raw = await fs.readFile(path.join(ROOT_DB, file), 'utf8');
    const cfg = JSON.parse(raw) as VaultCfg;
    if (cfg && typeof cfg.root === 'string' && cfg.root.startsWith('/')) return cfg;
    return null;
  } catch {
    return null;
  }
}

class Refused extends Error {}

/** Containment (mirrors lib/server/vault.ts safeResolve semantics):
 *  resolve → root-jail → realpath jail on the nearest existing ancestor. */
async function jailResolve(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string' || !rel.trim()) throw new Refused('missing path');
  if (rel.includes('\0')) throw new Refused('invalid path');
  const norm = path.normalize(rel);
  if (path.isAbsolute(norm)) throw new Refused('path must be relative to the vault root');
  // argv-injection guard: nano receives this rel as ONE argv element — a
  // leading `-` would parse as an OPTION cluster (`-B`, `-o`, …), not a
  // filename. Refused here AND in the app's safeResolve (same dialect).
  if (norm.startsWith('-')) throw new Refused("path looks like an option — leading '-' is refused");
  const abs = path.resolve(root, norm);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Refused('path escapes the connected directory');
  }
  for (const seg of norm.split(path.sep)) {
    if (seg.startsWith('.')) throw new Refused('hidden files stay out of the vault');
  }
  // realpath containment on the target or its nearest existing ancestor.
  try {
    const realRoot = await fs.realpath(root);
    let probe = abs;
    for (let i = 0; i < 8; i++) {
      try {
        const real = await fs.realpath(probe);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          throw new Refused('path escapes the connected directory');
        }
        return abs;
      } catch (err) {
        if (err instanceof Refused) throw err;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          const parent = path.dirname(probe);
          if (parent === probe) break;
          probe = parent;
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof Refused) throw err;
    // realpath on the root itself failed — the vault vanished; refuse.
    throw new Refused('connected directory is unavailable');
  }
  return abs;
}

function normRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '');
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : NaN;
  return Number.isNaN(n) ? dflt : Math.min(hi, Math.max(lo, n));
}

async function openSession(rel: string, cols: number, rows: number): Promise<{
  proc: pty.IPty; existed: boolean; root: string; name: string;
}> {
  const vault = await readJsonCfg('vault.json');
  if (!vault) throw new Refused('no vault connected — vault connect <absolute path> first');
  const st = await fs.stat(vault.root).catch(() => null);
  if (!st?.isDirectory?.()) throw new Refused('connected directory is unavailable');

  const abs = await jailResolve(vault.root, rel);
  let existed = false;
  try {
    const t = await fs.stat(abs);
    if (!t.isFile()) throw new Refused('is a directory');
    existed = true;
  } catch (err) {
    if (err instanceof Refused) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Refused('stat failed on the target path');
  }
  if (!existed) {
    // Phase 6 create-gate: creating real files is allowed ONLY while the
    // vault is designated as the CareSpace vault (same root, available).
    const care = await readJsonCfg('care-vault.json');
    if (!care || care.root !== vault.root) {
      throw new Refused(
        'no such file — creating real files needs a designated CareSpace vault (vault designate on)',
      );
    }
  }

  const c = clampInt(cols, 8, 500, 80);
  const r = clampInt(rows, 4, 200, 24);
  await fs.mkdir(NANO_HOME, { recursive: true, mode: 0o700 }).catch(() => {});

  // -R restricted (jail: no reads/writes outside cwd, no dotfiles, no
  // suspend/spell). -I ignores ALL nanorc files: /etc/nanorc on this
  // host enables `set locking`, which litters .file.swp lockfiles into
  // the vault and SIGKILLed sessions would leave STALE locks behind
  // (every later open then stalls on an "open anyway?" prompt). -I also
  // makes the embedded editor deterministic — same UI everywhere.
  const proc = pty.spawn('nano', ['-R', '-I', normRel(rel)], {
    name: 'xterm-256color',
    cols: c,
    rows: r,
    cwd: vault.root,
    env: {
      TERM: 'xterm-256color',
      LANG: process.env.LANG ?? 'C.UTF-8',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: NANO_HOME,
      NAKSHA_VAULT_ROOT: vault.root,
    } as Record<string, string>,
  });
  return { proc, existed, root: vault.root, name: vault.name ?? 'vault' };
}

/* ── the server (node http + ws — see the runtime note above) ──────── */

interface Session {
  proc: pty.IPty | null;
  open: boolean;   // 'open' frame accepted
  killed: boolean; // client asked for a kill (receipt honesty)
  alive: boolean;  // sockets where nano lives
}

/** Live ptys — SIGKILLed on shutdown so a restart never leaves
 *  unattended editors behind. */
const live = new Set<pty.IPty>();

const httpServer = http.createServer((req, res) => {
  // Plain HTTP: a tiny health/readable-by-curl card.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    service: 'naksha-nano-pty',
    runtime: 'node',
    ws: 'connect with WebSocket upgrade on /',
  }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

httpServer.on('upgrade', (req, socket, head) => {
  // The gateway forwards ANY path with ?XTransformPort=3005; accept the
  // upgrade regardless of path/query shape.
  wss.handleUpgrade(req, socket as never, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws: import('ws').WebSocket) => {
  const session: Session = { proc: null, open: false, killed: false, alive: true };
  log('client connected');

  ws.on('message', (rawBuf, isBinary) => {
    if (isBinary) return;
    const raw = String(rawBuf);
    if (raw.length > 1024 * 1024) return;
    let msg: { type?: string; rel?: unknown; cols?: unknown; rows?: unknown; data?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!session.open) {
      if (msg.type !== 'open') return;
      session.open = true;
      const rel = typeof msg.rel === 'string' ? msg.rel : '';
      openSession(rel, msg.cols as number, msg.rows as number)
        .then(({ proc, existed, root, name }) => {
          if (!session.alive) {
            // Socket died while the session was being opened.
            try { proc.kill('SIGKILL'); } catch { /* already dead */ }
            return;
          }
          session.proc = proc;
          live.add(proc);
          send(ws, { type: 'opened', rel: normRel(rel), existed, name, root });
          proc.onData((data) => {
            send(ws, { type: 'data', data });
          });
          proc.onExit(({ exitCode }) => {
            live.delete(proc);
            session.proc = null;
            send(ws, { type: 'exited', code: exitCode, killed: session.killed });
            try { ws.close(1000, 'session ended'); } catch { /* already closed */ }
            log(`session ended rel=${normRel(rel)} code=${exitCode} killed=${session.killed}`);
          });
          log(`session opened rel=${normRel(rel)} existed=${existed} root=${root}`);
        })
        .catch((err) => {
          const reason = err instanceof Refused ? err.message : 'failed to start nano';
          send(ws, { type: 'refused', error: reason });
          try { ws.close(1000, 'refused'); } catch { /* already closed */ }
          log(`refused rel=${rel}: ${reason}`);
        });
      return;
    }

    // Session established — keystrokes, resize, kill.
    if (msg.type === 'data' && typeof msg.data === 'string') {
      if (msg.data.length > 256 * 1024) return; // paste sanity cap
      try { session.proc?.write(msg.data); } catch { /* raced exit */ }
      return;
    }
    if (msg.type === 'resize') {
      const c = clampInt(msg.cols, 8, 500, 80);
      const r = clampInt(msg.rows, 4, 200, 24);
      try { session.proc?.resize(c, r); } catch { /* raced exit */ }
      return;
    }
    if (msg.type === 'kill') {
      session.killed = true;
      try { session.proc?.kill('SIGKILL'); } catch { /* already dead */ }
      // SIGKILL cannot be handled → no .save spill; buffer honestly lost.
    }
  });

  ws.on('close', () => {
    session.alive = false;
    // Browser gone → nano unattended → SIGKILL (cannot be handled, no
    // .save spill files). The receipt side of this tradeoff lives in
    // the client: "session lost — unsaved buffer gone".
    if (session.proc) {
      try { session.proc.kill('SIGKILL'); } catch { /* already dead */ }
      live.delete(session.proc);
      session.proc = null;
    }
    log('client disconnected');
  });

  ws.on('error', () => {
    /* close follows */
  });
});

function send(ws: import('ws').WebSocket, obj: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* socket raced close — the close handler reaps the pty */
  }
}

function log(msg: string): void {
  console.log(`[nano-pty ${new Date().toISOString()}] ${msg}`);
}

// Clean shutdown: take the children with us (--watch restarts us anyway).
function killAll(): void {
  for (const proc of live) {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }
  live.clear();
}
process.on('SIGINT', () => { killAll(); process.exit(0); });
process.on('SIGTERM', () => { killAll(); process.exit(0); });

httpServer.listen(PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${PORT} (loopback only — the Caddy gateway is the exposure surface; db at ${ROOT_DB}, runtime node ${process.version})`);
});
