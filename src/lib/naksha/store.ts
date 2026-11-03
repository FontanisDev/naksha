/**
 * Naksha — Global Zustand store
 *
 * This store is the reactive bridge between the pure engines
 * (FileSystem, CareSpace, MapEngine) and the React UI. The engines
 * hold their own mutable state; this store mirrors the bits the UI
 * needs to render reactively.
 *
 * Performance:
 *  - Terminal lines are capped (MAX_TERM_LINES) and trimmed.
 *  - CareSpace updates bump a `careRevision` counter — the canvas
 *    component reads `CareSpace.data` directly but only re-renders
 *    when careRevision changes (dirty-flag pattern).
 *  - Map state is mostly imperative (Leaflet); we only mirror the
 *    display values (layer name, coords, zoom) for the status bar.
 */

'use client';

import { create } from 'zustand';
import { FileSystem } from './filesystem';
import { CareSpace } from './carespace';
import { Storage } from './storage';
import {
  DEFAULT_SETTINGS,
  MAX_HISTORY,
  MAX_TERM_LINES,
  STORAGE_KEYS,
} from './constants';
import { generateId } from './utils';
import { applyTheme, getThemeMapLayer } from './themes';
import { applyPerfDocumentAttr } from './perf-tier';
import {
  applyDirectionDocumentAttr,
  effectiveDirection,
  sampleAppContent,
} from './direction';
import { resolveStorageContext } from './vault-context';
import {
  fetchCareVaultStatus,
  designateCareVault as apiDesignateCareVault,
  careVaultCheck,
} from './care-vault';
import { MapEngine } from './map-engine';
import type {
  AliasMap,
  CareVaultStatus,
  MapLayerKey,
  NakshaSettings,
  ReaderState,
  TermLine,
  TermLineType,
  ViewHistoryEntry,
  VaultStatus,
} from './types';
import type { UndoEntry } from './types';

/* Phase 3 — the "saved connected but unavailable" fallback notice fires
 * once per page load (not once per status refresh — the SSE poller and
 * panel boot would otherwise print it repeatedly). */
let vaultContextFallbackNotified = false;

/* ══ Task T2 (v138) — terminal print microbatch ════════════════════
 * print() queues into this buffer and a single microtask flush appends
 * the whole batch with ONE array copy + ONE store notification. The
 * queue lives at module scope so the flush helper can be a hoisted
 * function (no re-creation per print, no closure churn). clear()
 * drains it synchronously so a same-tick print→clear stays empty. */
const termPrintQueue: TermLine[] = [];
let termFlushScheduled = false;
function flushTermPrintQueue() {
  termFlushScheduled = false;
  if (termPrintQueue.length === 0) return;
  const batch = termPrintQueue.slice();
  termPrintQueue.length = 0;
  useNaksha.setState((s) => {
    const lines =
      s.lines.length + batch.length > MAX_TERM_LINES
        ? [...s.lines, ...batch].slice(-(MAX_TERM_LINES))
        : [...s.lines, ...batch];
    return { lines };
  });
}

/**
 * Detect low-end hardware (CPU-only rendering, no discrete GPU).
 * Uses navigator.hardwareConcurrency and deviceMemory as heuristics.
 * Conservative: returns true only if BOTH indicators are low.
 * 2026-09 (Task 29): CPU-ONLY boxes usually still report 4-8 logic cores but
 * render via software (SwiftShader / llvmpipe) — that is the strongest
 * signal, so WebGL renderer probing is checked too, and <=2 cores alone
 * now qualifies.
 */
function detectSoftwareRendering(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return true; // no WebGL at all → software compositing likely
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (!dbg) return false; // masked — can't tell, assume fine
    const renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '');
    return /swiftshader|software|llvmpipe|basic render/i.test(renderer);
  } catch {
    return false;
  }
}

/* Task 105 — the predicate now reports WHICH signal fired, so the init
 * path can stamp the tier's provenance into settings and the `settings`
 * receipt can make the tier diagnosable. Order preserved: hardware
 * signals win over the reduced-motion suggestion — the OS preference
 * and the measured machine are different kinds of truth, and the
 * receipt should say which one the tier came from. Returns null when
 * nothing fired (no tier decision → nothing persisted → detection
 * re-runs next load, as before). */
function detectLowEndReason(): 'auto-hardware' | 'auto-reduced-motion' | null {
  if (typeof navigator === 'undefined') return null;
  const cores = navigator.hardwareConcurrency ?? 8;
  const memGB = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  if (cores <= 2) return 'auto-hardware';
  if (cores <= 4 && memGB <= 4) return 'auto-hardware';
  if (detectSoftwareRendering()) return 'auto-hardware';
  /* Task 104 — the OS-level "reduce motion" accessibility setting implies
   * this tier. What it asks for (no continuous animation, settled
   * surfaces) is precisely what perf-low delivers, and the narrow CSS
   * blocks in globals.css can only kill motion — they cannot drop the
   * backdrop-filter cost, because blur is not motion. Routing these users
   * into the one-truth tier gives them the settled frosted glass and the
   * throttled canvases too. Detection only ever applies when the user has
   * NOT chosen a mode (`settings perfMode on/off` overrides, as before). */
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'auto-reduced-motion';
  return null;
}

interface NakshaState {
  /* ─── readiness ─── */
  ready: boolean;

  /* ─── terminal ─── */
  lines: TermLine[];
  /** whether the spinner / loading line is currently shown */
  isLoading: boolean;
  /** Perf: the loading spinner lives OUTSIDE `lines`. The old approach
   *  re-mapped the entire terminal buffer (up to MAX_TERM_LINES entries)
   *  ten times per second per network command, just to repaint one glyph.
   *  This tiny field animates only the rows that subscribe to it. */
  termSpinner: { id: string; message: string } | null;
  /** When non-null, `print` writes captured text here instead of to `lines`. */
  captureBuffer: string[] | null;

  /* ─── file system ─── */
  cwd: string;
  fsRevision: number;

  /* ─── carespace ─── */
  careRevision: number;
  currentNetworkName: string;
  currentNodeLabel: string;
  breadcrumb: string[];
  careStats: { totalNodes: number; totalNotes: number; pinnedLocations: number; networks: number };
  /** CareSpace pane render mode — hoisted here so commands (caregraph) and
   *  the pane's header button share one source of truth. */
  careViewMode: 'tree' | 'graph';

  /* ─── map ─── */
  mapLayer: MapLayerKey;
  mapZoom: number;
  mapCoord: string; // "35.70N 51.42E"
  mapReady: boolean;

  /* ─── view history (back / fwd / stream) ─── */
  viewHistory: ViewHistoryEntry[];
  viewIndex: number;

  /* ─── focus mode ─── */
  focusActive: boolean;
  focusNotes: Array<{ text: string; timestamp: number; timeString: string; snapped?: boolean }>;
  focusTimerEnd: number | null; // epoch ms when timer ends, or null

  /* ─── nano editor ─── */
  nanoOpen: boolean;
  nanoFile: string;
  /* Phase 6 — REAL nano over the PTY bridge: when non-null, the
   * NanoPty overlay runs the actual `nano` binary inside the connected
   * vault directory (one WebSocket = one session). Null = closed. This
   * is a DIFFERENT editor from the internal overlay above — the vault
   * nano writes the real file, the internal one writes the virtual FS. */
  nanoPtyRel: string | null;

  /* ─── reader panel ─── */
  reader: ReaderState;

  /* ─── vault (Phase 2 — connected real directory, READ-ONLY) ──────
   * Internal storage and the vault are separate worlds: these fields
   * only ever describe the SERVER-side connected directory. Internal
   * (localStorage) filesystem state lives in FileSystem/cwd/fsRevision
   * above and is never merged, mapped, or migrated into the vault. */
  vaultPanelOpen: boolean;
  /** null until the first status fetch resolves. */
  vaultStatus: VaultStatus | null;
  /** Bumped on every external-change event or manual refresh — the
   *  reader and tree re-read when they see a new revision. */
  vaultRevision: number;
  /** rel path of the note currently open in the vault reader. */
  vaultOpenFile: string | null;
  /* Phase 4 — the terminal's SEPARATE working directory INSIDE the
   * connected root ('' = the root). A different world from the internal
   * `cwd` above — they never read or write each other. In-memory only:
   * a reload re-anchors at the vault root (honest — the directory may
   * have changed on disk while the page was away; the internal cwd
   * stays persisted because the internal FS cannot change behind the
   * browser's back). */
  vaultCwd: string;

  /* ─── CareSpace vault (Phase 5 — the designated writable vault) ──
   * The write-capable twin of the read-only vault slice above. The
   * designation lives server-side; the browser only mirrors its STATE.
   * Note text lives in the real files; these fields carry no content. */
  /** null until the first care-vault status fetch resolves. */
  careVaultStatus: CareVaultStatus | null;
  /** rel → true when a bound note file is MISSING (broken-note markers
   *  in tree/graph/details). Only meaningful while designated; cleared
   *  whenever the designation or connection goes away. */
  careVaultMissing: Record<string, boolean>;
  /** Bumped whenever the missing-map changes — canvas redraw trigger. */
  careVaultRevision: number;

  /* ─── command history (persisted) ─── */
  history: string[];
  historyIndex: number;
  /** true while user is in Ctrl+R reverse-i-search */
  reverseSearch: boolean;
  reverseQuery: string;
  reverseResult: string;

  /* ─── settings & aliases (persisted) ─── */
  settings: NakshaSettings;
  aliases: AliasMap;

  /* Phase 8 — re-resolve and re-apply the chrome's text direction.
   * Meaningful in 'auto' mode (content changed → maybe it flips);
   * explicit ltr/rtl modes just re-assert. Cheap: one bounded scan +
   * two attribute writes. Called from Naksha.tsx on direction/
   * careRevision changes. */
  refreshDirection(): void;

  /* Phase 8 — the RESOLVED direction ('ltr'|'rtl') after auto-detection,
   * mirrored in state so chips/panels can react to it without touching
   * the DOM or re-scanning content on every render. */
  directionResolved: 'ltr' | 'rtl';

  /* Task 88 — history grows DEPTH: the slot (Task 60's single-level
   * surprise) becomes a stack. Every destructive action pushes; ⌘Z
   * pops one step and parks the present as the redo head; nothing is
   * discarded until the 32 cap trims the oldest (silently — the same
   * convention the redo stack always had). Persisted under the same
   * STORAGE_KEYS.undo the slot always used. */
  undoStack: UndoEntry[];

  /* Task 81 — the redo twin: what ⌘Z has undone, ⇧⌘Z can re-apply.
   * NOT a second head of history — it's the same line's forward
   * pointer, and any NEW action (a non-null setUndo without the
   * keepRedo lease) truncates it, exactly as it replaces the slot.
   * Task 82 — persisted beside the slot (STORAGE_KEYS.redo): a
   * reload no longer forfeits the future — the stack rides the same
   * Storage the undo entry always has, so ⇧⌘Z survives a refresh. */
  redoStack: UndoEntry[];

  /* ─── status indicator ─── */
  statusMode: 'idle' | 'active' | 'error';
}

interface NakshaActions {
  init(): void;

  /* terminal */
  print(text: string, type?: TermLineType, data?: TermLine['data']): void;
  printRaw(html: string, type?: TermLineType): void;
  /** Convenience: print as a section header (gold, underlined). */
  header(text: string): void;
  /** Convenience: print highlighted (gold-light). */
  highlight(text: string): void;
  /** Convenience wrappers for common types. */
  success(text: string): void;
  error(text: string): void;
  info(text: string): void;
  warning(text: string): void;
  muted(text: string): void;
  clear(): void;

  /** Begin capturing printed output into a buffer (for `> file` redirection). */
  startCapture(): void;
  /** Stop capturing and return the buffered lines. */
  stopCapture(): string[];
  showLoading(message: string): { stop: (finalMessage?: string, type?: TermLineType) => void };
  pushHistory(cmd: string): void;
  setHistoryIndex(index: number): void;
  startReverseSearch(): void;
  updateReverseSearch(query: string): void;
  endReverseSearch(): void;

  /* fs */
  syncFs(): void;

  /* carespace */
  syncCare(): void;

  /* map */
  setMapReady(ready: boolean): void;
  setMapLayer(layer: MapLayerKey): void;
  setMapZoom(zoom: number): void;
  setMapCoord(coord: string): void;
  pushView(label: string, view: Omit<ViewHistoryEntry, 'label'>): void;
  backView(): ViewHistoryEntry | null;
  fwdView(): ViewHistoryEntry | null;

  /* focus */
  setFocusActive(active: boolean): void;
  addFocusNote(text: string): void;
  clearFocusNotes(): void;
  setFocusTimerEnd(end: number | null): void;

  /* carespace view mode */
  setCareViewMode(mode: 'tree' | 'graph'): void;

  /* nano */
  setNanoOpen(open: boolean, file?: string): void;
  /* Phase 6 — the real-nano (PTY) session inside the connected vault. */
  openNanoPty(rel: string): void;
  closeNanoPty(): void;

  /* reader */
  openReader(state: Omit<ReaderState, 'open'>): void;
  closeReader(): void;

  /* settings & aliases */
  setSettings(partial: Partial<NakshaSettings>): void;
  setAlias(name: string, command: string): void;
  removeAlias(name: string): void;

  /* undo */
  setUndo(entry: UndoEntry | null, opts?: { keepRedo?: boolean }): void;
  /** Task 88 — the walk step: remove the stack's head (after a
   * successful restore). The verb peeks undoStack[0] first, so a
   * thrown restore never loses the entry. */
  dropUndoHead(): void;
  /* Task 81 — redo stack plumbing: park a just-undone state, take the
   * head back. Both run through the store so the truncation rule (any
   * new action kills the future) lives in ONE place. */
  pushRedo(entry: UndoEntry): void;
  consumeRedo(): UndoEntry | null;

  /* status */
  setStatusMode(mode: 'idle' | 'active' | 'error'): void;

  /* command palette + shortcuts overlay + node quick-jump */
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  jumpOpen: boolean;
  /** Task 100 — the opening query for the node quick-jump finder. The
   * `jump` verb carries its typed argument here; every setJumpOpen call
   * rewrites it (default ''), so each open is a fresh slate and the
   * Ctrl+P toggle can never reopen wearing a stale filter. */
  jumpQuery: string;
  themePickerOpen: boolean;
  statsOpen: boolean;
  /** Performance-tier panel (GUI for `settings perf`) — opened from the
   * status-bar PERF chip, the `perfpanel` command, or the palette. */
  perfPanelOpen: boolean;
  /** Task 74 — the frame-rate HUD (`perf` command): an instrument, not a
   * surface — measures the app's actual frame cadence so a human on REAL
   * hardware can finally verify smoothness (the dev environment can't). Ephemeral
   * on purpose: a diagnostic must not re-open itself on reload. */
  perfHudOpen: boolean;
  setPaletteOpen(open: boolean): void;
  setShortcutsOpen(open: boolean): void;
  setJumpOpen(open: boolean, query?: string): void;
  setThemePickerOpen(open: boolean): void;
  setStatsOpen(open: boolean): void;
  setPerfPanelOpen(open: boolean): void;
  setPerfHudOpen(open: boolean): void;

  /* timeline view + node details panel */
  timelineOpen: boolean;
  detailsNodeId: string | null;
  /* Task 48 — jump-arrival flash: a one-shot timestamp set by the ⇥ deep
   * link (when perf allows). The details panel flashes a gold ring on
   * mount if this is fresh (< 1.2s) — the landing is unmistakable without
   * any persistent animation. Self-expiring: no clearing, no stale
   * flashes, no extra store churn. */
  detailsFlashTs: number;
  /* Task 49 — deep-link intent: SHOULD the panel lead with the notes
   * section? Set by the graph's double-click (the gesture reads as "show
   * me what I wrote here"), consumed once on panel mount. Independent
   * of the flash ring — a node without notes simply ignores it. */
  detailsFocusNotes: boolean;
  setTimelineOpen(open: boolean): void;
  setDetailsNodeId(id: string | null, flash?: boolean, focusNotes?: boolean): void;

  /* ─── vault (Phase 2) ─── */
  setVaultPanelOpen(open: boolean): void;
  setVaultOpenFile(rel: string | null): void;
  /** Phase 4 — move the vault-world working directory (jailed rel path;
   *  normalized here so every consumer speaks one dialect). */
  setVaultCwd(rel: string): void;
  /** Fetch /api/vault/status into the store (cheap, cache-hit safe). */
  refreshVaultStatus(): Promise<VaultStatus | null>;
  /** Explicit connect — the ONLY way a real directory becomes active. */
  connectVault(absPath: string): Promise<{ ok: boolean; error?: string }>;
  disconnectVault(): Promise<void>;
  /** External change event arrived (SSE) — reactivity only, no data copied. */
  bumpVaultRevision(): void;

  /* ─── CareSpace vault (Phase 5) ─── */
  /** Fetch /api/care-vault/status into the store. */
  refreshCareVaultStatus(): Promise<CareVaultStatus | null>;
  /** Explicit designate / undesignate (panel toggle or vault designate). */
  designateCareVault(on: boolean): Promise<{ ok: boolean; error?: string }>;
  /** Batch existence check of every bound path (broken-note markers);
   *  clears the markers when not connected+designated. */
  refreshCareBoundState(): Promise<void>;
}

export type NakshaStore = NakshaState & NakshaActions;

const initialReader: ReaderState = {
  open: false,
  kind: null,
  title: '',
  body: '',
};

/* ── Undo/redo persistence discipline (round 2 perf pass) ──────────
 * The undo stack holds up to 32 entries, each carrying a FULL state
 * snapshot (a 'care' entry is an entire CareSpace copy). Persisting all
 * of it on EVERY destructive action re-serialized megabytes on the main
 * thread. Now: in-memory depth stays 32 (session undo depth unchanged),
 * but the PERSISTED copy is the newest 8 entries, written on a trailing
 * 400ms debounce and flushed on pagehide/visibilitychange. A reload
 * therefore restores the 8 most recent undo steps — a bounded,
 * documented trade for removing the per-click serialization spike. */
const PERSISTED_UNDO_DEPTH = 8;
let undoPersistTimer: ReturnType<typeof setTimeout> | null = null;
let undoPersistArmed = false;

/* Vault-revision bump debounce — see bumpVaultRevision(). One timer for
 * the whole app: every caller (SSE handlers, vault commands, the panel's
 * refresh button) shares the same trailing window. */
let vaultBumpTimer: ReturnType<typeof setTimeout> | null = null;

function writeUndoRedoNow(): void {
  if (undoPersistTimer !== null) {
    clearTimeout(undoPersistTimer);
    undoPersistTimer = null;
  }
  const s = useNaksha.getState();
  Storage.set(STORAGE_KEYS.undo, s.undoStack.slice(0, PERSISTED_UNDO_DEPTH));
  Storage.set(STORAGE_KEYS.redo, s.redoStack.slice(0, PERSISTED_UNDO_DEPTH));
}

function scheduleUndoRedoPersist(): void {
  if (typeof window === 'undefined') return;
  if (!undoPersistArmed) {
    undoPersistArmed = true;
    const flush = () => {
      if (undoPersistTimer !== null) writeUndoRedoNow();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
  if (undoPersistTimer !== null) clearTimeout(undoPersistTimer);
  undoPersistTimer = setTimeout(() => {
    undoPersistTimer = null;
    writeUndoRedoNow();
  }, 400);
}

export const useNaksha = create<NakshaStore>((set, get) => ({
  ready: false,

  lines: [],
  isLoading: false,
  termSpinner: null,
  captureBuffer: null,

  cwd: '~',
  fsRevision: 0,

  careRevision: 0,
  currentNetworkName: '',
  currentNodeLabel: 'Core',
  breadcrumb: ['Core'],
  careStats: { totalNodes: 1, totalNotes: 0, pinnedLocations: 0, networks: 1 },

  mapLayer: DEFAULT_SETTINGS.mapDefaultLayer,
  mapZoom: 12,
  mapCoord: '—',
  mapReady: false,

  viewHistory: [],
  viewIndex: -1,

  focusActive: false,
  focusNotes: [],
  focusTimerEnd: null,

  nanoOpen: false,
  nanoFile: '',
  /* Phase 6 — the real-nano session is closed by default. */
  nanoPtyRel: null,

  vaultPanelOpen: false,
  vaultStatus: null,
  vaultRevision: 0,
  vaultOpenFile: null,
  vaultCwd: '',
  careVaultStatus: null,
  careVaultMissing: {},
  careVaultRevision: 0,

  reader: initialReader,

  history: [],
  historyIndex: -1,
  reverseSearch: false,
  reverseQuery: '',
  reverseResult: '',

  settings: DEFAULT_SETTINGS,
  aliases: {},
  /* Phase 8 — init() resolves the real value before first paint. */
  directionResolved: 'ltr',

  undoStack: [],
  redoStack: [],

  statusMode: 'idle',

  careViewMode: 'tree',

  paletteOpen: false,
  shortcutsOpen: false,
  jumpOpen: false,
  jumpQuery: '',
  themePickerOpen: false,
  statsOpen: false,
  perfPanelOpen: false,
  perfHudOpen: false,

  timelineOpen: false,
  detailsNodeId: null,
  detailsFlashTs: 0,
  detailsFocusNotes: false,

  /* ────────────────────────────────────────────────────────────
     init
     ──────────────────────────────────────────────────────────── */
  init() {
    /* Task 118 — module inits run BEFORE the ready early-return: dev
     * HMR can re-evaluate the singleton modules (their module-level
     * state resets to cold) while this store's ready flag survives,
     * which used to leave a live fs with no home. Both inits are now
     * internally idempotent, so calling them on every store init is
     * free — and heals the warm-store/cold-module seam. */
    FileSystem.init();
    CareSpace.init();
    if (get().ready) return;
    const settings = Storage.get(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
    const aliases = Storage.get<AliasMap>(STORAGE_KEYS.aliases, {});
    const history = Storage.get<string[]>(STORAGE_KEYS.history, []);
    /* Task 88 — the stack migrates: old sessions stored ONE object
     * under the same key — wrap it, don't waste it (the single step
     * becomes depth 1; nothing the user could undo is lost). */
    const rawUndo = Storage.get<UndoEntry | UndoEntry[] | null>(STORAGE_KEYS.undo, null);
    const undoStack: UndoEntry[] = Array.isArray(rawUndo) ? rawUndo : rawUndo ? [rawUndo] : [];
    /* Task 82 — the future persists too: restored beside the slot so
     * an undo→reload→redo walk lands where it left off. */
    const redoStack = Storage.get<UndoEntry[]>(STORAGE_KEYS.redo, []);
    const mergedSettings = { ...DEFAULT_SETTINGS, ...settings };
    /* Task 112 — the dead `theme` key migration: old saves carry the
     * warm-dark/warm-light field NOTHING ever read (themeId drives the
     * whole theme pipeline). The spread above would faithfully resurrect
     * it forever — so strip it and persist ONCE. One honest write, then
     * the key is out of every profile, and the stored blob says only
     * what is true. */
    if ('theme' in mergedSettings) {
      delete mergedSettings.theme;
      Storage.set(STORAGE_KEYS.settings, mergedSettings);
    }
    // Apply the saved theme's CSS variables to :root
    if (mergedSettings.themeId) {
      applyTheme(mergedSettings.themeId);
    }
    // CPU-only performance mode: detect low-end hardware and set data-perf="low".
    // This disables continuous animations and reduces blur cost. The user can
    // override via `settings perfMode on/off`.
    // Auto-detected 'low' is persisted into settings so every consumer
    // (CSS via data-perf + JS via settings.perfMode) reads one truth.
    const savedPerfMode = mergedSettings.perfMode;
    let effectivePerfMode = savedPerfMode;
    if (savedPerfMode === undefined) {
      const reason = detectLowEndReason();
      if (reason) {
        effectivePerfMode = 'low';
        mergedSettings.perfMode = 'low';
        mergedSettings.perfProvenance = reason; // Task 105 — diagnosable tier
        Storage.set(STORAGE_KEYS.settings, mergedSettings);
      }
    }
    if (effectivePerfMode === 'low') {
      document.documentElement.setAttribute('data-perf', 'low');
    }
    /* Phase 1 — the tier writer moved into perf-tier.ts: a saved stable60
     * profile must re-apply its attribute on reload too (the old branch
     * only knew `low`), and switching tiers resets FrameScheduler counters
     * so diagnostics stay tier-pure. HIGH/undefined still remove the attr. */
    applyPerfDocumentAttr(effectivePerfMode);
    /* Phase 8 — direction applies BEFORE first paint of the reactive
     * tree (same slot as the perf attribute): a saved RTL profile must
     * not flash LTR chrome on reload. 'auto' samples CareSpace content. */
    applyDirectionDocumentAttr(
      mergedSettings.direction,
      effectiveDirection(mergedSettings.direction, sampleAppContent()),
    );
    set({
      settings: mergedSettings,
      aliases,
      history,
      undoStack,
      redoStack,
      ready: true,
    });
    get().syncFs();
    get().syncCare();
    /* Phase 2 — pull the server-side vault state once at boot so a
     * previously-connected directory is known to every consumer (cat -r
     * routing, future context chips) without requiring a `vault` command
     * first. Fire-and-forget: nothing blocks readiness on the network. */
    void get().refreshVaultStatus();
    /* Phase 5 — same boot pull for the CareSpace designation, plus the
     * broken-note markers for already-bound thoughts (a file deleted
     * while the page was away must show ⚠, not silently pretend). */
    void get().refreshCareVaultStatus().then(() => get().refreshCareBoundState());
  },

  /* ────────────────────────────────────────────────────────────
     terminal
     ──────────────────────────────────────────────────────────── */
  print(text, type = 'output', data?: TermLine['data']) {
    // If a capture buffer is active (e.g. `cmd > file`), divert the text.
    if (get().captureBuffer !== null) {
      get().captureBuffer!.push(String(text ?? ''));
      return;
    }
    const line: TermLine = {
      id: generateId('ln'),
      text: String(text ?? ''),
      type,
      ts: Date.now(),
      ...(data ? { data } : {}),
    };
    /* Task T2 (v138) — microtask-batched append. The old code did ONE full
     * buffer copy (up to MAX_TERM_LINES entries) + ONE store notification
     * PER LINE, so an N-line receipt (help, tree, listings) cost O(N×500)
     * copies and N selector evaluations across every `lines` subscriber.
     * Prints issued within the same tick now queue here and flush ONCE on
     * a microtask — one copy, one notification, identical order/content.
     * Synchronous semantics preserved where they matter: the capture
     * buffer diverts BEFORE the queue (start/stopCapture stay exact), and
     * `clear` cancels a pending batch so print→clear still ends empty. */
    termPrintQueue.push(line);
    if (!termFlushScheduled) {
      termFlushScheduled = true;
      queueMicrotask(flushTermPrintQueue);
    }
  },

  printRaw(_html, type = 'output') {
    // For safety we escape on render; raw HTML not allowed in React flow.
    // Callers should pass plain text and use `print` instead.
    get().print(_html, type);
  },

  header(text) {
    get().print(text, 'header');
  },
  highlight(text) {
    get().print(text, 'highlight');
  },
  success(text) {
    get().print(text, 'success');
  },
  error(text) {
    get().print(text, 'error');
  },
  info(text) {
    get().print(text, 'info');
  },
  warning(text) {
    get().print(text, 'warning');
  },
  muted(text) {
    get().print(text, 'muted');
  },

  clear() {
    /* Task T2 — cancel any pending microbatch first: a print issued before
     * a clear in the same tick must not resurrect after the clear. */
    termPrintQueue.length = 0;
    set({ lines: [] });
  },

  startCapture() {
    set({ captureBuffer: [] });
  },
  stopCapture() {
    const buf = get().captureBuffer ?? [];
    set({ captureBuffer: null });
    return buf;
  },

  showLoading(message) {
    /* Perf: the spinner is a dedicated store field, not a `lines` entry.
     * The 10 Hz frame tick now allocates one tiny object instead of
     * re-mapping the whole terminal buffer — the output list keeps a
     * stable identity for the entire duration of the request. */
    const id = generateId('ln');
    set((s) => ({ termSpinner: { id, message }, isLoading: true }));
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const interval = setInterval(() => {
      i = (i + 1) % frames.length;
      set((s) =>
        s.termSpinner?.id === id
          ? { termSpinner: { id, message: `${frames[i]} ${message}` } }
          : s,
      );
    }, 100);
    return {
      stop: (finalMessage, type = 'output') => {
        clearInterval(interval);
        set({ termSpinner: null, isLoading: false });
        if (finalMessage) get().print(finalMessage, type);
      },
    };
  },

  pushHistory(cmd) {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    set((s) => {
      // Dedupe consecutive duplicates.
      const last = s.history[s.history.length - 1];
      const history = last === trimmed ? s.history.slice() : [...s.history, trimmed];
      const trimmedHistory = history.length > MAX_HISTORY
        ? history.slice(history.length - MAX_HISTORY)
        : history;
      Storage.set(STORAGE_KEYS.history, trimmedHistory);
      return { history: trimmedHistory, historyIndex: trimmedHistory.length };
    });
  },

  setHistoryIndex(index) {
    set({ historyIndex: Math.max(-1, Math.min(index, get().history.length)) });
  },

  startReverseSearch() {
    set({ reverseSearch: true, reverseQuery: '', reverseResult: '' });
  },

  updateReverseSearch(query) {
    const { history } = get();
    const lower = query.toLowerCase();
    // Search backward from the most recent entry.
    const match = [...history].reverse().find((h) => h.toLowerCase().includes(lower));
    set({ reverseQuery: query, reverseResult: match ?? '' });
  },

  endReverseSearch() {
    set({ reverseSearch: false, reverseQuery: '', reverseResult: '' });
  },

  /* ────────────────────────────────────────────────────────────
     fs sync
     ──────────────────────────────────────────────────────────── */
  syncFs() {
    set((s) => ({ cwd: FileSystem.getCurrentPath(), fsRevision: s.fsRevision + 1 }));
  },

  /* ────────────────────────────────────────────────────────────
     carespace sync
     ──────────────────────────────────────────────────────────── */
  syncCare() {
    const node = CareSpace.getCurrentNode();
    const stats = CareSpace.getStats();
    set((s) => ({
      careRevision: s.careRevision + 1,
      currentNetworkName: CareSpace.currentNetwork().name,
      currentNodeLabel: node.label,
      breadcrumb: CareSpace.getBreadcrumb(),
      careStats: stats,
    }));
  },

  /* ────────────────────────────────────────────────────────────
     map
     ──────────────────────────────────────────────────────────── */
  setMapReady(ready) {
    set({ mapReady: ready });
  },
  setMapLayer(layer) {
    set({ mapLayer: layer });
  },
  setMapZoom(zoom) {
    set({ mapZoom: zoom });
  },
  setMapCoord(coord) {
    set({ mapCoord: coord });
  },

  pushView(label, view) {
    set((s) => {
      const truncated = s.viewHistory.slice(0, s.viewIndex + 1);
      truncated.push({ label, ...view });
      const trimmed = truncated.length > 50 ? truncated.slice(truncated.length - 50) : truncated;
      return { viewHistory: trimmed, viewIndex: trimmed.length - 1 };
    });
  },

  backView() {
    const { viewHistory, viewIndex } = get();
    if (viewIndex <= 0) return null;
    const newIdx = viewIndex - 1;
    set({ viewIndex: newIdx });
    return viewHistory[newIdx];
  },

  fwdView() {
    const { viewHistory, viewIndex } = get();
    if (viewIndex >= viewHistory.length - 1) return null;
    const newIdx = viewIndex + 1;
    set({ viewIndex: newIdx });
    return viewHistory[newIdx];
  },

  /* ────────────────────────────────────────────────────────────
     focus
     ──────────────────────────────────────────────────────────── */
  setFocusActive(active) {
    set({ focusActive: active });
    if (!active) set({ focusTimerEnd: null });
  },
  addFocusNote(text) {
    const note = {
      text,
      timestamp: Date.now(),
      timeString: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
    };
    set((s) => ({ focusNotes: [...s.focusNotes, note] }));
  },
  clearFocusNotes() {
    set({ focusNotes: [] });
  },
  setFocusTimerEnd(end) {
    set({ focusTimerEnd: end });
  },

  /* ────────────────────────────────────────────────────────────
     carespace view mode
     ──────────────────────────────────────────────────────────── */
  setCareViewMode(mode) {
    set({ careViewMode: mode });
  },

  /* ────────────────────────────────────────────────────────────
     nano
     ──────────────────────────────────────────────────────────── */
  setNanoOpen(open, file) {
    set({ nanoOpen: open, nanoFile: file ?? '' });
  },

  /* Phase 6 — real-nano session. Opening one closes the internal
   * editor (two editors over two worlds is one too many on screen) and
   * vice versa; the receipts in commands.ts name the world either way. */
  openNanoPty(rel) {
    set({ nanoPtyRel: rel, nanoOpen: false, nanoFile: '' });
  },
  closeNanoPty() {
    set({ nanoPtyRel: null });
  },

  /* ────────────────────────────────────────────────────────────
     reader
     ──────────────────────────────────────────────────────────── */
  openReader(state) {
    set({ reader: { ...state, open: true } });
  },
  closeReader() {
    set({ reader: initialReader });
  },

  /* ────────────────────────────────────────────────────────────
     settings & aliases
     ──────────────────────────────────────────────────────────── */
  refreshDirection() {
    /* Phase 8 — the applier lives in lib/naksha/direction.ts; this
       action is the store-facing door the settings command and the
       Naksha shell both call. Reads fresh state (not a stale closure)
       and mirrors the RESOLVED value into state for reactive chips. */
    const s = get().settings;
    const effective = effectiveDirection(s.direction, sampleAppContent());
    applyDirectionDocumentAttr(s.direction, effective);
    if (get().directionResolved !== effective) set({ directionResolved: effective });
  },
  setSettings(partial) {
    /* NOT a set((s)=>) updater: applyTheme + MapEngine.setLayer are
       side-effectful, so we read state via get() and commit once. */
    const s = get();
    const next = { ...s.settings, ...partial };
    const layerPatch: { mapLayer?: MapLayerKey } = {};
    // If the theme changed, apply it immediately.
    if (partial.themeId && partial.themeId !== s.settings.themeId) {
      applyTheme(partial.themeId);
      /* Theme-aware basemap (Task 33): switch the map layer only when
       * the user never diverged from the previous theme's default — an
       * explicit `layer standard` stays sticky across themes. */
      const prevThemeLayer = getThemeMapLayer(s.settings.themeId);
      if (next.mapDefaultLayer === prevThemeLayer) {
        const themeLayer = getThemeMapLayer(partial.themeId);
        if (themeLayer !== next.mapDefaultLayer) {
          next.mapDefaultLayer = themeLayer;
          layerPatch.mapLayer = themeLayer;
          MapEngine.setLayer(themeLayer);
        }
      }
    }
    Storage.set(STORAGE_KEYS.settings, next);
    set({ settings: next, ...layerPatch });
    /* Phase 8 — a direction change re-asserts the root attributes
       immediately (the command already called refreshDirection, but the
       panel/store path must not depend on remembering to do so). */
    if (partial.direction !== undefined) {
      const effective = effectiveDirection(next.direction, sampleAppContent());
      applyDirectionDocumentAttr(next.direction, effective);
      if (get().directionResolved !== effective) set({ directionResolved: effective });
    }
  },
  setAlias(name, command) {
    set((s) => {
      const aliases = { ...s.aliases, [name]: command };
      Storage.set(STORAGE_KEYS.aliases, aliases);
      return { aliases };
    });
  },
  removeAlias(name) {
    set((s) => {
      const aliases = { ...s.aliases };
      delete aliases[name];
      Storage.set(STORAGE_KEYS.aliases, aliases);
      return { aliases };
    });
  },

  /* ────────────────────────────────────────────────────────────
     undo
     ──────────────────────────────────────────────────────────── */
  setUndo(entry, opts) {
    /* Task 60 — the single-slot surprise, spoken — RETIRED in Task 88:
     * the slot became a STACK, so a new action discards NOTHING and
     * the "slot replaced" line loses its referent (it died honestly
     * with the slot; the Task 61 same-label rule dies with it —
     * same-label pushes are now legitimate distinct steps).
     * Task 81/88 — the truncation rule lives HERE, one place: a NEW
     * action (non-null entry, no keepRedo lease) kills the redo
     * future — the forward pointer only survives undo/redo walking
     * the same line. The forfeit line (Task 83) stays: its count was
     * built "for the day undo grows depth", and this is that day.
     * Task 88 — the PUSH: newest first, capped at 32 (the same bound
     * the redo stack carries, silenced the same way — editors don't
     * narrate their undo limit; `hist` shows the depth). Every park
     * persists: the array rides STORAGE_KEYS.undo, so depth survives
     * a reload. */
    if (entry === null) {
      /* The whole line clears (kept for completeness — the undo walk
       * uses dropUndoHead; today only legacy callers pass null). */
      Storage.set(STORAGE_KEYS.undo, []);
      set({ undoStack: [] });
      return;
    }
    if (!opts?.keepRedo) {
      /* v138 T5 — the truncation write is now CONDITIONAL: `Storage.set`
       * is a SYNCHRONOUS stringify+setItem, and this ran on EVERY action
       * (every rename, every note, every care mutation) even when the
       * redo stack was already empty — the common case — paying one full
       * sync write for nothing. The truncation semantics are unchanged:
       * a non-empty future is still killed in memory AND storage; an
       * empty future has nothing to truncate, so nothing is written
       * (an absent/empty redo key on reload restores to [] anyway). */
      const doomed = get().redoStack;
      if (doomed.length > 0) {
        get().print(
          doomed.length > 1
            ? `  redo future (${doomed.length}) forfeited — "${doomed[0].label}" would have been next`
            : `  redo future forfeited — "${doomed[0].label}" would have been next`,
          'muted',
        );
        /* Task 82 — truncation clears the PERSISTED future too: the
         * storage copy must never outlive the memory copy (or a reload
         * would resurrect a future the session already killed). */
        Storage.set(STORAGE_KEYS.redo, []);
        set({ redoStack: [] });
      }
    }
    const next = [entry, ...get().undoStack].slice(0, 32);
    set({ undoStack: next });
    /* Persisted via the debounced bounded-tail writer (see the plumbing
     * note above the store). The redo truncation ABOVE stays synchronous —
     * a killed future must never outlive its storage copy. */
    scheduleUndoRedoPersist();
  },

  dropUndoHead() {
    /* Task 88 — the walk's tail: the head is gone AFTER its restore
     * succeeded (the verb peeks undoStack[0] first, so a thrown
     * restore never loses the entry). */
    const rest = get().undoStack.slice(1);
    set({ undoStack: rest });
    scheduleUndoRedoPersist();
  },

  pushRedo(entry) {
    /* Task 81 — newest first, capped: a long undo walk is a bounded
     * memory of the walk, not a full history journal (the slot stays
     * single-head; the stack only holds what THIS session undid).
     * Task 82 — every park persists: the cap (32) bounds the storage
     * cost the same way it bounds the memory cost. */
    const next = [entry, ...get().redoStack].slice(0, 32);
    set({ redoStack: next });
    scheduleUndoRedoPersist();
  },

  consumeRedo() {
    const [head, ...rest] = get().redoStack;
    set({ redoStack: rest });
    scheduleUndoRedoPersist();
    return head ?? null;
  },

  /* ────────────────────────────────────────────────────────────
     status
     ──────────────────────────────────────────────────────────── */
  setStatusMode(mode) {
    set({ statusMode: mode });
  },

  /* ────────────────────────────────────────────────────────────
     command palette + shortcuts overlay
     ──────────────────────────────────────────────────────────── */
  setPaletteOpen(open) {
    set({ paletteOpen: open });
  },
  setShortcutsOpen(open) {
    set({ shortcutsOpen: open });
  },
  setJumpOpen(open, query) {
    set({ jumpOpen: open, jumpQuery: query ?? '' });
  },
  setThemePickerOpen(open) {
    set({ themePickerOpen: open });
  },
  setStatsOpen(open) {
    set({ statsOpen: open });
  },
  setPerfPanelOpen(open) {
    set({ perfPanelOpen: open });
  },

  setPerfHudOpen(open) {
    set({ perfHudOpen: open });
  },

  /* ────────────────────────────────────────────────────────────
     timeline view + node details panel
     ──────────────────────────────────────────────────────────── */
  setTimelineOpen(open) {
    set({ timelineOpen: open });
  },
  setDetailsNodeId(id, flash = false, focusNotes = false) {
    /* Task 48 — the optional flash flag rides along as a fresh timestamp;
     * the panel consumes it on mount (see NodeDetailsPanel). Task 49 —
     * the focus-notes intent rides the same arrival bundle (reset to
     * false whenever it isn't asked for, so stale intent can't linger). */
    set({
      detailsNodeId: id,
      detailsFocusNotes: focusNotes,
      ...(flash ? { detailsFlashTs: Date.now() } : {}),
    });
  },

  /* ────────────────────────────────────────────────────────────
     vault (Phase 2) — connected real directory, read-only
     ──────────────────────────────────────────────────────────── */
  setVaultPanelOpen(open) {
    set({ vaultPanelOpen: open });
  },
  setVaultOpenFile(rel) {
    set({ vaultOpenFile: rel });
  },
  setVaultCwd(rel) {
    /* Normalized at the single write point: no leading/trailing slashes,
     * no `.` segments, no null bytes — a jailed rel or '' (the root). */
    const clean = rel
      .replace(/\\/g, '/')
      .split('/')
      .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
      .join('/');
    set({ vaultCwd: clean });
  },
  async refreshVaultStatus() {
    try {
      const res = await fetch('/api/vault/status', { cache: 'no-store' });
      const data = (await res.json()) as VaultStatus & { ok: boolean };
      if (data.ok) {
        /* Perf: the 45s status poll + focus listener used to `set` a
         * fresh object every time, re-rendering every vaultStatus
         * subscriber (including the 500-row terminal) even when nothing
         * changed. Compare field-by-field and keep the old identity on
         * no-op polls. */
        const prev = get().vaultStatus;
        const unchanged =
          prev !== null &&
          prev.ok === data.ok &&
          prev.connected === data.connected &&
          prev.available === data.available &&
          prev.root === data.root &&
          prev.name === data.name &&
          prev.mdCount === data.mdCount &&
          prev.fileCount === data.fileCount &&
          prev.careVault === data.careVault &&
          prev.watch?.armed === data.watch?.armed &&
          prev.watch?.clients === data.watch?.clients &&
          prev.watch?.snapshotEntries === data.watch?.snapshotEntries;
        if (!unchanged) set({ vaultStatus: data });
        /* Phase 3 — server-validated persistence, SPOKEN: a saved
         * 'connected' pref the server cannot honor resolves to internal
         * with a visible one-time notice. Never silent, never migrated —
         * the pref itself is untouched (a later reconnect re-honors it). */
        const pref = get().settings.storageContext;
        if (pref === 'connected' && !vaultContextFallbackNotified) {
          const resolved = resolveStorageContext(pref, data);
          if (resolved.kind === 'internal' && resolved.reason === 'fallback-unavailable') {
            vaultContextFallbackNotified = true;
            get().warning(
              `storage context: saved 'connected'${data.name ? ` (${data.name})` : ''} is unavailable — active context fell back to internal · nothing was touched`,
            );
          }
        }
        return data;
      }
    } catch {
      /* server unreachable — keep the previous status; the panel shows
         its own error state from the failed fetch there */
    }
    return null;
  },
  async connectVault(absPath) {
    try {
      const res = await fetch('/api/vault/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: absPath }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) return { ok: false, error: data.error ?? 'connect failed' };
      await get().refreshVaultStatus();
      /* Phase 5 — a new connection re-evaluates the designation: the
       * flag file may point at a DIFFERENT root (never inherited). */
      await get().refreshCareVaultStatus();
      /* Phase 4 — a fresh connection starts the vault-world terminal at
       * the vault root: a cwd from a PREVIOUS connection must never
       * leak into this one (different directory, different world). */
      set({ vaultRevision: get().vaultRevision + 1, vaultCwd: '' });
      /* Phase 3 — connecting is an explicit user action, so following it
       * with the context switch is not silent: the receipts (command and
       * panel) say the active context moved to connected:<name>. The
       * internal FS stays fully intact either way. */
      get().setSettings({ storageContext: 'connected' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
  async disconnectVault() {
    try {
      await fetch('/api/vault/disconnect', { method: 'POST' });
    } catch {
      /* best-effort — the status refresh below reflects the truth */
    }
    /* vaultCwd dies with the connection — there is no directory to stand in. */
    set({ vaultOpenFile: null, vaultRevision: get().vaultRevision + 1, vaultCwd: '' });
    await get().refreshVaultStatus();
    /* Phase 5 — no directory → no writable gate → markers clear. */
    await get().refreshCareVaultStatus();
    await get().refreshCareBoundState();
    /* Phase 3 — with no directory connected there is nothing a
     * 'connected' pref could mean; the context falls back to internal
     * (receipt says so). Internal storage was never touched. */
    get().setSettings({ storageContext: 'internal' });
  },
  bumpVaultRevision() {
    /* External change bursts (one editor save → N SSE events, one vault
     * command → several writes) used to bump the revision N times → N
     * panel re-fetches + N care-bound probes. A short trailing debounce
     * collapses each burst into ONE revision bump ≤250ms after the last
     * event; direct user actions (refresh button, vault commands) simply
     * land inside the same window — the lag is imperceptible. */
    if (vaultBumpTimer) clearTimeout(vaultBumpTimer);
    vaultBumpTimer = setTimeout(() => {
      vaultBumpTimer = null;
      set({ vaultRevision: get().vaultRevision + 1 });
      /* Phase 5 — an external change may have created/deleted a bound
       * note file: re-probe so the ⚠/▤ markers tell the truth. Cheap when
       * nothing is bound (the probe returns before any fetch). */
      void get().refreshCareBoundState();
    }, 250);
  },

  /* ────────────────────────────────────────────────────────────
     CareSpace vault (Phase 5) — designated writable vault
     ──────────────────────────────────────────────────────────── */
  async refreshCareVaultStatus() {
    const data = await fetchCareVaultStatus();
    if (data) set({ careVaultStatus: data });
    return data;
  },
  async designateCareVault(on) {
    const r = await apiDesignateCareVault(on);
    if (r.ok) {
      await get().refreshCareVaultStatus();
      /* The writable gate changed: markers re-probe (or clear). */
      await get().refreshCareBoundState();
    }
    return r;
  },
  async refreshCareBoundState() {
    const status = get().careVaultStatus ?? (await get().refreshCareVaultStatus());
    const active = !!status?.designated && !!status?.vaultAvailable;
    if (!active) {
      /* No writable gate → no honest markers. Clear (cheap no-op when
       * already empty) so a stale ⚠ never outlives its cause. */
      if (Object.keys(get().careVaultMissing).length > 0) {
        set({ careVaultMissing: {}, careVaultRevision: get().careVaultRevision + 1 });
      }
      return;
    }
    const rels = Array.from(
      new Set(CareSpace.data.networks.flatMap((n) => Object.values(n.nodes).map((nd) => nd.vaultPath).filter((p): p is string => !!p))),
    ).slice(0, 200);
    if (rels.length === 0) {
      if (Object.keys(get().careVaultMissing).length > 0) {
        set({ careVaultMissing: {}, careVaultRevision: get().careVaultRevision + 1 });
      }
      return;
    }
    const exists = await careVaultCheck(rels);
    const missing: Record<string, boolean> = {};
    for (const rel of rels) if (exists[rel] === false) missing[rel] = true;
    set({ careVaultMissing: missing, careVaultRevision: get().careVaultRevision + 1 });
  },
}));
