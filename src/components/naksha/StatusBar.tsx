'use client';

/**
 * Naksha — StatusBar
 *
 * Sticky bottom status bar (36px tall). The parent Naksha shell wraps the
 * whole app in `min-h-screen flex flex-col` and renders `<StatusBar
 * className="mt-auto" />` last so the bar naturally sticks to the bottom
 * of the viewport.
 *
 * Perf:
 *  - Each slice subscription is its own selector (no object returns) so
 *    the bar only re-renders when a value it actually reads changes.
 *  - The clock uses a 30s interval (NOT 1s) and updates immediately on
 *    mount. Display is HH:MM 24h so 30s granularity is invisible.
 */

import { memo, useEffect, useMemo } from 'react';
import { useNaksha } from '@/lib/naksha/store';
import { CareSpace } from '@/lib/naksha/carespace';
import { CommandRunner } from '@/lib/naksha/commands';
import { formatTime } from '@/lib/naksha/utils';
import {
  contextChipLabel,
  contextChipTitle,
  resolveStorageContext,
} from '@/lib/naksha/vault-context';
import { t } from '@/lib/naksha/i18n';

function updateClock() {
  const el = document.getElementById('naksha-clock');
  if (el) el.textContent = formatTime();
}

const STATUS_COLORS: Record<'idle' | 'active' | 'error', string> = {
  idle: 'var(--naksha-success)',
  active: 'var(--naksha-gold)',
  error: 'var(--naksha-error)',
};

/* Leaf readout — the bar's only mapCoord reader. Panning the map used
 * to re-render the ENTIRE status bar at Leaflet's event rate; now it
 * re-renders this one span. */
const CoordReadout = memo(function CoordReadout() {
  const mapCoord = useNaksha((s) => s.mapCoord);
  return <span className="whitespace-nowrap hidden sm:inline tabular-nums">{mapCoord}</span>;
});

export function StatusBar({ className = '' }: { className?: string }) {
  const mapLayer = useNaksha((s) => s.mapLayer);
  const cwd = useNaksha((s) => s.cwd);
  /* Phase 3 — the CTX chip: which storage world is active. Two scalar
   * slices + one pure resolver, so the chip can never tell its own
   * story (same resolver the panel and receipts call). */
  const storagePref = useNaksha((s) => s.settings.storageContext);
  const vaultStatus = useNaksha((s) => s.vaultStatus);
  const storageCtx = useMemo(
    () => resolveStorageContext(storagePref, vaultStatus),
    [storagePref, vaultStatus],
  );
  const currentNodeLabel = useNaksha((s) => s.currentNodeLabel);
  const currentNetworkName = useNaksha((s) => s.currentNetworkName);
  // Re-subscribe to careRevision so the dot re-pulls color when the
  // active network switches.
  const careRevision = useNaksha((s) => s.careRevision);
  const historyLength = useNaksha((s) => s.history.length);
  const statusMode = useNaksha((s) => s.statusMode);
  /* Perf mode — scalar slice; the chip shows which rendering tier the app
   * is running (auto-detected or user-set via `settings perf low|high`). */
  const perfMode = useNaksha((s) => s.settings.perfMode);
  /* Phase 8 — direction chip state + the i18n-lite trigger: subscribing
   * to uiLang makes the whole bar re-render with Persian labels when
   * `settings lang fa` lands (t() reads the same slice per render). */
  const directionMode = useNaksha((s) => s.settings.direction ?? 'auto');
  const uiLang = useNaksha((s) => s.settings.uiLang);
  void uiLang;
  /* Phase 8 — the RESOLVED side (what 'auto' currently means), mirrored
   * into the store by refreshDirection so the chip never re-scans. */
  const directionResolved = useNaksha((s) => s.directionResolved);
  /* Task 106 — the PERF chip joins the provenance family: its verbose
   * title (and aria-label) now say WHY the tier is what it is, in sync
   * with the `settings` receipt and the PerfPanel caption. */
  const perfProvenance = useNaksha((s) => s.settings.perfProvenance);
  /* Undo availability — array identity, so the bar only re-renders when
   * a snapshot is created or consumed. Task 89 — the indicator became a
   * DOOR: click runs `hist` (the peek verb — consumes nothing), so the
   * question the badge invites ("what's in the stack?") is one click
   * away. The `undo` ACTION stays verb-owned and keyboard-owned (⌘Z) —
   * a click that silently mutates state would be a footgun. Echo +
   * execute, the terminal chip contract (Task 86's Σ chip template):
   * native button, so the keyboard story is free (Tab + Enter). */
  const undoStack = useNaksha((s) => s.undoStack);
  const undoEntry = undoStack[0];
  /* Task 118 — the future gets its door too: the ↪ chip mirrors the ↩
   * chip for the redo stack (Task 82 persists it, Task 117 made it
   * peekable with `hist r<n>`, but the status bar never SHOWED the
   * future — you could only discover it by running hist blind). Same
   * contract as the ↩ chip: click runs the peek verb (`hist r1`),
   * consumes nothing; the redo ACTION stays verb-owned (⇧⌘Z). */
  const redoStack = useNaksha((s) => s.redoStack);
  const redoEntry = redoStack[0];
  /* Node-marker layer state (Task 35) — when the violet thought-markers
   * are on, show how many located nodes they render. Reads CareSpace
   * directly (cheap property walk) behind the careRevision trigger. */
  const showNodesOnMap = useNaksha((s) => s.settings.showNodesOnMap);
  const locatedCount = (() => {
    void careRevision; // re-render trigger
    if (!showNodesOnMap) return 0;
    let count = 0;
    for (const net of CareSpace.networks()) {
      for (const node of Object.values(net.nodes)) if (node.location) count++;
    }
    return count;
  })();

  // 30s clock — only update textContent, no React state churn.
  useEffect(() => {
    updateClock();
    const id = setInterval(updateClock, 30_000);
    return () => clearInterval(id);
  }, []);

  /* Phase 3 — CTX freshness: the chip names a SERVER-side fact, so its
   * knowledge must not go stale (a vault restored on disk after a
   * fallback should flip the chip back without a manual command). One
   * lightweight status fetch per 45s + one on window focus; both no-ops
   * against the local API and they also keep `cat -r` routing honest. */
  useEffect(() => {
    const refresh = () => void useNaksha.getState().refreshVaultStatus();
    const id = window.setInterval(refresh, 45_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  // Resolve the active network's color from CareSpace directly.
  // Cheap (object property access) and runs only when careRevision bumps.
  const activeNetColor = (() => {
    void careRevision; // re-render trigger
    try {
      return CareSpace.currentNetwork().color;
    } catch {
      return 'var(--naksha-gold)';
    }
  })();

  const statusColor = STATUS_COLORS[statusMode];

  return (
    <footer
      role="contentinfo"
      aria-label="Status bar"
      /* UI-calm pass: quiet surface. The old inline dark scrim
       * (rgba(26,22,17) — wrong on light themes) + gradient sheen +
       * double inset shadows + glow dots read as "gaming RGB". Now:
       * theme tokens, a hairline top border, one soft blur. */
      className={`naksha-statusbar flex items-center justify-between px-4 font-mono text-[10px] text-[var(--naksha-text-3)] border-t border-[var(--naksha-border-2)] z-10 h-9 ${className}`}
      style={{
        background: 'var(--naksha-glass-2)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      {/* ─── Left: context info ─── */}
      <div className="flex items-center gap-4 min-w-0">
        <span className="whitespace-nowrap">
          {t('sb.map', 'map')}:{' '}
          <span className="text-[var(--naksha-gold)]">{mapLayer}</span>
        </span>
        <span className="whitespace-nowrap hidden sm:inline">
          {t('sb.fs', 'fs')}: <span className="text-[var(--naksha-text-2)]">{cwd}</span>
        </span>
        {/* Phase 3 — the storage-context chip (internal vs connected).
         * A DOOR, like the other chips: click opens the VaultPanel where
         * the connection is managed. Dot dialect: hollow = internal (no
         * real-disk link), filled green = a live connection. The label
         * speaks the world; the tooltip speaks the routing truth. */}
        <button
          type="button"
          onClick={() => useNaksha.getState().setVaultPanelOpen(true)}
          className="whitespace-nowrap hidden md:inline naksha-status-btn naksha-status-ctx"
          title={contextChipTitle(storageCtx)}
          aria-label={contextChipTitle(storageCtx, true)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
        >
          <span
            aria-hidden="true"
            className="inline-block w-1.5 h-1.5 rounded-full align-middle"
            style={
              storageCtx.kind === 'connected'
                ? {
                    background: 'var(--naksha-success)',
                    marginRight: 4,
                  }
                : {
                    background: 'transparent',
                    border: '1px solid var(--naksha-text-4)',
                    marginRight: 4,
                  }
            }
          />
          <span
            className={storageCtx.kind === 'connected' ? '' : 'text-[var(--naksha-text-2)]'}
            style={
              storageCtx.kind === 'connected'
                ? { color: 'var(--naksha-success)' }
                : undefined
            }
          >
            {contextChipLabel(storageCtx)}
          </span>
          {storageCtx.reason === 'fallback-unavailable' && (
            <span aria-hidden="true" style={{ color: 'var(--naksha-gold)', marginLeft: 4 }}>
              ⚠
            </span>
          )}
        </button>
        <span className="whitespace-nowrap hidden md:inline">
          {t('sb.node', 'node')}: <span className="text-[var(--naksha-text-2)]">{currentNodeLabel}</span>
        </span>
        <span className="whitespace-nowrap hidden md:inline-flex items-center gap-1.5">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: activeNetColor }}
            aria-hidden
          />
          {t('sb.net', 'net')}: <span className="text-[var(--naksha-text-2)]">{currentNetworkName || '—'}</span>
        </span>
        {/* Phase 8 — the direction chip: mode AND what auto resolves to,
         * spoken at a glance (the chrome's own writing direction is a
         * first-class instrument like PERF). A DOOR: click cycles
         * auto → rtl → ltr (echo + settings write, one applier). The
         * glyph shows the resolved side: ⇤ mirrored rows, ⇥ LTR rows. */}
        <button
          type="button"
          className="whitespace-nowrap hidden lg:inline naksha-status-btn naksha-status-dir"
          onClick={() => {
            const next = directionMode === 'auto' ? 'rtl' : directionMode === 'rtl' ? 'ltr' : 'auto';
            useNaksha.getState().print(`settings direction ${next}`, 'cmd');
            void CommandRunner.execute(`settings direction ${next}`);
          }}
          title={`text direction: ${directionMode} — click to cycle auto → rtl → ltr (auto follows the majority script of your notes)`}
          aria-label={`text direction ${directionMode} — press to cycle`}
        >
          {directionResolved === 'rtl' ? '⇤' : '⇥'} {t('sb.dir', 'dir')}:{' '}
          <span
            className={directionResolved === 'rtl' ? '' : 'naksha-status-sub'}
            style={directionResolved === 'rtl' ? { color: 'var(--naksha-gold)' } : undefined}
          >
            {directionMode}
          </span>
        </button>
        {/* Task 90 — the recall door. The old LINES span counted the
            command history while reading as terminal content lines — a
            label that lied by ambiguity, and the strip's last
            state-bearing dead text. CMD: names its unit, and the chip is
            a door that runs `history` (the peek verb — a chip run echoes
            + prints, the recall buffer itself is untouched). Native
            button: keyboard free. Rest state is pixel-identical to the
            old span (label inherits text-3, count text-2). */}
        <button
          type="button"
          className="whitespace-nowrap hidden lg:inline naksha-status-btn naksha-status-cmd"
          onClick={() => {
            useNaksha.getState().print('history', 'cmd');
            void CommandRunner.execute('history');
          }}
          title={`${historyLength} command${historyLength === 1 ? '' : 's'} in the recall buffer (↑/↓ walks it) · click to list them (runs: history — peek only, adds nothing)`}
          aria-label={`${historyLength} command${historyLength === 1 ? '' : 's'} in the recall buffer — press to list them`}
        >
          {t('sb.cmd', 'cmd')}: <span className="naksha-status-sub tabular-nums">{historyLength}</span>
        </button>
        {showNodesOnMap && (
          <button
            type="button"
            className="whitespace-nowrap hidden lg:inline naksha-status-btn naksha-status-loc"
            title="violet thought-markers on the map — click to hide ('mapnodes off'); click a marker for its info card"
            aria-label={`${locatedCount} thought marker${locatedCount === 1 ? '' : 's'} on the map — press to hide them`}
            onClick={() => {
              useNaksha.getState().setSettings({ showNodesOnMap: false });
              useNaksha.getState().print('Node markers OFF', 'info');
            }}
          >
            ◈ {locatedCount} loc
          </button>
        )}
        {perfMode && (
          <button
            type="button"
            className="whitespace-nowrap hidden xl:inline naksha-perf-chip naksha-status-btn"
            onClick={() => useNaksha.getState().setPerfPanelOpen(true)}
            title={
              perfMode === 'low'
                ? `perf LOW — animations/blur minimized${
                    perfProvenance === 'chosen'
                      ? ' (your choice)'
                      : perfProvenance === 'auto-reduced-motion'
                      ? ' (matched to your OS reduce-motion setting)'
                      : perfProvenance === 'auto-hardware'
                      ? ' (auto-detected for this hardware)'
                      : ''
                  } · click to open the performance panel`
                : perfMode === 'stable60'
                ? 'perf STABLE_60 — locked 60 FPS, zero blur, full-rate interaction · click to open the performance panel'
                : 'perf HIGH — full effects · click to open the performance panel'
            }
            aria-label={
              perfMode === 'low'
                ? 'performance tier LOW, animations and blur minimized — press to open the performance panel'
                : perfMode === 'stable60'
                ? 'performance tier STABLE 60, locked 60 FPS with zero blur — press to open the performance panel'
                : 'performance tier HIGH, full effects — press to open the performance panel'
            }
            style={{
              color:
                perfMode === 'low'
                  ? 'var(--naksha-purple)'
                  : perfMode === 'stable60'
                    ? 'var(--naksha-gold)'
                    : 'var(--naksha-success)',
              fontFamily: 'inherit',
              fontSize: 'inherit',
            }}
          >
            {t('sb.perf', 'perf')}:{perfMode}
          </button>
        )}
        {undoEntry && (
          <button
            type="button"
            className="naksha-status-btn naksha-status-hist whitespace-nowrap hidden xl:inline"
            onClick={() => {
              useNaksha.getState().print('hist', 'cmd');
              void CommandRunner.execute('hist');
            }}
            title={`undo ledger: ${undoStack.length} step${undoStack.length === 1 ? '' : 's'} deep · click to peek it (runs: hist — peek only, consumes nothing)`}
            aria-label={`undo ledger ${undoStack.length} step${undoStack.length === 1 ? '' : 's'} deep, last entry ${undoEntry.label.slice(0, 26)} — press to peek`}
          >
            ↩ <span className="naksha-status-sub">{undoEntry.label.slice(0, 26)}</span>
            {undoStack.length > 1 && <span className="naksha-status-dim"> ·{undoStack.length}</span>}
          </button>
        )}
        {redoEntry && (
          <button
            type="button"
            className="naksha-status-btn naksha-status-hist whitespace-nowrap hidden xl:inline"
            onClick={() => {
              useNaksha.getState().print('hist r1', 'cmd');
              void CommandRunner.execute('hist r1');
            }}
            title={`redo future: ${redoStack.length} step${redoStack.length === 1 ? '' : 's'} deep · click to peek it (runs: hist r1 — peek only, consumes nothing)`}
            aria-label={`redo future ${redoStack.length} step${redoStack.length === 1 ? '' : 's'} deep, next entry ${redoEntry.label.slice(0, 26)} — press to peek`}
          >
            ↪ <span className="naksha-status-sub">{redoEntry.label.slice(0, 26)}</span>
            {redoStack.length > 1 && <span className="naksha-status-dim"> ·{redoStack.length}</span>}
          </button>
        )}
      </div>

      {/* ─── Right: coord + clock + status dot ─── */}
      <div className="flex items-center gap-4">
        <CoordReadout />
        <span
          id="naksha-clock"
          className="text-[var(--naksha-gold)] font-medium tabular-nums"
          aria-label="Current time"
        >
          --:--
        </span>
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: statusColor }}
          aria-label={`Status: ${statusMode}`}
          role="status"
        />
      </div>

      {/* Instrument-panel separators — a 1px warm hairline centered in the
          gap between status segments, like tick marks on a console strip.
          Static paint (::before), no layout shift, perf-low safe. */}
      <style>{`
        footer[aria-label="Status bar"] > div > * + *::before {
          content: '';
          position: absolute;
          left: -9px;
          top: 50%;
          transform: translateY(-50%);
          width: 1px;
          height: 11px;
          background: linear-gradient(
            180deg,
            transparent,
            var(--naksha-border-2) 30%,
            var(--naksha-border-2) 70%,
            transparent
          );
          pointer-events: none;
        }
        footer[aria-label="Status bar"] > div > * {
          position: relative;
        }
      `}</style>
    </footer>
  );
}

export default StatusBar;
