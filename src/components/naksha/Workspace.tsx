'use client';

/**
 * Naksha — Workspace (replaces Focus Mode)
 *
 * A fullscreen canvas where the user sees ONLY the dot-grid background
 * (no glass panels). The dots become "stars" — the user can:
 *   • Click a star and drag to another star to draw a line between them
 *   • Close a shape (rectangle, triangle, polygon) → it fills with glass
 *   • Write notes inside closed shapes
 *   • Clear lines / shapes
 *
 * Inspired by constellation-drawing UIs. Pure canvas for performance.
 *
 * The star positions are the SAME dot-grid positions (computed from the
 * DotGridBackground's gap/dotSize), so the stars align with the
 * background visually.
 *
 * Performance:
 *  - Single canvas, DPR-capped at 1.5 (CPU-friendly)
 *  - rAF only runs during drag/interaction, sleeps after 2s idle
 *  - No backdrop-filter (the background IS the dot grid, no glass)
 *  - Lines are simple quadratic curves, O(N) where N = shapes
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useNaksha } from '@/lib/naksha/store';
import { CareSpace } from '@/lib/naksha/carespace';
import { MapEngine } from '@/lib/naksha/map-engine';
import { Storage } from '@/lib/naksha/storage';
import { STORAGE_KEYS, TAG_COLORS } from '@/lib/naksha/constants';
import { FrameScheduler } from '@/lib/naksha/frame-scheduler';
import { canvasInk } from '@/lib/naksha/themes';
import {
  listShapeFiles,
  moveShapeFile,
  pickShapeStorage,
  removeShapeFile,
  shapeFileBase,
  shapePathLabel,
  splitShapeRel,
  writeShapeFile,
  SHAPE_DIR_INTERNAL,
  SHAPE_DIR_VAULT,
  type ShapeFileData,
  type ShapeStorage,
} from '@/lib/naksha/shape-files';
import { NodeQuickJump, type NodePick } from './NodeQuickJump';
import type { NodeTag, UndoEntry } from '@/lib/naksha/types';

interface Star {
  x: number;
  y: number;
  id: number;
}

interface Line {
  from: number; // star id
  to: number;
}

interface Shape {
  starIds: number[]; // ordered list of star ids forming the closed polygon
  /* v138 T4 — the name/note split. Until now ONE string (note) carried
   * what was really a NAME (Task 76's input saved there). A shape now
   * has a NAME (its identity, shown on the canvas / rows / files) and a
   * NOTE (long-form annotation). Committed shapes also carry `file`,
   * the context-prefixed rel of their MD record in the file system
   * (internal:~/workspace or the designated vault's workspace/) — the
   * file carries name + note + geometry so a cleared board restores. */
  name: string;
  note: string;
  color: string;
  id: string;
  /** ISO stamp of the MD record's creation (set on first file write). */
  created?: string;
  /* Task 51 — the CareSpace node this sketch is bound to (set by the
   * three bridges: new node / attach / create-under). The workspace's
   * arrival flash matches on it: re-entering the workspace while a
   * bound thought is current pulses that thought's constellations.
   * Old snapshots (pre-Task 51) simply never match — graceful. */
  nodeId?: string;
}

const STAR_GAP = 28;
const STAR_FIELD_ALPHA = 0.5; // workspace stars are much brighter than city dots
/* Task 45 — perf-gated twinkle: the star field is pre-rendered in THREE
 * variants (only the ~7% "major" stars change phase); at perf=high a slow
 * interval swaps variants — ONE full-canvas blit per ~1.2s, and the rAF
 * loop itself stays asleep. At perf=low the extra variants are never
 * shown and the interval no-ops: the sky is exactly as static as before. */
const TWINKLE_VARIANTS = 3;
const TWINKLE_INTERVAL_MS = 1150;

/** Workspace drawing state is persisted so constellations survive reloads. */
interface WorkspaceSnapshot {
  lines: Line[];
  shapes: Shape[];
}

function loadSnapshot(): WorkspaceSnapshot | null {
  const v = Storage.get<WorkspaceSnapshot | null>(STORAGE_KEYS.workspace, null);
  if (!v || !Array.isArray(v.lines) || !Array.isArray(v.shapes)) return null;
  /* v138 T4 migration — the note field WAS the name (it saved Task 76's
   * naming input and drove every label). The legacy text MOVES to `name`
   * (nothing is lost); the note starts empty and becomes the long-form
   * annotation field it now is. Pre-T4 snapshots carry no `name`. */
  v.shapes = v.shapes.map((s) => ({
    ...s,
    name: typeof (s as Partial<Shape>).name === 'string' ? (s as Partial<Shape>).name! : (s.note ?? ''),
    note: typeof s.note === 'string' ? s.note : '',
  }));
  return v;
}

function saveSnapshot(s: WorkspaceSnapshot) {
  Storage.set(STORAGE_KEYS.workspace, s);
}

/** Task 64 — cross-river bound-owner resolution. The ⇒ Node picker
 *  deliberately binds sketches to nodes in ANY river ("jump across
 *  networks too"), and the ⇥ chip's own handler switches rivers to
 *  reach its target — but CareSpace.getNode is CURRENT-river scoped,
 *  so a cross-river binding silently lost its provenance (the row's
 *  tag dot, both tooltips, even the ⇥ chip gate read null). Reads
 *  follow the binding, not the viewport: resolve the owner across
 *  ALL rivers. Cheap: ≤ MAX_NETWORKS array scans, on hover / static
 *  paint / sidebar paths only — never per animation frame. */
type CareNetRef = ReturnType<typeof CareSpace.networks>[number];
function boundOwnerOf(nodeId: string | undefined): { net: CareNetRef; node: CareNetRef['nodes'][string] } | undefined {
  if (!nodeId) return undefined;
  const net = CareSpace.networks().find((n) => !!n.nodes[nodeId]);
  return net ? { net, node: net.nodes[nodeId] } : undefined;
}

/** Deterministic per-index pseudo-random in [0,1) — stable star sizes. */
function hash01(n: number): number {
  let h = (n + 1) * 2654435761;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* Task 59 — ONE pair of formatters for the bound-shape count line the
 * canvas hover title, the sidebar row text and the sidebar tooltip all
 * speak. Two hand-rolled strings already drifted once (`3 pts` vs
 * `3pts`); from here they cannot — one spelling, three surfaces. */
function tagWord(tag: string | null | undefined): string {
  return tag ? `${tag} tag` : '';
}
function ptsWord(pts: number): string {
  return `${pts} pts`;
}

/* Task 115 — same hex→rgba helper the other canvas painters carry: the
 * sketch layer's accent cues (selection outline, arrival pulse, drag
 * hint) ride the THEME's gold via canvasInk() instead of frozen amber. */
function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const SHAPE_COLORS = [
  'rgba(212, 160, 23, 0.12)',
  'rgba(99, 179, 237, 0.12)',
  'rgba(155, 126, 200, 0.12)',
  'rgba(125, 186, 106, 0.12)',
  'rgba(232, 93, 117, 0.12)',
];
/** Human-readable names for the fill palette (Task 36): provenance notes
 *  said "shape 2 · 5 points" but not WHICH sketch — the color is the only
 *  visual identity a shape carries, so notes now record it ("· violet"). */
const SHAPE_COLOR_NAMES: Record<string, string> = {
  'rgba(212, 160, 23, 0.12)': 'gold',
  'rgba(99, 179, 237, 0.12)': 'blue',
  'rgba(155, 126, 200, 0.12)': 'violet',
  'rgba(125, 186, 106, 0.12)': 'green',
  'rgba(232, 93, 117, 0.12)': 'red',
};
/** Task 37: sketch color → node color TAG (visual provenance beyond the
 *  provenance note). The tree row's tag dot, the details panel's COLOR TAG
 *  swatch, and the map marker's tinted ring all read node.tags[0] — so
 *  setting it at bridge time paints the sketch's identity through every
 *  surface at once. Applied ONLY when the node is untagged; an explicit
 *  user tag is never clobbered by a sketch. */
const SHAPE_TO_TAG: Record<string, NodeTag> = {
  'rgba(212, 160, 23, 0.12)': 'yellow',
  'rgba(99, 179, 237, 0.12)': 'blue',
  'rgba(155, 126, 200, 0.12)': 'purple',
  'rgba(125, 186, 106, 0.12)': 'green',
  'rgba(232, 93, 117, 0.12)': 'red',
};
/** Set the provenance tag on an UNTAGGED node (silent no-op otherwise).
 *  Shared by all three sketch bridges so the rule stays consistent. */
function applySketchProvenanceTag(nodeId: string, shapeColor: string): void {
  const tag = SHAPE_TO_TAG[shapeColor];
  if (!tag) return;
  const node = CareSpace.getNode(nodeId);
  if (!node || node.tags.length > 0) return;
  CareSpace.setTag(nodeId, tag);
}
/* Task 119 — the drawn constellation ink joins the theme system. The lines,
   drag preview, and hover/active star cores were the LAST frozen accents on
   this canvas (sky-blue #63b3ed/#38bdf8/#7dd3fc — the original star-chart
   palette from before canvasInk existed): on amber-night a sky-blue line was
   a foreign voice, the exact "stray, not a voice" contract Task 8 declared.
   They now ride the SAME goldLight the force-graph links and this canvas's
   own selection/pulse cues already speak — HUE follows the theme, the WEIGHTS
   (0.5 sharp / 0.15 glow / 0.9 preview-hover / 1.0 active core) never move.
   SHAPE_COLORS stays a data contract (color→name/tag provenance), untouched. */
const lineInk = () => hexWithAlpha(canvasInk().goldLight, 0.5);
const lineGlowInk = () => hexWithAlpha(canvasInk().goldLight, 0.15);
const starHoverInk = () => hexWithAlpha(canvasInk().goldLight, 0.9);
const starActiveInk = () => canvasInk().goldLight;
const IDLE_SLEEP_MS = 2000;
const SNAP_DISTANCE = 30; // px — how close to a star to snap

/** Bright outline variant of a shape fill color (fills are 0.12 alpha).
 * Used for polygon strokes, sidebar color chips (the legend), and the
 * dashed outline drawn on selected shapes. */
function shapeOutlineColor(fill: string): string {
  return fill.replace('0.12', '0.8');
}

export function Workspace() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const starsRef = useRef<Star[]>([]);
  const linesRef = useRef<Line[]>([]);
  const shapesRef = useRef<Shape[]>([]);
  /** Offscreen pre-rendered star fields — Task 45: an ARRAY of
   *  TWINKLE_VARIANTS canvases (majors phase-shifted); draw() blits the
   *  active one. At perf-low only variant 0 is ever shown. */
  const starFieldRef = useRef<HTMLCanvasElement[] | null>(null);
  /** Active twinkle variant (cycles only while perf=high). */
  const twinkleIdxRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastActivityRef = useRef(Date.now());
  const dprRef = useRef(1);
  /** Undo journal — parallel to lines/shapes, records what was added last. */
  const opOrderRef = useRef<Array<'line' | 'shape'>>([]);
  /** Shape ids flashed on arrival/sidebar click (drawn as bright pulsing
   *  outlines for ~1.5s). Task 51 — a SET now: the arrival flash may
   *  light EVERY constellation bound to the landed thought at once. */
  const highlightShapesRef = useRef<Set<string>>(new Set());
  const highlightUntilRef = useRef(0);
  /** Multi-select — shape ids picked via the sidebar color chips; selected
   *  shapes draw a dashed accent outline and "Care" can bulk-bridge just them. */
  const selectedRef = useRef<Set<string>>(new Set());
  const [selectionCount, setSelectionCount] = useState(0);
  /* Task 46 — note-label wrap cache: word-wrap is the ONLY measureText in
   *  the hot path. Notes change rarely but draw() used to re-wrap every
   *  awake frame; the cache keyed by the note string makes steady-state
   *  frames allocation-free (guarded size — notes are few and short). */
  const wrapCacheRef = useRef<Map<string, { lines: string[]; width: number }>>(new Map());

  /* Attach-to-existing-node flow — the sidebar "⇒ Node" button opens the
   *  fuzzy node picker (pickMode); the picked node gets pinned at the
   *  shape's real-world centroid + a provenance note. The target shape is
   *  held in a ref (state would go stale across the dialog's async close). */
  const [pickerOpen, setPickerOpen] = useState(false);
  const attachTargetRef = useRef<Shape | null>(null);
  /* Which pick flow is active: "attach" pins the shape onto the picked
   * node; "child" (Task 34) creates a NEW node UNDER the picked one.
   * A ref because the mode is chosen in the same click that opens the
   * dialog and must survive until the pick lands. */
  const pickerModeRef = useRef<'attach' | 'child'>('attach');

  /* Canvas-side action menu (Task 33) — click INSIDE a closed shape and a
   *  small glass menu opens at the cursor: Note / ⇒ Node / Pin / Care.
   *  Complements the sidebar row (which still has → Map / ⇒ Node / → Care)
   *  so the whole shape→thought loop works without ever opening the list. */
  const [menu, setMenu] = useState<{ shapeId: string; x: number; y: number } | null>(null);

  // Interaction state
  const dragFromRef = useRef<number | null>(null); // star id being dragged from
  /* Task 75 — the shape the IN-FLIGHT drag would close (recomputed on
   * every drag mousemove, cleared on release/leave): draw() ghosts it —
   * translucent fill + dashed outline + a hint at the cursor — so closing
   * a polygon stops being a surprise you only discover on mouseup. Null
   * whenever no drag is live; the SAME checker mouseup commits with
   * builds it, so the ghost never lies about geometry or color. */
  const pendingShapeRef = useRef<Shape | null>(null);
  /* Task 76 — the inline naming input: when a shape is BORN, a small
   * canvas-anchored input appears at its centroid — type a name, Enter
   * commits (the SAME core the ✎ prompt uses); Esc or click-away leaves
   * the shape unnamed. The create flow's prompt-wall comes down: naming
   * happens where the shape is, in the workspace's own typography.
   * DOM-only (one input while naming, none otherwise) — zero canvas or
   * rAF cost at every tier. */
  const [naming, setNaming] = useState<{ shapeId: string; value: string } | null>(null);
  /* Task 76 — a drag-completing mouseup is followed by a click event;
   * over the newborn shape that click used to pop the action menu open
   * UNDER the naming input (a pre-existing quirk the input turns into
   * a conflict). Drags now stamp a ~300ms click-suppression window;
   * deliberate clicks (mousedown on empty space) never set it. */
  const suppressClickUntilRef = useRef(0);
  const mouseRef = useRef({ x: 0, y: 0 });
  const hoveredStarRef = useRef<number | null>(null);

  /* Sidebar (shape list) visibility — plain state, only re-renders on toggle.
   * shapesCount mirrors shapesRef for the button chip (refs don't re-render). */
  const [listOpen, setListOpen] = useState(false);
  const [shapesCount, setShapesCount] = useState(0);
  /* Sidebar rows render straight from shapesRef (refs don't re-render), so
   * any mutation that changes a ROW's appearance — color cycle, note edit —
   * must bump this revision to refresh the list. Canvas is redrawn via
   * wakeUp(); the DOM list needs this explicit nudge. */
  const [sidebarRev, setSidebarRev] = useState(0);
  const bumpSidebar = useCallback(() => setSidebarRev((r) => r + 1), []);

  // NOTE: two separate selectors — returning a fresh array from a single
  // selector breaks useSyncExternalStore snapshot caching (infinite loop).
  const active = useNaksha((s) => s.focusActive);
  const setActive = useNaksha((s) => s.setFocusActive);

  // Compute star positions on resize
  const computeStars = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const stars: Star[] = [];
    let id = 0;
    const gap = STAR_GAP;
    const offsetX = (w % gap) / 2; // center the grid
    const offsetY = (h % gap) / 2;
    for (let y = offsetY; y < h; y += gap) {
      for (let x = offsetX; x < w; x += gap) {
        stars.push({ x, y, id: id++ });
      }
    }
    starsRef.current = stars;
  }, []);

  // Pre-render the star fields to offscreen canvases (same grid as
  // computeStars). Called on mount + resize. O(cols·rows · TWINKLE_VARIANTS)
  // ONCE, then a single drawImage per frame.
  const renderStarField = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = dprRef.current;
    const gap = STAR_GAP;
    const offsetX = (w % gap) / 2;
    const offsetY = (h % gap) / 2;

    // Star color — themed via --naksha-dot-color, brightened for visibility.
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--naksha-dot-color')
      .trim();
    const base = raw && !raw.startsWith('var(') ? raw : 'rgba(148, 163, 184, 0.28)';

    const fields: HTMLCanvasElement[] = [];
    for (let v = 0; v < TWINKLE_VARIANTS; v++) {
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(w * dpr));
      off.height = Math.max(1, Math.round(h * dpr));
      const octx = off.getContext('2d');
      if (!octx) continue;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.clearRect(0, 0, w, h);

      /* Night-sky star field — deterministic size/brightness variance so the
       * grid reads as constellations, not graph paper. ~7% of stars are
       * "majors" with a soft halo; majors twinkle ACROSS variants (phase from
       * a third hash), minors are identical in every variant. All
       * pre-rendered once → zero per-frame cost beyond one drawImage. */
      let idx = 0;
      for (let y = offsetY; y < h; y += gap) {
        for (let x = offsetX; x < w; x += gap) {
          const h1 = hash01(idx);
          const h2 = hash01(idx * 7 + 13);
          const major = h1 > 0.93;
          let r: number;
          let alpha: number;
          if (major) {
            /* Task 45 — twinkle phase: each major gets a stable phase; the
             * variant index samples it around the sky. Subtle by design:
             * brightness swings ±14%, radius ±4%. */
            const phase = hash01(idx * 31 + 7);
            const tw = 0.86 + 0.14 * Math.sin(((v / TWINKLE_VARIANTS + phase) % 1) * Math.PI * 2);
            r = 1.5 * (0.96 + 0.04 * tw);
            alpha = 0.9 * tw;
          } else {
            r = 0.7 + h2 * 0.6;
            alpha = STAR_FIELD_ALPHA * (0.55 + h1 * 0.9);
          }
          if (major) {
            // Soft halo underlay (constant across variants — no re-budget)
            const halo = octx.createRadialGradient(x, y, 0, x, y, 7);
            halo.addColorStop(0, withAlpha(base, 0.22));
            halo.addColorStop(1, withAlpha(base, 0));
            octx.fillStyle = halo;
            octx.beginPath();
            octx.arc(x, y, 7, 0, Math.PI * 2);
            octx.fill();
          }
          octx.fillStyle = withAlpha(base, alpha);
          octx.beginPath();
          octx.arc(x, y, r, 0, Math.PI * 2);
          octx.fill();
          idx++;
        }
      }
      fields.push(off);
    }
    starFieldRef.current = fields;
  }, []);

  // Find the nearest star to a point, within SNAP_DISTANCE
  const findNearestStar = useCallback((x: number, y: number): number | null => {
    const stars = starsRef.current;
    let nearest: number | null = null;
    let minDist = SNAP_DISTANCE;
    for (const s of stars) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < minDist) {
        minDist = d;
        nearest = s.id;
      }
    }
    return nearest;
  }, []);

  // Get star by id
  const getStar = useCallback((id: number): Star | null => {
    return starsRef.current.find((s) => s.id === id) ?? null;
  }, []);

  // Check if adding a line from→to would close a shape
  const checkShapeClosure = useCallback((): Shape | null => {
    const lines = linesRef.current;
    const from = dragFromRef.current;
    if (from == null) return null;
    const to = hoveredStarRef.current;
    if (to == null || to === from) return null;

    // BFS to find a path back to `from` starting from `to`
    // Build adjacency list from current lines
    const adj = new Map<number, number[]>();
    for (const l of lines) {
      if (!adj.has(l.from)) adj.set(l.from, []);
      if (!adj.has(l.to)) adj.set(l.to, []);
      adj.get(l.from)!.push(l.to);
      adj.get(l.to)!.push(l.from);
    }

    // BFS from `to` back to `from` (excluding the direct from→to edge we're about to add)
    const visited = new Set<number>([to]);
    const queue: Array<{ node: number; path: number[] }> = [{ node: to, path: [to] }];

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;
      const neighbors = adj.get(node) ?? [];
      for (const next of neighbors) {
        if (next === from && path.length >= 2) {
          // Found a closed shape! The path is [to, ..., node, from]
          const starIds = [...path, from];
          // Check if this shape already exists
          const shapeId = starIds.slice().sort().join('-');
          if (shapesRef.current.some((s) => s.id === shapeId)) return null;
          const colorIdx = shapesRef.current.length % SHAPE_COLORS.length;
          return {
            starIds,
            name: '',
            note: '',
            color: SHAPE_COLORS[colorIdx],
            id: shapeId,
          };
        }
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ node: next, path: [...path, next] });
        }
      }
    }
    return null;
  }, []);

  // Draw everything
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = dprRef.current;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Blit the pre-rendered star field variant (1 drawImage — no per-dot
    // work). Twinkle = swapping WHICH variant is blitted; the rAF loop
    // itself stays asleep between swaps (Task 45).
    const fields = starFieldRef.current;
    if (fields && fields.length > 0) {
      ctx.drawImage(fields[twinkleIdxRef.current % fields.length], 0, 0, w, h);
    }

    const stars = starsRef.current;
    const lines = linesRef.current;
    const shapes = shapesRef.current;
    const hovered = hoveredStarRef.current;
    const dragFrom = dragFromRef.current;
    const mouse = mouseRef.current;

    /* ── Task 46 — PASS 1: label layout + DECLUTTER ──────────────────
       Shape notes used to print at their centroid unconditionally, so
       two neighbouring labeled shapes printed ON TOP of each other.
       Pass 1 lays every note out once (cached wrap + cached max width —
       steady-state frames do ZERO measureText), reserves a screen rect
       at its centroid, and on collision shifts the label DOWN past the
       rect it hit (greedy, draw order = stacking order — converges in
       one step per collision). Cost: O(labeled²) rect tests per frame,
       nothing when no notes exist; the constellation geometry is
       untouched — only the TEXT moves. */
    ctx.font = '12px JetBrains Mono, monospace';
    const wrapNote = (note: string): { lines: string[]; width: number } => {
      const cached = wrapCacheRef.current.get(note);
      if (cached) return cached;
      const out: string[] = [];
      let current = '';
      for (const word of note.split(' ')) {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width > 120) {
          if (current) out.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) out.push(current);
      const width = out.length > 0 ? Math.max(...out.map((l) => ctx.measureText(l).width)) : 0;
      if (wrapCacheRef.current.size > 64) wrapCacheRef.current.clear();
      const entry = { lines: out, width };
      wrapCacheRef.current.set(note, entry);
      return entry;
    };
    const placedRects: Array<{ x: number; y: number; w: number; h: number }> = [];
    /* v138 T4 — labels carry the NAME as the primary line and the NOTE
     * wrapped underneath (muted, capped at 2 lines). `primary` counts
     * the leading name lines so PASS 2 can render them brighter. */
    const labelLayout = new Map<string, { cx: number; ly: number; lines: string[]; primary: number }>();
    for (const shape of shapes) {
      const nm = shape.name.trim();
      const note = shape.note.trim();
      if (!nm && !note) continue;
      const pts = shape.starIds.map((id) => getStar(id)).filter(Boolean) as Star[];
      if (pts.length < 3) continue;
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      /* Name = one line (created through an input, kept short); note =
       * the cached word-wrap, capped at 2 lines with an ellipsis. */
      const labelLines: string[] = [];
      if (nm) labelLines.push(nm.length > 40 ? `${nm.slice(0, 39)}…` : nm);
      if (note) {
        const wrapped = wrapNote(note).lines;
        const capped = wrapped.slice(0, 2).map((l) => l);
        if (wrapped.length > 2 && capped.length === 2) capped[1] = `${capped[1].replace(/…$/, '')}…`;
        else if (wrapped.length === 2 && wrapped[1].length > 38) capped[1] = `${wrapped[1].slice(0, 37)}…`;
        labelLines.push(...capped);
      }
      if (labelLines.length === 0) continue;
      const lw = Math.max(...labelLines.map((l) => ctx.measureText(l).width));
      const lh = labelLines.length * 16;
      /* Task 47 — 4-way resolution with a horizontal axis. 46 only pushed
       * labels DOWN, so a cluster near the canvas bottom kept getting
       * shoved off-screen once the vertical run ran out. Now "below" is
       * still the first choice, but when below would leave the canvas
       * the sides (right, then left) and finally "above" get a turn —
       * each candidate collision-checked against every placed rect AND
       * bounds-checked before it wins. Still pure rect math, only on
       * collisions; nothing changes when no labeled shapes exist. */
      let ly = cy;
      let lx = cx;
      const hw = lw / 2 + 4;
      for (let guard = 0; guard < 40; guard++) {
        const rect = { x: lx - lw / 2 - 4, y: ly - lh / 2 - 2, w: lw + 8, h: lh + 4 };
        const hit = placedRects.find(
          (p) => rect.x < p.x + p.w && rect.x + rect.w > p.x && rect.y < p.y + p.h && rect.y + rect.h > p.y,
        );
        if (!hit) break;
        const belowY = hit.y + hit.h + 4 + lh / 2 + 2;
        if (belowY + lh / 2 + 2 <= h - 8) {
          /* Below stays on-canvas — 46's move, unchanged. */
          ly = belowY;
          continue;
        }
        const candidates = [
          { x: hit.x + hit.w + 4 + hw, y: ly }, // right of the hit
          { x: hit.x - 4 - hw, y: ly }, // left of the hit
          { x: lx, y: hit.y - 4 - (lh / 2 + 2) }, // above the hit
        ];
        let resolved = false;
        for (const c of candidates) {
          if (c.x - hw < 8 || c.x + hw > w - 8 || c.y - lh / 2 - 2 < 8) continue;
          const cr = { x: c.x - lw / 2 - 4, y: c.y - lh / 2 - 2, w: lw + 8, h: lh + 4 };
          const blocked = placedRects.some(
            (p) => cr.x < p.x + p.w && cr.x + cr.w > p.x && cr.y < p.y + p.h && cr.y + cr.h > p.y,
          );
          if (!blocked) {
            lx = c.x;
            ly = c.y;
            resolved = true;
            break;
          }
        }
        if (!resolved) ly = belowY; // guarded fallback = 46's behavior
      }
      placedRects.push({ x: lx - lw / 2 - 4, y: ly - lh / 2 - 2, w: lw + 8, h: lh + 4 });
      labelLayout.set(shape.id, { cx: lx, ly, lines: labelLines, primary: nm ? 1 : 0 });
    }

    // Draw closed shapes (filled polygons)
    for (const shape of shapes) {
      const points = shape.starIds.map((id) => getStar(id)).filter(Boolean) as Star[];
      if (points.length < 3) continue;

      ctx.fillStyle = shape.color;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.closePath();
      ctx.fill();

      // Draw shape outline
      ctx.strokeStyle = shapeOutlineColor(shape.color);
      ctx.lineWidth = 1;
      ctx.stroke();

      // Task 52 — the tag-tint centroid dot: a bound sketch whose thought
      // wears a tag shows that tint AT the constellation itself, not just
      // in the sidebar / tree / terminal bullets. Static paint — one arc
      // + one ring per bound TAGGED shape (unbound/untagged shapes pay
      // one property read), no animation, no extra pass. Task 64 — the
      // lookup is CROSS-RIVER now: a dormant-river owner draws its dot
      // too (provenance follows the binding, not the current river).
      if (shape.nodeId) {
        const owner = boundOwnerOf(shape.nodeId)?.node ?? null;
        const ownerTag = owner?.tags.filter((t) => t && t !== 'none')[0];
        const tint = ownerTag ? TAG_COLORS[ownerTag] : undefined;
        if (tint && points.length > 0) {
          let cx = 0;
          let cy = 0;
          for (const p of points) { cx += p.x; cy += p.y; }
          cx /= points.length;
          cy /= points.length;
          ctx.beginPath();
          ctx.arc(cx, cy, 4, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(20, 17, 13, 0.6)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = tint;
          ctx.fill();
        }
      }

      // Selected via sidebar chips — dashed accent outline (static, no pulse:
      // zero animation cost, redraws only while the rAF loop is awake).
      // Task 115 — the accent rides the theme's gold (canvasInk).
      if (selectedRef.current.has(shape.id)) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = hexWithAlpha(canvasInk().goldLight, 0.9);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Sidebar/arrival highlight — bright pulsing outline for ~1.5s. The
      // pulse rides the interaction rAF loop (only awake while it lasts).
      if (highlightShapesRef.current.has(shape.id) && Date.now() < highlightUntilRef.current) {
        const pulse = 0.55 + 0.35 * Math.sin(Date.now() / 110);
        ctx.strokeStyle = hexWithAlpha(canvasInk().goldLight, pulse);
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Draw note text if present — position from PASS 1 (decluttered),
      // with a dark halo stroke so the label stays readable over its own
      // fill and any neighbours (halo = one strokeText per line, static).
      // v138 T4 — the NAME line renders brighter than the note lines:
      // identity first, annotation second, one glance tells them apart.
      const lab = labelLayout.get(shape.id);
      if (lab) {
        ctx.font = '12px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const startY = lab.ly - ((lab.lines.length - 1) * 16) / 2;
        for (let i = 0; i < lab.lines.length; i++) {
          const ty = startY + i * 16;
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(20, 17, 13, 0.85)';
          ctx.strokeText(lab.lines[i], lab.cx, ty);
          ctx.fillStyle = i < lab.primary ? 'rgba(238, 241, 247, 0.95)' : 'rgba(232, 224, 208, 0.55)';
          ctx.fillText(lab.lines[i], lab.cx, ty);
        }
      }
    }

    // Draw lines — Task 45 GLOW BUDGET: the 4px glow pass is the expensive
    // half of every stroke (wide aliased line). At perf=low it is SKIPPED
    // entirely; at high tier the first 120 lines keep their glow and the
    // tail renders sharp-only, so a mega-constellation can't blow the
    // frame budget. Read LIVE — `settings perf` flips instantly.
    const glowBudget =
      useNaksha.getState().settings.perfMode === 'low' ? 0 : 120;
    ctx.lineCap = 'round';
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const from = getStar(line.from);
      const to = getStar(line.to);
      if (!from || !to) continue;
      // Glow (budgeted)
      if (li < glowBudget) {
        ctx.strokeStyle = lineGlowInk();
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      // Sharp
      ctx.strokeStyle = lineInk();
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }

    /* ── Task 75 — VERTEX STARS: the stars a constellation actually
       touches SHINE (soft halo + warm core), so a drawn constellation
       reads as a star map even when the cursor is elsewhere. Before
       this, lines connected INVISIBLE points — the geometry only made
       sense while hovering. O(vertex count) static arcs per awake frame
       (a constellation has tens of vertices, never thousands); no
       gradients, no animation — CPU-friendly at every tier. */
    const vertexIds = new Set<number>();
    for (const l of lines) {
      vertexIds.add(l.from);
      vertexIds.add(l.to);
    }
    for (const s of shapes) {
      for (const id of s.starIds) vertexIds.add(id);
    }
    for (const vid of vertexIds) {
      const v = getStar(vid);
      if (!v) continue;
      ctx.fillStyle = 'rgba(99, 179, 237, 0.16)';
      ctx.beginPath();
      ctx.arc(v.x, v.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(196, 224, 246, 0.85)';
      ctx.beginPath();
      ctx.arc(v.x, v.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw drag preview line
    if (dragFrom != null) {
      const from = getStar(dragFrom);
      if (from) {
        // Dashed preview line to mouse or hovered star
        const targetX = hovered != null ? getStar(hovered)?.x ?? mouse.x : mouse.x;
        const targetY = hovered != null ? getStar(hovered)?.y ?? mouse.y : mouse.y;
        ctx.strokeStyle = starHoverInk();
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(targetX, targetY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Highlight source star
        ctx.fillStyle = starActiveInk();
        ctx.beginPath();
        ctx.arc(from.x, from.y, 3, 0, Math.PI * 2);
        ctx.fill();

        /* Task 45 — grid-coordinate readout at the drag origin: the star's
         * column/row in the dot grid, mono micro-type with a dark halo.
         * Expert-shell flavor, zero listeners — painted by draw() like
         * everything else, gone the moment the drag ends. */
        const col = Math.round(from.x / STAR_GAP);
        const row = Math.round(from.y / STAR_GAP);
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        const coordLabel = `c${col}·r${row}`;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(20, 17, 13, 0.85)';
        ctx.strokeText(coordLabel, from.x + 7, from.y - 7);
        ctx.fillStyle = 'rgba(232, 224, 208, 0.6)';
        ctx.fillText(coordLabel, from.x + 7, from.y - 7);
      }
    }

    /* ── Task 75 — CLOSURE GHOST: when the in-flight drag would close a
       polygon, the finished shape breathes under the cursor BEFORE
       release — translucent fill in the color it will keep, dashed
       outline, and a mono hint at the cursor. pendingShapeRef is built
       by the SAME checker mouseup commits with (checkShapeClosure), so
       the ghost never lies about geometry or color. Painted only while
       a drag is live; the hint text rides the interaction loop's own
       frames (zero idle cost). */
    const pending = dragFrom != null ? pendingShapeRef.current : null;
    if (pending) {
      const pts = pending.starIds.map((id) => getStar(id)).filter(Boolean) as Star[];
      if (pts.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fillStyle = pending.color.replace('0.12', '0.18');
        ctx.fill();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = shapeOutlineColor(pending.color);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const hint = '✦ release to close';
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(20, 17, 13, 0.85)';
        ctx.strokeText(hint, mouse.x + 12, mouse.y - 10);
        /* Task 115 — the hint text rides the theme gold like every other
         * accent cue on the sketch canvas. */
        ctx.fillStyle = hexWithAlpha(canvasInk().goldLight, 0.9);
        ctx.fillText(hint, mouse.x + 12, mouse.y - 10);
      }
    }

    // Draw stars (only if hovering or dragging — otherwise they're invisible,
    // the DotGridBackground shows them)
    if (hovered != null || dragFrom != null) {
      for (const star of stars) {
        const isHovered = star.id === hovered;
        const isActive = star.id === dragFrom;
        if (isHovered || isActive) {
          ctx.fillStyle = isActive ? starActiveInk() : starHoverInk();
          ctx.beginPath();
          ctx.arc(star.x, star.y, isActive ? 3 : 2.5, 0, Math.PI * 2);
          ctx.fill();
          // Glow — Task 119: was frozen sky rgba(125,211,252,.2)/rgba(56,189,248,.15)
          ctx.fillStyle = isActive
            ? hexWithAlpha(canvasInk().goldLight, 0.2)
            : hexWithAlpha(canvasInk().goldLight, 0.15);
          ctx.beginPath();
          ctx.arc(star.x, star.y, 8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }, [getStar]);

  // rAF loop with sleep
  const startRaf = useCallback(() => {
    if (rafRef.current != null) return;
    /* Cap the loop — full-canvas redraws are throttled per tier (read LIVE
     * each frame so `settings perf` flips instantly without restarting the
     * loop): LOW 20fps, HIGH 30fps, and STABLE_60 locks 60fps through the
     * shared FrameScheduler (draw admitted once per 16.67ms budget — a no-op
     * on 60Hz displays, a hard lock on 120/144Hz ones — with every admitted
     * draw feeding the PerfPanel diagnostics). The 2s idle sleep stays in
     * every tier: it only fires after 2s WITHOUT interaction, so it can
     * never cost interaction FPS; wakeUp() restarts the loop on the first
     * event with zero perception delay. */
    const loop = (ts: number) => {
      const tier = useNaksha.getState().settings.perfMode;
      if (tier === 'stable60') {
        if (FrameScheduler.shouldDraw('workspace', ts)) {
          FrameScheduler.noteDraw('workspace', ts);
          draw();
        }
      } else {
        const minFrame = tier === 'low' ? 50 : 33;
        if (ts - lastDrawTs >= minFrame) {
          lastDrawTs = ts;
          draw();
        }
      }
      if (Date.now() - lastActivityRef.current > IDLE_SLEEP_MS) {
        rafRef.current = null;
        // One final draw to clear any hover state
        draw();
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    let lastDrawTs = 0;
    rafRef.current = requestAnimationFrame(loop);
  }, [draw]);

  /* Task 115 — re-ink on theme switch: the accent cues now resolve
   * canvasInk() at draw time, so a theme change needs exactly one
   * repaint (the rAF loop may be idle-asleep — the wakeUp-free single
   * draw is enough; the next interaction restarts the loop). The
   * themeId subscription follows the pattern CareSpacePane/ForceGraph
   * already carry. */
  const themeId = useNaksha((s) => s.settings.themeId);
  useEffect(() => {
    draw();
  }, [themeId, draw]);

  const wakeUp = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (rafRef.current == null) startRaf();
  }, [startRaf]);

  /* v138 T5 — the workspace snapshot persist is now TRAILING-COALESCED
   * (the CareSpace.save discipline, mirrored exactly — including the
   * pagehide/visibilitychange flush). Before, a single shape commit
   * stringified + wrote the WHOLE snapshot TWICE synchronously: once for
   * the mutation (commitShapeName/Note) and again a microtask later when
   * the MD file write stamped `file`/`created` — the "renaming a shape
   * causes multiple saves" report, observed as naksha_workspace ×2 per
   * gesture. Both writes now collapse into ONE trailing write 250ms
   * after the last mutation; in-memory state is never stale (refs), only
   * the persisted copy lags ≤250ms. Durability: pagehide + visibility
   * hidden + workspace unmount all flush the tail. */
  const wsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushWorkspaceSnapshot = useCallback(() => {
    if (wsSaveTimerRef.current !== null) {
      clearTimeout(wsSaveTimerRef.current);
      wsSaveTimerRef.current = null;
      saveSnapshot({ lines: linesRef.current, shapes: shapesRef.current });
    }
  }, []);
  const persistWorkspace = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (wsSaveTimerRef.current !== null) clearTimeout(wsSaveTimerRef.current);
    wsSaveTimerRef.current = setTimeout(() => {
      wsSaveTimerRef.current = null;
      saveSnapshot({ lines: linesRef.current, shapes: shapesRef.current });
    }, 250);
  }, []);
  useEffect(() => {
    const flush = () => flushWorkspaceSnapshot();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      flush(); // unmount (workspace exit) — land the tail, never drop it
    };
  }, [flushWorkspaceSnapshot]);

  /* ══ v138 T4 — shape ⇄ MD file bridge ═════════════════════════════
   * A NAMED or ANNOTATED shape owns a real markdown file (designated
   * vault → `workspace/`, else the internal FS → `~/workspace/`). The
   * file carries name + note + color + binding + geometry, so a cleared
   * board restores every shape to its original position. Assembled on
   * the care-vault patterns (gated write/rename, noteBasename naming).
   * Writes are fire-and-forget: receipts land in the terminal. */
  const shapeStorageOf = useCallback((): ShapeStorage => {
    return pickShapeStorage(useNaksha.getState().careVaultStatus);
  }, []);

  /** Snapshot a shape into its serializable MD record (null when the
   *  polygon is gone from the current board geometry). */
  const buildShapeFileData = useCallback(
    (shape: Shape): ShapeFileData | null => {
      const pts = shape.starIds.map((id) => getStar(id)).filter(Boolean) as Star[];
      if (pts.length < 3) return null;
      const canvas = canvasRef.current;
      const nowIso = new Date().toISOString();
      return {
        id: shape.id,
        name: shape.name.trim(),
        note: shape.note.trim(),
        color: shape.color,
        bound: shape.nodeId ?? '',
        created: shape.created ?? nowIso,
        updated: nowIso,
        stars: [...shape.starIds],
        coords: pts.map((p) => ({ x: p.x, y: p.y })),
        board: canvas ? `${canvas.clientWidth}x${canvas.clientHeight}` : '',
      };
    },
    [getStar],
  );

  /** Create-or-update a shape's MD file. `force` creates the file (name /
   *  note commits); without it, an existing file is updated in place and
   *  a fileless shape is left alone (ambient syncs — bind, color — never
   *  invent files). A rename (`renameTo` base) MOVES the file so the
   *  filename keeps following the shape's name. */
  const syncShapeFile = useCallback(
    (shape: Shape, opts?: { force?: boolean; renameTo?: string; quiet?: boolean }) => {
      const data = buildShapeFileData(shape);
      if (!data) return;
      const storage = shapeStorageOf();
      const print = (msg: string, kind: 'success' | 'muted' | 'warning' | 'error') =>
        useNaksha.getState().print(msg, kind);

      void (async () => {
        try {
          let bare: string | null = null;
          let movedFrom: string | null = null;
          let existing = shape.file ? splitShapeRel(shape.file) : null;
          if (existing && existing.kind !== storage.kind) {
            /* The file lives in the OTHER world (storage target changed
             * since the last commit). The old world's file stays as the
             * record it was; this world gets a fresh one. */
            existing = null;
          }
          if (existing) {
            bare = existing.bare.replace(/\.(md|markdown)$/i, '');
            const base = opts?.renameTo;
            if (base && base !== bare) {
              const mv = await moveShapeFile(storage, `${bare}.md`, `${base}.md`);
              if (mv.ok) {
                movedFrom = bare;
                bare = base;
              } else if (!opts?.quiet) {
                print(`▤ file rename failed — ${mv.error} (content still written to "${bare}.md")`, 'warning');
              }
            }
          } else {
            if (!opts?.force) return; // ambient syncs never invent files
            if (!data.name && !data.note) return; // nothing worth a file yet
            const idx = shapesRef.current.indexOf(shape);
            const taken = new Set<string>();
            for (const s of shapesRef.current) {
              if (s.id === shape.id || !s.file) continue;
              const sp = splitShapeRel(s.file);
              if (sp) taken.add(sp.bare.replace(/\.(md|markdown)$/i, '').toLowerCase());
            }
            bare = shapeFileBase(data.name, `shape ${idx + 1}`, taken);
          }
          if (!bare) return;
          const w = await writeShapeFile(storage, `${bare}.md`, data);
          if (!w.ok) {
            print(`▤ shape file not saved — ${w.error}`, 'warning');
            return;
          }
          // Record the backing file + creation stamp on the shape.
          shapesRef.current = shapesRef.current.map((x) =>
            x.id === shape.id ? { ...x, file: w.rel, created: x.created ?? data.created } : x,
          );
          persistWorkspace(); // trailing-coalesced — collapses with the commit's own persist
          if (opts?.quiet) return;
          if (movedFrom) {
            print(`▤ "${movedFrom}.md" → "${bare}.md" · ${w.label}`, 'muted');
          } else if (existing) {
            print(`▤ shape file updated → ${w.label}`, 'muted');
          } else {
            print(`▤ shape saved → ${w.label}`, 'success');
            print('   the MD file carries name · note · geometry — Clear, then Restore MD brings it back', 'muted');
          }
        } catch (err) {
          print(`▤ shape file sync failed — ${(err as Error).message}`, 'warning');
        }
      })();
    },
    [buildShapeFileData, shapeStorageOf, persistWorkspace],
  );

  /** The Task 112 contract, shared: a non-empty shape name/note also
   *  echoes into the CURRENT CareSpace node with a NAMED undo receipt. */
  const echoShapeTextToCare = useCallback((text: string, verb: 'name' | 'note') => {
    const node = CareSpace.getCurrentNode();
    const undo: UndoEntry = {
      kind: 'care',
      label: `${verb} "${text.length > 24 ? `${text.slice(0, 24)}…` : text}" on ${node.label.slice(0, 18)}`,
      snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
      ts: Date.now(),
    };
    CareSpace.addNote(node.id, `[workspace] ${text}`);
    useNaksha.getState().setUndo(undo);
    useNaksha.getState().syncCare();
  }, []);

  /** GEO MAPPING — a shape's viewport centroid mapped onto the Leaflet
   *  container (left pane): viewport px → container px → lat/lng.
   *  Returns null when the map isn't ready. Shared by pin + care bridges. */
  const shapeCentroidLatLng = useCallback(
    (shape: Shape): { lat: number; lng: number } | null => {
      const map = MapEngine.map;
      if (!map) return null;
      const pts = shape.starIds
        .map((id) => getStar(id))
        .filter(Boolean) as Star[];
      if (pts.length === 0) return null;
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const rect = map.getContainer().getBoundingClientRect();
      const px = Math.min(Math.max(cx - rect.left, 0), rect.width);
      const py = Math.min(Math.max(cy - rect.top, 0), rect.height);
      const ll = map.containerPointToLatLng([px, py]);
      return { lat: ll.lat, lng: ll.lng };
    },
    [getStar],
  );

  /** GEO BRIDGE CORE — one shape → one map pin. Returns the pin number on
   *  success, null when the map isn't ready / the pin failed. Shared by the
   *  single-shape and Task 45 bulk flows so receipts stay one story. */
  const addPinForShape = useCallback(
    (shape: Shape): number | null => {
      const ll = shapeCentroidLatLng(shape);
      if (!ll) return null;
      const label = shape.name || shape.note || `shape ${shapesRef.current.indexOf(shape) + 1}`;
      const r = MapEngine.addPinAt(label, ll.lat, ll.lng);
      return r.success && r.pinNumber != null ? r.pinNumber : null;
    },
    [shapeCentroidLatLng],
  );

  /** GEO BRIDGE — drop a map pin at the shape's centroid. */
  const pinShapeToMap = useCallback(
    (shape: Shape) => {
      const ll = shapeCentroidLatLng(shape);
      if (!ll) {
        useNaksha.getState().print('Map not ready — cannot drop pin', 'error');
        return;
      }
      const label = shape.name || shape.note || `shape ${shapesRef.current.indexOf(shape) + 1}`;
      const r = MapEngine.addPinAt(label, ll.lat, ll.lng);
      if (r.success) {
        const latStr = `${Math.abs(ll.lat).toFixed(3)}${ll.lat >= 0 ? 'N' : 'S'}`;
        const lngStr = `${Math.abs(ll.lng).toFixed(3)}${ll.lng >= 0 ? 'E' : 'W'}`;
        useNaksha.getState().print(`Shape → pin ${r.pinNumber} @ ${latStr} ${lngStr}`, 'success');
      } else {
        useNaksha.getState().print('Could not drop pin', 'error');
      }
    },
    [shapeCentroidLatLng],
  );

  /** Task 45 — BULK pin: every selected shape (or all shapes) becomes a map
   *  pin at its centroid, ONE summary receipt instead of N (terminal stays
   *  readable; the ledger holds the per-pin rows). */
  const pinShapesToMap = useCallback(
    (shapes: Shape[]) => {
      if (shapes.length === 0) {
        useNaksha.getState().print('No shapes to pin — close a polygon first', 'muted');
        return;
      }
      let ok = 0;
      for (const s of shapes) {
        if (addPinForShape(s) != null) ok++;
      }
      useNaksha
        .getState()
        .print(
          ok > 0
            ? `✦ ${ok}/${shapes.length} shape(s) → map pins${selectedRef.current.size > 0 && ok === shapes.length ? ' (selected)' : ''}`
            : 'Map not ready — cannot drop pins',
          ok > 0 ? 'success' : 'error',
        );
    },
    [addPinForShape],
  );

  /** TRI-PANE BRIDGE — create a CareSpace node from a shape: named by its
   *  note (or "Shape N"), pinned at the shape's real-world centroid, with a
   *  provenance note. Closes the loop workspace → map + care. */
  const shapeToCareNode = useCallback(
    (shape: Shape) => {
      const idx = shapesRef.current.indexOf(shape);
      /* Task 65 — name the thought AT bind time: a fresh sketch (no
       * note yet) prompts once, and the answer becomes BOTH the shape's
       * note and the node's label — the ✎→→Care two-step collapses
       * into one for the common bind. Cancel aborts the bind (no
       * orphan node, no half binding — also the batch skip verb in
       * Care All); empty keeps the Shape N default. Already-named
       * sketches bind immediately (zero friction, unchanged). */
      /* v138 T4 — the bind-time prompt names the shape (the Task 65/66
       * flow, unchanged — but the answer now lands in `name`). */
      let label = (shape.name || '').trim().slice(0, 40);
      if (!label) {
        const named = window.prompt(`Name the thought for sketch ${idx + 1} (empty = "Shape ${idx + 1}"):`, '');
        if (named === null) return;
        const clean = named.trim();
        if (clean) {
          shapesRef.current = shapesRef.current.map((x) =>
            x.id === shape.id ? { ...x, name: clean } : x,
          );
          label = clean.slice(0, 40);
        } else {
          label = `Shape ${idx + 1}`;
        }
      }
      /* Task 112 — undo parity reaches the ORIGINAL bridge: this creates
       * a node, pins it, and notes it — three real care mutations that
       * ran silently while attach/under both snapshot first (their own
       * comments say "like every other destructive surface"). Same
       * snapshot, named receipt: undoing this gives the node back. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `node ${label}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.addNode(label);
      if (!r.success) {
        useNaksha.getState().print(r.error ?? 'Could not create node', 'error');
        return;
      }
      const nodeId = r.data!;
      /* Task 51 — record the binding ON the shape (persisted): the
       * workspace's arrival flash matches sketches to thoughts by it. */
      shapesRef.current = shapesRef.current.map((x) =>
        x.id === shape.id ? { ...x, nodeId } : x,
      );
      persistWorkspace();
      const ll = shapeCentroidLatLng(shape);
      if (ll) {
        const zoom = MapEngine.map ? Math.round(MapEngine.map.getZoom() ?? 12) : 12;
        CareSpace.pinLocation(nodeId, ll.lat, ll.lng, zoom);
      }
      applySketchProvenanceTag(nodeId, shape.color);
      CareSpace.addNote(
        nodeId,
        `[workspace] shape ${idx + 1} (${SHAPE_COLOR_NAMES[shape.color] ?? 'custom'}) · ${shape.starIds.length} points${ll ? ` · @ ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}` : ''}`,
      );
      useNaksha.getState().setUndo(undo);
      useNaksha.getState().syncCare();
      /* Task 63 — the sidebar row MUST re-render here: the binding (nodeId)
       * just changed, and the row reads shapesRef at render time — without
       * the bump the row keeps its pre-bind look (no tag dot, no tooltip,
       * no ⇥ chip) until some unrelated action refreshes the list. The
       * same rule editShapeNote already follows ("row text may have
       * changed" — a bind changes everything the row speaks). */
      bumpSidebar();
      /* v138 T4 — the binding rides the shape's MD file too (bound:
       * frontmatter) when one exists; quiet — the bridge's own receipt
       * already told this story. */
      const boundShape = shapesRef.current.find((x) => x.id === shape.id);
      if (boundShape) syncShapeFile(boundShape, { quiet: true });
      const latStr = ll ? `${Math.abs(ll.lat).toFixed(3)}${ll.lat >= 0 ? 'N' : 'S'}` : 'no map';
      const lngStr = ll ? `${Math.abs(ll.lng).toFixed(3)}${ll.lng >= 0 ? 'E' : 'W'}` : '';
      useNaksha
        .getState()
        .print(`Shape → CareSpace node "${label}"${ll ? ` @ ${latStr} ${lngStr}` : ' (created, no location)'} — undo available`, 'success');
    },
    [shapeCentroidLatLng, persistWorkspace, bumpSidebar, syncShapeFile],
  );

  /** ATTACH BRIDGE — pin an EXISTING node at the shape's real-world
   *  centroid + drop a provenance note ("⇒ Node" flow). Complements
   *  shapeToCareNode (which always creates a NEW node): sketches can now
   *  bind to whatever thought already exists. Undo parity: this mutates
   *  the node, so it snapshots CareSpace first like every other
   *  destructive surface. */
  const attachShapeToNode = useCallback(
    (shape: Shape, pick: NodePick) => {
      // pinLocation/addNote operate on the CURRENT network — switch to the
      // target's network first (also shows the user where the node lives).
      if (CareSpace.currentNetwork().name !== pick.networkName) {
        CareSpace.switchNetwork(pick.networkName);
      }
      const idx = shapesRef.current.indexOf(shape);
      const ll = shapeCentroidLatLng(shape);
      /* Task 51 — the attach bridge binds the shape to the EXISTING node
       * (same persisted nodeId the arrival flash matches on). */
      shapesRef.current = shapesRef.current.map((x) =>
        x.id === shape.id ? { ...x, nodeId: pick.nodeId } : x,
      );
      persistWorkspace();
      const undo: UndoEntry = {
        kind: 'care',
        label: `attach → ${pick.label.slice(0, 18)}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      if (ll) {
        const zoom = MapEngine.map ? Math.round(MapEngine.map.getZoom() ?? 12) : 12;
        CareSpace.pinLocation(pick.nodeId, ll.lat, ll.lng, zoom);
      }
      applySketchProvenanceTag(pick.nodeId, shape.color);
      CareSpace.addNote(
        pick.nodeId,
        `[workspace] attached shape ${idx + 1} (${SHAPE_COLOR_NAMES[shape.color] ?? 'custom'}) · ${shape.starIds.length} points${ll ? ` · @ ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}` : ''}`,
      );
      useNaksha.getState().setUndo(undo);
      useNaksha.getState().syncCare();
      bumpSidebar(); // Task 63 — the row re-speaks its binding (see shapeToCareNode)
      /* v138 T4 — binding → MD file (quiet, same as the Care bridge). */
      const boundShape = shapesRef.current.find((x) => x.id === shape.id);
      if (boundShape) syncShapeFile(boundShape, { quiet: true });
      const latStr = ll ? `${Math.abs(ll.lat).toFixed(3)}${ll.lat >= 0 ? 'N' : 'S'}` : 'no map';
      const lngStr = ll ? `${Math.abs(ll.lng).toFixed(3)}${ll.lng >= 0 ? 'E' : 'W'}` : '';
      useNaksha
        .getState()
        .print(
          `Shape → node "${pick.label}"${ll ? ` pinned @ ${latStr} ${lngStr}` : ' noted (map not ready)'} — undo available`,
          'success',
        );
    },
    [shapeCentroidLatLng, persistWorkspace, bumpSidebar, syncShapeFile],
  );

  /** CREATE-UNDER BRIDGE (Task 34) — the "✚ Care" menu item creates a new
   *  node under the CURRENT node; "↳ under node…" lets the user choose the
   *  parent from the fuzzy picker instead. The sketch is filed exactly
   *  where the user's structure lives — no post-move cleanup. Declared
   *  BEFORE handleAttachPick (its deps reference this callback). */
  const shapeToChildNode = useCallback(
    (shape: Shape, pick: NodePick) => {
      const idx = shapesRef.current.indexOf(shape);
      /* v138 T4 — the Under bridge shares the bind-time naming prompt
       * (the Task 65/66 flow, unchanged — but the answer now lands in
       * `name`). Placed BEFORE the river switch so cancel means nothing
       * happened — no network jump, no node, no half binding. Empty
       * keeps the "Shape N" default; already-named sketches file
       * silently. */
      let label = (shape.name || '').trim().slice(0, 40);
      if (!label) {
        const named = window.prompt(`Name the thought for sketch ${idx + 1} (empty = "Shape ${idx + 1}"):`, '');
        if (named === null) return;
        const clean = named.trim();
        if (clean) {
          shapesRef.current = shapesRef.current.map((x) =>
            x.id === shape.id ? { ...x, name: clean } : x,
          );
          label = clean.slice(0, 40);
        } else {
          label = `Shape ${idx + 1}`;
        }
      }
      if (CareSpace.currentNetwork().name !== pick.networkName) {
        CareSpace.switchNetwork(pick.networkName);
      }
      const undo: UndoEntry = {
        kind: 'care',
        label: `under ${pick.label.slice(0, 18)}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.addNode(label, pick.nodeId);
      if (!r.success) {
        useNaksha.getState().print(r.error ?? 'Could not create node', 'error');
        return;
      }
      const nodeId = r.data!;
      /* Task 51 — bind the sketch to the freshly created child node. */
      shapesRef.current = shapesRef.current.map((x) =>
        x.id === shape.id ? { ...x, nodeId } : x,
      );
      persistWorkspace();
      const ll = shapeCentroidLatLng(shape);
      if (ll) {
        const zoom = MapEngine.map ? Math.round(MapEngine.map.getZoom() ?? 12) : 12;
        CareSpace.pinLocation(nodeId, ll.lat, ll.lng, zoom);
      }
      applySketchProvenanceTag(nodeId, shape.color);
      CareSpace.addNote(
        nodeId,
        `[workspace] shape ${idx + 1} (${SHAPE_COLOR_NAMES[shape.color] ?? 'custom'}) · ${shape.starIds.length} points${ll ? ` · @ ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}` : ''} · under "${pick.label}"`,
      );
      useNaksha.getState().setUndo(undo);
      useNaksha.getState().syncCare();
      bumpSidebar(); // Task 63 — the row re-speaks its binding (see shapeToCareNode)
      /* v138 T4 — binding → MD file (quiet, same as the other bridges). */
      const underShape = shapesRef.current.find((x) => x.id === shape.id);
      if (underShape) syncShapeFile(underShape, { quiet: true });
      const latStr = ll ? `${Math.abs(ll.lat).toFixed(3)}${ll.lat >= 0 ? 'N' : 'S'}` : 'no map';
      const lngStr = ll ? `${Math.abs(ll.lng).toFixed(3)}${ll.lng >= 0 ? 'E' : 'W'}` : '';
      useNaksha
        .getState()
        .print(
          `Shape → new node "${label}" under "${pick.label}"${ll ? ` @ ${latStr} ${lngStr}` : ''} — undo available`,
          'success',
        );
    },
    [shapeCentroidLatLng, persistWorkspace, bumpSidebar, syncShapeFile],
  );

  const handleAttachPick = useCallback(
    (pick: NodePick) => {
      const shape = attachTargetRef.current;
      attachTargetRef.current = null;
      if (!shape) return;
      if (pickerModeRef.current === 'child') shapeToChildNode(shape, pick);
      else attachShapeToNode(shape, pick);
    },
    [attachShapeToNode, shapeToChildNode],
  );

  /** v138 T4 — the commit cores. The NAME is the shape's identity (what
   *  Task 76's input always saved — it used to land in `note`); the NOTE
   *  is the long-form annotation. Both persist, echo into the current
   *  thought (the Task 112 contract, unchanged), and write the shape's
   *  MD file — the name through a file RENAME when the base drifts. */
  const commitShapeName = useCallback(
    (shape: Shape, trimmedName: string) => {
      shapesRef.current = shapesRef.current.map((s) =>
        s.id === shape.id ? { ...shape, name: trimmedName } : s,
      );
      persistWorkspace();
      if (trimmedName) echoShapeTextToCare(trimmedName, 'name');
      /* The file follows the name: a named file whose base drifted gets
       * MOVED (internal move / gated vault rename), then rewritten with
       * the new frontmatter. Collision-safe via shapeFileBase. */
      const prevBase = shape.file
        ? splitShapeRel(shape.file)?.bare.replace(/\.(md|markdown)$/i, '') ?? null
        : null;
      const idx = shapesRef.current.indexOf(shape);
      const taken = new Set<string>();
      for (const s of shapesRef.current) {
        if (s.id === shape.id || !s.file) continue;
        const sp = splitShapeRel(s.file);
        if (sp) taken.add(sp.bare.replace(/\.(md|markdown)$/i, '').toLowerCase());
      }
      const wanted = trimmedName ? shapeFileBase(trimmedName, `shape ${idx + 1}`, taken) : null;
      syncShapeFile(
        { ...shape, name: trimmedName },
        { force: true, ...(prevBase && wanted && wanted !== prevBase ? { renameTo: wanted } : {}) },
      );
      if (trimmedName) {
        useNaksha.getState().print(`✎ "${trimmedName.slice(0, 32)}" — saved to the shape`, 'muted');
      }
      bumpSidebar(); // row text may have changed
      wakeUp();
    },
    [persistWorkspace, echoShapeTextToCare, syncShapeFile, bumpSidebar, wakeUp],
  );

  /** Edit a shape's note (menu "✎ Note" + sidebar double-click share this).
   *  Non-empty notes also echo into the CURRENT CareSpace node — the
   *  Task 112 contract, unchanged, now speaking through the shared echo
   *  core. The note also lands in the shape's MD file (body text). */
  const commitShapeNote = useCallback(
    (shape: Shape, trimmedNote: string) => {
      shapesRef.current = shapesRef.current.map((s) =>
        s.id === shape.id ? { ...shape, note: trimmedNote } : s,
      );
      persistWorkspace();
      if (trimmedNote) echoShapeTextToCare(trimmedNote, 'note');
      syncShapeFile({ ...shape, note: trimmedNote }, { force: true });
      bumpSidebar(); // row text may have changed
      wakeUp();
    },
    [persistWorkspace, echoShapeTextToCare, syncShapeFile, bumpSidebar, wakeUp],
  );

  const editShapeNote = useCallback(
    (shape: Shape) => {
      const note = window.prompt('Note for this shape:', shape.note);
      if (note !== null) commitShapeNote(shape, note.trim());
    },
    [commitShapeNote],
  );

  /** v138 T4 — rename from the canvas menu: the same prompt family the
   *  note editor speaks, committed through commitShapeName (which moves
   *  the MD file when the base drifts). */
  const editShapeName = useCallback(
    (shape: Shape) => {
      const name = window.prompt('Name for this shape:', shape.name);
      if (name !== null) commitShapeName(shape, name.trim());
    },
    [commitShapeName],
  );

  /** Open the canvas-side action menu for a shape at viewport coords. */
  const openShapeMenu = useCallback((shapeId: string, clientX: number, clientY: number) => {
    setMenu({ shapeId, x: clientX, y: clientY });
  }, []);

  /** Toggle a shape's selection (sidebar color chip). Refs carry the set;
   *  the count state only triggers the re-render that reflects it. */
  const toggleSelect = useCallback(
    (id: string) => {
      const sel = selectedRef.current;
      if (sel.has(id)) sel.delete(id);
      else sel.add(id);
      setSelectionCount(sel.size);
      wakeUp();
    },
    [wakeUp],
  );

  /** Undo the last added line or shape (journal order is exact). */
  const undoLast = useCallback(() => {
    const op = opOrderRef.current.pop();
    if (op === 'line') {
      linesRef.current.pop();
      useNaksha.getState().print('Undo: line removed', 'muted');
    } else if (op === 'shape') {
      const popped = shapesRef.current.pop();
      if (popped && selectedRef.current.delete(popped.id)) setSelectionCount(selectedRef.current.size);
      setShapesCount(shapesRef.current.length);
      /* Task 76 — undoing the shape that's being named closes the input
         (the shape it anchors on is gone). */
      setNaming((n) => (n && popped && n.shapeId === popped.id ? null : n));
      useNaksha.getState().print('Undo: shape removed', 'muted');
    } else {
      useNaksha.getState().print('Nothing to undo', 'muted');
      return;
    }
    persistWorkspace();
    wakeUp();
  }, [persistWorkspace, wakeUp]);

  /** Task 113 — per-shape delete (the menu's ✕ Delete): Clear wipes the
   *  whole board and local undo only pops the LAST op, but there was no
   *  way to remove ONE shape. The op ledger stays honest: the i-th
   *  'shape' tag IS the i-th shape in creation order, so deleting shape
   *  k splices exactly that tag out — future undoLast pops still land
   *  on the right object. Boundary lines stay (the design keeps closed
   *  loops' lines as constellation lines). */
  const deleteShape = useCallback(
    (shape: Shape) => {
      const idx = shapesRef.current.findIndex((s) => s.id === shape.id);
      if (idx === -1) return;
      shapesRef.current = shapesRef.current.filter((s) => s.id !== shape.id);
      let seen = -1;
      for (let i = 0; i < opOrderRef.current.length; i++) {
        if (opOrderRef.current[i] === 'shape') {
          seen++;
          if (seen === idx) {
            opOrderRef.current.splice(i, 1);
            break;
          }
        }
      }
      if (selectedRef.current.delete(shape.id)) setSelectionCount(selectedRef.current.size);
      /* Task 76 parity — deleting the shape being named closes the input. */
      setNaming((n) => (n && n.shapeId === shape.id ? null : n));
      setShapesCount(shapesRef.current.length);
      persistWorkspace();
      /* v138 T4 — the shape's MD file follows it out: internal files are
       * removed outright; vault files are TOMBSTONED (`deleted: yes`) —
       * the vault API has no delete route, and restore skips tombstones. */
      const fileRel = shape.file ? splitShapeRel(shape.file) : null;
      const fileData = buildShapeFileData(shape);
      if (fileRel && fileData && fileRel.kind === shapeStorageOf().kind) {
        void removeShapeFile(shapeStorageOf(), fileRel.bare, { ...fileData, name: shape.name }).then(
          (r) => {
            const st = useNaksha.getState();
            if (r.ok) {
              st.print(
                r.tombstoned
                  ? `▤ file marked deleted → ${shapePathLabel(shapeStorageOf(), fileRel.bare)} (vault keeps history)`
                  : `▤ file removed — ${shapePathLabel(shapeStorageOf(), fileRel.bare)}`,
                'muted',
              );
            } else {
              st.print(`▤ file cleanup failed — ${r.error}`, 'warning');
            }
          },
        );
      }
      useNaksha.getState().print(`Shape ${idx + 1} deleted — lines kept`, 'muted');
      wakeUp();
    },
    [persistWorkspace, wakeUp, buildShapeFileData, shapeStorageOf],
  );

  /** v138 T4 — RESTORE. A cleared board rebuilds every shape its MD files
   *  remember: coords snap back onto the CURRENT star lattice (same-size
   *  boards land on the exact original stars), boundary lines are rebuilt
   *  (kept as constellation lines, duplicates skipped), names/notes/colors
   *  and node bindings ride the frontmatter. Tombstoned (vault-deleted)
   *  and unparseable files are skipped and counted honestly. */
  const restoreFromFiles = useCallback(async () => {
    const st = useNaksha.getState();
    if (shapesRef.current.length > 0) {
      st.print('Board already has shapes — Clear first, then Restore', 'muted');
      return;
    }
    const storage = shapeStorageOf();
    const loading = st.showLoading(
      storage.kind === 'vault'
        ? `[vault:${storage.name}] restoring shapes from ${SHAPE_DIR_VAULT}/…`
        : 'restoring shapes from ~/workspace/…',
    );
    try {
      const list = await listShapeFiles(storage);
      if (!list.ok) {
        loading.stop(`restore failed — ${list.error}`, 'error');
        return;
      }
      const canvas = canvasRef.current;
      const bw = canvas?.clientWidth ?? 0;
      const bh = canvas?.clientHeight ?? 0;
      const snapToStar = (x: number, y: number): number | null => {
        const stars = starsRef.current;
        if (stars.length === 0) return null;
        const cx = Math.min(Math.max(x, 0), bw);
        const cy = Math.min(Math.max(y, 0), bh);
        let best = stars[0]!;
        let bd = Infinity;
        for (const s of stars) {
          const d = Math.hypot(s.x - cx, s.y - cy);
          if (d < bd) {
            bd = d;
            best = s;
          }
        }
        return best.id;
      };
      let shapes = 0;
      let lines = 0;
      let skipped = 0;
      for (const f of list.files) {
        const d = f.data;
        if (!d || d.deleted) {
          if (d) skipped++;
          continue;
        }
        // Snap the saved coords onto the current lattice.
        const ids: number[] = [];
        for (const c of d.coords) {
          const id = snapToStar(c.x, c.y);
          if (id == null) continue;
          if (ids.length === 0 || ids[ids.length - 1] !== id) ids.push(id);
        }
        while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
        const uniq = [...new Set(ids)];
        const shapeId = uniq.slice().sort((a, b) => a - b).join('-');
        if (uniq.length < 3 || shapesRef.current.some((s) => s.id === shapeId)) {
          skipped++;
          continue;
        }
        // Boundary lines stay (the constellation-lines design) — rebuilt,
        // duplicates against lines that survived skipped.
        for (let i = 0; i < uniq.length; i++) {
          const from = uniq[i]!;
          const to = uniq[(i + 1) % uniq.length]!;
          const exists = linesRef.current.some(
            (l) => (l.from === from && l.to === to) || (l.from === to && l.to === from),
          );
          if (!exists) {
            linesRef.current.push({ from, to });
            opOrderRef.current.push('line');
            lines++;
          }
        }
        shapesRef.current.push({
          id: shapeId,
          starIds: uniq,
          name: d.name,
          note: d.note,
          color: SHAPE_COLORS.includes(d.color) ? d.color : SHAPE_COLORS[0]!,
          file: storage.kind === 'vault' ? `vault:${SHAPE_DIR_VAULT}/${f.bare}` : `internal:${SHAPE_DIR_INTERNAL}/${f.bare}`,
          ...(d.created ? { created: d.created } : {}),
          ...(d.bound ? { nodeId: d.bound } : {}),
        });
        opOrderRef.current.push('shape');
        shapes++;
      }
      setShapesCount(shapesRef.current.length);
      persistWorkspace();
      bumpSidebar();
      wakeUp();
      const where = storage.kind === 'vault' ? `[vault:${storage.name}] ${SHAPE_DIR_VAULT}/` : '~/workspace/';
      loading.stop(
        shapes > 0
          ? `✦ Workspace restored — ${shapes} shape${shapes === 1 ? '' : 's'} · ${lines} line${lines === 1 ? '' : 's'} from ${where}${skipped > 0 ? ` · ${skipped} skipped` : ''}`
          : `No restorable shapes in ${where}${skipped > 0 ? ` (${skipped} skipped)` : ''}`,
        shapes > 0 ? 'success' : 'muted',
      );
    } catch (err) {
      loading.stop(`restore failed — ${(err as Error).message}`, 'error');
    }
  }, [shapeStorageOf, persistWorkspace, bumpSidebar, wakeUp]);

  // Mouse handlers
  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      mouseRef.current = { x, y };

      const nearest = findNearestStar(x, y);
      if (nearest !== hoveredStarRef.current) {
        hoveredStarRef.current = nearest;
        canvas.style.cursor = nearest != null ? 'pointer' : 'crosshair';
      }
      /* Task 53 — the canvas speaks: hovering INSIDE a shape updates the
       * canvas's NATIVE title with the shape's ownership (which thought
       * it is bound to). Zero DOM additions, zero React state. The
       * polygon walk is UNCONDITIONAL — on a 28px star grid every point
       * sits within SNAP_DISTANCE (30) of some star, so a "no star
       * hovered" gate would make this branch unreachable. Bounded: a
       * handful of polygons, short-circuit on first hit, title written
       * only when it changes. The star drag affordance (cursor) below
       * is untouched — the title describes the shape, the cursor the
       * snap. */
      let hint = '';
      for (const shape of shapesRef.current) {
        const pts = shape.starIds.map((id) => getStar(id)).filter(Boolean) as Star[];
        if (pts.length < 3) continue;
        if (pointInPolygon(x, y, pts)) {
          const nm = shape.name ? `"${shape.name.slice(0, 28)}${shape.name.length > 28 ? '…' : ''}"` : '';
          /* Task 54 — the shape's OWN annotation follows when it has
           * one. Truncated to keep the native tooltip one line.
           * Task 56 — the bound node's FIRST TAG speaks as text: the
           * same color story the terminal bullet and map marker tell,
           * now readable on the canvas hover (the tooltip can't show
           * color, so it names it). First non-none tag only; untagged
           * nodes stay silent about it.
           * Task 57 — the constellation's SIZE joins the count thread:
           * `N pts` is how many stars the shape spans — the same number
           * provenance notes and shape→node bridges already speak. */
          const note = shape.note ? `"${shape.note.slice(0, 28)}${shape.note.length > 28 ? '…' : ''}"` : '';
          /* Task 64 — cross-river: "Bound to" stays true when the owner
           * lives in another river (and names it, like the receipts do). */
          const ownerBound = boundOwnerOf(shape.nodeId);
          const owner = ownerBound?.node ?? null;
          const ownerCross = ownerBound && ownerBound.net !== CareSpace.currentNetwork();
          const firstTag = owner?.tags?.find((t) => t !== 'none');
          /* Task 59 — the tag + pts fragments come from the SHARED
           * formatters (tagWord / ptsWord) — same words the sidebar row
           * and tooltip speak. */
          const tw = tagWord(firstTag);
          const bound = owner ? `Bound to "${owner.label}"${ownerCross ? ` · ${ownerBound.net.name}` : ''}${tw ? ` · ${tw}` : ''}` : 'Shape';
          hint = `${nm ? `${nm} · ` : ''}${note ? `${note} · ` : ''}${bound} · ${ptsWord(shape.starIds.length)} · click for actions`;
          break;
        }
      }
      if (canvas.title !== hint) canvas.title = hint;
      /* Task 75 — closure preview: while a drag is live, ask the SAME
       * checker mouseup uses whether this release would close a shape.
       * BFS over ≤ the line count, only while dragging — zero cost at
       * rest (the not-dragging branch is a single ref write). */
      pendingShapeRef.current = dragFromRef.current != null ? checkShapeClosure() : null;
      wakeUp();
    },
    [findNearestStar, getStar, checkShapeClosure, wakeUp],
  );

  const onMouseDown = useCallback(
    (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const nearest = findNearestStar(x, y);
      if (nearest != null) {
        dragFromRef.current = nearest;
        canvas.style.cursor = 'grabbing';
      }
      wakeUp();
    },
    [findNearestStar, wakeUp],
  );

  const onMouseUp = useCallback(
    (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const from = dragFromRef.current;
      const to = findNearestStar(x, y);

      if (from != null && to != null && from !== to) {
        // Check if this closes a shape
        const shape = checkShapeClosure();
        if (shape) {
          shapesRef.current.push(shape);
          opOrderRef.current.push('shape');
          setShapesCount(shapesRef.current.length);
          persistWorkspace();
          // Remove the lines that form the shape boundary? No — keep them,
          // they're the constellation lines.
          /* Task 76 — the name prompt comes to the shape: the input mounts
           * at the centroid the moment the polygon closes. */
          setNaming({ shapeId: shape.id, value: '' });
          useNaksha
            .getState()
            .print('✦ Shape created — name it at the shape (Enter saves · Esc skips)', 'success');
        } else {
          // Add the line
          // Avoid duplicate lines
          const exists = linesRef.current.some(
            (l) => (l.from === from && l.to === to) || (l.from === to && l.to === from),
          );
          if (!exists) {
            linesRef.current.push({ from, to });
            opOrderRef.current.push('line');
            persistWorkspace();
          }
        }
      }

      dragFromRef.current = null;
      hoveredStarRef.current = null;
      pendingShapeRef.current = null; // Task 75 — the ghost had its moment
      /* Task 113 — the window now guards only gestures that DID work:
       * from !== to (a line was drawn or a shape closed). Task 76 armed
       * it on every mouseup with a star, and the full star grid means
       * EVERY mousedown finds one — so a stationary click armed its own
       * suppression 10ms before its click-event arrived, and the
       * canvas's promise ("click a shape for its action menu") was
       * unreachable for real users. Found by this round's e2e: a
       * natural-timing dispatch (down@0 → up@50 → click@62) on a shape
       * interior opened nothing. A stationary down/up IS the deliberate
       * click Task 76's own comment says must pass through. */
      if (from != null && to != null && from !== to) {
        suppressClickUntilRef.current = Date.now() + 300;
      }
      canvas.style.cursor = 'crosshair';
      wakeUp();
    },
    [checkShapeClosure, wakeUp, persistWorkspace],
  );

  const onClick = useCallback(
    (e: MouseEvent) => {
      // If we just finished a drag, don't treat as click
      if (dragFromRef.current != null) return;
      /* Task 76 — the click event a drag-completing mouseup emits lands
       * INSIDE the newborn shape; without this window it pops the action
       * menu open under the naming input. Deliberate clicks (mousedown
       * on empty space) never pass through a suppression window. */
      if (Date.now() < suppressClickUntilRef.current) return;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Click inside a shape → open the canvas-side action menu at the
      // cursor (Note / ⇒ Node / Pin / Care) — no prompt wall, no need to
      // find the sidebar row. Clicking empty space dismisses the menu.
      for (const shape of [...shapesRef.current]) {
        const points = shape.starIds.map((id) => getStar(id)).filter(Boolean) as Star[];
        if (points.length < 3) continue;
        if (pointInPolygon(x, y, points)) {
          openShapeMenu(shape.id, e.clientX, e.clientY);
          return;
        }
      }
      setMenu(null);
    },
    [getStar, openShapeMenu],
  );

  const onMouseLeave = useCallback(() => {
    hoveredStarRef.current = null;
    dragFromRef.current = null;
    pendingShapeRef.current = null; // Task 75 — no drag, no ghost
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'default';
    wakeUp();
  }, [wakeUp]);

  // Esc to exit workspace · Ctrl+Z to undo the last line/shape.
  // While the attach picker or the shape menu is open, Esc belongs to
  // them first (dialog closes / menu dismisses) — the workspace must
  // NOT also exit in the same keystroke.
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (pickerOpen) return;
      /* Task 76 — while the naming input is open, Esc belongs to IT:
       * it names nothing and closes the input — the workspace must NOT
       * exit in the same keystroke. */
      if (e.key === 'Escape' && naming) {
        e.preventDefault();
        setNaming(null);
        return;
      }
      if (e.key === 'Escape' && menu) {
        e.preventDefault();
        setMenu(null);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        useNaksha.getState().setFocusActive(false);
        useNaksha.getState().print('Exited workspace', 'info');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        /* Task 76 — while naming, Ctrl+Z is the input's native text undo
         * (no preventDefault): shape history keeps its hands off. */
        if (naming) return;
        /* Task 114 — the same courtesy for the TERMINAL input. Workspace
         * view keeps the terminal reachable (the "/" focus hint lives in
         * the boot text), and ⌘Z pressed THERE is text undo, not shape
         * history: the document handler was stealing it — preventDefault
         * killed the input's native undo and undoLast ate a shape
         * instead. Skip any editable target; the canvas gesture keeps
         * its shortcut only when the keystroke is really over the sky. */
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        undoLast();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [active, undoLast, pickerOpen, menu, naming]);

  // Setup canvas
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = containerRef.current;
    if (!container) return;

    // DPR — capped at 1.5 for CPU performance
    dprRef.current = Math.min(window.devicePixelRatio || 1, 1.5);

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = Math.round(w * dprRef.current);
      canvas.height = Math.round(h * dprRef.current);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      computeStars();
      renderStarField();
      draw();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    /* Restore persisted constellation (lines + shapes) — stars are computed
     * from viewport size, so only lines/shapes need saving. */
    const snap = loadSnapshot();
    if (snap) {
      linesRef.current = snap.lines;
      shapesRef.current = snap.shapes;
      opOrderRef.current = [
        ...snap.lines.map(() => 'line' as const),
        ...snap.shapes.map(() => 'shape' as const),
      ];
      if (snap.lines.length > 0 || snap.shapes.length > 0) {
        setShapesCount(snap.shapes.length);
        useNaksha
          .getState()
          .print(
            /* Task 119 — pluralized counts ("1 line · 0 shapes"), matching
               the header-meta copy standard the panels already follow. */
            `Workspace restored — ${snap.lines.length} ${snap.lines.length === 1 ? 'line' : 'lines'} · ${snap.shapes.length} ${snap.shapes.length === 1 ? 'shape' : 'shapes'}`,
            'muted',
          );
      }
    }

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('mouseleave', onMouseLeave);

    wakeUp();

    return () => {
      ro.disconnect();
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [active, computeStars, renderStarField, draw, onMouseMove, onMouseDown, onMouseUp, onClick, onMouseLeave, wakeUp]);

  /* Task 45 — twinkle driver. A slow interval swaps the pre-rendered star
   * field variant and paints ONE frame synchronously (no rAF, no activity
   * stamp — the interaction loop's 2s idle sleep is untouched). perf-low
   * machines no-op: the check is the first line, so the steady-state cost
   * is a single boolean read per ~1.2s. */
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => {
      if (useNaksha.getState().settings.perfMode === 'low') return;
      twinkleIdxRef.current = (twinkleIdxRef.current + 1) % TWINKLE_VARIANTS;
      draw();
    }, TWINKLE_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [active, draw]);

  /* Task 51 — constellation arrival flash. Entering the workspace while
   * the CURRENT thought owns bound sketches (shape.nodeId, written by
   * the three bridges) pulses ALL of them gold for ~1.5s — the same
   * "you have arrived" voice as the panel ring / tree flash / graph
   * ring, spoken in the workspace's own dialect. The user story: ⇥ jump
   * to a thought in the tree, type `ws`, and its constellations greet
   * you. Perf-low skips (parity with the pulse family); the interaction
   * loop is already awake ~2s after activation, so the flash adds no
   * idle-loop time — it only colors ~1.5s of frames that would paint
   * anyway. No match → zero cost beyond one array filter. */
  useEffect(() => {
    if (!active) return;
    if (useNaksha.getState().settings.perfMode === 'low') return;
    const node = CareSpace.getCurrentNode();
    if (!node) return;
    const bound = shapesRef.current.filter((s) => s.nodeId === node.id);
    if (bound.length === 0) return;
    highlightShapesRef.current = new Set(bound.map((s) => s.id));
    highlightUntilRef.current = Date.now() + 1500;
    lastActivityRef.current = Date.now();
    if (rafRef.current == null) startRaf();
    useNaksha
      .getState()
      .print(
        `⇥ "${node.label}" owns ${bound.length} constellation${bound.length === 1 ? '' : 's'} — they flash gold`,
        'muted',
      );
  }, [active, startRaf]);

  if (!active) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[3000]"
      style={{ background: 'var(--naksha-bg)' }}
    >
      <canvas
        ref={canvasRef}
        /* Task 109 — the deepest surface finally introduces itself. The
         * canvas was a bare node in the a11y tree; its only readout was
         * the pointer-only hover title. The label states the same contract
         * the visual hint bar prints — drag draws, a closed loop forms a
         * shape, a shape click opens its menu — and the Shapes list below
         * is the non-hover equivalent of the hover readout. */
        aria-label="Workspace star map — drag between stars to draw lines; close a loop of lines to form a shape; click a shape for its action menu"
        style={{
          position: 'absolute',
          inset: 0,
          cursor: 'crosshair',
        }}
      />

      {/* Task 76 — the inline naming input, anchored at the newborn
          shape's centroid. Enter commits through commitShapeNote (the
          same core the ✎ prompt uses — persist + CareSpace echo + row
          refresh); Esc or click-away leaves the shape unnamed. Renders
          only while naming is live; a stale shapeId (undone shape)
          renders nothing. */}
      {naming &&
        (() => {
          const ns = shapesRef.current.find((s) => s.id === naming.shapeId);
          if (!ns) return null;
          const npts = ns.starIds.map((id) => getStar(id)).filter(Boolean) as Star[];
          if (npts.length < 3) return null;
          const ncx = npts.reduce((s, p) => s + p.x, 0) / npts.length;
          const ncy = npts.reduce((s, p) => s + p.y, 0) / npts.length;
          return (
            <>
              <input
                autoFocus
                /* Task 109 — a placeholder is a hint, not a name: it vanishes
                 * on first keystroke and many AT configurations never read
                 * it. The label carries the same contract the title does. */
                aria-label="Name this shape — Enter saves the name (also written to the shape's MD file), Esc leaves it unnamed"
                value={naming.value}
                onChange={(e) => setNaming({ shapeId: naming.shapeId, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const trimmed = naming.value.trim();
                    /* v138 T4 — Enter commits the NAME now (the receipt
                     * + file write + care echo all live in the core). */
                    commitShapeName(ns, trimmed);
                    setNaming(null);
                  }
                }}
                onBlur={() => setNaming(null)}
                placeholder="name this shape…"
                title="Enter saves the name (echoes into the current thought + writes the MD file) · Esc or click-away leaves it unnamed"
                style={{
                  position: 'absolute',
                  left: ncx,
                  top: ncy,
                  transform: 'translate(-50%, -50%)',
                  width: 150,
                  padding: '4px 8px',
                  fontSize: 'var(--naksha-fs-xs)',
                  /* Task 95 — gold-tinted theme glass (Task 92's input rule:
                   * the surface tints with its action's family and rides the
                   * theme), replacing the frozen near-black that washed the
                   * themed ink on light papers. */
                  background: 'color-mix(in srgb, var(--naksha-gold) 12%, var(--naksha-glass-2))',
                  border: '1px solid var(--naksha-gold)',
                  borderRadius: 4,
                  color: 'var(--naksha-text)',
                  caretColor: 'var(--naksha-gold)',
                  outline: 'none',
                  zIndex: 12,
                  boxShadow: '0 2px 10px rgba(0, 0, 0, 0.35), 0 0 0 1px color-mix(in srgb, var(--naksha-gold) 12%, transparent)',
                }}
              />
              {/* Task 77 — the keystroke hint rides UNDER the input (the
                  title attr alone never taught the Esc path; the receipt
                  taught Enter after the fact). Non-interactive, canvas-
                  quiet: 8px mono, pointer-events none so a stray click
                  still lands on the canvas and blur-skips as designed. */}
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: ncx,
                  top: ncy + 15,
                  transform: 'translate(-50%, 0)',
                  fontSize: 'var(--naksha-fs-xs)',
                  color: 'var(--naksha-text-4)',
                  textShadow: '0 1px 3px rgba(0, 0, 0, 0.7)',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  zIndex: 12,
                }}
              >
                ↵ save · esc skip
              </span>
            </>
          );
        })()}

      {/* Minimal header — just a small hint that fades */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '6px 16px',
          borderRadius: 99,
          /* Task 95 — theme glass, not frozen near-black: the hint's ink
           * is var(--naksha-text-3) and ghosted on light papers. */
          background: 'var(--naksha-glass-2, rgba(26, 22, 17, 0.6))',
          border: '1px solid var(--naksha-border)',
          fontSize: 'var(--naksha-fs-xs)',
          color: 'var(--naksha-text-3)',
          pointerEvents: 'none',
          zIndex: 10,
        }}
      >
        Workspace · drag between stars · close a loop for a shape · named shapes save to MD · esc exit
      </div>

      {/* Bottom-left: shape list (collapsible) */}
      <div
        style={{
          position: 'absolute',
          bottom: 20,
          left: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          zIndex: 10,
          maxWidth: 260,
        }}
      >
        {listOpen && (
          <div
            /* Task 109 — the list is the non-hover equivalent of the
             * canvas hover title (same words: note, bound owner, tag,
             * pts); label it so tabbing in announces WHAT this is. */
            role="group"
            aria-label={`Shapes in this constellation (${shapesCount})`}
            style={{
              maxHeight: 180,
              overflowY: 'auto',
              borderRadius: 8,
              background: 'var(--naksha-glass-2, rgba(26, 22, 17, 0.6))', /* Task 95 — theme glass */
              border: '1px solid var(--naksha-border)',
              padding: '6px 8px',
              fontSize: 'var(--naksha-fs-xs)',
            }}
            className="naksha-scroll"
          >
            <div
              data-rev={sidebarRev}
              style={{ color: 'var(--naksha-gold)', marginBottom: 4 }}
            >
              {shapesCount === 1 ? 'Shape' : 'Shapes'} ({shapesCount})
              {selectionCount > 0 ? ` · ${selectionCount} selected` : ''}
            </div>
            {shapesRef.current.length === 0 && (
              <div style={{ color: 'var(--naksha-text-4)', padding: '2px 0' }}>
                none yet — close a polygon of lines
              </div>
            )}
            {shapesRef.current.map((s, i) => {
              /* Task 52 — bound-thought provenance for this row: the tag
               * tint dot + the tooltip label. Pure CareSpace reads, only
               * while the sidebar is open (≤ a handful of shapes).
               * Task 64 — the resolution is CROSS-RIVER (boundOwnerOf):
               * a sketch bound through the ⇒ Node picker may point at
               * any river — the dot, the tooltips and the ⇥ chip now
               * follow the binding, and the tooltip names the river. */
              const ownerBound = boundOwnerOf(s.nodeId);
              const owner = ownerBound?.node ?? null;
              const ownerNet = ownerBound?.net;
              const ownerCross = !!ownerNet && ownerNet !== CareSpace.currentNetwork();
              const ownerTag = owner?.tags.filter((t) => t && t !== 'none')[0];
              const boundTagColor = ownerTag ? TAG_COLORS[ownerTag] : undefined;
              const boundLabel = owner?.label;
              return (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'stretch',
                  gap: 4,
                  borderBottom: '1px solid var(--naksha-border)',
                  borderLeft: selectedRef.current.has(s.id)
                    ? '2px solid var(--naksha-gold)'
                    : '2px solid transparent',
                }}
              >
                {/* Color chip — the per-shape legend; click toggles selection,
                    right-click cycles the shape's color (instant repaint, no
                    menu — CPU-cheap and discoverable via the tooltip). */}
                <button
                  onClick={() => toggleSelect(s.id)}
                  /* Task 109 — a 12×12 swatch with no text: its name came
                   * only from the title attribute. aria-pressed already
                   * states the state; now the button has a name too. */
                  aria-label={`Shape ${i + 1} — select or deselect · right-click changes the color`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const idx = SHAPE_COLORS.indexOf(s.color);
                    const next = SHAPE_COLORS[(idx + 1) % SHAPE_COLORS.length];
                    shapesRef.current = shapesRef.current.map((x) =>
                      x.id === s.id ? { ...x, color: next } : x,
                    );
                    persistWorkspace();
                    /* v138 T4 — the color rides the MD file's frontmatter
                     * when the shape has one (quiet — no receipt for an
                     * ambient re-paint; errors still speak). */
                    const recolored = shapesRef.current.find((x) => x.id === s.id);
                    if (recolored) syncShapeFile(recolored, { quiet: true });
                    bumpSidebar(); // rows read shapesRef — refresh the list
                    wakeUp();
                  }}
                  title={
                    selectedRef.current.has(s.id)
                      ? 'Selected — click to deselect · right-click to change color'
                      : 'Select (gold dashed outline) · right-click to change color'
                  }
                  aria-pressed={selectedRef.current.has(s.id)}
                  style={{
                    width: 12,
                    height: 12,
                    flex: '0 0 auto',
                    alignSelf: 'center',
                    marginLeft: 2,
                    borderRadius: 3,
                    border: selectedRef.current.has(s.id)
                      ? '1px solid var(--naksha-gold)'
                      : '1px solid var(--naksha-border)',
                    background: shapeOutlineColor(s.color),
                    padding: 0,
                    cursor: 'pointer',
                  }}
                />
                <button
                  onClick={() => {
                    highlightShapesRef.current = new Set([s.id]);
                    highlightUntilRef.current = Date.now() + 1400;
                    wakeUp();
                  }}
                  onDoubleClick={() => {
                    // Edit note from the list too (same flow as the canvas
                    // menu — mutate + persist + CareSpace echo + row refresh)
                    editShapeNote(s);
                  }}
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--naksha-text-2)',
                    fontSize: 'var(--naksha-fs-xs)',
                    padding: '3px 2px',
                    cursor: 'pointer',
                    /* Task 58 — the meta tail (pts · tag) can push long
                     * notes wide; one-line rows with an ellipsis keep the
                     * list a list (the tooltip carries the full truth). */
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={`${boundLabel ? `Bound to "${boundLabel}"${ownerCross ? ` · ${ownerNet!.name}` : ''}${ownerTag ? ` · ${tagWord(ownerTag)}` : ''} · ` : ''}${s.note ? `note: ${s.note.slice(0, 40)} · ` : ''}click to highlight · double-click to edit note`}
                >
                  {/* Task 52 — the tag-tint bullet, sidebar edition: a bound
                      sketch whose thought wears a tag shows the SAME tint
                      here as the tree row, the map marker, the graph label
                      and the terminal bullets. The color story now runs
                      through the constellation list too. Computed per row
                      render (sidebar-only, ≤ a few shapes — pure reads). */}
                  {boundTagColor && (
                    <span
                      aria-hidden="true"
                      style={{
                        display: 'inline-block',
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        background: boundTagColor,
                        marginRight: 4,
                        verticalAlign: 1,
                      }}
                    />
                  )}
                  {String(i + 1).padStart(2, '0')}{' '}
                  {s.name ? s.name.slice(0, 22) : s.note ? s.note.slice(0, 22) : '(unnamed)'}
                  <span style={{ color: 'var(--naksha-text-4)' }}>
                    {' '}
                    · {ptsWord(s.starIds.length)}
                    {/* Task 58/59 — the tag NAME rides beside the pts via
                        the SHARED tagWord formatter (the dot already
                        wears its color): the same line the canvas hover
                        title speaks — one truth, one spelling. */}
                    {ownerTag ? ` · ${tagWord(ownerTag)}` : ''}
                  </span>
                </button>
                {/* Task 63 — the ⇥ chip, sidebar edition (the two-sided idea
                    mirrored from the links rows): a bound sketch is one click
                    from its THOUGHT. The hover title named the owner before;
                    now the row can REACH it — the same tree landing the
                    terminal ⇥ chips speak (switch river when needed, tree
                    view, details panel, receipt line). Unbound shapes render
                    no chip — nothing to reach. */}
                {owner && s.nodeId && (
                  <button
                    onClick={() => {
                      const nets = CareSpace.networks();
                      const ownerNet = nets.find((n) => !!n.nodes[s.nodeId!]);
                      if (!ownerNet) return;
                      const isCrossRiver = ownerNet !== nets[CareSpace.data.currentNetworkIndex];
                      if (isCrossRiver) CareSpace.switchNetwork(ownerNet.name);
                      ownerNet.currentId = s.nodeId!;
                      CareSpace.save();
                      const st = useNaksha.getState();
                      st.syncCare();
                      if (st.careViewMode !== 'tree') st.setCareViewMode('tree');
                      st.setDetailsNodeId(s.nodeId!, st.settings.perfMode !== 'low');
                      /* Task 64 — the receipt carries the sketch's MEANING:
                       * the note is why the sketch exists, so it rides the
                       * landing line (quoted, truncated like the row) — the
                       * terminal records the reason where the jump happened. */
                      st.print(`⇥ tree → "${owner.label}"${isCrossRiver ? ` · ${ownerNet.name}` : ''} · details — from sketch ${String(i + 1).padStart(2, '0')}${s.name ? ` · "${s.name.slice(0, 24)}"` : ''}`, 'muted');
                    }}
                    title={`⇥ open "${boundLabel}" in the tree${ownerCross ? ` · ${ownerNet!.name}` : ''}${ownerTag ? ` · ${tagWord(ownerTag)}` : ''}`}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--naksha-gold)',
                      fontSize: 'var(--naksha-fs-xs)',
                      padding: '3px 6px',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--naksha-gold-light)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--naksha-gold)'; }}
                  >
                    ⇥ Node
                  </button>
                )}
                {/* Task 64 — the note verb, chip edition: double-click edits
                    the sketch's note already, but a hidden verb is a rare
                    verb. The chip makes the note one click away for EVERY
                    row (bound or not) — the same prompt, the same CareSpace
                    echo, no new flow to learn. */}
                <button
                  onClick={() => editShapeNote(s)}
                  title="✎ edit this sketch's note (echoes into the current thought when non-empty)"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--naksha-gold)',
                    fontSize: 'var(--naksha-fs-xs)',
                    padding: '3px 6px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--naksha-gold-light)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--naksha-gold)'; }}
                >
                  ✎ Note
                </button>
                <button
                  onClick={() => pinShapeToMap(s)}
                  title="Drop a map pin at this shape's centroid"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--naksha-gold)',
                    fontSize: 'var(--naksha-fs-xs)',
                    padding: '3px 6px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--naksha-gold-light)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--naksha-gold)'; }}
                >
                  → Map
                </button>
                <button
                  onClick={() => {
                    pickerModeRef.current = 'attach';
                    attachTargetRef.current = s;
                    setPickerOpen(true);
                  }}
                  title="Attach to an EXISTING node — pick it, it gets pinned at this shape's real-world position"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--naksha-gold)',
                    fontSize: 'var(--naksha-fs-xs)',
                    padding: '3px 6px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--naksha-gold-light)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--naksha-gold)'; }}
                >
                  ⇒ Node
                </button>
                <button
                  onClick={() => shapeToCareNode(s)}
                  title="Create a NEW CareSpace node at this shape's real-world position (⇒ Node attaches to an existing one)"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--naksha-gold)',
                    fontSize: 'var(--naksha-fs-xs)',
                    padding: '3px 6px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--naksha-gold-light)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--naksha-gold)'; }}
                >
                  → Care
                </button>
                <button
                  onClick={() => {
                    pickerModeRef.current = 'child';
                    attachTargetRef.current = s;
                    setPickerOpen(true);
                  }}
                  title="Create a new node UNDER a node you pick — files the sketch inside your existing structure (Task 35: sidebar parity with the canvas menu)"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--naksha-gold)',
                    fontSize: 'var(--naksha-fs-xs)',
                    padding: '3px 6px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--naksha-gold-light)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--naksha-gold)'; }}
                >
                  ↳ Under
                </button>
              </div>
              );
            })}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setListOpen((v) => !v)}
            /* Task 109 — toggle semantics were pixels-only: the button
             * looked pressed-in when the list was open but AT heard a
             * featureless "Shapes 3". aria-expanded states the contract,
             * the label keeps the count the content carried. */
            aria-expanded={listOpen}
            aria-label={`${listOpen ? 'Hide' : 'Show'} the shapes list (${shapesCount} shape${shapesCount === 1 ? '' : 's'})`}
            className="naksha-mini-btn"
            style={{
              padding: '8px 14px',
              fontSize: 'var(--naksha-fs-xs)',
            }}
          >
            Shapes{shapesCount > 0 ? ` ${shapesCount}` : ''}
          </button>
          <button
            onClick={undoLast}
            /* Task 109 — "Undo" inside the workspace means the last drawn
             * line or shape, NOT the global ledger the status bar's ⌘Z
             * talks about. Say which undo is on offer. */
            aria-label="Undo the last drawn line or shape (workspace undo, not the global ledger)"
            className="naksha-mini-btn"
            style={{
              padding: '8px 14px',
              fontSize: 'var(--naksha-fs-xs)',
            }}
          >
            Undo
          </button>
        </div>
      </div>

      {/* Action buttons — Restore (when empty) · Export PNG · Care All · Clear */}
      <div
        style={{
          position: 'absolute',
          bottom: 20,
          right: 20,
          display: 'flex',
          gap: 8,
          zIndex: 10,
        }}
      >
        {/* v138 T4 — the empty-board door back in: every named/annotated
            shape left an MD record behind; this rebuilds them at their
            original positions. Only rendered when the board is empty. */}
        {shapesCount === 0 && (
          <button
            className="naksha-mini-btn"
            onClick={() => void restoreFromFiles()}
            aria-label="Restore shapes from their saved MD files (internal workspace folder or designated vault) — names, notes and original positions"
            title="Rebuild the shapes their MD files remember — names, notes and original positions"
            style={{
              padding: '8px 16px',
              fontSize: 'var(--naksha-fs-xs)',
            }}
          >
            Restore MD
          </button>
        )}
        <button
          className="naksha-mini-btn"
          /* Task 109 — named for what it exports and where it goes. */
          aria-label="Export the constellation as a PNG image to your downloads"
          onClick={() => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            try {
              const url = canvas.toDataURL('image/png');
              const a = document.createElement('a');
              a.href = url;
              a.download = `naksha-constellation-${new Date().toISOString().slice(0, 10)}.png`;
              a.click();
              useNaksha.getState().print('Constellation exported as PNG', 'success');
            } catch {
              useNaksha.getState().print('Export failed', 'error');
            }
          }}
          style={{
            padding: '8px 16px',
            fontSize: 'var(--naksha-fs-xs)',
          }}
        >
          Export PNG
        </button>
        <button
          className="naksha-mini-btn"
          onClick={() => {
            const sel = selectedRef.current;
            const shapes = sel.size > 0 ? shapesRef.current.filter((s) => sel.has(s.id)) : shapesRef.current;
            pinShapesToMap(shapes);
          }}
          title={
            selectionCount > 0
              ? `Drop map pins at the ${selectionCount} selected shape(s)' real-world centroids`
              : 'Drop a map pin at every shape\'s real-world centroid'
          }
          /* Task 109 — the title was the only carrier of the dynamic
           * contract; AT that skips titles heard a bare "Pin All". The
           * aria-label mirrors it (status-bar pattern: verbose name,
           * visual text unchanged). */
          aria-label={
            selectionCount > 0
              ? `Drop map pins at the ${selectionCount} selected shape(s)' real-world centroids`
              : 'Drop a map pin at every shape\'s real-world centroid'
          }
          style={{
            padding: '8px 16px',
            fontSize: 'var(--naksha-fs-xs)',
          }}
        >
          {selectionCount > 0 ? `Pin ${selectionCount}` : 'Pin All'}
        </button>
        <button
          className="naksha-mini-btn"
          onClick={() => {
            const sel = selectedRef.current;
            const shapes = sel.size > 0 ? shapesRef.current.filter((s) => sel.has(s.id)) : shapesRef.current;
            if (shapes.length === 0) {
              useNaksha.getState().print('No shapes to bridge — close a polygon first', 'muted');
              return;
            }
            let ok = 0;
            for (const s of shapes) {
              const before = CareSpace.getStats().totalNodes;
              shapeToCareNode(s);
              if (CareSpace.getStats().totalNodes > before) ok++;
            }
            useNaksha
              .getState()
              .print(
                `✦ Bridge: ${ok}/${shapes.length} shape(s) → CareSpace nodes${sel.size > 0 ? ' (selected)' : ' (all)'}`,
                'success',
              );
          }}
          title={
            selectionCount > 0
              ? `Create CareSpace nodes for the ${selectionCount} selected shape(s) at their real-world positions`
              : 'Create a CareSpace node for every shape at its real-world position'
          }
          /* Task 109 — same mirror as Pin: the dynamic contract reaches
           * AT by name, the cryptic visual shorthand stays as-is. */
          aria-label={
            selectionCount > 0
              ? `Create CareSpace nodes for the ${selectionCount} selected shape(s) at their real-world positions`
              : 'Create a CareSpace node for every shape at its real-world position'
          }
          style={{
            padding: '8px 16px',
            fontSize: 'var(--naksha-fs-xs)',
          }}
        >
          {selectionCount > 0 ? `Care ${selectionCount}` : 'Care All'}
        </button>
        <button
          className="naksha-mini-btn"
          onClick={() => {
            linesRef.current = [];
            shapesRef.current = [];
            opOrderRef.current = [];
            selectedRef.current.clear();
            setSelectionCount(0);
            setShapesCount(0);
            persistWorkspace();
            wakeUp();
            useNaksha.getState().print('Workspace cleared — shapes restorable from their MD files (Restore MD)', 'info');
          }}
          style={{
            padding: '8px 16px',
            fontSize: 'var(--naksha-fs-xs)',
          }}
          /* Task 109 — the one destructive control in the overlay, and it
           * was a bare "Clear". Name the blast radius (the workspace
           * undo's op-order is emptied too, so undo cannot restore). */
          aria-label="Clear every line and shape from the workspace (workspace undo cannot restore them)"
        >
          Clear
        </button>
      </div>

      {/* Canvas-side shape action menu — opens where you clicked. Glass,
          monospace, static (no animation) — perf-low safe. Clamped so it
          never leaves the viewport. */}
      {menu && (() => {
        const shape = shapesRef.current.find((s) => s.id === menu.shapeId);
        if (!shape) return null;
        const MENU_W = 150;
        /* Task 113 — six items now: 6 × ~23px rows + header + padding.
         * v138 T4 — seven: ✎ Name joins (rename = the file rename path). */
        const MENU_H = 191;
        const mx = Math.min(menu.x, window.innerWidth - MENU_W - 12);
        const my = Math.min(menu.y, window.innerHeight - MENU_H - 12);
        const items: Array<{ label: string; hint: string; run: () => void }> = [
          /* v138 T4 — the name gets its own verb: the identity (label,
           * canvas, sidebar, MD filename) vs the annotation (the file body). */
          { label: '✎ Name', hint: 'rename · moves the MD file', run: () => editShapeName(shape) },
          { label: '✎ Note', hint: 'annotate · saved to the file', run: () => editShapeNote(shape) },
          { label: '⇒ Node', hint: 'attach to existing', run: () => { pickerModeRef.current = 'attach'; attachTargetRef.current = shape; setPickerOpen(true); } },
          { label: '◉ Pin', hint: 'map pin at centroid', run: () => pinShapeToMap(shape) },
          { label: '✚ Care', hint: 'create new node', run: () => shapeToCareNode(shape) },
          { label: '↳ under node…', hint: 'new node, pick parent', run: () => { pickerModeRef.current = 'child'; attachTargetRef.current = shape; setPickerOpen(true); } },
          /* Task 113 — per-shape delete, last because destructive. The
           * hint says what survives: the constellation lines stay. */
          { label: '✕ Delete', hint: 'remove this shape, keep lines', run: () => deleteShape(shape) },
        ];
        return (
          <div
            data-rev={sidebarRev}
            /* Task 109 — a floating group of buttons with no name: an AT
             * user tabbing in heard five unlabeled-context buttons. A
             * role="group" (NOT "menu" — no arrow-key nav exists, and
             * announcing a contract the UI doesn't keep is worse than
             * silence) carries the shape's identity into the group. */
            role="group"
            aria-label={`Actions for ${shape.name ? `"${shape.name.slice(0, 16)}"` : shape.note ? `"${shape.note.slice(0, 16)}"` : `shape ${shapesRef.current.indexOf(shape) + 1}`}`}
            style={{
              position: 'fixed',
              left: mx,
              top: my,
              width: MENU_W,
              zIndex: 3500,
              background: 'var(--naksha-glass-strong, rgba(26, 22, 17, 0.92))', /* Task 95 — elevated menu rides strong glass */
              border: '1px solid var(--naksha-border-2)',
              borderRadius: 8,
              padding: '4px',
              boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
            }}
            onMouseLeave={() => setMenu(null)}
          >
            <div style={{ color: 'var(--naksha-text-4)', fontSize: 'var(--naksha-fs-xs)', padding: '3px 6px 4px' }}>
              {shape.name ? shape.name.slice(0, 16) : shape.note ? shape.note.slice(0, 16) : `shape ${shapesRef.current.indexOf(shape) + 1}`}
            </div>
            {items.map((it) => (
              <button
                key={it.label}
                onClick={() => { setMenu(null); it.run(); }}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 8,
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 4,
                  color: 'var(--naksha-text-2)',
                  fontFamily: 'inherit',
                  fontSize: 'var(--naksha-fs-xs)',
                  padding: '5px 6px',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'color-mix(in srgb, var(--naksha-gold) 10%, transparent)';
                  e.currentTarget.style.color = 'var(--naksha-gold-light)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--naksha-text-2)';
                }}
                title={it.hint}
              >
                <span style={{ color: 'var(--naksha-gold)' }}>{it.label}</span>
                <span style={{ color: 'var(--naksha-text-4)', fontSize: 'var(--naksha-fs-xs)' }}>{it.hint}</span>
              </button>
            ))}
          </div>
        );
      })()}

      {/* Attach-to-existing-node picker (fuzzy, all networks). Radix portals
          to <body>, so it stacks above the workspace overlay; Esc closes it
          without exiting the workspace (the Esc handler gates on pickerOpen). */}
      <NodeQuickJump
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        pickMode
        onPick={handleAttachPick}
        pickTitle={pickerModeRef.current === 'child' ? 'Create Under Node' : 'Attach to Node'}
        pickDescription={
          pickerModeRef.current === 'child'
            ? 'Pick the PARENT — a new node (named by the shape) is created beneath it, pinned at the shape\u2019s real-world position.'
            : undefined
        }
      />
    </div>
  );
}

/** Point-in-polygon test (ray casting) */
function pointInPolygon(x: number, y: number, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Re-emit any hex/rgb color string with a specific alpha (theme dot colors). */
function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const rgba = c.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => p.trim());
    return `rgba(${parts[0] || '0'}, ${parts[1] || '0'}, ${parts[2] || '0'}, ${alpha})`;
  }
  let h = c.replace('#', '');
  if (h.length === 3) {
    h = h.split('').map((ch) => ch + ch).join('');
  }
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default Workspace;
