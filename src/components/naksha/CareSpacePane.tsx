'use client';

/**
 * Naksha — CareSpacePane
 *
 * The right pane of Naksha: a Trillium-Next-inspired tree map rendered on a
 * single <canvas>. Each CareNetwork is laid out as a vertical column of
 * indented file-tree-style node "cards" connected by L-shaped elbow lines.
 *
 * Core behaviours:
 *   • 1 network  → full-width column.
 *   • 2–3 networks → N equal columns separated by dashed gold dividers.
 *   • Current network column is full-opacity; others dimmed to 60% (until hovered).
 *   • Current node is highlighted with a gold border + tinted background.
 *   • Hover shows a tooltip with the latest notes + meta.
 *   • Click on a node navigates into it; click on the left chevron toggles collapse.
 *   • Click on a column header switches networks.
 *   • Optional flow particles travel child→parent (ideas toward the core).
 *
 * Performance (the "no-CPU-when-idle" rule):
 *   • Single canvas, DPR capped at 2.
 *   • ResizeObserver debounced 100ms.
 *   • Layout cached in nodePositionsRef — recomputed only on revision/size change.
 *   • Particle rAF loop sleeps after PARTICLE_SLEEP_MS of inactivity and is
 *     re-armed on any mousemove / click / wheel.
 *   • mousemove throttled to 30 fps (33ms) — CPU-friendly.
 *   • No continuous CSS animations.
 */

import { useEffect, useRef, useCallback } from 'react';
import { CareSpace } from '@/lib/naksha/carespace';
import { useNaksha } from '@/lib/naksha/store';
import {
  TAG_COLORS,
  PARTICLE_SLEEP_MS,
  PARTICLE_TRAVEL_MS,
} from '@/lib/naksha/constants';
import { debounce, throttle, timeAgo, truncate } from '@/lib/naksha/utils';
import { accentPurple, canvasInk } from '@/lib/naksha/themes';
import type { CareNode, CareNetwork } from '@/lib/naksha/types';
import { CareSpaceForceGraph } from './CareSpaceForceGraph';

/* ════════════════════════════════════════════════════════════════
   Color helper — convert hex + alpha to rgba string (for canvas).
   ════════════════════════════════════════════════════════════════ */
function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ════════════════════════════════════════════════════════════════
   Layout & visual constants
   ════════════════════════════════════════════════════════════════ */

const NODE_W = 140;
const NODE_H = 32;
const VERTICAL_GAP = 10;
const PADDING = 16;
const INDENT_PER_LEVEL = 18;
const HEADER_H = 24;
const TOP_GAP = 8;
const NODE_RADIUS = 6;
const MAX_LABEL_CHARS = 16;
const MAX_HEADER_NAME_CHARS = 22;
const CHEVRON_HIT_WIDTH = 16;

/* Colors — decorative alpha washes stay literal (they read on both theme
 * families and never change); the INK trio (labels) rides the theme via
 * the cached canvasInk() resolver (Task 94) — one getComputedStyle read
 * per theme change, never per frame, so the old "kept inline for canvas
 * performance" concern still holds. In amber-night the resolved values
 * EQUALED the literals this palette froze for months (#a89e88 / #6b6353 /
 * #f0c040) until the v138 T3 metallic re-tone retuned the theme's tokens;
 * on light papers the ink goes dark where the frozen amber washed out. */
const C = {
  dash: 'rgba(212, 160, 23, 0.25)',
  connector: 'rgba(212, 160, 23, 0.2)',
  customLink: 'rgba(155, 126, 200, 0.25)',
  locPin: '#7a9ec2',
  /* labelCur = the current row's gold, label = resting ink, labelDim =
     depth-hierarchy ink — all three follow the theme's declared values. */
  get labelCur() {
    return canvasInk().goldLight;
  },
  get label() {
    return canvasInk().text2;
  },
  get labelDim() {
    return canvasInk().text3;
  },
  nodeBg: 'rgba(255, 255, 255, 0.04)',
  nodeBgHover: 'rgba(212, 160, 23, 0.08)',
  nodeBgCur: 'rgba(212, 160, 23, 0.15)',
  nodeBorder: 'rgba(255, 255, 255, 0.1)',
  nodeBorderHover: 'rgba(212, 160, 23, 0.3)',
  nodeBorderCur: 'rgba(212, 160, 23, 0.5)',
  netTint: 'rgba(212, 160, 23, 0.08)',
  headerHairline: 'rgba(212, 160, 23, 0.18)',
};

/* ════════════════════════════════════════════════════════════════
   Types
   ════════════════════════════════════════════════════════════════ */

interface NodePos {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  networkIdx: number;
  nodeId: string;
  hasChildren: boolean;
  collapsed: boolean;
  hiddenChildCount: number;
}

interface Pt {
  x: number;
  y: number;
}

interface LinkPath {
  parentId: string;
  childId: string;
  networkIdx: number;
  color: string;
  p0: Pt; // parent bottom-left
  p1: Pt; // (parent.x, midY)
  p2: Pt; // (child.x, midY)
  p3: Pt; // child top-left
  segLengths: [number, number, number];
  totalLength: number;
}

interface CustomLinkPath {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  networkIdx: number;
}

interface Particle {
  linkIdx: number;
  linkKey: string;
  progress: number; // 0..1, child→parent direction
}

interface HeaderBar {
  x: number;
  y: number;
  w: number;
  h: number;
  networkIdx: number;
  name: string;
  color: string;
  active: boolean;
}

/* ════════════════════════════════════════════════════════════════
   Pure helpers
   ════════════════════════════════════════════════════════════════ */

function pathRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function truncateLabel(s: string, max = MAX_LABEL_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function getRootId(net: CareNetwork): string | null {
  for (const id of Object.keys(net.nodes)) {
    if (net.nodes[id].parentId === null) return id;
  }
  return null;
}

function countHidden(net: CareNetwork, nodeId: string): number {
  const node = net.nodes[nodeId];
  if (!node) return 0;
  let count = 0;
  const walk = (id: string) => {
    const n = net.nodes[id];
    if (!n) return;
    count += 1;
    n.children.forEach(walk);
  };
  node.children.forEach(walk);
  return count;
}

/** Interpolate a particle's position along the child→parent path. */
function particlePosition(link: LinkPath, progress: number): Pt {
  // Child→parent path is the reverse of [p0, p1, p2, p3]
  // → [p3, p2, p1, p0] with reversed segment lengths [seg2, seg1, seg0]
  const total = link.totalLength;
  if (total <= 0) return { x: link.p3.x, y: link.p3.y };
  let remaining = progress * total;
  const pts: Pt[] = [link.p3, link.p2, link.p1, link.p0];
  const segLens: [number, number, number] = [
    link.segLengths[2],
    link.segLengths[1],
    link.segLengths[0],
  ];
  for (let i = 0; i < 3; i++) {
    if (remaining <= segLens[i]) {
      const t = segLens[i] > 0 ? remaining / segLens[i] : 0;
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
      };
    }
    remaining -= segLens[i];
  }
  return { x: link.p0.x, y: link.p0.y };
}

function escapeHtmlSafe(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ════════════════════════════════════════════════════════════════
   Component
   ════════════════════════════════════════════════════════════════ */

export function CareSpacePane() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  /* View mode lives in the store so commands (`caregraph`) and the header
   * button stay in sync. */
  const viewMode = useNaksha((s) => s.careViewMode);
  const setViewMode = useNaksha((s) => s.setCareViewMode);

  /* Reactive (header/footer & re-render triggers) */
  const careRevision = useNaksha((s) => s.careRevision);
  const breadcrumb = useNaksha((s) => s.breadcrumb);
  const currentNetworkName = useNaksha((s) => s.currentNetworkName);
  const careStats = useNaksha((s) => s.careStats);
  const particlesEnabled = useNaksha((s) => s.settings.particlesEnabled);
  const perfMode = useNaksha((s) => s.settings.perfMode);
  /* Task 91 — theme switches repaint the canvas: the tree's violet
     accents (the ◈ basemap badge) resolve per theme via accentPurple(),
     and this subscription is the redraw trigger. */
  const themeId = useNaksha((s) => s.settings.themeId);
  /* Task 49 — the SAME arrival signal the details panel's gold ring
   * rides: set by every ⇥ deep link (terminal rows, graph double-click).
   * Both landing surfaces announce the landing — the panel rings, the
   * tree's selected row pulses. */
  const detailsFlashTs = useNaksha((s) => s.detailsFlashTs);

  /* Imperative refs (mutable, no re-render) */
  const nodePositionsRef = useRef<Map<string, NodePos>>(new Map());
  const linkPathsRef = useRef<LinkPath[]>([]);
  const customLinksRef = useRef<CustomLinkPath[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const headerBarsRef = useRef<HeaderBar[]>([]);
  const hoveredNodeRef = useRef<string | null>(null);
  const hoveredNetworkRef = useRef<number | null>(null);
  const canvasSizeRef = useRef({ w: 0, h: 0 });
  const scrollYRef = useRef(0);
  const maxScrollRef = useRef(0);
  const contentHeightRef = useRef(0);
  const lastInteractionRef = useRef(Date.now());
  const rafRef = useRef<number | null>(null);
  /* Task 49 — tree arrival flash: expiry timestamp of the one-shot gold
   * pulse on the selected row (0 = idle). Set by the detailsFlashTs
   * subscription below; drawAll reads it and fades the overlay — zero
   * cost at rest, a ~0.9s burst only when a ⇥ jump actually lands. */
  const treeFlashRef = useRef<number>(0);
  const lastFrameTsRef = useRef(0);
  const particlesEnabledRef = useRef(particlesEnabled);
  /** Drag-to-reorder state (tree view). `active` flips once the pointer moves
   *  >6px so a simple click still navigates. */
  const dragStateRef = useRef<{
    nodeId: string;
    networkIdx: number;
    startX: number;
    startY: number;
    active: boolean;
    drop: { targetId: string; before: boolean } | null;
  } | null>(null);
  /** Suppresses the click that fires right after a drag mouseup. */
  const didDragRef = useRef(false);

  /* ──────────────────────────────────────────────────────────
     Layout — recompute nodePositions, linkPaths, particles
     ────────────────────────────────────────────────────────── */
  const computeLayout = useCallback(() => {
    const pos = new Map<string, NodePos>();
    const links: LinkPath[] = [];
    const customs: CustomLinkPath[] = [];
    const headers: HeaderBar[] = [];
    const { w: cw, h: ch } = canvasSizeRef.current;
    if (cw <= 0 || ch <= 0) {
      nodePositionsRef.current = pos;
      linkPathsRef.current = links;
      customLinksRef.current = customs;
      headerBarsRef.current = headers;
      return;
    }

    const networks = CareSpace.networks();
    const nNets = networks.length;
    const colW = cw / nNets;
    const curIdx = CareSpace.data.currentNetworkIndex;

    let maxBottom = HEADER_H + TOP_GAP;

    const layoutNode = (
      net: CareNetwork,
      netIdx: number,
      nodeId: string,
      depth: number,
      y: number,
    ): number => {
      const node = net.nodes[nodeId];
      if (!node) return y;
      const x = netIdx * colW + PADDING + depth * INDENT_PER_LEVEL;
      const hasChildren = node.children.length > 0;
      const hiddenChildCount = node.collapsed ? countHidden(net, nodeId) : 0;

      pos.set(nodeId, {
        x,
        y,
        w: NODE_W,
        h: NODE_H,
        depth,
        networkIdx: netIdx,
        nodeId,
        hasChildren,
        collapsed: node.collapsed,
        hiddenChildCount,
      });

      if (y + NODE_H > maxBottom) maxBottom = y + NODE_H;
      let nextY = y + NODE_H + VERTICAL_GAP;

      if (!node.collapsed) {
        for (const childId of node.children) {
          if (!net.nodes[childId]) continue;
          nextY = layoutNode(net, netIdx, childId, depth + 1, nextY);
        }
      }
      return nextY;
    };

    for (let i = 0; i < nNets; i++) {
      const net = networks[i];
      const rootId = getRootId(net);
      if (!rootId) continue;
      const startY = HEADER_H + TOP_GAP;
      layoutNode(net, i, rootId, 0, startY);
      headers.push({
        x: i * colW,
        y: 0,
        w: colW,
        h: HEADER_H,
        networkIdx: i,
        name: net.name,
        color: net.color,
        active: i === curIdx,
      });
    }

    /* Second pass: build link paths using now-complete positions map */
    for (let i = 0; i < nNets; i++) {
      const net = networks[i];
      const rootId = getRootId(net);
      if (!rootId) continue;
      const walk = (nodeId: string) => {
        const node = net.nodes[nodeId];
        if (!node) return;
        if (!node.collapsed) {
          for (const childId of node.children) {
            const pp = pos.get(nodeId);
            const cp = pos.get(childId);
            if (pp && cp) {
              const px = pp.x + 4;
              const py = pp.y + pp.h;
              const cx = cp.x + 4;
              const cy = cp.y;
              const midY = (py + cy) / 2;
              const seg1 = Math.abs(midY - py);
              const seg2 = Math.abs(cx - px);
              const seg3 = Math.abs(cy - midY);
              links.push({
                parentId: nodeId,
                childId,
                networkIdx: i,
                color: net.color,
                p0: { x: px, y: py },
                p1: { x: px, y: midY },
                p2: { x: cx, y: midY },
                p3: { x: cx, y: cy },
                segLengths: [seg1, seg2, seg3],
                totalLength: seg1 + seg2 + seg3,
              });
            }
            walk(childId);
          }
        }
        /* Custom (non-hierarchical) links */
        for (const otherId of node.links) {
          if (pos.has(otherId) && nodeId < otherId) {
            const a = pos.get(nodeId)!;
            const b = pos.get(otherId)!;
            customs.push({
              ax: a.x + a.w / 2,
              ay: a.y + a.h / 2,
              bx: b.x + b.w / 2,
              by: b.y + b.h / 2,
              networkIdx: i,
            });
          }
        }
      };
      walk(rootId);
    }

    nodePositionsRef.current = pos;
    linkPathsRef.current = links;
    customLinksRef.current = customs;
    headerBarsRef.current = headers;

    /* Rebuild particles — preserve progress for unchanged links */
    const oldParticles = particlesRef.current;
    const newParticles: Particle[] = [];
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const key = `${link.parentId}->${link.childId}`;
      const old = oldParticles.find((p) => p.linkKey === key);
      newParticles.push({
        linkIdx: i,
        linkKey: key,
        progress: old ? old.progress : Math.random(),
      });
    }
    particlesRef.current = newParticles;

    /* Scroll bounds */
    contentHeightRef.current = maxBottom + PADDING;
    maxScrollRef.current = Math.max(0, contentHeightRef.current - ch);
    if (scrollYRef.current > maxScrollRef.current) {
      scrollYRef.current = maxScrollRef.current;
    }
  }, []);

  /* ──────────────────────────────────────────────────────────
     Drawing
     ────────────────────────────────────────────────────────── */
  const drawAll = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = canvasSizeRef.current;
    if (w <= 0 || h <= 0) return;

    ctx.clearRect(0, 0, w, h);

    const networks = CareSpace.networks();
    const nNets = networks.length;
    const curIdx = CareSpace.data.currentNetworkIndex;
    const hoveredNet = hoveredNetworkRef.current;
    const scrollY = scrollYRef.current;
    const hoveredNodeId = hoveredNodeRef.current;
    const colW = w / nNets;

    /* Column separators (between columns, full opacity) */
    if (nNets > 1) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = C.dash;
      ctx.lineWidth = 1;
      for (let i = 1; i < nNets; i++) {
        const x = i * colW;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      ctx.restore();
    }

    /* For each column: dim inactive, draw header + nodes + links + particles */
    for (let i = 0; i < nNets; i++) {
      const isActive = i === curIdx;
      const isHovered = i === hoveredNet;
      const dimmed = !isActive && !isHovered;
      const colX = i * colW;

      ctx.save();
      if (dimmed) ctx.globalAlpha = 0.6;
      ctx.translate(0, -scrollY);

      /* Header bar */
      const header = headerBarsRef.current.find((hb) => hb.networkIdx === i);
      if (header) {
        if (isActive) {
          ctx.fillStyle = C.netTint;
          ctx.fillRect(header.x, header.y, header.w, header.h);
        }
        ctx.fillStyle = C.headerHairline;
        ctx.fillRect(header.x, header.y + header.h - 1, header.w, 1);
        /* Colored dot */
        const dotX = header.x + 12;
        const dotY = header.y + header.h / 2;
        ctx.fillStyle = header.color;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
        ctx.fill();
        /* Soft glow under dot for active network */
        if (isActive) {
          ctx.fillStyle = hexToRgba(header.color, 0.25);
          ctx.beginPath();
          ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
          ctx.fill();
        }
        /* Network name */
        ctx.fillStyle = isActive ? C.labelCur : C.label;
        ctx.font = `600 11px 'JetBrains Mono', 'Geist Mono', monospace`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(
          truncateLabel(header.name, MAX_HEADER_NAME_CHARS),
          dotX + 10,
          dotY,
        );
        /* Task 38 — ◈ basemap badge: a river bound to a non-default
           basemap carries a violet ◈ at the header's right edge — the
           same glyph family as the map's netlayer chip, so "this river
           owns a terrain" reads from either pane. Rides the existing
           redraws (careRevision bumps); zero idle cost. Task 91 — the
           violet is the THEMED accent now (accentPurple() resolves
           --naksha-purple once per theme — canvas can't read vars), so
           the badge stays the same hue as the map's chip in EVERY
           theme, not just the default. */
        if (networks[i].mapLayer) {
          ctx.fillStyle = hexToRgba(accentPurple(), 0.9);
          ctx.font = `10px 'JetBrains Mono', 'Geist Mono', monospace`;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText('◈', header.x + header.w - 10, dotY);
        }
      }

      /* Custom (curved dashed) links — drawn first so they sit behind nodes */
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = C.customLink;
      ctx.lineWidth = 1;
      for (const cl of customLinksRef.current) {
        if (cl.networkIdx !== i) continue;
        ctx.beginPath();
        ctx.moveTo(cl.ax, cl.ay);
        const mx = (cl.ax + cl.bx) / 2;
        const my = (cl.ay + cl.by) / 2;
        const dx = cl.bx - cl.ax;
        const dy = cl.by - cl.ay;
        /* Perpendicular offset for a gentle curve */
        const cx = mx - dy * 0.18;
        const cy = my + dx * 0.18;
        ctx.quadraticCurveTo(cx, cy, cl.bx, cl.by);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      /* Elbow connectors (parent→child) — with subtle glow.
         Drawn twice: first a wider semi-transparent stroke (glow),
         then the thin sharp line on top.
         Task 104 — the glow pass is the tree's most expensive stroke
         (every connector repainted at 3× width for an 8%-alpha wash)
         and it reads as imperceptible at exactly the tier that can
         least afford it, so perf=low draws the sharp pass only. Read
         LIVE from the store (drawAll is dep-free by design). */
      const glowEnabled = useNaksha.getState().settings.perfMode !== 'low';
      for (const link of linkPathsRef.current) {
        if (link.networkIdx !== i) continue;
        // Glow pass (wider, low alpha, network color)
        const netColor = networks[i].color;
        if (glowEnabled) {
          ctx.strokeStyle = hexWithAlpha(netColor, 0.08);
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(link.p0.x, link.p0.y);
          ctx.lineTo(link.p1.x, link.p1.y);
          ctx.lineTo(link.p2.x, link.p2.y);
          ctx.lineTo(link.p3.x, link.p3.y);
          ctx.stroke();
        }
        // Sharp pass (thin, original connector color)
        ctx.strokeStyle = C.connector;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(link.p0.x, link.p0.y);
        ctx.lineTo(link.p1.x, link.p1.y);
        ctx.lineTo(link.p2.x, link.p2.y);
        ctx.lineTo(link.p3.x, link.p3.y);
        ctx.stroke();
      }

      /* Nodes — Trillium-style flat rows (no card backgrounds).
         Each row is a simple horizontal strip with:
           • indentation guide lines (thin vertical at each depth)
           • chevron (▸/▾) for expand/collapse
           • label in monospace
           • subtle hover background (no border)
           • selected row gets a solid accent-colored bar (full width)
         This matches Trilium's fancytree-based tree panel. */
      const net = networks[i];
      const curNode = net.nodes[net.currentId];
      const curNodeId = curNode ? curNode.id : null;

      for (const [, p] of nodePositionsRef.current.entries()) {
        if (p.networkIdx !== i) continue;
        const node = net.nodes[p.nodeId];
        if (!node) continue;

        const isCur = p.nodeId === curNodeId;
        const isHov = hoveredNodeId === p.nodeId;

        /* Row background — Trillium uses a solid bar for selected,
           a faint highlight for hover, nothing for default. */
        if (isCur) {
          // Solid accent bar (full column width) — Trilium's active-node style
          ctx.fillStyle = hexWithAlpha(net.color, 0.22);
          ctx.fillRect(colX, p.y, colW, p.h);
          // Left accent edge (3px solid accent)
          ctx.fillStyle = net.color;
          ctx.fillRect(colX, p.y, 3, p.h);
          /* Task 49 — the arrival pulse: only on the ACTIVE column (a
             jump lands in one river, not every river's last-open node),
             fading gold over the river-colored bar — the same gold the
             details panel's ring speaks, so both landing surfaces use
             one voice. Time-based alpha: no state, the rAF burst just
             redraws until the expiry passes. */
          if (isActive && treeFlashRef.current) {
            const remain = treeFlashRef.current - Date.now();
            if (remain <= 0) {
              treeFlashRef.current = 0;
            } else {
              const t = remain / 900;
              /* Task 115 — the pulse rides the theme gold: the details
               * panel ring it answers (Task 113) follows the accent, so
               * tree + panel land in one voice per theme. */
              ctx.fillStyle = hexWithAlpha(canvasInk().goldLight, 0.22 * t);
              ctx.fillRect(colX, p.y, colW, p.h);
              ctx.fillStyle = hexWithAlpha(canvasInk().goldLight, 0.8 * t);
              ctx.fillRect(colX, p.y, 3, p.h);
            }
          }
        } else if (isHov) {
          // Faint hover background — no border, no rounded corners
          ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
          ctx.fillRect(colX, p.y, colW, p.h);
        }

        /* Indentation guide lines — thin vertical lines at each depth level.
           These are the "tree lines" that make it read as a hierarchy. */
        for (let d = 1; d <= p.depth; d++) {
          const lineX = p.x - INDENT_PER_LEVEL * (p.depth - d) - INDENT_PER_LEVEL / 2;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(lineX, p.y);
          ctx.lineTo(lineX, p.y + p.h);
          ctx.stroke();
        }

        /* Chevron — Trilium uses ▸/▾ at the left of the row.
           Only drawn if the node has children. */
        const chevX = p.x + 6;
        const chevY = p.y + p.h / 2;
        ctx.fillStyle = isCur ? C.labelCur : C.labelDim;
        ctx.font = `9px 'JetBrains Mono', 'Geist Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (p.hasChildren) {
          ctx.fillText(p.collapsed ? '▸' : '▾', chevX, chevY);
        }

        /* Hidden child count badge (when collapsed) */
        if (p.collapsed && p.hiddenChildCount > 0) {
          ctx.font = `8px 'JetBrains Mono', 'Geist Mono', monospace`;
          ctx.fillStyle = C.labelDim;
          ctx.textAlign = 'left';
          ctx.fillText(`+${p.hiddenChildCount}`, chevX + 7, chevY);
        }

        /* Label — Trilium uses the tree font, left-aligned after chevron. */
        ctx.fillStyle = isCur ? C.labelCur : C.label;
        ctx.font = `${isCur ? '500' : '400'} 12px 'JetBrains Mono', 'Geist Mono', monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(truncateLabel(node.label), p.x + 20, p.y + p.h / 2);

        /* Badges (right-aligned) — note count, location pin, tag dot.
           Trilium shows small inline icons; we keep our badge system. */
        let badgeX = p.x + p.w - 8;

        /* Note count — small gold pill (clearer association than a bare
           number floating at the row edge). */
        if (node.notes.length > 0) {
          const txt = `${node.notes.length}`;
          ctx.font = `9px 'JetBrains Mono', 'Geist Mono', monospace`;
          const tw = ctx.measureText(txt).width;
          const pillW = tw + 10;
          const pillH = 12;
          const pillX = badgeX - pillW;
          const pillY = p.y + (p.h - pillH) / 2;
          ctx.fillStyle = hexWithAlpha('#d4a017', 0.16);
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(pillX, pillY, pillW, pillH, 6);
          } else {
            ctx.rect(pillX, pillY, pillW, pillH);
          }
          ctx.fill();
          ctx.fillStyle = C.labelCur;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(txt, pillX + pillW / 2, p.y + p.h / 2 + 0.5);
          badgeX = pillX - 6;
        }

        /* Location pin */
        if (node.location) {
          ctx.fillStyle = C.locPin;
          ctx.font = `11px 'JetBrains Mono', 'Geist Mono', monospace`;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText('◉', badgeX, p.y + p.h / 2 + 0.5);
          badgeX -= 12;
        }

        /* Phase 5 — vault binding badge: ▤ (gold) when the thought's
           writing lives in a real file; ⚠ (rust) when that file is
           currently MISSING — the broken-note state the tree must show
           instead of pretending. Read fresh at draw time (the redraw
           effect subscribes to careVaultRevision). */
        if (node.vaultPath) {
          const missing = useNaksha.getState().careVaultMissing[node.vaultPath] === true;
          ctx.fillStyle = missing ? 'rgba(226, 122, 95, 0.95)' : 'rgba(212, 165, 116, 0.95)';
          ctx.font = `9px 'JetBrains Mono', 'Geist Mono', monospace`;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(missing ? '⚠' : '▤', badgeX, p.y + p.h / 2 + 0.5);
          badgeX -= 11;
        }

        /* Custom-link badge — ⇄ + count, in the same violet as the tree's
           dashed link curves so the association reads at a glance. */
        if (node.links.length > 0) {
          ctx.fillStyle = 'rgba(178, 156, 224, 0.85)';
          ctx.font = `9px 'JetBrains Mono', 'Geist Mono', monospace`;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(`⇄${node.links.length}`, badgeX, p.y + p.h / 2 + 0.5);
          badgeX -= 8 + ctx.measureText(`⇄${node.links.length}`).width;
        }

        /* Tag dot */
        if (node.tags.length > 0) {
          const tag = node.tags[0];
          const tc = TAG_COLORS[tag];
          if (tc && tc !== 'transparent') {
            ctx.fillStyle = tc;
            ctx.beginPath();
            ctx.arc(badgeX, p.y + p.h / 2, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      /* Flow particles */
      if (particlesEnabledRef.current) {
        for (const p of particlesRef.current) {
          const link = linkPathsRef.current[p.linkIdx];
          if (!link || link.networkIdx !== i) continue;
          const pt = particlePosition(link, p.progress);
          /* Soft glow */
          ctx.fillStyle = hexToRgba(link.color, 0.25);
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
          ctx.fill();
          /* Core */
          ctx.fillStyle = link.color;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
    }

    /* ── Drag-to-reorder overlay (drawn last, on top of everything) ── */
    const drag = dragStateRef.current;
    if (drag && drag.active) {
      const dp = nodePositionsRef.current.get(drag.nodeId);
      if (dp) {
        /* Dashed gold outline around the dragged row — Task 115: the gold
           is the THEME's gold (canvasInk), same alpha/weight. */
        ctx.save();
        ctx.translate(0, -scrollY);
        ctx.strokeStyle = hexWithAlpha(canvasInk().goldLight, 0.85);
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(dp.x + 0.5, dp.y + 0.5, dp.w - 1, dp.h - 1);
        ctx.restore();
      }
      const drop = drag.drop;
      if (drop) {
        const tp = nodePositionsRef.current.get(drop.targetId);
        if (tp) {
          const gapHalf = VERTICAL_GAP / 2;
          const lineY = drop.before ? tp.y - gapHalf : tp.y + tp.h + gapHalf;
          ctx.save();
          ctx.translate(0, -scrollY);
          /* Gold insertion line across the column at the drop position
             (Task 94 — rides the theme's gold-light like the rest of the ink) */
          ctx.strokeStyle = C.labelCur;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(tp.x - 6, lineY);
          ctx.lineTo(tp.x + tp.w, lineY);
          ctx.stroke();
          /* Direction marker */
          ctx.fillStyle = C.labelCur;
          ctx.beginPath();
          ctx.moveTo(tp.x - 2, lineY - 4);
          ctx.lineTo(tp.x - 2, lineY + 4);
          ctx.lineTo(tp.x + 5, lineY);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }, []);

  /* ──────────────────────────────────────────────────────────
     Particle animation rAF (sleeps after PARTICLE_SLEEP_MS of idle)
     ────────────────────────────────────────────────────────── */
  const startRaf = useCallback(() => {
    if (rafRef.current !== null) return;
    if (!particlesEnabledRef.current) return;
    lastFrameTsRef.current = performance.now();
    lastInteractionRef.current = Date.now();
    /* Cap the particle loop at ~30fps: rAF fires at 60/120Hz but a full
     * canvas redraw every tick is wasteful. Skipping frames halves the
     * paint cost with zero visual difference for slow-moving dots. */
    let lastDrawTs = 0;
    const loop = (ts: number) => {
      const dt = Math.min(64, ts - lastFrameTsRef.current);
      lastFrameTsRef.current = ts;

      /* Advance particles (always — keeps motion time-accurate) */
      for (const p of particlesRef.current) {
        p.progress += dt / PARTICLE_TRAVEL_MS;
        if (p.progress >= 1) p.progress -= 1;
      }

      /* Redraw at most every ~33ms */
      if (ts - lastDrawTs >= 33) {
        lastDrawTs = ts;
        drawAll();
      }

      /* Sleep check */
      if (Date.now() - lastInteractionRef.current > PARTICLE_SLEEP_MS) {
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [drawAll]);

  /* Task 91 — repaint on theme switch: the tree's canvas accents (the ◈
     basemap badge) resolve the themed purple at draw time, so a theme
     change only needs one redraw — the DOM around it re-renders via the
     themeId subscription's normal React path. */
  useEffect(() => {
    drawAll();
  }, [themeId, drawAll]);

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /* CPU-only mode: particles are the single biggest idle CPU cost (60fps
   * full-canvas redraws for 2.5s after every mousemove) — force them off.
   * Lives after stopRaf (declared above) to avoid TDZ ordering issues. */
  useEffect(() => {
    particlesEnabledRef.current = particlesEnabled && perfMode !== 'low';
    if (!particlesEnabledRef.current) stopRaf();
  }, [particlesEnabled, perfMode, stopRaf]);

  /* ──────────────────────────────────────────────────────────
     Tooltip
     ────────────────────────────────────────────────────────── */
  const showTooltip = useCallback((nodeId: string, mx: number, my: number) => {
    const tip = tooltipRef.current;
    if (!tip) return;
    let node: CareNode | null = null;
    for (const n of CareSpace.networks()) {
      if (n.nodes[nodeId]) {
        node = n.nodes[nodeId];
        break;
      }
    }
    if (!node) {
      tip.style.display = 'none';
      return;
    }
    const notes = node.notes.slice(-2).reverse();
    const updatedAgo = timeAgo(node.updatedAt);
    /* Phase 5 — the tooltip names the binding (and its brokenness):
     * the same fact the row's ▤/⚠ badge carries, one line lower. */
    const vaultLine = node.vaultPath
      ? `<div class="ct-meta">${
          useNaksha.getState().careVaultMissing[node.vaultPath] ? '⚠ file missing · ' : '▤ bound · '
        }${escapeHtmlSafe(node.vaultPath)}</div>`
      : '';
    const noteHtml =
      notes.length > 0
        ? notes
            .map(
              (n) =>
                `<div class="ct-note">${escapeHtmlSafe(truncate(n.text, 60))} ` +
                `<span class="ct-time">${escapeHtmlSafe(n.timeString)}</span></div>`,
            )
            .join('')
        : '<div class="ct-empty">no notes</div>';

    tip.innerHTML =
      `<div class="ct-title">${escapeHtmlSafe(node.label)}</div>` +
      noteHtml +
      vaultLine +
      `<div class="ct-meta">${node.children.length} ${node.children.length === 1 ? 'child' : 'children'} · ${node.notes.length} ${node.notes.length === 1 ? 'note' : 'notes'} · updated ${escapeHtmlSafe(updatedAgo)}</div>`;

    tip.style.display = 'block';
    /* Position, clamped inside wrap */
    const wrap = wrapRef.current;
    if (wrap) {
      const w = wrap.clientWidth;
      const hWrap = wrap.clientHeight;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let tx = mx + 12;
      let ty = my + 12;
      if (tx + tw > w - 8) tx = mx - tw - 12;
      if (ty + th > hWrap - 8) ty = my - th - 12;
      tip.style.left = `${Math.max(4, tx)}px`;
      tip.style.top = `${Math.max(4, ty)}px`;
    }
  }, []);

  const hideTooltip = useCallback(() => {
    const tip = tooltipRef.current;
    if (tip) tip.style.display = 'none';
  }, []);

  /* ──────────────────────────────────────────────────────────
     Hit testing
     ────────────────────────────────────────────────────────── */
  const hitTestNode = useCallback((mx: number, my: number): NodePos | null => {
    for (const [, p] of nodePositionsRef.current.entries()) {
      if (mx >= p.x && mx <= p.x + p.w && my >= p.y && my <= p.y + p.h) {
        return p;
      }
    }
    return null;
  }, []);

  const hitTestHeader = useCallback((mx: number, my: number): number | null => {
    for (const hb of headerBarsRef.current) {
      if (mx >= hb.x && mx <= hb.x + hb.w && my >= hb.y && my <= hb.y + hb.h) {
        return hb.networkIdx;
      }
    }
    return null;
  }, []);

  /* Task 40 — the ◈ basemap badge occupies the right 20px of a bound
   * river's header (painted in drawAll). Hit-testing derives from the
   * SAME headerBars layout — no new refs, no paint changes, zero idle
   * cost. A hit makes the badge a CLICK TARGET: it opens the netlayer
   * picker for that river on the map pane (the badge becomes the
   * cross-pane bridge Task 38's list promised). */
  const BADGE_HIT_WIDTH = 20;
  const hitTestHeaderBadge = useCallback((mx: number, my: number): number | null => {
    for (const hb of headerBarsRef.current) {
      if (mx >= hb.x + hb.w - BADGE_HIT_WIDTH && mx <= hb.x + hb.w && my >= hb.y && my <= hb.y + hb.h) {
        return hb.networkIdx;
      }
    }
    return null;
  }, []);

  /* ──────────────────────────────────────────────────────────
     Setup effect — runs once on mount
     ────────────────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    /* Debounced resize via ResizeObserver */
    const resize = debounce(() => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvasSizeRef.current = { w, h };
      computeLayout();
      drawAll();
      /* Wake particles on resize (data hasn't changed but layout did) */
      lastInteractionRef.current = Date.now();
      if (particlesEnabledRef.current && rafRef.current === null) startRaf();
    }, 100);

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    /* Throttled mousemove (30fps — CPU-friendly) */
    const onMouseMove = throttle((e: MouseEvent) => {
      lastInteractionRef.current = Date.now();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const myCanvas = e.clientY - rect.top;
      const myContent = myCanvas + scrollYRef.current;

      /* ── Drag-to-reorder (takes over the pointer while active) ── */
      const drag = dragStateRef.current;
      if (drag) {
        /* Button released outside the canvas → cancel */
        if (drag.active && e.buttons === 0) {
          dragStateRef.current = null;
          canvas.style.cursor = 'default';
          drawAll();
          return;
        }
        if (!drag.active) {
          if (Math.abs(mx - drag.startX) + Math.abs(myCanvas - drag.startY) > 6) {
            drag.active = true;
            didDragRef.current = true;
            hideTooltip();
            canvas.style.cursor = 'grabbing';
          }
        }
        if (drag.active) {
          const hit = hitTestNode(mx, myContent);
          let drop: { targetId: string; before: boolean } | null = null;
          if (hit && hit.networkIdx === drag.networkIdx && hit.nodeId !== drag.nodeId) {
            const net = CareSpace.networks()[drag.networkIdx];
            const target = net?.nodes[hit.nodeId];
            const dragged = net?.nodes[drag.nodeId];
            /* Can't drop on/below the core, into the dragged node's own
               subtree, or across networks. */
            if (
              target &&
              dragged &&
              target.parentId !== null &&
              !CareSpace.isDescendant(hit.nodeId, drag.nodeId)
            ) {
              drop = { targetId: hit.nodeId, before: myContent < hit.y + hit.h / 2 };
            }
          }
          const changed =
            (drag.drop?.targetId ?? null) !== (drop?.targetId ?? null) ||
            (drag.drop?.before ?? false) !== (drop?.before ?? false);
          drag.drop = drop;
          if (changed) drawAll();
          return; /* no hover/tooltip while dragging */
        }
      }

      const headerHit = hitTestHeader(mx, myCanvas);
      const pos = hitTestNode(mx, myContent);
      const newHovered = pos ? pos.nodeId : null;

      let needRedraw = false;
      if (newHovered !== hoveredNodeRef.current) {
        hoveredNodeRef.current = newHovered;
        needRedraw = true;
        if (newHovered) {
          showTooltip(newHovered, mx, myCanvas);
        } else {
          hideTooltip();
        }
      } else if (newHovered) {
        /* Keep tooltip but update its position to follow cursor */
        showTooltip(newHovered, mx, myCanvas);
      }

      /* Hovered network for column dimming */
      let newHoveredNet: number | null = null;
      if (headerHit !== null) {
        newHoveredNet = headerHit;
      } else if (pos) {
        newHoveredNet = pos.networkIdx;
      }
      if (newHoveredNet !== hoveredNetworkRef.current) {
        hoveredNetworkRef.current = newHoveredNet;
        needRedraw = true;
      }

      canvas.style.cursor = pos || headerHit !== null ? 'pointer' : 'default';

      /* Wake particles */
      if (rafRef.current === null && particlesEnabledRef.current) {
        startRaf();
      } else {
        lastInteractionRef.current = Date.now();
      }

      if (needRedraw) drawAll();
    }, 33); // 30fps — CPU-friendly

    const onClick = (e: MouseEvent) => {
      lastInteractionRef.current = Date.now();
      /* The click event fires right after a drag mouseup — ignore it so
         dropping a node doesn't navigate into it. */
      if (didDragRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const myCanvas = e.clientY - rect.top;
      const myContent = myCanvas + scrollYRef.current;

      /* Column header? */
      const headerHit = hitTestHeader(mx, myCanvas);
      if (headerHit !== null) {
        /* Task 40 — ◈ badge FIRST: the right edge of a bound river's
           header opens the netlayer picker for THAT river instead of
           switching networks. Unbound headers fall through unchanged. */
        const badgeHit = hitTestHeaderBadge(mx, myCanvas);
        if (badgeHit !== null) {
          const badgeNet = CareSpace.networks()[badgeHit];
          if (badgeNet?.mapLayer) {
            window.dispatchEvent(
              new CustomEvent('naksha:open-netlayer-picker', { detail: { netId: badgeNet.id } }),
            );
            useNaksha
              .getState()
              .print(`◈ "${badgeNet.name}" — pick its basemap on the map pane`, 'info');
            return;
          }
        }
        const net = CareSpace.networks()[headerHit];
        if (net && headerHit !== CareSpace.data.currentNetworkIndex) {
          CareSpace.switchNetwork(net.name);
          useNaksha.getState().syncCare();
          useNaksha
            .getState()
            .print(`Switched to network: ${net.name}`, 'info');
        }
        return;
      }

      /* Node? */
      const pos = hitTestNode(mx, myContent);
      if (!pos) return;
      const net = CareSpace.networks()[pos.networkIdx];
      const node = net.nodes[pos.nodeId];
      if (!node) return;

      /* If clicking in a non-current network, switch first */
      if (pos.networkIdx !== CareSpace.data.currentNetworkIndex) {
        CareSpace.switchNetwork(net.name);
      }

      /* Chevron area (left 16px) toggles collapse */
      if (mx - pos.x < CHEVRON_HIT_WIDTH && node.children.length > 0) {
        const res = CareSpace.toggleCollapse(pos.nodeId);
        useNaksha.getState().syncCare();
        if (res.success) {
          useNaksha
            .getState()
            .print(
              `${res.data ? 'Collapsed' : 'Expanded'}: ${node.label}`,
              'info',
            );
        }
        return;
      }

      /* Navigate to this node directly */
      net.currentId = pos.nodeId;
      CareSpace.save();
      useNaksha.getState().syncCare();
      useNaksha.getState().print(`Navigated to: ${node.label}`, 'info');
    };

    /* Right-click → open the node details panel */
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const myCanvas = e.clientY - rect.top;
      const myContent = myCanvas + scrollYRef.current;
      const pos = hitTestNode(mx, myContent);
      if (!pos) return;
      useNaksha.getState().setDetailsNodeId(pos.nodeId);
    };

    /* Double-click → open details too (for touch / accessibility) */
    const onDblClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const myCanvas = e.clientY - rect.top;
      const myContent = myCanvas + scrollYRef.current;
      const pos = hitTestNode(mx, myContent);
      if (!pos) return;
      useNaksha.getState().setDetailsNodeId(pos.nodeId);
    };

    const onMouseLeave = () => {
      hoveredNodeRef.current = null;
      hoveredNetworkRef.current = null;
      /* Leaving the canvas mid-drag cancels the drag (no commit) */
      if (dragStateRef.current?.active) {
        dragStateRef.current = null;
        didDragRef.current = false;
      }
      hideTooltip();
      canvas.style.cursor = 'default';
      drawAll();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      lastInteractionRef.current = Date.now();
      if (rafRef.current === null && particlesEnabledRef.current) {
        startRaf();
      }
      const delta = e.deltaY;
      const next = Math.max(
        0,
        Math.min(maxScrollRef.current, scrollYRef.current + delta),
      );
      if (next !== scrollYRef.current) {
        scrollYRef.current = next;
        drawAll();
      }
    };

    /* mousedown — begin a potential drag (a plain click stays a click) */
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      didDragRef.current = false;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const myCanvas = e.clientY - rect.top;
      const myContent = myCanvas + scrollYRef.current;
      const pos = hitTestNode(mx, myContent);
      if (!pos) {
        dragStateRef.current = null;
        return;
      }
      const net = CareSpace.networks()[pos.networkIdx];
      const node = net?.nodes[pos.nodeId];
      /* The core (parentId null) can't be dragged; the chevron zone is
         reserved for collapse. */
      if (!node || !node.parentId || (mx - pos.x < CHEVRON_HIT_WIDTH && node.children.length > 0)) {
        dragStateRef.current = null;
        return;
      }
      dragStateRef.current = {
        nodeId: pos.nodeId,
        networkIdx: pos.networkIdx,
        startX: mx,
        startY: myCanvas,
        active: false,
        drop: null,
      };
    };

    /* mouseup — commit the reorder / move */
    const onMouseUp = () => {
      const drag = dragStateRef.current;
      dragStateRef.current = null;
      if (!drag || !drag.active) return;
      lastInteractionRef.current = Date.now();
      canvas.style.cursor = 'default';
      if (!drag.drop) {
        drawAll();
        return;
      }
      const net = CareSpace.networks()[drag.networkIdx];
      const dragged = net?.nodes[drag.nodeId];
      const target = net?.nodes[drag.drop.targetId];
      if (!net || !dragged || !target || !dragged.parentId || target.parentId === null) return;
      const parentId = target.parentId;
      const parent = net.nodes[parentId];
      if (!parent) return;
      const after = !drag.drop.before;
      if (dragged.parentId === parentId) {
        /* Same parent — pure reorder (reorderNode's index is post-removal) */
        const preIdx = parent.children.indexOf(drag.drop.targetId);
        const oldIdx = parent.children.indexOf(drag.nodeId);
        const newIndex = preIdx - (oldIdx < preIdx ? 1 : 0) + (after ? 1 : 0);
        const r = CareSpace.reorderNode(drag.nodeId, newIndex);
        if (r.success) {
          useNaksha
            .getState()
            .print(`Reordered: ${dragged.label} → ${newIndex + 1}${['st', 'nd', 'rd'][newIndex] ?? 'th'}`, 'success');
        } else {
          useNaksha.getState().print(r.error!, 'error');
        }
      } else {
        /* Different parent — reparent, then place next to the target */
        const mr = CareSpace.moveNode(drag.nodeId, parentId);
        if (!mr.success) {
          useNaksha.getState().print(mr.error!, 'error');
          useNaksha.getState().syncCare();
          return;
        }
        const freshParent = net.nodes[parentId]!;
        const idx = freshParent.children.indexOf(drag.drop.targetId) + (after ? 1 : 0);
        CareSpace.reorderNode(drag.nodeId, idx);
        useNaksha
          .getState()
          .print(`Moved: ${dragged.label} → inside "${parent.label}"`, 'success');
      }
      useNaksha.getState().syncCare();
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      ro.disconnect();
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('wheel', onWheel);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [computeLayout, drawAll, hitTestNode, hitTestHeader, showTooltip, hideTooltip, startRaf]);

  /* ──────────────────────────────────────────────────────────
     Redraw effect — runs on careRevision / particlesEnabled change
     ────────────────────────────────────────────────────────── */
  useEffect(() => {
    /* CPU-ONLY refinement: in low-perf mode, defer the layout recompute +
     * full repaint to the browser's idle window (bounded at 80ms so it never
     * feels stale). Layout is O(nodes) and the repaint is a full canvas —
     * during bursts of typing/paste this keeps the input thread clean.
     * Normal mode stays synchronous (snappier single-change redraws). */
    let cancelled = false;
    let idleHandle: number | null = null;
    const run = () => {
      if (cancelled) return;
      computeLayout();
      drawAll();
      /* Wake particles on data change */
      lastInteractionRef.current = Date.now();
      if (particlesEnabledRef.current) {
        if (rafRef.current === null) startRaf();
      } else if (rafRef.current !== null) {
        stopRaf();
        drawAll();
      }
    };
    if (perfMode === 'low' && typeof requestIdleCallback === 'function') {
      idleHandle = requestIdleCallback(run, { timeout: 80 }) as unknown as number;
    } else {
      run();
    }
    return () => {
      cancelled = true;
      if (idleHandle !== null && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(idleHandle);
      }
    };
  }, [careRevision, particlesEnabled, perfMode, computeLayout, drawAll, startRaf, stopRaf]);

  /* Phase 5 — binding markers change server-side (SSE → vaultRevision
     bumps and the store re-probes); careVaultRevision redraws the tree
     so ▤/⚠ always match reality. */
  const careVaultRevision = useNaksha((s) => s.careVaultRevision);
  useEffect(() => {
    drawAll();
  }, [careVaultRevision, drawAll]);

  /* ──────────────────────────────────────────────────────────
     Task 49 — arrival flash on the tree. When a ⇥ deep link lands (the
     same detailsFlashTs the panel's gold ring consumes), the selected
     row pulses once: a gold wash + edge that fades over ~0.9s. A
     PRIVATE rAF burst runs the fade (independent of particles — it
     must animate even with particles off), then fully stops: nothing
     at rest, no loop after the pulse. Perf-low skips entirely (parity
     with the panel ring's gate). Graph view skips — the tree isn't
     visible, so there's nothing to announce to. */
  useEffect(() => {
    if (!detailsFlashTs) return;
    if (useNaksha.getState().settings.perfMode === 'low') return;
    if (useNaksha.getState().careViewMode !== 'tree') return;
    treeFlashRef.current = Date.now() + 900;
    let raf = 0;
    const loop = () => {
      drawAll();
      if (treeFlashRef.current > Date.now()) {
        raf = requestAnimationFrame(loop);
      } else {
        treeFlashRef.current = 0;
        drawAll();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [detailsFlashTs, drawAll]);

  /* ──────────────────────────────────────────────────────────
     Breadcrumb click — walk up to ancestor
     ────────────────────────────────────────────────────────── */
  const navigateToBreadcrumb = useCallback((index: number) => {
    const crumbs = CareSpace.getBreadcrumb();
    const steps = crumbs.length - 1 - index;
    for (let i = 0; i < steps; i++) {
      CareSpace.navigateTo('..');
    }
    useNaksha.getState().syncCare();
    const target = crumbs[index];
    if (target) {
      useNaksha.getState().print(`Navigated to: ${target}`, 'info');
    }
  }, []);

  /* ──────────────────────────────────────────────────────────
     Render
     ────────────────────────────────────────────────────────── */
  const curNetColor = CareSpace.currentNetwork().color;

  return (
    <section
      className="naksha-glass flex flex-col"
      style={{
        height: '100%',
        width: '100%',
        borderRadius: 8,
        overflow: 'hidden',
      }}
      aria-label="CareSpace tree map"
      role="region"
    >
      {/* Header (40px) */}
      <header
        className="flex items-center justify-between"
        style={{
          height: 40,
          padding: '0 12px',
          borderBottom: '1px solid var(--naksha-border)',
          flexShrink: 0,
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 'var(--naksha-fs-sm)',
            letterSpacing: '0.06em',
            color: 'var(--naksha-text)',
            flexShrink: 0,
            userSelect: 'none',
          }}
        >
          care
          <em
            style={{
              color: 'var(--naksha-gold-light)',
              fontStyle: 'normal',
              fontWeight: 600,
            }}
          >
            space
          </em>
        </div>

        {/* View mode toggle */}
        <button
          type="button"
          onClick={() => setViewMode(viewMode === 'tree' ? 'graph' : 'tree')}
          title={viewMode === 'tree' ? 'Switch to force-graph view' : 'Switch to tree view'}
          /* Task 106 — the label shows the CURRENT mode, so the accessible
             name must announce the ACTION (what clicking does), not echo
             the state a sighted user already reads. */
          aria-label={viewMode === 'tree' ? 'Switch to graph view' : 'Switch to tree view'}
          style={{
            padding: '2px 8px',
            borderRadius: 4,
            /* Task 106 — ONE skin for both modes. The old gold-vs-muted
               split dressed graph as "selected" and tree as inactive,
               which is exactly what made the shows-current label read as
               shows-target (Task 105's field evidence — the operator
               misread it twice). The glyph + word carry the state; the
               chip is a control, not a status lamp. text-2 not text-3:
               with the state styling gone, the 9px state word is the
               only state signal left, and load-bearing text rides the
               legible tier (Task 103's AA rule). */
            background: 'color-mix(in srgb, var(--naksha-wash) 50%, transparent)',
            border: '1px solid var(--naksha-border)',
            fontSize: 'var(--naksha-fs-xs)',
            color: 'var(--naksha-text-2)',
            cursor: 'pointer',
            flexShrink: 0,
            userSelect: 'none',
          }}
        >
          {viewMode === 'tree' ? '◉ tree' : '◈ graph'}
        </button>

        <nav
          className="naksha-scroll"
          aria-label="Breadcrumb"
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            overflowX: 'auto',
            overflowY: 'hidden',
            fontSize: 'var(--naksha-fs-xs)',
            scrollbarWidth: 'thin',
            whiteSpace: 'nowrap',
          }}
        >
          {/* Task 115 — the trail shows the PATH BACK, not where you
              are: the chip beside it already names the current node,
              and the old trail's disabled last crumb duplicated it —
              at narrow panes (caresolution 25) the flex squeeze crushed
              the duplication into a 2-character sliver of dead ink.
              Ancestors only now, every crumb clickable; no ancestors
              renders the honest dash the empty state already had. */}
          {(() => {
            const trail = breadcrumb.slice(0, -1);
            if (trail.length === 0) {
              return <span style={{ color: 'var(--naksha-text-4)' }}>—</span>;
            }
            return trail.map((crumb, i) => (
              <span
                key={`${i}-${crumb}`}
                style={{ display: 'inline-flex', alignItems: 'center' }}
              >
                {i > 0 && (
                  <span
                    style={{
                      color: 'var(--naksha-text-4)',
                      margin: '0 2px',
                    }}
                  >
                    /
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => navigateToBreadcrumb(i)}
                  style={{
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                    color: 'var(--naksha-text-2)',
                    background: 'none',
                    border: 'none',
                    padding: '2px 4px',
                    cursor: 'pointer',
                    borderRadius: 3,
                    maxWidth: 140,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    transition: 'color 0.12s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color =
                      'var(--naksha-gold-light)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = 'var(--naksha-text-2)';
                  }}
                >
                  {crumb}
                </button>
              </span>
            ));
          })()}
        </nav>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 8px',
            borderRadius: 4,
            background: 'color-mix(in srgb, var(--naksha-gold) 8%, transparent)',
            border: '1px solid var(--naksha-border)',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: curNetColor,
            }}
            aria-hidden="true"
          />
          <span
            style={{
              fontSize: 'var(--naksha-fs-xs)',
              color: 'var(--naksha-text)',
              maxWidth: 120,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={currentNetworkName}
          >
            {currentNetworkName}
          </span>
        </div>
      </header>

      {/* Canvas wrap (flex: 1) */}
      <div
        ref={wrapRef}
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          minHeight: 0,
        }}
      >
        {/* Tree canvas — only visible in tree mode */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: viewMode === 'tree' ? 'block' : 'none',
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ display: 'block' }}
            aria-label="CareSpace tree map canvas"
            role="tree"
          />
          <div
            ref={tooltipRef}
            className="care-tooltip"
            style={{
              position: 'absolute',
              display: 'none',
              pointerEvents: 'none',
              zIndex: 10,
              background: 'var(--naksha-glass-strong)',
              backdropFilter: 'blur(12px) saturate(140%)',
              WebkitBackdropFilter: 'blur(12px) saturate(140%)',
              border: '1px solid var(--naksha-border-2)',
              borderRadius: 6,
              padding: '8px 10px',
              maxWidth: 240,
              boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            }}
          >
            {/* filled by showTooltip() */}
          </div>
        </div>

        {/* Force graph — only visible in graph mode */}
        {viewMode === 'graph' && (
          <CareSpaceForceGraph onToggleView={() => setViewMode('tree')} viewMode="graph" />
        )}
      </div>

      {/* Footer (32px) */}
      <footer
        className="flex items-center justify-between"
        style={{
          height: 32,
          padding: '0 12px',
          borderTop: '1px solid var(--naksha-border)',
          fontSize: 'var(--naksha-fs-xs)',
          color: 'var(--naksha-text-3)',
          flexShrink: 0,
          gap: 8,
        }}
      >
        <span>
          nodes <span style={{ color: 'var(--naksha-gold-light)' }}>{careStats.totalNodes}</span>
          {' · '}
          notes <span style={{ color: 'var(--naksha-gold-light)' }}>{careStats.totalNotes}</span>
          {careStats.pinnedLocations > 0 && (
            <>
              {' · '}
              {/* Same ◉ glyph as the tree's location badge — thoughts with a
                  place. Violet tint ties it to the map's node-marker layer. */}
              <span style={{ color: 'color-mix(in srgb, var(--naksha-purple) 90%, transparent)' }}>◉ {careStats.pinnedLocations}</span>
              <span style={{ opacity: 0.7 }}> on map</span>
            </>
          )}
        </span>
        <span style={{ opacity: 0.85 }}>drag to reorder · click to navigate</span>
      </footer>

      {/* Tooltip styles (scoped) */}
      <style>{`
        .care-tooltip .ct-title {
          color: var(--naksha-gold-light);
          font-size: var(--naksha-fs-sm);
          font-weight: 600;
          margin-bottom: 4px;
          word-break: break-word;
        }
        .care-tooltip .ct-note {
          color: var(--naksha-text);
          font-size: var(--naksha-fs-xs);
          line-height: 1.45;
          margin-bottom: 2px;
          word-break: break-word;
        }
        .care-tooltip .ct-note .ct-time {
          color: var(--naksha-text-4);
          margin-left: 4px;
          font-size: var(--naksha-fs-xs);
        }
        .care-tooltip .ct-empty {
          color: var(--naksha-text-4);
          font-size: var(--naksha-fs-xs);
          font-style: italic;
          margin-bottom: 4px;
        }
        .care-tooltip .ct-meta {
          color: var(--naksha-text-3);
          font-size: var(--naksha-fs-xs);
          margin-top: 4px;
          padding-top: 4px;
          border-top: 1px solid var(--naksha-border);
        }
      `}</style>
    </section>
  );
}

export default CareSpacePane;
