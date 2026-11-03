'use client';

/**
 * Naksha — NanoPty (Phase 6)
 *
 * REAL nano over the PTY bridge: this overlay hosts an xterm.js terminal
 * wired to the nano-pty mini-service (one WebSocket = one `nano -R -I`
 * process running with cwd = the connected vault root). Every keystroke
 * goes to the real editor; every save (^O) writes the REAL file; the
 * exit (^X) closes the session and the vault watcher surfaces the
 * change to every reader surface (Phase 5 machinery).
 *
 * Honesty rules this component keeps:
 *  - The overlay is closed by the SERVICE's exit event, never guessed.
 *  - A refusal (missing file + no designation, jail escape, dir, hidden)
 *    prints the service's own words into the terminal, then closes.
 *  - Killing a session (✕ button) or losing the socket SIGKILLs nano:
 *    the receipt says the unsaved buffer is GONE — no pretending.
 *  - Keys are never intercepted while the session lives (nano owns
 *    Esc, Ctrl+everything); the ✕ button is the manual way out.
 *
 * Rendering: @xterm/xterm 5 (DOM renderer) + FitAddon, mounted inside
 * the terminal pane exactly like NanoEditor, sized off the pane via
 * ResizeObserver → pty resize (SIGWINCH inside nano).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNaksha } from '@/lib/naksha/store';
import '@xterm/xterm/css/xterm.css';

const PTY_WS_PATH = '/?XTransformPort=3005';

export function NanoPty() {
  const rel = useNaksha((s) => s.nanoPtyRel);
  if (!rel) return null;
  return <NanoPtyInner rel={rel} />;
}

function NanoPtyInner({ rel }: { rel: string }) {
  const closeNanoPty = useNaksha((s) => s.closeNanoPty);
  const vaultName = useNaksha((s) => s.vaultStatus?.name ?? 'vault');

  const containerRef = useRef<HTMLDivElement | null>(null);
  /** live socket — the ✕ button routes {type:'kill'} through it. */
  const wsRef = useRef<WebSocket | null>(null);
  /** set once the service accepted the session (✕ only kills real sessions). */
  const [phase, setPhase] = useState<'connecting' | 'live' | 'ended'>('connecting');
  const [isNewFile, setIsNewFile] = useState(false);
  /** guards receipts: exactly one end-receipt per session. */
  const doneRef = useRef(false);

  const finish = useCallback(
    (receipt: string | null, kind: 'info' | 'warning' | 'success' | 'error') => {
      if (doneRef.current) return;
      doneRef.current = true;
      if (receipt) useNaksha.getState().print(receipt, kind);
      // The watcher picks the save up via SSE; a direct bump makes the
      // reader/tree react without waiting for the next poll.
      useNaksha.getState().bumpVaultRevision();
      closeNanoPty();
    },
    [closeNanoPty],
  );

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: import('@xterm/xterm').Terminal | null = null;
    let fit: import('@xterm/addon-fit').FitAddon | null = null;
    let ro: ResizeObserver | null = null;
    let resizeRaf = 0;

    const sendResize = () => {
      if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    const scheduleResize = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        try {
          fit?.fit();
        } catch {
          /* container collapsed mid-frame */
        }
        sendResize();
      });
    };

    (async () => {
      const container = containerRef.current;
      if (!container || disposed) return;

      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed) return;

      const styles = getComputedStyle(document.documentElement);
      const fontMono = styles.getPropertyValue('--naksha-font-mono').trim() ||
        'ui-monospace, Menlo, Consolas, monospace';
      const bg = styles.getPropertyValue('--naksha-bg').trim() || '#0e1013';
      const fg = styles.getPropertyValue('--naksha-text').trim() || '#e7eaf0';

      term = new Terminal({
        fontFamily: fontMono,
        fontSize: 13,
        lineHeight: 1.25,
        cursorBlink: true,
        allowProposedApi: true,
        theme: {
          background: '#00000000',
          foreground: fg,
          cursor: styles.getPropertyValue('--naksha-gold').trim() || '#d4a24c',
          selectionBackground: '#d4a24c40',
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      try {
        fit.fit();
      } catch {
        /* first paint may be 0-sized; the observer refits */
      }
      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data }));
        }
      });

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}${PTY_WS_PATH}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed || !term) return;
        ws?.send(JSON.stringify({ type: 'open', rel, cols: term.cols, rows: term.rows }));
      };
      ws.onmessage = (ev) => {
        if (disposed) return;
        let msg: { type?: string; data?: string; error?: string; existed?: boolean; rel?: string; code?: number; killed?: boolean };
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return;
        }
        if (msg.type === 'data' && typeof msg.data === 'string') {
          term?.write(msg.data);
        } else if (msg.type === 'opened') {
          setIsNewFile(!msg.existed);
          setPhase('live');
          term?.focus();
        } else if (msg.type === 'refused') {
          finish(`nano: [vault:${useNaksha.getState().vaultStatus?.name ?? 'vault'}] refused — ${msg.error ?? 'unknown'}`, 'error');
        } else if (msg.type === 'exited') {
          setPhase('ended');
          finish(
            msg.killed
              ? `nano — [vault:${vaultName}] ${rel} · session killed — the unsaved buffer is gone`
              : `nano — [vault:${vaultName}] ${rel} · session ended (exit ${msg.code ?? 0}) — saved changes are already visible to the watcher`,
            msg.killed ? 'warning' : 'success',
          );
        }
      };
      ws.onerror = () => {
        if (!doneRef.current) {
          finish('nano: the PTY bridge is unreachable — the nano-pty mini-service is not running (terminal receipts stay honest; nothing was edited)', 'error');
        }
      };
      ws.onclose = () => {
        // A close we did not already account for (network drop / tab
        // suspend) means the service SIGKILLed the session.
        finish('nano — session lost — the service killed it on disconnect (unsaved buffer gone)', 'warning');
      };

      // Pane size → pty size (nano repaints via SIGWINCH).
      ro = new ResizeObserver(scheduleResize);
      ro.observe(container);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(resizeRaf);
      ro?.disconnect();
      if (ws) {
        // Normal paths already closed this; a mid-session unmount still
        // tells the service to SIGKILL nano (unattended editor).
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
      term?.dispose();
    };
  }, [rel, finish, vaultName]);

  const handleKill = useCallback(() => {
    // Route the kill through the protocol, then STAY MOUNTED until the
    // service's exited frame arrives — the receipt must say what actually
    // happened (SIGKILL = unsaved buffer gone), not what we hope did.
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'kill' }));
      setPhase('ended');
      useNaksha.getState().print(`nano — [vault:${vaultName}] ${rel} · killing session…`, 'muted');
    }
  }, [rel, vaultName]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        containerRef.current?.querySelector('textarea')?.focus();
      }
    },
    [],
  );

  return (
    <div
      className="absolute inset-0 z-[100] flex flex-col"
      style={{ background: 'color-mix(in srgb, var(--naksha-bg) 97%, transparent)' }}
      onClick={handleOverlayClick}
      role="dialog"
      aria-label={`Real nano editing ${rel}`}
    >
      {/* Header — mirrors NanoEditor's 36px strip */}
      <div className="flex items-center justify-between h-9 px-4 border-b border-[var(--naksha-border)] shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[var(--naksha-text-4)] font-mono text-[length:var(--naksha-fs-xs)]">
            nano·pty
          </span>
          <span
            className="font-mono text-[10px] px-1.5 py-px rounded"
            style={{
              color: 'var(--naksha-gold)',
              border: '1px solid var(--naksha-gold-dim)',
              background: 'color-mix(in srgb, var(--naksha-gold) 10%, transparent)',
            }}
            title={`the real nano binary runs inside ${vaultName} (restricted mode)`}
          >
            [vault:{vaultName}]
          </span>
          <span className="text-[var(--naksha-text-2)] font-mono text-xs truncate" title={rel}>
            {rel}
          </span>
          {isNewFile && (
            <span
              className="font-mono text-[10px] px-1.5 py-px rounded"
              style={{
                color: 'var(--naksha-gold-light)',
                background: 'color-mix(in srgb, var(--naksha-gold) 12%, transparent)',
              }}
              title="this file does not exist yet — nano creates it on first save (^O)"
            >
              new file
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="font-mono text-[10px] text-[var(--naksha-text-4)] hidden sm:inline">
            ^O save · ^X exit
          </span>
          <span
            className="font-mono text-[10px] whitespace-nowrap"
            style={{
              color: phase === 'live' ? 'var(--naksha-success, var(--naksha-gold))' : 'var(--naksha-text-4)',
            }}
            aria-live="polite"
          >
            {phase === 'connecting' ? 'connecting…' : phase === 'live' ? '● live' : 'ended'}
          </span>
          <button
            onClick={handleKill}
            disabled={phase !== 'live'}
            title={
              phase === 'live'
                ? 'Kill the session (SIGKILL) — nano cannot save an unsaved buffer; the receipt says so'
                : 'session not live'
            }
            className="font-mono text-[10px] px-2 py-0.5 rounded disabled:opacity-40"
            style={{
              color: 'var(--naksha-error)',
              border: '1px solid color-mix(in srgb, var(--naksha-error) 40%, transparent)',
              background: 'transparent',
              cursor: phase === 'live' ? 'pointer' : 'default',
            }}
          >
            ✕ kill
          </button>
        </div>
      </div>

      {/* xterm host — the terminal fills the pane under the header */}
      <div ref={containerRef} className="flex-1 min-h-0 px-1 py-1" />

      {/* Footer strip — the honest one-liner */}
      <div className="flex items-center justify-between h-7 px-4 border-t border-[var(--naksha-border)] shrink-0">
        <span className="font-mono text-[10px] text-[var(--naksha-text-4)] truncate">
          real nano · restricted to the connected directory · saves write the file on disk
        </span>
        <span className="font-mono text-[10px] text-[var(--naksha-text-4)] whitespace-nowrap hidden md:inline">
          Esc is nano&apos;s Meta — use ^X to exit
        </span>
      </div>
    </div>
  );
}

export default NanoPty;
