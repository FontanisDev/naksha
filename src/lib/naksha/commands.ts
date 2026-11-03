/**
 * Naksha — Command Registry & Runner
 *
 * Parses command strings, expands aliases, handles output redirection,
 * and dispatches to the right handler. Every command writes its output
 * through the store's `print` so the React terminal renders reactively.
 *
 * Commands are organized in groups:
 *   - File System  (ls, cd, pwd, tree, cat, nano, mkdir, touch, rm, echo, cp, mv, grep, export, import)
 *   - CareSpace     (idea, use, drop, care, allout, node, cdnode, lsnode, treenode, save, notes, find,
 *                    pinat, fly, mvnode, rmnode, rennode, order, link, tag, untag, stats, timeline,
 *                    exporttree, replace, collapse)
 *   - Map           (goto, route, where, whereami, search, measure, pin, pins, jump, clearpins,
 *                    layer, zoom, wiki, open, weather, saveview, views, view, rmview, back, fwd, stream)
 *   - Terminal/Sys  (help, clear, focus, about, settings, storage, alias, unalias, undo, vslice,
 *                    split, history)
 *   - Focus-only    (note, snap, timer, list, done, exit)
 */

import { FileSystem } from './filesystem';
import { CareSpace } from './carespace';
import { MapEngine } from './map-engine';
import { Storage } from './storage';
import { useNaksha } from './store';
import { fetchWiki, fetchWeather, fetchWeatherAt, normalizeUrl } from './reader';
import {
  DEFAULT_NETWORK_NAME,
  ELEVATION_API,
  MAP_LAYERS,
  MAX_NETWORKS,
  NETWORK_COLORS,
  POI_CATEGORIES,
  STORAGE_KEYS,
  TAG_COLORS,
  TAG_PALETTE,
} from './constants';
import { THEMES } from './themes';
import { termCols } from './termcols';
import { applyPerfDocumentAttr, normalizePerfMode } from './perf-tier';
import {
  contextChipLabel,
  contextReceiptTag,
  contextRoutingLine,
  resolveStorageContext,
} from './vault-context';
import { resolveVaultPath, vaultPwdAbs } from './vault-path';
import { splitShapeRel } from './shape-files';
import { vaultMarkdownToHtml } from './vault-markdown';
import {
  appendNoteLine,
  careVaultReadNote,
  careVaultRenameNote,
  careVaultWriteNote,
  deriveChildVaultPath,
  deriveExportVaultPath,
  newNoteContent,
  noteBasename,
} from './care-vault';
import {
  clamp,
  escapeHtml,
  formatCoord,
  formatDistance,
  formatDuration,
  formatSize,
  formatTime,
  haversineKm,
  markdownToHtml,
  sleep,
  splitToPair,
  timeAgo,
  truncate,
} from './utils';
import type {
  AliasMap,
  CareNetwork,
  CareNode,
  MapLayerKey,
  NakshaSettings,
  NodeTag,
  TermLine,
  TermLineType,
  UndoEntry,
  ViewHistoryEntry,
  WeatherReport,
} from './types';
import {
  detectDirection,
  describeDirection,
  sampleAppContent,
} from './direction';

interface CommandDef {
  name: string;
  description: string;
  usage: string;
  category: 'fs' | 'care' | 'map' | 'system' | 'focus';
  handler: (args: string) => void | Promise<void>;
}

/** Count a node's subtree size (itself + all descendants) in the CURRENT
 *  network — used by `dupnode` to report what the clone contains. */
function countSubtree(rootId: string): number {
  const net = CareSpace.currentNetwork();
  let count = 0;
  const walk = (id: string) => {
    const n = net.nodes[id];
    if (!n) return;
    count++;
    n.children.forEach(walk);
  };
  walk(rootId);
  return count;
}

/* Task 56 — the neighbor scan leaves the pins handler and becomes a
 * shared question: "what have I thought within R km of (lat,lng)?"
 * One bounded haversine sweep over EVERY river's located nodes (the
 * same rule `near` speaks — cross-river by design, invocation-only
 * cost, zero at rest). Pins asked it first; views carry coordinates
 * just as well, so both nouns share one helper and one chip verb.
 * Task 57 — RELEVANCE beats raw distance: within the sweep, a thought
 * you WROTE on (notes) or TAGGED (identity color) outranks a bare
 * located thought. Score notes +2 / tag +1; ties break by distance;
 * an all-plain field falls back to pure proximity (the old answer).
 * The row marks the pick (▤ noted / ● tagged) so "why THIS one?"
 * answers itself; the footer states the rule.
 * Task 58 — the COUNT rides along (notes: number, not a flag) so the
 * mark can speak ▤N exactly as the map label does, and score TIES
 * prefer the CURRENT river: equal relevance → the thought in the
 * river you're exploring wins; a cross-river candidate must be
 * strictly higher-scored, or nearer on the same side of the fence.
 * Task 59 — `remote` rides the return so rows can NAME the pick's
 * river when the chip reached across (a cross-river surprise shouldn't
 * be anonymous). */
function nearestThought(
  lat: number,
  lng: number,
  radiusKm: number,
): { nodeId: string; river: string; label: string; d: number; notes: number; tagged: boolean; tagColor?: string; remote: boolean } | null {
  let best: { nodeId: string; river: string; label: string; d: number; notes: number; tagged: boolean; tagColor?: string; remote: boolean } | null = null;
  let bestScore = -1;
  let bestRemote = false;
  const curId = CareSpace.currentNetwork().id;
  for (const net of CareSpace.networks()) {
    const remote = net.id !== curId;
    for (const node of Object.values(net.nodes)) {
      if (!node.location) continue;
      const d = haversineKm(lat, lng, node.location.lat, node.location.lng);
      if (d > radiusKm) continue;
      const notes = node.notes.length;
      const firstTag = node.tags.filter((t) => t && t !== 'none')[0];
      const tagged = !!firstTag;
      /* Task 70 — the pick's identity color rides along: the map-side
       * badges (search/pins/views rows) tint with it, same rule the
       * care and links rows already speak — every chip a swatch. */
      const tagColor = firstTag ? TAG_COLORS[firstTag] : undefined;
      const score = (notes > 0 ? 2 : 0) + (tagged ? 1 : 0);
      if (score < bestScore) continue;
      if (
        !best ||
        score > bestScore ||
        (score === bestScore && ((bestRemote && !remote) || (remote === bestRemote && d < best.d)))
      ) {
        best = { nodeId: node.id, river: net.name, label: node.label, d, notes, tagged, tagColor, remote };
        bestScore = score;
        bestRemote = remote;
      }
    }
  }
  return best;
}

/* Task 70 — is this POI already a thought? nodefrom's mirror of the
 * demo location-guard (Task 68): a node whose label matches the pin's
 * (case-insensitive) AND sits within 100 m of its coordinates, in ANY
 * river. nodefrom stores the pin's own numbers verbatim, so exact
 * round-trips land at distance zero; 100 m absorbs only float noise.
 * A renamed thought legitimately escapes the net — its identity
 * changed, a fresh plant is fair. */
function findPlantedThought(
  label: string,
  lat: number,
  lng: number,
): { node: CareNode; net: CareNetwork; tagColor?: string } | null {
  const lower = label.toLowerCase();
  for (const net of CareSpace.networks()) {
    for (const node of Object.values(net.nodes)) {
      if (node.label.toLowerCase() !== lower || !node.location) continue;
      const dKm = Math.hypot(
        (node.location.lat - lat) * 111,
        (node.location.lng - lng) * 111 * Math.cos((lat * Math.PI) / 180),
      );
      if (dKm <= 0.1) {
        const t = node.tags.filter((x) => x && x !== 'none')[0];
        return { node, net, tagColor: t ? TAG_COLORS[t] : undefined };
      }
    }
  }
  return null;
}

/* Task 57 — one parse for both list commands: a positive number in the
 * args sets the sweep radius; anything else keeps the 5km default.
 * fmtKm echoes it the way a human typed it (5 / 2.5 / 500). */
function parseRadiusKm(args: string): number {
  const n = parseFloat(args.trim());
  return !isNaN(n) && n > 0 ? n : 5;
}
function fmtKm(km: number): string {
  return km % 1 === 0 ? String(km) : km.toFixed(1);
}

/* Task 58 — the counted ▤ mark, one builder for every list row that
 * wears it: bare ▤ = one note, ▤N = N notes, ▤9+ caps (a 40-note
 * thought must not turn a terminal row into a spreadsheet column).
 * The graph label's glyph speaks the same dialect (its own builder
 * lives beside the painter it sizes). */
function notesMark(notes: number): string {
  return notes > 9 ? '▤9+' : notes > 1 ? `▤${notes}` : '▤';
}

/* Phase 3 — shared storage-context choice applier. Used by BOTH the
 * `context` command and `settings storageContext <x>` so validation,
 * receipts and persistence can never drift apart. Returns false when
 * the choice was rejected (prints its own error). */
function applyStorageContextChoice(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value !== 'internal' && value !== 'connected') {
    useNaksha.getState().print(`Unknown storage context: ${raw} — use internal | connected`, 'error');
    return false;
  }
  const s = useNaksha.getState();
  if (value === 'connected') {
    const vs = s.vaultStatus;
    if (!vs?.connected || !vs.available) {
      useNaksha.getState().print(
        !vs?.connected
          ? 'No vault connected — vault connect <ABSOLUTE path> first, then context connected'
          : `The connected directory (${vs.name}) is unavailable — reconnect it first`,
        'error',
      );
      return false;
    }
  }
  s.setSettings({ storageContext: value });
  const resolved = resolveStorageContext(value, s.vaultStatus);
  if (value === 'internal') {
    const wasFallback = resolved.reason === 'fallback-unavailable';
    useNaksha.getState().print(
      wasFallback
        ? 'Storage context → internal (saved connected stays saved; it just cannot be honored right now)'
        : 'Storage context → internal — every surface works on the browser-side virtual FS',
      'success',
    );
  } else {
    useNaksha.getState().print(`Storage context → connected:${resolved.name ?? '?'}`, 'success');
  }
  useNaksha.getState().print(`  ${contextRoutingLine(resolved)}`, 'muted');
  return true;
}

/* Task 93 — width-aware sheets. The mono face made padEnd columns
 * truly align AND made every fixed pad a lie: the sheets were authored
 * for a proportional font's narrower metrics, and at the default pane
 * (~35 columns) a padEnd(34) help sheet wrapped every row. Sheets now
 * read the terminal's live char capacity (termcols.ts, measured by
 * TerminalPane's ResizeObserver) and reflow like man pages:
 *
 *   wide row  → `  left    right`   (the classic two-column, shared
 *                                     pad so columns still align)
 *   tight row → `  left` + `      right` (indented, muted — the
 *                                     description becomes its own line)
 *
 * `pad` caps at the longest left value (a sheet of short verbs must
 * not inherit padEnd(34)'s dead space); pass padFixed to keep a
 * label-column contract instead (the `help <cmd>` card's usage /
 * category / aliases column). The stack indent defaults to 6; the card
 * aligns its continuation with the value column (14) instead. */
function sheetRows(
  rows: Array<[left: string, right: string]>,
  opts?: { pad?: number; padFixed?: number; stackIndent?: number; rightTone?: TermLineType },
): void {
  const s = useNaksha.getState();
  const budget = termCols();
  /* pad = the shared column start: capped by padCap, never narrower
   * than the LONGEST left value (Math.max first — spreading the lengths
   * into the min would take the SHORTEST and collapse every column),
   * and never wider than the pane's budget can use. */
  const pad = opts?.padFixed ?? Math.min(opts?.pad ?? 34, Math.max(...rows.map(([l]) => l.length)), budget - 4);
  const indent = ' '.repeat(opts?.stackIndent ?? 6);
  const rightTone = opts?.rightTone ?? 'muted';
  for (const [l, r] of rows) {
    if (2 + pad + 1 + r.length <= budget) {
      s.print(`  ${l.padEnd(pad)} ${r}`, 'output');
    } else {
      s.print(`  ${l}`, 'output');
      printIndentedWrapped(indent, r, rightTone);
    }
  }
}

/* Task 115 — a stacked right-side line must wrap like the man page it
 * imitates: greedy word-packing at the live budget, continuations keep
 * the stack indent. Before the theme fonts were wired, the measured
 * budget overcounted (the terminal computed Inter's narrower advance
 * while the receipts rendered mono) and these lines happened to fit;
 * the honest 7.8px JetBrains advance exposed flush-left orphans
 * ("change)", "to toggle)", "to exit)") — a continuation that loses
 * its column is not a reflow, it's a broken row. Empty tokens from the
 * authored double-space ("value␣␣(hint)") survive packing inside a
 * chunk; only a chunk boundary may swallow one. */
function printIndentedWrapped(indent: string, text: string, tone: TermLineType): void {
  const budget = termCols();
  const room = Math.max(8, budget - indent.length);
  const words = text.split(' ');
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    /* `room` already subtracts the indent — compare the chunk alone,
     * or the indent is paid twice and rows break early. */
    if (next.length > room && cur) {
      useNaksha.getState().print(`${indent}${cur}`, tone);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) useNaksha.getState().print(`${indent}${cur}`, tone);
}

/* Task 93 — truncate-to-budget for single-line data rows (rivers,
 * near, views): the row keeps its radar-table shape by giving the
 * LABEL the room that's left, never by wrapping the table. */
function fitLabel(label: string, room: number): string {
  return truncate(label, Math.max(6, room));
}

/** Pluralize a count the way the sheets say it: "1 node", "3 nodes". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Build a standalone, self-contained HTML document that embeds the
 * entire CareSpace (all networks, nodes, notes) with the warm glass
 * styling. The resulting file can be opened in any browser offline —
 * a portable snapshot of the user's thought tree.
 */
function buildStandaloneHTML(): string {
  const nets = CareSpace.networks();
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const renderNode = (node: CareNode, depth: number, netColor: string): string => {
    const indent = depth * 24;
    const noteList = node.notes
      .map(
        (n) => `
        <li class="note">
          <span class="note-time">${esc(n.timeString)}</span>
          <span class="note-text">${esc(n.text)}</span>
        </li>`,
      )
      .join('');
    const locBadge = node.location
      ? `<span class="badge loc" title="${node.location.lat.toFixed(4)}, ${node.location.lng.toFixed(4)}">◉</span>`
      : '';
    const notesBadge = node.notes.length > 0 ? `<span class="badge notes">${node.notes.length}</span>` : '';
    const tagDot =
      node.tags.length > 0 && node.tags[0] !== 'none'
        ? `<span class="badge tag" style="background:${TAG_COLORS[node.tags[0]]}"></span>`
        : '';

    return `
      <div class="node" style="margin-left:${indent}px; border-left-color:${netColor}">
        <div class="node-head">
          <span class="node-label">${esc(node.label)}</span>
          ${notesBadge}${locBadge}${tagDot}
        </div>
        ${node.notes.length > 0 ? `<ul class="notes">${noteList}</ul>` : ''}
        ${node.children.map((cid) => renderNode(CareSpace.currentNetwork().nodes[cid] ?? (nets[0].nodes[cid] as CareNode), depth + 1, netColor)).join('')}
      </div>`;
  };

  const networksHTML = nets
    .map((net) => {
      const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null);
      if (!rootId) return '';
      const nodeCount = Object.keys(net.nodes).length;
      const noteCount = Object.values(net.nodes).reduce((s, n) => s + n.notes.length, 0);
      return `
      <section class="network" data-color="${net.color}">
        <header class="net-header" style="border-bottom-color:${net.color}">
          <span class="net-dot" style="background:${net.color}"></span>
          <h2>${esc(net.name)}</h2>
          <span class="net-stats">${nodeCount} nodes · ${noteCount} notes</span>
        </header>
        <div class="tree">
          ${renderNode(net.nodes[rootId], 0, net.color)}
        </div>
      </section>`;
    })
    .join('');

  const generated = new Date().toISOString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Naksha CareSpace Export — ${esc(new Date().toLocaleDateString())}</title>
<style>
  :root {
    /* v138 T3 — the export wears the theme's own re-toned paper
     * (gunmetal + shiny gold), in parity with amber-night's tokens. */
    --bg: #0e1013; --bg2: #15181c; --glass: rgba(28,32,38,0.72);
    --text: #e7eaf0; --text2: #9aa3b2; --text3: #5d6673; --text4: #3e4650;
    --gold: #ffd700; --gold-light: #ffe55c; --cream: #eef1f7;
    --border: rgba(255,215,0,0.14); --border2: rgba(255,215,0,0.28);
    --mono: 'JetBrains Mono','Fira Code','Consolas',monospace;
    --ui: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background:
      radial-gradient(ellipse 150% 42% at 50% 112%, rgba(255,215,0,0.07), transparent 58%),
      linear-gradient(180deg, #090b0d 0%, #0e1013 42%, #13161a 78%, #1c2026 100%);
    background-attachment: fixed;
    color: var(--text); font-family: var(--ui); min-height: 100vh; padding: 40px 20px;
  }
  .container { max-width: 900px; margin: 0 auto; }
  header.page-head {
    text-align: center; padding: 40px 20px 32px; border-bottom: 1px solid var(--border); margin-bottom: 40px;
  }
  header.page-head h1 {
    font-family: var(--mono); font-size: 28px; font-weight: 600;
    color: var(--gold-light); letter-spacing: 2px; margin-bottom: 8px;
  }
  header.page-head p { color: var(--text3); font-size: 13px; font-family: var(--mono); }
  .network {
    background: var(--glass); backdrop-filter: blur(10px);
    border: 1px solid var(--border); border-radius: 12px; margin-bottom: 24px; overflow: hidden;
  }
  .net-header {
    display: flex; align-items: center; gap: 12px; padding: 16px 20px;
    border-bottom: 1px solid var(--border2); background: rgba(34,30,24,0.6);
  }
  .net-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .net-header h2 { font-family: var(--mono); font-size: 16px; font-weight: 600; color: var(--gold-light); flex: 1; }
  .net-stats { font-family: var(--mono); font-size: 10px; color: var(--text3); }
  .tree { padding: 16px 20px; }
  .node { padding: 8px 0 8px 12px; border-left: 2px solid var(--border); margin-bottom: 4px; }
  .node-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .node-label { font-family: var(--mono); font-size: 13px; font-weight: 500; color: var(--text); flex: 1; }
  .badge { font-family: var(--mono); font-size: 10px; padding: 1px 6px; border-radius: 8px; }
  .badge.notes { background: rgba(255,215,0,0.15); color: var(--gold-light); }
  .badge.loc { color: #7a9ec2; background: rgba(122,158,194,0.1); }
  .badge.tag { width: 8px; height: 8px; border-radius: 50%; padding: 0; }
  .notes { list-style: none; margin-top: 4px; }
  .note { padding: 4px 0 4px 12px; font-family: var(--mono); font-size: 12px; color: var(--text2); line-height: 1.6; }
  .note-time { color: var(--text4); margin-right: 10px; font-size: 10px; }
  footer { text-align: center; padding: 32px 0; color: var(--text4); font-family: var(--mono); font-size: 10px; }
  footer a { color: var(--gold); text-decoration: none; }
  @media print { body { background: white; color: black; } .network { border-color: #ccc; } }
</style>
</head>
<body>
<div class="container">
  <header class="page-head">
    <h1>NAKSHA · CARESPACE</h1>
    <p>Exported ${esc(new Date().toLocaleString())} · ${nets.length} network${nets.length === 1 ? '' : 's'}</p>
  </header>
  ${networksHTML}
  <footer>
    Generated by Naksha — the geographic shell.<br>
    <a href="https://github.com">Open in Naksha</a> · ${esc(generated)}
  </footer>
</div>
</body>
</html>`;
}

/**
 * Build a print-friendly HTML document for the `exportpdf` command.
 * Optimized for A4 paper: white background, black text, clean typography,
 * page-break-aware sections. The user selects "Save as PDF" in the print dialog.
 */
function buildPrintableHTML(): string {
  const nets = CareSpace.networks();
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const renderNode = (node: CareNode, depth: number, netColor: string): string => {
    const indent = depth * 20;
    const noteList = node.notes
      .map(
        (n) => `<li class="note"><span class="note-time">${esc(n.timeString)}</span> ${esc(n.text)}</li>`,
      )
      .join('');
    return `
      <div class="node" style="margin-left:${indent}px; border-left:3px solid ${netColor}">
        <div class="node-label">${esc(node.label)}</div>
        ${node.notes.length > 0 ? `<ul class="notes">${noteList}</ul>` : ''}
        ${node.children.map((cid) => renderNode(CareSpace.currentNetwork().nodes[cid] ?? (nets[0].nodes[cid] as CareNode), depth + 1, netColor)).join('')}
      </div>`;
  };

  const networksHTML = nets
    .map((net) => {
      const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null);
      if (!rootId) return '';
      const nodeCount = Object.keys(net.nodes).length;
      const noteCount = Object.values(net.nodes).reduce((s, n) => s + n.notes.length, 0);
      return `
      <section class="network" style="page-break-inside: avoid;">
        <h2 style="border-bottom: 2px solid ${net.color}; color: ${net.color};">
          <span class="net-dot" style="background:${net.color}"></span>
          ${esc(net.name)}
          <span class="net-stats">${nodeCount} nodes · ${noteCount} notes</span>
        </h2>
        <div class="tree">
          ${renderNode(net.nodes[rootId], 0, net.color)}
        </div>
      </section>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Naksha CareSpace — ${esc(new Date().toLocaleDateString())}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Georgia', 'Times New Roman', serif; color: #1a1a1a; line-height: 1.6; font-size: 11pt; }
  h1 { font-size: 22pt; font-weight: 600; text-align: center; margin-bottom: 4pt; letter-spacing: 1pt; }
  .subtitle { text-align: center; color: #666; font-size: 10pt; margin-bottom: 24pt; font-style: italic; }
  .network { margin-bottom: 24pt; page-break-inside: avoid; }
  .network h2 { font-size: 14pt; font-weight: 600; padding-bottom: 4pt; margin-bottom: 8pt; display: flex; align-items: center; gap: 8pt; }
  .net-dot { width: 10pt; height: 10pt; border-radius: 50%; display: inline-block; }
  .net-stats { margin-left: auto; font-size: 9pt; color: #888; font-weight: 400; }
  .node { padding: 4pt 0 4pt 8pt; margin-bottom: 2pt; }
  .node-label { font-weight: 600; font-size: 11pt; margin-bottom: 2pt; }
  .notes { list-style: none; margin: 2pt 0 4pt 8pt; }
  .note { font-size: 10pt; color: #333; padding: 1pt 0; line-height: 1.5; }
  .note-time { color: #999; font-size: 8pt; margin-right: 6pt; font-family: 'Courier New', monospace; }
  footer { margin-top: 32pt; padding-top: 8pt; border-top: 1px solid #ddd; text-align: center; color: #999; font-size: 8pt; }
</style>
</head>
<body>
  <h1>Naksha · CareSpace</h1>
  <p class="subtitle">Exported ${esc(new Date().toLocaleString())} · ${nets.length} network${nets.length === 1 ? '' : 's'}</p>
  ${networksHTML}
  <footer>Generated by Naksha — the geographic shell.</footer>
</body>
</html>`;
}

/** Markdown outline of every CareSpace network — tree structure with notes,
 *  locations, and link counts. Written into the virtual FS by `careout` so
 *  thoughts become ordinary files: editable with nano, greppable, cattable,
 *  printable. Closes the CareSpace → filesystem bridge. */
function buildCareMarkdown(): string {
  const nets = CareSpace.networks();
  const lines: string[] = [
    `# Naksha CareSpace — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `> ${nets.length} network${nets.length === 1 ? '' : 's'} · generated by \`careout\``,
    '',
  ];
  for (const net of nets) {
    const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null);
    if (!rootId) continue;
    lines.push(`## ${net.name}`, '');
    const walk = (id: string, depth: number) => {
      const n = net.nodes[id];
      if (!n) return;
      const indent = '  '.repeat(depth);
      const marks: string[] = [];
      if (n.notes.length) marks.push(`${n.notes.length} note${n.notes.length > 1 ? 's' : ''}`);
      if (n.location) marks.push(`@ ${n.location.lat.toFixed(3)}, ${n.location.lng.toFixed(3)}`);
      if (n.links.length) marks.push(`${n.links.length} link${n.links.length > 1 ? 's' : ''}`);
      lines.push(`${indent}- ${n.label}${marks.length ? ` — ${marks.join(' · ')}` : ''}`);
      for (const note of n.notes) {
        lines.push(`${indent}  - > ${note.text.replace(/\n/g, ' ')}`);
      }
      n.children.forEach((cid) => walk(cid, depth + 1));
    };
    walk(rootId, 0);
    lines.push('');
  }
  return lines.join('\n');
}

/* Task 94 — the correction suggester. The miss that built it: the app's
 * own copy calls networks "rivers" everywhere (welcome, care sheet,
 * receipts), so a user types `rivers` and the terminal answered
 * "Command not found" with zero recovery — the vocabulary betrayed the
 * verb. zsh's correction idiom, dialect-ported: (1) a poetry map for
 * the app's own nouns that aren't verbs, (2) Levenshtein for the
 * fat-fingered near-misses, threshold scaled to length so short verbs
 * stay strict. The suggestion rides the filterchip idiom — the
 * correction is ONE CLICK, not a retyping. Runs only on the miss path:
 * zero cost on every successful command. */
const CMD_POETRY: Record<string, string> = {
  rivers: 'care',
  river: 'care',
  thoughts: 'care',
  constellation: 'workspace',
  stars: 'workspace',
  star: 'workspace',
  places: 'goto',
  place: 'goto',
};

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/* Task 97 — one engine, four doors. The length-scaled Levenshtein
 * suggester had been written out twice (verb Task 94, theme Task 96);
 * the fourth miss-class (saved views) would have been the third copy —
 * the factorization Task 96 banked, triggered. One nearest-candidate
 * search: threshold scales with the miss (≤4 chars: 1, ≤8: 2, else 3 —
 * short names stay strict), an optional `alt` spelling rides each
 * candidate (the theme answers to its id OR its display name), and ties
 * break toward the shorter id (identity before breadth — the precedence
 * the verb suggester already spoke). null = honest stranger; callers
 * keep their own miss copy, the helper only decides WHO is near. */
function nearestSuggestion(miss: string, candidates: Array<{ id: string; alt?: string }>): string | null {
  const m = miss.toLowerCase();
  const threshold = m.length <= 4 ? 1 : m.length <= 8 ? 2 : 3;
  let best: string | null = null;
  let bestDist = threshold + 1;
  for (const c of candidates) {
    const d = Math.min(editDistance(m, c.id.toLowerCase()), c.alt ? editDistance(m, c.alt.toLowerCase()) : Infinity);
    if (d < bestDist || (d === bestDist && best && c.id.length < best.length)) {
      best = c.id;
      bestDist = d;
    }
  }
  return bestDist <= threshold ? best : null;
}

class CommandRunnerImpl {
  commands = new Map<string, CommandDef>();
  /** In-focus-only commands (only available inside focus mode). */
  focusCommands = new Set<string>(['note', 'snap', 'timer', 'list', 'done', 'exit']);

  init(): void {
    this.registerAll();
  }

  /** Get all command names for tab completion. */
  getAllCommandNames(): string[] {
    return Array.from(this.commands.keys());
  }

  /* Task 95 — argument candidates for Tab completion, read from the
   * command's own usage string wherever possible (the usage IS the
   * dialect's self-description: '[tree|graph]' enumerates its literals,
   * '<node>' names the pool). Returns null when the slot is free-form —
   * <place>, <path>, <text>, <term> stay un-completed: a wrong suggestion
   * is worse than no suggestion (the same honesty the suggester keeps). */
  getArgCandidates(def: CommandDef, slot: string): string[] | null {
    /* Pipe enums: 'caregraph [tree|graph]' → tree, graph. */
    const pipe = slot.match(/^\[([a-z0-9|]+)\]$/i);
    if (pipe && pipe[1].includes('|')) return pipe[1].toLowerCase().split('|');

    /* Pool placeholders — both angle and bracket spellings. */
    const pool = slot.match(/^[<\[]([a-z_]+)[>\]]$/i);
    if (pool) {
      const word = pool[1].toLowerCase();
      if (word === 'node' || word === 'parent') {
        return CareSpace.networks()
          .flatMap((n) => Object.values(n.nodes))
          .map((n) => n.label);
      }
      if (word === 'network') return CareSpace.networks().map((n) => n.name);
      if (word === 'name' && def.name === 'view') {
        return MapEngine.listViews().map((v) => v.name);
      }
    }

    /* The theme verb's slot says [name] — a free word, but the pool is
     * exactly the theme registry, so the provider is honest here. */
    if (def.name === 'theme') return THEMES.map((t) => t.id);

    return null;
  }

  /** Look up a command definition. */
  get(name: string): CommandDef | undefined {
    return this.commands.get(name);
  }

  /** List commands grouped by category (for help). */
  grouped(): Record<string, CommandDef[]> {
    const out: Record<string, CommandDef[]> = { fs: [], care: [], map: [], system: [], focus: [] };
    for (const cmd of this.commands.values()) {
      out[cmd.category].push(cmd);
    }
    return out;
  }

  /** Parse and execute a command string. Handles aliases and redirection. */
  async execute(commandStr: string): Promise<void> {
    const store = useNaksha.getState();
    const trimmed = commandStr.trim();
    if (!trimmed) return;

    // Alias expansion (first token only).
    const spaceIdx = trimmed.indexOf(' ');
    const head = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
    const alias = store.aliases[head];
    const expanded = alias ? `${alias}${rest ? ' ' + rest : ''}` : trimmed;

    // Output redirection: `cmd args > file` or `cmd args >> file`
    const redirect = expanded.match(/\s+(>>|>)\s*(\S+)\s*$/);
    let effective = expanded;
    let redirectTarget: { file: string; append: boolean } | null = null;
    if (redirect) {
      redirectTarget = { file: redirect[2], append: redirect[1] === '>>' };
      effective = expanded.slice(0, redirect.index).trim();
    }

    // Parse verb + args.
    const idx = effective.indexOf(' ');
    const verb = (idx === -1 ? effective : effective.slice(0, idx)).toLowerCase();
    const args = idx === -1 ? '' : effective.slice(idx + 1).trim();

    // help is special — handled inline.
    if (verb === 'help' || verb === '?') {
      this.showHelp(args);
      return;
    }

    // If workspace is active, terminal input is hidden — commands shouldn't run.
    if (useNaksha.getState().focusActive) {
      useNaksha.getState().print(`Workspace is active — press Esc to exit first.`, 'warning');
      return;
    }

    const cmd = this.commands.get(verb);
    if (!cmd) {
      useNaksha.getState().print(`Command not found: ${verb}`, 'error');
      const sug = this.suggestCommand(verb);
      if (sug) {
        useNaksha.getState().print(`did you mean '${sug.name}'? — click to run`, 'muted', {
          chips: [{ cmd: sug.name, label: sug.name, title: `run: ${sug.usage} — ${sug.description}` }],
        });
      } else {
        /* webDevReview — prose-capture hint: a multi-word (or RTL-script)
           miss is very often a thought typed straight into the prompt, not
           a broken verb ("سلام این یک یادداشت است" answered "Command not
           found" with zero recovery — the capture verb betrayed nobody,
           it just never got offered). One chip, the same correction idiom
           as the verb suggester above: recovery is ONE CLICK. RTL ranges:
           Hebrew 0590–05FF, Arabic (incl. Persian/Urdu) 0600–06FF,
           Syriac 0700–074F. Zero cost on every successful command. */
        const looksProse =
          /\s/.test(trimmed) || /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F]/.test(verb);
        if (looksProse) {
          useNaksha.getState().print(`looks like a thought, not a command — capture it`, 'muted', {
            chips: [
              {
                cmd: `note ${trimmed}`,
                label: `✎ note ${trimmed.length > 26 ? `${trimmed.slice(0, 26)}…` : trimmed}`,
                /* webDevReview — the capture chip wears the warm cream of
                   the ✎ file-verb family (not the default muted chip): the
                   suggestion IS a capture verb, so it reads as one. */
                tint: '#e8d9a8',
                title: `quick-capture this text into the active thought: note ${trimmed}`,
              },
            ],
          });
        } else {
          useNaksha.getState().print(`Type 'help' to see available commands`, 'muted');
        }
      }
      return;
    }

    // If redirecting, start capturing output before running the handler.
    if (redirectTarget) {
      useNaksha.getState().startCapture();
    }

    try {
      await cmd.handler(args);
    } catch (err) {
      useNaksha.getState().print(`Error: ${(err as Error).message}`, 'error');
      console.error(`[naksha] command error (${verb}):`, err);
    }

    // If we were capturing, write the buffer to the file.
    if (redirectTarget) {
      const captured = useNaksha.getState().stopCapture();
      if (captured.length > 0) {
        const r = FileSystem.writeFile(redirectTarget.file, captured.join('\n'), redirectTarget.append);
        if (r.success) {
          useNaksha.getState().print(`→ wrote ${captured.length} line(s) to ${redirectTarget.file}`, 'muted');
        } else {
          useNaksha.getState().print(`redirect failed: ${r.error}`, 'error');
        }
      } else {
        useNaksha.getState().print(`(no output to redirect)`, 'muted');
      }
    }
  }

  /* ════════════════════════════════════════════════════════════════
     History navigation (used by Terminal input)
     ════════════════════════════════════════════════════════════════ */
  historyPrevious(): void {
    const { history, historyIndex, setHistoryIndex } = useNaksha.getState();
    if (historyIndex > 0) setHistoryIndex(historyIndex - 1);
    else if (history.length > 0) setHistoryIndex(0);
  }
  historyNext(): void {
    const { history, historyIndex, setHistoryIndex } = useNaksha.getState();
    if (historyIndex < history.length) setHistoryIndex(historyIndex + 1);
  }
  getCurrentHistoryEntry(): string {
    const { history, historyIndex } = useNaksha.getState();
    if (historyIndex >= 0 && historyIndex < history.length) return history[historyIndex];
    return '';
  }

  /* ════════════════════════════════════════════════════════════════
     Help
     ════════════════════════════════════════════════════════════════ */
  showHelp(category?: string): void {
    const store = useNaksha.getState();
    if (!category) {
      store.print('═', 'muted');
      store.header('Naksha — Geographic Shell');
      store.print('');
      store.print('A terminal workspace for maps, files, and thoughts.', 'muted');
      store.print('');
      store.highlight('Categories:');
      /* Task 68 — the index hands over its verbs: every category row (and
       * the workspace invite) wears a one-click chip — the Task 66 chips
       * payload, so reading a row and running it are the same gesture.
       * The rows keep their `cmd  description` index typography; the chip
       * is the physical twin riding at the tail. */
      /* Task 93 — the index reflows: a wide pane keeps the classic
       * `cmd  description … [chip]` row; at the default pane's ~35
       * columns the description drops to an indented second line and
       * the chip rides the usage line, so no index row ever wraps.
       * The descs also shed their topic prefixes (the row already
       * names the topic) — shorter at every width, same story. */
      const indexRows: Array<{ cmd: string; desc: string; title: string }> = [
        { cmd: 'help fs', desc: 'file system commands', title: 'run: help fs — the file-system index' },
        { cmd: 'help care', desc: 'networks, tree, notes', title: 'run: help care — the CareSpace index' },
        { cmd: 'help map', desc: 'map, routing, wiki, weather', title: 'run: help map — the map index' },
        { cmd: 'help system', desc: 'terminal, settings, aliases', title: 'run: help system — the terminal index' },
        { cmd: 'help focus', desc: 'workspace + quick-capture', title: 'run: help focus — the focus index' },
      ];
      for (const row of indexRows) {
        const single = 2 + 18 + row.desc.length + 1 + row.cmd.length + 4 <= termCols();
        /* Task 97 — the twin stops echoing itself at narrow widths. The
         * stacked row used to print `  help fs` + a chip labeled `help fs`
         * — the same string twice, side by side (the wide row separates
         * them with the description, so there the twin still reads as
         * doc + button). The narrow row is now the CHIP ITSELF: one
         * boxed token, description demoted below. Same runnable text,
         * same gesture, half the ink. */
        if (single) store.print(`  ${row.cmd.padEnd(18)}${row.desc}`, 'output', {
          chips: [{ cmd: row.cmd, label: row.cmd, title: row.title }],
        });
        else store.print('  ', 'output', {
          chips: [{ cmd: row.cmd, label: row.cmd, title: row.title }],
        });
        if (!single) printIndentedWrapped('      ', row.desc, 'muted');
      }
      const wsDesc = 'star-constellation drawing';
      const wsSingle = 2 + 18 + wsDesc.length + 11 + 'workspace'.length + 4 <= termCols();
      if (wsSingle) store.print(`  ${'workspace'.padEnd(18)}${wsDesc} (Esc to exit)`, 'output', {
        chips: [{ cmd: 'workspace', label: 'workspace', title: 'run: workspace — star-constellation drawing (Esc exits)' }],
      });
      else store.print('  ', 'output', {
        chips: [{ cmd: 'workspace', label: 'workspace', title: 'run: workspace — star-constellation drawing (Esc exits)' }],
      });
      if (!wsSingle) printIndentedWrapped('      ', `${wsDesc} (Esc to exit)`, 'muted');
      store.print('');
      store.print('Tip: Tab completes commands — and their arguments (themes, thoughts, views).', 'muted');
      store.print('Tip: press / to focus the terminal, Esc to dismiss overlays.', 'muted');
      store.print('');
      return;
    }
    const groups = this.grouped();
    const cat = category.toLowerCase();
    const map: Record<string, string> = {
      fs: 'fs', filesystem: 'fs', file: 'fs', files: 'fs',
      care: 'care', carespace: 'care', node: 'care', nodes: 'care',
      map: 'map', geo: 'map',
      system: 'system', sys: 'system', terminal: 'system',
      focus: 'focus',
    };
    const key = map[cat];
    if (!key) {
      /* Task 36: `help <command>` — with 90+ commands, category-only help
         meant `help whereis` answered "Unknown category". If the token
         matches a registered command, print its full card instead. */
      const cmd = this.commands.get(cat);
      if (cmd) {
        store.header(`help — ${cmd.name}`);
        /* Task 93 — the card's label column is a contract (padFixed
         * 12), but a 35-col pane can't hold `usage` + a 35-char usage
         * string on one line: the value reflows to a continuation line
         * aligned with the value column (indent 14). */
        sheetRows(
          [
            ['usage', cmd.usage],
            ['category', cmd.category],
          ],
          { padFixed: 12, stackIndent: 14, rightTone: 'output' },
        );
        store.print(`  ${cmd.description}`, 'muted');
        /* Task 69 — the card hands over the verb: a BARE-runnable
         * command (usage carries no required <arg>) wears a one-click
         * chip — `help demo` → run demo, same gesture as reading about
         * it. Commands demanding args keep the card as documentation. */
        if (!cmd.usage.includes('<')) {
          store.print('  try it now:', 'output', {
            chips: [{ cmd: cmd.name, label: cmd.name, title: `run: ${cmd.name} — straight from its help card` }],
          });
        }
        const aliases = Object.entries(store.aliases)
          .filter(([, v]) => v === cmd.name)
          .map(([k]) => k);
        if (aliases.length > 0) sheetRows([['aliases', aliases.join(', ')]], { padFixed: 12, stackIndent: 14 });
        store.print('');
        return;
      }
      /* Task 37: user-defined aliases (`alias ll=ls`) live in
         store.aliases, NOT in the command registry — `help ll` used to
         fall through to "Unknown category". Resolve the alias (following
         chains up to 3 deep) and print the canonical card with a provenance
         line, so every name the user can TYPE also answers to `help`. */
      const aliasTarget = store.aliases[cat];
      if (aliasTarget) {
        let target = aliasTarget;
        let depth = 0;
        while (store.aliases[target] && depth < 3) {
          target = store.aliases[target];
          depth++;
        }
        const targetWords = target.split(/\s+/);
        const targetCmd = this.commands.get(targetWords[0].toLowerCase());
        if (targetCmd) {
          store.header(`help — ${cat}`);
          sheetRows(
            [
              ['alias', `${cat} → ${aliasTarget}`],
              ['usage', targetCmd.usage],
              ['category', targetCmd.category],
            ],
            { padFixed: 12, stackIndent: 14, rightTone: 'output' },
          );
          store.print(`  ${targetCmd.description}`, 'muted');
          if (targetWords.length > 1) {
            sheetRows([['note', `expands with args: ${targetWords.slice(1).join(' ')}`]], { padFixed: 12, stackIndent: 14 });
          }
          store.print('');
          return;
        }
        /* Alias → not a real command (weird input like `alias x=foo bar`).
           Still more useful than "Unknown category". */
        store.print(`Alias ${cat} → "${aliasTarget}" — not a known command.`, 'warning');
        store.print('');
        return;
      }
      store.print(`Unknown category or command: ${category}`, 'error');
      store.print('Try: fs · care · map · system · focus — or a command name (help whereis)', 'muted');
      return;
    }
    store.header(`${key.toUpperCase()} commands`);
    const cmds = groups[key];
    /* Task 93 — two-column when the row fits the pane's live budget,
     * usage-then-indented-description when it doesn't (man-page
     * reflow; see sheetRows). */
    sheetRows(cmds.map((c) => [c.usage, c.description] as [string, string]));
    /* Task 67 — the cross-group pointer: demo (the practice seeder)
     * lives in the map group, so `help care` never mentioned it — care
     * workers had no way to discover the one command that stocks the
     * pond (4 thoughts with notes/tags/locations + 1 pin + a link, then
     * pins/near/links/caregraph graph all have specimens). One muted
     * line at the foot of the care listing closes the gap.
     * Task 68 — the pointer became a BRIDGE: gotonode (fly the map to
     * a thought) and pinnode (pin a thought at the map center) are ALSO
     * map-group verbs that speak care nouns. Three full-card rows, each
     * with its own provenance footnote — the two hemispheres of the
     * shell finally appear in each other's indexes. */
    if (key === 'care') {
      const bridges: Array<{ name: string; why: string }> = [
        { name: 'demo', why: 'it seeds the pond every care verb fishes from' },
        { name: 'gotonode', why: 'it flies the map to a care thought' },
        { name: 'pinnode', why: 'it pins a care thought at the map center' },
      ];
      for (const { name, why } of bridges) {
        const c = this.commands.get(name);
        if (!c) continue;
        sheetRows([[c.usage, c.description]]);
        store.print(`  ^(under map — ${why})`, 'muted');
      }
    }
    store.print('');
  }

  /* ════════════════════════════════════════════════════════════════
     Registration
     ════════════════════════════════════════════════════════════════ */
  private register(name: string, description: string, usage: string, category: CommandDef['category'], handler: CommandDef['handler']): void {
    this.commands.set(name, { name, description, usage, category, handler });
  }

  /* Task 94 — nearest honest verb for a miss, or null when nothing is
   * close enough to be worth suggesting (the generic help pointer stays
   * for that case). Poetry first — the app's own nouns map to the verb
   * that actually lives there — then the shared Levenshtein engine
   * (Task 97) over the registry. */
  private suggestCommand(miss: string): CommandDef | null {
    const poetic = CMD_POETRY[miss];
    if (poetic) {
      const p = this.commands.get(poetic);
      if (p) return p;
    }
    const near = nearestSuggestion(miss, Array.from(this.commands.values()).map((c) => ({ id: c.name })));
    return near ? (this.commands.get(near) ?? null) : null;
  }

  /** Resolve a node name with fuzzy fallback + ambiguity reporting.
   * Prints the "did you mean" line itself on ambiguity; callers can
   * `return` on null. Task 34 fix: a ZERO-match lookup used to return
   * silently (the ambiguity callback only fires on ≥2 matches) — every
   * node-taking command failed mute. Now prints "Node not found" itself.
   * Task 70 — the reason rides along: auto-creating callers (save, pinat)
   * must only create on a CLEAN not-found — creating a node because two
   * AMBIGUOUS candidates matched would be exactly the wrong reflex (the
   * snap rule, now everywhere). */
  private resolveNodeWithReason(name: string): { node: CareNode | null; reason: 'found' | 'not-found' | 'ambiguous' } {
    let ambiguous = false;
    const found = CareSpace.searchNodeByName(name, (candidates) => {
      ambiguous = true;
      useNaksha.getState().print(`Ambiguous name "${name}" — did you mean: ${candidates.map((c) => `"${c}"`).join(', ')}?`, 'error');
      /* Task 69 — the escape hatch, surfaced: id-bearing candidates
       * (the exact-duplicate case) mean the user can AIM — re-running
       * with the full id resolves to exactly one node. */
      if (candidates.some((c) => c.includes('('))) {
        useNaksha.getState().print('  tip: re-run with a full id (shown above) to aim at one exactly', 'muted');
      }
    });
    if (!found && !ambiguous) {
      useNaksha.getState().print(`Node not found: ${name.replace(/^["']|["']$/g, '')}`, 'error');
    }
    return { node: found, reason: found ? 'found' : ambiguous ? 'ambiguous' : 'not-found' };
  }

  /** The common shape: just the node (receipts already printed). */
  private resolveNode(name: string): CareNode | null {
    return this.resolveNodeWithReason(name).node;
  }

  /** Task 40 — cross-river resolver for mutation commands. The CURRENT
   *  river is searched first with the same exact → prefix → substring
   *  cascade (zero behavior change for the common case); other rivers
   *  follow. A `<river>/<name>` qualifier pins the search to one river —
   *  merged rivers love duplicate labels, and `rennode backup/Root to X`
   *  now means exactly one thing. Success returns the node WITH its
   *  river so the caller can write river-scoped and the receipt can
   *  name where the write landed. A miss returns the reason — `rennode`
   *  just bails, but `snap` only auto-creates on a clean not-found
   *  (creating a node because two AMBIGUOUS candidates matched would
   *  be exactly the wrong reflex). */
  private resolveNodeGlobal(
    nameOrQualified: string,
  ): { ok: true; node: CareNode; net: CareNetwork } | { ok: false; reason: 'not-found' | 'ambiguous' | 'bad-river' } {
    const store = useNaksha.getState();
    let qualifiedNet: string | null = null;
    let name = nameOrQualified.trim();
    const sep = name.indexOf('/');
    if (sep > 0) {
      qualifiedNet = name.slice(0, sep).trim().replace(/^["']|["']$/g, '').toLowerCase();
      name = name.slice(sep + 1).trim();
    }
    name = name.replace(/^["']|["']$/g, '');
    if (!name) {
      store.print(`Node not found: ${nameOrQualified}`, 'error');
      return { ok: false, reason: 'not-found' };
    }
    const lower = name.toLowerCase();
    let nets = CareSpace.networks();
    if (qualifiedNet) {
      nets = nets.filter((n) => n.name.toLowerCase() === qualifiedNet);
      if (nets.length === 0) {
        store.print(`River not found: "${qualifiedNet}" — rivers: ${CareSpace.networks().map((n) => n.name).join(', ')}`, 'error');
        return { ok: false, reason: 'bad-river' };
      }
    }
    /* Current river first — matches where the user is standing. */
    const curId = CareSpace.currentNetwork().id;
    const ordered = [...nets].sort((a, b) => (a.id === curId ? -1 : b.id === curId ? 1 : 0));
    for (const net of ordered) {
      const nodes = Object.values(net.nodes);
      /* Task 71 — exact duplicates report, never silently pick: two
       * nodes labeled alike in ONE river made `.find` return whichever
       * came first (the exact case was the LEAST safe — same lesson as
       * Task 69's rmnode fix, this resolver just hadn't learned it).
       * The candidates carry their ids: a full id is the aim. */
      const exacts = nodes.filter((n) => n.label.toLowerCase() === lower || n.id === name);
      if (exacts.length === 1) return { ok: true, node: exacts[0], net };
      if (exacts.length > 1) {
        store.print(
          `Ambiguous name "${name}" in river "${net.name}" (${exacts.map((n) => `"${n.label} (${n.id})"`).join(', ')}) — re-run with a full id to aim at one exactly`,
          'error',
        );
        return { ok: false, reason: 'ambiguous' };
      }
      const byPrefix = nodes.filter((n) => n.label.toLowerCase().startsWith(lower));
      if (byPrefix.length === 1) return { ok: true, node: byPrefix[0], net };
      const bySubstring = nodes.filter((n) => n.label.toLowerCase().includes(lower));
      if (bySubstring.length === 1) return { ok: true, node: bySubstring[0], net };
      const pool = byPrefix.length > 1 ? byPrefix : bySubstring;
      if (pool.length > 1) {
        store.print(
          `Ambiguous name "${name}" in river "${net.name}" (${pool.map((n) => `"${n.label}"`).join(', ')}) — qualify as ${net.name.toLowerCase()}/${name}`,
          'error',
        );
        return { ok: false, reason: 'ambiguous' };
      }
    }
    store.print(`Node not found: ${nameOrQualified}`, 'error');
    return { ok: false, reason: 'not-found' };
  }

  /* Task 49 — place→thought matcher: when a fly row's destination (a
   * wiki article's coordinates, a weather geocode hit) is "about" a
   * thought, the row can carry the ⇥ jumpBadge chip so clicking the chip
   * opens that thought in the tree — the same two-verbs-on-one-row
   * dialect `near` rows speak. Two passes, both cheap (a few dozen
   * haversine calls per invocation, zero idle cost):
   *   1. PROXIMITY — the honest signal: a pinned thought within 1km of
   *      the place IS "the thought about this place" (closest wins).
   *   2. LABEL — a name overlap (case-insensitive containment, the
   *      shorter side ≥ 4 chars so "cafe in Paris" can't match a town
   *      called "Café") catches thoughts pinned far from their namesake.
   * Proximity always beats label; label ties break by distance. */
  private matchThoughtToPlace(
    lat: number,
    lng: number,
    name?: string,
  ): { nodeId: string; river: string; label: string } | null {
    const PROXIMITY_KM = 1;
    let bestId: string | null = null;
    let bestRiver = '';
    let bestLabel = '';
    let bestD = Infinity;
    const q = name ? name.toLowerCase().trim() : '';
    for (const net of CareSpace.networks()) {
      for (const node of Object.values(net.nodes)) {
        if (!node.location) continue;
        const d = haversineKm(lat, lng, node.location.lat, node.location.lng);
        if (d <= PROXIMITY_KM) {
          /* Proximity pass — always beats label (label candidates only
           * exist beyond the 1km ring, so they can never out-distance
           * a proximity hit on the shared closest-wins rule). */
          if (d < bestD) { bestId = node.id; bestRiver = net.name; bestLabel = node.label; bestD = d; }
          continue;
        }
        /* Label pass — name overlap (case-insensitive containment both
         * ways, the shorter side ≥ 4 chars so a town called "Café"
         * can't adopt every thought with "cafe" in the name). Catches
         * thoughts pinned far from their namesake place. */
        if (!q || q.length < 4) continue;
        const l = node.label.toLowerCase();
        if ((l.includes(q) || q.includes(l)) && Math.min(l.length, q.length) >= 4 && d < bestD) {
          bestId = node.id; bestRiver = net.name; bestLabel = node.label; bestD = d;
        }
      }
    }
    return bestId ? { nodeId: bestId, river: bestRiver, label: bestLabel } : null;
  }

  /* Task 50 — shared filesystem row helpers (ls + tree speak the same
   * language: same icons, same colors, same binary rule). */
  private static readonly FS_BINARY_EXT = [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'gz', 'bin', 'woff', 'woff2',
  ];
  /* Task 52 — extensions eligible for the ▤ reader chip (the same list
   * `cat -r` renders): the chip only appears where the reader can
   * actually render, so the promise is kept. */
  private static readonly READER_EXT = ['md', 'markdown', 'txt', 'rst'];
  private fsIconFor(name: string, isDir: boolean): { icon: string; color: string } {
    if (isDir) return { icon: '▸', color: '#d4a017' };
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (['md', 'markdown', 'txt', 'rst'].includes(ext)) return { icon: '✎', color: '#f5ead0' };
    if (['json', 'yaml', 'yml', 'toml', 'ini', 'cfg'].includes(ext)) return { icon: '⚙', color: '#7a9ec2' };
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'sh'].includes(ext)) return { icon: '⌘', color: '#9b7ec8' };
    if (['html', 'css', 'svg'].includes(ext)) return { icon: '◈', color: '#ff9bb5' };
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico'].includes(ext)) return { icon: '▣', color: '#7fe7d6' };
    return { icon: '•', color: '#a89e88' };
  }

  private registerAll(): void {
    const store = () => useNaksha.getState();
    const syncAll = () => { store().syncFs(); store().syncCare(); };

    /* Phase 4 — the ONE routing decision every fs verb makes: which
     * world answers this command? resolveStorageContext (the Phase 3
     * truth table) + the live VaultStatus decide — no handler guesses,
     * no surface tells its own story. When the connected context is
     * active, the READ verbs (ls/cd/pwd/tree/cat/grep) speak to the
     * REAL directory through the vault API; the internal FS stays
     * byte-identical as the 'internal' world and as the write-verb
     * surface (the vault is read-only by construction). */
    const activeCtx = () => {
      const s = useNaksha.getState();
      return resolveStorageContext(s.settings.storageContext, s.vaultStatus);
    };
    /* A vault fetch said the config is gone — self-heal the chip while
     * the error receipt tells the user what happened (never silent).
     * The `loading` overload also STOPS a spinner line first, so an
     * error can never leave an orphaned ⠇ animation on the scrollback. */
    const noteVaultFail = (msg: string) => {
      store().print(msg, 'error');
      void useNaksha.getState().refreshVaultStatus();
    };
    type LoadingHandle = ReturnType<ReturnType<typeof store>['showLoading']>;
    const noteVaultFailStop = (loading: LoadingHandle, msg: string) => {
      loading.stop(msg, 'error');
      void useNaksha.getState().refreshVaultStatus();
    };
    /* The muted one-liner write verbs print when the connected context
     * is active: their work happened on the internal FS, and the receipt
     * NAMES it (honesty over convenience — no silent cross-world reads
     * of intent). */
    const hintInternalWrite = (verb: string) => {
      if (activeCtx().kind !== 'connected') return;
      store().print(`  [internal] ${verb} worked on the internal FS — the connected vault is read-only`, 'muted');
    };

    /* Phase 5 — the CareSpace-vault WRITE gate. Designation is a
     * server-side fact; the store mirrors it. Every command that may
     * create/rename/append a real .md file asks this first and speaks
     * the honest reason when the gate is closed. */
    const careGate = (): { ok: boolean; name: string; error?: string } => {
      const st = useNaksha.getState().careVaultStatus;
      if (!st || !st.vaultConnected) {
        return { ok: false, name: '', error: 'no vault connected — vault connect <absolute path> first' };
      }
      if (!st.designatedFlag) {
        return { ok: false, name: st.name ?? '', error: 'this vault is not designated for CareSpace — vault designate on' };
      }
      if (!st.designated) {
        return { ok: false, name: st.name ?? '', error: 'the designated directory is unavailable (or the designation points elsewhere) — vault status' };
      }
      return { ok: true, name: st.name ?? 'vault' };
    };
    /* A bound thought's honest marker for receipts: ▤ + rel path,
     * ⚠-prefixed when the file is currently known missing. */
    const boundTag = (node: CareNode): string => {
      if (!node.vaultPath) return '';
      const missing = useNaksha.getState().careVaultMissing[node.vaultPath];
      return `${missing ? '⚠' : '▤'} ${node.vaultPath}`;
    };

    /* ────────────────── FILE SYSTEM ──────────────────
     * Phase 4 — ls/cd/pwd/tree/cat/grep are CONTEXT-ROUTED: connected
     * context → the real directory via the vault API (rows carry
     * world:'vault' so click verbs land in the same world); internal
     * context → FileSystem below, byte-identical to before. */
    this.register('ls', 'List directory contents (click rows to open)', 'ls [path]', 'fs', (args) => {
      const ctx = activeCtx();
      if (ctx.kind === 'connected') {
        const s0 = useNaksha.getState();
        const resolved = resolveVaultPath(s0.vaultCwd, args || '.');
        if (!resolved.ok) { store().print(`ls: ${resolved.error}`, 'error'); return; }
        const loading = store().showLoading(`[vault:${ctx.name}] listing ${resolved.rel || '/'}…`);
        void (async () => {
          try {
            const res = await fetch(`/api/vault/list?p=${encodeURIComponent(resolved.rel)}`, { cache: 'no-store' });
            const data = (await res.json()) as {
              ok: boolean;
              entries?: Array<{ name: string; rel: string; type: 'dir' | 'file'; size: number; ext: string }>;
              error?: string;
            };
            if (!data.ok || !data.entries) { noteVaultFailStop(loading, `ls: [vault:${ctx.name}] ${data.error ?? 'list failed'}`); return; }
            const entries = data.entries;
            if (entries.length === 0) { loading.stop(`[vault:${ctx.name}] ${resolved.rel || '/'} — (empty)`, 'muted'); return; }
            loading.stop(`[vault:${ctx.name}] ${resolved.rel || '/'} — ${entries.length} entries`, 'info');
            for (const e of entries) {
              const isDir = e.type === 'dir';
              const { icon, color } = this.fsIconFor(e.name, isDir);
              const ind = isDir ? '/' : '';
              const sz = !isDir ? `  ${formatSize(e.size)}` : '';
              const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
              const interactive = isDir || !CommandRunnerImpl.FS_BINARY_EXT.includes(ext);
              /* Rows carry the VAULT rel path + world marker — clicks
               * resolve through the vault API + vault cwd, never the
               * internal FS (the same honesty the typed verbs keep). */
              store().print(
                `  \uE000${color}\uE001${icon}\uE002  ${e.name}${ind}${sz}`,
                'output',
                interactive
                  ? {
                      fs: { path: e.rel, kind: isDir ? 'dir' : 'file', world: 'vault' },
                      ...(isDir || !CommandRunnerImpl.READER_EXT.includes(ext) ? {} : { read: { path: e.rel, world: 'vault' } }),
                    }
                  : undefined,
              );
            }
            store().print('  ⇥ click a folder row to enter it · a file row to read it (real directory)', 'muted');
          } catch (err) {
            loading.stop(`vault list failed: ${(err as Error).message}`, 'error');
          }
        })();
        return;
      }
      const result = FileSystem.listDirectory(args);
      if (!result.success) { store().print(result.error!, 'error'); return; }
      if (result.isFile) { store().print(result.name!, 'info'); return; }
      const entries = result.entries!;
      if (entries.length === 0) { store().print('(empty)', 'muted'); return; }
      const node = result.node!;
      if (node.type !== 'dir') { store().print('(not a directory)', 'muted'); return; }

      /* Task 49 — the filesystem joins the interactive dialect: ls used
       * to print ONE joined multi-line blob (the last non-interactive
       * output family); now every entry is its own row carrying an `fs`
       * payload — the delegated terminal listener turns a click into the
       * row's own verb: a folder row runs `cd` into it, a file row runs
       * `cat` on it. Binary-ish extensions (images/archives) stay plain
       * rows — the terminal can't show a PNG, so the row shouldn't
       * promise to. Paths are resolved ABSOLUTE at print time, so rows
       * from `ls subdir` still work after the click. */
      const absBase = FileSystem.resolvePath(args || '.');
      for (const name of entries) {
        const e = node.contents[name];
        const isDir = e.type === 'dir';
        const { icon, color } = this.fsIconFor(name, isDir);
        const ind = isDir ? '/' : '';
        const sz = !isDir ? `  ${FileSystem.formatSize(e.type === 'file' ? e.content : '')}` : '';
        const ext = name.split('.').pop()?.toLowerCase() ?? '';
        const interactive = isDir || !CommandRunnerImpl.FS_BINARY_EXT.includes(ext);
        const rowPath = '/' + [...absBase, name].join('/');
        // Inline color markup using Unicode private-use area chars:
        // \uE000<color>\uE001<icon>\uE002 — parsed by ColoredText in TerminalPane.
        store().print(
          `  \uE000${color}\uE001${icon}\uE002  ${name}${ind}${sz}`,
          'output',
          interactive
            ? {
                fs: { path: rowPath, kind: isDir ? 'dir' : 'file' },
                /* Task 52 — reader-eligible FILE rows also carry the ▤
                 * chip payload (row click stays raw cat; chip = reader). */
                ...(isDir || !CommandRunnerImpl.READER_EXT.includes(ext) ? {} : { read: { path: rowPath } }),
              }
            : undefined,
        );
      }
      store().print('  ⇥ click a folder row to enter it · a file row to read it', 'muted');
    });

    this.register('cd', 'Change directory', 'cd <path>', 'fs', (args) => {
      /* Phase 4 — connected context: the vault world keeps its OWN cwd
       * (jailed at the root; `..` clamps, never escapes). The internal
       * cwd is untouched — switching contexts never drags either world. */
      const ctx = activeCtx();
      if (ctx.kind === 'connected') {
        const s0 = useNaksha.getState();
        const resolved = resolveVaultPath(s0.vaultCwd, args || '~');
        if (!resolved.ok) { store().print(`cd: ${resolved.error}`, 'error'); return; }
        void (async () => {
          try {
            const res = await fetch(`/api/vault/list?p=${encodeURIComponent(resolved.rel)}`, { cache: 'no-store' });
            const data = (await res.json()) as { ok: boolean; error?: string };
            if (!data.ok) { noteVaultFail(`cd: [vault:${ctx.name}] ${data.error ?? 'cannot enter'}`); return; }
            s0.setVaultCwd(resolved.rel);
            store().print(`⇥ [vault:${ctx.name}] ${vaultPwdAbs(ctx.root ?? '', resolved.rel)}${resolved.rel ? '' : '  (vault root)'}`, 'muted');
          } catch (err) {
            store().print(`vault cd failed: ${(err as Error).message}`, 'error');
          }
        })();
        return;
      }
      const result = FileSystem.changeDirectory(args || '~');
      if (result.success) {
        store().syncFs();
        return;
      }
      /* UX fallback: after `node Research` users instinctively type
       * `cd Research`. If the name matches a CareSpace node, navigate
       * there instead of failing with a filesystem error. */
      if (args && !args.startsWith('/') && !args.startsWith('.') && !args.startsWith('~')) {
        /* Task 70 — the CareSpace fallback speaks the resolver's dialect:
         * an ambiguous name gets did-you-mean instead of a filesystem
         * error, and a clean miss falls through to that error. */
        const target = this.resolveNode(args.trim());
        if (target) {
          const nav = CareSpace.navigateTo(target.label);
          if (nav.success) {
            store().print(`↦ CareSpace node: ${nav.data!.label}`, 'info');
            store().syncCare();
            return;
          }
        }
      }
      store().print(result.error!, 'error');
    });

    this.register('pwd', 'Print working directory', 'pwd', 'fs', () => {
      /* Phase 4 — pwd names the world it is standing in: the vault's
       * absolute root + the jailed rel cwd when connected. */
      const ctx = activeCtx();
      if (ctx.kind === 'connected') {
        const s0 = useNaksha.getState();
        store().print(`[vault:${ctx.name}] ${vaultPwdAbs(ctx.root ?? '', s0.vaultCwd)}`, 'info');
        return;
      }
      store().print(FileSystem.getCurrentPath(), 'info');
    });

    this.register('tree', 'Show directory tree (click rows to open)', 'tree [path]', 'fs', (args) => {
      /* Phase 4 — connected context: walk the REAL directory through
       * /api/vault/tree (capped) and print the same interactive row
       * dialect, rel paths + world marker. */
      const ctx = activeCtx();
      if (ctx.kind === 'connected') {
        const s0 = useNaksha.getState();
        const resolved = resolveVaultPath(s0.vaultCwd, args || '.');
        if (!resolved.ok) { store().print(`tree: ${resolved.error}`, 'error'); return; }
        const loading = store().showLoading(`[vault:${ctx.name}] walking ${resolved.rel || '/'}…`);
        void (async () => {
          try {
            const res = await fetch(`/api/vault/tree?p=${encodeURIComponent(resolved.rel)}&max=200`, { cache: 'no-store' });
            const data = (await res.json()) as {
              ok: boolean;
              entries?: Array<{ rel: string; name: string; isDir: boolean; depth: number }>;
              truncated?: boolean;
              error?: string;
            };
            if (!data.ok || !data.entries) { noteVaultFailStop(loading, `tree: [vault:${ctx.name}] ${data.error ?? 'tree failed'}`); return; }
            const entries = data.entries;
            if (entries.length === 0) { loading.stop(`[vault:${ctx.name}] ${resolved.rel || '/'} — (empty)`, 'muted'); return; }
            loading.stop(`tree [vault:${ctx.name}] ${resolved.rel || '/'} — ${entries.length} entries`, 'info');
            for (const e of entries) {
              const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
              const { icon, color } = this.fsIconFor(e.name, e.isDir);
              const indent = '  ' + '│ '.repeat(e.depth);
              store().print(
                `${indent}\uE000${color}\uE001${icon}\uE002  ${e.name}${e.isDir ? '/' : ''}`,
                'output',
                e.isDir || !CommandRunnerImpl.FS_BINARY_EXT.includes(ext)
                  ? {
                      fs: { path: e.rel, kind: e.isDir ? 'dir' : 'file', world: 'vault' },
                      ...(e.isDir || !CommandRunnerImpl.READER_EXT.includes(ext) ? {} : { read: { path: e.rel, world: 'vault' } }),
                    }
                  : undefined,
              );
            }
            if (data.truncated || entries.length >= 200) store().print('  … deeper entries truncated (200 cap)', 'muted');
            store().print('  ⇥ click a folder row to enter it · a file row to read it (real directory)', 'muted');
          } catch (err) {
            loading.stop(`vault tree failed: ${(err as Error).message}`, 'error');
          }
        })();
        return;
      }
      /* Task 50 — the tree output was the LAST blob-style view (one
       * ASCII string). Now it walks via getTreeEntries and prints one
       * interactive row per entry — indented with the │ glyph family so
       * the hierarchy still reads at a glance, but every row speaks the
       * fs dialect: folder click = cd, file click = cat. Same binary
       * rule as ls (rows only promise what the terminal can show). */
      const entries = FileSystem.getTreeEntries(args);
      if (!entries) { store().print(`Cannot access: ${args || '.'}`, 'error'); return; }
      if (entries.length === 0) { store().print('(empty)', 'muted'); return; }
      store().header(`tree ${args || FileSystem.getCurrentPath()} — ${entries.length} entries`);
      for (const e of entries) {
        const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
        const { icon, color } = this.fsIconFor(e.name, e.isDir);
        /* Indent guides — the │ family echoes getTreeString's connectors,
         * so old hands still read the hierarchy shape. Two spaces base
         * aligns with ls rows. */
        const indent = '  ' + '│ '.repeat(e.depth);
        store().print(
          `${indent}\uE000${color}\uE001${icon}\uE002  ${e.name}${e.isDir ? '/' : ''}`,
          'output',
          e.isDir || !CommandRunnerImpl.FS_BINARY_EXT.includes(ext)
            ? {
                fs: { path: e.path, kind: e.isDir ? 'dir' : 'file' },
                ...(e.isDir || !CommandRunnerImpl.READER_EXT.includes(ext) ? {} : { read: { path: e.path } }),
              }
            : undefined,
        );
      }
      if (entries.length >= 300) store().print('  … deeper entries truncated (300 cap)', 'muted');
      store().print('  ⇥ click a folder row to enter it · a file row to read it', 'muted');
    });

    /* Task 51 — `cat -r <file>`: text/markdown files open in the READER
     * panel (block-rendered: headings, lists, code fences, links) instead
     * of raw terminal text. Opt-in flag — plain `cat` stays byte-faithful
     * for pipes/inspection; the reader is for READING. */
    this.register('cat', 'Display file contents (-r: read in reader panel)', 'cat [-r] <file>', 'fs', (args) => {
      if (!args) { store().print('Usage: cat [-r] <file>', 'error'); return; }
      const wantReader = /^(-r|--reader)\s+/.test(args);
      const path = wantReader ? args.replace(/^(-r|--reader)\s+/, '').trim() : args;

      /* Phase 4 — the CONTEXT decides the world, for plain cat and -r
       * alike: connected → the REAL file via the vault API (jailed rel
       * resolution, honest miss errors — no cross-world fallback);
       * internal → FileSystem below. The old "prefer vault whenever
       * connected" special case is gone — one truth table, no drift. */
      const ctx = activeCtx();
      if (ctx.kind === 'connected') {
        const s0 = useNaksha.getState();
        const resolved = resolveVaultPath(s0.vaultCwd, path);
        if (!resolved.ok) { store().print(`cat: ${resolved.error}`, 'error'); return; }
        if (!resolved.rel) { store().print(`cat: [vault:${ctx.name}] is a directory (the vault root)`, 'error'); return; }
        void (async () => {
          try {
            const res = await fetch(`/api/vault/read?p=${encodeURIComponent(resolved.rel)}`, { cache: 'no-store' });
            const data = (await res.json()) as { ok: boolean; content?: string; size?: number; error?: string };
            if (!data.ok || typeof data.content !== 'string') {
              /* The real directory answered with a miss — printed as
               * exactly that. The internal FS is a separate world and is
               * NOT consulted silently; 'context internal' moves the
               * terminal there explicitly. */
              noteVaultFail(`cat: [vault:${ctx.name}] ${data.error ?? 'read failed'} — the internal FS is a separate world ('context internal' switches)`);
              return;
            }
            const content = data.content;
            if (wantReader) {
              const ext = resolved.rel.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
              if (['md', 'markdown', 'txt', 'rst'].includes(ext)) {
                useNaksha.getState().openReader({
                  kind: 'file',
                  title: resolved.rel.split('/').pop() ?? resolved.rel,
                  body: vaultMarkdownToHtml(content, resolved.rel),
                  /* Phase 8 — per-note direction from the RAW text. */
                  direction: detectDirection(content) ?? 'ltr',
                });
                store().print(`Reader — [vault:${ctx.name}] ${resolved.rel} · press Esc to close`, 'success');
                return;
              }
              store().print(`cat -r reads text/markdown files (this one is .${ext || 'bin'}) — showing raw:`, 'warning');
            }
            if (!content) { store().print(`(empty file — [vault:${ctx.name}])`, 'muted'); return; }
            store().print(`[vault:${ctx.name}] ${resolved.rel} · ${formatSize(data.size ?? content.length)}`, 'info');
            store().print(content, 'file-output');
          } catch (err) {
            store().print(`vault read failed: ${(err as Error).message}`, 'error');
          }
        })();
        return;
      }

      const result = FileSystem.readFile(path);
      if (!result.success) { store().print(result.error!, 'error'); return; }
      const content = result.content ?? '';
      if (!content) { store().print('(empty file)', 'muted'); return; }
      const ext = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
      const isText = ['md', 'markdown', 'txt', 'rst'].includes(ext);
      if (wantReader && isText) {
        useNaksha.getState().openReader({
          kind: 'file',
          title: path.split('/').pop() ?? path,
          body: markdownToHtml(content),
          /* Phase 8 — per-note direction from the RAW text. */
          direction: detectDirection(content) ?? 'ltr',
        });
        store().print(`Reader — ${path} · press Esc to close`, 'success');
        store().print('  headings, lists and code render in the panel; plain cat keeps raw text', 'muted');
        return;
      }
      if (wantReader) {
        store().print(`cat -r reads text/markdown files (this one is .${ext || 'bin'}) — showing raw:`, 'warning');
      }
      store().print(content, 'file-output');
    });

    /* Phase 6 — nano is CONTEXT-ROUTED and the connected world gets the
     * REAL editor: `nano <file>` under the connected context opens the
     * actual nano binary (PTY bridge, restricted mode, cwd = vault root)
     * through the NanoPty overlay. Reads/writes hit the real file — no
     * interception, no fakes. Creation of a file that does not exist is
     * gated exactly like every other write: it needs the designated
     * CareSpace vault. Internal context → the internal overlay editor
     * below (unchanged since Phase 1). */
    this.register('nano', 'Edit file (real nano when connected)', 'nano <file>', 'fs', (args) => {
      if (!args) { store().print('Usage: nano <file>', 'error'); return; }
      const ctx = activeCtx();
      if (ctx.kind === 'connected') {
        const s0 = useNaksha.getState();
        const resolved = resolveVaultPath(s0.vaultCwd, args);
        if (!resolved.ok) { store().print(`nano: ${resolved.error}`, 'error'); return; }
        if (!resolved.rel) { store().print(`nano: [vault:${ctx.name}] is a directory (the vault root)`, 'error'); return; }
        if (resolved.rel.split('/').some((seg) => seg.startsWith('.'))) {
          store().print(`nano: [vault:${ctx.name}] hidden files stay out of the vault (the reader never lists them)`, 'error');
          return;
        }
        void (async () => {
          try {
            /* Existence pre-check through the read-only API: the PTY
             * service re-validates everything anyway (defense in depth),
             * but this keeps the honest refusal INSIDE the terminal
             * instead of flashing the overlay open-then-closed. */
            const res = await fetch(`/api/vault/read?p=${encodeURIComponent(resolved.rel)}`, { cache: 'no-store' });
            const data = (await res.json()) as { ok: boolean; error?: string };
            const errText = data.error ?? '';
            if (data.ok || /binary|cap|exceeds/i.test(errText)) {
              /* Exists (readable, or binary/over-cap — a real file nano
               * can still open; the reader's caps are not nano's). */
              store().print(`nano — [vault:${ctx.name}] ${resolved.rel} · real nano, restricted mode · ^O save · ^X exit`, 'info');
              s0.openNanoPty(resolved.rel);
            } else if (/no such file/i.test(errText)) {
              const designated = !!useNaksha.getState().careVaultStatus?.designated;
              if (designated) {
                store().print(`nano — [vault:${ctx.name}] ${resolved.rel} · NEW FILE — nano creates it on first save (^O)`, 'warning');
                s0.openNanoPty(resolved.rel);
              } else {
                store().print(`nano: [vault:${ctx.name}] ${errText} — creating real files needs a designated CareSpace vault ('vault designate on'); 'context internal' switches to the internal editor`, 'error');
              }
            } else {
              noteVaultFail(`nano: [vault:${ctx.name}] ${errText || 'read failed'}`);
            }
          } catch (err) {
            store().print(`nano: vault read failed: ${(err as Error).message}`, 'error');
          }
        })();
        return;
      }
      // Internal context — the virtual FS editor, unchanged behavior.
      const node = FileSystem.getNode(FileSystem.resolvePath(args));
      if (!node) {
        const wr = FileSystem.writeFile(args, '');
        if (!wr.success) { store().print(wr.error!, 'error'); return; }
      } else if (node.type === 'dir') {
        store().print(`Is a directory: ${args}`, 'error');
        return;
      }
      store().setNanoOpen(true, args);
    });

    /* ── Phase 2 — VAULT: the explicitly connected REAL directory ──────
     * `vault connect <abs-path>` is the ONLY way a real directory becomes
     * active (no silent access, ever). The reader surfaces are read-only
     * (GET-only API); writes belong to the REAL nano in the terminal —
     * since Phase 6 it is the actual `nano` binary over the PTY bridge,
     * jailed to this directory — and the watcher surfaces every save. */
    this.register(
      'vault',
      'Connect/browse a REAL directory (reader read-only · real nano writes)',
      'vault [connect <abs-path> | disconnect | status | doctor | check [fix] | recent [N] [dir] | find <query> [in <dir>] | history [path] | diff <path> [n [m]] | restore <path> <n> | erase <path> <n|all> | open <path> | refresh | tree | designate on|off]',
      'fs',
      (args) => {
        const s = useNaksha.getState();
        const parts = args.split(/\s+/).filter(Boolean);
        const sub = parts[0] ?? '';

        if (sub === 'connect') {
          const target = parts.slice(1).join(' ').trim();
          if (!target) { store().print('Usage: vault connect <ABSOLUTE path>', 'error'); return; }
          const loading = store().showLoading(`connecting to ${target}…`);
          void (async () => {
            const res = await s.connectVault(target);
            if (res.ok) {
              /* Fresh read — `s` is the pre-connect snapshot; connectVault
               * set() the store after it was taken, so s.vaultStatus would
               * print the stale `null (null) · 0 notes` receipt. */
              const vs = useNaksha.getState().vaultStatus;
              loading.stop(`connected: ${vs?.name} (${vs?.root})`, 'success');
              store().print(`  ${vs?.mdCount ?? 0} markdown notes · ${vs?.fileCount ?? 0} text files · read-only`, 'muted');
              store().print(`  active storage context → connected:${vs?.name ?? '?'} · internal FS untouched and fully active`, 'success');
              store().print("  'ls/cd/pwd/tree/cat/grep' now route to the real directory · 'context internal' routes them back", 'muted');
              store().print("  open the panel: 'vault' · read a note: 'vault open <path>' · 'context' names the worlds", 'muted');
            } else {
              loading.stop(`connect failed: ${res.error}`, 'error');
            }
          })();
          return;
        }

        if (sub === 'disconnect') {
          void (async () => {
            const vs = useNaksha.getState().vaultStatus;
            await useNaksha.getState().disconnectVault();
            store().print(`Disconnected${vs?.root ? `: ${vs.root}` : ''} — internal storage untouched, no files modified`, 'success');
            store().print('  active storage context → internal (every surface back on the browser-side FS)', 'info');
          })();
          return;
        }

        if (sub === 'open') {
          const target = parts.slice(1).join(' ').trim();
          if (!target) { store().print('Usage: vault open <relative/path.md>', 'error'); return; }
          const vs = useNaksha.getState().vaultStatus;
          if (!vs?.connected) { store().print('No vault connected — vault connect <abs-path> first', 'error'); return; }
          void (async () => {
            const res = await fetch(`/api/vault/resolve?q=${encodeURIComponent(target)}`, { cache: 'no-store' });
            const data = (await res.json()) as { ok: boolean; rel?: string | null };
            if (data.ok && data.rel) {
              useNaksha.getState().setVaultOpenFile(data.rel);
              useNaksha.getState().setVaultPanelOpen(true);
              store().print(`[vault:${vs.name}] opened ${data.rel} — read-only`, 'success');
            } else {
              store().print(`No note matches '${target}' in the connected directory`, 'error');
            }
          })();
          return;
        }

        if (sub === 'find') {
          /* v138 T7 round 5 — the TriliumNext search-parser port (their
           * services/search pipeline: lex → parens → parse → expression
           * tree; studied via https://deepwiki.com/TriliumNext/Notes).
           * Grammar: bare words = fulltext · note.title/content/text/
           * dates/contentsize with = != *=* =* *= > >= < <= %= · #label
           * [op value] (frontmatter pairs) · and/or/not(…) · orderby ·
           * limit. Read verb — answers for a merely-CONNECTED vault.
           * Args: `vault find <query>` · `vault find <query> in <dir>`
           * — the `in <dir>` scope is recognized only when the tail is
           * path-like (no operator characters), so a fulltext query that
           * merely contains the word "in" keeps working. */
          const vsNow = useNaksha.getState().vaultStatus;
          if (!vsNow?.connected || !vsNow.available) {
            store().print('No available vault connected — vault connect <abs-path> first', 'error');
            return;
          }
          /* args still carries the subcommand word ('find golden') — the
           * query is everything after it (bare `vault find` → usage). */
          const raw = args.trim().replace(/^find\b\s*/, '');
          if (!raw) {
            store().print('Usage: vault find <query> [in <dir>]  — e.g. vault find note.title *=* plan · vault find #status = done orderby note.dateModified desc limit 10', 'error');
            store().print('  fulltext: golden plans · title/content: note.title *=* x · labels: #status = done · boolean: (a or b) and not(c) · order: orderby note.dateModified desc · window: limit 20', 'muted');
            return;
          }
          /* Split an optional trailing ` in <dir>` (outside quotes,
           * path-like tail only). */
          let query = raw;
          let dir = '';
          let inQuote: string | null = null;
          let splitAt = -1;
          for (let i = 0; i < raw.length - 3; i++) {
            const ch = raw[i];
            if (inQuote) { if (ch === inQuote) inQuote = null; continue; }
            if (ch === '"' || ch === "'" || ch === '`') { inQuote = ch; continue; }
            if (ch === ' ' && raw.slice(i + 1, i + 4) === 'in ') splitAt = i;
          }
          if (splitAt !== -1) {
            const tail = raw.slice(splitAt + 4).trim();
            if (tail && !/[=*(<>!%#~]/.test(tail)) {
              query = raw.slice(0, splitAt).trim();
              dir = tail.replace(/\/+$/, '');
            }
          }
          const loading = store().showLoading('vault find: searching…');
          void (async () => {
            try {
              const res = await fetch('/api/vault/find', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, dir: dir || undefined }),
              });
              const data = (await res.json()) as {
                ok: boolean;
                parsed?: string;
                errors?: string[];
                matches?: Array<{ rel: string; title: string; size: number; mtimeMs: number; kind: 'node' | 'shape' | 'none'; tombstone: boolean; name?: string; snippet?: string }>;
                total?: number;
                scanned?: number;
                truncated?: boolean;
                contentReads?: number;
                error?: string;
              };
              if (!data.ok) {
                loading.stop(`vault find failed: ${data.error ?? 'search failed'}`, 'error');
                return;
              }
              loading.stop('vault find: done', 'success');
              store().header('Vault search (Trilium-style dialect)');
              const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
              sheetRows(
                [
                  ['query', query],
                  ['read as', data.parsed || '(empty)'],
                  ['scope', `[vault:${vsNow.name}] ${dir || '/'} · ${data.scanned ?? 0} md file(s) · ${data.contentReads ?? 0} body read(s)${data.truncated ? ' · capped' : ''}`],
                  ['matched', `${data.total ?? 0}${(data.matches?.length ?? 0) < (data.total ?? 0) ? ` · showing first ${data.matches?.length ?? 0}` : ''}`],
                ],
                { padFixed: 10, rightTone: 'output' },
              );
              if (data.errors && data.errors.length > 0) {
                for (const e of data.errors) store().print(`  parse: ${e}`, 'error');
              }
              if (!data.matches || data.matches.length === 0) {
                store().print(`  (no matches — the query matched 0 of ${data.scanned ?? 0} md file(s)${data.errors?.length ? ' · see parse notes above' : ''})`, 'muted');
                return;
              }
              for (const m of data.matches) {
                const label = m.kind === 'shape' ? `shape record${m.name ? ` (${m.name})` : ''}` : m.kind === 'node' ? 'care note' : 'markdown';
                const snippet = m.snippet ? ` — ${m.snippet}` : '';
                if (m.tombstone) {
                  store().print(`  † ${m.rel} — deleted shape record${m.name ? ` (${m.name})` : ''} · ${kb(m.size)}${snippet}`, 'muted');
                } else {
                  store().print(`  ${m.kind === 'shape' ? '◆' : m.kind === 'node' ? '●' : '·'} ${m.title} (${m.rel}) — ${label} · ${kb(m.size)}${snippet}`, 'output', {
                    /* Match rows are clickable: click = read the real file. */
                    fs: { path: m.rel, kind: 'file', world: 'vault' },
                  });
                }
              }
              if (data.truncated) store().print(`  … more matches exist (${data.matches.length} shown)`, 'muted');
              store().print('  ⇥ click a row to read the real file · line-level search: grep <pattern> · grammar: bare words · note.title *=* x · #label op value · and/or/not(…) · orderby · limit N', 'muted');
            } catch (err) {
              loading.stop(`vault find failed: ${(err as Error).message}`, 'error');
            }
          })();
          return;
        }

        if (sub === 'designate') {
          const mode = (parts[1] ?? '').toLowerCase();
          if (mode !== 'on' && mode !== 'off') {
            store().print('Usage: vault designate on|off', 'error');
            const cs = useNaksha.getState().careVaultStatus;
            store().print(cs ? `  current: ${cs.designated ? 'DESIGNATED' : cs.designatedFlag ? 'flag points at another root' : 'not designated'}` : '  status unknown — run once with on/off', 'muted');
            return;
          }
          void (async () => {
            const on = mode === 'on';
            const r = await useNaksha.getState().designateCareVault(on);
            if (!r.ok) { store().print(`vault designate: ${r.error}`, 'error'); return; }
            if (on) {
              const root = useNaksha.getState().careVaultStatus?.root ?? '';
              store().print(`Designated ${root} as the CareSpace vault`, 'success');
              store().print('  CareSpace may now CREATE and RENAME .md notes there (explicit commands only — careexport/carebind/node/rennode on bound thoughts)', 'muted');
              store().print('  no delete exists · existing files are overwritten only by an explicit careexport · un-designate: vault designate off', 'muted');
            } else {
              store().print('CareSpace designation cleared — the vault is read-only again, files untouched', 'success');
              store().print('  bound thoughts keep their paths; file sync pauses until re-designated', 'muted');
            }
          })();
          return;
        }

        if (sub === 'doctor') {
          /* Phase 7 — the safety/scope receipt: what is connected, is it
           * writable, is the watcher alive, is the PTY bridge reachable,
           * and which jail rules guard the real directory. Honest
           * numbers only — every row is fetched live, nothing cached. */
          const loading = store().showLoading('vault doctor: probing the live state…');
          void (async () => {
            const vs = await useNaksha.getState().refreshVaultStatus();
            const cs = await useNaksha.getState().refreshCareVaultStatus();
            // PTY bridge health: the service answers any path with a JSON
            // card. Through the gateway origin ?XTransformPort=3005 reaches
            // it; on a direct-:3000 origin Next answers with HTML — the
            // doctor then says the bridge is unreachable FROM HERE, which
            // is the honest observation, not a guess about the machine.
            let bridge = 'unreachable from this origin';
            try {
              const ctl = new AbortController();
              const t = setTimeout(() => ctl.abort(), 2500);
              const res = await fetch('/nano-pty-health?XTransformPort=3005', { cache: 'no-store', signal: ctl.signal });
              clearTimeout(t);
              const j = (await res.json().catch(() => null)) as { service?: string; runtime?: string } | null;
              bridge = j?.service === 'naksha-nano-pty' ? `up (${j.runtime ?? 'node'} · loopback :3005)` : 'answered, but not the PTY bridge';
            } catch {
              /* keep the honest unreachable copy */
            }
            loading.stop('vault doctor: done', 'success');
            store().header('Vault doctor — safety & scope');
            if (!vs?.connected) {
              store().print('  no directory connected — nothing to examine', 'output');
              store().print("  connect one first: vault connect <ABSOLUTE path>", 'muted');
              return;
            }
            const w = vs.watch;
            const watchRow = w
              ? `${w.armed ? 'armed' : 'idle (no listeners — zero cost)'} · sse clients ${w.clients} · snapshot ${w.snapshotEntries} files${w.lastEventAt ? ` · last event ${Math.max(0, Math.round((Date.now() - w.lastEventAt) / 1000))}s ago` : ''}`
              : 'unknown';
            sheetRows(
              [
                ['root', vs.root ?? '?'],
                ['state', vs.available ? 'connected · available' : 'connected · UNAVAILABLE (directory missing?)'],
                ['reader', 'GET-only — no write endpoints exist in the reader stack'],
                ['writable', vs.careVault ? 'DESIGNATED — CareSpace may create/rename .md notes here' : 'read-only (not designated)'],
                ['designate flag', cs?.designatedFlag ? 'on (points at the connected root)' : 'off'],
                ['watch', watchRow],
                ['pty bridge', bridge],
                ['jail', 'rel paths only · realpath containment · nano -R -I · no dotfiles · no leading -'],
              ],
              { padFixed: 15, rightTone: 'output' },
            );
            if (vs.careVault) {
              store().print('  ⚠ writable vault: real writes happen here — CareSpace notes and real nano saves hit the disk', 'warning');
              store().print('    the PTY jail above is the only write boundary; un-designate any time: vault designate off', 'muted');
            }
            store().print('  probe the jail yourself: bun scripts/security-probe.ts (36 cases, exit 1 on any leak)', 'muted');
          })();
          return;
        }

        if (sub === 'check') {
          /* v138 T7 — the TriliumNext consistency-check port (their
           * services/consistency_checks.ts runs at startup + hourly,
           * finding orphaned/invalid entities before they confuse anyone —
           * studied via https://deepwiki.com/TriliumNext/Notes, Data Model
           * and Persistence). Naksha's file-backed equivalent audits the
           * CareSpace↔vault bridge: broken bindings (file gone from the
           * real directory), duplicate bindings (two thoughts claiming one
           * file), and orphaned Naksha files (frontmatter present, no
           * app-side owner left). Report-first; `vault check fix` applies
           * the ONE safe repair — unbinding paths the directory no longer
           * has — which is metadata-only, exactly like Trilium's fixIssues
           * pruning invalid references. Files are never touched. */
          const fix = (parts[1] ?? '').toLowerCase() === 'fix';
          const vsNow = useNaksha.getState().vaultStatus;
          if (!vsNow?.connected || !vsNow.available) {
            store().print('No available vault connected — vault connect <abs-path> first', 'error');
            return;
          }
          const loading = store().showLoading('vault check: auditing bindings and Naksha files…');
          void (async () => {
            try {
              /* 1 · the app-side half of the bridge (ALL networks, not
               * just the current river — Trilium audits the whole tree). */
              const boundIds = new Map<string, string[]>();
              const boundLabels = new Map<string, string[]>();
              const nodeIds = new Set<string>();
              for (const net of CareSpace.data.networks) {
                for (const n of Object.values(net.nodes)) {
                  nodeIds.add(n.id);
                  if (n.vaultPath) {
                    boundIds.set(n.vaultPath, [...(boundIds.get(n.vaultPath) ?? []), n.id]);
                    boundLabels.set(n.vaultPath, [...(boundLabels.get(n.vaultPath) ?? []), n.label || n.id]);
                  }
                }
              }
              const ws = Storage.get<{ shapes?: Array<{ id: string; name?: string; file?: string }> } | null>(
                STORAGE_KEYS.workspace,
                null,
              );
              const shapeRels = new Map<string, string>();
              const shapeIds = new Set<string>();
              for (const sh of ws?.shapes ?? []) {
                shapeIds.add(sh.id);
                const sp = sh.file ? splitShapeRel(sh.file) : null;
                if (sp?.kind === 'vault') shapeRels.set(sp.bare, sh.name || sh.id);
              }
              const rels = [...new Set([...boundIds.keys(), ...shapeRels.keys()])];

              /* 2 · the server-side half: existence + Naksha inventory. */
              const res = await fetch('/api/vault/audit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rels }),
              });
              const data = (await res.json()) as {
                ok: boolean;
                exists?: Record<string, boolean>;
                nakshaFiles?: Array<{ rel: string; kind: 'node' | 'shape'; id: string; tombstone: boolean }>;
                scanned?: number;
                truncated?: boolean;
                error?: string;
              };
              if (!data.ok) {
                loading.stop(`vault check failed: ${data.error ?? 'audit failed'}`, 'error');
                return;
              }
              const exists = data.exists ?? {};
              const nakshaFiles = data.nakshaFiles ?? [];
              const missingNodeRels = [...boundIds.keys()].filter((rel) => exists[rel] === false);
              const missingShapeRels = [...shapeRels.keys()].filter((rel) => exists[rel] === false);
              const duplicateRels = [...boundLabels.entries()].filter(([, labels]) => labels.length > 1);
              const orphanNodeFiles = nakshaFiles.filter((f) => f.kind === 'node' && !nodeIds.has(f.id));
              const orphanShapeFiles = nakshaFiles.filter((f) => f.kind === 'shape' && !shapeIds.has(f.id));
              const tombstones = nakshaFiles.filter((f) => f.tombstone);
              const okBindings = rels.filter((rel) => exists[rel] === true).length;
              const problems =
                missingNodeRels.length + missingShapeRels.length + duplicateRels.length +
                orphanNodeFiles.length + orphanShapeFiles.length;

              /* 3 · the report — honest numbers first, then each finding. */
              loading.stop('vault check: done', 'success');
              store().header('Vault check — bridge consistency (Trilium-style)');
              sheetRows(
                [
                  ['root', vsNow.root ?? '?'],
                  ['bindings', `${rels.length} bound path(s) · ${okBindings} present · ${missingNodeRels.length + missingShapeRels.length} missing`],
                  ['duplicates', duplicateRels.length === 0 ? 'none' : `${duplicateRels.length} path(s) claimed by 2+ thoughts`],
                  ['naksha files', `${nakshaFiles.filter((f) => f.kind === 'node').length} note(s) · ${nakshaFiles.filter((f) => f.kind === 'shape').length} shape record(s)${tombstones.length ? ` · ${tombstones.length} tombstone(s)` : ''}`],
                  ['inventory scan', `${data.scanned ?? 0} markdown file(s)${data.truncated ? ' (capped at 800 — report may be partial)' : ''}`],
                  ['verdict', problems === 0 ? '✓ consistent' : `✗ ${problems} issue(s) found`],
                ],
                { padFixed: 15, rightTone: 'output' },
              );
              for (const rel of missingNodeRels) {
                store().print(`  ✗ broken binding: ${rel} — bound by ${(boundLabels.get(rel) ?? []).join(', ')} · file no longer in the directory`, 'error');
              }
              for (const rel of missingShapeRels) {
                store().print(`  ✗ broken shape record: ${rel} (${shapeRels.get(rel)}) · file no longer in the directory`, 'error');
              }
              for (const [rel, labels] of duplicateRels) {
                store().print(`  ⚠ duplicate binding: ${rel} — claimed by ${labels.join(', ')} · appends race each other; keep one`, 'warning');
              }
              for (const f of orphanNodeFiles) {
                store().print(`  ⚠ orphaned note file: ${f.rel} (naksha-node ${f.id}) · no thought references it — rebind or archive by hand`, 'warning');
              }
              for (const f of orphanShapeFiles) {
                store().print(
                  `  ⚠ orphaned shape record: ${f.rel} · no constellation uses it${f.tombstone ? ' (tombstone — already deleted)' : ' · restorable: clear the board and press Restore MD'}`,
                  f.tombstone ? 'muted' : 'warning',
                );
              }
              if (problems === 0) {
                store().print('  bridge is consistent — every binding resolves, every Naksha file has an owner', 'success');
              } else if (missingNodeRels.length > 0 && !fix) {
                store().print("  run 'vault check fix' to unbind the broken path(s) — metadata only, files untouched", 'muted');
              }
              if (fix) {
                /* 4 · the safe repair: unbind what the directory lost.
                 * Shape records have no unbind (the record IS the shape's
                 * identity); they stay reported. */
                let fixed = 0;
                for (const rel of missingNodeRels) {
                  for (const id of boundIds.get(rel) ?? []) {
                    const r = CareSpace.unbindNode(id);
                    if (r.success) fixed++;
                  }
                }
                if (fixed > 0) {
                  await useNaksha.getState().refreshCareBoundState();
                  store().print(`Fixed: ${fixed} broken binding(s) unbound — the thoughts remain, only the dead path reference is gone`, 'success');
                  store().print('  rebind any time: carebind <node> "<path.md>"', 'muted');
                } else {
                  store().print('Nothing to fix — no broken node bindings', 'muted');
                }
              }
            } catch (err) {
              loading.stop(`vault check failed: ${(err as Error).message}`, 'error');
            }
          })();
          return;
        }

        if (sub === 'recent') {
          /* v138 T7 round 2 — the TriliumNext recent-changes port (their
           * routes/api/recent_changes.ts getRecentChanges: collect change
           * points → sort newest-first → cap the list → surface deletions
           * visibly; studied via https://deepwiki.com/TriliumNext/Notes).
           * The file-backed equivalent: the vault's .md files by mtime,
           * Naksha-classified in the window (● care note · ◆ shape record
           * · plain markdown), tombstones shown muted like upstream's
           * deleted rows. Answers "what changed in the directory lately —
           * including outside the app?" before `vault check` is needed. */
          const vsNow = useNaksha.getState().vaultStatus;
          if (!vsNow?.connected || !vsNow.available) {
            store().print('No available vault connected — vault connect <abs-path> first', 'error');
            return;
          }
          /* Arg forms: `vault recent` · `vault recent 40` ·
           * `vault recent sub/dir` · `vault recent 40 sub/dir`. */
          const nRaw = parts[1] ?? '';
          const numeric = /^\d+$/.test(nRaw);
          const limit = numeric ? parseInt(nRaw, 10) : 20;
          const dir = (numeric ? parts.slice(2).join(' ') : parts.slice(1).join(' ')).trim().replace(/\/+$/, '');
          const loading = store().showLoading('vault recent: scanning the directory…');
          void (async () => {
            try {
              const res = await fetch('/api/vault/recent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ limit, dir: dir || undefined }),
              });
              const data = (await res.json()) as {
                ok: boolean;
                changes?: Array<{ rel: string; mtimeMs: number; size: number; kind: 'node' | 'shape' | 'none'; tombstone: boolean; name?: string }>;
                scanned?: number;
                truncated?: boolean;
                error?: string;
              };
              if (!data.ok) {
                loading.stop(`vault recent failed: ${data.error ?? 'scan failed'}`, 'error');
                return;
              }
              const changes = data.changes ?? [];
              loading.stop('vault recent: done', 'success');
              store().header('Vault recent changes (Trilium-style)');
              const ago = (ms: number) => {
                const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
                if (s < 60) return `${s}s ago`;
                const m = Math.floor(s / 60);
                if (m < 60) return `${m}m ago`;
                const h = Math.floor(m / 60);
                if (h < 24) return `${h}h ago`;
                return `${Math.floor(h / 24)}d ago`;
              };
              sheetRows(
                [
                  ['root', vsNow.root ?? '?'],
                  ['window', `newest ${changes.length} of ${data.scanned ?? 0} markdown file(s)${dir ? ` under ${dir}/` : ''}${data.truncated ? ' (walk capped at 800 — result may be partial)' : ''}`],
                  ['sources', 'filesystem mtime — every writer shows: app, nano, Obsidian, anything'],
                ],
                { padFixed: 10, rightTone: 'output' },
              );
              if (changes.length === 0) {
                store().print(dir ? `  no markdown files under ${dir}/` : '  no markdown files in the vault yet', 'muted');
                return;
              }
              for (const c of changes) {
                const when = ago(c.mtimeMs);
                const kb = c.size >= 1024 ? `${(c.size / 1024).toFixed(1)} KB` : `${c.size} B`;
                if (c.tombstone) {
                  store().print(`  † ${when.padEnd(8)} ${c.rel} — deleted shape record${c.name ? ` (${c.name})` : ''} · ${kb} · restorable via workspace Restore MD`, 'muted');
                } else if (c.kind === 'shape') {
                  store().print(`  ◆ ${when.padEnd(8)} ${c.rel} — shape record${c.name ? ` (${c.name})` : ''} · ${kb}`, 'output');
                } else if (c.kind === 'node') {
                  store().print(`  ● ${when.padEnd(8)} ${c.rel} — care note · ${kb}`, 'output');
                } else {
                  store().print(`  · ${when.padEnd(8)} ${c.rel} · ${kb}`, 'output');
                }
              }
              store().print('  ● naksha care note · ◆ naksha shape record · · plain markdown · † deleted (tombstone)', 'muted');
              store().print("  read one: 'vault open <path>' · audit the bridge afterwards: 'vault check'", 'muted');
            } catch (err) {
              loading.stop(`vault recent failed: ${(err as Error).message}`, 'error');
            }
          })();
          return;
        }

        if (sub === 'history') {
          /* v138 T7 round 3 — the TriliumNext note-revisions port (their
           * note_revisions table + revisions tab; studied in earlier
           * rounds via https://deepwiki.com/TriliumNext/Notes). Overwrites
           * through the app archive the content about to disappear;
           * external saves (nano/Obsidian) are archived by the watcher as
           * "observed" states. Read verb — answers for a merely-CONNECTED
           * vault, like `vault recent`. Arg forms: `vault history` ·
           * `vault history <path>`. */
          const vsNow = useNaksha.getState().vaultStatus;
          if (!vsNow?.connected || !vsNow.available) {
            store().print('No available vault connected — vault connect <abs-path> first', 'error');
            return;
          }
          const rel = parts.slice(1).join(' ').trim().replace(/\/+$/, '');
          const loading = store().showLoading(rel ? 'vault history: reading the archive…' : 'vault history: indexing the archive…');
          void (async () => {
            try {
              const res = await fetch('/api/vault/revisions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rel: rel || undefined }),
              });
              const data = (await res.json()) as {
                ok: boolean;
                paths?: Array<{ rel: string; count: number; latestTs: number; latestKind: 'app' | 'observed' }>;
                entries?: Array<{ id: string; ts: number; size: number; kind: 'app' | 'observed'; reason: string; head?: string; delta?: { added: number; removed: number } }>;
                error?: string;
              };
              if (!data.ok) {
                loading.stop(`vault history failed: ${data.error ?? 'list failed'}`, 'error');
                return;
              }
              const ago = (ms: number) => {
                const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
                if (s < 60) return `${s}s ago`;
                const m = Math.floor(s / 60);
                if (m < 60) return `${m}m ago`;
                const h = Math.floor(m / 60);
                if (h < 24) return `${h}h ago`;
                return `${Math.floor(h / 24)}d ago`;
              };
              const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
              loading.stop('vault history: done', 'success');
              if (!rel) {
                store().header('Vault revision archive (Trilium-style)');
                const paths = data.paths ?? [];
                sheetRows(
                  [
                    ['root', vsNow.root ?? '?'],
                    ['paths', `${paths.length} path(s) with revisions · stored in Naksha's own db/revisions — the vault stays pristine`],
                  ],
                  { padFixed: 8, rightTone: 'output' },
                );
                if (paths.length === 0) {
                  store().print('  no revisions yet — overwriting a note (or an external nano save) starts its history', 'muted');
                  store().print("  inspect one: 'vault history <path>' · what changed lately: 'vault recent'", 'muted');
                  return;
                }
                for (const p of paths) {
                  const glyph = p.latestKind === 'app' ? '✎' : '⌁';
                  store().print(`  ⟲ ${String(p.count).padStart(3)} rev · ${ago(p.latestTs).padEnd(8)} ${glyph} ${p.rel}`, 'output');
                }
                store().print("  detail + restore: 'vault history <path>' · restore needs a designated vault", 'muted');
                return;
              }
              store().header(`Revisions — ${rel}`);
              const entries = data.entries ?? [];
              sheetRows(
                [
                  ['archive', `${entries.length} revision(s) · newest first · keep-last-20 policy (Trilium-style)`],
                  ['sources', '✎ archived by the app before an overwrite · ⌁ observed external save (nano/Obsidian)'],
                ],
                { padFixed: 10, rightTone: 'output' },
              );
              if (entries.length === 0) {
                store().print('  no revisions for this path yet', 'muted');
                store().print("  an overwrite through the app — or an external nano save while the vault is watched — starts the history", 'muted');
                return;
              }
              entries.forEach((e, i) => {
                const n = String(i + 1).padStart(2);
                const glyph = e.kind === 'app' ? '✎' : '⌁';
                const delta = e.delta ? `  +${e.delta.added} −${e.delta.removed}` : '';
                const head = e.head ? `  "${e.head}"` : '';
                const connector = i === 0 ? '┌' : i === entries.length - 1 ? '└' : '│';
                store().print(
                  `  ${connector} [${n}] ${glyph} ${ago(e.ts).padEnd(8)} ${kb(e.size).padStart(8)}  ${e.reason}${delta}${head}`,
                  i === 0 ? 'output' : 'muted',
                );
              });
              store().print('  newest at the top — the live file is the next state after [1] · +a −b = line delta vs the previous revision', 'muted');
              store().print("  what changed: 'vault diff <path> [n [m]]' · restore: 'vault restore <path> <n>' (designated vault) · erase: 'vault erase <path> <n|all>'", 'muted');
            } catch (err) {
              loading.stop(`vault history failed: ${(err as Error).message}`, 'error');
            }
          })();
          return;
        }

        if (sub === 'diff') {
          /* v138 T7 round 4 — the TriliumNext revisions-diff port (their
           * revisions tab diffs note revisions; upstream attribution in
           * lib/server/revisions.ts + text-diff.ts). Argument forms:
           * `vault diff <path>` · `vault diff <path> <n>` ·
           * `vault diff <path> <n> <m>` — n/m are the [n] indices from
           * 'vault history <path>' (newest-first). Direction: '+' lines
           * exist in the "to" side, '−' in the "from" side. Read verb. */
          const vsNow = useNaksha.getState().vaultStatus;
          if (!vsNow?.connected || !vsNow.available) {
            store().print('No available vault connected — vault connect <abs-path> first', 'error');
            return;
          }
          const rel = (parts[1] ?? '').replace(/\/+$/, '');
          const numsRaw = parts.slice(2);
          if (!rel || numsRaw.some((t) => !/^\d+$/.test(t))) {
            store().print("Usage: vault diff <path> [n [m]]  — n/m are the [n] indices from 'vault history <path>'", 'error');
            return;
          }
          const nums = numsRaw.map((t) => parseInt(t, 10));
          const loading = store().showLoading('vault diff: computing…');
          void (async () => {
            try {
              let aId: string | undefined;
              let bId: string | undefined;
              if (nums.length > 0) {
                const listRes = await fetch('/api/vault/revisions', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ rel }),
                });
                const list = (await listRes.json()) as { ok: boolean; entries?: Array<{ id: string }>; error?: string };
                if (!list.ok) {
                  loading.stop(`vault diff failed: ${list.error ?? 'list failed'}`, 'error');
                  return;
                }
                const entries = list.entries ?? [];
                const pick = (n: number): string | undefined =>
                  n >= 1 && n <= entries.length ? entries[n - 1].id : undefined;
                aId = pick(nums[0]);
                if (aId === undefined) {
                  loading.stop(`vault diff failed: [${nums[0]}] is out of range — ${entries.length} revision(s); see 'vault history ${rel}'`, 'error');
                  return;
                }
                if (nums.length > 1) {
                  bId = pick(nums[1]);
                  if (bId === undefined) {
                    loading.stop(`vault diff failed: [${nums[1]}] is out of range — ${entries.length} revision(s)`, 'error');
                    return;
                  }
                }
              }
              const res = await fetch('/api/vault/revisions/diff', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rel, a: aId, b: bId }),
              });
              const data = (await res.json()) as {
                ok: boolean;
                a?: { id: string | null; label: string };
                b?: { id: string | null; label: string };
                lines?: Array<{ kind: 'same' | 'add' | 'del'; text: string }>;
                stats?: { added: number; removed: number };
                error?: string;
              };
              if (!data.ok) {
                loading.stop(`vault diff failed: ${data.error ?? 'diff failed'}`, 'error');
                return;
              }
              loading.stop('vault diff: done', 'success');
              store().header(`Diff — ${rel}`);
              sheetRows(
                [
                  ['from', data.a?.label ?? '?'],
                  ['to', data.b?.label ?? '?'],
                  ['delta', `+${data.stats?.added ?? 0} −${data.stats?.removed ?? 0} lines`],
                ],
                { padFixed: 8, rightTone: 'output' },
              );
              const lines = data.lines ?? [];
              /* Hunk compression: keep every change plus ONE context line
               * around it; gaps become a muted ⋯ — a unified-diff feel
               * that stays small even for big files. */
              const keep = new Array<boolean>(lines.length).fill(false);
              lines.forEach((l, i) => {
                if (l.kind !== 'same') {
                  keep[i] = true;
                  if (i > 0) keep[i - 1] = true;
                  if (i < lines.length - 1) keep[i + 1] = true;
                }
              });
              const SHOW_CAP = 80;
              let shown = 0;
              let hidden = 0;
              let lastKept = -2;
              for (let i = 0; i < lines.length; i++) {
                if (!keep[i]) continue;
                if (shown >= SHOW_CAP) {
                  hidden++;
                  continue;
                }
                if (lastKept < i - 1) store().print('  ⋯', 'muted');
                const l = lines[i];
                if (l.kind === 'del') store().print(`  − ${l.text}`, 'error');
                else if (l.kind === 'add') store().print(`  + ${l.text}`, 'success');
                else store().print(`    ${l.text}`, 'muted');
                shown++;
                lastKept = i;
              }
              if (hidden > 0) store().print(`  ⋯ ${hidden} more change line(s) hidden — cap 80`, 'muted');
              if (lines.every((l) => l.kind === 'same')) store().print('  identical content', 'muted');
              store().print("  read the live file: 'vault open <path>' · full history: 'vault history <path>'", 'muted');
            } catch (err) {
              loading.stop(`vault diff failed: ${(err as Error).message}`, 'error');
            }
          })();
          return;
        }

        if (sub === 'restore') {
          /* Write verb — the route enforces the designated-vault gate and
           * answers honestly when it's off. Reversible by construction:
           * the pre-restore content is archived before the old state is
           * written back (upstream's restore semantics). */
          const vsNow = useNaksha.getState().vaultStatus;
          if (!vsNow?.connected || !vsNow.available) {
            store().print('No available vault connected — vault connect <abs-path> first', 'error');
            return;
          }
          const rel = (parts[1] ?? '').replace(/\/+$/, '');
          const nRaw = parts[2] ?? '';
          if (!rel || !/^\d+$/.test(nRaw)) {
            store().print("Usage: vault restore <path> <n>  — n is the [n] index from 'vault history <path>'", 'error');
            return;
          }
          const n = parseInt(nRaw, 10);
          const loading = store().showLoading(`vault restore: resolving revision [${n}]…`);
          void (async () => {
            try {
              const listRes = await fetch('/api/vault/revisions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rel }),
              });
              const list = (await listRes.json()) as { ok: boolean; entries?: Array<{ id: string; ts: number; size: number; kind: 'app' | 'observed'; reason: string }>; error?: string };
              if (!list.ok) {
                loading.stop(`vault restore failed: ${list.error ?? 'list failed'}`, 'error');
                return;
              }
              const entries = list.entries ?? [];
              if (n < 1 || n > entries.length) {
                loading.stop(`vault restore failed: [${n}] is out of range — ${entries.length} revision(s); see 'vault history ${rel}'`, 'error');
                return;
              }
              const target = entries[n - 1]; // newest-first listing order
              const res = await fetch('/api/vault/revisions/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rel, id: target.id }),
              });
              const data = (await res.json()) as { ok: boolean; restoredId?: string; restoredSize?: number; shieldId?: string | null; error?: string };
              if (!data.ok) {
                loading.stop(`vault restore failed: ${data.error ?? 'restore failed'}`, 'error');
                return;
              }
              const kb = (target.size >= 1024 ? `${(target.size / 1024).toFixed(1)} KB` : `${target.size} B`);
              loading.stop('vault restore: done', 'success');
              store().header('Vault restore (Trilium-style)');
              sheetRows(
                [
                  ['restored', `${rel} ← revision ${data.restoredId} (${kb}, was ${target.reason})`],
                  ['shield', `the pre-restore content was archived first${data.shieldId ? ` as ${data.shieldId}` : ''} — it is the newest entry in 'vault history'`],
                  ['undo', `restore [1] from 'vault history ${rel}' to undo this restore`],
                ],
                { padFixed: 10, rightTone: 'output' },
              );
              store().print("  the reader will show the old state after 'vault refresh' (or wait for the watcher)", 'muted');
            } catch (err) {
              loading.stop(`vault restore failed: ${(err as Error).message}`, 'error');
            }
          })();
          return;
        }

        if (sub === 'erase') {
          /* Metadata hygiene on Naksha's own archive — the vault file is
           * never touched, so like `vault check fix` this is a read-context
           * verb (connected, not designated). Forms: `vault erase <path>
           * <n>` · `vault erase <path> all`. */
          const vsNow = useNaksha.getState().vaultStatus;
          if (!vsNow?.connected || !vsNow.available) {
            store().print('No available vault connected — vault connect <abs-path> first', 'error');
            return;
          }
          const rel = (parts[1] ?? '').replace(/\/+$/, '');
          const which = parts[2] ?? '';
          if (!rel || !which) {
            store().print("Usage: vault erase <path> <n|all>  — n is the [n] index from 'vault history <path>'", 'error');
            return;
          }
          const loading = store().showLoading(`vault erase: resolving '${which}'…`);
          void (async () => {
            try {
              let id: string | undefined;
              if (which !== 'all') {
                if (!/^\d+$/.test(which)) {
                  loading.stop('vault erase failed: last argument must be an [n] index or all', 'error');
                  return;
                }
                const n = parseInt(which, 10);
                const listRes = await fetch('/api/vault/revisions', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ rel }),
                });
                const list = (await listRes.json()) as { ok: boolean; entries?: Array<{ id: string }>; error?: string };
                if (!list.ok) {
                  loading.stop(`vault erase failed: ${list.error ?? 'list failed'}`, 'error');
                  return;
                }
                const entries = list.entries ?? [];
                if (n < 1 || n > entries.length) {
                  loading.stop(`vault erase failed: [${n}] is out of range — ${entries.length} revision(s)`, 'error');
                  return;
                }
                id = entries[n - 1].id;
              }
              const res = await fetch('/api/vault/revisions/erase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rel, id }),
              });
              const data = (await res.json()) as { ok: boolean; erased?: number; error?: string };
              if (!data.ok) {
                loading.stop(`vault erase failed: ${data.error ?? 'erase failed'}`, 'error');
                return;
              }
              loading.stop(`erased ${data.erased ?? 0} revision(s) of ${rel}${id ? ` (${id})` : ' (all)'} — the file itself was never touched`, 'success');
            } catch (err) {
              loading.stop(`vault erase failed: ${(err as Error).message}`, 'error');
            }
          })();
          return;
        }

        if (sub === 'refresh') {
          useNaksha.getState().bumpVaultRevision();
          void useNaksha.getState().refreshVaultStatus();
          store().print('Vault refreshed from the real directory', 'success');
          return;
        }

        if (sub === 'tree') {
          const vs = useNaksha.getState().vaultStatus;
          if (!vs?.connected || !vs.available) { store().print('No available vault connected', 'error'); return; }
          void (async () => {
            const res = await fetch('/api/vault/tree?max=150', { cache: 'no-store' });
            const data = (await res.json()) as {
              ok: boolean; entries?: Array<{ rel: string; name: string; isDir: boolean; depth: number }>; error?: string;
            };
            if (!data.ok || !data.entries) { store().print(data.error ?? 'tree failed', 'error'); return; }
            store().header(`vault tree — ${vs.name} (${data.entries.length} entries)`);
            for (const e of data.entries) {
              const indent = '  ' + '│ '.repeat(e.depth);
              store().print(
                `${indent}\uE000${e.isDir ? 'gold' : 'text'}\uE001${e.isDir ? '▣' : '▤'}\uE002  ${e.name}${e.isDir ? '/' : ''}`,
                'output',
                /* Phase 4 — rows wear the vault world marker so a click
                 * enters/reads the REAL directory (they used to dead-end
                 * against the internal FS). */
                { fs: { path: e.rel, kind: e.isDir ? 'dir' : 'file', world: 'vault' } },
              );
            }
            store().print('  ⇥ click a folder row to enter it · a file row to read it', 'muted');
            store().print("  read: 'vault open <path>' (read-only) · 'vault refresh' re-walks", 'muted');
          })();
          return;
        }

        /* bare `vault` (and `vault status`) — the receipt sheet + the panel.
         * Phase 2 QA follow-up: the receipt alone hid the GUI (and with no
         * vault connected, the panel IS the connect form). Opening it is
         * the honest default; Esc closes and the receipt stays readable. */
        void (async () => {
          const vs = await useNaksha.getState().refreshVaultStatus();
          useNaksha.getState().setVaultPanelOpen(true);
          store().header('Vault — connected real directory (read-only)');
          if (!vs || !vs.connected) {
            store().print('  state        no directory connected', 'output');
            store().print("  connect      vault connect <ABSOLUTE path>  · or 'vault' panel", 'muted');
            store().print('  internal storage is a separate world and stays fully active', 'muted');
            return;
          }
          sheetRows(
            [
              ['state', vs.available ? 'connected · available' : 'connected · UNAVAILABLE'],
              ['name', vs.name ?? '?'],
              ['root', vs.root ?? '?'],
              ['notes', `${vs.mdCount} markdown · ${vs.fileCount} text files`],
              ['mode', 'reader read-only · writes: real nano (nano <file>, PTY bridge)'],
              ['care vault', vs.careVault ? 'DESIGNATED — CareSpace may write .md notes here' : 'not designated (read-only for CareSpace too)'],
              ['changes', 'auto via watcher · recent: vault recent · history: vault history · manual: vault refresh'],
              ['search', "dialect: vault find <query> · line-level: grep <pattern>"],
            ],
            { padFixed: 10, rightTone: 'output' },
          );
          store().print("  open panel: 'vault' · read: 'vault open <path>' · browse: 'vault tree' · search: 'vault find <query>' · recent: 'vault recent' · history: 'vault history <path>' · designate: 'vault designate on' · audit: 'vault doctor' · consistency: 'vault check'", 'muted');
        })();
      },
    );

    /* ── Phase 3 — CONTEXT: name the active storage world ──────────────
     * The internal FS and the connected vault stay SEPARATE modules;
     * this command names which world is active, switches it explicitly
     * (never silently), and states the routing truth. Phase 4: the
     * read fs verbs FOLLOW the context — the sheet shows the live
     * vault-world cwd so the user can see where the terminal stands. */
    this.register(
      'context',
      'Show or switch the active storage context — routes ls/cd/pwd/tree/cat/grep',
      'context [internal | connected]',
      'fs',
      (args) => {
        const sub = args.trim().toLowerCase();
        if (sub === 'internal' || sub === 'connected') {
          applyStorageContextChoice(sub);
          return;
        }
        if (sub && sub !== 'status') {
          store().print(`Unknown storage context: ${args} — use internal | connected`, 'error');
          return;
        }
        void (async () => {
          // Refresh first: the context is only as honest as the live status.
          const vs = await useNaksha.getState().refreshVaultStatus();
          const s = useNaksha.getState();
          const ctx = resolveStorageContext(s.settings.storageContext, vs);
          store().header('Storage context');
          sheetRows(
            [
              ['active', contextChipLabel(ctx) + (ctx.reason === 'fallback-unavailable' ? '  ⚠ fallback' : '')],
              ['pref', `${s.settings.storageContext ?? 'internal (default)'}  (use 'context internal|connected')`],
              ['vault', !vs?.connected ? 'none connected' : vs.available ? `${vs.name} · available` : `${vs.name ?? '?'} · UNAVAILABLE`],
              ['vault cwd', ctx.kind === 'connected' ? `${s.vaultCwd || '/'} (the terminal's home inside the vault)` : '—'],
              ['why', ctx.reason],
            ],
            { padFixed: 10, rightTone: 'output' },
          );
          store().print(`  routes: ${contextRoutingLine(ctx)}`, 'muted');
          store().print('  worlds stay separate: nothing copies, maps, or migrates between them', 'muted');
        })();
      },
    );

    this.register('mkdir', 'Create directory', 'mkdir <dir>', 'fs', (args) => {
      if (!args) { store().print('Usage: mkdir <dir>', 'error'); return; }
      const r = FileSystem.makeDirectory(args);
      if (r.success) { store().print(`Directory created: ${args}`, 'success'); store().syncFs(); hintInternalWrite('mkdir'); }
      else store().print(r.error!, 'error');
    });

    this.register('touch', 'Create empty file', 'touch <file>', 'fs', (args) => {
      if (!args) { store().print('Usage: touch <file>', 'error'); return; }
      const r = FileSystem.touchFile(args);
      if (r.success) { store().print(`File created: ${args}`, 'success'); store().syncFs(); hintInternalWrite('touch'); }
      else store().print(r.error!, 'error');
    });

    this.register('rm', 'Remove file or directory', 'rm [-r] <path>', 'fs', (args) => {
      if (!args) { store().print('Usage: rm [-r] <file/dir>', 'error'); return; }
      let recursive = false; let path = args;
      if (args.startsWith('-r ')) { recursive = true; path = args.slice(3).trim(); }
      else if (args === '-r' || args.startsWith('-r')) {
        const after = args.replace(/^-r\s*/, '').trim();
        if (after) { recursive = true; path = after; }
        else { store().print('Usage: rm [-r] <path>', 'error'); return; }
      }
      // snapshot for undo
      const targetPath = FileSystem.resolvePath(path);
      const node = FileSystem.getNode(targetPath);
      if (node) {
        const undo: UndoEntry = {
          kind: 'fs',
          label: `rm ${path}`,
          snapshot: JSON.parse(JSON.stringify(FileSystem.root)),
          ts: Date.now(),
        };
        store().setUndo(undo);
      }
      const r = FileSystem.remove(path, recursive);
      if (r.success) { store().print(`Removed: ${path}`, 'success'); store().syncFs(); hintInternalWrite('rm'); }
      else store().print(r.error!, 'error');
    });

    this.register('echo', 'Print text or write to file', 'echo <text> [> file]', 'fs', (args) => {
      if (!args) { store().print('', 'output'); return; }
      const m = args.match(/^(.*?)\s*(>>|>)\s*(\S+)$/);
      if (m) {
        const text = m[1].replace(/^["']|["']$/g, '');
        const append = m[2] === '>>';
        const file = m[3];
        const r = FileSystem.writeFile(file, text, append);
        if (r.success) { store().print(`Wrote to ${file}`, 'success'); hintInternalWrite('echo>'); }
        else store().print(r.error!, 'error');
      } else {
        store().print(args.replace(/^["']|["']$/g, ''), 'output');
      }
    });

    this.register('cp', 'Copy file or directory', 'cp [-r] <src> <dst>', 'fs', (args) => {
      const parts = args.split(/\s+/).filter(Boolean);
      let recursive = false;
      if (parts[0] === '-r') { recursive = true; parts.shift(); }
      if (parts.length < 2) { store().print('Usage: cp [-r] <src> <dst>', 'error'); return; }
      const [src, dst] = parts;
      const r = FileSystem.copy(src, dst);
      if (r.success) { store().print(`Copied: ${src} → ${dst}`, 'success'); store().syncFs(); hintInternalWrite('cp'); }
      else store().print(r.error!, 'error');
    });

    this.register('mv', 'Move or rename file', 'mv <src> <dst>', 'fs', (args) => {
      const parts = args.split(/\s+/).filter(Boolean);
      if (parts.length < 2) { store().print('Usage: mv <src> <dst>', 'error'); return; }
      const [src, dst] = parts;
      const r = FileSystem.move(src, dst);
      if (r.success) { store().print(`Moved: ${src} → ${dst}`, 'success'); store().syncFs(); hintInternalWrite('mv'); }
      else store().print(r.error!, 'error');
    });

    this.register('grep', 'Search in files', 'grep [-r] <pattern> <file>', 'fs', (args) => {
      let recursive = false; let rest = args;
      if (args.startsWith('-r ')) { recursive = true; rest = args.slice(3).trim(); }
      const parts = rest.split(/\s+/);

      /* Phase 4 — connected context: the search runs on the REAL files
       * via /api/vault/grep (regex, case-insensitive — the internal
       * engine's semantics), walking from the vault cwd by default.
       * Vault search is inherently recursive (a directory IS the unit);
       * `-r` is accepted and acknowledged in the footer. */
      const ctx = activeCtx();
      if (ctx.kind === 'connected') {
        if (!rest.trim()) { store().print('Usage: grep <pattern> [path] — searches the connected vault', 'error'); return; }
        const pattern = parts[0];
        /* QA (Phase 9) — `grep -i foo README.md` used to treat `-i` as
         * the PATTERN and fail with a confusing "no such file". The
         * vault search is always case-insensitive (server semantics) and
         * `-r` is already acknowledged above; any other leading dash is
         * a flag this dialect doesn't have — say so instead of losing
         * the user inside a path error. */
        if (pattern.startsWith('-')) {
          store().print('grep: unknown flag — vault search is always case-insensitive and recursive (flags other than -r are not recognized)', 'error');
          store().print('  usage: grep <pattern> [path]   ·  to search a literal dash, drop it or use a character class: grep [-]foo .', 'muted');
          return;
        }
        const pathArg = parts.slice(1).join(' ').trim();
        const s0 = useNaksha.getState();
        const resolved = resolveVaultPath(s0.vaultCwd, pathArg || '.');
        if (!resolved.ok) { store().print(`grep: ${resolved.error}`, 'error'); return; }
        const loading = store().showLoading(`[vault:${ctx.name}] searching "${pattern}"…`);
        void (async () => {
          try {
            const res = await fetch(
              `/api/vault/grep?q=${encodeURIComponent(pattern)}&p=${encodeURIComponent(resolved.rel)}&max=100`,
              { cache: 'no-store' },
            );
            const data = (await res.json()) as {
              ok: boolean;
              matches?: Array<{ rel: string; line: number; text: string }>;
              truncated?: boolean;
              error?: string;
            };
            if (!data.ok || !data.matches) { noteVaultFailStop(loading, `grep: [vault:${ctx.name}] ${data.error ?? 'search failed'}`); return; }
            if (data.matches.length === 0) {
              loading.stop(`(no matches for "${pattern}" — [vault:${ctx.name}] ${resolved.rel || '/'})`, 'muted');
              return;
            }
            loading.stop(`Matches for "${pattern}" — [vault:${ctx.name}] ${resolved.rel || '/'} (${data.matches.length})`, 'header');
            for (const m of data.matches) {
              /* Match rows are clickable: click = cat the real file. */
              store().print(`${m.rel}:${m.line}: ${m.text}`, 'output', {
                fs: { path: m.rel, kind: 'file', world: 'vault' },
              });
            }
            if (data.truncated) store().print('  … more matches exist (100 shown)', 'muted');
            store().print('  ⇥ click a match row to read the real file · vault search is always recursive', 'muted');
          } catch (err) {
            loading.stop(`vault grep failed: ${(err as Error).message}`, 'error');
          }
        })();
        return;
      }

      if (parts.length < 2) { store().print('Usage: grep [-r] <pattern> <file>', 'error'); return; }
      const pattern = parts[0];
      const file = parts.slice(1).join(' ');
      const r = FileSystem.grep(pattern, file, recursive);
      if ('error' in r) { store().print(r.error, 'error'); return; }
      if (r.matches.length === 0) { store().print('(no matches)', 'muted'); return; }
      store().header(`Matches for "${pattern}" (${r.matches.length})`);
      r.matches.forEach((m) => {
        store().print(`${m.file}:${m.line}: ${m.text}`, 'output');
      });
    });

    this.register('export', 'Download all data as backup', 'export', 'fs', () => {
      const backup = {
        version: 2,
        timestamp: Date.now(),
        filesystem: FileSystem.exportAll(),
        carespace: CareSpace.exportAll(),
        settings: store().settings,
        aliases: store().aliases,
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `naksha-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      store().print(`Backup downloaded (${formatSize(blob.size)})`, 'success');
    });

    this.register('import', 'Restore from backup (uploads a file)', 'import', 'fs', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (data.filesystem) {
            const r = FileSystem.importAll(data.filesystem);
            if (!r.success) { store().print(r.error!, 'error'); return; }
          }
          if (data.carespace) {
            const r = CareSpace.importAll(data.carespace);
            if (!r.success) { store().print(r.error!, 'error'); return; }
          }
          if (data.settings) store().setSettings(data.settings);
          if (data.aliases) {
            Object.entries(data.aliases).forEach(([k, v]) => store().setAlias(k, v as string));
          }
          store().print(`Backup restored from ${file.name}`, 'success');
          syncAll();
        } catch (err) {
          store().print(`Import failed: ${(err as Error).message}`, 'error');
        }
      };
      input.click();
    });

    /* ────────────────── CARESPACE ────────────────── */
    this.register('idea', 'Create a new network (max 3)', 'idea <name>', 'care', (args) => {
      /* Strip wrapping quotes — `idea "My Net"` names the net, quotes off
       * (same rule as node names; Task 34). */
      const name = args.trim().replace(/^["']|["']$/g, '');
      if (!name) { store().print('Usage: idea <name>', 'error'); return; }
      /* Task 83 — same undo parity as `node`: network creation parks the
       * pre-creation doc, ⌘Z removes the river again (wholesale restore
       * — networks array and current index both come back). */
      const undo: UndoEntry = {
        kind: 'care',
        label: `idea ${name}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.createNetwork(name);
      if (r.success) {
        store().setUndo(undo);
        store().print(`Network "${name}" created (${CareSpace.networks().length}/${MAX_NETWORKS}) — undo available`, 'success');
        store().syncCare();
      } else store().print(r.error!, 'error');
    });

    this.register('use', 'Switch to a network', 'use <name>', 'care', (args) => {
      /* Strip wrapping quotes — multi-word network names are naturally
       * quoted (Task 34, same rule as node names). */
      const name = args.trim().replace(/^["']|["']$/g, '');
      if (!name) { store().print('Usage: use <name>', 'error'); return; }
      const r = CareSpace.switchNetwork(name);
      if (r.success) {
        store().print(`Switched to "${name}"`, 'success');
        store().syncCare();
        /* Task 35: apply the network's own basemap preference. A network
         * bound to "Ocean" wants water-blue OSM; one bound to "Night Ops"
         * wants dark tiles. Explicit per-network choice → also persists
         * into settings so the theme-migration logic stays consistent. */
        const net = CareSpace.currentNetwork();
        if (net.mapLayer && net.mapLayer !== MapEngine.currentLayer) {
          MapEngine.setLayer(net.mapLayer);
          useNaksha.getState().setMapLayer(net.mapLayer);
          useNaksha.getState().setSettings({ mapDefaultLayer: net.mapLayer });
          store().print(`Basemap → ${net.mapLayer} (network preference — 'netlayer clear' unbinds)`, 'muted');
        }
      } else store().print(r.error!, 'error');
    });

    /* Task 35 — per-network basemap preference. Each river of thought can
     * declare the terrain it belongs to; `use <net>` follows it. */
    this.register('netlayer', 'Bind a basemap layer to the current network', 'netlayer [layer|clear]', 'care', (args) => {
      const arg = args.trim().toLowerCase();
      const net = CareSpace.currentNetwork();
      if (!arg) {
        store().print(`Network "${net.name}" layer: ${net.mapLayer ?? '(theme default)'}`, 'info');
        store().print(`Set: netlayer <${Object.keys(MAP_LAYERS).join('|')}> · unbind: netlayer clear`, 'muted');
        return;
      }
      const undo: UndoEntry = {
        kind: 'care',
        label: `netlayer ${arg.slice(0, 14)}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      if (arg === 'clear') {
        delete net.mapLayer;
        CareSpace.save();
        store().setUndo(undo);
        store().syncCare();
        store().print(`Network "${net.name}" follows the theme default again — undo available`, 'success');
        return;
      }
      if (!MAP_LAYERS[arg as MapLayerKey]) {
        store().print(`Unknown layer: ${arg}`, 'error');
        store().print(`Available: ${Object.keys(MAP_LAYERS).join(', ')}`, 'muted');
        return;
      }
      net.mapLayer = arg as MapLayerKey;
      CareSpace.save();
      store().setUndo(undo);
      store().syncCare();
      MapEngine.setLayer(net.mapLayer);
      useNaksha.getState().setMapLayer(net.mapLayer);
      useNaksha.getState().setSettings({ mapDefaultLayer: net.mapLayer });
      store().print(`Network "${net.name}" bound to ${arg} basemap (applies on 'use') — undo available`, 'success');
    });

    this.register('drop', 'Remove a network', 'drop <name>', 'care', (args) => {
      const name = args.trim().replace(/^["']|["']$/g, '');
      if (!name) { store().print('Usage: drop <name>', 'error'); return; }
      // snapshot for undo
      const undo: UndoEntry = {
        kind: 'network',
        label: `drop ${name}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      store().setUndo(undo);
      const r = CareSpace.dropNetwork(name);
      if (r.success) {
        store().print(`Dropped network "${name}"`, 'success');
        store().syncCare();
      } else store().print(r.error!, 'error');
    });

    this.register('rennet', 'Rename a network', 'rennet <old> to <new>', 'care', (args) => {
      const pair = splitToPair(args);
      if (!pair) { store().print('Usage: rennet <old> to <new>', 'error'); return; }
      const [oldName, newName] = pair;
      /* Snapshot BEFORE renaming — `undo` restores the old name. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `rennet ${oldName.slice(0, 18)}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.renameNetwork(oldName, newName);
      if (r.success) {
        store().setUndo(undo);
        store().print(`Network "${oldName}" → "${newName}" — undo available`, 'success');
        store().syncCare();
      } else store().print(r.error!, 'error');
    });

    this.register('copytree', 'Copy the current network outline (Markdown) to the clipboard — falls back to writing /network.md', 'copytree [network]', 'care', async (args) => {
      const md = CareSpace.exportMarkdown(args?.trim() || undefined);
      const netName = args?.trim() || CareSpace.currentNetwork().name;
      try {
        await navigator.clipboard.writeText(md);
        store().print(`Copied outline of "${netName}" — ${md.split('\n').length} lines → clipboard`, 'success');
        store().print('  paste into any document, issue, or email', 'muted');
      } catch {
        /* Clipboard blocked (permissions / insecure context) — land the
           outline in the virtual FS instead so the content is never lost. */
        const path = '/network.md';
        const w = FileSystem.writeFile(path, md);
        if (w.success) {
          store().print(`Clipboard unavailable — outline written to ${path} (${md.split('\n').length} lines)`, 'warning');
          store().print(`  try: cat ${path} · nano ${path}`, 'muted');
          store().syncFs();
        } else store().print(w.error!, 'error');
      }
    });

    this.register('care', 'List all networks (click a river to open it)', 'care', 'care', () => {
      const list = CareSpace.listNetworks();
      /* Task 48 — every river row is a ⇥ jump row: click "River Two" and
       * the shell switches to it AND lands on the node you last had open
       * there (+ details panel). The river's own color rides the bullet
       * channel — the list reads as a legend of your three rivers.
       * Task 67 — the landing wears a NAME now: each row carries a ⇥
       * jumpBadge (the Task 59 cross-river chip) pointing at the exact
       * node "where you left off" — the row's promise becomes a fact on
       * screen, and the STATS↔care loop is symmetric (stats hands over
       * care <river> chips; care hands back the landing chip). */
      const nets = CareSpace.networks();
      store().header(`Networks (${list.length}/${MAX_NETWORKS})`);
      list.forEach((n) => {
        const cur = n.current ? ' ←' : '';
        const layer = n.mapLayer ? ` · layer:${n.mapLayer}` : '';
        const net = nets.find((x) => x.name === n.name);
        const leftoff = net && net.currentId ? net.nodes[net.currentId] : undefined;
        /* Task 68 — the badge wears the THOUGHT's hue: the left-off
         * node's first tag color, the same rule map markers and graph
         * dots speak. Untagged thoughts keep the violet tree dialect. */
        const leftTag = leftoff?.tags.filter((t) => t && t !== 'none')[0];
        /* Task 93 — singular/plural grammar ("1 node", not "1 nodes")
         * and a name that yields to the pane: the row's tail (counts ·
         * layer · ←) is measured, the name gets the room that's left.
         * The pad is shared across the sheet so columns still align. */
        const counts = ` · ${plural(n.nodes, 'node')} · ${plural(n.notes, 'note')}`;
        const room = Math.max(8, termCols() - 3 - counts.length - layer.length - cur.length);
        const namePad = Math.min(20, Math.max(...list.map((x) => x.name.length)));
        store().print(`  ${fitLabel(n.name, room).padEnd(Math.min(namePad, room))} ${counts.slice(3)}${layer}${cur}`, n.current ? 'highlight' : 'output', {
          ...(leftoff
            ? { jump: { nodeId: leftoff.id, river: n.name } }
            : {}),
          ...(leftoff
            ? {
                jumpBadge: {
                  nodeId: leftoff.id,
                  river: n.name,
                  label: leftoff.label,
                  mark: leftoff.notes.length > 0 ? notesMark(leftoff.notes.length) : undefined,
                  tint: (leftTag && TAG_COLORS[leftTag]) || undefined,
                },
              }
            : {}),
          bullet: n.color,
        });
      });
      store().print('');
      store().print('  ⇥ click a river to open it where you left off — the ⇥ chip names that thought', 'muted');
      store().print('Three networks is the law of focus. No fourth river is needed.', 'muted');
    });

    this.register('allout', 'Reset entire CareSpace', 'allout', 'care', () => {
      const undo: UndoEntry = {
        kind: 'care',
        label: 'allout',
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      store().setUndo(undo);
      CareSpace.resetAll();
      store().print('CareSpace reset to defaults', 'warning');
      store().syncCare();
    });

    this.register('node', 'Create a child node', 'node <label>', 'care', (args) => {
      if (!args) { store().print('Usage: node <label>', 'error'); return; }
      /* Task 83 — creation joins the undo story: the doc before the
       * child landed is the snapshot, and ⌘Z/`undo` removes the node
       * again (wholesale restore, the same contract every care verb
       * speaks). The QA round caught this verb printing receipts as if
       * history existed — creation was the one care mutation silently
       * outside it, and it's exactly the one a hand tries ⌘Z on. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `node ${args}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.addNode(args);
      if (r.success) {
        const parent = CareSpace.getCurrentNode();
        const created = CareSpace.getNode(r.data!)!;
        store().setUndo(undo);
        store().print(`Node "${args}" created under "${parent.label}" — undo available`, 'success');
        /* Phase 5 — in a designated vault a new thought under a BOUND
         * parent gets its real note file immediately (the file is part
         * of what "create a thought" means there). An unbound parent
         * stays fileless and SAYS so — binding is explicit, never
         * invented. */
        const gate = careGate();
        const parentPath = parent.vaultPath ?? null;
        if (gate.ok && parentPath) {
          const rel = deriveChildVaultPath(parentPath, created.label);
          if (rel) {
            const loading = store().showLoading(`[vault:${gate.name}] creating ${rel}…`);
            void (async () => {
              const w = await careVaultWriteNote(rel, newNoteContent(created.id, created.label));
              if (!w.ok) {
                loading.stop(`node: file not created — ${w.error} (thought exists, unbound)`, 'warning');
                return;
              }
              const b = CareSpace.bindNode(created.id, rel);
              if (!b.success) { loading.stop(`node: file created but binding failed — ${b.error}`, 'warning'); return; }
              loading.stop(`note file created: [vault:${gate.name}] ${rel} — bound`, 'success');
              store().print('  metadata (tags/links/pin) stays internal · text lives in the file', 'muted');
              store().syncCare();
              useNaksha.getState().bumpVaultRevision();
              await useNaksha.getState().refreshCareBoundState();
            })();
          }
        } else if (gate.ok && !parentPath) {
          store().print(`  [${gate.name}] parent "${parent.label}" is not bound — no file created · carebind/careexport attaches files`, 'muted');
        }
        store().syncCare();
      } else store().print(r.error!, 'error');
    });

    this.register('cdnode', 'Navigate to a node', 'cdnode <name|..|/>', 'care', (args) => {
      if (!args) {
        const c = CareSpace.getCurrentNode();
        store().print(`Current node: ${c.label}`, 'info');
        store().print(`Path: ${CareSpace.getBreadcrumb().join(' / ')}`, 'muted');
        return;
      }
      const r = CareSpace.navigateTo(args);
      if (r.success) {
        store().print(`Navigated to: ${r.data!.label}`, 'info');
        store().syncCare();
      } else store().print(r.error!, 'error');
    });

    /* Short alias — `cdn Research` ≡ `cdnode Research`. */
    this.register('cdn', 'Navigate to a node (alias of cdnode)', 'cdn <name|..|/>', 'care', (args) => {
      if (!args) {
        const c = CareSpace.getCurrentNode();
        store().print(`Current node: ${c.label}`, 'info');
        store().print(`Path: ${CareSpace.getBreadcrumb().join(' / ')}`, 'muted');
        return;
      }
      const r = CareSpace.navigateTo(args);
      if (r.success) {
        store().print(`Navigated to: ${r.data!.label}`, 'info');
        store().syncCare();
      } else store().print(r.error!, 'error');
    });

    this.register('lsnode', 'List child nodes (click a row to open)', 'lsnode', 'care', () => {
      const c = CareSpace.getCurrentNode();
      if (c.children.length === 0) { store().print('(no children)', 'muted'); return; }
      /* Task 48 — lsnode joins the interactive dialect: every child row
       * is a ⇥ jump row (+ ↗ badge when pinned, ● tag tint in the bullet
       * channel — the `●` text suffix moved there, same as treenode did).
       * One listener serves them all. */
      const net = CareSpace.currentNetwork();
      c.children.forEach((cid) => {
        const ch = CareSpace.getNode(cid);
        if (ch) {
          /* Task 59 — the bracket count `[2]` joins the shell's counted
           * dialect: ▤N is the has-writing token the graph glyph, the
           * lists and the receipts ALL speak.
           * Task 60 — the 📍 emoji is GONE: located rows wear the ↗
           * fly badge (same as treenode) — one located-cue token, not
           * an emoji beside a badge saying the same thing twice. */
          const notes = ch.notes.length > 0 ? ` ${notesMark(ch.notes.length)}` : '';
          const firstTag = ch.tags.filter((t) => t && t !== 'none')[0];
          store().print(`  ${ch.label}${notes}`, 'output', {
            jump: { nodeId: ch.id, river: net.name },
            ...(ch.location ? { flyBadge: { lat: ch.location.lat, lng: ch.location.lng, zoom: ch.location.zoom || 13, label: ch.label } } : {}),
            bullet: (firstTag && TAG_COLORS[firstTag]) || net.color,
          });
        }
      });
      store().print('  ⇥ click a row to open that thought · ↗ flies to its pin · ▤N = notes', 'muted');
    });

    /* Task 46 — treenode is now INTERACTIVE: every row is a ⇥ jump row
     * (click → land the tree pane on that thought) and wears the node's
     * provenance tint (first-tag color, river fallback) — the same
     * dialect as near/find rows. The tag ● moved from the line's tail
     * to the row's bullet channel, so provenance reads top-down.
     * Task 47 — LOCATED rows also carry a nested ↗ fly badge: one row,
     * two verbs (click text = tree landing + details, click badge = map
     * flies to the pin). Unlocated thoughts keep the single ⇥ verb —
     * a badge to nowhere would be a lie. */
    this.register('treenode', 'Show node tree (click a row to jump)', 'treenode', 'care', () => {
      const net = CareSpace.currentNetwork();
      const rows = CareSpace.getTreeRows();
      store().header(`tree — "${net.name}" · ${rows.length} node${rows.length === 1 ? '' : 's'}`);
      for (const row of rows) {
        const node = net.nodes[row.nodeId];
        if (!node) continue;
        const firstTag = node.tags.filter((t) => t && t !== 'none')[0];
        const loc = node.location;
        /* Task 59 — the tree wears the counted mark: which branches hold
         * WRITING reads before any click — the same discoverability win
         * the graph glyph gave the map, on the primary browsing surface. */
        const mark = node.notes.length > 0 ? ` ${notesMark(node.notes.length)}` : '';
        store().print(`  ${row.text}${mark}`, 'output', {
          jump: { nodeId: row.nodeId, river: net.name },
          ...(loc ? { flyBadge: { lat: loc.lat, lng: loc.lng, zoom: loc.zoom || 13, label: node.label } } : {}),
          bullet: (firstTag && TAG_COLORS[firstTag]) || net.color,
        });
      }
      store().print('  ⇥ click a row to open that thought · ↗ flies to its pin · ● = tag tint · ▤N = notes', 'muted');
    });

    this.register('careout', 'Write the CareSpace outline into the filesystem (Markdown, or JSON backup with --json)', 'careout [--json] [path]', 'care', (args) => {
      const json = /(^|\s)--json(\s|$)/.test(args ?? '');
      const pathArg = (args ?? '').replace(/--json/g, '').trim();
      const path = pathArg || (json ? '/carespace.json' : '/carespace.md');
      if (json) {
        /* Full-fidelity backup — every network, node, note, tag, link label
         * and collapse state. `carein` reads this exact format back, giving
         * lossless round-trips (back up → experiment → restore). */
        const backup = JSON.stringify(CareSpace.exportAll(), null, 2);
        const r = FileSystem.writeFile(path, backup);
        if (r.success) {
          const nets = CareSpace.networks().length;
          const nodes = CareSpace.networks().reduce((sum, n) => sum + Object.keys(n.nodes).length, 0);
          store().print(`CareSpace backup (JSON) → ${path} (${nets} net · ${nodes} nodes · ${backup.split('\n').length} lines)`, 'success');
          store().print(`  restore later with: carein ${path}`, 'muted');
          store().syncFs();
        } else store().print(r.error!, 'error');
        return;
      }
      const md = buildCareMarkdown();
      const r = FileSystem.writeFile(path, md);
      if (r.success) {
        store().print(`CareSpace outline → ${path} (${md.split('\n').length} lines)`, 'success');
        store().print(`  try: cat ${path} · nano ${path} · grep -r "note" ${path}`, 'muted');
        store().syncFs();
      } else store().print(r.error!, 'error');
    });

    this.register('carein', 'Restore CareSpace from a JSON backup file (replaces current data — undo available)', 'carein [path=/carespace.json]', 'care', (args) => {
      const path = args?.trim() || '/carespace.json';
      const f = FileSystem.readFile(path);
      if (!f.success || f.content == null) {
        store().print(`Cannot read ${path}${f.error ? ` — ${f.error}` : ''}`, 'error');
        store().print(`  create a backup first: careout --json`, 'muted');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(f.content);
      } catch {
        store().print(`${path} is not valid JSON — import aborted`, 'error');
        return;
      }
      /* Snapshot BEFORE replacing — one `undo` brings the current tree back. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `carein ${path.split('/').pop() ?? path}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.importAll(parsed);
      if (r.success) {
        store().setUndo(undo);
        const nets = CareSpace.networks();
        const nodes = nets.reduce((sum, n) => sum + Object.keys(n.nodes).length, 0);
        const notes = nets.reduce((sum, n) => sum + Object.values(n.nodes).reduce((ns, nd) => ns + nd.notes.length, 0), 0);
        store().print(`CareSpace restored from ${path} — ${nets.length} net · ${nodes} nodes · ${notes} notes — undo available`, 'success');
        store().syncCare();
      } else store().print(r.error ?? 'Import failed', 'error');
    });

    this.register('caremerge', 'Merge networks from a JSON backup into CareSpace (adds non-colliding networks; --rename merges colliding ones under "Name (2)" — undo available)', 'caremerge [--rename] [path=/carespace.json]', 'care', (args) => {
      const rename = /(^|\s)--rename(\s|$)/.test(args ?? '');
      const path = (args ?? '').replace(/--rename/g, '').trim() || '/carespace.json';
      const f = FileSystem.readFile(path);
      if (!f.success || f.content == null) {
        store().print(`Cannot read ${path}${f.error ? ` — ${f.error}` : ''}`, 'error');
        store().print(`  create a backup first: careout --json`, 'muted');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(f.content);
      } catch {
        store().print(`${path} is not valid JSON — merge aborted`, 'error');
        return;
      }
      /* Snapshot BEFORE merging — one `undo` removes merged networks. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `caremerge ${path.split('/').pop() ?? path}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.mergeNetworks(parsed, { renameCollisions: rename });
      if (!r.success) { store().print(r.error ?? 'Merge failed', 'error'); return; }
      const { merged, skipped, limitHit } = r.data!;
      if (merged.length === 0 && skipped.length === 0) {
        store().print('Nothing to merge — backup has no networks', 'muted');
        return;
      }
      store().setUndo(undo);
      for (const m of merged) {
        const net = CareSpace.networks().find((n) => n.name === m.name);
        const count = net ? Object.keys(net.nodes).length : 0;
        const renamed = m.renamedFrom ? ` (renamed from "${m.renamedFrom}")` : '';
        store().print(`  + "${m.name}"${renamed} (${count} nodes)`, 'success');
      }
      for (const name of skipped) {
        store().print(`  = "${name}" skipped — a network with this name already exists (caremerge --rename to merge it as "Name (2)")`, 'muted');
      }
      if (limitHit) {
        store().print('  ⚠ three networks is the limit — the law of focus. Remaining networks not merged.', 'warning');
      }
      const verb = merged.length === 1 ? 'network merged' : `${merged.length} networks merged`;
      store().print(`CareSpace merge from ${path} — ${verb}${skipped.length ? `, ${skipped.length} skipped` : ''} — undo available`, 'success');
      store().syncCare();
    });

    /* ── Phase 5 — CARESPACE ↔ REAL MARKDOWN FILES ────────────────────
     * The designated-vault bridge. Explicit everywhere: a thought binds
     * to a real .md file only by `carebind` / `careexport`; the note
     * TEXT lives in the file, the tree/tags/links/pins stay internal
     * (keyed by the stable rel path). No frontmatter in user files;
     * files CareSpace creates carry a minimal, documented block. */
    this.register('carebind', 'Bind a thought to a REAL note file in the designated vault (note text then lives in the file)', 'carebind <node> "<path.md>"', 'care', (args) => {
      /* Phase 6 bugfix — real vault files have REAL names ("Main
       * Purpose.md"): the old split-on-whitespace parser could never
       * bind a path containing a space. Quoted paths now work:
       *   carebind My Node "folder/note name.md"   ← path = quoted tail
       *   carebind My Node folder/note.md          ← path = last token
       * The node NAME (which may also contain spaces) is everything
       * before the path. */
      const raw = (args ?? '').trim();
      const quoted = raw.match(/^(.+?)\s+["'](.+)["']$/);
      let rel: string;
      let nodeName: string;
      if (quoted) {
        nodeName = quoted[1];
        rel = quoted[2];
      } else {
        const parts = raw.split(/\s+/).filter(Boolean);
        if (parts.length < 2) { store().print('Usage: carebind <node> "<path.md>"', 'error'); return; }
        rel = parts.pop()!.replace(/^["']|["']$/g, '');
        nodeName = parts.join(' ');
      }
      const node = this.resolveNode(nodeName);
      if (!node) return;
      const gate = careGate();
      if (!gate.ok) { store().print(`carebind: ${gate.error}`, 'error'); return; }
      const loading = store().showLoading(`[vault:${gate.name}] resolving ${rel}…`);
      void (async () => {
        try {
          const res = await fetch(`/api/vault/resolve?q=${encodeURIComponent(rel)}`, { cache: 'no-store' });
          const data = (await res.json()) as { ok: boolean; rel?: string | null; error?: string };
          if (!data.ok || !data.rel) {
            noteVaultFailStop(loading, `carebind: no file matches '${rel}' in [vault:${gate.name}]`);
            return;
          }
          const r = CareSpace.bindNode(node.id, data.rel);
          if (!r.success) { loading.stop(`carebind: ${r.error}`, 'error'); return; }
          loading.stop(`bound "${node.label}" → [vault:${gate.name}] ${data.rel}`, 'success');
          store().print('  the FILE is now the source of this thought\'s text · metadata (tags, links, pin) stays internal', 'muted');
          store().print("  read it here: 'notes' · open the raw note: 'cat -r' · unbind: careunbind", 'muted');
          store().syncCare();
          await useNaksha.getState().refreshCareBoundState();
        } catch (err) {
          loading.stop(`carebind failed: ${(err as Error).message}`, 'error');
        }
      })();
    });

    this.register('careunbind', 'Unbind a thought from its real file (metadata only — the file stays on disk)', 'careunbind <node>', 'care', (args) => {
      const node = args?.trim() ? this.resolveNode(args.trim()) : CareSpace.getCurrentNode();
      if (!node) return;
      if (!node.vaultPath) { store().print(`"${node.label}" is not bound to a file`, 'muted'); return; }
      const rel = node.vaultPath;
      const r = CareSpace.unbindNode(node.id);
      if (r.success) {
        store().print(`Unbound "${node.label}" from ${rel} — the file was NOT touched`, 'success');
        store().print('  past notes stay internal again; the file remains as-is in the vault', 'muted');
        store().syncCare();
        void useNaksha.getState().refreshCareBoundState();
      } else store().print(r.error ?? 'unbind failed', 'error');
    });

    this.register('careexport', 'Export the current network to REAL .md files in the designated vault (folder/<Path/of/Labels>.md) and bind every thought to its file', 'careexport <folder>', 'care', (args) => {
      const folder = (args ?? '').trim().replace(/^["']|["']$/g, '').replace(/^\/+|\/+$/g, '');
      if (!folder) {
        store().print('Usage: careexport <folder>   e.g. careexport carespace', 'error');
        store().print('  writes one .md per thought under <folder>/ INSIDE the designated vault, then binds each thought to its file', 'muted');
        return;
      }
      const gate = careGate();
      if (!gate.ok) { store().print(`careexport: ${gate.error}`, 'error'); return; }
      /* Walk the current network, plan every file first (paths + content),
       * then write through the gated API. Planning before writing means a
       * failure mid-way still leaves valid files (just partially bound). */
      const net = CareSpace.currentNetwork();
      const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null);
      if (!rootId) { store().print('careexport: network has no core', 'error'); return; }
      const plan: Array<{ node: CareNode; rel: string; content: string }> = [];
      const walk = (id: string, labelPath: string[]) => {
        const node = net.nodes[id];
        if (!node) return;
        const path = [...labelPath, node.label];
        const rel = deriveExportVaultPath(folder, path);
        const lines: string[] = [];
        if (node.location) {
          lines.push(`> 📍 ${node.location.lat.toFixed(4)}, ${node.location.lng.toFixed(4)} (z${node.location.zoom})`, '');
        }
        for (const n of node.notes) lines.push(`- ${n.text} _(${n.timeString})_`);
        const content = `${newNoteContent(node.id, node.label)}${lines.length ? lines.join('\n') + '\n' : ''}`;
        plan.push({ node, rel, content });
        for (const cid of node.children) walk(cid, path);
      };
      walk(rootId, []);
      if (plan.length === 0) { store().print('careexport: nothing to export', 'muted'); return; }
      if (plan.length > 200) {
        store().print(`careexport: ${plan.length} thoughts exceeds the 200-file export cap — export a smaller subtree (cdnode + a smaller river)`, 'error');
        return;
      }
      const loading = store().showLoading(`[vault:${gate.name}] writing ${plan.length} notes to ${folder}/…`);
      void (async () => {
        let written = 0;
        let bound = 0;
        const failed: string[] = [];
        const overwrote: string[] = [];
        for (const item of plan) {
          const r = await careVaultWriteNote(item.rel, item.content);
          if (!r.ok) { failed.push(`${item.rel} — ${r.error ?? 'write failed'}`); continue; }
          written++;
          if (r.created === false) overwrote.push(item.rel);
          const b = CareSpace.bindNode(item.node.id, item.rel);
          if (b.success) bound++;
        }
        loading.stop(
          `careexport → [vault:${gate.name}] ${folder}/ — ${written}/${plan.length} files written · ${bound} bound`,
          failed.length ? 'warning' : 'success',
        );
        for (const rel of overwrote.slice(0, 5)) store().print(`  ⟳ overwrote existing file: ${rel}`, 'muted');
        if (overwrote.length > 5) store().print(`  ⟳ … and ${overwrote.length - 5} more existing files`, 'muted');
        for (const f of failed.slice(0, 5)) store().print(`  ✕ ${f}`, 'error');
        if (failed.length > 5) store().print(`  ✕ … and ${failed.length - 5} more failures`, 'error');
        if (bound > 0) {
          store().print(`  thoughts now live in real files — open one: 'cat -r ${plan[0].rel}' · outline: 'careout'`, 'muted');
          store().syncCare();
          useNaksha.getState().bumpVaultRevision();
          await useNaksha.getState().refreshCareBoundState();
        }
      })();
    });

    this.register('save', 'Save a note to a node', 'save <text> to <node>', 'care', (args) => {
      const m = args.match(/^(.+?)\s+to\s+(.+)$/i);
      if (!m) { store().print('Usage: save <text> to <node>', 'error'); return; }
      const text = m[1].trim();
      const nodeName = m[2].trim();
      /* Task 70 — resolveNodeWithReason: did-you-mean on duplicates, and
       * auto-create ONLY on a clean not-found (an ambiguous name means
       * the user aimed at an existing thought — creating a twin would
       * be exactly the wrong reflex). */
      const rr = this.resolveNodeWithReason(nodeName);
      let target = rr.node;
      /* Task 87 — content joins history: delnote has been undoable all
       * along; the ADDITION stayed outside — an asymmetry with no
       * principle. Snapshot before ANY mutation (the auto-create below
       * mutates too): one undo reverts note and, if it happened, the
       * auto-created thought with it. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `save "${text.length > 24 ? `${text.slice(0, 24)}…` : text}" to ${nodeName}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      if (!target && rr.reason === 'not-found') {
        const cr = CareSpace.addNode(nodeName);
        if (cr.success) { target = CareSpace.getNode(cr.data!)!; store().print(`Created node: ${nodeName}`, 'muted'); }
      }
      if (!target) { store().print(`Cannot create node: ${nodeName}`, 'error'); return; }
      /* Phase 5 — a BOUND thought's text lives in its real file: the
       * note appends to the file through the gated write API and the
       * internal notes array stays out of it (one source of truth, no
       * duplication). Real files are not undoable — the receipt says
       * so instead of pretending ⌘Z can rewind a file. */
      if (target.vaultPath) {
        const gate = careGate();
        if (!gate.ok) {
          store().print(`"${target.label}" is bound to ${target.vaultPath}, but: ${gate.error}`, 'error');
          store().print('  the note was NOT written — nothing changed', 'muted');
          return;
        }
        const rel = target.vaultPath;
        const loading = store().showLoading(`[vault:${gate.name}] appending to ${rel}…`);
        void (async () => {
          const cur = await careVaultReadNote(rel);
          if (!cur.ok || typeof cur.content !== 'string') {
            loading.stop(`save: cannot read ${rel} — ${cur.error ?? 'read failed'} (nothing written)`, 'error');
            void useNaksha.getState().refreshCareBoundState();
            return;
          }
          const w = await careVaultWriteNote(rel, appendNoteLine(cur.content, text, formatTime()));
          if (!w.ok) {
            loading.stop(`save: append to ${rel} failed — ${w.error}`, 'error');
            return;
          }
          loading.stop(`Note appended to "${target.label}" → [vault:${gate.name}] ${rel}`, 'success');
          store().print('  the file is the source of truth · file writes are NOT undoable', 'muted');
          useNaksha.getState().bumpVaultRevision();
        })();
        return;
      }
      const r = CareSpace.addNote(target.id, text);
      if (r.success) {
        store().setUndo(undo);
        store().print(`Note saved to "${target.label}" (${r.data} total) — undo available`, 'success');
        if (careGate().ok) {
          store().print('  thought not bound — text stays internal · carebind/careexport moves it into the vault', 'muted');
        }
        store().syncCare();
      } else store().print(r.error!, 'error');
    });

    this.register('notes', 'Show notes for a node', 'notes [node]', 'care', (args) => {
      const target = args ? this.resolveNode(args) : CareSpace.getCurrentNode(); // Task 70 — did-you-mean
      if (!target) return; // resolveNode already printed
      /* Phase 5 — a bound thought's notes ARE its file: print the real
       * content through the read-only vault API (never invented). */
      if (target.vaultPath) {
        const gate = careGate();
        const rel = target.vaultPath;
        if (!gate.ok) {
          store().print(`"${target.label}" is bound to ${rel}, but: ${gate.error}`, 'error');
          return;
        }
        const loading = store().showLoading(`[vault:${gate.name}] reading ${rel}…`);
        void (async () => {
          const cur = await careVaultReadNote(rel);
          if (!cur.ok || typeof cur.content !== 'string') {
            loading.stop(`notes: cannot read ${rel} — ${cur.error ?? 'read failed'} ⚠ (file missing? careunbind to detach)`, 'error');
            void useNaksha.getState().refreshCareBoundState();
            return;
          }
          loading.stop(`Notes for "${target.label}" — [vault:${gate.name}] ${rel}`, 'success');
          const lines = cur.content.replace(/\n+$/, '').split('\n');
          const CAP = 40;
          for (const l of lines.slice(0, CAP)) store().print(`  ${l}`, 'output');
          if (lines.length > CAP) store().print(`  … (+${lines.length - CAP} more lines — cat -r ${rel} opens the reader)`, 'muted');
          store().print(`  the file is the source of truth · edit it: nano ${rel} (real nano) · cat -r opens the reader`, 'muted');
        })();
        return;
      }
      if (target.notes.length === 0) { store().print(`No notes for "${target.label}"`, 'muted'); return; }
      store().header(`Notes for "${target.label}"`);
      /* Task 52 — the index list IS the delete button: every row wears its
       * chronological index (the same number `delnote` takes, 0 = oldest)
       * and the data-del payload. Click = delete with full undo parity.
       * Newest-first print order stays; the numbers just make it
       * addressable. */
      [...target.notes].reverse().forEach((n) => {
        const idx = target.notes.indexOf(n);
        store().print(`[${idx}] [${n.timeString}] ${n.text}`, 'output', {
          del: { nodeId: target.id, index: idx },
        });
      });
      store().print('click a row to delete it · undo available', 'muted');
    });

    /* Task 51 — notes were write-only: add/replace existed, removal didn't.
     * `delnote [node] <index>` closes the loop — indices match the
     * chronological order (0 = oldest, as `notes` prints newest-first so
     * the LAST printed number is 0). Undo parity like every care mutation. */
    this.register('delnote', 'Delete a note by index (oldest = 0)', 'delnote [node] <index>', 'care', (args) => {
      if (!args) { store().print('Usage: delnote [node] <index> — see `notes`', 'error'); return; }
      const parts = args.split(/\s+/);
      const idx = parseInt(parts[parts.length - 1], 10);
      const name = parts.length > 1 ? parts.slice(0, -1).join(' ') : undefined;
      const node = name ? this.resolveNode(name) : CareSpace.getCurrentNode(); // Task 70 — did-you-mean
      if (!node) return; // resolveNode already printed
      /* Phase 5 — a bound thought's text lives in the FILE: deleting one
       * line through regex surgery would be dishonest fragility. Say so,
       * point at the real levers (real nano / unbind), touch nothing. */
      if (node.vaultPath) {
        store().print(`"${node.label}" is bound to a real file (${node.vaultPath}) — its text is not deletable by index`, 'error');
        store().print(`  remove the line in the file itself (nano ${node.vaultPath}) or detach first: careunbind ${node.label}`, 'muted');
        return;
      }
      if (isNaN(idx)) { store().print(`Note index must be a number (0 = oldest) — see \`notes\``, 'error'); return; }
      if (node.notes.length === 0) { store().print(`No notes on "${node.label}"`, 'muted'); return; }
      const victim = node.notes[idx];
      if (!victim) {
        store().print(`No note #${idx} on "${node.label}" (0–${node.notes.length - 1})`, 'error');
        /* Task 52 — the error path's enumerated list is interactive too:
         * same del rows as `notes`, so a typo'd index still ends in a
         * click instead of a retyped command. */
        node.notes.forEach((n, i) =>
          store().print(`  [${i}] ${n.text.slice(0, 60)}`, 'muted', {
            del: { nodeId: node.id, index: i },
          }),
        );
        return;
      }
      const undo: UndoEntry = {
        kind: 'care',
        label: `delnote ${node.label.slice(0, 18)} #${idx}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.removeNote(node.id, idx);
      if (r.success) {
        store().setUndo(undo);
        store().print(`Deleted note #${idx} on "${node.label}": "${victim.text.slice(0, 50)}" — undo available`, 'success');
        store().syncCare();
      } else store().print(r.error ?? 'Could not delete note', 'error');
    });

    this.register('find', 'Search all notes', 'find <text>', 'care', (args) => {
      if (!args) { store().print('Usage: find <text>', 'error'); return; }
      const results = CareSpace.searchNotes(args);
      if (results.length === 0) { store().print(`No results for: "${args}"`, 'muted'); return; }
      /* Task 45 — result groups wear the note's node tag tint (the same
       * provenance bullet as `near` rows): who owns the note is visible
       * before you read a word. Untagged nodes fall back to the river
       * color, like every other surface.
       * Task 47 — the owning node's path row is now a ⇥ jump row (click
       * → open that thought in the tree + details), and located owners
       * also wear the ↗ fly badge. `searchNotes` walks the current river
       * only, so the jump names it explicitly — no drift if the user
       * switches rivers before clicking. */
      const net = CareSpace.currentNetwork();
      const netColor = net.color;
      store().header(`Search Results (${results.length})`);
      results.forEach((r) => {
        const ft = r.node.tags.filter((t) => t && t !== 'none')[0];
        const loc = r.node.location;
        /* Task 61 — the path wears the node's FULL writing load (the same
         * counted ▤ as every list): a single hit in a 10-note node shows
         * ▤9+ — the match is one page of a bigger book. find results
         * always live on noted nodes, so the mark is always present. */
        const mark = r.node.notes.length > 0 ? ` ${notesMark(r.node.notes.length)}` : '';
        store().print(`${r.nodePath}${mark}:`, 'highlight', {
          jump: { nodeId: r.node.id, river: net.name },
          ...(loc ? { flyBadge: { lat: loc.lat, lng: loc.lng, zoom: loc.zoom || 13, label: r.node.label } } : {}),
          bullet: (ft && TAG_COLORS[ft]) || netColor,
        });
        store().print(`  "${r.note.text}"`, 'output');
        store().print(`  (${r.note.timeString})`, 'muted');
      });
      store().print('  ⇥ click a path to open that thought · ↗ flies to its pin', 'muted');
    });

    this.register('pinat', 'Pin current map location to node', 'pinat [node]', 'care', (args) => {
      /* Task 70 — did-you-mean + create only on a clean not-found (the
       * save rule): an ambiguous name is an AIMED name, not a blank one. */
      let target: CareNode | null;
      if (!args) target = CareSpace.getCurrentNode();
      else {
        const rr = this.resolveNodeWithReason(args);
        target = rr.node;
        if (!target && rr.reason === 'not-found') {
          const cr = CareSpace.addNode(args);
          if (cr.success) target = CareSpace.getNode(cr.data!)!;
        }
      }
      if (!target) { store().print(`Cannot find or create node: ${args}`, 'error'); return; }
      const c = MapEngine.getCenter();
      const zoom = MapEngine.getZoom();
      /* Task 87 — the overwrite joins history: pinat onto a located
       * thought silently DESTROYED the old coordinates while unpinnode
       * (the removal) rode a snapshot — one surface of the same loss
       * was safer than the other. Snapshot covers the fresh-pin case
       * too (undo restores "no location"). */
      const undo: UndoEntry = {
        kind: 'care',
        label: `pinat ${target.label}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.pinLocation(target.id, c.lat, c.lng, zoom);
      if (r.success) {
        store().setUndo(undo);
        store().print(`Location pinned to "${target.label}" — undo available`, 'success');
        store().print(`  Coords: ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`, 'muted');
        store().print(`  Use 'fly ${target.label}' to return here`, 'muted');
        store().syncCare();
      } else store().print(r.error!, 'error');
    });

    this.register('fly', 'Fly to a node location', 'fly <node>', 'care', (args) => {
      if (!args) { store().print('Usage: fly <node>', 'error'); return; }
      const target = this.resolveNode(args); // Task 70 — did-you-mean
      if (!target) return;
      if (!target.location) {
        store().print(`Node "${args}" has no pinned location`, 'error');
        store().print(`Use 'pinat ${args}' to pin current location`, 'muted');
        return;
      }
      /* Task 44 — programmatic arrivals pulse too: the marker you flew to
       * announces itself (perf-low machines stay silent — engine-gated). */
      MapEngine.flyAndPulse(target.location.lat, target.location.lng, target.location.zoom || 13);
      store().print(`Flying to "${target.label}"`, 'info');
    });

    /* (mvnode is registered later as an alias of caremove — the older
     * duplicate that lived here was dead code silently shadowed by the
     * Map overwrite, and without the caremove undo snapshot.) */

    this.register('rmnode', 'Remove a node', 'rmnode <node>', 'care', (args) => {
      const clean = args.trim().replace(/^["']|["']$/g, '');
      if (!clean) { store().print('Usage: rmnode <node>', 'error'); return; }
      /* Task 69 — rmnode goes through the STANDARD resolver now. It used
       * to call searchNodeByName directly with no ambiguity callback, so
       * duplicate exact labels ("Alpha" twice — the twin-cluster
       * pollution Task 68's guard now prevents) made rmnode answer
       * "Node not found" while aiming at NOTHING — the worst answer:
       * silent deletion before, a false negative now. resolveNode
       * prints the did-you-mean line WITH ids + the aim-by-id tip. */
      const node = this.resolveNode(clean);
      if (!node) return;
      /* Phase 5 — collect the subtree's bound paths BEFORE removal: the
       * files stay on disk (no destructive vault op exists), and the
       * receipt names every orphan instead of abandoning it silently. */
      const boundLeft: string[] = [];
      const collectBound = (n: CareNode) => {
        if (n.vaultPath) boundLeft.push(n.vaultPath);
        for (const cid of n.children) {
          const c = CareSpace.getNode(cid);
          if (c) collectBound(c);
        }
      };
      collectBound(node);
      const undo: UndoEntry = {
        kind: 'care',
        label: `rmnode ${clean}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      store().setUndo(undo);
      const r = CareSpace.removeNode(node.id);
      if (r.success) {
        store().print(`Removed "${clean}" and ${r.data!.removedCount - 1} descendants`, 'success');
        /* Phase 5 — bound thoughts leave their real files in place: no
         * destructive vault op exists (by design). Name the orphans so
         * nothing is silently abandoned. */
        const leftFiles = boundLeft;
        if (leftFiles.length > 0) {
          store().print(`  ⚠ ${leftFiles.length} bound file${leftFiles.length === 1 ? '' : 's'} left on disk (CareSpace never deletes):`, 'warning');
          for (const p of leftFiles.slice(0, 6)) store().print(`    ${p}`, 'muted');
          if (leftFiles.length > 6) store().print(`    … and ${leftFiles.length - 6} more`, 'muted');
        }
        store().syncCare();
        void useNaksha.getState().refreshCareBoundState();
      } else store().print(r.error!, 'error');
    });

    /* Task 38 — rennode upgrade: it was the only care mutation WITHOUT an
     * undo snapshot (undo after a rename restored the WRONG state) and it
     * used bare searchNodeByName, so ambiguous names silently picked the
     * first match. Now: resolveNode (did-you-mean reporting), a snapshot
     * BEFORE the write, an idempotence guard, and the same "undo
     * available" receipt every sibling command prints. */
    this.register('rennode', 'Rename a node (searches every river — "river/name" qualifies a duplicate label)', 'rennode <old> to <new>', 'care', (args) => {
      const pair = splitToPair(args);
      if (!pair) { store().print('Usage: rennode <old> to <new>', 'error'); return; }
      const [oldName, newName] = pair;
      /* Task 40 — cross-river resolution: the current river wins exact
       * matches as before; otherwise a unique match in ANY river is
       * renamed THERE (river-scoped write, like the map card's ✎), and
       * the receipt names the river when it differs from the current
       * one. "backup/Root to Harbor" disambiguates merged rivers. */
      const found = this.resolveNodeGlobal(oldName);
      if (!found.ok) return; // resolveNodeGlobal already printed (not found / ambiguous)
      const { node, net } = found;
      const trimmed = newName.trim();
      if (!trimmed) { store().print('New label cannot be empty', 'error'); return; }
      if (trimmed === node.label) { store().print(`"${node.label}" is already named that`, 'muted'); return; }
      const inCurrent = net.id === CareSpace.currentNetwork().id;
      const riverSuffix = inCurrent ? '' : ` · river "${net.name}"`;
      const undo: UndoEntry = {
        kind: 'care',
        label: `rennode ${node.label.slice(0, 18)}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      /* Phase 5 — file identity rides the rename: a bound thought's real
       * file is renamed FIRST (through the gated API); only a successful
       * file move updates the internal label + binding. A failed rename
       * changes nothing — no half-renamed worlds. */
      if (node.vaultPath) {
        const gate = careGate();
        const oldRel = node.vaultPath;
        const dir = oldRel.replace(/[^/]+$/,'');
        const newRel = `${dir}${noteBasename(trimmed)}.md`;
        if (!gate.ok) {
          store().print(`"${node.label}" is bound to ${oldRel}, but: ${gate.error}`, 'error');
          store().print('  rename aborted — the file and the binding must move together', 'muted');
          return;
        }
        if (oldRel === newRel) {
          store().print(`  note file keeps its name: ${oldRel}`, 'muted');
        } else {
          const loading = store().showLoading(`[vault:${gate.name}] renaming ${oldRel} → ${newRel}…`);
          void (async () => {
            const rr = await careVaultRenameNote(oldRel, newRel);
            if (!rr.ok) {
              loading.stop(`rennode: file rename failed — ${rr.error} (nothing changed)`, 'error');
              return;
            }
            node.vaultPath = newRel;
            if (inCurrent) {
              const r = CareSpace.renameNode(node.id, trimmed);
              if (!r.success) { loading.stop(`rennode: ${r.error} (file already renamed!)`, 'error'); return; }
            } else {
              node.label = trimmed;
              node.updatedAt = Date.now();
              CareSpace.save();
            }
            store().setUndo(undo);
            loading.stop(`✎ "${oldName}" → "${trimmed}"${riverSuffix} · file renamed → ${newRel} — undo covers the tree, not the file`, 'success');
            store().syncCare();
            useNaksha.getState().bumpVaultRevision();
            await useNaksha.getState().refreshCareBoundState();
          })();
          return;
        }
      }
      if (inCurrent) {
        const r = CareSpace.renameNode(node.id, trimmed);
        if (r.success) {
          store().setUndo(undo);
          store().print(`✎ "${oldName}" → "${trimmed}"${riverSuffix} — undo available`, 'success');
          store().syncCare();
        }
        else store().print(r.error!, 'error');
      } else {
        /* Dormant-river write: mutate the node in ITS river directly —
           the same river-scoped pipeline the marker card uses. */
        node.label = trimmed;
        node.updatedAt = Date.now();
        CareSpace.save();
        store().setUndo(undo);
        store().syncCare();
        store().print(`✎ "${oldName}" → "${trimmed}"${riverSuffix} — undo available`, 'success');
      }
    });

    this.register('whereis', 'Show the full path of a node (searches every network)', 'whereis <node>', 'care', (args) => {
      const q = args.trim().replace(/^["']|["']$/g, '');
      if (!q) { store().print('Usage: whereis <node>', 'error'); return; }
      const lower = q.toLowerCase();
      /* Walk every network's tree collecting label substring matches with
       * their full breadcrumb paths — the answer to "where did I put that
       * thought?" once trees grow past one screen. Task 36: matches also
       * report WHERE the thought lives on earth (◉ coords) and how much
       * it carries (note count) — cross-network dedupe decisions (which
       * of the two "Ideas" do I keep?) no longer require opening each.
       * Task 47 — matches remember their node id + raw pin (the string
       * coords stay for the ◉ meta): every row is now a ⇥ jump row and
       * located matches wear the ↗ fly badge, so "where IS it" answers
       * with two verbs — open it, or go there. */
      const matches: Array<{ net: string; path: string; current: boolean; loc: string; notes: number; id: string; locData?: { lat: number; lng: number; zoom: number } }> = [];
      for (const net of CareSpace.networks()) {
        const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null);
        if (!rootId) continue;
        const walk = (id: string, path: string) => {
          const n = net.nodes[id];
          if (!n) return;
          const p = path ? `${path}/${n.label}` : n.label;
          if (n.label.toLowerCase().includes(lower)) {
            const l = n.location;
            matches.push({
              net: net.name,
              path: p,
              current: net.currentId === id,
              loc: l
                ? `${Math.abs(l.lat).toFixed(3)}${l.lat >= 0 ? 'N' : 'S'} ${Math.abs(l.lng).toFixed(3)}${l.lng >= 0 ? 'E' : 'W'}`
                : '',
              notes: n.notes.length,
              id,
              locData: l ? { lat: l.lat, lng: l.lng, zoom: l.zoom || 13 } : undefined,
            });
          }
          n.children.forEach((cid) => walk(cid, p));
        };
        walk(rootId, '');
      }
      if (matches.length === 0) { store().print(`No node matching "${q}" in any network`, 'muted'); return; }
      store().header(`whereis "${q}" — ${matches.length} match${matches.length === 1 ? '' : 'es'}`);
      for (const m of matches.slice(0, 12)) {
        const meta = [
          m.loc ? `◉ ${m.loc}` : '',
          m.notes > 0 ? `${m.notes} note${m.notes === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(' · ');
        store().print(`  [${m.net}] ${m.path}${meta ? `  ${meta}` : ''}${m.current ? ' ←' : ''}`, 'output', {
          jump: { nodeId: m.id, river: m.net },
          ...(m.locData ? { flyBadge: { lat: m.locData.lat, lng: m.locData.lng, zoom: m.locData.zoom, label: m.path.split('/').pop() || q } } : {}),
        });
      }
      if (matches.length > 12) store().print(`  … and ${matches.length - 12} more (narrow the search)`, 'muted');
      store().print('  ⇥ click a match to open that thought · ↗ flies to its pin', 'muted');
    });

    this.register('dupnode', 'Duplicate a node with its whole subtree under the same parent (templates for thought — undo available)', 'dupnode <node>', 'care', (args) => {
      if (!args) { store().print('Usage: dupnode <node>', 'error'); return; }
      const node = this.resolveNode(args); // Task 70 — did-you-mean
      if (!node) return;
      /* Snapshot BEFORE cloning — one `undo` removes the copy again. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `dup ${node.label.slice(0, 18)}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.duplicateNode(node.id);
      if (r.success) {
        store().setUndo(undo);
        const copy = CareSpace.getNode(r.data!);
        const count = copy ? countSubtree(copy.id) : 1;
        store().print(`Duplicated "${node.label}" → "${copy?.label ?? '(copy)'}" (${count} nodes) — undo available`, 'success');
        store().syncCare();
      } else store().print(r.error!, 'error');
    });

    this.register('order', 'Reorder node among siblings', 'order <node> <index>', 'care', (args) => {
      const parts = args.split(/\s+/);
      if (parts.length < 2) { store().print('Usage: order <node> <index>', 'error'); return; }
      const idx = parseInt(parts[parts.length - 1], 10);
      if (isNaN(idx)) { store().print('Index must be a number', 'error'); return; }
      const name = parts.slice(0, -1).join(' ');
      const node = this.resolveNode(name); // Task 70 — did-you-mean
      if (!node) return;
      /* Task 87 — structural order joins history: sibling order lives
       * in the care document, so the same snapshot dialect covers it
       * (undo restores the previous sequence). */
      const undo: UndoEntry = {
        kind: 'care',
        label: `order ${name} ${idx}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.reorderNode(node.id, idx);
      if (r.success) { store().setUndo(undo); store().print(`Reordered "${name}" to position ${idx} — undo available`, 'success'); store().syncCare(); }
      else store().print(r.error!, 'error');
    });

    this.register('link', 'Link two nodes (custom flow), optionally labeled', 'link <A> to <B> [as <label>]', 'care', (args) => {
      /* Parse "A to B" or "A to B as <multi-word label>". The label suffix
       * is split off FIRST so splitToPair only ever sees "A to B". */
      let label: string | undefined;
      const asMatch = args.match(/\s+as\s+(.+)$/i);
      if (asMatch) {
        label = asMatch[1].trim().replace(/^["']|["']$/g, '');
        args = args.slice(0, asMatch.index).trim();
      }
      const pair = splitToPair(args);
      if (!pair) { store().print('Usage: link <A> to <B> [as <label>]', 'error'); return; }
      const [a, b] = pair;
      const na = this.resolveNode(a);
      if (!na) return; // resolveNode already printed (not found / ambiguous)
      const nb = this.resolveNode(b);
      if (!nb) return;
      /* Snapshot BEFORE linking — `undo` removes the relation again. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `link ${na.label} ↔ ${nb.label}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.linkNodes(na.id, nb.id, label);
      if (r.success) {
        store().setUndo(undo);
        store().print(label ? `Linked "${na.label}" ↔ "${nb.label}" · ${label} — undo available` : `Linked "${na.label}" ↔ "${nb.label}" — undo available`, 'success');
        store().syncCare();
      }
      else store().print(r.error!, 'error');
    });

    this.register('unlink', 'Remove a custom link between two nodes', 'unlink <A> to <B>', 'care', (args) => {
      const pair = splitToPair(args);
      if (!pair) { store().print('Usage: unlink <A> to <B>', 'error'); return; }
      const [a, b] = pair;
      const na = this.resolveNode(a);
      if (!na) return;
      const nb = this.resolveNode(b);
      if (!nb) return;
      /* Snapshot BEFORE unlinking — `undo` restores the relation. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `unlink ${na.label} ↮ ${nb.label}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.unlinkNodes(na.id, nb.id);
      if (r.success) {
        store().setUndo(undo);
        store().print(`Unlinked "${na.label}" ↮ "${nb.label}" — undo available`, 'success');
        store().syncCare();
      }
      else store().print(r.error!, 'error');
    });

    this.register('relabel', 'Rename or clear a link label (empty = clear)', 'relabel <A> to <B> [as <label>]', 'care', (args) => {
      let label = '';
      const asMatch = args.match(/\s+as\s+(.+)$/i);
      if (asMatch) {
        label = asMatch[1].trim().replace(/^["']|["']$/g, '');
        args = args.slice(0, asMatch.index).trim();
      }
      const pair = splitToPair(args);
      if (!pair) { store().print('Usage: relabel <A> to <B> [as <label>]  (omit "as" to clear)', 'error'); return; }
      const [a, b] = pair;
      const na = this.resolveNode(a);
      if (!na) return;
      const nb = this.resolveNode(b);
      if (!nb) return;
      const prev = CareSpace.getLinkLabel(na.id, nb.id);
      if (!prev && !label) { store().print(`No labeled relation between "${na.label}" and "${nb.label}"`, 'error'); return; }
      const undo: UndoEntry = {
        kind: 'care',
        label: `relabel ${na.label} ↔ ${nb.label}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.setLinkLabel(na.id, nb.id, label);
      if (r.success) {
        store().setUndo(undo);
        store().print(label ? `Relation "${na.label} ↔ ${nb.label}" → "${label}" — undo available` : `Relation label cleared ("${na.label} ↔ ${nb.label}") — undo available`, 'success');
        store().syncCare();
      }
      else store().print(r.error!, 'error');
    });

    this.register('links', 'List custom links across rivers (click a row to open one endpoint)', 'links [network]', 'care', (args) => {
      /* Task 61 — link/unlink/relabel could EDIT relations, but nothing
       * could LIST them: the custom-link surface had no inventory. One
       * loop over every river's nodes; each undirected pair prints ONCE
       * (the lower id owns the row — links are stored on both sides),
       * with its label, both endpoints wearing the counted ▤ (the
       * shell-wide writing token — a relation between two heavy notes
       * reads heavy before you click), and REMOTE rivers named — the
       * near/pins/views rule, now on relation rows: a cross-river link
       * is never anonymous. The optional argument filters one river. */
      const filter = args.trim().toLowerCase();
      const curName = CareSpace.currentNetwork().name;
      const rows: { net: CareNetwork; a: CareNode; b: CareNode; label?: string }[] = [];
      for (const net of CareSpace.networks()) {
        if (filter && net.name.toLowerCase() !== filter) continue;
        for (const node of Object.values(net.nodes)) {
          for (const otherId of node.links) {
            const other = net.nodes[otherId];
            if (!other || other.id < node.id) continue; // each pair once
            rows.push({ net, a: node, b: other, label: node.linkLabels?.[otherId] ?? other.linkLabels?.[node.id] });
          }
        }
      }
      if (rows.length === 0) {
        store().print(filter ? `No custom links in "${args.trim()}"` : 'No custom links yet — link <A> to <B> [as <label>] creates one', 'muted');
        return;
      }
      /* Task 63 — named relations float: a label is the user's OWN words
       * for the pair (what `find` and the eye reach for), so labeled rows
       * lead the list. Stable sort — unlabeled pairs keep their river/id
       * order beneath the named ones. */
      rows.sort((x, y) => (y.label ? 1 : 0) - (x.label ? 1 : 0));
      store().header(`Custom Links (${rows.length})`);
      rows.forEach(({ net, a, b, label }) => {
        const remote = net.name !== curName ? ` · ${net.name}` : '';
        const markA = a.notes.length > 0 ? ` ${notesMark(a.notes.length)}` : '';
        const markB = b.notes.length > 0 ? ` ${notesMark(b.notes.length)}` : '';
        const tagA = a.tags.filter((t) => t && t !== 'none')[0];
        const loc = a.location;
        store().print(`${a.label}${markA} ↔ ${b.label}${markB}${label ? ` · "${label}"` : ''}${remote}`, 'output', {
          jump: { nodeId: a.id, river: net.name },
          ...(loc ? { flyBadge: { lat: loc.lat, lng: loc.lng, zoom: loc.zoom || 13, label: a.label } } : {}),
          /* Task 62 — the ⇥ chip reaches the OTHER endpoint: the row
           * click opens A, the chip opens B — a relation is two-sided,
           * so both ends are one click away. The chip tooltip names B
           * and its counted mark (the Task 59 dialect, riding the same
           * jumpBadge payload the near/pins rows speak).
           * Task 68 — the chip wears B's hue: the endpoint's first tag
           * color, so the chip that lands on a thought is dressed in
           * that thought's identity (untagged → violet stays). */
          jumpBadge: {
            nodeId: b.id,
            river: net.name,
            label: b.label,
            ...(markB.trim() ? { mark: markB.trim() } : {}),
            tint: (() => { const t = b.tags.filter((x) => x && x !== 'none')[0]; return (t && TAG_COLORS[t]) || undefined; })(),
          },
          bullet: (tagA && TAG_COLORS[tagA]) || net.color,
        });
      });
      store().print('  click a row to open its first endpoint · ⇥ the chip opens the other · ↗ flies to its pin', 'muted');
    });

    this.register('caremove', 'Move a node (with its subtree) under another parent', 'caremove <node> to <parent>', 'care', (args) => {
      const pair = splitToPair(args);
      if (!pair) { store().print('Usage: caremove <node> to <parent>', 'error'); return; }
      const [a, b] = pair;
      /* Task 71 — both ends speak the cross-river resolver: did-you-mean
       * on ambiguity (the Task 70 sweep missed this one), and a parent
       * in ANOTHER river resolves — the move just goes cross-river via
       * moveNodeAcross, same machinery drag-to-reparent trusts. */
      const ra = this.resolveNodeGlobal(a);
      if (!ra.ok) return; // resolveNodeGlobal already printed
      const rb = this.resolveNodeGlobal(b);
      if (!rb.ok) return;
      const na = ra.node; const aNet = ra.net;
      const nb = rb.node; const bNet = rb.net;
      if (na.id === nb.id) { store().print('Cannot move a node under itself', 'error'); return; }
      /* Snapshot BEFORE the move so `undo` restores the original parentage. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `caremove ${a} to ${b}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const aIdx = CareSpace.data.networks.indexOf(aNet);
      const bIdx = CareSpace.data.networks.indexOf(bNet);
      const r = aIdx === bIdx
        ? CareSpace.moveNode(na.id, nb.id)
        : CareSpace.moveNodeAcross(aIdx, na.id, bIdx, nb.id);
      if (r.success) {
        store().setUndo(undo);
        /* Task 71 — a cross-river move NAMES its river: the receipt is
         * self-describing about where the subtree landed. */
        const riverNote = aIdx !== bIdx ? ` · river "${bNet.name}"` : '';
        store().print(`Moved "${na.label}" under "${nb.label}"${riverNote} — undo available`, 'success');
        store().syncCare();
      }
      else store().print(r.error!, 'error');
    });
    /* Short alias — `mvnode` ≡ `caremove`. */
    this.register('mvnode', 'Move a node under another parent (alias of caremove)', 'mvnode <node> to <parent>', 'care', (args) => {
      this.execute(`caremove ${args}`);
    });

    this.register('tag', 'Assign a color tag (one arg asks what a thought wears)', 'tag <node> [color]', 'care', (args) => {
      const parts = args.split(/\s+/);
      if (parts.length === 0 || !args) {
        store().print('Usage: tag <node> [color] — one arg asks, two args dress', 'error');
        store().print(`Colors: ${TAG_PALETTE.join(' ')}`, 'muted');
        return;
      }
      /* Task 85 — the read form: `tag <node>` shows what it wears, the
       * ask before the dress. Symmetric with the write form's resolver
       * (current river), and when the thought isn't here, the escape
       * hatch names itself: `whereis` crosses rivers. */
      if (parts.length === 1) {
        const q = this.resolveNodeWithReason(args);
        if (!q.node) {
          if (q.reason === 'not-found') store().print('not in this river? `whereis <name>` searches every river', 'muted');
          return;
        }
        const worn = q.node.tags.filter((t) => t && t !== 'none');
        store().print(`"${q.node.label}" wears: ${worn.length ? worn.join(', ') : 'nothing yet'}`, worn.length ? 'output' : 'muted');
        store().print(
          worn.length
            ? `  redress: tag ${q.node.label} <color> · remove: untag ${q.node.label}`
            : `  dress it: tag ${q.node.label} <color> (palette: ${TAG_PALETTE.join(' ')})`,
          'muted',
        );
        return;
      }
      const color = parts[parts.length - 1].toLowerCase() as NodeTag;
      const name = parts.slice(0, -1).join(' ');
      const node = this.resolveNode(name); // Task 70 — did-you-mean
      if (!node) return;
      if (!TAG_COLORS[color]) {
        /* Task 80 — the palette answers a MISS with its nearest NAME
         * (prefix → substring → edit distance ≤ 2), the same teaching
         * move resolveNode makes for node names (Task 70). Six
         * candidates — the whole dictionary is checked in one breath. */
        const near = (a: string, b: string): number => {
          const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
          for (let j = 0; j <= b.length; j++) dp[0][j] = j;
          for (let i = 1; i <= a.length; i++)
            for (let j = 1; j <= b.length; j++)
              dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
          return dp[a.length][b.length];
        };
        const guess =
          TAG_PALETTE.find((t) => t.startsWith(color)) ??
          TAG_PALETTE.find((t) => t.includes(color)) ??
          TAG_PALETTE.find((t) => near(color, t) <= 2);
        store().print(`Unknown color: ${color}`, 'error');
        if (guess) store().print(`Did you mean "${guess}"?`, 'muted');
        store().print(`Available: ${TAG_PALETTE.join(' ')}`, 'muted');
        return;
      }
      /* Snapshot BEFORE retagging — `undo` restores the previous tags. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `tag ${node.label} ${color}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.setTag(node.id, color);
      if (r.success) {
        store().setUndo(undo);
        store().print(`Tagged "${name}" with ${color} — undo available`, 'success');
        store().syncCare();
      }
      else store().print(r.error!, 'error');
    });

    this.register('untag', 'Remove color tag', 'untag <node>', 'care', (args) => {
      if (!args) { store().print('Usage: untag <node>', 'error'); return; }
      const node = this.resolveNode(args); // Task 70 — did-you-mean
      if (!node) return;
      if (!node.tags.length) { store().print(`"${node.label}" has no tags`, 'muted'); return; }
      /* Snapshot BEFORE clearing — `undo` restores the tags. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `untag ${node.label}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      CareSpace.setTag(node.id, 'none');
      store().setUndo(undo);
      store().print(`Untagged "${args}" — undo available`, 'success');
      store().syncCare();
    });

    /* Task 85 — the tag INVENTORY: the graph's chip row speaks
     * per-graph; `tags` speaks the whole CareSpace — which colors are
     * worn, by whom, and who owns nothing yet. Read-only by
     * construction: every chip it hands over runs a peek verb
     * (stats · whereis · tags itself), nothing consumes. The wearer
     * chips respect locality — a chip must run where its command
     * resolves (searchNodeByName is current-river-only), so remote
     * wearers hand over `whereis` (the one verb that DOES cross
     * rivers) instead of a stats that would print not-found. */
    this.register('tags', 'Tag inventory across all rivers (tags <color|untagged> drills down)', 'tags [color|untagged]', 'care', (args) => {
      const want = (args ?? '').trim().toLowerCase();
      const curId = CareSpace.currentNetwork().id;
      const wearers: Array<{ label: string; river: string; riverColor: string; tag: NodeTag; remote: boolean; notes: number }> = [];
      const orphans: Array<{ label: string; river: string; riverColor: string; remote: boolean; notes: number }> = [];
      for (const net of CareSpace.networks()) {
        const remote = net.id !== curId;
        for (const node of Object.values(net.nodes)) {
          const t = node.tags.filter((x) => x && x !== 'none')[0];
          const row = { label: node.label, river: net.name, riverColor: net.color, remote, notes: node.notes.length };
          if (t) wearers.push({ ...row, tag: t });
          else orphans.push(row);
        }
      }
      const multi = CareSpace.networks().length > 1;
      const display = (w: { label: string; river: string; remote: boolean }) =>
        multi && w.remote ? `${w.river}/${w.label}` : w.label;
      /* Task 86 — locality became COLOR, by the same restraint the
       * label prefix follows: only REMOTE wearers tint (their river's
       * hue, the same value stats' river chips wear). Single river → no
       * chip is remote → not one pixel changes; multi river → the tint
       * is the prefix's fact at a glance. Local chips stay untinted —
       * they all live HERE, and one shared hue would say nothing. */
      const chip = (w: { label: string; river: string; riverColor: string; remote: boolean }) =>
        w.remote
          ? { cmd: `whereis ${w.label}`, label: display(w), title: `run: whereis ${w.label} — lives in "${w.river}", the cross-river peek`, tint: w.riverColor }
          : { cmd: `stats ${w.label}`, label: display(w), title: `run: stats ${w.label} — this wearer's stats` };

      /* Drill-down — one color's wearers, each row wearing the color. */
      if (want && want !== 'untagged') {
        if (!TAG_COLORS[want] || want === 'none') {
          store().print(`Unknown color: ${want}`, 'error');
          store().print(`Available: ${TAG_PALETTE.join(' ')} — or \`tags untagged\``, 'muted');
          return;
        }
        const hits = wearers.filter((w) => w.tag === want);
        store().header(`Tagged "${want}"`);
        if (!hits.length) {
          store().print(`No thought wears ${want} yet — \`tag <node> ${want}\` dresses the first`, 'muted');
          return;
        }
        for (const w of hits) {
          store().print(`${display(w)}  ${notesMark(w.notes)}`, 'output', {
            bullet: TAG_COLORS[want],
            chips: [chip(w)],
          });
        }
        store().print(`${hits.length} wearer${hits.length === 1 ? '' : 's'} of ${want}${multi ? ' — across all rivers' : ''}`, 'muted');
        return;
      }

      /* Drill-down — the orphans: what `tag:untagged` means. */
      if (want === 'untagged') {
        store().header('Untagged');
        if (!orphans.length) {
          store().print('Every thought wears a color', 'muted');
          return;
        }
        for (const w of orphans) {
          store().print(`${display(w)}  ${notesMark(w.notes)}`, 'output', {
            /* Task 87 — the hollow ring: absence wears ○, the terminal
             * twin of the graph's hollow untagged dot (Task 76). */
            bullet: 'var(--naksha-text-4)',
            bulletHollow: true,
            chips: [chip(w)],
          });
        }
        store().print(`${orphans.length} untagged — \`tag <node> <color>\` dresses one`, 'muted');
        return;
      }

      /* The inventory — palette order, one line per worn color. */
      store().header('Tag Inventory');
      if (!wearers.length) {
        store().print(
          orphans.length
            ? `No tags worn yet — \`tag <node> <color>\` dresses the first (palette: ${TAG_PALETTE.join(' ')})`
            : 'No thoughts yet — `node <label>` plants one, `tag <node> <color>` dresses it',
          'muted',
        );
        return;
      }
      for (const color of TAG_PALETTE) {
        const hits = wearers.filter((w) => w.tag === color);
        if (!hits.length) continue;
        store().print(`${color} ×${hits.length}`, 'output', {
          bullet: TAG_COLORS[color],
          chips: hits.map(chip),
        });
      }
      if (orphans.length) {
        store().print(`untagged ×${orphans.length}`, 'muted', {
          bullet: 'var(--naksha-text-4)',
          bulletHollow: true,
          chips: [{ cmd: 'tags untagged', label: 'orphans', title: 'run: tags untagged — list the untagged' }],
        });
      }
      /* Task 86 — the bridge, terminal side: the footnote always
       * MENTIONED the graph's chip row; a mention is now a door. The
       * inventory speaks nouns, the graph shows them wearing colors —
       * the handover was the only missing verb of the tag story. */
      store().print("drill: tags <color|untagged> · the graph's chip row speaks the same colors, per-graph", 'muted', {
        chips: [{ cmd: 'caregraph graph', label: '⌗ open the graph', title: 'run: caregraph graph — the force-graph note-map, where the colors become dots and the chip row filters them' }],
      });
    });

    this.register('collapse', 'Toggle node collapse', 'collapse <node>', 'care', (args) => {
      if (!args) { store().print('Usage: collapse <node>', 'error'); return; }
      const node = this.resolveNode(args); // Task 70 — did-you-mean
      if (!node) return;
      const r = CareSpace.toggleCollapse(node.id);
      if (r.success) {
        store().print(`${r.data ? 'Collapsed' : 'Expanded'} "${args}"`, 'success');
        store().syncCare();
      } else store().print(r.error!, 'error');
    });

    this.register('stats', 'Show CareSpace statistics', 'stats [node]', 'care', (args) => {
      const s = CareSpace.getStats();
      store().header('CareSpace Statistics');
      /* Task 93 — the Networks row reflows: wide panes keep the
       * (current: …) contract; the default pane gets the short form
       * with the name truncated to the room that's left (user data). */
      const netRowFull = `Networks:    ${s.networks}/${MAX_NETWORKS}  (current: ${s.currentNet})`;
      if (netRowFull.length <= termCols()) store().print(netRowFull, 'output');
      else store().print(`Networks:    ${s.networks}/${MAX_NETWORKS} · ${truncate(s.currentNet, Math.max(8, termCols() - 20))}`, 'output');
      store().print(`Nodes:       ${s.totalNodes}`, 'output');
      store().print(`Notes:       ${s.totalNotes}`, 'output');
      /* Task 62 — the global summary now speaks the relation web too
       * (per-node stats already did; the total was missing). */
      store().print(`Links:       ${s.totalLinks}`, 'output');
      store().print(`Pinned locs: ${s.pinnedLocations}`, 'output');
      /* Task 64 — structure weight per river: the total above is the
       * CURRENT river's web; a river with 3 relations vs one with 0 is
       * the sentence this line speaks. Muted footnote under the block,
       * and only when there is more than one river to compare.
       * Task 66 — each river's count is a `care <river>` chip now: the
       * switch verb has existed since the rivers did — the summary
       * just never handed it over. Click = echo + care <name>. */
      if (CareSpace.data.networks.length > 1) {
        const riverChips = CareSpace.networks().map((n) => {
          let ends = 0;
          for (const node of Object.values(n.nodes)) ends += node.links.length;
          return {
            cmd: `care ${n.name}`,
            label: `${n.name} ${Math.round(ends / 2)}`,
            title: `care ${n.name} — switch to this river`,
            /* Task 67 — the chip wears its river's hue (the bullet
             * payload tints rows; --chip-tint is the same fact for
             * chips). The legend and the verbs now read as one. */
            tint: n.color,
          };
        });
        store().print('  per river:', 'muted', { chips: riverChips });
      }
      if (args) {
        const node = this.resolveNode(args); // Task 70 — did-you-mean (was: silent nothing when not found)
        if (node) {
          store().print('');
          store().print(`Node "${node.label}":`, 'highlight');
          store().print(`  children: ${node.children.length}`, 'muted');
          store().print(`  notes:    ${node.notes.length}`, 'muted');
          store().print(`  links:    ${node.links.length}`, 'muted');
          store().print(`  tags:     ${node.tags.join(', ') || '—'}`, 'muted');
          store().print(`  created:  ${timeAgo(node.createdAt)}`, 'muted');
          store().print(`  updated:  ${timeAgo(node.updatedAt)}`, 'muted');
        }
      }
    });

    this.register('timeline', 'Show notes chronologically', 'timeline [today|node]', 'care', (args) => {
      const all = CareSpace.getAllNotes();
      let filtered = all;
      if (args === 'today') {
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
        filtered = all.filter((n) => n.note.timestamp >= startOfDay.getTime());
      } else if (args && args !== 'all') {
        /* Task 70 — was a silent fallthrough: a typo'd name showed ALL
         * notes (filtered never narrowed). Now the resolver's receipt
         * prints and the command stops. */
        const node = this.resolveNode(args);
        if (!node) return;
        filtered = all.filter((n) => n.node.id === node.id);
      }
      if (filtered.length === 0) { store().print('(no notes)', 'muted'); return; }
      store().header(`Timeline (${filtered.length})`);
      /* Task 74 — timeline rows become ARRIVALS (the last unlabeled
       * landing surface, per Task 73's list): click the `[time] path`
       * row = ⇥ tree landing on the note's thought (doJump receipt +
       * details, the standard jump covenant), and a located thought
       * wears the ↗ flyBadge at the row's tail — which, via the shared
       * doFly verb, carries the saveview chip. One row, the full
       * arrival dialect: tree ⇥ · map ↗ · persistence ⌂. */
      const river = CareSpace.currentNetwork().name;
      filtered.forEach((n) => {
        const loc = n.node.location;
        store().print(`[${n.note.timeString}] ${n.nodePath}`, 'highlight', {
          jump: { nodeId: n.node.id, river },
          ...(loc ? { flyBadge: { lat: loc.lat, lng: loc.lng, zoom: loc.zoom || 13, label: n.node.label } } : {}),
        });
        store().print(`  ${n.note.text}`, 'output');
      });
    });

    this.register('exporttree', 'Export tree as markdown', 'exporttree [network]', 'care', (args) => {
      const md = CareSpace.exportMarkdown(args);
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `naksha-tree-${(args || CareSpace.currentNetwork().name).toLowerCase().replace(/\s+/g, '-')}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      store().print('Tree exported as markdown', 'success');
    });

    this.register('exporthtml', 'Export everything as a standalone HTML file', 'exporthtml', 'care', () => {
      const html = buildStandaloneHTML();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `naksha-export-${new Date().toISOString().slice(0, 10)}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      store().print(`HTML export downloaded (${formatSize(new Blob([html]).size)})`, 'success');
      store().print('  Open the file in any browser to view your CareSpace.', 'muted');
    });

    this.register('exportpdf', 'Export CareSpace as a print-ready PDF (via browser print)', 'exportpdf', 'care', () => {
      // Open a print-friendly HTML view in a new window, then trigger print.
      // The user selects "Save as PDF" in the print dialog.
      const html = buildPrintableHTML();
      const printWin = window.open('', '_blank');
      if (!printWin) {
        store().print('Popup blocked. Allow popups to export PDF.', 'error');
        return;
      }
      printWin.document.write(html);
      printWin.document.close();
      // Wait for fonts/content to settle, then trigger print.
      printWin.onload = () => {
        setTimeout(() => {
          printWin.print();
        }, 500);
      };
      store().print('Print view opened — select "Save as PDF" in the dialog', 'success');
    });

    this.register('details', 'Open node details panel', 'details [node]', 'care', (args) => {
      let target: CareNode | null;
      if (args) {
        target = this.resolveNode(args); // Task 70 — did-you-mean
      } else {
        target = CareSpace.getCurrentNode();
      }
      if (!target) return; // resolveNode already printed
      /* Task 49 — the command asks for a thought by name; when it HAS
       * notes, the panel leads with them (same focus-notes intent the
       * graph's double-click sends). A note-less node just opens plain. */
      useNaksha.getState().setDetailsNodeId(target.id, false, target.notes.length > 0);
      store().print(`Details: ${target.label}`, 'info');
    });

    this.register('tlview', 'Open visual timeline view', 'tlview', 'care', () => {
      useNaksha.getState().setTimelineOpen(true);
      store().print('Timeline view opened — press Esc to close', 'info');
    });

    this.register('caregraph', 'Toggle CareSpace force-graph note-map view', 'caregraph [tree|graph]', 'care', (args) => {
      const s = useNaksha.getState();
      const mode = args.trim().toLowerCase();
      if (mode === 'tree' || mode === 'graph') {
        s.setCareViewMode(mode);
      } else {
        // No/unknown arg → toggle
        s.setCareViewMode(s.careViewMode === 'tree' ? 'graph' : 'tree');
      }
      const now = useNaksha.getState().careViewMode;
      store().print(
        now === 'graph'
          ? 'Force-graph note-map — drag nodes, scroll to zoom, ⌗ labels show link relations'
          : 'Back to tree view',
        'info',
      );
    });

    /* Task 100 — the care `jump [query]` registration that lived here was
     * DEAD CODE: the map section registered `jump` again further down and
     * the registry's Map.set silently buried this one. The merged verb
     * (pin# → map, text/bare → this finder) now lives there. */

    this.register('replace', 'Search and replace in notes', 'replace "old" with "new" in <node>', 'care', (args) => {
      const m = args.match(/^(.+?)\s+with\s+(.+?)\s+in\s+(.+)$/i);
      if (!m) { store().print('Usage: replace "old" with "new" in <node>', 'error'); return; }
      const oldText = m[1].replace(/^["']|["']$/g, '');
      const newText = m[2].replace(/^["']|["']$/g, '');
      const nodeName = m[3].trim();
      const node = this.resolveNode(nodeName); // Task 70 — did-you-mean
      if (!node) return;
      const r = CareSpace.replaceInNotes(node.id, oldText, newText);
      if (r.success) {
        store().print(`Replaced in ${r.data!.count} note(s)`, 'success');
        store().syncCare();
      } else store().print(r.error!, 'error');
    });

    /* ────────────────── MAP ────────────────── */
    this.register('goto', 'Fly to a location', 'goto <place>', 'map', async (args) => {
      if (!args) { store().print('Usage: goto <place>', 'error'); return; }
      const loading = store().showLoading(`Searching for "${args}"...`);
      const r = await MapEngine.flyTo(args);
      loading.stop();
      if (r.success && r.result) {
        store().print(`Flying to ${r.result.displayName.split(',')[0]}`, 'success');
        store().print(r.result.displayName, 'muted');
        const st = MapEngine.getState();
        useNaksha.getState().pushView(`goto ${args}`, { lat: st.lat, lng: st.lng, zoom: st.zoom, layer: st.layer });
        /* Task 72 — arrival → persistence in one click: the receipt
         * wears a saveview chip prefilled with the place's first token,
         * so pinning the camera where you just landed needs no retyping
         * (the view history already holds the arrival — this names it). */
        const firstName = args.replace(/^["']|["']$/g, '').split(/\s+/)[0];
        if (firstName) {
          store().print('  keep this camera:', 'muted', {
            chips: [{ cmd: `saveview ${firstName}`, label: '⌂ save view', title: `run: saveview ${firstName} — pin the camera where you just landed` }],
          });
        }
      } else {
        store().print(r.error || 'Location not found', 'error');
      }
    });

    this.register('route', 'Calculate a route', 'route <from> to <to>', 'map', async (args) => {
      const pair = splitToPair(args);
      if (!pair) { store().print('Usage: route <from> to <to>', 'error'); return; }
      const loading = store().showLoading('Calculating route...');
      const r = await MapEngine.route(pair[0], pair[1]);
      loading.stop();
      if (r.success) {
        store().print('Route calculated', 'success');
        MapEngine.formatRouteReport(r as never).forEach((l) => store().print(l, 'info'));
        const st = MapEngine.getState();
        useNaksha.getState().pushView(`route ${pair[0]}→${pair[1]}`, { lat: st.lat, lng: st.lng, zoom: st.zoom, layer: st.layer });
      } else store().print(r.error || 'Route failed', 'error');
    });

    this.register('where', 'Identify current location', 'where', 'map', async () => {
      const loading = store().showLoading('Identifying location...');
      const r = await MapEngine.reverseGeocode();
      loading.stop();
      if (r.success) store().print(r.displayName!, 'info');
      else store().print(r.error || 'No location data', 'warning');
    });

    this.register('whereami', 'Use GPS to find your position', 'whereami', 'map', async () => {
      const loading = store().showLoading('Getting GPS position...');
      const r = await MapEngine.whereAmI();
      loading.stop();
      if (r.success) {
        store().print(`You are at ${r.lat!.toFixed(4)}, ${r.lng!.toFixed(4)}`, 'success');
        const st = MapEngine.getState();
        useNaksha.getState().pushView('whereami', { lat: st.lat, lng: st.lng, zoom: st.zoom, layer: st.layer });
      } else store().print(r.error || 'GPS unavailable', 'error');
    });

    this.register('search', 'Find nearby POIs (or use a category: food, fuel, health...)', 'search <term|category> near [place]', 'map', async (args) => {
      const m = args.match(/^(.+?)\s+near\s+(.+)$/i);
      let term = m ? m[1] : args.split(' near ')[0];
      const place = m ? m[2] : 'here';
      if (!term) {
        store().print('Usage: search <term> near [place]', 'error');
        store().print(`Categories: ${Object.keys(POI_CATEGORIES).join(', ')}`, 'muted');
        return;
      }
      // If the term is a category preset, expand it
      const catKey = term.toLowerCase();
      if (POI_CATEGORIES[catKey]) {
        term = POI_CATEGORIES[catKey];
      }
      const loading = store().showLoading(`Searching for ${term} near ${place}...`);
      const r = await MapEngine.searchNearby(term, place);
      loading.stop();
      if (r.success && r.results && r.results.length > 0) {
        /* Task 70 — the receipt names the reuse: pins already on the map
         * kept their numbers (no twin markers); only fresh POIs were
         * added. Task 71 — it names the mirror detour too. */
        const reusedNote = r.reused ? ` · ${r.reused} pin${r.reused === 1 ? '' : 's'} reused` : ' (added as pins)';
        store().print(`Found ${r.count} results${reusedNote}${r.mirrored ? ' · via mirror' : ''} — click a row to fly`, 'success');
        /* Task 43 — aligned fly rows: pin number, truncated label. Every
         * row carries fly data (zoom 16: POI-reading zoom), so the SAME
         * delegated terminal listener that powers `near` flies here too.
         * Zero extra listeners — the plumbing is shared.
         * Task 69 — the rows speak the FULL pins dialect now: the
         * nearest-thought mark + ⇥ landing chip (the demo-receipt
         * machinery — 20 rows × nearestThought is trivial), and a
         * `+thought` chip handing over `nodefrom <pin>` — the POI →
         * CareSpace bridge, one click per row.
         * Task 70 — the chip is STATE-AWARE: a POI that already became
         * a thought (same name + same coordinates, any river) wears a
         * tinted `⇥ planted` chip that flies you there instead of
         * offering a duplicate — state you can see, the demo-guard's
         * honesty carried onto the row itself. */
        for (const p of r.results.slice(0, 20)) {
          const near = nearestThought(p.lat, p.lng, 5);
          const mark = near ? (near.notes > 0 ? ` ${notesMark(near.notes)}` : near.tagged ? ' ●' : '') : '';
          const riverMark = near && near.remote ? ` · ${near.river}` : '';
          const planted = findPlantedThought((p.label || `Pin ${p.num}`).trim(), p.lat, p.lng);
          const chips = planted
            ? [{ cmd: `gotonode ${planted.node.id}`, label: '⇥ planted', title: `already a thought — run: gotonode ${planted.node.id}`, tint: planted.tagColor }]
            : [{ cmd: `nodefrom ${p.num}`, label: '+thought', title: `run: nodefrom ${p.num} — plant a thought from this POI (its name + location)` }];
          /* Task 93 — the pin row measures its near-tail and gives the
             POI label the room that's left (the tail keeps its inner
             truncates) — the row stays one line, one flight. */
          const nearTail = near
            ? ` · near "${truncate(near.label, 12)}" ${near.d < 10 ? near.d.toFixed(1) : Math.round(near.d)}km${mark}${riverMark}`
            : '';
          store().print(
            `  [${String(p.num).padStart(2, '0')}] ${truncate(p.label, Math.max(8, termCols() - 7 - nearTail.length))}${nearTail}`,
            'output',
            {
              fly: { lat: p.lat, lng: p.lng, zoom: 16, label: p.label || `Pin ${p.num}` },
              ...(near
                ? { jumpBadge: { nodeId: near.nodeId, river: near.river, label: near.label, tint: near.tagColor, ...(mark.trim() ? { mark: mark.trim() } : {}) } }
                : {}),
              chips,
            },
          );
        }
        if (r.results.length > 20) store().print(`  … ${r.results.length - 20} more (pins on the map)`, 'muted');
      } else if (r.success) store().print(`Found ${r.count} results (added as pins)`, 'success');
      else store().print(r.error || 'No results', 'warning');
    });

    this.register('measure', 'Measure distance between two points (or save: measure <A> to <B> as <name>)', 'measure <A> to <B> [as <name>]', 'map', async (args) => {
      // Check for "as <name>" suffix for saving
      const saveMatch = args.match(/^(.+?)\s+to\s+(.+?)\s+as\s+(.+)$/i);
      const pair = splitToPair(saveMatch ? `${saveMatch[1]} to ${saveMatch[2]}` : args);
      if (!pair) { store().print('Usage: measure <A> to <B> [as <name>]', 'error'); return; }
      const loading = store().showLoading('Measuring...');
      const r = await MapEngine.measure(pair[0], pair[1]);
      loading.stop();
      if (r.success) {
        MapEngine.formatMeasureReport(r as never).forEach((l) => store().print(l, 'info'));
        // If saving, persist the measurement
        if (saveMatch && r.from && r.to && r.km != null) {
          const saveName = saveMatch[3].trim();
          MapEngine.saveMeasurement(
            saveName,
            r.from.displayName.split(',')[0],
            r.to!.displayName.split(',')[0],
            r.km,
            r.from.lat, r.from.lng,
            r.to.lat, r.to.lng,
          );
          store().print(`Measurement saved as "${saveName}"`, 'success');
          store().print(`  Use 'loadmeasure ${saveName}' to recall it`, 'muted');
        }
      } else store().print(r.error || 'Measure failed', 'error');
    });

    this.register('measures', 'List all saved measurements', 'measures', 'map', () => {
      const list = MapEngine.listMeasurements();
      if (list.length === 0) { store().print('No saved measurements', 'muted'); return; }
      store().header(`Saved Measurements (${list.length})`);
      list.forEach((m) => {
        /* Task 93 — measures stack their endpoints when the pane can't
         * hold name + from → to + distance on one line. */
        const mRow = `  ${m.name.padEnd(20)} ${m.fromLabel} → ${m.toLabel}  ${formatDistance(m.km)}`;
        if (mRow.length <= termCols()) store().print(mRow, 'output');
        else {
          store().print(`  ${m.name}`, 'output');
          printIndentedWrapped('      ', `${m.fromLabel} → ${m.toLabel} · ${formatDistance(m.km)}`, 'muted');
        }
      });
    });

    this.register('loadmeasure', 'Load a saved measurement onto the map', 'loadmeasure <name>', 'map', (args) => {
      if (!args) { store().print('Usage: loadmeasure <name>', 'error'); return; }
      const r = MapEngine.loadMeasurement(args);
      if (r.success) {
        store().print(`Loaded: ${args} (${formatDistance(r.km!)})`, 'success');
      } else store().print(r.error!, 'error');
    });

    this.register('rmmeasure', 'Remove a saved measurement', 'rmmeasure <name>', 'map', (args) => {
      if (!args) { store().print('Usage: rmmeasure <name>', 'error'); return; }
      /* Task 87 — the last map-side verb outside history: the mapdata
       * snapshot now carries measurements (optional field — pre-87
       * snapshots restore without touching the live set). */
      const undo: UndoEntry = {
        kind: 'mapdata',
        label: `rmmeasure ${args}`,
        snapshot: MapEngine.snapshotMapData(),
        ts: Date.now(),
      };
      const r = MapEngine.removeMeasurement(args);
      if (r.success) {
        store().setUndo(undo);
        store().print(`Removed: ${args} — undo available`, 'success');
      }
      else store().print(r.error!, 'error');
    });

    this.register('pin', 'Add a pin at map center', 'pin [label]', 'map', (args) => {
      const r = MapEngine.addPin(args);
      if (r.success) {
        store().print(`Pin ${r.pinNumber} added${args ? ` (${args})` : ''}`, 'success');
      }
    });

    /* Task 53 — the pin list joins the interactive dialect: every row is
     * a ↗ fly row (click = jump to the pin) wearing a ✕ kill chip
     * (click = delpin). The list IS the map — and the delete button.
     * Task 55 — the NEIGHBOR chip: a pin is a PLACE, so each row asks
     * "what have I thought here?" — the closest thought rides the row
     * as a ⇥ chip (tree landing + details). Invocation-only cost; zero
     * at rest.
     * Task 56 — the radius is YOURS: `pins 12` widens the sweep to
     * 12km (any positive number; bare `pins` keeps the 5km default).
     * The footer echoes the radius actually used, so the chip's
     * contract is always spelled out on the very list that wears it.
     * Task 57 — relevance: the pick prefers noted/tagged thoughts and
     * the row marks it (▤ has notes / ● has a tag), so a farther but
     * WRITTEN thought honestly outranks a bare nearer one. */
    this.register('pins', 'List all pins (click = fly · ✕ = remove · ⇥ = nearest thought) — pins [km] sets the sweep radius', 'pins [km]', 'map', (args) => {
      const radiusKm = parseRadiusKm(args);
      const pins = MapEngine.listPins();
      if (pins.length === 0) { store().print('No pins added', 'muted'); return; }
      pins.forEach((p) => {
        const near = nearestThought(p.lat, p.lng, radiusKm);
        /* Task 58 — the mark COUNTS: ▤2 says "two notes written here",
         * the same token the map label and the near rows speak.
         * Task 59 — a cross-river pick NAMES its river (the near rows'
         * rule): a chip that reached across shouldn't be anonymous. */
        const mark = near ? (near.notes > 0 ? ` ${notesMark(near.notes)}` : near.tagged ? ' ●' : '') : '';
        const riverMark = near && near.remote ? ` · ${near.river}` : '';
        /* Task 71 — the planted chip, ported from the search rows: a pin
         * that already BECAME a thought offers ⇥ planted (tinted by the
         * thought's identity) beside ✕ — the row shows its own state. */
        const planted = findPlantedThought((p.label || `Pin ${p.number}`).trim(), p.lat, p.lng);
        store().print(
          `  ${p.number}. ${p.label || `Pin ${p.number}`}  (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})${near ? ` · near "${truncate(near.label, 18)}" ${near.d < 10 ? near.d.toFixed(1) : Math.round(near.d)}km${mark}${riverMark}` : ''}`,
          'output',
          {
            fly: { lat: p.lat, lng: p.lng, zoom: 14, label: p.label || `Pin ${p.number}` },
            kill: { pin: p.number },
            ...(near ? { jumpBadge: { nodeId: near.nodeId, river: near.river, label: near.label, tint: near.tagColor, ...(mark.trim() ? { mark: mark.trim() } : {}) } } : {}),
            ...(planted
              ? { chips: [{ cmd: `gotonode ${planted.node.id}`, label: '⇥ planted', title: `already a thought — run: gotonode ${planted.node.id}`, tint: planted.tagColor }] }
              : {}),
          },
        );
      });
      store().print(`↗ click a row to fly there · ✕ removes · ⇥ opens your most relevant thought nearby — notes/tagged first (≤${fmtKm(radiusKm)}km)`, 'muted');
    });

    /* Task 100 — jump was registered TWICE and the second set() silently
     * buried the first: the care fuzzy-finder never existed from the
     * user's chair. One verb now owns both meanings, dispatched by the
     * arg's shape — digits are a pin number (map), anything else (or
     * nothing) is the node quick-jump finder (care), which receives the
     * typed text as its opening query via the store's jumpQuery. */
    this.register('jump', 'Jump — to a pin by number, or to a node via the quick finder', 'jump [pin# | node]', 'map', (args) => {
      const raw = args.trim();
      if (/^\d+$/.test(raw)) {
        const n = parseInt(raw, 10);
        const r = MapEngine.jumpToPin(n);
        if (r.success) store().print(`Flying to pin ${n}`, 'info');
        else store().print(r.error!, 'error');
        return;
      }
      useNaksha.getState().setJumpOpen(true, raw);
      store().print(
        raw
          ? `Node quick-jump opened — searching "${raw}"`
          : 'Node quick-jump opened — type to search, ↑↓ to navigate',
        'info',
      );
    });

    this.register('clearpins', 'Remove all pins', 'clearpins', 'map', () => {
      /* Task 87 — bulk destruction joins history: clearpins wiped every
       * pin with no way back while its one-pin sibling (delpin, via the
       * kill chip) rode a snapshot since Task 54. The honest guard
       * comes first — undoing a no-op would be a receipt that lies. */
      if (MapEngine.markers.length === 0) {
        store().print('No pins to clear', 'muted');
        return;
      }
      const undo: UndoEntry = {
        kind: 'mapdata',
        label: 'clearpins',
        snapshot: MapEngine.snapshotMapData(),
        ts: Date.now(),
      };
      MapEngine.clearPins();
      store().setUndo(undo);
      store().print(`All pins cleared — undo available`, 'success');
    });

    this.register('delpin', 'Delete one pin by number', 'delpin <n>', 'map', (args) => {
      const n = parseInt(args, 10);
      if (isNaN(n)) { store().print('Usage: delpin <n>', 'error'); return; }
      /* Task 87 — the verb catches up with its own kill chip: the ✕ on
       * a pins row has parked a mapdata snapshot since Task 54; typing
       * the SAME destruction now speaks the same safety. */
      const undo: UndoEntry = {
        kind: 'mapdata',
        label: `delpin ${n}`,
        snapshot: MapEngine.snapshotMapData(),
        ts: Date.now(),
      };
      const r = MapEngine.removePin(n);
      if (r.success) {
        store().setUndo(undo);
        store().print(`Pin ${n} removed — undo available`, 'success');
      }
      else store().print(r.error!, 'error');
    });

    /* Task 59 — `demo`: a playground in one command. Four located
     * thoughts with real notes and tags, spread ±1.5km around the
     * crosshair, plus one pin — the least-keystroke path to a LIVE
     * map layer, force-graph, and every list (pins / near / treenode)
     * wearing counted marks. Beta carries TEN notes so the ▤9+ cap
     * has a real specimen to show. One care-snapshot undo covers the
     * thoughts; clearpins removes the pin. */
    this.register('demo', 'Seed a demo cluster at the crosshair — 4 thoughts (notes/tags/locations) + 1 pin; then try pins, near, caregraph graph', 'demo', 'map', () => {
      /* Task 62 — idempotency: demo is a SEEDER, not a topping. When all
       * four specimen labels are already children of the current node
       * (addNode's own duplicate rule — exact, case-insensitive, same
       * parent), re-running could add nothing new EXCEPT a duplicate
       * pin (last round's QA find) — so it early-exits, touching
       * neither the undo slot nor the pin list. Partial presence (a
       * half-cleared cluster, or a user node that merely shares a
       * label elsewhere in the river) keeps the old behavior: the
       * existing names error honestly, the rest seed. */
      const curNet = CareSpace.currentNetwork();
      const parentNode = CareSpace.getNode(curNet.currentId);
      const hasSpecimen = (label: string) =>
        !!parentNode?.children.some((cid) => curNet.nodes[cid]?.label.toLowerCase() === label.toLowerCase());
      /* Task 68 — the guard grows a LOCATION sense. The cluster is
       * anchored at the CROSSHAIR, not at a tree parent: cdnode
       * elsewhere and re-running used to seed a TWIN cluster on the
       * same spot — two demo pins at one coordinate, duplicate
       * Alpha/Beta labels, a second Alpha⇌Beta (Task 62's bug back
       * through the parent hole, found by this round's own e2e when a
       * cdnode Gamma slipped between two demo runs). Now the ground
       * itself answers: if all four specimens stand within 2km of the
       * crosshair — in ANY river — this ground is already seeded. The
       * per-parent check stays (a cluster under the current node is
       * "present" wherever the map points). */
      const c = MapEngine.getCenter();
      const nearSpecimen = (label: string) =>
        Object.values(CareSpace.data.networks).some((net) =>
          Object.values(net.nodes).some((n) => {
            if (n.label.toLowerCase() !== label.toLowerCase() || !n.location) return false;
            const dKm = Math.hypot(
              (n.location.lat - c.lat) * 111,
              (n.location.lng - c.lng) * 111 * Math.cos((c.lat * Math.PI) / 180),
            );
            return dKm <= 2;
          }),
        );
      const allFour = (pred: (label: string) => boolean) =>
        ['Alpha', 'Beta', 'Gamma', 'Delta'].every(pred);
      if (allFour(hasSpecimen) || allFour(nearSpecimen)) {
        store().print('Demo cluster already present — nothing reseeded · rmnode Alpha/Beta/Gamma/Delta resets it', 'muted');
        return;
      }
      const zoom = Math.round(MapEngine.getZoom());
      const undo: UndoEntry = {
        kind: 'care',
        label: 'demo',
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const mk = (label: string, dLat: number, dLng: number, notes: string[], tag: NodeTag | null): string | null => {
        const cr = CareSpace.addNode(label);
        if (!cr.success) { store().print(cr.error!, 'error'); return null; }
        const id = cr.data!;
        for (const t of notes) CareSpace.addNote(id, t);
        if (tag) CareSpace.setTag(id, tag);
        CareSpace.pinLocation(id, c.lat + dLat, c.lng + dLng, Math.max(zoom, 13));
        return id;
      };
      const tenNotes = Array.from({ length: 10 }, (_, i) => `demo note ${i + 1} — the counted glyph has a real specimen now`);
      const alphaId = mk('Alpha', 0, 0, ['first light at the crosshair', 'second pass, tighter'], 'red');
      const betaId = mk('Beta', 0.008, 0.012, tenNotes, null);
      const gammaId = mk('Gamma', -0.01, 0.004, ['southwest sketch, half-formed'], 'blue');
      const deltaId = mk('Delta', 0.004, -0.014, [], 'green');
      const made = [alphaId, betaId, gammaId, deltaId].filter(Boolean).length;
      /* Task 60 — the cluster carries ONE custom link (Alpha ⇌ Beta):
       * the force-graph's edge rendering finally has a demo specimen,
       * and `link <A> to <B>` has a living example one `caregraph
       * graph` away. Same undo snapshot covers it. */
      let linked = false;
      if (alphaId && betaId) {
        const lr = CareSpace.linkNodes(alphaId, betaId, 'demo flow');
        linked = !!lr.success;
      }
      MapEngine.addPin('demo');
      useNaksha.getState().setUndo(undo);
      useNaksha.getState().syncCare();
      if (!useNaksha.getState().settings.showNodesOnMap) {
        useNaksha.getState().setSettings({ showNodesOnMap: true });
        store().print('Node markers enabled (mapnodes off to hide)', 'muted');
      }
      store().print(`Demo cluster seeded — ${made} thoughts${linked ? ' · 1 link (Alpha ⇌ Beta)' : ''} · 1 pin · undo reverts the thoughts, clearpins removes the pin`, 'success');
      /* Task 63 — the receipt wears a LIVE pins-row: the seeded pin sits
       * at the crosshair, Alpha sits ON it, so the ⇥ near chip has a
       * real nearest-thought to name the moment demo finishes — the
       * pins dialect taught by specimen (the exact row `pins` will
       * print), not by pointer ("then try pins"). Same payload shape:
       * ↗ fly row + ⇥ chip with the counted mark. */
      const seeded = MapEngine.listPins();
      const pin = seeded[seeded.length - 1];
      if (pin) {
        const near = nearestThought(pin.lat, pin.lng, 5);
        const mark = near ? (near.notes > 0 ? ` ${notesMark(near.notes)}` : near.tagged ? ' ●' : '') : '';
        const riverMark = near && near.remote ? ` · ${near.river}` : '';
        /* Task 71 — the specimen row speaks the full pins dialect:
         * planted chip included WHEN it's true (the rule is label-
         * precise: the demo pin is named "demo", the thought there is
         * "Alpha" — no chip; a pin whose OWN name became the thought
         * wears it, as `pins` rows do). */
        const planted = findPlantedThought((pin.label || `Pin ${pin.number}`).trim(), pin.lat, pin.lng);
        store().print(
          `  ${pin.number}. ${pin.label || `Pin ${pin.number}`}  (${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)})${near ? ` · near "${truncate(near.label, 18)}" ${near.d < 10 ? near.d.toFixed(1) : Math.round(near.d)}km${mark}${riverMark}` : ''}`,
          'output',
          {
            fly: { lat: pin.lat, lng: pin.lng, zoom: 14, label: pin.label || `Pin ${pin.number}` },
            ...(near ? { jumpBadge: { nodeId: near.nodeId, river: near.river, label: near.label, tint: near.tagColor, ...(mark.trim() ? { mark: mark.trim() } : {}) } } : {}),
            ...(planted
              ? { chips: [{ cmd: `gotonode ${planted.node.id}`, label: '⇥ planted', title: `already a thought — run: gotonode ${planted.node.id}`, tint: planted.tagColor }] }
              : {}),
          },
        );
        /* Task 65 — the loop made explicit: the specimen row above is
         * the pin naming the thought; one line points at the reverse —
         * near's own row wears ⚑N (Task 65's chip) naming the pin. */
        if (near) {
          store().print(`  near answers the reverse — its "${truncate(near.label, 18)}" row carries ⚑${pin.number}: the pin sits ON the thought`, 'muted');
        }
      }
      /* Task 66 — the try line WEARS its verbs: each suggestion is a
       * real filter chip (the plural `chips` payload) — click = echo +
       * run, the exact surface the user would have typed. The receipt
       * stops pointing at commands the user must retype and starts
       * handing them over. */
      store().print('  try:', 'muted', {
        chips: [
          { cmd: 'pins', label: 'pins', title: 'run: pins — the pin list (✕ there removes one)' },
          { cmd: 'near', label: 'near', title: 'run: near — thoughts near the crosshair' },
          { cmd: 'treenode', label: 'treenode', title: 'run: treenode — the tree view of this cluster' },
          { cmd: 'caregraph graph', label: 'caregraph graph', title: 'run: caregraph graph — the force-graph (link specimen lives there)' },
        ],
      });
    });

    /* ── Task 34: CareSpace ↔ map bridges — thoughts with a place ──
     * Nodes that carry a location render as violet ring markers when the
     * layer is on (`mapnodes`). These three commands close the CLI loop:
     * pin a thought at the map center, fly to a thought, toggle the layer. */

    /* Task 41 — `near [radiusKm]`: the crosshair's neighborhood, as
     * thoughts. Scans EVERY river's located nodes, haversine-distance to
     * the map center, closest first — "what have I thought near here?"
     * without opening each river. Pure CPU (a few dozen sqrt calls on
     * invocation; zero idle cost). Terminal typography: aligned columns,
     * 8-wind bearing, river named when it isn't the current one.
     * Task 42 — `near <node> [km]`: the neighborhood OF a thought
     * (resolved via resolveNodeGlobal — current river first, cross-river
     * and `river/name` qualifiers welcome). The node itself is excluded;
     * every row carries a fly payload so ONE delegated terminal click
     * listener flies the map there (zero React handlers). */
    this.register('near', 'List located thoughts within radius of the crosshair — or of a thought: near [node] [km]', 'near [node] [km]', 'map', (args) => {
      const raw = args.trim();
      /* Crosshair mode: bare number (backward compatible) or nothing. */
      const bareNumber = raw !== '' && !isNaN(parseFloat(raw)) && /^-?\d/.test(raw);
      let anchorLat: number, anchorLng: number;
      let headerWhat: string;
      let excludeId: string | null = null;
      let anchorBullet: string | undefined;
      let radius: number;
      if (raw === '' || bareNumber) {
        const c = MapEngine.getCenter();
        anchorLat = c.lat;
        anchorLng = c.lng;
        radius = clamp(parseFloat(raw) || 5, 0.1, 200);
        headerWhat = 'the crosshair';
      } else {
        /* Node mode: last whitespace-separated numeric token (if any) is
         * the radius; everything before is the node name (quotes are
         * stripped by resolveNodeGlobal). `near "Far Post" 5`. */
        const m = raw.match(/^(.*?)\s+(-?\d+(?:\.\d+)?)$/);
        const nodeName = (m ? m[1] : raw).trim();
        const found = this.resolveNodeGlobal(nodeName);
        if (!found.ok) return; // resolveNodeGlobal already printed the miss
        if (!found.node.location) {
          store().print(`Node "${found.node.label}" has no location yet — 'pinnode ${found.node.label.split(' ')[0]}' pins it at the crosshair`, 'error');
          return;
        }
        anchorLat = found.node.location.lat;
        anchorLng = found.node.location.lng;
        radius = m ? clamp(parseFloat(m[2]), 0.1, 200) : 5;
        headerWhat = `"${truncate(found.node.label, 26)}"`;
        excludeId = found.node.id;
        /* Task 45 — the header wears the anchor's own tint (the SAME color
         * the result rows' ● uses): the neighborhood reads as ONE thought's
         * color story, top to bottom. */
        const anchorTag = found.node.tags.filter((t) => t && t !== 'none')[0];
        anchorBullet = (anchorTag && TAG_COLORS[anchorTag]) || found.net.color;
      }
      const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
      const bearing8 = (dLngDeg: number, lat2: number): string => {
        const toRad = (d: number) => (d * Math.PI) / 180;
        const y = Math.sin(toRad(dLngDeg)) * Math.cos(toRad(lat2));
        const x =
          Math.cos(toRad(anchorLat)) * Math.sin(toRad(lat2)) -
          Math.sin(toRad(anchorLat)) * Math.cos(toRad(lat2)) * Math.cos(toRad(dLngDeg));
        const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
        return dirs[Math.round(deg / 45) % 8];
      };
      const curId = CareSpace.currentNetwork().id;
      const hits: Array<{ d: number; brg: string; label: string; river: string; notes: number; remote: boolean; bullet: string; fly: NonNullable<TermLine['data']>['fly']; nodeId: string }> = [];
      for (const net of CareSpace.networks()) {
        for (const node of Object.values(net.nodes)) {
          if (!node.location) continue;
          if (excludeId && node.id === excludeId && net.id === curId) continue;
          const d = haversineKm(anchorLat, anchorLng, node.location.lat, node.location.lng);
          if (d > radius) continue;
          /* Task 44 — the row's ● wears the thought's first-tag tint — the
           * SAME color its map marker and graph dot wear (provenance in the
           * terminal; `none`/untagged falls back to the river color). */
          const firstTag = node.tags.filter((t) => t && t !== 'none')[0];
          hits.push({
            d,
            brg: bearing8(node.location.lng - anchorLng, node.location.lat),
            label: node.label,
            river: net.name,
            notes: node.notes.length,
            remote: net.id !== curId,
            bullet: (firstTag && TAG_COLORS[firstTag]) || net.color,
            fly: { lat: node.location.lat, lng: node.location.lng, zoom: node.location.zoom || 13, label: node.label },
            nodeId: node.id,
          });
        }
      }
      if (hits.length === 0) {
        const where = headerWhat === 'the crosshair' ? 'of the crosshair' : `of ${headerWhat}`;
        store().print(`No located thoughts within ${radius}km ${where} — 'near 50' widens the net`, 'muted');
        return;
      }
      hits.sort((a, b) => a.d - b.d);
      const latStr = `${Math.abs(anchorLat).toFixed(3)}${anchorLat >= 0 ? 'N' : 'S'}`;
      const lngStr = `${Math.abs(anchorLng).toFixed(3)}${anchorLng >= 0 ? 'E' : 'W'}`;
      const headerText = `near ${headerWhat} · ${latStr} ${lngStr} · r ${radius}km — ${hits.length} thought${hits.length === 1 ? '' : 's'}`;
      /* Task 45 — node-anchored headers carry the anchor's tint via the same
       * data.bullet channel as the rows; crosshair headers stay untinted
       * (the crosshair is a place, not a thought — no color of its own). */
      if (anchorBullet) store().print(headerText, 'header', { bullet: anchorBullet });
      else store().header(headerText);
      /* Task 64 — the reverse reference, map edition: the pins rows name
       * their nearest thought; a near row now names the pin that sits ON
       * the thought (≤50m — co-location, not mere proximity). After `demo`
       * the seeded pin is ON Alpha, and the near list says so: the two
       * lists read each other instead of requiring a second command. */
      const pins = MapEngine.listPins();
      let anyPinned = false;
      for (const h of hits.slice(0, 20)) {
        const dist = h.d < 10 ? `${h.d.toFixed(2)}km` : h.d < 100 ? `${h.d.toFixed(1)}km` : `${Math.round(h.d)}km`;
        const river = h.remote ? ` · ${h.river}` : '';
        /* Task 58 — the counted ▤ rides on the label — the SAME token
         * the map glyph and the pins/views pick-marks speak — replacing
         * the old `· N notes` suffix, so the row speaks ONCE in the
         * shared vocabulary instead of translating for one surface. */
        const mark = h.notes > 0 ? ` ${notesMark(h.notes)}` : '';
        const onPin = pins.find((p) => haversineKm(p.lat, p.lng, h.fly!.lat, h.fly!.lng) <= 0.05);
        if (onPin) anyPinned = true;
        /* Task 93 — the label truncates to the room that's left, so the
         * radar table keeps its shape instead of wrapping mid-distance. */
        const labelRoom = Math.max(8, termCols() - 16 - mark.length - river.length);
        store().print(
          `  ${dist.padStart(7)} ${h.brg.padEnd(2)}  ${truncate(h.label, labelRoom)}${mark}${river}`,
          'output',
          {
            fly: h.fly,
            bullet: h.bullet,
            /* Task 48 — the ⇥ chip rides along: the row's primary verb
             * stays FLY (a near-query is a map question), but the chip
             * opens the thought in the tree without another command.
             * Task 59 — the chip tooltip names the row's mark (▤N/●).
             * Task 72 — the chip wears the row's tint (the SAME tag-
             * color the ● speaks) — the near rows join the every-chip-
             * a-swatch covenant the care/links/pins rows already honor. */
            jumpBadge: { nodeId: h.nodeId, river: h.river, label: h.label, tint: h.bullet, ...(mark.trim() ? { mark: mark.trim() } : {}) },
            /* Task 65 — the ⚑ graduates from text to VERB: the chip
             * re-runs `pins` (the exact list where pin N lives, its ✕
             * chip included) — the Task 53 filter payload with a custom
             * glyph, one verb, no sixth chip class. */
            ...(onPin ? { filter: { cmd: 'pins', label: `⚑${onPin.number}`, title: `⚑ pin ${onPin.number} sits here — show the pins list (✕ there removes it)` } } : {}),
          },
        );
      }
      if (hits.length > 20) store().print(`  … and ${hits.length - 20} more within ${radius}km`, 'muted');
      /* Task 64 — the ⚑N legend speaks only when a row actually wears
       * one (conditional teaching — no legend for a symbol never shown). */
      store().print(`  click a row to fly there · ⇥ chip opens it in the tree · ● = tag tint · ▤N = notes${anyPinned ? ' · ⚑N = pin N sits here (the chip lists it)' : ''}`, 'muted');
    });

    this.register('pinnode', 'Pin a CareSpace node at the map center', 'pinnode <node>', 'map', (args) => {
      if (!args) { store().print('Usage: pinnode <node>', 'error'); return; }
      const node = this.resolveNode(args);
      if (!node) return;
      const c = MapEngine.getCenter();
      const zoom = MapEngine.getZoom();
      /* Snapshot BEFORE the location write — `undo` clears it (undo parity
       * with every other node-mutating surface). */
      const undo: UndoEntry = {
        kind: 'care',
        label: `pinnode ${node.label.slice(0, 18)}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      CareSpace.pinLocation(node.id, c.lat, c.lng, Math.round(zoom));
      useNaksha.getState().setUndo(undo);
      useNaksha.getState().syncCare();
      /* Auto-show the layer so the new marker is immediately visible. */
      if (!useNaksha.getState().settings.showNodesOnMap) {
        useNaksha.getState().setSettings({ showNodesOnMap: true });
        store().print('Node markers enabled (mapnodes off to hide)', 'muted');
      }
      const latStr = `${Math.abs(c.lat).toFixed(3)}${c.lat >= 0 ? 'N' : 'S'}`;
      const lngStr = `${Math.abs(c.lng).toFixed(3)}${c.lng >= 0 ? 'E' : 'W'}`;
      store().print(`Node "${node.label}" pinned @ ${latStr} ${lngStr} — undo available`, 'success');
    });

    /* Task 69 — `nodefrom <pin>`: pinnode's mirror. A search result is a
     * pin on the map; this turns it into a THOUGHT — the POI's name
     * rides in as the node label, the pin's coordinates become the
     * node's location. The search rows carry the `+thought` chip, so
     * POI → CareSpace is one click. Registered under map (it speaks pin
     * nouns) — creating the node, like `node`, is rmnode-revertible, so
     * no undo snapshot of its own (parity with `node`). */
    this.register('nodefrom', 'Create a CareSpace thought from a map pin (search results are pins)', 'nodefrom <pin#> [under <node>]', 'map', (args) => {
      /* Task 70 — `under <node>` aims the plant: the thought grows under
       * the parent you name, not under wherever you're standing — and a
       * cross-river parent works (moveNodeAcross re-homes the fresh
       * node, the same machinery drag-to-reparent trusts). */
      const m = args.match(/^(\S+)(?:\s+under\s+(.+))?$/i);
      if (!m) { store().print('Usage: nodefrom <pin#> [under <node>]', 'error'); return; }
      const num = parseInt(m[1], 10);
      if (!Number.isFinite(num)) {
        store().print('Usage: nodefrom <pin#> [under <node>]  (pins lists the numbers)', 'error');
        return;
      }
      const pin = MapEngine.listPins().find((p) => p.number === num);
      if (!pin) {
        store().print(`No pin #${num} — pins lists the numbers`, 'error');
        return;
      }
      const underName = m[2]?.trim();
      let parentId: string | undefined;
      let parentLabel: string | null = null;
      let parentNetIdx = -1;
      if (underName) {
        const rr = this.resolveNodeGlobal(underName);
        if (!rr.ok) return; // resolveNodeGlobal already printed (not found / ambiguous / bad river)
        parentId = rr.node.id;
        parentLabel = rr.node.label;
        parentNetIdx = CareSpace.data.networks.indexOf(rr.net);
      }
      const label = (pin.label || `Pin ${num}`).trim();
      /* Task 70 — the planted guard: this POI may already BE a thought
       * (findPlantedThought: same name + same coordinates, any river).
       * Twin thoughts from one pin are pollution, not intent — the
       * receipt names the existing thought, the badge jumps to it, and
       * `rmnode <id>` is the way to make room for a fresh plant. */
      const planted = findPlantedThought(label, pin.lat, pin.lng);
      if (planted) {
        store().print(`Pin ${num} is already a thought: "${planted.node.label}" (${planted.node.id}) — nothing planted`, 'error');
        store().print(`  ⇥ open it, or rmnode ${planted.node.id} to make room for a fresh plant`, 'muted', {
          jumpBadge: { nodeId: planted.node.id, river: planted.net.name, label: planted.node.label, tint: planted.tagColor },
        });
        return;
      }
      /* Task 71 — the cross-river dup check: addNode rejects a duplicate
       * label under the target parent, but a CROSS-RIVER parent plants
       * via addNode-then-moveNodeAcross, and the move doesn't dup-check
       * — the twin would surface only later as an ambiguous name.
       * Aim-before-powder: same check addNode would have run, done here
       * BEFORE the node exists. */
      if (parentId && parentNetIdx !== CareSpace.data.currentNetworkIndex) {
        const targetNet = CareSpace.data.networks[parentNetIdx];
        const targetParent = targetNet?.nodes[parentId];
        const dup = targetParent?.children.some((cid) => {
          const c = targetNet.nodes[cid];
          return c && c.label.toLowerCase() === label.toLowerCase();
        });
        if (dup) {
          store().print(`Node "${label}" already exists under "${parentLabel}"`, 'error');
          return;
        }
      }
      /* Cross-river parents: addNode only reaches the current river's
       * nodes, so plant locally (under the current node) then let
       * moveNodeAcross re-home the fresh node — subtree of one, no
       * links to strip, exactly the case it was built for. */
      const r = CareSpace.addNode(label, parentNetIdx === CareSpace.data.currentNetworkIndex ? parentId : undefined);
      if (!r.success) { store().print(r.error!, 'error'); return; }
      const id = r.data!;
      if (parentId && parentNetIdx !== CareSpace.data.currentNetworkIndex) {
        const mv = CareSpace.moveNodeAcross(CareSpace.data.currentNetworkIndex, id, parentNetIdx, parentId);
        if (!mv.success) { store().print(`Planted, but the cross-river move failed: ${mv.error}`, 'error'); return; }
      }
      CareSpace.pinLocation(id, pin.lat, pin.lng, 16,
        /* Task 70 — after a cross-river move the node lives in the TARGET
         * river, and pinLocation is net-scoped: pin it where it landed. */
        parentId && parentNetIdx !== CareSpace.data.currentNetworkIndex ? CareSpace.data.networks[parentNetIdx].id : undefined);
      const parent = CareSpace.getCurrentNode();
      const home = parentLabel ? `"${parentLabel}"` : `"${parent.label}"`;
      const riverNote = parentLabel && parentNetIdx !== CareSpace.data.currentNetworkIndex
        ? ` · river "${CareSpace.data.networks[parentNetIdx].name}"`
        : '';
      store().print(`Thought "${label}" planted from pin ${num} · under ${home}${riverNote} · pinned at (${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)})`, 'success');
      /* Auto-show the layer so the new marker is immediately visible —
       * same reflex pinnode has. */
      if (!useNaksha.getState().settings.showNodesOnMap) {
        useNaksha.getState().setSettings({ showNodesOnMap: true });
        store().print('Node markers enabled (mapnodes off to hide)', 'muted');
      }
      store().syncCare();
    });

    this.register('unpinnode', "Remove a CareSpace node's location", 'unpinnode <node>', 'map', (args) => {
      if (!args) { store().print('Usage: unpinnode <node>', 'error'); return; }
      const node = this.resolveNode(args);
      if (!node) return;
      if (!node.location) {
        store().print(`Node "${node.label}" has no location to remove`, 'error');
        return;
      }
      /* Snapshot BEFORE clearing — `undo` restores the coordinates. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `unpinnode ${node.label.slice(0, 18)}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      CareSpace.unpinLocation(node.id);
      useNaksha.getState().setUndo(undo);
      useNaksha.getState().syncCare();
      store().print(`✕ Node "${node.label}" unpinned — the thought lost its place (undo available)`, 'success');
    });

    this.register('gotonode', 'Fly the map to a CareSpace node', 'gotonode <node>', 'map', (args) => {
      if (!args) { store().print('Usage: gotonode <node>', 'error'); return; }
      const node = this.resolveNode(args);
      if (!node) return;
      if (!node.location) {
        store().print(`Node "${node.label}" has no location yet`, 'error');
        store().print(`Pin one: 'pinnode ${node.label.split(' ')[0]}' at map center, or bridge a workspace shape (⇒ Node / ✚ Care)`, 'muted');
        return;
      }
      /* Task 44 — flyAndPulse: same arrival pulse the terminal's fly rows
       * use (moveend-gated, perf-low skips it). */
      MapEngine.flyAndPulse(node.location.lat, node.location.lng, node.location.zoom || 13);
      const latStr = `${Math.abs(node.location.lat).toFixed(3)}${node.location.lat >= 0 ? 'N' : 'S'}`;
      const lngStr = `${Math.abs(node.location.lng).toFixed(3)}${node.location.lng >= 0 ? 'E' : 'W'}`;
      store().print(`Flying to node "${node.label}" @ ${latStr} ${lngStr}`, 'info');
    });

    this.register('mapnodes', 'Toggle CareSpace node markers on the map', 'mapnodes [on|off]', 'map', (args) => {
      const arg = args.trim().toLowerCase();
      const cur = useNaksha.getState().settings.showNodesOnMap ?? false;
      const next = arg === 'on' ? true : arg === 'off' ? false : !cur;
      useNaksha.getState().setSettings({ showNodesOnMap: next });
      if (next) {
        let count = 0;
        for (const net of CareSpace.networks()) {
          for (const node of Object.values(net.nodes)) if (node.location) count++;
        }
        store().print(`Node markers ON — ${count} located node${count === 1 ? '' : 's'} across all networks`, 'success');
        if (count === 0) store().print('Pin thoughts via pinnode <node> or workspace ⇒ Node / ✚ Care', 'muted');
      } else {
        store().print('Node markers OFF', 'info');
      }
    });

    this.register('layer', 'Change map layer', 'layer [name]', 'map', (args) => {
      if (!args) {
        store().print('Available layers:', 'highlight');
        (Object.keys(MAP_LAYERS) as MapLayerKey[]).forEach((k) => {
          const cur = k === MapEngine.currentLayer ? ' ←' : '';
          /* Task 93 — pad follows the data (max key len), name truncates
           * to the room that's left; the layer list stays a table. */
          const layerPad = Math.min(12, Math.max(...Object.keys(MAP_LAYERS).map((k2) => k2.length)));
          store().print(`  ${k.padEnd(layerPad)} ${fitLabel(MAP_LAYERS[k].name, Math.max(8, termCols() - 4 - layerPad - cur.length))}${cur}`, k === MapEngine.currentLayer ? 'highlight' : 'muted');
        });
        return;
      }
      const r = MapEngine.setLayer(args.toLowerCase() as MapLayerKey);
      if (r.success) {
        const key = args.toLowerCase() as MapLayerKey;
        store().print(`Layer changed to: ${args}`, 'success');
        useNaksha.getState().setMapLayer(key);
        /* Persist the explicit choice — this is also how theme switches
           know the user DIVERGED from the theme's default (Task 33). */
        useNaksha.getState().setSettings({ mapDefaultLayer: key });
      } else {
        store().print(r.error!, 'error');
        store().print(`Available: ${Object.keys(MAP_LAYERS).join(', ')}`, 'muted');
      }
    });

    this.register('zoom', 'Set zoom level', 'zoom <3-19>', 'map', (args) => {
      const z = parseInt(args, 10);
      if (isNaN(z) || z < 3 || z > 19) { store().print('Usage: zoom <3-19>', 'error'); return; }
      MapEngine.setZoom(z);
      store().print(`Zoom set to ${z}`, 'info');
    });

    this.register('wiki', 'Open Wikipedia article', 'wiki <topic>', 'map', async (args) => {
      if (!args) { store().print('Usage: wiki <topic>', 'error'); return; }
      const loading = store().showLoading(`Fetching Wikipedia: ${args}...`);
      const article = await fetchWiki(args);
      loading.stop();
      if (!article) { store().print(`No Wikipedia article for: ${args}`, 'error'); return; }
      store().print(`Wikipedia: ${article.title}`, 'success');
      if (article.description) store().print(article.description, 'muted');
      store().print('');
      store().print(article.extract, 'file-output');
      /* Task 46 — geo-articles carry a fly row: the same delegated
       * terminal listener that powers `near`/`search` flies the map to
       * the article's coordinates (zoom 12: city-scale reading zoom —
       * article coords are place-level, not POI-level). One optional
       * row; concept articles (no coordinates) skip it entirely. */
      if (article.lat != null && article.lon != null) {
        /* Task 49 — place→thought matcher: when a pinned thought sits
         * within 1km of the article's coordinates (or shares its name),
         * the fly row grows the violet ⇥ chip — the article and the
         * thought are about the same place, so the row speaks BOTH
         * verbs: ↗ flies the map, ⇥ opens the thought (+ details). */
        const hit = this.matchThoughtToPlace(article.lat, article.lon, article.title);
        store().print(`  ↗  ${article.title} · ${formatCoord(article.lat, article.lon)}`, 'output', {
          fly: { lat: article.lat, lng: article.lon, zoom: 12, label: article.title },
          ...(hit ? { jumpBadge: { nodeId: hit.nodeId, river: hit.river, label: hit.label } } : {}),
        });
        store().print(
          hit
            ? '  click the ↗ row to fly the map · ⇥ chip opens the matching thought'
            : "  click the ↗ row to fly the map to the article's coordinates",
          'muted',
        );
      }
      /* Task 107 — the body no longer carries the title h2 or the
       * thumbnail: WikiContent renders the `title` and `image` props
       * with their own semantics (h2, alt=title, object-cover), so a
       * second copy inside the HTML printed the title and the photo
       * TWICE ("Kyoto / Kyoto" + stacked images). The body is now the
       * article's words only: description line + extract. */
      const descHtml = article.description
        ? `<p><em>${escapeHtml(article.description)}</em></p>`
        : '';
      useNaksha.getState().openReader({
        kind: 'wiki',
        title: article.title,
        body: `${descHtml}<p>${escapeHtml(article.extract).replace(/\n/g, '<br/>')}</p>`,
        image: article.thumbnail,
        link: article.url,
      });
      store().print('Reader panel opened — press Esc to close', 'muted');
    });

    this.register('open', 'Open a URL in the reader', 'open <url>', 'map', (args) => {
      if (!args) { store().print('Usage: open <url>', 'error'); return; }
      const url = normalizeUrl(args);
      useNaksha.getState().openReader({
        kind: 'web',
        title: url,
        body: '', // the iframe will render it
        link: url,
      });
      store().print(`Opening: ${url}`, 'info');
      store().print('Note: some sites block embedding (X-Frame-Options).', 'muted');
    });

    /* Task 100 — `weather [place]` finally tells the truth: bare means
     * the crosshair (the usage string always read optional, but bare
     * used to print "Usage"). The sibling `elevation` set the contract —
     * no place → the map center speaks — and a coords-based core skips
     * the geocode the bare path never needed. */
    this.register('weather', 'Current weather for a place — or at the crosshair', 'weather [place]', 'map', async (args) => {
      const place = args.trim();
      let wx: WeatherReport | null = null;
      let failed: Extract<Awaited<ReturnType<typeof fetchWeather>>, { ok: false }> | null = null;
      if (place) {
        const loading = store().showLoading(`Fetching weather: ${place}...`);
        const w = await fetchWeather(place);
        loading.stop();
        if (!w.ok) failed = w;
        else wx = w.report;
      } else {
        const c = MapEngine.getCenter();
        const loading = store().showLoading('Fetching weather at crosshair...');
        wx = await fetchWeatherAt(c.lat, c.lng, formatCoord(c.lat, c.lng));
        loading.stop();
      }
      /* Task 109 — the named path now says WHERE it failed. The old bare
       * null conflated "the geocoder never heard of the place" (retype
       * it) with "geocoder answered, forecast API refused" (wait out the
       * quota) — two remedies behind one dishonest line that called a
       * valid place "unknown". The geocode hit also keeps its fly row:
       * even a refused forecast names a real place. The bare crosshair
       * path (coords in hand, never geocoded) keeps its single-cause
       * line. */
      if (failed) {
        if (failed.reason === 'geocode') {
          store().print(`No weather data for: ${failed.query}`, 'error');
          store().print('  (unknown place — the geocoder found nothing by that name)', 'muted');
        } else {
          store().print(`Geocoded "${failed.label}" (${formatCoord(failed.lat, failed.lng)}) — but the forecast API refused`, 'error');
          store().print("  (usually the free tier's daily quota — try again later)", 'muted');
          store().print(`  ↗  ${failed.label} · ${formatCoord(failed.lat, failed.lng)}`, 'output', {
            fly: { lat: failed.lat, lng: failed.lng, zoom: 11, label: failed.label },
          });
        }
        return;
      }
      if (!wx) {
        store().print('No weather data for the crosshair', 'error');
        store().print('  (the free weather API is rate-limited — try again later)', 'muted');
        return;
      }
      store().print(`Weather: ${wx.place}`, 'success');
      store().print(`  ${wx.temperature}°C · ${wx.description}`, 'info');
      /* Task 46 — the forecast place is by definition a place: the
       * geocode hit's coordinates become a fly row (zoom 11 — a city
       * sits comfortably at metro scale). Same shared listener, zero
       * new plumbing. */
      if (wx.lat != null && wx.lon != null) {
        /* Task 49 — the same place→thought matcher wiki rows wear: a
         * thought within 1km of the geocode hit (or named like it) adds
         * the ⇥ chip — the forecast place and the thought are one. The
         * hint line only prints when there IS a chip to explain (the
         * plain fly row needs no lesson it never needed). */
        const hit = this.matchThoughtToPlace(wx.lat, wx.lon, wx.place);
        /* Task 119 — the bare-crosshair path names the report with the
         * formatted coordinate itself (reader.ts label), so the fly row's
         * "place · coords" split printed the same string twice. When the
         * place IS the coords, say it once; named places keep the split. */
        const coordStr = formatCoord(wx.lat, wx.lon);
        store().print(wx.place === coordStr ? `  ↗  ${wx.place}` : `  ↗  ${wx.place} · ${coordStr}`, 'output', {
          fly: { lat: wx.lat, lng: wx.lon, zoom: 11, label: wx.place },
          ...(hit ? { jumpBadge: { nodeId: hit.nodeId, river: hit.river, label: hit.label } } : {}),
        });
        if (hit) store().print('  ⇥ chip opens the matching thought in the tree', 'muted');
      }
      useNaksha.getState().openReader({
        kind: 'weather',
        title: `Weather — ${wx.place}`,
        body: '',
        weather: wx,
      });
    });

    this.register('saveview', 'Save current map view', 'saveview <name>', 'map', (args) => {
      if (!args) { store().print('Usage: saveview <name>', 'error'); return; }
      const r = MapEngine.saveView(args);
      if (r.success) store().print(`View saved: ${args}`, 'success');
      else store().print(r.error!, 'error');
    });

    /* Task 53 — saved views join the dialect: row click APPLIES the view
     * (the exact `view <name>` surface — fly + layer sync), ✕ chip
     * removes it. The last static list in the shell answers a click.
     * Task 56 — views are PLACES too: a saved view is a camera position
     * over real coordinates, so each row asks the same shared question
     * pins ask — the nearest located thought within 5km rides the row
     * as a ⇥ chip. One row now answers three ways: apply it (row),
     * remove it (✕), or read what you thought nearby (⇥).
     * Task 57 — radius parity + relevance: `views [km]` sets the sweep
     * (same parse as pins), and the pick prefers noted/tagged thoughts,
     * marked ▤/● on the row — both lists now speak the SAME rule. */
    this.register('views', 'List saved views (click = apply · ✕ = remove · ⇥ = nearest thought) — views [km] sets the sweep radius', 'views [km]', 'map', (args) => {
      const radiusKm = parseRadiusKm(args);
      const views = MapEngine.listViews();
      if (views.length === 0) { store().print('No saved views', 'muted'); return; }
      store().header(`Saved Views (${views.length})`);
      views.forEach((v) => {
        const near = nearestThought(v.lat, v.lng, radiusKm);
        /* Task 58 — counted mark, pins' dialect (▤N rides the pick).
         * Task 59 — remote picks name their river, chip carries mark. */
        const mark = near ? (near.notes > 0 ? ` ${notesMark(near.notes)}` : near.tagged ? ' ●' : '') : '';
        const riverMark = near && near.remote ? ` · ${near.river}` : '';
        /* Task 93 — views: the name truncates to the room the zoom/layer
         * core and the near-tail leave; the tail's inner truncates keep
         * the flight row to one line. */
        const core = ` z${v.zoom} ${v.layer}`;
        const nearTail = near
          ? ` · near "${truncate(near.label, 12)}" ${near.d < 10 ? near.d.toFixed(1) : Math.round(near.d)}km${mark}${riverMark}`
          : '';
        store().print(`  ${truncate(v.name, Math.max(8, termCols() - 3 - core.length - nearTail.length)).padEnd(Math.min(20, Math.max(...views.map((x) => x.name.length))))}${core}${nearTail}`, 'output', {
          view: { name: v.name },
          kill: { view: v.name },
          ...(near ? { jumpBadge: { nodeId: near.nodeId, river: near.river, label: near.label, tint: near.tagColor, ...(mark.trim() ? { mark: mark.trim() } : {}) } } : {}),
        });
      });
      store().print(`⇥ click a row to apply the view · ✕ removes it · ⇥ chip opens your most relevant thought nearby — notes/tagged first (≤${fmtKm(radiusKm)}km)`, 'muted');
    });

    this.register('view', 'Fly to a saved view', 'view <name>', 'map', (args) => {
      if (!args) { store().print('Usage: view <name>', 'error'); return; }
      const r = MapEngine.flyToView(args);
      if (r.success) {
        store().print(`Flying to view: ${args}`, 'info');
        const st = MapEngine.getState();
        useNaksha.getState().setMapLayer(st.layer);
      } else {
        /* Task 97 — the fourth door. A view-name miss was a raw
         * `No view named "x"` dump; the correction contract now covers
         * it: a near hit gets the one-click chip (the same gesture a
         * verb, node, or theme miss earns), an empty pool gets the
         * honest pointer to the verb that fills it, and only a true
         * stranger keeps the raw dump. */
        const pool = MapEngine.listViews();
        if (pool.length === 0) {
          store().print(`No saved views — save the current camera with 'saveview <name>'`, 'muted');
          return;
        }
        const near = nearestSuggestion(args, pool.map((v) => ({ id: v.name })));
        if (near) {
          store().print(`did you mean '${near}'? — click to run`, 'muted', {
            chips: [{ cmd: `view ${near}`, label: near, title: `run: view ${near} — fly the camera there` }],
          });
        } else {
          store().print(r.error!, 'error');
          store().print(`Saved views: ${pool.map((v) => v.name).join(', ')}`, 'muted');
        }
      }
    });

    this.register('rmview', 'Remove a saved view', 'rmview <name>', 'map', (args) => {
      if (!args) { store().print('Usage: rmview <name>', 'error'); return; }
      /* Task 87 — kill-chip parity for the typed verb (same story as
       * delpin): one surface of a destruction must not be safer than
       * the other. */
      const undo: UndoEntry = {
        kind: 'mapdata',
        label: `rmview ${args}`,
        snapshot: MapEngine.snapshotMapData(),
        ts: Date.now(),
      };
      const r = MapEngine.removeView(args);
      if (r.success) {
        store().setUndo(undo);
        store().print(`Removed view: ${args} — undo available`, 'success');
      } else {
        /* Task 97 — the destructive verb corrects more carefully. A
         * one-click DELETE riding a fuzzy guess is exactly the reflex
         * the snap rule forbids (Task 70): the near hit is NAMED, but
         * the chip it earns is the non-destructive `view <near>` —
         * look at what you'd remove before removing it. The removal
         * itself stays an aimed, typed act (Tab completes the name). */
        const pool = MapEngine.listViews();
        if (pool.length === 0) {
          store().print(`No saved views — nothing to remove`, 'muted');
          return;
        }
        const near = nearestSuggestion(args, pool.map((v) => ({ id: v.name })));
        if (near) {
          store().print(`No view named "${args}" — did you mean '${near}'?`, 'muted', {
            chips: [{ cmd: `view ${near}`, label: '⇥ view it first', title: `run: view ${near} — look before you remove (rmview ${near} removes it)` }],
          });
        } else {
          store().print(r.error!, 'error');
          store().print(`Saved views: ${pool.map((v) => v.name).join(', ')}`, 'muted');
        }
      }
    });

    this.register('back', 'Go to previous view', 'back', 'map', () => {
      const v = useNaksha.getState().backView();
      if (!v) { store().print('No previous view', 'muted'); return; }
      MapEngine.setLayer(v.layer);
      MapEngine.flyToCoords(v.lat, v.lng, v.zoom, 1);
      useNaksha.getState().setMapLayer(v.layer);
      store().print(`Back to: ${v.label}`, 'info');
    });

    this.register('fwd', 'Go to next view', 'fwd', 'map', () => {
      const v = useNaksha.getState().fwdView();
      if (!v) { store().print('No forward view', 'muted'); return; }
      MapEngine.setLayer(v.layer);
      MapEngine.flyToCoords(v.lat, v.lng, v.zoom, 1);
      useNaksha.getState().setMapLayer(v.layer);
      store().print(`Forward to: ${v.label}`, 'info');
    });

    this.register('stream', 'Show view history', 'stream', 'map', () => {
      const { viewHistory, viewIndex } = useNaksha.getState();
      if (viewHistory.length === 0) { store().print('(no history)', 'muted'); return; }
      store().header('View Stream');
      viewHistory.forEach((v, i) => {
        const cur = i === viewIndex ? ' ←' : '';
        store().print(`  ${i === viewIndex ? '>' : ' '} ${v.label}${cur}`, i === viewIndex ? 'highlight' : 'output');
      });
    });

    /* ────────────────── SYSTEM ────────────────── */
    this.register('clear', 'Clear the terminal', 'clear', 'system', () => {
      store().clear();
    });

    this.register('focus', 'Enter workspace (star constellation mode)', 'focus', 'system', () => {
      useNaksha.getState().setFocusActive(true);
      store().print('Workspace activated', 'info');
      store().print('Drag between stars to draw lines · close shapes for notes · Esc to exit', 'muted');
    });

    this.register('workspace', 'Enter workspace (star constellation mode)', 'workspace', 'system', () => {
      useNaksha.getState().setFocusActive(true);
      store().print('Workspace activated', 'info');
      store().print('Drag between stars to draw lines · close shapes for notes · Esc to exit', 'muted');
    });

    /* Short alias — `ws` ≡ `workspace`. */
    this.register('ws', 'Enter workspace (alias of workspace)', 'ws', 'system', () => {
      useNaksha.getState().setFocusActive(true);
      store().print('Workspace activated', 'info');
      store().print('Drag between stars to draw lines · close shapes for notes · Esc to exit', 'muted');
    });

    /* Task 52 — `shapes [node]`: the constellation INVENTORY. Task 51
     * persisted the shape→node binding; this command reads it back into
     * the terminal, grouped by owning thought. Owner rows wear the full
     * jump dialect (⇥ open · ↗ fly to pin · ● tag tint — the same color
     * story as find/whereis), sketch rows wear their own fill color as
     * the bullet (the sidebar legend color, now legible in text). The
     * workspace snapshot is the source of truth — read, never mutated. */
    this.register('shapes', 'List constellations per thought', 'shapes [node]', 'system', (args) => {
      const snap = Storage.get<{ lines: unknown[]; shapes: Array<{ starIds: number[]; note: string; color: string; id: string; nodeId?: string }> } | null>(STORAGE_KEYS.workspace, null);
      const shapes = snap?.shapes ?? [];
      if (shapes.length === 0) {
        store().print('No constellations yet — close a polygon of lines in the workspace (`ws`)', 'muted');
        return;
      }
      /* Owner resolution across ALL rivers (a sketch may be bound to a
       * node in a dormant network — whereis's rule). */
      const ownerOf = (nodeId?: string): { node: CareNode; net: CareNetwork } | null => {
        if (!nodeId) return null;
        for (const net of CareSpace.networks()) {
          const node = net.nodes[nodeId];
          if (node) return { node, net };
        }
        return null;
      };
      let list = shapes;
      if (args) {
        const target = this.resolveNode(args); // Task 70 — did-you-mean
        if (!target) return;
        list = shapes.filter((s) => s.nodeId === target.id);
        if (list.length === 0) { store().print(`No constellations bound to "${target.label}"`, 'muted'); return; }
      }
      const boundCount = list.filter((s) => ownerOf(s.nodeId)).length;
      store().header(`Constellations (${list.length} shape${list.length === 1 ? '' : 's'} · ${boundCount} bound)`);
      const printedOwners = new Set<string>();
      list.forEach((s, i) => {
        const owner = ownerOf(s.nodeId);
        const outline = s.color.replace('0.12', '0.8');
        if (owner) {
          const { node, net } = owner;
          if (!printedOwners.has(node.id)) {
            printedOwners.add(node.id);
            const owned = list.filter((x) => x.nodeId === node.id);
            const ft = node.tags.filter((t) => t && t !== 'none')[0];
            const loc = node.location;
            /* Task 53 — the owner row now speaks THREE verbs + a chip:
             * text = ⇥ tree landing, ↗ = fly to pin, and the boxed count
             * chip re-runs `shapes <node>` — the filter form of this very
             * command, so the inventory drills down without retyping. */
            store().print(`${node.label} — ${owned.length} sketch${owned.length === 1 ? '' : 'es'}${net.id !== CareSpace.currentNetwork().id ? ` · ${net.name}` : ''}`, 'highlight', {
              jump: { nodeId: node.id, river: net.name },
              ...(loc ? { flyBadge: { lat: loc.lat, lng: loc.lng, zoom: loc.zoom || 13, label: node.label } } : {}),
              filter: { cmd: `shapes "${node.label}"` },
              bullet: (ft && TAG_COLORS[ft]) || net.color,
            });
          }
          /* Task 93 — the note truncates to the room that's left, so
           * the sketch index keeps its `NN · note · Npts` shape. */
          const notePart = s.note ? `"${truncate(s.note, Math.max(10, termCols() - 16))}"` : '(no note)';
          store().print(`  ${String(i + 1).padStart(2, '0')} · ${notePart} · ${s.starIds.length}pts`, 'output', { bullet: outline });
        } else {
          const notePart = s.note ? `"${truncate(s.note, Math.max(10, termCols() - 16))}"` : '(no note)';
          store().print(`  ${String(i + 1).padStart(2, '0')} · ${notePart} · ${s.starIds.length}pts · unbound`, 'muted', { bullet: outline });
        }
      });
      store().print('⇥ click a thought to open it · ↗ flies to its pin · count chip filters · sketch ● = fill color', 'muted');
    });

    this.register('about', 'About Naksha', 'about', 'system', () => {
      store().header('Naksha — Geographic Shell');
      store().print('');
      store().print('A terminal-based workspace for maps, files, and thoughts.', 'muted');
      store().print('');
      store().print('  · Virtual Unix file system (persistent, with cp/mv/grep)', 'muted');
      store().print('  · Interactive map with routing, geocoding, wiki, weather', 'muted');
      store().print('  · CareSpace — 3-network hierarchical thought tree', 'muted');
      store().print('  · Workspace — star-constellation capture & sketching', 'muted');
      store().print('  · View history (back / fwd / stream)', 'muted');
      store().print('');
      store().print('Version: 4.0.0  ·  Trillium-inspired tree map', 'muted');
      store().print('Storage:  Browser localStorage (internal) · optionally a read-only real-directory vault (see: context, vault)', 'muted');
    });

    this.register('settings', 'View or change settings (perf · storage context · direction · uiLang)', 'settings [key] [value]', 'system', (args) => {
      const parts = args.split(/\s+/).filter(Boolean);
      const s = useNaksha.getState().settings;
      if (parts.length === 0) {
        store().header('Settings');
        /* Task 93 — settings reflows with the other sheets: the
         * annotations ride the value, the aligned label column keeps
         * the sheet a sheet, and narrow panes stack the long values. */
        sheetRows(
          [
            ['themeId', `${s.themeId}  (use 'theme' to change)`],
            ['terminalFont', String(s.terminalFont)],
            ['mapDefaultLayer', String(s.mapDefaultLayer)],
            ['caresolution', String(s.caresolution)],
            ['mapsplit', String(s.mapsplit)],
            ['particlesEnabled', String(s.particlesEnabled)],
            ['showNodesOnMap', `${s.showNodesOnMap ?? false}  (use 'mapnodes' to toggle)`],
            /* Task 105 — the tier's provenance rides the value: chosen vs
             * auto-detected (hardware / reduced-motion) is the first
             * question when a CPU-only user asks "why is my glass dull?".
             * Pre-105 profiles render unlabeled — honest unknown. */
            ['perfMode', `${s.perfMode}${s.perfProvenance ? ` · ${s.perfProvenance}` : ''}  (use 'settings perf low|stable60|high')`],
            /* Phase 3 — the storage world lives beside the render tier:
             * both are persisted choices validated against reality. */
            ['storageContext', `${s.storageContext ?? 'internal (default)'}  (use 'context internal|connected')`],
            /* Phase 8 — the direction context rides the sheet: mode AND
             * what it currently resolves to, so 'auto' is never a guess. */
            ['direction', `${describeDirection(s.direction, sampleAppContent())}  (use 'settings direction auto|ltr|rtl')`],
            ['uiLang', `${s.uiLang ?? 'en'}  (use 'settings lang en|fa')`],
          ],
          { padFixed: 16, rightTone: 'output' },
        );
        return;
      }
      const [key, ...valParts] = parts;
      const value = valParts.join(' ');
      const partial: Partial<NakshaSettings> = {};
      if (key === 'theme' || key === 'themeId') {
        // Validate against available themes
        const valid = THEMES.find((t) => t.id === value);
        if (!valid) {
          store().print(`Unknown theme: ${value}`, 'error');
          store().print(`Available: ${THEMES.map((t) => t.id).join(', ')}`, 'muted');
          return;
        }
        partial.themeId = value;
      }
      else if (key === 'terminalFont' || key === 'font') partial.terminalFont = value as NakshaSettings['terminalFont'];
      else if (key === 'mapDefaultLayer' || key === 'map.default') partial.mapDefaultLayer = value as MapLayerKey;
      else if (key === 'caresolution') partial.caresolution = clamp(parseInt(value, 10) || 38, 25, 70);
      else if (key === 'mapsplit') partial.mapsplit = clamp(parseInt(value, 10) || 50, 25, 75);
      else if (key === 'particlesEnabled' || key === 'particles') partial.particlesEnabled = value === 'true' || value === 'on' || value === '1';
      else if (key === 'perfMode' || key === 'perf') {
        /* Phase 1 — three tiers now: low < stable60 < high. normalizePerfMode
         * accepts the natural aliases people type at a terminal (stable, 60,
         * balanced). The document attribute + scheduler reset ride the shared
         * perf-tier helper, so the panel cards and this command can never
         * drift apart. */
        const mode = value ? normalizePerfMode(value) : null;
        if (mode) {
          partial.perfMode = mode;
          /* Task 105 — an explicit choice outranks any auto-detection
           * label; the receipt should never show 'auto-*' for a tier
           * the user set by hand. */
          partial.perfProvenance = 'chosen';
          applyPerfDocumentAttr(mode);
          if (mode === 'low') {
            store().print('Performance mode: LOW — animations disabled, blur reduced', 'info');
          } else if (mode === 'stable60') {
            store().print('Performance mode: STABLE_60 — locked 60 FPS (frame limiter on, blur off, full-rate interaction)', 'info');
            store().print('  diagnostics: perfpanel · live meter: perf on', 'muted');
          } else {
            store().print('Performance mode: HIGH — full effects enabled', 'info');
          }
        } else if (value) {
          store().print(`Unknown perf tier: ${value} — use low | stable60 | high`, 'error');
          return;
        }
      }
      else if (key === 'storageContext' || key === 'ctx') {
        /* Phase 3 — same door as the `context` command (one applier, so
         * validation + receipts cannot drift). Rejected choices print
         * their own error and leave settings untouched. */
        if (!value) {
          store().print('Usage: settings storageContext internal|connected', 'error');
          return;
        }
        /* The applier prints its own success or error receipt. */
        applyStorageContextChoice(value);
        return;
      }
      else if (key === 'direction' || key === 'dir') {
        /* Phase 8 — the direction context: 'auto' follows the first
         * strong RTL character in the app's own writing; explicit
         * ltr/rtl pin it. One applier (setSettings → applyDirection)
         * so the command and any future panel cannot drift. */
        const mode = value === 'auto' || value === 'ltr' || value === 'rtl' ? value : null;
        if (!mode) {
          store().print('Usage: settings direction auto|ltr|rtl', 'error');
          return;
        }
        partial.direction = mode;
      }
      else if (key === 'lang' || key === 'uiLang') {
        /* Phase 8 — i18n-lite: Persian chrome labels. Orthogonal to
         * direction by design; the receipt says so instead of coupling. */
        if (value === 'fa' || value === 'fa-IR' || value === 'persian') {
          partial.uiLang = 'fa';
        } else if (value === 'en' || value === 'english') {
          partial.uiLang = 'en';
        } else {
          store().print('Usage: settings lang en|fa', 'error');
          return;
        }
      }
      else { store().print(`Unknown setting: ${key}`, 'error'); return; }
      useNaksha.getState().setSettings(partial);
      /* Live-switch the basemap when changed via settings (the MapPane
         mount effect only covers reloads). */
      if (partial.mapDefaultLayer) {
        MapEngine.setLayer(partial.mapDefaultLayer);
        useNaksha.getState().setMapLayer(partial.mapDefaultLayer);
      }
      store().print(`Setting ${key} = ${value}`, 'success');
    });

    /* Phase 8 — the direction context, spoken. Bare = the audit sheet
     * (mode, what auto currently resolves to, the per-surface rules);
     * with a mode = the same door as `settings direction`. The terminal
     * input row stays LTR by design — only OUTPUT rows carry dir=auto,
     * so Persian results render readably without breaking command
     * syntax. */
    this.register('direction', 'View or set text direction (auto-detects Persian/Arabic/Hebrew content)', 'direction [auto|ltr|rtl]', 'system', (args) => {
      const s = useNaksha.getState().settings;
      const mode = args.trim().toLowerCase();
      if (!mode) {
        store().header('Direction');
        sheetRows(
          [
            ['mode', `${s.direction ?? 'auto'}  (use 'direction auto|ltr|rtl')`],
            ['effective', describeDirection(s.direction, sampleAppContent())],
            ['detects', 'Persian · Arabic · Hebrew (strong-character majority over first lines)'],
            ['sample', 'your CareSpace labels + notes'],
            ['reader', 'per note — each file keeps its own base direction'],
            ['terminal', 'input stays LTR · output rows dir=auto'],
            ['chrome', 'root <html dir> — panels mirror via logical CSS'],
          ],
          { padFixed: 12, rightTone: 'output' },
        );
        return;
      }
      if (mode !== 'auto' && mode !== 'ltr' && mode !== 'rtl') {
        store().print('Usage: direction auto|ltr|rtl', 'error');
        return;
      }
      useNaksha.getState().setSettings({ direction: mode });
      store().print(`Direction: ${describeDirection(mode, sampleAppContent())}`, 'success');
      if (mode === 'rtl') {
        store().print('  chrome mirrored · reader notes detect per file · terminal output dir=auto', 'muted');
      }
    });

    /* Phase 8 — i18n-lite switch. Labels only (status bar, vault panel,
     * perf panel); command names, syntax and receipts stay English. */
    this.register('lang', 'Switch UI label language (en | fa — Persian chrome labels)', 'lang [en|fa]', 'system', (args) => {
      const s = useNaksha.getState().settings;
      const l = args.trim().toLowerCase();
      if (!l) {
        store().header('UI language');
        sheetRows(
          [
            ['uiLang', `${s.uiLang ?? 'en'}  (use 'lang en|fa')`],
            ['scope', 'status bar · vault panel · perf panel labels'],
            ['untouched', 'terminal commands, syntax, receipts (English by design)'],
          ],
          { padFixed: 10, rightTone: 'output' },
        );
        return;
      }
      if (l !== 'en' && l !== 'fa') {
        store().print('Usage: lang en|fa', 'error');
        return;
      }
      useNaksha.getState().setSettings({ uiLang: l });
      store().print(`UI labels: ${l === 'fa' ? 'فارسی (Persian)' : 'English'}`, 'success');
      if (l === 'fa') {
        store().print("  labels are Persian now — direction is separate: 'settings direction rtl' mirrors the chrome", 'muted');
      }
    });

    this.register('theme', 'Switch color theme', 'theme [name]', 'system', (args) => {
      if (!args) {
        const current = useNaksha.getState().settings.themeId;
        store().header(`Themes (current: ${current})`);
        THEMES.forEach((t) => {
          const cur = t.id === current ? ' ←' : '';
          /* Task 93 — three columns when the pane holds them; otherwise
           * the description drops to its own indented line (prose — it
           * may wrap, that's honest). */
          const themePad = Math.min(18, Math.max(...THEMES.map((t2) => t2.id.length)));
          if (2 + themePad + 1 + t.name.length + 1 + t.description.length + cur.length <= termCols()) {
            store().print(`  ${t.id.padEnd(themePad)} ${t.name.padEnd(16)} ${t.description}${cur}`, t.id === current ? 'highlight' : 'output');
          } else {
            store().print(`  ${t.id.padEnd(themePad)} ${t.name}${cur}`, t.id === current ? 'highlight' : 'output');
            store().print(`    ${t.description}`, 'muted');
          }
        });
        store().print('');
        store().print(`Use 'theme <id>' to switch.`, 'muted');
        return;
      }
      const valid = THEMES.find((t) => t.id === args || t.name.toLowerCase() === args.toLowerCase());
      if (!valid) {
        /* Task 96 — the suggester idiom reaches the theme slot. Eight of
         * nine theme ids carry a hyphen, so the natural miss IS the
         * dropped hyphen ('warmlight'); a near-miss gets the one-click
         * correction chip, the same contract a verb miss has had since
         * Task 94. Only a true stranger keeps the raw dump.
         * Task 97 — the search rides the shared engine; the theme's alt
         * spelling (display name) is a candidate field now, not a
         * hand-rolled second distance. */
        const near = nearestSuggestion(args, THEMES.map((t) => ({ id: t.id, alt: t.name })));
        if (near) {
          const theme = THEMES.find((t) => t.id === near)!;
          store().print(`did you mean '${near}'? — click to run`, 'muted', {
            chips: [{ cmd: `theme ${near}`, label: near, title: `run: theme ${near} — ${theme.description}` }],
          });
        } else {
          store().print(`Unknown theme: ${args}`, 'error');
          store().print(`Available: ${THEMES.map((t) => t.id).join(', ')}`, 'muted');
        }
        return;
      }
      useNaksha.getState().setSettings({ themeId: valid.id });
      store().print(`Theme: ${valid.name} — ${valid.description}`, 'success');
    });

    this.register('themes', 'List all available themes (or open visual picker)', 'themes [open]', 'system', (args) => {
      // `themes open` or `themes picker` opens the visual theme picker.
      if (args === 'open' || args === 'picker' || args === 'ui') {
        useNaksha.getState().setThemePickerOpen(true);
        store().print('Theme picker opened — click a swatch to apply', 'info');
        return;
      }
      const current = useNaksha.getState().settings.themeId;
      store().header(`Available Themes (${THEMES.length})`);
      THEMES.forEach((t) => {
        const cur = t.id === current ? ' ←' : '';
        const themePad = Math.min(18, Math.max(...THEMES.map((t2) => t2.id.length)));
        store().print(`  ${t.id.padEnd(themePad)} ${t.name}${cur}`, t.id === current ? 'highlight' : 'output');
        store().print(`    ${t.description}`, 'muted');
      });
      store().print('');
      store().print(`Tip: 'themes open' for the visual swatch picker.`, 'muted');
    });

    this.register('themepicker', 'Open the visual theme picker', 'themepicker', 'system', () => {
      useNaksha.getState().setThemePickerOpen(true);
      store().print('Theme picker opened — click a swatch to apply', 'info');
    });

    this.register('statsview', 'Open the visual statistics panel', 'statsview', 'care', () => {
      useNaksha.getState().setStatsOpen(true);
      store().print('Statistics panel opened — press Esc to close', 'info');
    });

    this.register('perfpanel', 'Open the performance-tier panel (visual LOW / STABLE_60 / HIGH switch + live frame diagnostics)', 'perfpanel', 'system', () => {
      useNaksha.getState().setPerfPanelOpen(true);
      store().print('Performance panel opened — click a tier card to switch', 'info');
    });

    /* Task 74 — the frame-rate instrument. Five review rounds queued
     * "real-hardware perf verification" and five rounds the dev environment
     * honestly reported: can't feel smoothness from here. So the app
     * carries its own meter — leave it open on the machine in question,
     * work normally, read fps / worst / jank. The receipt teaches the
     * reading (steady ≈refresh, worst <50ms, jank 0 = comfortable). */
    this.register('perf', 'Toggle the frame-rate HUD (fps · worst frame · jank) — the real-hardware smoothness instrument', 'perf [on|off]', 'system', (args) => {
      const s = useNaksha.getState();
      const arg = args.trim().toLowerCase();
      const next = arg === 'on' ? true : arg === 'off' ? false : !s.perfHudOpen;
      s.setPerfHudOpen(next);
      if (next) {
        const pm = s.settings.perfMode ?? 'high';
        store().print('⏱ frame meter on (bottom-right) — it keeps frames flowing while open; that IS the measurement', 'info');
        store().print('  load the app: pan the map, drag graph nodes, switch panes — steady fps + worst <50ms + jank 0 = this machine is comfortable', 'muted');
        store().print(`  tier: ${pm} · perfpanel switches tiers (stable60 = locked 60fps) · perf off hides the meter`, 'muted');
      } else {
        store().print('⏱ frame meter off', 'muted');
      }
    });

    this.register('copycoords', 'Copy current map center coordinates', 'copycoords', 'map', () => {
      const c = MapEngine.getCenter();
      const z = MapEngine.getZoom();
      const coordStr = `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)} (z${z})`;
      // Use the clipboard API if available, otherwise print for manual copy.
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(coordStr).then(
          () => store().print(`Copied: ${coordStr}`, 'success'),
          () => store().print(`Copy failed. Coords: ${coordStr}`, 'warning'),
        );
      } else {
        store().print(`Coords: ${coordStr}`, 'info');
        store().print('(clipboard API unavailable — copy manually)', 'muted');
      }
    });

    this.register('elevation', 'Get elevation at current map center', 'elevation [place]', 'map', async (args) => {
      let lat: number;
      let lng: number;
      let placeLabel = 'current center';
      if (args) {
        const loading = store().showLoading(`Finding ${args}...`);
        try {
          const g = await MapEngine.geocode(args);
          loading.stop();
          if (!g) { store().print(`Cannot find: ${args}`, 'error'); return; }
          lat = g.lat; lng = g.lng; placeLabel = g.displayName.split(',')[0];
        } catch {
          loading.stop('Geocoding failed', 'error');
          return;
        }
      } else {
        const c = MapEngine.getCenter();
        lat = c.lat; lng = c.lng;
      }
      const loading2 = store().showLoading('Fetching elevation...');
      try {
        const res = await fetch(ELEVATION_API.elevation(lat, lng));
        if (!res.ok) throw new Error(`Elevation API error: ${res.status}`);
        const data = (await res.json()) as { elevation?: number[] };
        const elev = data.elevation?.[0];
        loading2.stop();
        if (elev == null) {
          store().print('No elevation data for this location', 'warning');
          return;
        }
        const elevStr = elev > 0 ? `${elev.toFixed(1)} m` : 'sea level';
        store().print(`Elevation at ${placeLabel}: ${elevStr}`, 'success');
        store().print(`  Coordinates: ${lat.toFixed(4)}, ${lng.toFixed(4)}`, 'muted');
      } catch (err) {
        loading2.stop('Elevation service unavailable', 'error');
      }
    });

    this.register('storage', 'Show storage usage', 'storage', 'system', () => {
      const usage = (() => {
        const keys = Object.values(STORAGE_KEYS);
        const out: Record<string, number> = {};
        let total = 0;
        for (const k of keys) {
          let size = 0;
          try { const raw = localStorage.getItem(k); size = raw ? new Blob([raw]).size : 0; } catch { size = 0; }
          out[k] = size; total += size;
        }
        out.total = total;
        return out;
      })();
      store().header('Storage Usage');
      Object.entries(usage).forEach(([k, v]) => {
        if (k === 'total') store().print(`  ${'TOTAL'.padEnd(20)} ${formatSize(v)}`, 'highlight');
        else store().print(`  ${k.padEnd(20)} ${formatSize(v)}`, 'output');
      });
      store().print('  (browser localStorage, ~5MB limit)', 'muted');
      /* Phase 3 — the usage sheet names the ACTIVE world too: these
       * numbers are always the internal FS; a connected vault's real
       * files never live in this budget (they stay on your disk). */
      const ctx = resolveStorageContext(
        useNaksha.getState().settings.storageContext,
        useNaksha.getState().vaultStatus,
      );
      store().print(`  active context: ${contextChipLabel(ctx)} · ${contextRoutingLine(ctx)}`, 'muted');
    });

    this.register('alias', 'Create or list aliases', 'alias [name=cmd]', 'system', (args) => {
      const aliases = useNaksha.getState().aliases;
      if (!args) {
        const entries = Object.entries(aliases);
        if (entries.length === 0) { store().print('(no aliases)', 'muted'); return; }
        store().header('Aliases');
        entries.forEach(([k, v]) => store().print(`  ${k} = ${v}`, 'output'));
        return;
      }
      const m = args.match(/^(\S+)\s*=\s*(.+)$/);
      if (!m) { store().print('Usage: alias <name>=<command>', 'error'); return; }
      useNaksha.getState().setAlias(m[1], m[2]);
      store().print(`Alias set: ${m[1]} = ${m[2]}`, 'success');
    });

    this.register('unalias', 'Remove an alias', 'unalias <name>', 'system', (args) => {
      if (!args) { store().print('Usage: unalias <name>', 'error'); return; }
      if (!useNaksha.getState().aliases[args]) { store().print(`No such alias: ${args}`, 'error'); return; }
      useNaksha.getState().removeAlias(args);
      store().print(`Alias removed: ${args}`, 'success');
    });

    this.register('undo', 'Undo destructive action(s) (fs · node/idea · rmnode/caremove · link/unlink/relabel · tag/untag · save/delnote · pinat/order · carein/caremerge · delpin/rmview/clearpins · rmmeasure)', 'undo [steps]', 'system', (args) => {
      /* Task 88 — the WALK: the stack's head restores, the rest waits.
       * Peek first, drop last — a thrown restore never loses the
       * entry (the slot-era setUndo(null) is gone; nothing is ever
       * discarded by undoing). */
      /* Task 115 — `undo <n>` walks n steps in ONE invocation. Each
       * step is the exact single-step primitive (park the present →
       * restore → drop the head), so the redo line stays walkable in
       * both directions and a mid-walk throw leaves the ledger exactly
       * as a single-step throw would. The chip and the depth hint ride
       * the LAST step only — a walk is one gesture, not n receipts
       * shouting; an early stack floor is named, not swallowed. */
      const raw = args.trim();
      if (raw && !/^\d+$/.test(raw)) { store().print('Usage: undo [steps]', 'error'); return; }
      const want = raw ? parseInt(raw, 10) : 1;
      if (want < 1) { store().print('Usage: undo [steps]', 'error'); return; }
      let done = 0;
      for (let i = 0; i < want; i++) {
        const undo = useNaksha.getState().undoStack[0];
        if (!undo) break;
        const s = useNaksha.getState();
        /* Task 81 — park the present before restoring the past: the state
         * this restore overwrites becomes the redo head, so ⇧⌘Z (or
         * `redo`) can walk the SAME line forward again. The truncation
         * rule stays in the store — undoing never kills it. */
        s.pushRedo({ kind: undo.kind, label: undo.label, snapshot: currentForKind(undo.kind), ts: Date.now() });
        restoreSnapshot(undo);
        s.dropUndoHead();
        done++;
        const isFinal = i === want - 1;
        if (done === 1 && !isFinal) {
          store().print(`Undone: ${undo.label}`, 'success');
        } else {
          const rest = useNaksha.getState().undoStack.length;
          store().print(`Undone: ${undo.label}`, 'success', {
            /* Task 82 — the chip's title names the very action it would
             * re-apply, not a generic promise. */
            chips: [{ cmd: 'redo', label: '⇧⌘Z redo', title: `run: redo — re-applies "${undo.label}"`, kbd: true }],
          });
          /* Task 88 — the walk teaches itself: depth remains → ⌘Z goes
           * again. The count is the story the slot could never tell. */
          if (rest > 0) {
            store().print(`  ${rest} step${rest === 1 ? '' : 's'} further back — ⌘Z walks on`, 'muted');
          }
        }
      }
      if (done === 0) { store().print('Nothing to undo', 'muted'); return; }
      if (done < want) store().print(`  stack floor — walked ${done} of ${want} requested`, 'muted');
    });

    this.register('redo', 'Re-apply the last undone action(s)', 'redo [steps]', 'system', (args) => {
      /* Task 115 — the forward mirror of `undo [steps]`: same walk
       * discipline, one gesture for n steps, chip + depth hint on the
       * last step only, an early future floor named. */
      const raw = args.trim();
      if (raw && !/^\d+$/.test(raw)) { store().print('Usage: redo [steps]', 'error'); return; }
      const want = raw ? parseInt(raw, 10) : 1;
      if (want < 1) { store().print('Usage: redo [steps]', 'error'); return; }
      let done = 0;
      for (let i = 0; i < want; i++) {
        const s = useNaksha.getState();
        const entry = s.consumeRedo();
        if (!entry) break;
        /* The undone present parks back into the slot — ⌘Z takes it
         * again. keepRedo: the rest of the future survives (an undo→redo
         * walk is ONE line, not a truncation). */
        s.setUndo({ kind: entry.kind, label: entry.label, snapshot: currentForKind(entry.kind), ts: Date.now() }, { keepRedo: true });
        restoreSnapshot(entry);
        done++;
        const isFinal = i === want - 1;
        if (done === 1 && !isFinal) {
          store().print(`Redone: ${entry.label}`, 'success');
        } else {
          const rest = useNaksha.getState().redoStack.length;
          store().print(`Redone: ${entry.label}`, 'success', {
            /* Task 82 — the mirror chip names its action the same way. */
            chips: [{ cmd: 'undo', label: '⌘Z undo', title: `run: undo — takes "${entry.label}" back`, kbd: true }],
          });
          /* Task 88 — the forward walk teaches itself the same way. */
          if (rest > 0) {
            store().print(`  ${rest} step${rest === 1 ? '' : 's'} further forward — ⇧⌘Z walks on`, 'muted');
          }
        }
      }
      if (done === 0) { store().print('Nothing to redo', 'muted'); return; }
      if (done < want) store().print(`  redo floor — walked ${done} of ${want} requested`, 'muted');
    });

    this.register('vslice', 'Resize terminal/carespace split', 'vslice <25-70>', 'system', (args) => {
      const n = parseInt(args, 10);
      if (isNaN(n) || n < 25 || n > 70) { store().print('Usage: vslice <25-70>', 'error'); return; }
      useNaksha.getState().setSettings({ caresolution: n });
      store().print(`Terminal width set to ${n}%`, 'success');
    });

    this.register('split', 'Resize map/(terminal+care) split', 'split <25-75>', 'system', (args) => {
      const n = parseInt(args, 10);
      if (isNaN(n) || n < 25 || n > 75) { store().print('Usage: split <25-75>', 'error'); return; }
      useNaksha.getState().setSettings({ mapsplit: n });
      store().print(`Map width set to ${n}%`, 'success');
    });

    /* Task 84 — the history state at a glance: what ⌘Z and ⇧⌘Z will do
     * RIGHT NOW, without consuming anything. The receipts teach the
     * moment a change happens; `hist` is the come-back-later instrument
     * — slot label and age, redo head and depth, each wearing its door
     * as a clickable chip (zero new CSS, the CPU rule holds). */
    this.register('hist', 'Peek the undo/redo history state, or one side at a depth (n past · r n future)', 'hist [depth|r]', 'system', (args) => {
      const s = useNaksha.getState();
      const age = (ts: number): string => {
        const m = Math.floor((Date.now() - ts) / 60000);
        if (m < 1) return 'now';
        if (m < 60) return `${m}m`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h`;
        return `${Math.floor(h / 24)}d`;
      };
      /* Task 116 — `hist <n>` is the walk's aiming scope: the ledger at
       * depth n, rows 1..n each wearing its age, the TARGET row marked
       * and bright while the rows above stay muted past. Peek-only, the
       * sheet's own covenant; a depth past the floor is clamped and
       * NAMED (the honest floor line), never silently cut. The bare
       * sheet below stays byte-identical — this branch returns early. */
      /* Task 117 — the future side rides the SAME dialect: `hist r<n>`
       * aims into the redo stack, rows r1..rn (the direction lives in
       * the TOKEN, not in a sign — `>` points along the walk's own
       * direction either way), footer says `redo k walks here`. Task
       * 116's design question answered by construction: the mark
       * survives because it never needed a sign to begin with. */
      const raw = args.trim();
      if (raw) {
        const futureSide = /^r\d+$/i.test(raw);
        if (!futureSide && !/^\d+$/.test(raw)) { store().print('Usage: hist [depth|r]', 'error'); return; }
        const want = parseInt(futureSide ? raw.slice(1) : raw, 10);
        if (want < 1) { store().print('Usage: hist [depth|r]', 'error'); return; }
        const ledger = futureSide ? s.redoStack : s.undoStack;
        if (ledger.length === 0) {
          store().print(futureSide ? 'Nothing to peek — the redo future is empty' : 'Nothing to peek — the ledger is empty', 'muted');
          return;
        }
        const k = Math.min(want, ledger.length);
        const numW = String(k).length + (futureSide ? 1 : 0);
        store().header('History Peek');
        for (let i = 0; i < k; i++) {
          const e = ledger[i];
          const target = i === k - 1;
          const mark = target ? '> ' : '  ';
          const num = ((futureSide ? 'r' : '') + String(i + 1)).padStart(numW);
          const meta = ` · ${age(e.ts)}`;
          const room = Math.max(8, termCols() - 2 - numW - 2 - meta.length - 2);
          store().print(`${mark}${num}  ${truncate(e.label, room)}${meta}`, target ? 'output' : 'muted');
        }
        if (want > ledger.length) {
          store().print(`  ${futureSide ? 'future' : 'ledger'} floor — ${ledger.length} deep, ${want} requested`, 'muted');
        }
        store().print(`  (peek only — ${futureSide ? 'redo' : 'undo'} ${k} walks here; nothing consumed)`, 'muted');
        return;
      }
      store().header('History State');
      /* Task 88 — the slot became a stack: the head is what ⌘Z does
       * NOW, the depth is how far the walk reaches. */
      const stack = s.undoStack;
      /* Task 93 — the ledger fits its pane: ages drop the "old" suffix
       * ("5m" reads the same in a ledger), the chips shrink to ⌘Z /
       * ⇧⌘Z (the glyph IS the verb; the title carries the words), and
       * the row itself reflows — a wide pane keeps the two-column
       * `undo stack  head · age · N deep [⌘Z]`; a narrow pane stacks
       * the head UNDER the slot label (chip riding the detail line)
       * instead of wrapping mid-metric. The head truncates to the
       * stacked line's budget — the roomier of the two. */
      const ledgerRow = (slot: string, headLabel: string, agePart: string, depthPart: string, chipCmd: string, chipLabel: string, chipTitle: string): void => {
        const chipW = chipLabel.length + 3; /* pill padding/border/gap */
        /* The label is the identity; the age is metadata. When the full
         * meta can't leave the label 10+ chars, the AGE yields (the
         * depth stays — it's the covenant the sheet speaks). */
        const depthMeta = depthPart ? ` · ${depthPart}` : '';
        let meta = agePart ? ` · ${agePart}${depthMeta}` : depthMeta;
        let room = Math.max(6, termCols() - 7 - chipW - meta.length);
        if (agePart && room < 10) {
          meta = depthMeta;
          room = Math.max(6, termCols() - 7 - chipW - meta.length);
        }
        const head = `${truncate(headLabel, room)}${meta}`;
        const chip = [{ cmd: chipCmd, label: chipLabel, title: chipTitle, kbd: true }];
        if (2 + 12 + 1 + head.length + 1 + chipW <= termCols()) {
          store().print(`  ${slot.padEnd(12)}${head}`, 'output', { chips: chip });
        } else {
          store().print(`  ${slot}`, 'output');
          store().print(`      ${head}`, 'output', { chips: chip });
        }
      };
      if (stack.length > 0) {
        ledgerRow(
          'undo stack',
          stack[0].label,
          stack.length > 0 ? age(stack[0].ts) : '',
          stack.length > 1 ? `${stack.length} deep` : '',
          'undo',
          '⌘Z',
          `run: undo — restores the "${stack[0].label}" snapshot`,
        );
      } else {
        store().print(`  ${'undo stack'.padEnd(12)}(empty)`, 'output');
      }
      if (stack.length > 1) {
        /* Task 93 — one peek label + the count: two quoted labels
         * could not share 35 columns with the count, and the head's
         * next step matters more than the one after it. */
        const rest = stack.length - 2;
        const tail = rest > 0 ? ` — ${rest} earlier step${rest === 1 ? '' : 's'}` : '';
        store().print(`  then: "${truncate(stack[1].label, Math.max(5, termCols() - 10 - tail.length))}"${tail}`, 'muted');
      }
      const future = s.redoStack;
      if (future.length > 0) {
        ledgerRow(
          'redo future',
          future[0].label,
          '',
          `${future.length} deep`,
          'redo',
          '⇧⌘Z',
          `run: redo — re-applies "${future[0].label}"`,
        );
      } else {
        store().print(`  ${'redo future'.padEnd(12)}(empty)`, 'output');
      }
      /* Task 89 — the redo side speaks the same shape as the undo side:
         when the walk reaches past the head, name the next two labels.
         "later" (redo walks forward in time) mirrors undo's "earlier".
         Same information, same shape — the ledger reads the same in
         both directions. */
      if (future.length > 1) {
        const rest = future.length - 2;
        const tail = rest > 0 ? ` — ${rest} later step${rest === 1 ? '' : 's'}` : '';
        store().print(`  then: "${truncate(future[1].label, Math.max(5, termCols() - 10 - tail.length))}"${tail}`, 'muted');
      }
      /* Task 93 — the disclaimer breaks where 35 columns can hold it:
       * two short lines, the break placed by the author, not by the
       * wrapper (a lone "future)" on a continuation line is not
       * typography). Task 118 — the covenant now names the future's
       * door: the r-dialect (Task 117) was invisible from this sheet —
       * an operator staring at "redo future · 1 deep" had no way to
       * learn `hist r1` exists. Third author-broken line, same 35-col
       * floor, the walk verb the peek footer already speaks. */
      store().print('  (peek only — nothing consumed;', 'muted');
      store().print('   new actions forfeit the redo;', 'muted');
      store().print('   hist r1 walks the future)', 'muted');
    });

    this.register('history', 'Show command history', 'history', 'system', () => {
      const h = useNaksha.getState().history;
      if (h.length === 0) { store().print('(empty history)', 'muted'); return; }
      store().header(`Command History (${h.length})`);
      h.forEach((cmd, i) => store().print(`  ${(i + 1).toString().padStart(3)}. ${cmd}`, 'output'));
    });
    /* Task 101 — help joins the registry so the PALETTE can surface it:
     * the terminal's `help`/`?` stay special-cased in dispatch (the fast
     * path above), but Ctrl+K listed only registry verbs — the single
     * most discoverable verb of all was invisible exactly where a new
     * user looks first. Same engine both doors; the registry entry is
     * the listing, the dispatch case stays the terminal's shortcut. */
    this.register('help', 'Show the command index (help <verb> for one)', 'help [verb]', 'system', (args) => {
      this.showHelp(args);
    });

    this.register('shortcuts', 'Show keyboard shortcuts', 'shortcuts', 'system', () => {
      useNaksha.getState().setShortcutsOpen(true);
      store().print('Shortcuts overlay opened — press Esc to close', 'info');
    });

    this.register('palette', 'Open command palette', 'palette', 'system', () => {
      useNaksha.getState().setPaletteOpen(true);
    });

    this.register('cheatsheet', 'Print a quick-start cheatsheet', 'cheatsheet', 'system', () => {
      store().header('Naksha Cheatsheet');
      store().print('');
      store().highlight('  File System');
      store().print('    ls                 list files — ⇥ rows open · ▤ chip = reader panel', 'output');
      store().print('    tree <path>        hierarchy — same ⇥ rows, indented', 'output');
      store().print('    cd <path>          change directory', 'output');
      store().print('    nano <file>        edit file (real nano when connected)', 'output');
      store().print('    cat -r <file>      read markdown in the reader panel (plain cat = raw)', 'output');
      store().print('    cp/mv/grep         copy/move/search', 'output');
      store().print('    export / import    backup & restore', 'output');
      store().print('');
      store().highlight('  CareSpace (3 networks max)');
      store().print('    idea <name>       create a network', 'output');
      store().print('    use <name>         switch network', 'output');
      store().print('    node <label>       create child node', 'output');
      store().print('    caremove <n> to <p>  reparent node (subtree)', 'output');
      store().print('    save <text> to <n> save a note', 'output');
      store().print('    notes [n]          view notes — ✕ click a row to delete it', 'output');
      store().print('    shapes [node]      constellations per thought (⇥ open · ↗ fly · count = filter)', 'output');
      store().print('    find <text>        search notes — click a path to open ⇥', 'output');
      store().print('    whereis <n>        locate a node in every network (⇥ open · ↗ fly)', 'output');
      store().print('    tags [color]       tag inventory across rivers — wearer chips open stats', 'output');
      store().print('    pinat / fly        pin & fly to locations', 'output');
      store().print('    caregraph          note-map view — rt-click located → fly', 'output');
      store().print('    treenode           tree — ⇥ opens a thought · ↗ flies to its pin', 'output');
      store().print('');
      store().highlight('  Map');
      store().print('    goto <place>       fly to location', 'output');
      store().print('    route <a> to <b>   calculate route', 'output');
      store().print('    wiki <topic>       Wikipedia reader (⇥ chip opens a matching thought)', 'output');
      store().print('    weather <place>   current weather (⇥ chip when a thought matches)', 'output');
      store().print('    search <x> near <p>  find POIs', 'output');
      store().print('    near [node] [km]   thoughts near a place (click rows to fly)', 'output');
      store().print('    pins               pin list — click a row = fly · ✕ removes', 'output');
      store().print('    views / view       saved views — click = apply · ✕ removes', 'output');
      store().print('    back / fwd / stream  view history', 'output');
      store().print('');
      store().highlight('  System');
      store().print('    Ctrl+K             command palette', 'output');
      store().print('    ?                  keyboard shortcuts', 'output');
      store().print('    workspace          star-constellation mode (⇥ a thought, then ws: its sketches flash)', 'output');
      store().print('    direction [m]      text direction — auto|ltr|rtl (RTL scripts auto-detected)', 'output');
      store().print('    lang [en|fa]       chrome label language (Persian labels via fa)', 'output');
      store().print('    settings / storage / about', 'output');
      store().print('');
      store().print('  provenance chain: sketch → tag → marker → ghost → magnet', 'muted');
      store().print('  (one color story end to end — near rows wear the tag tint ●)', 'muted');
    });

    /* ────────────────── QUICK CAPTURE ────────────────── */
    this.register('note', 'Quick-capture a note (later: snap to <node>)', 'note <text>', 'focus', (args) => {
      if (!args) { store().print('Usage: note <text>', 'error'); return; }
      useNaksha.getState().addFocusNote(args);
      store().print(`✓ captured`, 'success');
    });

    this.register('snap', 'Snap focus notes to a node', 'snap to [node]', 'focus', (args) => {
      const s = useNaksha.getState();
      if (s.focusNotes.length === 0) { store().print('No notes to snap', 'muted'); return; }
      let target: CareNode | null = null;
      let targetNet: CareNetwork | null = null;
      const nodeName = args.startsWith('to ') ? args.slice(3).trim() : args;
      if (nodeName) {
        /* Task 40 — cross-river resolution (same cascade as rennode):
           a unique match in a dormant river receives the notes THERE,
           and the receipt says so. Auto-CREATE stays a current-river
           act and only fires on a clean not-found — an ambiguous miss
           printed its candidates and waits for a river/name qualifier. */
        const found = this.resolveNodeGlobal(nodeName);
        if (found.ok) {
          target = found.node;
          targetNet = found.net;
        } else if (found.reason === 'not-found') {
          const cr = CareSpace.addNode(nodeName);
          if (cr.success) {
            target = CareSpace.getNode(cr.data!);
            targetNet = CareSpace.currentNetwork();
          }
        }
      } else {
        target = CareSpace.getCurrentNode();
        targetNet = CareSpace.currentNetwork();
      }
      if (!target || !targetNet) { store().print('Target node not found', 'error'); return; }
      /* webDevReview — snap × vault integration (Phase 5's one-source-of-
         truth rule, which the focus-capture path never learned): a BOUND
         thought's text lives in its real file, so snapping into a bound
         node must append through the gated write API — exactly like
         `save` does. The old path pushed the note into the internal
         array even for bound nodes: the note never reached the disk and
         was invisible in every bound view (`notes` reads the FILE for
         bound thoughts). Unbound targets keep the internal, undoable
         path below — nothing changes when no vault is in play. */
      if (target.vaultPath) {
        const gate = careGate();
        if (!gate.ok) {
          store().print(`"${target.label}" is bound to ${target.vaultPath}, but: ${gate.error}`, 'error');
          store().print('  notes NOT written — they stay in the capture buffer', 'muted');
          return;
        }
        const pending = s.focusNotes.filter((n) => !n.snapped);
        if (pending.length === 0) { store().print('No notes to snap', 'muted'); return; }
        const rel = target.vaultPath;
        const loading = store().showLoading(`[vault:${gate.name}] appending to ${rel}…`);
        void (async () => {
          const cur = await careVaultReadNote(rel);
          if (!cur.ok || typeof cur.content !== 'string') {
            loading.stop(`snap: cannot read ${rel} — ${cur.error ?? 'read failed'} (nothing written)`, 'error');
            void useNaksha.getState().refreshCareBoundState();
            return;
          }
          let content = cur.content;
          for (const n of pending) content = appendNoteLine(content, n.text, n.timeString || formatTime());
          const w = await careVaultWriteNote(rel, content);
          if (!w.ok) {
            loading.stop(`snap: append to ${rel} failed — ${w.error} (notes stay in the buffer)`, 'error');
            return;
          }
          useNaksha.setState({
            focusNotes: useNaksha.getState().focusNotes.map((n) => ({ ...n, snapped: true })),
          });
          loading.stop(`Snapped ${pending.length} note(s) to "${target.label}" → [vault:${gate.name}] ${rel}`, 'success');
          store().print('  the file is the source of truth · file writes are NOT undoable', 'muted');
          useNaksha.getState().bumpVaultRevision();
        })();
        return;
      }
      /* Task 40 — the snap now carries an undo snapshot like every other
         care mutation (notes used to land undo-less). */
      const undo: UndoEntry = {
        kind: 'care',
        label: `snap ${target.label.slice(0, 18)}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      let count = 0;
      s.focusNotes.forEach((n) => {
        if (!n.snapped) { CareSpace.addNote(target!.id, n.text, targetNet!.id); count++; }
      });
      // Mark all as snapped
      useNaksha.setState({
        focusNotes: useNaksha.getState().focusNotes.map((n) => ({ ...n, snapped: true })),
      });
      const riverSuffix = targetNet.id !== CareSpace.currentNetwork().id ? ` · river "${targetNet.name}"` : '';
      store().print(`Snapped ${count} note(s) to "${target.label}"${riverSuffix} — undo available`, 'success');
      store().setUndo(undo);
      store().syncCare();
    });

    this.register('timer', 'Start a focus timer', 'timer <minutes>', 'focus', (args) => {
      const n = parseInt(args, 10);
      if (isNaN(n) || n <= 0) { store().print('Usage: timer <minutes>', 'error'); return; }
      const end = Date.now() + n * 60_000;
      useNaksha.getState().setFocusTimerEnd(end);
      store().print(`Timer started: ${n} minutes`, 'success');
    });

    this.register('list', 'Refresh focus mode display', 'list', 'focus', () => {
      store().print(`Focus notes: ${useNaksha.getState().focusNotes.length}`, 'info');
    });

    this.register('done', 'Exit focus mode', 'done', 'focus', () => {
      const s = useNaksha.getState();
      const notes = s.focusNotes;
      const unsnapped = notes.filter((n) => !n.snapped).length;
      s.setFocusActive(false);
      store().print('═', 'muted');
      store().header('Focus Session Summary');
      store().print(`  Notes captured: ${notes.length}`, 'output');
      store().print(`  Snapped:        ${notes.length - unsnapped}`, 'output');
      if (unsnapped > 0) store().print(`  Unsaved:       ${unsnapped}  (lost)`, 'warning');
      store().print(`  Exited focus mode`, 'info');
    });

    this.register('exit', 'Exit focus mode', 'exit', 'focus', () => {
      useNaksha.getState().setFocusActive(false);
      store().print('Exited focus mode', 'info');
    });
  }
}

/* Task 81 — grab the CURRENT state for a snapshot kind: the redo twin
 * parks it before an undo-restore overwrites it, and a redo-restore
 * parks it back before overwriting it again. Same shapes the restore
 * paths consume (fs tree · care document · mapdata pins+views). */
function currentForKind(kind: UndoEntry['kind']): unknown {
  if (kind === 'fs') return JSON.parse(JSON.stringify(FileSystem.root));
  if (kind === 'mapdata') {
    return {
      pins: MapEngine.markers.map((m) => ({ number: m.number, label: m.label, lat: m.lat, lng: m.lng })),
      views: [...MapEngine.savedViews.values()],
      /* Task 87 — the redo twin carries the same measurements field the
       * forward snapshot does; a rmmeasure undo→redo walk must not
       * drop the measurement mid-line. */
      measurements: Array.from(MapEngine.savedMeasurements.values()),
    };
  }
  return JSON.parse(JSON.stringify(CareSpace.data)); // care | network
}

/* Task 81 — the restore tail both directions share (was inlined in the
 * undo verb; redo speaks the identical contract). Syncs follow the
 * kind, exactly as the verb always did. */
function restoreSnapshot(u: UndoEntry): void {
  const s = useNaksha.getState();
  if (u.kind === 'fs') {
    FileSystem.replace(JSON.parse(JSON.stringify(u.snapshot)));
    s.syncFs();
  } else if (u.kind === 'care' || u.kind === 'network') {
    CareSpace.data = JSON.parse(JSON.stringify(u.snapshot));
    CareSpace.save();
    s.syncCare();
  } else if (u.kind === 'mapdata') {
    /* Task 54 — the kill chip's undo parity: pins + saved views
     * restore wholesale (markers re-created at their original
     * numbers, views map rebuilt). */
    MapEngine.replaceMapData(u.snapshot as Parameters<typeof MapEngine.replaceMapData>[0]);
  }
}

export const CommandRunner = new CommandRunnerImpl();
