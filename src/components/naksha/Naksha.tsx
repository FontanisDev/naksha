'use client';

/**
 * Naksha — Main shell component
 *
 * Lays out the three primary panes (Map | Terminal | CareSpace) with
 * resizable splits driven by the settings (`mapsplit`, `caresolution`),
 * plus the sticky status bar at the bottom and the overlays (Nano,
 * Focus, Reader, DotGrid background, Command Palette, Shortcuts).
 *
 * Performance:
 *  - The shell itself never re-renders on terminal line appends —
 *    only on split changes (rare).
 *  - Each pane subscribes to its own Zustand slices.
 *  - DotGrid background is a fixed canvas behind everything (z-0).
 *  - Overlays (Palette, Shortcuts, Nano, Focus) only mount when open.
 */

import { memo, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { DotGridBackground } from './DotGridBackground';
import { MapPane as MapPaneBase } from './MapPane';
import TerminalPaneBase from './TerminalPane';
import { CareSpacePane as CareSpacePaneBase } from './CareSpacePane';
import { StatusBar as StatusBarBase } from './StatusBar';
import { ReaderPanel } from './ReaderPanel';
import { CommandPalette } from './CommandPalette';
import { NodeQuickJump } from './NodeQuickJump';
import { PerfHud } from './PerfHud';
import { PerfStyles } from './PerfStyles';
import { DetailStyles } from './DetailStyles';
import { useNaksha } from '@/lib/naksha/store';
import { CommandRunner } from '@/lib/naksha/commands';

/* Code-split overlays (queued backlog #3): every panel below returns
 * null when closed, so lazy-loading changes no DOM — its chunk simply
 * loads on first open instead of weighing down the boot bundle. The
 * prop-gated ones are ALSO mount-gated at the render site (open ? … :
 * null) so their chunk is fetched only when first opened.
 * CommandPalette / NodeQuickJump / ReaderPanel keep mounted-but-hidden
 * chrome while closed (close transitions, scroll carry) and stay
 * static. MapPane / CareSpacePane deliberately stay static too: they
 * render at boot, and a dynamic mount opens a window where `goto` and
 * CareSpace commands would hit an engine whose pane isn't there yet —
 * not worth it for one cold-load beat. */
/* v138 T5/T6 — every factory is a NAMED binding so the idle preloader
 * below can invoke the SAME import() the dynamic components ride: the
 * module/chunk cache is shared, so a warmed panel mounts without the
 * first-open fetch+compile stall. This is the standard lazy-preload
 * recipe (React docs' "preload before render" adapted to next/dynamic):
 * the boot bundle is untouched — warming starts on requestIdleCallback
 * AFTER the shell is interactive, staggered so the dev server's
 * on-demand compiles never land in one burst. */
const loadNanoEditor = () => import('./NanoEditor');
const loadNanoPty = () => import('./NanoPty');
const loadWorkspace = () => import('./Workspace');
const loadVaultPanel = () => import('./VaultPanel');
const loadShortcutsOverlay = () => import('./ShortcutsOverlay');
const loadTimelineView = () => import('./TimelineView');
const loadNodeDetailsPanel = () => import('./NodeDetailsPanel');
const loadThemePicker = () => import('./ThemePicker');
const loadStatsPanel = () => import('./StatsPanel');
const loadPerfPanel = () => import('./PerfPanel');

const NanoEditor = dynamic(loadNanoEditor, { ssr: false });
const NanoPty = dynamic(loadNanoPty, { ssr: false });
const Workspace = dynamic(loadWorkspace, { ssr: false });
const VaultPanel = dynamic(loadVaultPanel, { ssr: false });
const ShortcutsOverlay = dynamic(loadShortcutsOverlay, { ssr: false });
const TimelineView = dynamic(loadTimelineView, { ssr: false });
const NodeDetailsPanel = dynamic(loadNodeDetailsPanel, { ssr: false });
const ThemePicker = dynamic(loadThemePicker, { ssr: false });
const StatsPanel = dynamic(loadStatsPanel, { ssr: false });
const PerfPanel = dynamic(loadPerfPanel, { ssr: false });

/* Perf: memo boundaries for the three panes + status bar. None take
 * props (StatusBar's className is stable), so a shell re-render —
 * theme switch, split resize, settings change — no longer cascades
 * into a full re-render of each pane's subtree (the terminal alone
 * reconciles up to 500 rows). The panes still re-render on their own
 * store slices exactly as before. */
const MapPane = memo(MapPaneBase);
const TerminalPane = memo(TerminalPaneBase);
const CareSpacePane = memo(CareSpacePaneBase);
const StatusBar = memo(StatusBarBase);

export default function Naksha() {
  const initRef = useRef(false);
  const settings = useNaksha((s) => s.settings);
  const paletteOpen = useNaksha((s) => s.paletteOpen);
  const shortcutsOpen = useNaksha((s) => s.shortcutsOpen);
  const jumpOpen = useNaksha((s) => s.jumpOpen);
  const themePickerOpen = useNaksha((s) => s.themePickerOpen);
  const statsOpen = useNaksha((s) => s.statsOpen);
  const perfPanelOpen = useNaksha((s) => s.perfPanelOpen);
  const vaultPanelOpen = useNaksha((s) => s.vaultPanelOpen);
  const timelineOpen = useNaksha((s) => s.timelineOpen);
  const detailsNodeId = useNaksha((s) => s.detailsNodeId);

  // One-time initialization.
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    useNaksha.getState().init();
    CommandRunner.init();
  }, []);

  /* v138 T5/T6 — the overlays' chunks warm on idle. Before this, the
   * FIRST open of each panel (right-click a node → details, `perf`
   * → PerfPanel, `vault` → VaultPanel, theme switch → picker, `ws` →
   * workspace…) paid the chunk fetch + module evaluation synchronously
   * in the click handler — the exact "panel opens slow/laggy" family
   * the owner flagged. Warming keeps the code-splitting contract intact
   * (boot bundle unchanged, nothing mounts, zero DOM): the factories
   * resolve through the same chunk cache next/open rides. Order = the
   * owner's own lag report: details + perf first, the rest follow;
   * each step waits for idle so the compiles stay off the hot path. */
  useEffect(() => {
    const factories = [
      loadNodeDetailsPanel,
      loadPerfPanel,
      loadVaultPanel,
      loadThemePicker,
      loadStatsPanel,
      loadShortcutsOverlay,
      loadTimelineView,
      loadNanoEditor,
      loadNanoPty,
      loadWorkspace,
    ];
    let i = 0;
    let cancelled = false;
    const idle =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback.bind(window)
        : (cb: () => void) => window.setTimeout(cb, 180);
    const step = () => {
      if (cancelled || i >= factories.length) return;
      void factories[i++]().catch(() => {
        /* a failed warm must never break the shell — the dynamic()
         * mount retries naturally on the next open. */
      });
      idle(step);
    };
    idle(step);
    return () => {
      cancelled = true;
    };
  }, []);

  /* Phase 8 — DirectionContext management: the root `dir` attribute is
   * OWNED here (the shell), re-resolved on direction-mode changes AND
   * on careRevision bumps (auto mode follows the user's own writing —
   * new Persian notes flip the chrome; a bounded sample scan keeps it
   * cheap). Explicit ltr/rtl modes just re-assert. init() already
   * applied the boot value, so this only fires on real changes.
   *
   * Perf fix: the careRevision trigger moved OUT of the render tree —
   * a render-level subscription re-rendered the entire shell (and, with
   * no memo boundary, every pane and overlay) on EVERY CareSpace
   * mutation, selection clicks included. The store subscription below
   * reacts to the same bumps with zero re-renders. */
  const directionMode = settings.direction;
  useEffect(() => {
    useNaksha.getState().refreshDirection();
  }, [directionMode]);
  useEffect(() => {
    return useNaksha.subscribe((s, prev) => {
      if (s.careRevision !== prev.careRevision) {
        useNaksha.getState().refreshDirection();
      }
    });
  }, []);

  // Global keyboard shortcuts: Cmd/Ctrl+K (palette), ? (shortcuts).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const s = useNaksha.getState();
      // Don't trigger when an overlay is capturing input.
      if (s.focusActive || s.nanoOpen) return;
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      // Cmd/Ctrl + K → toggle command palette
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
        return;
      }

      // Cmd/Ctrl + P → node quick-jump (fuzzy finder)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        s.setJumpOpen(!s.jumpOpen);
        return;
      }

      // ? → show shortcuts (only when not in an input)
      if (e.key === '?' && !inEditable) {
        e.preventDefault();
        s.setShortcutsOpen(true);
        return;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Split percentages (clamped for safety).
  const mapSplit = Math.max(25, Math.min(75, settings.mapsplit));
  const termSplit = Math.max(25, Math.min(70, settings.caresolution));
  const careSplit = 100 - termSplit;

  // Subscribe to themeId + perf tier so the DotGrid remounts (re-reads
  // CSS vars and the tier decision) on either change. Both are rare
  // settings-level events — the shell already re-renders on settings.
  const themeId = useNaksha((s) => s.settings.themeId);
  const perfMode = useNaksha((s) => s.settings.perfMode);

  /* Task T1 (v138) — the ReactBits reactive star field is the HIGH
   * tier's experience; the low/stable60 tiers render the static field
   * (their documented contract kills continuous animations). The key
   * bundles tier + theme so a tier switch rebuilds the field too. */
  const starsReactive = perfMode !== 'low' && perfMode !== 'stable60';

  return (
    <div className="relative h-screen w-screen overflow-hidden flex flex-col">
      {/* CPU-only tier: global zero-blur glass + transition kills (see PerfStyles). */}
      <PerfStyles />
      {/* Styling details: glass catch-light, terminal hover, tabular digits (see DetailStyles). */}
      <DetailStyles />

      {/* Background dot-grid — the ReactBits DotGrid star field (fixed,
          behind everything; panes are glass over it). `key` forces
          remount on theme switch (re-read --naksha-dot-color /
          --naksha-dot-hover) AND on perf-tier switch (reactive ↔
          static). The map pane is untouched: its tiles are opaque, so
          the field never shows inside the map. */}
      <DotGridBackground
        key={`${themeId}:${perfMode ?? 'high'}`}
        reactive={starsReactive}
      />

      {/* Main content: three panes */}
      <main
        className="relative z-[1] flex-1 min-h-0 flex gap-2 p-2"
        style={{ flex: '1 1 auto' }}
      >
        {/* Map pane (left) */}
        <section
          className="relative min-w-[300px] naksha-glass rounded-xl overflow-hidden flex flex-col"
          style={{ flex: `${mapSplit} 1 0` }}
          aria-label="Map"
        >
          <MapPane />
          {/* Reader panel overlays the map (slide-in from right) */}
          <ReaderPanel />
        </section>

        {/* Right column: terminal + CareSpace side by side */}
        <div
          className="flex gap-2 min-w-0"
          style={{ flex: `${100 - mapSplit} 1 0` }}
        >
          {/* Terminal pane (center) */}
          <section
            className="relative min-w-[320px] max-w-[640px] naksha-glass rounded-xl overflow-hidden flex flex-col"
            style={{ flex: `${termSplit} 1 0` }}
            aria-label="Terminal"
          >
            <TerminalPane />
            {/* Nano editor overlays the terminal — internal FS (overlay) */}
            <NanoEditor />
            {/* Phase 6 — REAL nano (PTY bridge) overlays the terminal too:
             * the actual nano binary inside the connected vault. */}
            <NanoPty />
          </section>

          {/* CareSpace pane (right) */}
          <section
            className="relative min-w-[280px] naksha-glass rounded-xl overflow-hidden flex flex-col"
            style={{ flex: `${careSplit} 1 0` }}
            aria-label="CareSpace"
          >
            <CareSpacePane />
          </section>
        </div>
      </main>

      {/* Sticky status bar at the bottom */}
      <StatusBar className="mt-auto" />

      {/* Workspace overlay (replaces Focus Mode) — star constellation drawing */}
      <Workspace />

      {/* Command palette (Ctrl/Cmd+K) */}
      <CommandPalette open={paletteOpen} onOpenChange={useNaksha.getState().setPaletteOpen} />

      {/* Node quick-jump (Ctrl/Cmd+P) — fuzzy finder for CareSpace nodes */}
      <NodeQuickJump open={jumpOpen} onOpenChange={useNaksha.getState().setJumpOpen} />

      {/* Theme picker (themepicker command) — visual swatch grid.
          Mount-gated: closed = returns null anyway, so this only moves
          the chunk fetch to the first open. */}
      {themePickerOpen ? (
        <ThemePicker open onClose={() => useNaksha.getState().setThemePickerOpen(false)} />
      ) : null}

      {/* Statistics panel (statsview command) — visual charts */}
      {statsOpen ? <StatsPanel open onClose={() => useNaksha.getState().setStatsOpen(false)} /> : null}

      {/* Performance-tier panel (perfpanel command / status-bar PERF chip) */}
      {perfPanelOpen ? <PerfPanel open onClose={() => useNaksha.getState().setPerfPanelOpen(false)} /> : null}

      {/* Vault panel (vault command) — the read-only window onto the
          explicitly connected real directory; no vault, no access */}
      {vaultPanelOpen ? <VaultPanel open onClose={() => useNaksha.getState().setVaultPanelOpen(false)} /> : null}

      {/* Frame-rate HUD (perf command) — the real-hardware smoothness
          instrument; off means off, zero residual cost */}
      <PerfHud />

      {/* Keyboard shortcuts overlay (?) */}
      {shortcutsOpen ? <ShortcutsOverlay open onClose={() => useNaksha.getState().setShortcutsOpen(false)} /> : null}

      {/* Timeline view (tlview command) */}
      {timelineOpen ? <TimelineView open onClose={() => useNaksha.getState().setTimelineOpen(false)} /> : null}

      {/* Node details panel (details command or right-click) */}
      {detailsNodeId ? (
        <NodeDetailsPanel nodeId={detailsNodeId} onClose={() => useNaksha.getState().setDetailsNodeId(null)} />
      ) : null}
    </div>
  );
}
