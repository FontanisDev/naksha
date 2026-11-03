'use client';

/**
 * Naksha — CareSpaceForceGraph
 *
 * A force-directed note-map view (like Trilium Next's note-map).
 * Nodes are circles sized by note count; Task 43 — colored by the
 * node's first tag (provenance tint), falling back to the network
 * color. Links are directional arrows with subtle glow.
 *
 * Uses `force-graph` (vasturiano) — the same library Trilium uses.
 * Toggle between tree view and force-graph view via a header button.
 *
 * Performance: single canvas via force-graph, lazy-loaded on first render.
 * DPR handled by force-graph internally.
 */

import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from 'react';
import { CareSpace } from '@/lib/naksha/carespace';
import { useNaksha } from '@/lib/naksha/store';
import { CommandRunner } from '@/lib/naksha/commands';
import { MapEngine } from '@/lib/naksha/map-engine';
import { TAG_COLORS, TAG_PALETTE } from '@/lib/naksha/constants';
import { accentPurple, canvasInk } from '@/lib/naksha/themes';
import type { CareNode, CareNetwork, NodeTag } from '@/lib/naksha/types';
import type { UndoEntry } from '@/lib/naksha/types';

interface GraphNode {
  id: string;
  label: string;
  notes: number;
  hasLocation: boolean;
  color: string;
  networkIdx: number;
  val: number; // size value
  /* Task 51 — the node's FIRST tag color, when tagged (undefined when
   * untagged). The label wears it so the graph joins the terminal
   * bullets and map markers in the tag-tint color story. */
  tagColor?: string;
  /* Task 73 — the tag NAME itself (first tag, undefined when untagged).
   * The cluster force groups by NAME, not by color: two different tags
   * share a palette slot less often than colors collide, and the anchor
   * assignment must be one-per-tag to read as clusters. */
  tag?: string;
  /* Task 44 — All-networks focus: nodes outside the current river carry a
   * precomputed dim fill (same hue, 35% alpha) so the current river reads
   * first without hiding the rest. Precomputed at build time — the render
   * loop never mixes colors per frame. */
  dimColor?: string;
  /* Task 44 — graph → map bridge payload (lat/lng resolved at build time so
   * the right-click handler does zero lookups). */
  flyLat?: number;
  flyLng?: number;
  /* Runtime props added by force-graph */
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  /* Task 73 — simulation velocities, written by the cluster force
   * (d3-force's velocity-add contract) and read by the engine's
   * integrator. Same lifecycle class as x/y — runtime-only. */
  vx?: number;
  vy?: number;
}

interface GraphLink {
  source: string;
  target: string;
  /** 'tree' = hierarchy (parent→child), 'custom' = non-hierarchical link. */
  kind: 'tree' | 'custom';
  /** Optional relation label (`link A to B as "..."`) — drawn on the edge. */
  label?: string;
  /** Task 44 — true when both endpoints live outside the current river
   *  (All-networks mode): the edge renders fainter, focus without hiding. */
  dim?: boolean;
}

/* Task 54 — shared offscreen 2d context for measuring the label width at
   click time (the ▤ glyph's hit box anchors to the label's tail). One
   measureText per click — nothing at rest. */
const glyphMeasureCtx =
  typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;

/* Task 58 — ONE counted glyph for BOTH the painter and the hit-test:
 * bare ▤ (one note) → ▤N (two to nine) → ▤9+ (capped — a 40-note
 * thought must not turn its label tail into a spreadsheet column).
 * The terminal rows speak the same dialect (notesMark in commands). */
function notesGlyph(notes: number): string {
  return notes > 9 ? '▤9+' : notes > 1 ? `▤${notes}` : '▤';
}

/* Task 74 — the cluster's ONE ring constant: the force pulls toward it,
   the legend paints it. Two readers, one number — the painted guide
   can never drift from the actual pull. */
const CLUSTER_RING = 110;

/* Task 74 — ONE tag→petal assignment for BOTH cluster readers (the d3
   force and the anchor-ring legend): unique tags, SORTED alphabetically
   → deterministic petals that never shuffle when the data re-orders.
   The legend paints exactly the anchors the force pulls toward — two
   readers of one algorithm, or the guide would lie about the pull. */
function clusterTagOrder(nodes: Array<{ tag?: string }>): string[] {
  const seen = new Set<string>();
  for (const n of nodes) if (n.tag) seen.add(n.tag);
  return [...seen].sort();
}

interface CareSpaceForceGraphProps {
  onToggleView: () => void;
  viewMode: 'tree' | 'graph';
}

export function CareSpaceForceGraph({ onToggleView, viewMode }: CareSpaceForceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<{ destroy?: () => void; _destructor?: () => void; graphData: (d: unknown) => void } | null>(null);
  const careRevision = useNaksha((s) => s.careRevision);
  const currentNetworkName = useNaksha((s) => s.currentNetworkName);
  const breadcrumb = useNaksha((s) => s.breadcrumb);
  const careStats = useNaksha((s) => s.careStats);
  /* Task 50 — the SAME arrival signal the panel ring and tree flash
   * ride: a ⇥ deep link landing while graph view is up pulses the
   * landed NODE here (the graph's side of "both landing surfaces
   * announce it"). */
  const detailsFlashTs = useNaksha((s) => s.detailsFlashTs);
  /* Task 91 — the violet halo rides the theme: the accent is resolved
     per theme (canvas can't read CSS vars) and parked in a ref the
     nodeCanvasObject painter reads — one string lookup per theme
     change, never per frame. */
  const themeId = useNaksha((s) => s.settings.themeId);
  const accentPurpleRef = useRef(accentPurple());
  /* Task 94 — the label ink rides the theme too: same ref + same redraw
     kick as the violet halo above, one cached resolve per theme change. */
  const inkRef = useRef(canvasInk());
  useEffect(() => {
    accentPurpleRef.current = accentPurple();
    inkRef.current = canvasInk();
    /* Kick one redraw burst so stale pixels re-ink in the new hue —
       the arrival-pulse shape: unpause, one frame, back to rest. */
    const g = fgRef.current as unknown as { autoPauseRedraw?: (enable?: boolean) => unknown } | null;
    if (!g) return;
    g.autoPauseRedraw?.(false);
    const raf = requestAnimationFrame(() => g.autoPauseRedraw?.(true));
    return () => {
      cancelAnimationFrame(raf);
      g.autoPauseRedraw?.(true);
    };
  }, [themeId]);
  const [showAllNetworks, setShowAllNetworks] = useState(false);
  /* Task 73 — Trilium's color-cluster mode, dialect-ported: same-tag
   * thoughts gather toward shared anchors. A toggle, not a law — the
   * plain gravity layout stays the default. */
  const [clusterMode, setClusterMode] = useState(false);
  /* Latest node/link lists — read by the drag-end hit test (which nodes are
   * under the dropped pointer) and by the hover highlighter (which links
   * connect to the hovered node). Refs, never state: zero re-renders. */
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  /* Perf — Effect 2's change detector. A structural+presentation
   * signature of the last graphData push and the fg instance it was
   * pushed to. Selection-only careRevision bumps rebuild byte-identical
   * node/link sets; without this check each one re-heated the d3
   * simulation (alpha=1, up to 15s of ticks) and re-randomized layout.
   * When the structure DID change, previous positions are carried over
   * by id so the layout settles from where it was instead of from noise. */
  const lastGraphSigRef = useRef<string | null>(null);
  const lastFgRef = useRef<unknown>(null);
  const hoverIdRef = useRef<string | null>(null);
  /** id of the node being dragged — suppresses hover-reparent while dragging. */
  const draggingIdRef = useRef<string | null>(null);
  /** Undo snapshot taken at dragStart, committed only if the reparent lands. */
  const reparentUndoRef = useRef<UndoEntry | null>(null);
  /* Task 72 — the find box: Trilium's note-map lets you TYPE at the map
   * and watch matches stay lit while everything else recedes to ghosts.
   * The query rides a REF (the painter reads it per frame — zero React
   * re-renders); only the match count rides state (the header is cheap
   * DOM). Empty query = the graph paints exactly as before. */
  const [findQuery, setFindQuery] = useState('');
  const findQueryRef = useRef('');
  const [findCount, setFindCount] = useState<number | null>(null);
  const findLastTypeRef = useRef(0);
  const findRafRef = useRef(0);
  /* Task 73 — the find becomes a FINDER: matches precompute into a Set
   * of graph ids at applyFind time (labels, or note BODIES under the
   * `notes:` prefix), so the painter pays one Set.has per node per frame
   * — cheaper than the string scan it replaces. The cursor rides state
   * (the counter span re-renders to say 2/5); Enter walks it. */
  const findMatchesRef = useRef<Set<string> | null>(null);
  const [findCursor, setFindCursor] = useState(-1);
  /* Task 75 — the query surface made DISCOVERABLE: the distinct first-tags
   * in the rendered graph, each a clickable chip under the find box.
   * Task 74's `tag:` clause lived in a title attribute — nobody finds a
   * dialect there. The chips ARE the clause: one click fills `tag:<name>`
   * (and lights the chip), a second click releases it. Recomputed ONLY on
   * data rebuilds (Effect 2) — never per frame, zero canvas cost. */
  const [tagChips, setTagChips] = useState<Array<{ tag: string; count: number }>>([]);
  /* Task 78 — the fix verb's two transient surfaces, both anchored to the
   * chip row: a 3s undo toast (the receipt leaves the terminal for the
   * surface that caused it — click it and the fix reverts in place) and
   * the inline palette picker (the assign direction's prompt-wall, down:
   * a styled input with the six colors as a datalist, not window.prompt). */
  const [fixToast, setFixToast] = useState<{ label: string; snapshot: string; ts: number } | null>(null);
  const [fixPicker, setFixPicker] = useState<{ nodeId: string; label: string } | null>(null);

  /** zoomToFit but capped — with 1–2 nodes the fit would zoom in absurdly
   *  close and the single circle would fill the whole pane. */
  const fitCapped = useCallback((fg: unknown, ms = 400, pad = 40) => {
    try {
      const g = fg as { zoomToFit: (ms: number, pad: number) => void; zoom: (z: number, ms?: number) => number; k?: number };
      g.zoomToFit(ms, pad);
      // Read the post-fit scale via zoom() getter, then clamp.
      const k = (g as unknown as { zoom: () => number }).zoom?.() ?? 1;
      if (k > 1.8) (g as unknown as { zoom: (z: number, ms?: number) => void }).zoom(1.8, ms);
    } catch {
      /* ignore */
    }
  }, []);

  /* Task 73 — the cluster force reads the toggle through a ref so the
   * mount-once init effect (Effect 1) can re-register it on instance
   * recreation without re-running on every toggle. */
  const clusterModeRef = useRef(false);
  clusterModeRef.current = clusterMode;

  /** Task 73 — tag-cluster force: nodes of one tag are pulled GENTLY
   * toward a per-tag anchor on a ring around the center (tags sorted
   * alphabetically → deterministic petal assignment). Untagged nodes
   * keep their place in the middle — gravity is theirs. The pull is
   * weak enough to bend the tree layout, not break it: parent/child
   * links stay legible inside each petal.
   * d3-force contract: the force exposes initialize(nodes) and reads
   * the simulation's OWN node array — always fresh after a graphData
   * swap, zero lookups through React or refs.
   * CPU: O(n) per tick DURING the cooldown only (same class as the
   * charge force); autoPauseRedraw + cooldownTicks caps keep the
   * steady state at exactly zero, perf-low included. */
  const makeClusterForce = useCallback(() => {
    const PULL = 0.055;
    let simNodes: GraphNode[] = [];
    const force = (alpha: number) => {
      if (!simNodes.length) return;
      /* Task 74 — petal assignment via the SHARED clusterTagOrder (sorted,
       * deterministic): same algorithm the legend painter reads, so the
       * painted anchors are the anchors. Buckets stay in encounter order;
       * the sorted tag list drives the angles. */
      const tags = clusterTagOrder(simNodes);
      if (tags.length === 0) return;
      const buckets = new Map<string, GraphNode[]>();
      for (const n of simNodes) {
        if (!n.tag) continue;
        const arr = buckets.get(n.tag);
        if (arr) arr.push(n);
        else buckets.set(n.tag, [n]);
      }
      const step = (Math.PI * 2) / tags.length;
      let i = 0;
      for (const tag of tags) {
        const arr = buckets.get(tag);
        if (!arr) continue;
        const a = i++ * step - Math.PI / 2;
        const tx = Math.cos(a) * CLUSTER_RING;
        const ty = Math.sin(a) * CLUSTER_RING;
        for (const n of arr) {
          if (n.x == null || n.y == null) continue;
          n.vx = (n.vx ?? 0) + (tx - n.x) * PULL * alpha;
          n.vy = (n.vy ?? 0) + (ty - n.y) * PULL * alpha;
        }
      }
    };
    (force as unknown as { initialize: (nodes: GraphNode[]) => void }).initialize = (nodes) => {
      simNodes = nodes as GraphNode[];
    };
    return force;
  }, []);

  /** Task 73 — register/unregister the cluster force on the live
   * simulation. ON = register + reheat (the layout visibly re-gathers —
   * the point of the toggle) + a delayed re-fit once it settles; OFF =
   * unregister + reheat (the old gravity relaxes back). */
  const applyClusterForce = useCallback(
    (on: boolean) => {
      const fg = fgRef.current as unknown as
        | { d3Force?: (name: string, force?: unknown) => unknown; d3ReheatSimulation?: () => void }
        | null;
      if (!fg?.d3Force) return;
      fg.d3Force('tagCluster', on ? makeClusterForce() : null);
      fg.d3ReheatSimulation?.();
      if (on) {
        setTimeout(() => {
          if (fgRef.current) fitCapped(fgRef.current);
        }, 1400);
      }
    },
    [fitCapped, makeClusterForce],
  );

  /* Task 72 — repaint window while typing: force-graph auto-pauses at
   * rest, so a query change kicks a short rAF burst that re-renders the
   * highlight, then hands the canvas back to auto-pause. CPU cost is a
   * ~350ms burst per typing burst — nothing at rest (the arrival pulse
   * extends the window while it rings). */
  const kickFindRedraw = useCallback(() => {
    const g = fgRef.current as unknown as { autoPauseRedraw?: (enable?: boolean) => unknown } | null;
    const pause = g?.autoPauseRedraw;
    if (!pause) return;
    pause(false);
    findLastTypeRef.current = Date.now();
    if (findRafRef.current) return; // loop already running — it reads the fresh timestamp
    const loop = () => {
      const pulseActive = !!arrivalPulseRef.current && Date.now() < arrivalPulseRef.current.until;
      if (Date.now() - findLastTypeRef.current < 350 || pulseActive) {
        findRafRef.current = requestAnimationFrame(loop);
      } else {
        pause(true);
        findRafRef.current = 0;
      }
    };
    findRafRef.current = requestAnimationFrame(loop);
  }, []);

  /** Task 72 — apply a query: mirror into the painter's ref, count the
   * matches for the header, kick the repaint.
   * Task 73 — two dialects: a bare term matches LABELS (Trilium's
   * floor); `notes:<term>` walks note BODIES through CareSpace (the
   * graph node only carries the count — the bodies resolve here, once
   * per keystroke, never per frame). An empty term (`notes:` alone)
   * goes INERT: the painter keeps the normal graph instead of ghosting
   * everything while the term is still being typed.
   * Task 74 — the two dialects grow into a QUERY SURFACE: the query is
   * whitespace-split into clauses that AND together, so
   * `notes:demo tag:blue` means "bodies mention demo AND first tag is
   * blue-ish". `tag:<term>` matches the first tag's NAME — the very
   * grouping verb ◈ cluster gathers by, so find and cluster now speak
   * the same noun. Cost stays keystroke-time: one pass over nodes ×
   * clauses, the painter still pays one Set.has per node per frame. */
  const applyFind = useCallback(
    (raw: string) => {
      setFindQuery(raw);
      const q = raw.trim().toLowerCase();
      setFindCursor(-1);
      const clauses = q.split(/\s+/).filter(Boolean);
      const parsed = clauses.map((c) =>
        c.startsWith('notes:')
          ? { mode: 'notes' as const, term: c.slice(6).trim() }
          : c.startsWith('tag:')
            ? { mode: 'tag' as const, term: c.slice(4).trim() }
            : { mode: 'label' as const, term: c },
      );
      /* Inert rules — empty query, or ANY clause still half-typed
       * (`tag:` / `notes:` with no term yet): the painter keeps the
       * normal graph instead of ghosting everything mid-keystroke. */
      if (!q || parsed.some((p) => !p.term)) {
        findQueryRef.current = '';
        findMatchesRef.current = null;
        setFindCount(null);
        kickFindRedraw();
        return;
      }
      const matches = new Set<string>();
      for (const n of nodesRef.current) {
        let ok = true;
        for (const p of parsed) {
          if (p.mode === 'label') {
            if (!n.label.toLowerCase().includes(p.term)) {
              ok = false;
              break;
            }
          } else if (p.mode === 'tag') {
            /* Task 76 — `tag:untagged` is the ABSENCE clause: it matches
             * nodes with NO first tag (the untagged majority, finally
             * filterable — and the chip row's hollow-dot chip fills
             * exactly this). A literal tag NAMED "untagged" still wins
             * if it exists — presence beats absence. */
            if (p.term === 'untagged') {
              if (n.tag) {
                ok = false;
                break;
              }
            } else if (!(n.tag ?? '').toLowerCase().includes(p.term)) {
              ok = false;
              break;
            }
          } else {
            const [idxStr, nodeId] = n.id.split(':');
            const care = CareSpace.networks()[parseInt(idxStr, 10)]?.nodes[nodeId];
            if (!(care && care.notes.some((nt) => nt.text.toLowerCase().includes(p.term)))) {
              ok = false;
              break;
            }
          }
        }
        if (ok) matches.add(n.id);
      }
      findQueryRef.current = q;
      findMatchesRef.current = matches;
      setFindCount(matches.size);
      kickFindRedraw();
    },
    [kickFindRedraw],
  );

  /** Task 72 — Enter on the find box: center + zoom + arrival pulse on
   * the first match (the graph's own ⇥ arrival, one keystroke).
   * Task 73 — Enter CYCLES: the first Enter focuses match #1, each
   * further Enter walks to the next (wrapping) — Trilium's next-match
   * verb, and the only sane answer to `notes:` hits whose labels give
   * no hint they matched. The counter reads k/N while cycling. */
  const focusFirstFind = useCallback(() => {
    const matches = findMatchesRef.current;
    if (!matches || matches.size === 0) return;
    const order = nodesRef.current.filter((n) => matches.has(n.id));
    if (order.length === 0) return;
    const next = (findCursor + 1) % order.length;
    const hit = order[next];
    const fg = fgRef.current as unknown as
      | { centerAt?: (x: number, y: number, ms?: number) => void; zoom?: (z: number, ms?: number) => number }
      | null;
    if (hit && fg?.centerAt && hit.x != null && hit.y != null) {
      setFindCursor(next);
      fg.centerAt(hit.x, hit.y, 500);
      fg.zoom?.(1.6, 500);
      arrivalPulseRef.current = { id: hit.id, until: Date.now() + 900 };
      kickFindRedraw();
    }
  }, [findCursor, kickFindRedraw]);

  /** Task 75 — chip click: fill or release the `tag:<name>` clause in the
   *  query. Other clauses (typed label terms, notes:) survive — chips
   *  COMPOSE with typed text, the same AND grammar applyFind speaks. A
   *  second tag chip REPLACES the first (the tag clause is singular by
   *  design — one cluster noun at a time). */
  const toggleTagClause = useCallback(
    (tag: string) => {
      const clause = `tag:${tag}`;
      const clauses = findQuery.trim().split(/\s+/).filter(Boolean);
      const has = clauses.includes(clause);
      const next = (has
        ? clauses.filter((c) => c !== clause)
        : [...clauses.filter((c) => !c.startsWith('tag:')), clause]
      ).join(' ');
      applyFind(next);
    },
    [findQuery, applyFind],
  );

  /* Task 78 — the fix verb's shared tail: snapshot → setTag → setUndo →
   * receipt → 3s toast → syncCare → query re-run. Both directions (untag
   * and tag-assign) land here — one spelling of "confirmed on the
   * surface", the undo slot holding exactly what the toast offers. */
  const completeFix = useCallback(
    (w: { id: string; label: string }, next: NodeTag | 'none', verb: string) => {
      const snapshot = JSON.parse(JSON.stringify(CareSpace.data));
      CareSpace.setTag(w.id, next);
      const s = useNaksha.getState();
      /* Task 79 — ONE timestamp for both doors. Two Date.now() calls were
       * a timing lottery: when the clock ticked between them the toast's
       * ts missed the slot's, and its undo door refused a fix that WAS
       * the history's head ("history moved on" for a history that
       * hadn't). The snapshot IS the identity — shared, not re-rolled. */
      const ts = Date.now();
      s.setUndo({ kind: 'care', label: verb, snapshot, ts });
      s.print(`${verb} · undo available`, 'success');
      setFixToast({ label: verb, snapshot: JSON.stringify(snapshot), ts });
      s.syncCare(); // chips + graph rebuild (careRevision)
      applyFind(findQuery); // the active query re-runs against the new truth
    },
    [applyFind, findQuery],
  );

  /* Task 77 — SHIFT-click a chip = the FIX verb (filter → fix, one
   * surface). A tag chip with exactly one wearer REMOVES that tag; the
   * untagged chip with exactly one orphan mounts the INLINE palette
   * picker (Task 78 — the window.prompt wall came down). Any other
   * count refuses by receipt — mass mutations belong to the details
   * panel, not a mis-click. Same undo snapshot + syncCare contract
   * every CareSpace verb speaks, and the live query re-runs against
   * the new truth (a filtered chip that just lost its wearer shows 0
   * matches — the surface confirms the fix). */
  const shiftFixChip = useCallback(
    (tag: string) => {
      /* Exact wearers among the RENDERED nodes — nodesRef is exactly the
       * set the chip's count counted (network scope included). */
      const wearers: Array<{ id: string; label: string }> = [];
      for (const n of nodesRef.current) {
        const [idxStr, nodeId] = n.id.split(':');
        const care = CareSpace.networks()[parseInt(idxStr, 10)]?.nodes[nodeId];
        if (!care) continue;
        const first = care.tags.find((t) => t && t !== 'none');
        if (tag === 'untagged' ? !first : first === tag) wearers.push({ id: nodeId, label: care.label });
      }
      if (wearers.length !== 1) {
        useNaksha.getState().print(
          tag === 'untagged'
            ? `⇧chip fixes ONE thought — ${wearers.length} are untagged here`
            : `⇧chip fixes ONE thought — ${wearers.length} wear ${tag} here`,
          'muted',
        );
        return;
      }
      const w = wearers[0];
      if (tag === 'untagged') {
        /* The assign direction asks for a color ON THE SURFACE now — no
         * native prompt, no lost keystrokes; Esc/click-away cancels. */
        setFixPicker({ nodeId: w.id, label: w.label });
        return;
      }
      completeFix(w, 'none', `untagged "${w.label}" — ${tag} removed`);
    },
    [completeFix],
  );

  /* Task 78 — the picker's Enter: palette-validated, then the same
   * completeFix contract the untag direction rides. Invalid input keeps
   * the picker open (the fix hasn't happened — nothing to undo). */
  const commitFixPicker = useCallback(
    (raw: string) => {
      if (!fixPicker) return;
      const pick = raw.trim().toLowerCase() as NodeTag;
      if (!TAG_PALETTE.includes(pick)) {
        useNaksha
          .getState()
          .print(`unknown tag "${raw.trim()}" — palette: red orange yellow green blue purple`, 'muted');
        return;
      }
      const w = { id: fixPicker.nodeId, label: fixPicker.label };
      setFixPicker(null);
      completeFix(w, pick, `tagged "${w.label}" ${pick}`);
    },
    [fixPicker, completeFix],
  );

  /* Task 78 — the toast's undo door: the SAME consume contract the
   * terminal verb speaks (restore → save → receipt → syncCare → slot
   * cleared). If the slot moved on (a newer destructive action took
   * it), the door refuses — the toast's snapshot is no longer the
   * history's head, and pretending otherwise would fork the undo
   * story into two truths. */
  const undoFixToast = useCallback(() => {
    if (!fixToast) return;
    const s = useNaksha.getState();
    setFixToast(null);
    if (s.undoStack[0]?.ts !== fixToast.ts) {
      s.print('that fix is no longer the undo slot — history moved on', 'muted');
      return;
    }
    /* Task 81 — the toast's undo feeds the redo twin too: the state it
     * overwrites parks as the redo head, so ⇧⌘Z re-applies the fix.
     * One history, three doors (toast · verb · keyboard), one truth. */
    s.pushRedo({ kind: 'care', label: fixToast.label, snapshot: JSON.parse(JSON.stringify(CareSpace.data)), ts: Date.now() });
    CareSpace.data = JSON.parse(fixToast.snapshot);
    CareSpace.save();
    s.print(`Undone: ${fixToast.label}`, 'success', {
      chips: [{ cmd: 'redo', label: '⇧⌘Z redo', title: `run: redo — re-applies "${fixToast.label}"` }],
    });
    s.syncCare();
    s.dropUndoHead(); // the head IS this toast — consumed by use (Task 88: the stack's walk step)
    applyFind(findQuery);
  }, [fixToast, applyFind, findQuery]);

  /* Task 78 — the toast is a 3s lease, not a fixture. */
  useEffect(() => {
    if (!fixToast) return;
    const t = setTimeout(() => setFixToast(null), 3000);
    return () => clearTimeout(t);
  }, [fixToast]);

  /* Task 79 — the palette, ordered by what the network WEARS: colors
   * already in use first (most wearers first, palette order breaks
   * ties), unworn colors after in palette order. Rarely does a thought
   * need a color no sibling wears — so the suggestions teach the
   * graph's own habits instead of a raw rainbow. One array feeds BOTH
   * doors (the datalist the keyboard cycles and the <details> the
   * pointer clicks), so the two can never disagree. Counts come from
   * CareSpace directly (fresh truth, same source shiftFixChip walks).
   * Computed only while the picker is open — zero cost otherwise. */
  const paletteChoices = useMemo(() => {
    if (!fixPicker) return [];
    const nets = CareSpace.networks();
    const scope = showAllNetworks ? nets : [nets[CareSpace.data.currentNetworkIndex]];
    const counts = new Map<string, number>();
    for (const net of scope) {
      if (!net) continue;
      for (const node of Object.values(net.nodes)) {
        const first = node.tags.find((t) => t && t !== 'none');
        if (first) counts.set(first, (counts.get(first) ?? 0) + 1);
      }
    }
    const worn = TAG_PALETTE.filter((t) => counts.has(t)).sort(
      (a, b) =>
        (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || TAG_PALETTE.indexOf(a) - TAG_PALETTE.indexOf(b),
    );
    const bare = TAG_PALETTE.filter((t) => !counts.has(t));
    return [...worn, ...bare].map((t) => ({ tag: t, count: counts.get(t) ?? 0 }));
  }, [fixPicker, careRevision, showAllNetworks]);

  /* Task 80 — the DOMINANT color leads the pick list visually: the
   * most-worn tag is the row the graph most likely wants, so it wears
   * a gold frame the moment the picker opens. Zero cost — it's the
   * head of the already-sorted array (null when nothing is worn). */
  const dominantTag = paletteChoices[0]?.count ? paletteChoices[0].tag : null;

  /* Task 82 — the pre-fill: the input opens one keystroke ahead with
   * the dominant as its starting value (Enter confirms, typing
   * replaces). UNLESS this thought already wears the dominant — Enter
   * would then re-apply a no-op and print a receipt about nothing;
   * the field stays empty and honest instead. */
  const prefillTag =
    dominantTag &&
    CareSpace.getNode(fixPicker?.nodeId ?? '')?.tags.find((t) => t && t !== 'none') !== dominantTag
      ? dominantTag
      : '';

  /* Task 84 — name the tie: the dominant is palette order among equals
   * when several colors share the top count, and a hand deserves to
   * know the frame's choice was a convention, not a consensus. Zero
   * cost — one filter over the already-sorted array, only while the
   * picker is open. */
  const dominantTie =
    dominantTag && paletteChoices[0].count > 0
      ? paletteChoices.filter((p) => p.count === paletteChoices[0].count).length
      : 0;

  /* Task 72 — the find rAF loop must not outlive the component. */
  useEffect(
    () => () => {
      if (findRafRef.current) cancelAnimationFrame(findRafRef.current);
    },
    [],
  );

  /* Phase 5 — the broken-note probe result rides the store; subscribing
   * to its revision makes the graph rebuild when a bound file appears,
   * disappears, or comes back (rust ⇄ tag color, one color story). */
  const careVaultRev = useNaksha((s) => s.careVaultRevision);

  const buildGraphData = useCallback(() => {
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];
    const nets = CareSpace.networks();
    const netsToRender = showAllNetworks ? nets : [nets[CareSpace.data.currentNetworkIndex]];

    for (const net of netsToRender) {
      const netIdx = nets.indexOf(net);
      const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null);
      if (!rootId) continue;

      /* Task 44 — in All-networks mode the CURRENT river renders full
         * strength; every other river is dimmed (focus without hiding). */
      const isCurrentNet = netIdx === CareSpace.data.currentNetworkIndex;
      const walk = (node: CareNode) => {
        /* Task 43 — provenance parity: a tagged node wears its first tag's
         * color in the graph, exactly as its map marker does (Task 37).
         * Untagged nodes keep the network color. The sketch → tag →
         * marker → ghost → magnet chain now extends to the note-map too:
         * one color story across every view of the same thought.
         * Phase 5 — a bound thought whose FILE IS MISSING wears rust:
         * broken beats tagged for attention (no invented content in any
         * view; the graph must tell the truth too). */
        const firstTag = node.tags.filter((t) => t && t !== 'none')[0];
        const broken = node.vaultPath
          ? useNaksha.getState().careVaultMissing[node.vaultPath] === true
          : false;
        const color = broken
          ? '#e27a5f'
          : (firstTag && TAG_COLORS[firstTag]) || net.color;
        nodes.push({
          id: `${netIdx}:${node.id}`,
          label: node.label,
          notes: node.notes.length,
          hasLocation: !!node.location,
          color,
          tagColor: firstTag ? TAG_COLORS[firstTag] : undefined,
          tag: firstTag || undefined,
          dimColor: isCurrentNet ? undefined : hexWithAlpha(color, 0.35),
          flyLat: node.location?.lat,
          flyLng: node.location?.lng,
          networkIdx: netIdx,
          val: Math.max(2, Math.log2(node.notes.length + 1) * 3 + 2),
        });
        for (const cid of node.children) {
          const child = net.nodes[cid];
          if (!child) continue;
          links.push({ source: `${netIdx}:${node.id}`, target: `${netIdx}:${cid}`, kind: 'tree', dim: !isCurrentNet || undefined });
          walk(child);
        }
        /* Custom (non-hierarchical) links — drawn dashed in the graph, and
           deduped so A→B and B→A render once (same rule as the tree view).
           Optional relation labels resolve from EITHER side of the pair. */
        for (const otherId of node.links) {
          if (!net.nodes[otherId]) continue;
          if (node.id >= otherId) continue; // each pair once
          links.push({
            source: `${netIdx}:${node.id}`,
            target: `${netIdx}:${otherId}`,
            kind: 'custom',
            label: node.linkLabels?.[otherId] ?? net.nodes[otherId].linkLabels?.[node.id],
            dim: !isCurrentNet || undefined,
          });
        }
      };

      walk(net.nodes[rootId]);
    }

    return { nodes, links };
  }, [showAllNetworks, careVaultRev]);

  /** Is `link` attached to the currently-hovered node? Used to brighten the
   *  hovered node's edges — a hover-only repaint, so the cost is zero at rest. */
  const linkTouchesHover = useCallback((l: GraphLink): boolean => {
    const hover = hoverIdRef.current;
    if (!hover) return false;
    const sid = typeof l.source === 'string' ? l.source : (l.source as unknown as { id: string }).id;
    const tid = typeof l.target === 'string' ? l.target : (l.target as unknown as { id: string }).id;
    return sid === hover || tid === hover;
  }, []);

  /** GRAPH REPARENT — drop a dragged node onto another node to move it (and
   *  its whole subtree) under that node, even across networks. Hit-test runs
   *  in GRAPH space (÷ zoom → constant screen-pixel radius): force-graph's
   *  graph2ScreenCoords drifts when its internal transform is stale, but raw
   *  node.x/y are always authoritative. */
  const reparentOnDrop = useCallback((dragged: GraphNode) => {
    const fg = fgRef.current as unknown as {
      zoom?: () => number;
    } | null;
    if (!fg || dragged.x == null || dragged.y == null) return;
    const k = typeof fg.zoom === 'function' ? fg.zoom() : 1;
    const thresh = 20 / Math.max(k, 0.0001);

    // Nearest OTHER node to the drop point, in graph space.
    let target: GraphNode | null = null;
    let bestD = thresh;
    for (const other of nodesRef.current) {
      if (other.id === dragged.id || other.x == null || other.y == null) continue;
      const d = Math.hypot(other.x - dragged.x, other.y - dragged.y);
      if (d < bestD) {
        bestD = d;
        target = other;
      }
    }
    if (!target) return;

    const [fromIdxStr, fromNodeId] = dragged.id.split(':');
    const [toIdxStr, toNodeId] = target.id.split(':');
    const fromIdx = parseInt(fromIdxStr, 10);
    const toIdx = parseInt(toIdxStr, 10);
    const fromNet = CareSpace.networks()[fromIdx];
    const toNet = CareSpace.networks()[toIdx];
    if (!fromNet?.nodes[fromNodeId] || !toNet?.nodes[toNodeId]) return;

    const r = CareSpace.moveNodeAcross(fromIdx, fromNodeId, toIdx, toNodeId);
    if (r.success) {
      /* Undo parity with `caremove` — snapshot was taken BEFORE the move. */
      useNaksha.getState().setUndo(reparentUndoRef.current);
      reparentUndoRef.current = null;
      const cross = fromIdx !== toIdx;
      useNaksha
        .getState()
        .print(
          cross
            ? `Moved "${dragged.label}" → network "${toNet.name}" under "${target.label}" · subtree carried over — undo available`
            : `Moved "${dragged.label}" under "${target.label}" — undo available`,
          'success',
        );
      useNaksha.getState().syncCare();
    } else {
      useNaksha.getState().print(r.error ?? 'Move failed', 'error');
    }
  }, []);

  // Keep a ref to the latest data builder so the init effect (which runs once)
  // and the update effect always read fresh data without re-creating the graph.
  const buildRef = useRef(buildGraphData);
  buildRef.current = buildGraphData;
  const initialFitDoneRef = useRef(false);
  const roRef = useRef<ResizeObserver | null>(null);
  /* Task 48 — double-click → details: force-graph has no dblclick
   * handler, so two clicks on the SAME node within 350ms are folded
   * into a double-click. Ref lives outside the init effect so it
   * survives re-renders but resets naturally per graph session.
   * Task 50 — `src` tags the timestamp's timeline ('ev' = event
   * dispatch time, 'date' = handler fallback) so the two never mix. */
  const lastNodeClickRef = useRef<{ id: string; ts: number; src: 'ev' | 'date' } | null>(null);
  /* Task 50 — one-shot arrival pulse: the graph node a ⇥ jump landed on,
   * as `{ graphId, until }` (null = idle). The nodeCanvasObject painter
   * reads it and draws the expanding ring; the rAF burst below drives
   * the frames and clears it — nothing at rest, no loop after. */
  const arrivalPulseRef = useRef<{ id: string; until: number } | null>(null);

  /* ── Effect 1: create the force-graph instance ONCE per graph-mode entry ── */
  useEffect(() => {
    if (viewMode !== 'graph') return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    initialFitDoneRef.current = false;

    const init = async () => {
      try {
        // force-graph's types don't export cleanly; use any for the chain.
        const ForceGraphModule = (await import('force-graph')) as any;
        // Kapsule API: ForceGraph()(element) — the factory must be called first
        // to produce the component, which is then mounted on the element.
        const ForceGraph = ForceGraphModule.default as () => (el: HTMLElement) => any;
        if (cancelled || !containerRef.current) return;

        const perfMode = useNaksha.getState().settings.perfMode;

        container.innerHTML = '';

        const fg = ForceGraph()(containerRef.current)
          .graphData(buildRef.current())
          .nodeId('id')
          .nodeLabel((n) => (n as GraphNode).label)
          .nodeVal((n) => (n as GraphNode).val)
          .nodeColor((n) => (n as GraphNode).color)
          .nodeCanvasObject((node, ctx, globalScale) => {
            const n = node as GraphNode;
            /* Task 72 — the find box speaks HERE: a live query dims
             * non-matches to ghosts (8% ink — the graph's shape stays
             * readable, the noise recedes) and lets matches keep
             * everything: full fill, label at ANY zoom (you typed, the
             * label owes you nothing), plus a gold ring. One lowercase
             * compare per node per frame — the same cost class as the
             * hover compare the painter already pays. */
            const searching = !!findQueryRef.current;
            /* Task 73 — membership in the precomputed Set (labels or note
             * bodies — decided ONCE per keystroke in applyFind), not a
             * per-frame string scan. One hash probe per node per frame. */
            const isMatch = searching && !!findMatchesRef.current?.has(n.id);
            // Base radius grows with note count; floored so nodes stay
            // clickable at low zoom. 4px @ zoom1 ≈ Trilium's dot scale.
            const size = Math.max(4, (n.val ?? 2) / 2);
            /* Task 44 — All-networks focus: non-current rivers render at
             * 35% alpha (precomputed), current river full strength. The
             * circle IS the dim state — no extra paint pass, same arc. */
            const fill = searching && !isMatch ? hexWithAlpha(n.color, 0.08) : (n.dimColor ?? n.color);
            const dim = !!n.dimColor;
            ctx.beginPath();
            ctx.arc(n.x!, n.y!, size, 0, Math.PI * 2);
            ctx.fillStyle = fill;
            ctx.fill();

            // Crisp rim — reads well on both dark and light themes
            ctx.lineWidth = 1;
            ctx.strokeStyle = searching && !isMatch ? 'rgba(0, 0, 0, 0.15)' : dim ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.35)';
            ctx.stroke();

            /* Task 35 — located-node ring: nodes pinned to the real world
               wear a faint violet halo, echoing the map's thought-marker
               layer. The graph shows at a glance WHICH thoughts have a
               place. Static paint per frame, two arcs — perf-low safe.
               Task 72 — ghosts skip the halo: a receded node shouldn't
               keep spending ink on rings. */
            if (n.hasLocation && !(searching && !isMatch)) {
              ctx.beginPath();
              ctx.arc(n.x!, n.y!, size + 2.5, 0, Math.PI * 2);
              ctx.setLineDash([1.5, 1.5]);
              const accent = accentPurpleRef.current;
              ctx.strokeStyle = dim ? hexWithAlpha(accent, 0.28) : hexWithAlpha(accent, 0.65);
              ctx.lineWidth = 1;
              ctx.stroke();
              ctx.setLineDash([]);
            }

            // Hover ring + drop-target cue while dragging another node onto
            // this one — pure canvas, only paid during hover/drag frames.
            // Task 115 — the accent CUES ride the theme's gold now (same
            // alpha/weight, the theme's own hue): with the whole graph's
            // accent chrome themed, a frozen amber ring would be the lone
            // amber on non-amber themes — a stray, not a voice.
            if (draggingIdRef.current && draggingIdRef.current !== n.id) {
              ctx.beginPath();
              ctx.arc(n.x!, n.y!, size + 3.5, 0, Math.PI * 2);
              ctx.setLineDash([2, 2]);
              ctx.strokeStyle = hexWithAlpha(inkRef.current.goldLight, 0.75);
              ctx.lineWidth = 1;
              ctx.stroke();
              ctx.setLineDash([]);
            } else if (hoverIdRef.current === n.id) {
              ctx.beginPath();
              ctx.arc(n.x!, n.y!, size + 3, 0, Math.PI * 2);
              ctx.strokeStyle = hexWithAlpha(inkRef.current.goldLight, 0.6);
              ctx.lineWidth = 1;
              ctx.stroke();
            }

            /* Task 72 — the find ring: a match under a live query wears
               the same gold the hover speaks (dashed = the find's own
               voice — it's a STATE, not a cursor). Task 115 — that gold
               is the THEME's gold: the find ring is persistent chrome
               while a query lives, so it rides canvasInk like the rest
               of the state family. */
            if (isMatch) {
              ctx.beginPath();
              ctx.arc(n.x!, n.y!, size + 4, 0, Math.PI * 2);
              ctx.setLineDash([2.5, 2]);
              ctx.strokeStyle = hexWithAlpha(inkRef.current.goldLight, 0.8);
              ctx.lineWidth = 1;
              ctx.stroke();
              ctx.setLineDash([]);
            }

            // Glow for nodes with notes (skipped on dim nodes — focus mode
            // keeps its halo budget for the current river; ghosts skip it
            // too — Task 72).
            if (n.notes > 0 && !dim && !(searching && !isMatch)) {
              ctx.beginPath();
              ctx.arc(n.x!, n.y!, size + 2, 0, Math.PI * 2);
              ctx.fillStyle = hexWithAlpha(n.color, 0.15);
              ctx.fill();
            }

            /* Task 50 — one-shot arrival pulse: an expanding gold ring
               when a ⇥ deep link just landed on this node (same gold as
               the panel ring / tree flash — one arrival, one voice).
               Time-based: the rAF burst above drives frames, this only
               reads a ref + one compare per node per frame — zero cost
               at rest (ref is null). */
            if (arrivalPulseRef.current && arrivalPulseRef.current.id === n.id) {
              const remain = arrivalPulseRef.current.until - Date.now();
              if (remain <= 0) {
                arrivalPulseRef.current = null;
              } else {
                const t = 1 - remain / 900;
                ctx.beginPath();
                ctx.arc(n.x!, n.y!, size + 3 + 14 * t, 0, Math.PI * 2);
                /* Task 115 — the pulse rides the theme gold: the DOM panel
                 * ring it answers (Task 113) already follows the accent,
                 * so graph + panel land in one voice per theme again. */
                ctx.strokeStyle = hexWithAlpha(inkRef.current.goldLight, 0.85 * (1 - t));
                ctx.lineWidth = 2;
                ctx.stroke();
              }
            }

            // Label (only when zoomed in enough; dim rivers need a deeper
            // zoom before their labels earn ink). Task 51 — a tagged node's
            // label wears its tag tint (same precedence the terminal bullet
            // speaks: tag > notes-gold > neutral), so one color story runs
            // through bullets, markers, and now the note-map itself.
            // Task 72 — the find overrides both gates: matches label at
            // ANY zoom; non-matches lose their label entirely (you asked
            // to see what you typed). A matched DIM node also lights —
            // the find crosses rivers by design.
            if (isMatch || (!searching && globalScale > (dim ? 1.15 : 0.8))) {
              ctx.font = `${Math.min(11 / globalScale, 11)}px JetBrains Mono, monospace`;
              /* Task 56 — hover lifts the LABEL too: the same hovered
                 compare the ▤ glyph speaks (computed once, above the
                 fillStyle) also brightens the node's own label —
                 notes-gold steps up to the lit gold, the neutral ink
                 steps to a brighter bone. Tag-tinted labels KEEP their
                 tag color (identity beats hover); dim rivers stay dim
                 (depth hierarchy). One ref read + compares per labeled
                 node per frame — the same cost class Task 55 already
                 paid, no new branches at rest. */
              const hovered = hoverIdRef.current === n.id;
              /* Task 94 — the resting label ink rides the theme (amber
                 literals were amber-night's text-2/text-3 frozen; on light
                 papers they washed). Task 117 — the hover LIFTS ride the
                 theme too now: computed in canvasInk() as the resting ink
                 mixed toward the theme's strongest text ink, so the lift
                 brightens on dark papers and deepens on light ones (where
                 "brighter" was the wrong polarity) — and never flashes
                 amber-night's gold on foreign papers. */
              const ink = inkRef.current;
              ctx.fillStyle = !dim || isMatch
                ? n.tagColor
                  ? n.tagColor
                  : n.notes > 0
                    ? hovered
                      ? ink.goldLift
                      : ink.goldLight
                    : hovered
                      ? ink.textLift
                      : ink.text2
                : ink.text3;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              const label = n.label.length > 14 ? `${n.label.slice(0, 12)}…` : n.label;
              ctx.fillText(label, n.x!, n.y! + size + 2);
              /* Task 53 — the ▤ affordance, graph edition: a node with
                 notes draws a small reader glyph at its label's tail —
                 the SAME ▤ the terminal's reader chip speaks, so "this
                 thought has writing" reads BEFORE any click. The verb
                 behind it already exists (double-click = details panel,
                 notes section focused); the glyph makes it discoverable.
                 Static paint: one measure + one fillText per notes-bearing
                 node per frame, skipped on dim rivers — perf-low safe. */
              if (n.notes > 0) {
                const labelW = ctx.measureText(label).width;
                ctx.font = `${Math.min(9 / globalScale, 9)}px JetBrains Mono, monospace`;
                /* Task 55 — hover lights the verb: a notes-bearing node
                 * under the cursor draws the ▤ at full gold (vs the
                 * resting 0.85) — the affordance answers the hover with
                 * "this glyph is live". One alpha compare per frame on
                 * the hovered node only; rest of the graph unchanged.
                 * Task 56 — reuses `hovered` from the label branch.
                 * Task 57 — the glyph COUNTS: ▤2 / ▤3 when the thought
                 * carries more than one note — one string build per
                 * notes-bearing node per frame, same paint cost class;
                 * the click hit-test below measures the same string.
                 * Task 58 — the count caps at ▤9+ (shared builder), and
                 * the painter + hit-test now read ONE function so the
                 * box can never drift from what was drawn. */
                const glyphStr = notesGlyph(n.notes);
                /* Task 115 — the hover lift is the accent at FULL strength
                 * (same hue as the resting glyph, brighter by alpha) — the
                 * frozen #f6cf5a flash would clash with the themed resting
                 * ink on non-amber themes. */
                ctx.fillStyle = hovered ? inkRef.current.goldLight : hexWithAlpha(inkRef.current.goldLight, 0.85);
                ctx.fillText(glyphStr, n.x! + labelW / 2 + 4 / globalScale, n.y! + size + 2);
              }
            }
          })
          /* REPLACE the default big-sphere rendering with our flat circles.
           * Without this, force-graph draws its default node AND our custom
           * object on top (mode 'after'), producing doubled circles. */
          .nodeCanvasObjectMode(() => 'replace')
          /* Task 54 — the pointer area extends BELOW the circle to cover
           * the label + ▤ glyph zone, so a click on the glyph reaches
           * onNodeClick (the onGlyph hit-test there does the rest). Same
           * graph-coord space as the node painter; the zone is sized in
           * screen px via the current zoom so it feels constant at any
           * scale. Static paint per hit-canvas rebuild — no per-frame
           * cost, CPU-safe. */
          .nodePointerAreaPaint((node, color, ctx) => {
            const n = node as GraphNode;
            const size = Math.max(4, (n.val ?? 2) / 2);
            const k = (() => {
              try {
                return (fgRef.current as unknown as { zoom?: () => number })?.zoom?.() ?? 1;
              } catch {
                return 1;
              }
            })();
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x!, n.y!, size + 2, 0, Math.PI * 2);
            ctx.fill();
            /* Height covers the FULL label line: baseline sits at
             * n.y + size + 2 graph units and the text body extends
             * ~11/k further — (size + 16)/k keeps the whole line (and
             * the ▤ at its tail) inside the hit zone at any zoom. */
            ctx.fillRect(n.x! - 75 / k, n.y!, 150 / k, (size + 16) / k);
          })
          .linkColor((l) => {
            const gl = l as GraphLink;
            /* Task 115 — the edge accent family rides the theme: custom
             * links speak the theme's goldLight, tree edges its goldDim
             * (the declared quiet-voice token — the frozen pre-token
             * #d4a017 washed on light papers). Same alphas/weights as
             * the amber they replace; amber-night resolves to its own
             * family, so the default theme reads unchanged in spirit. */
            if (linkTouchesHover(gl)) {
              // Hovered node's edges light up (tree edges get full gold too).
              return gl.kind === 'custom'
                ? hexWithAlpha(inkRef.current.goldLight, 0.9)
                : hexWithAlpha(inkRef.current.goldLight, 0.45);
            }
            if (gl.dim) {
              // Task 44 — dormant-river edges fall back to texture, not noise.
              return gl.kind === 'custom'
                ? hexWithAlpha(inkRef.current.goldLight, 0.18)
                : hexWithAlpha(inkRef.current.goldDim, 0.06);
            }
            return gl.kind === 'custom'
              ? hexWithAlpha(inkRef.current.goldLight, 0.55)
              : hexWithAlpha(inkRef.current.goldDim, 0.15);
          })
          .linkWidth((l) => {
            const gl = l as GraphLink;
            if (linkTouchesHover(gl)) return gl.kind === 'custom' ? 1.6 : 1;
            if (gl.dim) return gl.kind === 'custom' ? 0.8 : 0.4;
            return gl.kind === 'custom' ? 1.2 : 0.5;
          })
          .linkLineDash((l) => ((l as GraphLink).kind === 'custom' ? [4, 3] : null))
          .linkDirectionalArrowLength(3)
          .linkDirectionalArrowRelPos(0.9)
          /* Hover tooltip: only labeled custom links get one (tree edges are
           * visually self-explanatory — skipping their tooltip avoids a DOM
           * layout per hover, which matters on CPU-only machines). */
          .linkLabel((l) => (l as GraphLink).label ?? null)
          /* Edge labels — drawn ON TOP of the default line (mode 'after').
           * Only labeled links paint text; unlabeled ones early-return, so
           * the per-frame cost is O(labeled links). Text size is divided by
           * globalScale to keep a constant on-screen size.
           * Task 62 — z-order note, honestly: force-graph paints the whole
           * link phase (default lines + 'after' custom objects) BEFORE the
           * node phase, so a node painted at the label's midpoint CAN cover
           * its head (seen once in the demo geometry, where Delta sat near
           * the Alpha⇌Beta midpoint). A true fix means either per-frame
           * node-distance checks (CPU cost on the CPU-only machines this
           * app targets) or an overlay canvas (second rAF — same cost).
           * Both violate the perf mandate for a rare cosmetic artifact, so
           * the halo (below) stays the only mitigation. */
          .linkCanvasObjectMode(() => 'after')
          .linkCanvasObject((link, ctx, globalScale) => {
            const l = link as GraphLink & { source: { x?: number; y?: number }; target: { x?: number; y?: number } };
            if (!l.label) return;
            const sx = l.source.x;
            const sy = l.source.y;
            const tx = l.target.x;
            const ty = l.target.y;
            if (sx == null || sy == null || tx == null || ty == null) return;
            if (globalScale < 0.55) return; // too zoomed out — labels are noise
            const mx = (sx + tx) / 2;
            const my = (sy + ty) / 2;
            const fontSize = 9 / globalScale;
            ctx.font = `${fontSize}px JetBrains Mono, monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            const label = l.label.length > 24 ? `${l.label.slice(0, 22)}…` : l.label;
            /* Dark halo behind the text keeps it readable over edges/nodes. */
            ctx.lineWidth = 3 / globalScale;
            ctx.strokeStyle = 'rgba(20, 17, 13, 0.85)';
            ctx.strokeText(label, mx, my - 2 / globalScale);
            /* Task 94 — the custom-link's name plate rides the theme gold
               (it sat over BOTH theme families since light arrived). */
            ctx.fillStyle = inkRef.current.goldLight;
            ctx.fillText(label, mx, my - 2 / globalScale);
          })
          /* Task 74 — the cluster mode earns its LEGEND: while ◈ cluster
             is on, the anchor ring is PAINTED — a faint dashed circle at
             the exact radius the force pulls toward, with a tick dot +
             tag name at each petal anchor (same sorted assignment, same
             CLUSTER_RING — two readers of one algorithm, so the guide
             cannot lie). Screen-space honesty: onRenderFramePre fires
             with the transform reset (DPR only), so the painter applies
             the pan/zoom itself — width/2 − center·k is the same math
             force-graph uses internally. Ink budget: one dashed circle +
             one dot + one text per TAG (never per node), and only while
             frames actually paint (auto-paused rest costs nothing). */
          .onRenderFramePre((ctx: CanvasRenderingContext2D, k: number) => {
            if (!clusterModeRef.current) return;
            const tags = clusterTagOrder(nodesRef.current);
            if (tags.length === 0) return;
            const fgAny = fgRef.current as unknown as {
              centerAt?: () => { x: number; y: number };
              width?: () => number;
              height?: () => number;
            } | null;
            const center = fgAny?.centerAt?.();
            const w = fgAny?.width?.();
            const h = fgAny?.height?.();
            if (!center || typeof center.x !== 'number' || w == null || h == null) return;
            ctx.save();
            ctx.translate(w / 2 - center.x * k, h / 2 - center.y * k);
            ctx.scale(k, k);
            /* the guide ring itself */
            ctx.beginPath();
            ctx.arc(0, 0, CLUSTER_RING, 0, Math.PI * 2);
            ctx.setLineDash([2, 4]);
            /* Task 115 — the legend is persistent chrome while cluster mode
             * lives, so its hairline rides the theme gold too. */
            ctx.strokeStyle = hexWithAlpha(inkRef.current.goldLight, 0.14);
            ctx.lineWidth = 1 / Math.max(k, 0.0001); // hairline at any zoom
            ctx.stroke();
            ctx.setLineDash([]);
            /* per-tag anchors — text only when zoomed enough to read it */
            if (k >= 0.3) {
              const step = (Math.PI * 2) / tags.length;
              ctx.font = `${Math.min(9 / k, 9)}px JetBrains Mono, monospace`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              tags.forEach((tag, i) => {
                const a = i * step - Math.PI / 2;
                const ax = Math.cos(a) * CLUSTER_RING;
                const ay = Math.sin(a) * CLUSTER_RING;
                const col = (TAG_COLORS as Record<string, string | undefined>)[tag] ?? inkRef.current.text2;
                ctx.beginPath();
                ctx.arc(ax, ay, Math.max(1.2, 2.5 / k), 0, Math.PI * 2);
                ctx.fillStyle = hexWithAlpha(col, 0.5);
                ctx.fill();
                const lx = Math.cos(a) * (CLUSTER_RING + 16 / k);
                const ly = Math.sin(a) * (CLUSTER_RING + 16 / k);
                ctx.fillStyle = hexWithAlpha(col, 0.62);
                ctx.fillText(tag.length > 10 ? `${tag.slice(0, 9)}…` : tag, lx, ly);
              });
            }
            ctx.restore();
          })
          .backgroundColor('rgba(0,0,0,0)')
          .onNodeHover((node) => {
            const prev = hoverIdRef.current;
            hoverIdRef.current = node ? (node as GraphNode).id : null;
            /* Task 55 — the extended pointer area (label + ▤ zone) now
             * signals clickability: pointer cursor while over any node
             * region, crosshair-ish default otherwise. Enter/leave only
             * — one style write per transition, nothing per frame. */
            const fgAny = fgRef.current as unknown as {
              canvas?: () => HTMLCanvasElement | null;
              centerAt?: () => { x: number; y: number };
            } | null;
            const cv = (() => {
              try {
                return fgAny?.canvas?.() ?? container?.querySelector('canvas');
              } catch {
                return null;
              }
            })();
            if (cv) cv.style.cursor = node ? 'pointer' : '';
            /* Task 55 — hover must be VISIBLE at rest: autoPauseRedraw
             * skips painting while the engine idles, so a hover
             * transition alone would never light the ring / ▤ glyph on
             * screen. Re-setting the center to its own value flips the
             * engine's one-shot needsRedraw — exactly ONE repaint per
             * enter/leave, nothing per frame, CPU-safe. */
            if (prev !== hoverIdRef.current) {
              try {
                const c = fgAny?.centerAt?.();
                if (c && typeof c.x === 'number') {
                  (fgRef.current as unknown as { centerAt: (x: number, y: number) => void }).centerAt(c.x, c.y);
                }
              } catch {
                /* best-effort */
              }
            }
          })
          /* Task 62 — custom edges are CLICKABLE (click opens the relabel
           * prompt), so hovering one now says so: pointer cursor while over
           * a dashed edge, default otherwise. Enter/leave only — one style
           * write per transition, nothing per frame (the same economy as
           * the node hover; the hover hit-test already runs for the
           * labeled-edge tooltip, so this adds zero per-move cost). Tree
           * edges stay default — structure, not interactive. */
          .onLinkHover((link) => {
            const l = link as GraphLink | null;
            const fgAny = fgRef.current as unknown as {
              canvas?: () => HTMLCanvasElement | null;
            } | null;
            const cv = (() => {
              try {
                return fgAny?.canvas?.() ?? container?.querySelector('canvas');
              } catch {
                return null;
              }
            })();
            if (cv) cv.style.cursor = l && l.kind === 'custom' ? 'pointer' : '';
          })
          /* Click a dashed (custom) edge to rename / clear its relation
           * label — tree edges are structure, not relations, so they stay
           * non-interactive (also keeps misclicks harmless). */
          .onLinkClick((link) => {
            const l = link as GraphLink;
            if (l.kind !== 'custom') return;
            const sid = typeof l.source === 'string' ? l.source : (l.source as unknown as { id: string }).id;
            const tid = typeof l.target === 'string' ? l.target : (l.target as unknown as { id: string }).id;
            const netIdx = parseInt(sid.split(':')[0], 10);
            const net = CareSpace.networks()[netIdx];
            const a = net?.nodes[sid.split(':')[1]];
            const b = net?.nodes[tid.split(':')[1]];
            if (!a || !b) return;
            const current = CareSpace.getLinkLabel(a.id, b.id) ?? '';
            /* Task 63 — the prompt is a BROWSER dialog, invisible to the
             * terminal scrollback: the click announces itself BEFORE the
             * dialog opens, so the transcript shows why focus jumped and
             * which relation is being named (the receipt after OK/Cancel
             * was already spoken — the "why" before it was not). */
            useNaksha
              .getState()
              .print(
                `relabel prompt open — "${a.label} ↔ ${b.label}"${current ? ` · now "${current}"` : ''} · cancel leaves it unchanged`,
                'muted',
              );
            const next = window.prompt(
              `Relation label for "${a.label}" ↔ "${b.label}"\n(empty = clear the label):`,
              current,
            );
            if (next === null) return; // cancelled
            const undo: UndoEntry = {
              kind: 'care',
              label: `relabel ${a.label} ↔ ${b.label}`,
              snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
              ts: Date.now(),
            };
            const r = CareSpace.setLinkLabel(a.id, b.id, next);
            if (r.success) {
              useNaksha.getState().setUndo(undo);
              useNaksha
                .getState()
                .print(
                  next.trim()
                    ? `Relation "${a.label} ↔ ${b.label}" → "${next.trim()}" — undo available`
                    : `Relation label cleared ("${a.label} ↔ ${b.label}") — undo available`,
                  'success',
                );
              useNaksha.getState().syncCare();
            } else {
              useNaksha.getState().print(r.error ?? 'Failed to set label', 'error');
            }
          })
          .onNodeClick((node, ev) => {
            const n = node as GraphNode;
            /* Task 54 — the ▤ glyph is its OWN click target: a click on
             * the label-tail glyph opens the details panel with the
             * notes section focused (the same surface the terminal's ▤
             * reader chip leads to) — instead of just navigating.
             * Detection: one measureText + one graph2ScreenCoords + a
             * ±8px box around the glyph anchor; best-effort, total. The
             * pointer-area paint below is what makes the glyph zone
             * reach the click handler at all. */
            let onGlyph = false;
            try {
              const fgAny = fgRef.current as unknown as {
                graph2ScreenCoords?: (x: number, y: number) => { x: number; y: number };
                zoom?: () => number;
              } | null;
              /* graph2ScreenCoords is CANVAS-relative; the event is
               * page-space — bridge the two with the canvas's live rect
               * (one getBoundingClientRect per click). force-graph nests
               * its canvas inside an internal .force-graph-container div,
               * so the lookup must descend (not :scope >). */
              const canvas = container?.querySelector('canvas') as HTMLCanvasElement | null;
              if (fgAny?.graph2ScreenCoords && glyphMeasureCtx && canvas && typeof ev?.clientX === 'number') {
                const size = Math.max(4, (n.val ?? 2) / 2);
                const k = fgAny.zoom?.() ?? 1;
                glyphMeasureCtx.font = `${Math.min(11 / k, 11)}px JetBrains Mono, monospace`;
                const label = n.label.length > 14 ? `${n.label.slice(0, 12)}…` : n.label;
                const labelW = glyphMeasureCtx.measureText(label).width;
                /* Task 57 — the hit box measures the SAME counted string
                 * the painter draws (▤2 is wider than ▤), at the glyph's
                 * own 9px font, scaled to screen px by the live zoom. The
                 * half-width floors at 8 so a bare ▤ keeps Task 54's
                 * original box. Task 58 — both sites read ONE builder
                 * (notesGlyph), so ▤9+ is measured exactly as drawn. */
                const glyphStr = notesGlyph(n.notes);
                glyphMeasureCtx.font = `${Math.min(9 / k, 9)}px JetBrains Mono, monospace`;
                const glyphW = glyphMeasureCtx.measureText(glyphStr).width;
                const halfW = Math.max(8, (glyphW * k) / 2 + 3);
                const scr = fgAny.graph2ScreenCoords(n.x! + labelW / 2 + 4 / k, n.y! + size + 2);
                const rect = canvas.getBoundingClientRect();
                onGlyph = Math.abs(ev.clientX - (rect.left + scr.x)) <= halfW && Math.abs(ev.clientY - (rect.top + scr.y)) <= 8;
              }
            } catch {
              /* detection is best-effort — fall through to node click */
            }
            /* Task 48 — double-click closes the deep-link loop: the first
             * click navigates (existing behavior), a second click on the
             * SAME node within 350ms opens its details panel — the same
             * "open this thought" the terminal's ⇥ rows perform. One
             * timestamp compare per click, nothing at rest.
             * Task 50 — fold on EVENT time, not handler time: force-graph
             * defers the click emission to a rAF, and each click's own
             * syncCare re-render keeps the main thread busy — on a slow
             * machine the HANDLER can run ~400ms after the user's finger
             * while the two clicks were 150ms apart (observed live:
             * canvas clicks 118ms apart, handler timestamps >350ms). The
             * pointerup event's timeStamp is captured at dispatch, so
             * the window measures the USER's rhythm, not the render
             * queue's. Fallback Date.now() keeps the detector total. */
            const evTs = typeof ev?.timeStamp === 'number' && ev.timeStamp > 0 ? ev.timeStamp : Date.now();
            const isDbl =
              lastNodeClickRef.current !== null &&
              lastNodeClickRef.current.id === n.id &&
              lastNodeClickRef.current.src === (typeof ev?.timeStamp === 'number' && ev.timeStamp > 0 ? 'ev' : 'date') &&
              evTs - lastNodeClickRef.current.ts < 350;
            lastNodeClickRef.current = { id: n.id, ts: evTs, src: typeof ev?.timeStamp === 'number' && ev.timeStamp > 0 ? 'ev' : 'date' };
            // Navigate to this node
            const [netIdxStr, nodeId] = n.id.split(':');
            const netIdx = parseInt(netIdxStr, 10);
            const net = CareSpace.networks()[netIdx];
            if (net && net.nodes[nodeId]) {
              if (netIdx !== CareSpace.data.currentNetworkIndex) {
                CareSpace.switchNetwork(net.name);
              }
              net.currentId = nodeId;
              CareSpace.save();
              useNaksha.getState().syncCare();
              if (onGlyph || isDbl) {
                const s = useNaksha.getState();
                /* Task 49 — the double-click reads as "show me what I
                 * wrote here": when the thought HAS notes, the panel's
                 * arrival focuses (scrolls to + one-shot pulses) the
                 * notes section instead of leaving it below the fold.
                 * The intent flag rides the same deep-link bundle.
                 * Task 54 — the ▤ glyph click takes the same path with
                 * its own receipt, so the affordance the graph draws is
                 * the verb the graph speaks.
                 * Task 57 — the receipt COUNTS: `notes (2)` echoes the
                 * glyph's ▤2 story into the terminal, so the number the
                 * user saw on the map is the number the shell names. */
                const noteCount = net.nodes[nodeId].notes.length;
                s.setDetailsNodeId(
                  nodeId,
                  s.settings.perfMode !== 'low',
                  noteCount > 0,
                );
                s.print(onGlyph ? `▤ details → "${n.label}" · notes${noteCount > 1 ? ` (${noteCount})` : ''}` : `details: ${n.label}`, 'muted');
              } else {
                useNaksha.getState().print(`Navigated to: ${n.label}`, 'info');
              }
            }
          })
          /* Task 44/45 — graph → map bridge: right-click a LOCATED node and
           * the map flies there (with the arrival pulse). Task 45 — for a
           * node in a DORMANT river (dimmed in All-networks mode) the same
           * gesture ALSO switches to that river and navigates to the node:
           * one right-click stands you where the thought lives, in its own
           * river — no separate click-then-switch dance. Unlocated nodes
           * get the pin hint (same text gotonode uses). */
          .onNodeRightClick((node) => {
            const n = node as GraphNode;
            const [netIdxStr, nodeId] = n.id.split(':');
            const netIdx = parseInt(netIdxStr, 10);
            const net = CareSpace.networks()[netIdx];
            if (!net?.nodes[nodeId]) return;
            const crossRiver = netIdx !== CareSpace.data.currentNetworkIndex;
            if (crossRiver) {
              CareSpace.switchNetwork(net.name);
              net.currentId = nodeId;
              CareSpace.save();
              useNaksha.getState().syncCare();
            }
            if (n.flyLat == null || n.flyLng == null) {
              useNaksha
                .getState()
                .print(`"${n.label}" has no location — 'pinnode ${n.label.split(' ')[0]}' pins it at the crosshair`, 'muted');
              /* Task 46 — even an unlocated thought gets its ⇥ row: the
               * tree can still land on it (river + selection), which is
               * often what the user wanted anyway. */
              useNaksha.getState().print(`⇥ tree  "${n.label}" · ${net.name}`, 'output', {
                jump: { nodeId, river: net.name },
              });
              return;
            }
            MapEngine.flyAndPulse(n.flyLat, n.flyLng);
            useNaksha
              .getState()
              .print(
                crossRiver
                  ? `↗ "${n.label}" → map + river "${net.name}" (fly + pulse)`
                  : `↗ "${n.label}" → map (fly + pulse)`,
                'muted',
              );
            /* Task 46 — the receipt now offers the return path: a ⇥ row
             * that lands the CareSpace TREE on this node (the delegated
             * terminal listener handles the click; see TerminalPane).
             * One row, two verbs already on screen: ↗ moves the map,
             * ⇥ moves the tree. */
            useNaksha.getState().print(`⇥ tree  "${n.label}" · ${net.name}`, 'output', {
              jump: { nodeId, river: net.name },
            });
          })
          /* Drag-to-reparent: force-graph pins the node while dragging and
           * releases it on drop; we hit-test what's under the pointer. The
           * undo snapshot is taken at dragStart (cheap, pre-move state). */
          .onNodeDrag((node) => {
            draggingIdRef.current = (node as GraphNode).id;
            reparentUndoRef.current = {
              kind: 'care',
              label: `drag ${((node as GraphNode).label ?? 'node')}`,
              snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
              ts: Date.now(),
            };
          })
          .onNodeDragEnd((node) => {
            const n = node as GraphNode;
            const wasDragging = draggingIdRef.current;
            draggingIdRef.current = null;
            if (wasDragging === n.id) reparentOnDrop(n);
          })
          .onEngineStop(() => {
            // Fit the view once, after the initial layout settles.
            if (!initialFitDoneRef.current) {
              initialFitDoneRef.current = true;
              fitCapped(fg);
            }
          })
          .d3AlphaDecay(0.035)
          .d3VelocityDecay(0.15);

        /* Task 110 — the library's injected canvas is bare in the a11y
         * tree (its only voice was the nodeLabel hover tooltip — a
         * pointer-only readout, the workspace lesson again). Name it
         * the moment it exists: the factory mounted synchronously into
         * the innerHTML-cleared container, so THIS is the graph's only
         * canvas. The label states the drag/reparent/details contract;
         * the controls row above carries the find/filter narrative. */
        container
          .querySelector('canvas')
          ?.setAttribute(
            'aria-label',
            'CareSpace force graph — every thought is a node; drag nodes to move them, drop one onto another to reparent (even across networks); double-click a node for details; the find box and tag chips above light and filter matches',
          );

        // CPU-friendly: reduce ticks and cooldown. autoPauseRedraw stops the
        // render loop entirely once the layout settles (default true, kept
        // explicit here for clarity).
        fg.autoPauseRedraw(true);
        if (perfMode === 'low') {
          /* CPU-only: settle the layout as fast as possible — a higher
           * alphaMin stops the engine sooner, fewer cooldown ticks cap the
           * total animation frames. Combined with autoPauseRedraw (render
           * loop halts once settled) this keeps the graph's steady-state
           * cost at exactly zero and its heat-up short. */
          fg.d3AlphaMin(0.15);
          fg.cooldownTicks(25);
        }

        // force-graph does NOT read the container size — it defaults to
        // window.innerWidth/innerHeight. Size it to the pane explicitly.
        const sizeToContainer = () => {
          const el = containerRef.current;
          if (!el) return;
          fg.width(el.clientWidth).height(el.clientHeight);
        };
        sizeToContainer();

        // Keep the canvas in sync with pane resizes (layout drags, window).
        const ro = new ResizeObserver(() => sizeToContainer());
        ro.observe(containerRef.current);
        roRef.current = ro;

        // Fallback fit in case the engine-stop event never fires (tiny graphs).
        setTimeout(() => {
          if (!cancelled && !initialFitDoneRef.current && fgRef.current) {
            initialFitDoneRef.current = true;
            fitCapped(fg);
          }
        }, 2500);

        fgRef.current = fg as unknown as { graphData: (d: unknown) => void };
        /* Task 73 — a graph re-entered while cluster mode is still on
         * must come up CLUSTERED: the fresh simulation knows no forces
         * yet, so re-register (no reheat — the initial layout run IS
         * the heat; the force shapes it from tick one). */
        if (clusterModeRef.current) {
          const g2 = fg as unknown as { d3Force?: (name: string, force?: unknown) => unknown };
          g2.d3Force?.('tagCluster', makeClusterForce());
        }
      } catch (err) {
        // force-graph failed to load — log the real reason for debugging.
        console.warn('[naksha] force-graph failed to load:', err);
      }
    };

    init();

    return () => {
      cancelled = true;
      roRef.current?.disconnect();
      roRef.current = null;
      if (fgRef.current) {
        try {
          // force-graph v1.5x exposes `_destructor` (destroy was removed).
          const fg = fgRef.current as unknown as { destroy?: () => void; _destructor?: () => void };
          if (typeof fg._destructor === 'function') fg._destructor();
          else if (typeof fg.destroy === 'function') fg.destroy();
        } catch {
          // ignore
        }
        fgRef.current = null;
      }
    };
  }, [viewMode, fitCapped]); // buildGraphData accessed via buildRef — intentionally not a dep

  /* ── Effect 2: push fresh graphData on data changes WITHOUT re-creating
     the instance. Perf: a signature check skips the push entirely when
     the rebuilt graph is equivalent (selection clicks, unrelated care
     mutations) — force-graph's graphData setter re-heats the simulation
     on EVERY call, so pushing identical data re-randomized the layout
     and burned d3 ticks for seconds. When the graph did change, nodes
     inherit the previous positions by id (x/y/vx/vy), so the layout
     evolves instead of restarting from noise. ── */
  useEffect(() => {
    if (viewMode !== 'graph') return;
    const prevNodes = nodesRef.current;
    const fg = fgRef.current;
    const data = buildRef.current();
    nodesRef.current = data.nodes;
    linksRef.current = data.links;
    /* Task 75 — the chip row's data: distinct first-tags with node counts,
     * sorted (the same deterministic order clusterTagOrder gives the
     * cluster petals). Identity-checked so an unchanged tag set doesn't
     * re-render the row. */
    const counts = new Map<string, number>();
    let untagged = 0;
    for (const n of data.nodes) {
      if (!n.tag) {
        untagged++;
        continue;
      }
      counts.set(n.tag, (counts.get(n.tag) ?? 0) + 1);
    }
    const chips = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
    /* Task 76 — the untagged majority gets its own chip (only when it
     * exists): fills `tag:untagged`, the ABSENCE clause — the tag story
     * is only complete when "none of the above" is clickable too. */
    if (untagged > 0) chips.push({ tag: 'untagged', count: untagged });
    setTagChips((prev) =>
      prev.length === chips.length &&
      prev.every((c, i) => c.tag === chips[i].tag && c.count === chips[i].count)
        ? prev
        : chips,
    );
    if (!fg) return; // async init hasn't finished; Effect 1 passed fresh data already

    /* Signature: ids + rendered props + link pairs. Cheap (string join
     * over a personal-sized graph) compared to a simulation re-heat. */
    const sig =
      data.nodes
        .map(
          (n) =>
            `${n.id}\u0001${n.label}\u0001${n.color}\u0001${n.val}\u0001${n.tag ?? ''}\u0001${n.dimColor ?? ''}\u0001${n.notes}\u0001${n.hasLocation ? 1 : 0}`,
        )
        .join('\u0002') +
      '\u0003' +
      data.links
        .map((l) => `${l.source}\u0001${l.target}\u0001${l.kind}\u0001${l.dim ? 1 : 0}\u0001${l.label ?? ''}`)
        .join('\u0002');

    const sameInstance = lastFgRef.current === fg;
    if (sameInstance && sig === lastGraphSigRef.current) {
      // Nothing the renderer draws changed — keep the live simulation
      // (positions, velocities, cooldown) exactly as it is.
      return;
    }
    lastGraphSigRef.current = sig;
    lastFgRef.current = fg;

    if (sameInstance && prevNodes.length > 0) {
      const prevById = new Map(prevNodes.map((n) => [n.id, n]));
      for (const n of data.nodes) {
        const old = prevById.get(n.id);
        if (old && typeof old.x === 'number' && typeof old.y === 'number') {
          n.x = old.x;
          n.y = old.y;
          n.vx = typeof old.vx === 'number' ? old.vx : 0;
          n.vy = typeof old.vy === 'number' ? old.vy : 0;
        }
      }
    }
    (fg as unknown as { graphData: (d: unknown) => void }).graphData(data);
    /* Phase 5 — dep: careVaultRev makes the graph re-run when a bound
     * file's existence flips, so rust ⇄ tag color stays truthful. */
  }, [viewMode, careRevision, showAllNetworks, careVaultRev]);

  /* ── Effect 3 (Task 50): arrival pulse on the landed node. Same signal
     the panel ring and tree flash consume — but THIS view's surface.
     force-graph's render cycle always runs (cheap hover ticks) but its
     autoPauseRedraw skips PAINTING once the engine settles — the ring
     would never reach the canvas. So the pulse BORROWS the painter:
     autoPauseRedraw(false) for the ring's ~0.9s (full-canvas paints —
     the same one-shot burst cost as the tree flash), then back to true.
     Perf-low skips entirely (parity with the ring/flash gates); tree
     view skips (the tree flash owns that surface — no double-fire). */
  useEffect(() => {
    if (!detailsFlashTs) return;
    const s = useNaksha.getState();
    if (s.settings.perfMode === 'low') return;
    if (s.careViewMode !== 'graph') return;
    const targetNodeId = s.detailsNodeId;
    const fg = fgRef.current;
    if (!targetNodeId || !fg) return;
    /* Graph node ids are `${netIdx}:${nodeId}` — resolve the landed node
     * to its graph-side id (a jump can cross rivers). */
    let graphId: string | null = null;
    CareSpace.networks().forEach((net, idx) => {
      if (net.nodes[targetNodeId]) graphId = `${idx}:${targetNodeId}`;
    });
    if (!graphId) return;
    arrivalPulseRef.current = { id: graphId, until: Date.now() + 900 };
    const g = fg as unknown as { autoPauseRedraw?: (enable?: boolean) => unknown };
    g.autoPauseRedraw?.(false);
    let raf = 0;
    const loop = () => {
      if (arrivalPulseRef.current && Date.now() < arrivalPulseRef.current.until) {
        raf = requestAnimationFrame(loop);
      } else {
        arrivalPulseRef.current = null;
        g.autoPauseRedraw?.(true); // back to the auto-paused rest state
        raf = 0;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      arrivalPulseRef.current = null;
      g.autoPauseRedraw?.(true);
    };
  }, [detailsFlashTs]);

  if (viewMode !== 'graph') return null;

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 5 }}>
      {/* Force graph container */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />

      {/* Controls overlay — Task 75: a COLUMN now. Row 1 = the controls;
          row 2 = the tag chips (only when the rendered graph has tags) —
          the query surface made visible: nobody finds `tag:` in a title
          attribute, but a colored chip with a count reads at a glance. */}
      <div
        style={{
          position: 'absolute',
          top: 36,
          left: 8,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 4,
          zIndex: 10,
        }}
      >
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {/* Task 72 — the find box: Trilium's note-map signature move.
            Type → matches stay lit (gold dashed ring, label at any zoom),
            everything else recedes to ghosts. Enter focuses the first
            match (center + zoom + the gold arrival pulse); Esc clears.
            Terminal typography — the shell's keyboard story, continued
            in the graph. */}
        <input
          value={findQuery}
          onChange={(e) => applyFind(e.target.value)}
          /* Task 110 — the find box teaches its whole dialect in a title
           * and a placeholder; placeholders are not names. The label
           * carries the clause nouns; the title keeps the long lesson. */
          aria-label="Find thoughts — bare text matches labels, notes: searches note bodies, tag: matches the first tag; Enter focuses matches, Esc clears"
          onKeyDown={(e) => {
            if (e.key === 'Enter') focusFirstFind();
            else if (e.key === 'Escape') {
              applyFind('');
              (e.target as HTMLInputElement).blur();
            }
          }}
          list="naksha-find-clauses"
          placeholder="find node…"
          className="naksha-graph-find"
          title="type to highlight matching thoughts · notes:<t> searches inside note bodies · tag:<t> matches the first tag's name (tag:untagged = absence) · clauses AND together (notes:demo tag:blue) · typing tag: suggests the tag clauses (↓ to cycle) · the tag chips under this box fill/release the tag: clause in one click (⇧+click = fix when the count is 1) · Enter focuses, Enter again = next match · Esc clears"
          style={{
            width: 138,
            padding: '3px 8px',
            fontSize: 9,
            fontFamily: 'var(--naksha-font-mono)',
            background: 'var(--naksha-bg-3)',
            border: '1px solid var(--naksha-border-2)',
            borderRadius: 4,
            color: 'var(--naksha-text)',
            outline: 'none',
          }}
        />
        {findCount !== null && (
          <span
            style={{
              fontFamily: 'var(--naksha-font-mono)',
              fontSize: 8,
              color: findCount === 0 ? 'var(--naksha-text-4)' : 'var(--naksha-gold-light, #ffe55c)',
              alignSelf: 'center',
              whiteSpace: 'nowrap',
            }}
          >
            {findCursor >= 0
              ? `${findCursor + 1}/${findCount} match`
              : `${findCount} match${findCount === 1 ? '' : 'es'}`}
          </span>
        )}
        <button
          onClick={() => setShowAllNetworks(!showAllNetworks)}
          className="naksha-mini-btn"
          data-active={showAllNetworks}
          /* Task 110 — data-active dressed the state in pixels only
           * (Task 108's theme-card lesson): aria-pressed is how a
           * button that LOOKS latched SOUNDS latched. */
          aria-pressed={showAllNetworks}
          style={{
            padding: '3px 8px',
            fontSize: 9,
          }}
        >
          All networks
        </button>
        {/* Task 73 — Trilium's color-cluster mode, dialect-ported: ON,
            same-tag thoughts gather toward shared ring anchors (tag names
            sorted → deterministic petals); OFF, plain gravity returns.
            Reheat + re-fit are part of the click, not a hidden cost. */}
        <button
          onClick={() => {
            const next = !clusterMode;
            setClusterMode(next);
            applyClusterForce(next);
          }}
          className="naksha-mini-btn"
          data-active={clusterMode}
          aria-pressed={clusterMode}
          title="gather thoughts of one tag toward shared anchors (click again to release) — untagged stay center · while on, the anchor ring is painted: faint dashed circle + tag names at each petal"
          style={{
            padding: '3px 8px',
            fontSize: 9,
          }}
        >
          ◈ cluster
        </button>
        <button
          onClick={() => {
            if (fgRef.current) {
              fitCapped(fgRef.current);
            }
          }}
          className="naksha-mini-btn"
          style={{
            padding: '3px 8px',
            fontSize: 9,
          }}
        >
          Fit
        </button>
        {/* Edge legend — solid = hierarchy, dashed = custom link (`link A to B`) */}
        <span
          style={{
            fontFamily: 'var(--naksha-font-mono)',
            fontSize: 8,
            color: 'var(--naksha-text-4)',
            alignSelf: 'center',
            whiteSpace: 'nowrap',
          }}
          title="solid = hierarchy · dashed = custom link · violet halo = node has a map location (RIGHT-CLICK = fly + ⇥ tree row) · DOUBLE-CLICK = open details · CLICK the ▤ by a label = open that thought's notes · node dots wear their first tag's color · dimmed = other rivers (All networks) · drag a node onto another to reparent (even across networks) · click a dashed edge to rename/clear its label · find box: bare text = label, notes: = body, tag: = first tag, clauses AND"
        >
          ─ tree ┄ link · ◦ on map ⇥fly · ▤=notes (count · click) · drag→reparent · #chip = tag: filter · ⇧# = fix
        </span>
        </div>
        {/* Task 77 — the chips' keyboard story: a native datalist speaks
            the SAME nouns the chip row renders, so typing `tag:` suggests
            the full clause set (↓ to cycle, no mouse needed). The dropdown
            is the browser's own — zero new surfaces to learn, zero extra
            DOM to style, and picking one lands in applyFind like typing. */}
        <datalist id="naksha-find-clauses">
          {/* Task 78 — the dialects teach themselves: the bare `notes:`
              skeleton rides the same suggestion list (it stays INERT when
              committed alone — applyFind's half-typed rule), so typing
              `n` offers the body-search verb without a doc visit. */}
          <option value="notes:">search inside note bodies</option>
          {/* Task 80 — the suggestions speak the WEAR order now (most
              worn first, alpha ties), the same order the fix picker's
              palette speaks: the two suggestion surfaces teach one
              dialect, not two. The CHIP ROW keeps its alphabetical
              stability — only the typed-surface order follows usage. */}
          {[...tagChips]
            .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
            .map((c) => (
              <option key={c.tag} value={`tag:${c.tag}`}>
                {c.count} thought{c.count === 1 ? '' : 's'}
              </option>
            ))}
        </datalist>
        {tagChips.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              maxWidth: 460,
            }}
            title="tags present in this graph — click to filter (the tag: clause), click again to release; ⇧+click FIXES when the count is 1 (tag chip = remove the tag · untagged chip = assign one); typed label/notes: terms survive and AND together · Σ tags = the whole CareSpace's inventory, printed in the terminal"
          >
            {tagChips.map((c) => {
              const active = findQuery.split(/\s+/).includes(`tag:${c.tag}`);
              const isUntagged = c.tag === 'untagged';
              return (
                <button
                  key={c.tag}
                  onClick={(e) => (e.shiftKey ? shiftFixChip(c.tag) : toggleTagClause(c.tag))}
                  className="naksha-mini-btn"
                  data-active={active}
                  /* Task 110 — the chip row filters BY state (the tag:
                   * clause lives in the find box); pressed is that state's
                   * sound. The dot stays aria-hidden — the name is the
                   * tag and count. */
                  aria-pressed={active}
                  title={isUntagged
                    ? `find UNTAGGED thoughts (${c.count}) — fills tag:untagged, the absence clause · click again to release · ⇧+click = tag the one orphan (when count is 1)`
                    : `find thoughts tagged "${c.tag}" (${c.count}) — fills the tag: clause · click again to release · ⇧+click = untag the one wearer (when count is 1)`}
                  style={{
                    padding: '2px 7px',
                    fontSize: 8,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-block',
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      flex: '0 0 auto',
                      /* Task 76 — the untagged chip's dot is HOLLOW: every
                       * real tag owns a color; absence owns the ring. */
                      ...(isUntagged
                        ? { background: 'transparent', border: '1px solid var(--naksha-text-4)' }
                        : { background: TAG_COLORS[c.tag as keyof typeof TAG_COLORS] ?? 'var(--naksha-text-4)' }),
                    }}
                  />
                  {c.tag}·{c.count}
                </button>
              );
            })}
            {/* Task 86 — the bridge, graph side: this row speaks THIS
             * graph's tags as filters; Σ hands the WHOLE space's
             * inventory to the terminal (every river, wearers named,
             * chips included). The door the footnote opens in reverse.
             * A native button — tab + Enter already reach it. Same
             * echo-then-execute covenant the terminal chips speak:
             * the receipt reads like a typed run, history untouched. */}
            <button
              onClick={() => {
                useNaksha.getState().print('tags', 'cmd');
                void CommandRunner.execute('tags');
              }}
              className="naksha-mini-btn"
              title="run: tags — the whole CareSpace's tag inventory in the terminal, every river (this row speaks THIS graph only)"
              style={{
                padding: '2px 7px',
                fontSize: 8,
              }}
            >
              Σ tags
            </button>
          </div>
        )}
        {/* Task 78 — the fix receipt, ON the surface that caused it: a
            3s gold chip whose click reverts the fix in place (the same
            consume contract the terminal undo speaks). One fix, one
            toast, one door back — no terminal round-trip. */}
        {fixToast && (
          <div style={{ display: 'flex', maxWidth: 460 }}>
            <button
              onClick={undoFixToast}
              className="naksha-mini-btn naksha-fix-toast"
              title={`${fixToast.label} · click to undo (⇧⌘Z re-applies) — leases for 3s, the terminal's undo slot holds the same snapshot`}
              style={{
                padding: '2px 7px',
                fontSize: 8,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span aria-hidden="true" style={{ color: 'var(--naksha-gold)' }}>✓</span>
              {fixToast.label} — undo
            </button>
          </div>
        )}
        {/* Task 78 — the assign direction's picker: a styled inline input
            with the palette as ITS datalist. Enter commits through
            completeFix, Esc/click-away cancels, ↓ cycles the palette —
            the same keyboard story the find box speaks. Task 79 — the
            suggestions are ordered by what the network wears, and a
            <details> pick list rides beside the input: plain DOM (the
            datalist's native popup is invisible to automation), skinned
            by the same theme vars, committing through the SAME
            commitFixPicker contract typing rides. The blur-guard moved
            to the WHOLE row — focus landing on the dropdown is not
            click-away; only focus leaving the row cancels. */}
        {fixPicker && (
          <div
            style={{ display: 'flex', gap: 4, alignItems: 'center' }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFixPicker(null);
            }}
          >
            <input
              autoFocus
              key={fixPicker.nodeId}
              defaultValue={prefillTag}
              onFocus={(e) => e.currentTarget.select()}
              /* Task 110 — same placeholder-is-not-a-name rule as the
               * find box; this one names the THOUGHT it is tagging. */
              aria-label={`Tag "${fixPicker.label}" — Enter commits, Esc cancels, arrow keys cycle the palette`}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitFixPicker(e.currentTarget.value);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setFixPicker(null);
                }
              }}
              list="naksha-fix-palette"
              className="naksha-fix-picker"
              placeholder={`tag "${fixPicker.label}" with…`}
              title="Enter tags the thought (palette: red orange yellow green blue purple) · Esc or click-away cancels · ↓ cycles the palette list · palette ▾ = click a color to commit · opens pre-filled with the dominant color — Enter confirms, typing replaces"
              style={{
                width: 178,
                padding: '3px 8px',
                fontSize: 9,
                fontFamily: 'var(--naksha-font-mono)',
                background: 'var(--naksha-bg-3)',
                /* Task 82 — the pre-fill is announced in the dominant's
                 * own color: the border IS the color Enter would apply
                 * (gold again the moment the field is empty). Static —
                 * no animation, the CPU rule holds. */
                border: `1px solid ${prefillTag ? TAG_COLORS[prefillTag] : 'var(--naksha-gold)'}`,
                borderRadius: 4,
                color: 'var(--naksha-text)',
                caretColor: 'var(--naksha-gold)',
                outline: 'none',
                animation: 'nakshaToastIn 160ms ease-out',
                /* Task 83 — the selected prefill loses the browser's
                 * default blue: the highlight wears the dominant's tint
                 * too (::selection reads --naksha-sel in globals.css),
                 * so every pixel of the announce agrees on the color. */
                ...(prefillTag ? { '--naksha-sel': hexWithAlpha(TAG_COLORS[prefillTag], 0.32) } : {}),
              } as CSSProperties}
            />
            <details className="naksha-fix-palette-details">
              <summary className="naksha-mini-btn" title="the palette as a pick list — worn colors first, a click commits">
                palette ▾
              </summary>
              <div className="naksha-fix-palette-pop">
                {paletteChoices.map((p) => (
                  <button
                    key={p.tag}
                    type="button"
                    className="naksha-fix-palette-opt"
                    data-dominant={p.tag === dominantTag ? '' : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitFixPicker(p.tag)}
                    title={p.count > 0 ? `${p.count} thought${p.count === 1 ? '' : 's'} wear ${p.tag} here${p.tag === dominantTag ? ` — the dominant color here${dominantTie > 1 ? ` (first among ${dominantTie} tied)` : ''}` : ''}` : `${p.tag} — unworn in this graph`}
                  >
                    <span
                      aria-hidden="true"
                      className="naksha-fix-palette-dot"
                      style={{ background: TAG_COLORS[p.tag] }}
                    />
                    {p.tag}
                    {p.count > 0 && (
                      <span className="naksha-fix-palette-count" aria-hidden="true">
                        ·{p.count}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </details>
            <datalist id="naksha-fix-palette">
              {paletteChoices.map((p) => (
                <option key={p.tag} value={p.tag}>
                  {p.count > 0 ? `worn by ${p.count}` : ''}
                </option>
              ))}
            </datalist>
          </div>
        )}
      </div>
    </div>
  );
}

function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default CareSpaceForceGraph;
