/**
 * Naksha — Type definitions
 * Single source of truth for all data shapes across the app.
 */

/* ══════════════════════════════════════════════════════════════════
   File System
   ══════════════════════════════════════════════════════════════════ */

export interface FSDir {
  type: 'dir';
  contents: Record<string, FSNode>;
}

export interface FSFile {
  type: 'file';
  content: string;
  /** Optional mount info if this is a real-folder mount point */
  mount?: {
    handle: string; // serialized handle id (File System Access API)
    name: string;
  };
}

export type FSNode = FSDir | FSFile;

export interface FSListResult {
  success: boolean;
  isFile?: boolean;
  name?: string;
  entries?: string[];
  node?: FSNode;
  error?: string;
}

export interface FSReadResult {
  success: boolean;
  content?: string;
  error?: string;
}

export interface FSOpResult {
  success: boolean;
  error?: string;
}

/* ══════════════════════════════════════════════════════════════════
   CareSpace — Hierarchical thought management
   ══════════════════════════════════════════════════════════════════ */

export interface CareNote {
  text: string;
  timestamp: number;
  timeString: string;
}

export interface CareLocation {
  lat: number;
  lng: number;
  zoom: number;
}

export type NodeTag = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'none';

export interface CareNode {
  id: string;
  label: string;
  parentId: string | null;
  children: string[];
  notes: CareNote[];
  location: CareLocation | null;
  tags: NodeTag[];
  collapsed: boolean;
  /** Custom (non-hierarchical) links to other node ids */
  links: string[];
  /** Optional labels for custom links, keyed by the other node's id.
   *  A label set on EITHER side of the pair applies to the link
   *  (`link A to B as "mentors"` writes it on both A and B). Optional
   *  so pre-label persisted data loads without migration. */
  linkLabels?: Record<string, string>;
  /** Phase 5 — the node's bound REAL note, as a vault-relative path
   *  ("Projects/Roadmap.md"). This is the stable relative-path identity
   *  the whole CareSpace↔filesystem bridge keys on: the note TEXT lives
   *  in the real file; every piece of app metadata (id, tags, links,
   *  location, timestamps) stays HERE, in internal storage — no
   *  frontmatter is written into files CareSpace did not create.
   *  Undefined = an ordinary internal-only thought. */
  vaultPath?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CareNetwork {
  id: string;
  name: string;
  color: string; // hex
  currentId: string; // root id of this network
  nodes: Record<string, CareNode>;
  /** Optional per-network basemap preference (Task 35) — `netlayer` sets
   *  it, `use <net>` applies it. Undefined = follow the global theme
   *  default. Explicit user choice, so it overrides the theme migration. */
  mapLayer?: MapLayerKey;
}

export interface CareSpaceData {
  networks: CareNetwork[];
  currentNetworkIndex: number;
  /** Increment on every mutation so renderers can dirty-check */
  revision: number;
}

export interface CareOpResult<T = void> {
  success: boolean;
  error?: string;
  data?: T;
}

/* ══════════════════════════════════════════════════════════════════
   Map
   ══════════════════════════════════════════════════════════════════ */

export interface MapLayerConfig {
  name: string;
  url: string;
  attribution: string;
  maxZoom: number;
  subdomains?: string[];
}

export type MapLayerKey = 'standard' | 'hot' | 'satellite' | 'topographic' | 'dark';

export interface MapPin {
  number: number;
  label: string;
  lat: number;
  lng: number;
  marker?: unknown; // Leaflet marker ref (kept out of TS to avoid importing L types broadly)
}

export interface MapView {
  name: string;
  lat: number;
  lng: number;
  zoom: number;
  layer: MapLayerKey;
  createdAt: number;
}

export interface ViewHistoryEntry {
  label: string;
  lat: number;
  lng: number;
  zoom: number;
  layer: MapLayerKey;
}

/* ══════════════════════════════════════════════════════════════════
   Terminal
   ══════════════════════════════════════════════════════════════════ */

export type TermLineType =
  | 'cmd'
  | 'output'
  | 'success'
  | 'error'
  | 'info'
  | 'warning'
  | 'highlight'
  | 'muted'
  | 'header'
  | 'file-output';

export interface TermLine {
  id: string;
  text: string;
  type: TermLineType;
  ts: number;
  /* Task 42 — optional line-level action payload. Currently only `fly`:
   * the row is rendered with data-fly-* attributes + the `term-fly`
   * class, and ONE delegated click listener on the output container
   * (TerminalPane, mount-once) flies the map there. No per-line React
   * handlers, no re-renders — the hot path stays style-only. */
  data?: {
    /* Task 54 — fly rows can carry an explicit label (the view receipt
     * re-flies by name, not by parsing its own text). */
    fly?: { lat: number; lng: number; zoom?: number; label?: string };
    /** Task 44 — provenance bullet: a CSS color drawn as a ● before the
     *  row's text (the node's first-tag tint, same rule as map markers
     *  and graph dots). Render-only — no interaction, no handlers. */
    bullet?: string;
    /* Task 87 — the hollow twin: the row's bullet renders as ○ instead
     * of ● — the graph's "absence owns the ring" dialect (Task 76's
     * hollow untagged dot) reaching the terminal. Pure render, same
     * span, zero new CSS. */
    bulletHollow?: boolean;
    /* Task 46 — jump row: the row renders with the `term-jump` class +
     * data-jump-* attributes; the same delegated click listener branches
     * on it and lands the CareSpace TREE on that node (switching rivers
     * and dropping out of graph view if needed). One listener, two verbs:
     * `.term-fly` moves the MAP, `.term-jump` moves the TREE. */
    jump?: { nodeId: string; river?: string };
    /* Task 47 — nested ↗ fly badge: a small gold chip printed at the tail
     * of a jump row when the thought has a pinned location. The badge
     * carries its own data-fly-* attrs and the delegated listener checks
     * it BEFORE the enclosing jump row — so one row speaks both verbs:
     * click the text = tree landing (⇥), click the badge = map fly (↗).
     * Zero new handlers: still the one delegated listener, still dumb
     * divs — the badge is a span with data attributes. */
    flyBadge?: { lat: number; lng: number; zoom?: number; label?: string };
    /* Task 48 — the MIRROR twin: a small ⇥ chip printed at the tail of a
     * FLY row (today: `near` results) that opens the thought in the tree
     * (+ details) without giving up the row's primary verb. Checked even
     * before .term-flybadge in the delegated listener — chips first, then
     * row-level verbs. Violet tint = the tree side of the bridge. */
    jumpBadge?: { nodeId: string; river?: string; label?: string; mark?: string; tint?: string };
    /* Task 68 — `tint`: the TARGET's identity hue (the Task 67 rule —
     * tint = what the chip points at). A care row's ⇥ badge wears the
     * left-off thought's first tag color; a links row's ⇥ chip wears
     * the OTHER endpoint's tag color. No tag → no tint → the violet
     * tree dialect stays (nothing to say is said by silence). */
    /* Task 59 — `mark`: the counted ▤N / ● token the ROW already wears,
     * handed to the chip so its tooltip names the same fact the row
     * does ("⇥ open "X" ▤2 in the tree") — one fact, not two stories. */
    /* Task 49 — the FILESYSTEM verb: an `ls` row (dir or file) carries
     * the absolute path + what it is. The delegated listener's .term-fsrow
     * branch turns a click into `cd` (folder) or `cat` (file) — the last
     * non-interactive output family joins the dialect. Binary-ish
     * extensions get no payload (non-clickable rows).
     * Phase 4 — `world: 'vault'` marks rows printed from the CONNECTED
     * real directory (rel paths): the click verbs resolve them through
     * the vault API + vault cwd, never against the internal FS. Rows
     * without the marker stay internal-world (byte-identical behavior). */
    fs?: { path: string; kind: 'dir' | 'file'; world?: 'vault' };
    /* Task 52 — the DELETE verb: a `notes` row carries the owning node id
     * + the note's chronological index (the same number `delnote` takes).
     * The delegated listener's .term-delrow branch deletes it with full
     * undo parity — the index list IS the delete button. Rows render a
     * strike-through hover so the verb is legible before the click. */
    del?: { nodeId: string; index: number };
    /* Task 52 — the READER chip: an `ls` FILE row whose extension is
     * reader-eligible (md/markdown/txt/rst) carries the absolute path so
     * a small ▤ chip at the row's tail opens it in the reader panel —
     * the same surface `cat -r` uses. Row click stays raw `cat`; the
     * chip is the rendered twin. Checked with the chips (before row
     * verbs), since it nests inside a .term-fsrow.
     * Phase 4 — `world: 'vault'`: the chip reads the REAL file through
     * the vault API and renders it with the vault wikilink pipeline. */
    read?: { path: string; world?: 'vault' };
    /* Task 53 — the COUNT chip: a `shapes` owner row carries the exact
     * command that lists ONLY that thought's sketches. A small boxed
     * count at the row's tail re-runs it — chip = `shapes <node>` filter,
     * text stays the ⇥ tree landing, ↗ still flies. Checked with the
     * chips (before row verbs), since it nests inside a .term-jump.
     * Task 65 — `label`/`title` let a filter chip speak a DIFFERENT
     * glyph than the boxed ≡ (near rows wear ⚑N: the pin's list is one
     * click away) without a sixth chip class for one verb. */
    filter?: { cmd: string; label?: string; title?: string };
    /* Task 66 — the PLURAL twin: rows that teach more than one verb
     * (demo's try line, stats' per-river line) carry an ARRAY of filter
     * chips instead of one. Rendered as consecutive .term-filterchip
     * spans — the delegated listener and doFilter see the same class
     * and data attribute they always have, so multiple chips per row
     * cost ZERO new click machinery: each chip is still "echo + run
     * this exact cmd". The single `filter` payload stays for the
     * boxed-≡ owners-row surface (and near's ⚑N).
     * Task 67 — `tint`: an optional river color worn by the chip
     * itself (stats' per-river chips ride their network's hue). The
     * bullet payload tints ROWS; this is the same fact for chips —
     * one CSS var (--chip-tint) the stylesheet consumes, so hover
     * stays gold and no JS color math is needed. */
    chips?: { cmd: string; label: string; title?: string; tint?: string; kbd?: boolean }[];
    /* Task 53 — the KILL chip: a ✕ chip on `pins` and `views` rows that
     * deletes that pin (delpin) or saved view (rmview) — full command
     * parity, destructive rust tint like .term-delrow. The row's own
     * click stays its primary verb (fly / apply); the chip is the
     * destructive twin. Chips win over row verbs in the listener. */
    kill?: { pin?: number; view?: string };
    /* Task 53 — the APPLY verb: a `views` row carries the saved view's
     * name; the delegated listener's .term-viewrow branch applies it
     * (flyToView + layer sync) — the exact `view <name>` surface. The
     * last static list joins the dialect: every saved view answers a
     * click, and its ✕ chip answers rmview. */
    view?: { name: string };
  };
}

/* ══════════════════════════════════════════════════════════════════
   Vault — connected real directory (Phase 2, read-only)
   ══════════════════════════════════════════════════════════════════ */

/** Mirrors GET /api/vault/status — the single source of truth for the
 *  connected-directory state across all UI surfaces. */
export interface VaultStatus {
  connected: boolean;
  available: boolean;
  root: string | null;
  name: string | null;
  mdCount: number;
  fileCount: number;
  connectedAt?: number;
  /** Phase 5 — the connected vault is designated as the writable
   *  CareSpace vault (care notes live here as real .md files). */
  careVault?: boolean;
  /** Phase 7 — the change watcher's honest live state (idle-to-zero
   *  cost when no SSE listener exists). Absent on older payloads. */
  watch?: {
    armed: boolean;
    clients: number;
    snapshotEntries: number;
    lastEventAt: number | null;
  };
}

/* ══════════════════════════════════════════════════════════════════
   CareSpace vault (Phase 5) — the designated writable vault
   ══════════════════════════════════════════════════════════════════ */

/** Mirrors GET /api/care-vault/status — whether CareSpace may write
 *  notes into the connected real directory. `designated` is only true
 *  when the designation file points at the CURRENT vault's root and the
 *  directory is available; a designation for some other root never
 *  silently applies. */
export interface CareVaultStatus {
  designated: boolean;
  /** Raw designation flag even when it points at a different root
   *  (lets the UI say "designated vault points elsewhere"). */
  designatedFlag: boolean;
  root: string | null;
  name: string | null;
  designatedAt?: number;
  vaultConnected: boolean;
  vaultAvailable: boolean;
}

/* ══════════════════════════════════════════════════════════════════
   Storage context (Phase 3) — internal vs connected separation
   ══════════════════════════════════════════════════════════════════ */

/** Which storage world the app's context-aware surfaces emphasize.
 *  'internal'  — the browser-side virtual FS (localStorage), always on.
 *  'connected' — the explicitly connected real directory (read-only
 *                vault surfaces resolve here when it is available).
 *  This is a USER CHOICE persisted in settings; it is validated against
 *  the live server-side vault status on every boot and status refresh —
 *  a saved 'connected' that the server cannot honor falls back to
 *  'internal' with a visible notice, never silently. */
export type StorageContextPref = 'internal' | 'connected';

/** The resolved, currently-active storage context. Derived (never
 *  persisted itself) from the saved pref + live VaultStatus. */
export interface StorageContext {
  kind: StorageContextPref;
  /** Real directory root when kind === 'connected' (null otherwise). */
  root: string | null;
  /** Vault display name when connected (null otherwise). */
  name: string | null;
  /** Honest provenance: why the context is what it is right now.
   *  'default'               — nothing chosen yet (no vault ever connected).
   *  'chosen'                — the user picked it (connect, disconnect,
   *                            `context <x>`, or the panel switcher).
   *  'fallback-unavailable'  — a saved 'connected' the server cannot
   *                            currently honor (dir gone / never was). */
  reason: 'default' | 'chosen' | 'fallback-unavailable';
}

/* ══════════════════════════════════════════════════════════════════
   Settings & Aliases
   ══════════════════════════════════════════════════════════════════ */

export interface NakshaSettings {
  /* Task 112 — the dead `theme: 'warm-dark' | 'warm-light'` field is
   * GONE. It predates themeId (the one-palette era), was written by the
   * default and carried by every persist spread, but NO code ever read
   * it — theme switching is themeId → applyTheme → data-theme, end to
   * end. Worse, the stored value could silently lie: after switching to
   * a light palette it still said 'warm-dark'. init() now strips the
   * stale key from old saves with one honest migration write. */
  themeId: string; // which color palette (amber-night, forest-deep, etc.)
  terminalFont: 'mono' | 'serif';
  mapDefaultLayer: MapLayerKey;
  caresolution: number; // terminal/carespace split %
  mapsplit: number; // map/(terminal+carespace) split %
  particlesEnabled: boolean;
  /**
   * Performance tier. Three tiers, one system (LOW < STABLE_60 < HIGH):
   *  'low'     — CPU-only floor: zero blur, zero continuous animation,
   *              canvas loops capped at 20fps with idle sleep.
   *  'stable60'— balanced 60 FPS lock: opaque settled glass (zero
   *              backdrop-filter cost, like LOW) but FULL-rate interaction
   *              (no 20/30fps canvas caps), rendering frame-limited to 60
   *              via the shared FrameScheduler with live diagnostics.
   *              CPU may rise vs LOW; never a busy-loop.
   *  'high'    — full frosted glass + ambience + 30fps workspace cap.
   */
  perfMode?: 'low' | 'stable60' | 'high';
  /** Task 105 — how the ACTIVE perf tier was decided: 'chosen' = the user
   *  ran `settings perf low|high`; 'auto-hardware' = the CPU/memory/
   *  software-render detection fired at init; 'auto-reduced-motion' = the
   *  OS prefers-reduced-motion signal fired. Labels only — never read by
   *  detection (which still applies only when perfMode is unset). Profiles
   *  that predate the field simply render unlabeled. */
  perfProvenance?: 'chosen' | 'auto-hardware' | 'auto-reduced-motion';
  /** Phase 3 — which storage world the app emphasizes: the internal
   *  (localStorage) FS or the connected real directory. Persisted user
   *  choice; re-validated against live vault status on every boot (a
   *  stale 'connected' falls back to 'internal' with a visible notice).
   *  Undefined profiles resolve as 'internal' (the historical default). */
  storageContext?: StorageContextPref;
  /** Render CareSpace nodes that carry a location as violet markers on the
   *  map (live-synced with careRevision). Opt-in — off by default so the
   *  CPU-only baseline stays marker-free until the user asks for it. */
  showNodesOnMap?: boolean;
  /** Phase 8 — text direction of the chrome. 'auto' follows the first
   *  strong RTL character found in the app's own content (CareSpace
   *  labels/notes); explicit 'ltr'/'rtl' win. Applied to <html dir> via
   *  lib/naksha/direction.ts. Orthogonal to uiLang on purpose. */
  direction?: 'auto' | 'ltr' | 'rtl';
  /** Phase 8 — i18n-lite: Persian chrome labels behind 'fa' (status bar,
   *  vault panel, perf panel). English default and fallback; terminal
   *  command syntax/receipts stay English by design. */
  uiLang?: 'en' | 'fa';
}

export type AliasMap = Record<string, string>;

/* ══════════════════════════════════════════════════════════════════
   Reader panel (wiki / web / weather)
   ══════════════════════════════════════════════════════════════════ */

export interface WikiArticle {
  title: string;
  description: string;
  extract: string;
  thumbnail?: string;
  url: string;
  /* Task 46 — place coordinates when the article is about a location
   * (Wikipedia summary API `coordinates`). Optional: most articles
   * (concepts, people) have none, and the fly row is then skipped. */
  lat?: number;
  lon?: number;
}

export interface WeatherReport {
  place: string;
  temperature: number;
  windspeed: number;
  winddir: number;
  weatherCode: number;
  description: string;
  /* Task 46 — geocode hit coordinates (Open-Meteo geocoding always has
   * them); lets the receipt row fly the map to the forecast place. */
  lat?: number;
  lon?: number;
}

export interface ReaderState {
  open: boolean;
  /* Task 51 — 'file': a filesystem text/markdown file opened by
   * `cat -r`, rendered in the same glass panel as wiki articles. */
  kind: 'wiki' | 'web' | 'weather' | 'file' | null;
  title: string;
  /** HTML or plain text body */
  body: string;
  /** Optional image URL */
  image?: string;
  /** External link */
  link?: string;
  /** For weather — structured data */
  weather?: WeatherReport;
  /** Phase 8 — the per-note base direction for 'file' kind (detected
   *  from the RAW content at open time, before markdown conversion).
   *  Undefined = legacy open / non-file kinds → the panel uses dir=auto
   *  + unicode-bidi plaintext, which lands the same visual result. */
  direction?: 'ltr' | 'rtl';
}

/* ══════════════════════════════════════════════════════════════════
   Undo
   ══════════════════════════════════════════════════════════════════ */

export interface UndoEntry {
  /* Task 54 — 'mapdata': pins + saved views snapshot (the kill chip's
   * undo parity — one ✕ on a pins/views row restores via `undo`). */
  kind: 'fs' | 'care' | 'network' | 'mapdata';
  label: string;
  /** Snapshot of relevant state to restore */
  snapshot: unknown;
  ts: number;
}
