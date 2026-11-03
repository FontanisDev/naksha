/**
 * Naksha — CareSpace Engine
 *
 * A hierarchical thought-management system inspired by Trillium Next's
 * tree map: each network is an independent rooted tree; nodes carry
 * notes, optional geographic pins, color tags, and custom (non-
 * hierarchical) links.
 *
 * Core philosophy (the "three-river rule"):
 *   Maximum 3 separate idea networks, each cored differently and
 *   fully separated. No fourth river is needed.
 *
 * Layout (Trillium-Next-style):
 *   The visual renderer lays each network out as a vertical column of
 *   indented nodes (file-tree style), with a dashed vertical separator
 *   between networks. The "core" of each network sits at the top of
 *   its column.
 *
 * All operations are pure mutations on `this.data`. Callers must
 * `save()` afterwards (we save automatically on every mutation here
 * for safety — the cost is tiny).
 */

import type {
  CareNetwork,
  CareNode,
  CareNote,
  CareOpResult,
  CareSpaceData,
  NodeTag,
} from './types';
import { STORAGE_KEYS, NETWORK_COLORS, MAX_NETWORKS, DEFAULT_NETWORK_NAME } from './constants';
import { Storage } from './storage';
import { generateId, formatTime } from './utils';

function makeRootNode(name: string): CareNode {
  const now = Date.now();
  return {
    id: 'root',
    label: name,
    parentId: null,
    children: [],
    notes: [],
    location: null,
    tags: [],
    collapsed: false,
    links: [],
    linkLabels: {},
    createdAt: now,
    updatedAt: now,
  };
}

function makeNetwork(name: string, color: string, index: number): CareNetwork {
  // Each network has its own root id so they never collide.
  const rootId = index === 0 ? 'root' : `root_${index}`;
  const root = makeRootNode(name);
  root.id = rootId;
  return {
    id: `net_${index + 1}`,
    name,
    color,
    currentId: rootId,
    nodes: { [rootId]: root },
  };
}

function createDefaultData(): CareSpaceData {
  return {
    networks: [makeNetwork(DEFAULT_NETWORK_NAME, NETWORK_COLORS[0], 0)],
    currentNetworkIndex: 0,
    revision: 0,
  };
}

function isCareSpaceData(value: unknown): value is CareSpaceData {
  if (!value || typeof value !== 'object') return false;
  const v = value as CareSpaceData;
  if (!Array.isArray(v.networks)) return false;
  if (v.networks.length === 0) return false;
  if (typeof v.currentNetworkIndex !== 'number') return false;
  for (const net of v.networks) {
    if (!net || typeof net !== 'object') return false;
    if (typeof net.id !== 'string' || typeof net.name !== 'string') return false;
    if (typeof net.color !== 'string') return false;
    if (typeof net.currentId !== 'string') return false;
    if (!net.nodes || typeof net.nodes !== 'object') return false;
    // The network must CONTAIN a root node (any node with parentId === null).
    // NOTE: this is deliberately NOT `nodes[currentId]` — currentId points at
    // wherever the user last navigated (often a child). Requiring it to be the
    // root made every reload after navigating deeper fail validation, which
    // silently WIPED all CareSpace data back to defaults (data-loss bug).
    const hasRoot = Object.values(net.nodes).some((n) => n && n.parentId === null);
    if (!hasRoot) return false;
    // currentId must point at an existing node (may be any depth).
    if (!net.nodes[net.currentId]) return false;
  }
  return true;
}

/** Migrate legacy (single-network) CareSpace data into the new shape. */
function migrateLegacy(raw: unknown): CareSpaceData {
  // The legacy shape had { rootId, currentId, nodes }.
  const legacy = raw as {
    rootId?: string;
    currentId?: string;
    nodes?: Record<string, CareNode>;
  };
  if (legacy && legacy.nodes && (legacy.rootId || legacy.currentId)) {
    const rootId = legacy.rootId || legacy.currentId || 'root';
    const nodes = legacy.nodes as Record<string, CareNode>;
    // Ensure all nodes have the new optional fields.
    for (const id of Object.keys(nodes)) {
      const n = nodes[id];
      if (!n.tags) n.tags = [];
      if (typeof n.collapsed !== 'boolean') n.collapsed = false;
      if (!Array.isArray(n.links)) n.links = [];
    }
    const net: CareNetwork = {
      id: 'net_1',
      name: DEFAULT_NETWORK_NAME,
      color: NETWORK_COLORS[0],
      currentId: legacy.currentId || rootId,
      nodes,
    };
    return {
      networks: [net],
      currentNetworkIndex: 0,
      revision: 0,
    };
  }
  return createDefaultData();
}

/* ── Debounced persistence plumbing (module-level). HMR re-evaluations
   reset these like everything else — safe: a stale timer is cleared by
   the next save(), and the flush listeners re-arm on demand. ── */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function careSaveSchedule(): void {
  if (typeof window === 'undefined') return; // SSR — nothing to persist
  if (saveTimer === null) {
    armSaveFlushListeners();
  }
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    CareSpace.saveNow();
  }, 400);
}

let saveFlushArmed = false;
function armSaveFlushListeners(): void {
  if (saveFlushArmed || typeof window === 'undefined') return;
  saveFlushArmed = true;
  const flush = () => {
    if (saveTimer !== null) CareSpace.saveNow();
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

export const CareSpace = {
  /* Task 118 — same disease as the fs singleton, same cure: dev HMR
   * re-evaluates this module and its module-level `data` resets to a
   * fresh default (statistically identical to the archive baseline —
   * a reset that HIDES itself). The state now sits behind a
   * self-healing getter: a cold instance loads localStorage on first
   * read, wherever that read comes from. The setter marks warmth —
   * undo/redo assign whole snapshots (commands.ts, force-graph), and
   * that assignment must declare the state authoritative rather than
   * let the next read heal OVER it. */
  _data: createDefaultData(),
  _ready: false,

  get data(): CareSpaceData {
    if (!this._ready) this.init();
    return this._data;
  },
  set data(v: CareSpaceData) {
    this._data = v;
    this._ready = true;
  },

  init(): void {
    if (this._ready) return; // idempotent — the getter re-enters safely
    this._ready = true; // armed FIRST: internal reads below never re-enter
    const stored = Storage.get<unknown>(STORAGE_KEYS.carespace, null);
    if (stored) {
      if (isCareSpaceData(stored)) {
        this.data = stored;
      } else {
        this.data = migrateLegacy(stored);
        this.save();
      }
    } else {
      this.data = createDefaultData();
      this.save();
    }
  },

  save(): void {
    /* Perf — persistence discipline (round 2). save() used to
     * JSON.stringify the ENTIRE tree synchronously on EVERY mutation —
     * including selection-only changes (net.currentId = …) — so a burst
     * of N interactions cost N full-tree serializations + N synchronous
     * localStorage writes on the main thread. Now: a trailing 400ms
     * debounce coalesces each burst into ONE write, flushed on pagehide
     * / visibilitychange so closing the tab never loses the tail.
     * In-memory reads always see fresh state (this.data is untouched);
     * only the persisted copy lags by ≤400ms. */
    this.data.revision = (this.data.revision || 0) + 1;
    careSaveSchedule();
  },

  /** Synchronous persistence — for the rare path that must hit storage
   *  immediately (there are none today; kept as the documented escape
   *  hatch so future callers don't silently re-introduce sync writes). */
  saveNow(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    Storage.set(STORAGE_KEYS.carespace, this.data);
  },

  /** Get the currently-active network. */
  currentNetwork(): CareNetwork {
    return this.data.networks[this.data.currentNetworkIndex] ?? this.data.networks[0];
  },

  /** Get a node by id (within the current network). */
  getNode(id: string): CareNode | null {
    return this.currentNetwork().nodes[id] ?? null;
  },

  /** Get the "current" (focused) node in the current network. */
  getCurrentNode(): CareNode {
    const net = this.currentNetwork();
    return net.nodes[net.currentId] ?? net.nodes[Object.keys(net.nodes)[0]];
  },

  /** All networks (read-only list). */
  networks(): CareNetwork[] {
    return this.data.networks;
  },

  /* ════════════════════════════════════════════════════════════════
     Network management — the 3-river rule
     ════════════════════════════════════════════════════════════════ */

  createNetwork(name: string): CareOpResult<CareNetwork> {
    if (!name || !name.trim()) return { success: false, error: 'Network name cannot be empty' };
    if (this.data.networks.length >= MAX_NETWORKS) {
      return {
        success: false,
        error:
          'Three networks is the limit — this is the law of focus. No fourth river is needed.',
      };
    }
    if (this.data.networks.some((n) => n.name.toLowerCase() === name.toLowerCase())) {
      return { success: false, error: `Network "${name}" already exists` };
    }
    const idx = this.data.networks.length;
    const net = makeNetwork(name.trim(), NETWORK_COLORS[idx % NETWORK_COLORS.length], idx);
    this.data.networks.push(net);
    this.data.currentNetworkIndex = idx;
    this.save();
    return { success: true, data: net };
  },

  switchNetwork(name: string): CareOpResult<CareNetwork> {
    const idx = this.data.networks.findIndex(
      (n) => n.name.toLowerCase() === name.toLowerCase(),
    );
    if (idx === -1) return { success: false, error: `No network named "${name}"` };
    this.data.currentNetworkIndex = idx;
    this.save();
    return { success: true, data: this.data.networks[idx] };
  },

  /**
   * Rename a network in place (the `rennet` command). Case-insensitive
   * lookup for the old name (like every other network command), rejects
   * empty names and collisions. Callers snapshot first — this mutates
   * `data` and saves.
   */
  renameNetwork(oldName: string, newName: string): CareOpResult<CareNetwork> {
    const clean = newName.trim();
    if (!clean) return { success: false, error: 'Network name cannot be empty' };
    const idx = this.data.networks.findIndex(
      (n) => n.name.toLowerCase() === oldName.trim().toLowerCase(),
    );
    if (idx === -1) return { success: false, error: `No network named "${oldName}"` };
    if (this.data.networks.some((n, i) => i !== idx && n.name.toLowerCase() === clean.toLowerCase())) {
      return { success: false, error: `Network "${clean}" already exists` };
    }
    const net = this.data.networks[idx];
    net.name = clean;
    this.save();
    return { success: true, data: net };
  },

  dropNetwork(name: string): CareOpResult {
    const idx = this.data.networks.findIndex(
      (n) => n.name.toLowerCase() === name.toLowerCase(),
    );
    if (idx === -1) return { success: false, error: `No network named "${name}"` };
    if (this.data.networks.length <= 1) {
      return { success: false, error: 'Cannot drop the last network' };
    }
    this.data.networks.splice(idx, 1);
    this.data.currentNetworkIndex = Math.min(this.data.currentNetworkIndex, this.data.networks.length - 1);
    this.save();
    return { success: true };
  },

  listNetworks(): Array<{ name: string; color: string; nodes: number; notes: number; current: boolean; mapLayer?: string }> {
    return this.data.networks.map((n, i) => ({
      name: n.name,
      color: n.color,
      nodes: Object.keys(n.nodes).length,
      notes: Object.values(n.nodes).reduce((sum, node) => sum + node.notes.length, 0),
      current: i === this.data.currentNetworkIndex,
      mapLayer: n.mapLayer,
    }));
  },

  /** Reset everything (the `allout` command). */
  resetAll(): void {
    this.data = createDefaultData();
    this.save();
  },

  /* ════════════════════════════════════════════════════════════════
     Node operations
     ════════════════════════════════════════════════════════════════ */

  addNode(label: string, parentId?: string): CareOpResult<string> {
    const net = this.currentNetwork();
    const parent = this.getNode(parentId ?? net.currentId);
    if (!parent) return { success: false, error: 'Parent node not found' };
    if (!label || !label.trim()) return { success: false, error: 'Node label cannot be empty' };
    const trimmed = label.trim();
    const dup = parent.children.find((cid) => {
      const c = net.nodes[cid];
      return c && c.label.toLowerCase() === trimmed.toLowerCase();
    });
    if (dup) return { success: false, error: `Node "${trimmed}" already exists` };
    const id = generateId('node');
    const now = Date.now();
    const node: CareNode = {
      id,
      label: trimmed,
      parentId: parent.id,
      children: [],
      notes: [],
      location: null,
      tags: [],
      collapsed: false,
      links: [],
      createdAt: now,
      updatedAt: now,
    };
    net.nodes[id] = node;
    parent.children.push(id);
    parent.updatedAt = now;
    this.save();
    return { success: true, data: id };
  },

  removeNode(nodeId: string): CareOpResult<{ removedCount: number }> {
    const net = this.currentNetwork();
    if (nodeId === net.currentId && net.currentId === 'root') {
      return { success: false, error: 'Cannot remove root node' };
    }
    // Allow removing root of a network? No — root is the core. Use `drop` instead.
    const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null);
    if (nodeId === rootId) return { success: false, error: 'Cannot remove the core — drop the network instead' };

    const node = net.nodes[nodeId];
    if (!node) return { success: false, error: 'Node not found' };

    const descendants: string[] = [];
    const collect = (id: string) => {
      const n = net.nodes[id];
      if (!n) return;
      descendants.push(id);
      n.children.forEach(collect);
    };
    collect(nodeId);

    const parent = net.nodes[node.parentId!];
    if (parent) {
      parent.children = parent.children.filter((id) => id !== nodeId);
      parent.updatedAt = Date.now();
    }
    descendants.forEach((id) => delete net.nodes[id]);
    if (descendants.includes(net.currentId)) net.currentId = rootId!;
    this.save();
    return { success: true, data: { removedCount: descendants.length } };
  },

  /**
   * Duplicate a node (with its whole subtree) under the same parent — the
   * `dupnode` command. The copy's label gets a " (copy)" suffix; every node
   * gets a fresh id; custom links that point INSIDE the subtree are remapped
   * to the clones, links pointing OUTSIDE are dropped (they'd tie the copy
   * to the original's context). No location on the copy: two pins at the
   * same coordinates would lie about the map. Callers snapshot first —
   * this mutates `data` and saves.
   */
  duplicateNode(nodeId: string): CareOpResult<string> {
    const net = this.currentNetwork();
    const src = net.nodes[nodeId];
    if (!src) return { success: false, error: 'Node not found' };
    if (src.parentId === null) {
      return { success: false, error: 'Cannot duplicate the core — drop/duplicate the network instead' };
    }
    const parent = net.nodes[src.parentId];
    if (!parent) return { success: false, error: 'Parent node not found' };

    /* Collect the source subtree, then clone it bottom-up with fresh ids. */
    const subtreeIds: string[] = [];
    const collect = (id: string) => {
      const n = net.nodes[id];
      if (!n) return;
      subtreeIds.push(id);
      n.children.forEach(collect);
    };
    collect(nodeId);
    const inSubtree = new Set(subtreeIds);
    const idMap = new Map<string, string>();
    for (const oldId of subtreeIds) idMap.set(oldId, generateId('node'));

    const now = Date.now();
    for (const oldId of subtreeIds) {
      const from = net.nodes[oldId];
      const isRootCopy = oldId === nodeId;
      const copy: CareNode = {
        ...JSON.parse(JSON.stringify(from)),
        id: idMap.get(oldId)!,
        label: isRootCopy ? `${from.label} (copy)` : from.label,
        parentId: isRootCopy ? parent.id : idMap.get(from.parentId!)!,
        children: from.children.filter((c) => inSubtree.has(c)).map((c) => idMap.get(c)!),
        /* Remap internal links; drop links leaving the subtree. */
        links: from.links.filter((l) => inSubtree.has(l)).map((l) => idMap.get(l)!),
        linkLabels: from.linkLabels
          ? Object.fromEntries(
              Object.entries(from.linkLabels)
                .filter(([k]) => inSubtree.has(k))
                .map(([k, v]) => [idMap.get(k)!, v]),
            )
          : undefined,
        location: null,
        notes: JSON.parse(JSON.stringify(from.notes)),
        createdAt: now,
        updatedAt: now,
      };
      net.nodes[copy.id] = copy;
    }
    parent.children.push(idMap.get(nodeId)!);
    parent.updatedAt = now;
    this.save();
    return { success: true, data: idMap.get(nodeId)! };
  },

  moveNode(nodeId: string, newParentId: string): CareOpResult {
    return this.moveNodeAcross(this.data.currentNetworkIndex, nodeId, this.data.currentNetworkIndex, newParentId);
  },

  /**
   * Move a node (with its entire subtree) under a new parent — possibly in a
   * DIFFERENT network. Powers the graph-view drag-to-reparent and `caremove`.
   * Same-network moves keep the old descendant guard; cross-network moves
   * re-register every subtree node in the target network, strip dangling
   * custom links that would cross network boundaries, and fix up currentId.
   */
  moveNodeAcross(fromNetIndex: number, nodeId: string, toNetIndex: number, newParentId: string): CareOpResult {
    const fromNet = this.data.networks[fromNetIndex];
    const toNet = this.data.networks[toNetIndex];
    if (!fromNet || !toNet) return { success: false, error: 'Network not found' };
    const fromRootId = Object.keys(fromNet.nodes).find((id) => fromNet.nodes[id].parentId === null);
    if (nodeId === fromRootId) return { success: false, error: 'Cannot move the core' };
    const node = fromNet.nodes[nodeId];
    const newParent = toNet.nodes[newParentId];
    if (!node || !newParent) return { success: false, error: 'Node or parent not found' };
    if (nodeId === newParentId) return { success: false, error: 'Cannot move a node under itself' };

    // Descendant guard — walk the new parent's ancestry. In the same network
    // this catches "into own subtree"; across networks it trivially passes.
    if (fromNetIndex === toNetIndex) {
      let cur: CareNode | null = newParent;
      while (cur) {
        if (cur.id === nodeId) return { success: false, error: 'Cannot move node to its own descendant' };
        cur = cur.parentId ? fromNet.nodes[cur.parentId] : null;
      }
    }

    // Collect the subtree ids BEFORE touching anything.
    const subtreeIds: string[] = [];
    const collect = (id: string) => {
      const n = fromNet.nodes[id];
      if (!n) return;
      subtreeIds.push(id);
      n.children.forEach(collect);
    };
    collect(nodeId);

    // Detach from the old parent.
    const oldParent = node.parentId ? fromNet.nodes[node.parentId] : null;
    if (oldParent) oldParent.children = oldParent.children.filter((id) => id !== nodeId);

    // Attach under the new parent.
    newParent.children.push(nodeId);
    node.parentId = newParentId;
    node.updatedAt = Date.now();

    /* Cross-network moves: re-register the whole subtree in the target
     * network. (Same-network moves share the nodes map — running this would
     * `delete` every moved node out of the ONLY network and erase them.) */
    if (fromNet !== toNet) {
      for (const id of subtreeIds) {
        toNet.nodes[id] = fromNet.nodes[id];
        delete fromNet.nodes[id];
      }

      // Data hygiene: custom links must not dangle across network boundaries.
      // (The renderer guards against unknown ids anyway, but stale entries
      // would resurface if a node with the same id were ever recreated.)
      const movedSet = new Set(subtreeIds);
      const toNetIds = new Set(Object.keys(toNet.nodes));
      for (const id of subtreeIds) {
        const n = toNet.nodes[id];
        if (!n) continue;
        n.links = n.links.filter((other) => toNetIds.has(other) || movedSet.has(other));
        if (n.linkLabels) {
          for (const other of Object.keys(n.linkLabels)) {
            if (!toNet.nodes[other] && !movedSet.has(other)) delete n.linkLabels[other];
          }
        }
      }
      for (const id of Object.keys(fromNet.nodes)) {
        const n = fromNet.nodes[id];
        if (!n) continue;
        if (n.links.some((other) => movedSet.has(other))) {
          n.links = n.links.filter((other) => !movedSet.has(other));
        }
        if (n.linkLabels) {
          for (const other of Object.keys(n.linkLabels)) {
            if (movedSet.has(other)) delete n.linkLabels[other];
          }
        }
      }
    }

    // currentId fixup in the source network.
    if (subtreeIds.includes(fromNet.currentId)) fromNet.currentId = fromRootId!;
    this.save();
    return { success: true };
  },

  renameNode(nodeId: string, newLabel: string): CareOpResult {
    const node = this.getNode(nodeId);
    if (!node) return { success: false, error: 'Node not found' };
    if (!newLabel || !newLabel.trim()) return { success: false, error: 'Label cannot be empty' };
    node.label = newLabel.trim();
    node.updatedAt = Date.now();
    this.save();
    return { success: true };
  },

  reorderNode(nodeId: string, newIndex: number): CareOpResult {
    const node = this.getNode(nodeId);
    if (!node || !node.parentId) return { success: false, error: 'Cannot reorder the core' };
    const parent = this.getNode(node.parentId)!;
    const oldIndex = parent.children.indexOf(nodeId);
    if (oldIndex === -1) return { success: false, error: 'Node not in parent children' };
    parent.children.splice(oldIndex, 1);
    const clamped = Math.max(0, Math.min(newIndex, parent.children.length));
    parent.children.splice(clamped, 0, nodeId);
    node.updatedAt = Date.now();
    this.save();
    return { success: true };
  },

  isDescendant(potentialDescendantId: string, ancestorId: string): boolean {
    let current: CareNode | null = this.getNode(potentialDescendantId);
    while (current && current.parentId) {
      if (current.parentId === ancestorId) return true;
      current = this.getNode(current.parentId);
    }
    return false;
  },

  toggleCollapse(nodeId: string): CareOpResult<boolean> {
    const node = this.getNode(nodeId);
    if (!node) return { success: false, error: 'Node not found' };
    node.collapsed = !node.collapsed;
    this.save();
    return { success: true, data: node.collapsed };
  },

  setTag(nodeId: string, tag: NodeTag): CareOpResult {
    const node = this.getNode(nodeId);
    if (!node) return { success: false, error: 'Node not found' };
    if (tag === 'none') {
      node.tags = [];
    } else {
      node.tags = [tag];
    }
    node.updatedAt = Date.now();
    this.save();
    return { success: true };
  },

  linkNodes(aId: string, bId: string, label?: string): CareOpResult {
    const a = this.getNode(aId);
    const b = this.getNode(bId);
    if (!a || !b) return { success: false, error: 'Node not found' };
    if (aId === bId) return { success: false, error: 'Cannot link a node to itself' };
    if (!a.links.includes(bId)) a.links.push(bId);
    if (!b.links.includes(aId)) b.links.push(aId);
    /* Optional relation label — stored on BOTH sides so it survives either
     * node being the one that renders the pair (tree badge / graph edge). */
    if (label && label.trim()) {
      const clean = label.trim().slice(0, 40);
      if (!a.linkLabels) a.linkLabels = {};
      if (!b.linkLabels) b.linkLabels = {};
      a.linkLabels[bId] = clean;
      b.linkLabels[aId] = clean;
    }
    a.updatedAt = Date.now();
    b.updatedAt = Date.now();
    this.save();
    return { success: true };
  },

  /** Set / change / clear (empty string) the label of an existing link. */
  setLinkLabel(aId: string, bId: string, label: string): CareOpResult {
    const a = this.getNode(aId);
    const b = this.getNode(bId);
    if (!a || !b) return { success: false, error: 'Node not found' };
    const had = a.links.includes(bId) || b.links.includes(aId);
    if (!had) return { success: false, error: 'These nodes are not linked — use link first' };
    const clean = label.trim().slice(0, 40);
    if (!a.linkLabels) a.linkLabels = {};
    if (!b.linkLabels) b.linkLabels = {};
    if (clean) {
      a.linkLabels[bId] = clean;
      b.linkLabels[aId] = clean;
    } else {
      delete a.linkLabels[bId];
      delete b.linkLabels[aId];
    }
    a.updatedAt = Date.now();
    b.updatedAt = Date.now();
    this.save();
    return { success: true };
  },

  /** Resolve the label of the link between two nodes (either side may hold it). */
  getLinkLabel(aId: string, bId: string): string | undefined {
    const a = this.getNode(aId);
    const b = this.getNode(bId);
    return a?.linkLabels?.[bId] ?? b?.linkLabels?.[aId];
  },

  /** Remove a custom (non-hierarchical) link between two nodes. */
  unlinkNodes(aId: string, bId: string): CareOpResult {
    const a = this.getNode(aId);
    const b = this.getNode(bId);
    if (!a || !b) return { success: false, error: 'Node not found' };
    const had = a.links.includes(bId) || b.links.includes(aId);
    a.links = a.links.filter((id) => id !== bId);
    b.links = b.links.filter((id) => id !== aId);
    /* Clean the label from both sides so relinking starts fresh. */
    if (a.linkLabels) delete a.linkLabels[bId];
    if (b.linkLabels) delete b.linkLabels[aId];
    if (!had) return { success: false, error: 'These nodes are not linked' };
    a.updatedAt = Date.now();
    b.updatedAt = Date.now();
    this.save();
    return { success: true };
  },

  /* ════════════════════════════════════════════════════════════════
     Notes
     ════════════════════════════════════════════════════════════════ */

  /* Phase 5 — vault binding. The binding is METADATA ONLY (the stable
   * rel path on the node); the note text itself lives in the real file.
   * Explicit user action binds (`carebind` / `care export`) — nothing
   * here ever invents a path or touches a file. */

  /** Bind a node to a real note file (vault-relative path). The path is
   * stored verbatim — existence is the CALLER's job (it has the API). */
  bindNode(nodeId: string, rel: string): CareOpResult<string> {
    const node = this.getNode(nodeId);
    if (!node) return { success: false, error: 'Node not found' };
    const clean = rel.trim().replace(/^\.\//, '');
    if (!clean) return { success: false, error: 'Binding path cannot be empty' };
    node.vaultPath = clean;
    node.updatedAt = Date.now();
    this.save();
    return { success: true, data: clean };
  },

  /** Clear a node's file binding (internal metadata only — the real
   * file, if any, stays untouched on disk). */
  unbindNode(nodeId: string): CareOpResult {
    const node = this.getNode(nodeId);
    if (!node) return { success: false, error: 'Node not found' };
    if (!node.vaultPath) return { success: false, error: 'Node is not bound to a file' };
    delete node.vaultPath;
    node.updatedAt = Date.now();
    this.save();
    return { success: true };
  },

  /** All bound nodes in the CURRENT network (id + rel path) — the input
   * list for the batch broken-note check behind the tree/graph ⚠. */
  boundNodes(netIndex?: number): Array<{ id: string; rel: string }> {
    const net = netIndex !== undefined ? this.data.networks[netIndex] : this.currentNetwork();
    if (!net) return [];
    return Object.values(net.nodes)
      .filter((n) => !!n.vaultPath)
      .map((n) => ({ id: n.id, rel: n.vaultPath! }));
  },

  /* Task 39: optional netId — the marker card's "+ note here" can target
   * a node in a merged non-current river (same scoping fix as
   * pinLocation/unpinLocation in Task 38). No netId → current network. */
  addNote(nodeId: string, text: string, netId?: string): CareOpResult<number> {
    const net = netId ? this.data.networks.find((n) => n.id === netId) : this.currentNetwork();
    const node = net?.nodes[nodeId] ?? null;
    if (!node) return { success: false, error: 'Node not found' };
    if (!text || !text.trim()) return { success: false, error: 'Note text cannot be empty' };
    const note: CareNote = {
      text: text.trim(),
      timestamp: Date.now(),
      timeString: formatTime(),
    };
    node.notes.push(note);
    node.updatedAt = Date.now();
    this.save();
    return { success: true, data: node.notes.length };
  },

  removeNote(nodeId: string, noteIndex: number): CareOpResult {
    const node = this.getNode(nodeId);
    if (!node) return { success: false, error: 'Node not found' };
    if (noteIndex < 0 || noteIndex >= node.notes.length) {
      return { success: false, error: 'Invalid note index' };
    }
    node.notes.splice(noteIndex, 1);
    node.updatedAt = Date.now();
    this.save();
    return { success: true };
  },

  replaceInNotes(nodeId: string, oldText: string, newText: string): CareOpResult<{ count: number }> {
    const node = this.getNode(nodeId);
    if (!node) return { success: false, error: 'Node not found' };
    let count = 0;
    node.notes.forEach((n) => {
      if (n.text.includes(oldText)) {
        n.text = n.text.split(oldText).join(newText);
        count++;
      }
    });
    if (count > 0) {
      node.updatedAt = Date.now();
      this.save();
    }
    return { success: true, data: { count } };
  },

  /* ════════════════════════════════════════════════════════════════
     Location
     ════════════════════════════════════════════════════════════════ */

  /* Task 38: both location writers accept an optional netId — the marker
   * card can target a node in a MERGED, non-current river (the composite
   * key scenario), and `getNode` is current-network-scoped, so a bare
   * nodeId write silently failed for other rivers. No netId → current
   * network (CLI parity: pinnode/unpinnode behave exactly as before). */
  pinLocation(nodeId: string, lat: number, lng: number, zoom: number, netId?: string): CareOpResult {
    const net = netId ? this.data.networks.find((n) => n.id === netId) : this.currentNetwork();
    const node = net?.nodes[nodeId] ?? null;
    if (!node) return { success: false, error: 'Node not found' };
    node.location = { lat, lng, zoom };
    node.updatedAt = Date.now();
    this.save();
    return { success: true };
  },

  /** Remove a node's location (Task 37 — the marker card's "✕ Unpin").
   *  Until now a thought's place was write-only via the CLI: pinnode could
   *  move it but nothing could clear it. Fails explicitly when the node is
   *  unknown or already unplaced, so callers can report honestly. */
  unpinLocation(nodeId: string, netId?: string): CareOpResult {
    const net = netId ? this.data.networks.find((n) => n.id === netId) : this.currentNetwork();
    const node = net?.nodes[nodeId] ?? null;
    if (!node) return { success: false, error: 'Node not found' };
    if (!node.location) return { success: false, error: 'Node has no location' };
    node.location = null;
    node.updatedAt = Date.now();
    this.save();
    return { success: true };
  },

  /* ════════════════════════════════════════════════════════════════
     Navigation
     ════════════════════════════════════════════════════════════════ */

  navigateTo(pathOrName: string): CareOpResult<CareNode> {
    const net = this.currentNetwork();
    if (pathOrName === '/' || pathOrName === 'root') {
      const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null)!;
      net.currentId = rootId;
      this.save();
      return { success: true, data: net.nodes[rootId] };
    }
    if (pathOrName === '..') {
      const current = this.getCurrentNode();
      if (current.parentId) {
        net.currentId = current.parentId;
        this.save();
        return { success: true, data: this.getCurrentNode() };
      }
      return { success: true, data: current };
    }
    const current = this.getCurrentNode();
    const childId = current.children.find((cid) => {
      const c = net.nodes[cid];
      return c && (c.label.toLowerCase() === pathOrName.toLowerCase() || cid === pathOrName);
    });
    if (childId) {
      net.currentId = childId;
      this.save();
      return { success: true, data: net.nodes[childId] };
    }
    const global = this.searchNodeByName(pathOrName);
    if (global) {
      net.currentId = global.id;
      this.save();
      return { success: true, data: global };
    }
    return { success: false, error: `Node not found: ${pathOrName}` };
  },

  searchNodeByName(name: string, onAmbiguous?: (candidates: string[]) => void): CareNode | null {
    const net = this.currentNetwork();
    /* Users naturally quote multi-word names (`details "Old Harbor"`) —
     * strip the wrapping quotes so every command accepts them. */
    const clean = name.trim().replace(/^["']|["']$/g, '');
    if (!clean) return null;
    const lower = clean.toLowerCase();
    const nodes = Object.values(net.nodes);
    /* Pass 0: raw id — unique by construction, always wins (even when
     * duplicate labels crowd the pool). */
    const byId = nodes.find((n) => n.id === clean);
    if (byId) return byId;
    /* Pass 1: exact label — unambiguous when ONE. Task 69 — duplicate
     * awareness: this pass used to return the FIRST exact match, so two
     * nodes labeled "Alpha" made `rmnode Alpha` silently delete
     * whichever Object.values surfaced first — no ambiguity report, no
     * way to aim (the exact case, ironically, was the LEAST safe).
     * Now many exacts report ambiguous WITH ids — the raw-id pass above
     * is the escape hatch (`rmnode <id>` aims at one). */
    const exact = nodes.filter((n) => n.label.toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      if (onAmbiguous) onAmbiguous(exact.map((n) => `${n.label} (${n.id})`));
      return null;
    }
    /* Pass 2: unique prefix — `link Alpha to Beta` finds "Alpha Station". */
    const byPrefix = nodes.filter((n) => n.label.toLowerCase().startsWith(lower));
    if (byPrefix.length === 1) return byPrefix[0];
    /* Pass 3: unique substring — still unambiguous to the user. */
    const bySubstring = nodes.filter((n) => n.label.toLowerCase().includes(lower));
    if (bySubstring.length === 1) return bySubstring[0];
    /* Ambiguous — surface the candidates so the caller can ask. */
    if (onAmbiguous) {
      const pool = byPrefix.length > 1 ? byPrefix : bySubstring;
      if (pool.length > 1) onAmbiguous(pool.map((n) => n.label));
    }
    return null;
  },

  searchNotes(query: string): Array<{ node: CareNode; nodePath: string; note: CareNote; noteIndex: number }> {
    const net = this.currentNetwork();
    const results: Array<{ node: CareNode; nodePath: string; note: CareNote; noteIndex: number }> = [];
    const lower = query.toLowerCase();
    const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null)!;
    const search = (nodeId: string, path: string) => {
      const node = net.nodes[nodeId];
      if (!node) return;
      const currentPath = path ? `${path}/${node.label}` : node.label;
      node.notes.forEach((note, i) => {
        if (note.text.toLowerCase().includes(lower)) {
          results.push({ node, nodePath: currentPath, note, noteIndex: i });
        }
      });
      node.children.forEach((cid) => search(cid, currentPath));
    };
    search(rootId, '');
    return results;
  },

  /* Task 46 — tree rows with node ids: the structural data behind
   * `treenode`, exposed so the terminal can make every row a ⇥ jump row
   * (click → open that thought in the tree pane). `getTreeString` stays
   * for any plain-text consumer; it now derives from this method. */
  getTreeRows(): Array<{ text: string; nodeId: string }> {
    const net = this.currentNetwork();
    const rows: Array<{ text: string; nodeId: string }> = [];
    const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null)!;
    const build = (nodeId: string, prefix: string, isLast: boolean, isRoot: boolean) => {
      const node = net.nodes[nodeId];
      if (!node) return;
      if (isRoot) {
        rows.push({ text: node.label, nodeId });
      } else {
        const connector = isLast ? '└── ' : '├── ';
        const notes = node.notes.length > 0 ? ` [${node.notes.length}]` : '';
        const loc = node.location ? ' 📍' : '';
        const cur = nodeId === net.currentId ? ' ←' : '';
        rows.push({ text: `${prefix}${connector}${node.label}${notes}${loc}${cur}`, nodeId });
      }
      if (node.children.length > 0) {
        node.children.forEach((cid, i) => {
          const childIsLast = i === node.children.length - 1;
          const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
          build(cid, childPrefix, childIsLast, false);
        });
      }
    };
    build(rootId, '', true, true);
    return rows;
  },

  getTreeString(): string {
    return this.getTreeRows()
      .map((r) => r.text)
      .join('\n');
  },

  getBreadcrumb(): string[] {
    const net = this.currentNetwork();
    const path: string[] = [];
    let current: CareNode | null = this.getCurrentNode();
    while (current) {
      path.unshift(current.label);
      current = current.parentId ? net.nodes[current.parentId] : null;
    }
    return path;
  },

  getStats(): { totalNodes: number; totalNotes: number; totalLinks: number; pinnedLocations: number; networks: number; currentNet: string } {
    const net = this.currentNetwork();
    let totalNotes = 0;
    let pinned = 0;
    let linkEnds = 0;
    const nodeCount = Object.keys(net.nodes).length;
    for (const node of Object.values(net.nodes)) {
      totalNotes += node.notes.length;
      if (node.location) pinned++;
      linkEnds += node.links.length;
    }
    return {
      totalNodes: nodeCount,
      totalNotes,
      /* Task 62 — the inventory (`links`) exists; the summary speaks it.
       * Custom links are stored on BOTH endpoints — halve the count. */
      totalLinks: Math.round(linkEnds / 2),
      pinnedLocations: pinned,
      networks: this.data.networks.length,
      currentNet: net.name,
    };
  },

  getAllNotes(): Array<{ node: CareNode; nodePath: string; note: CareNote }> {
    const net = this.currentNetwork();
    const notes: Array<{ node: CareNode; nodePath: string; note: CareNote }> = [];
    const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null)!;
    const collect = (nodeId: string, path: string) => {
      const node = net.nodes[nodeId];
      if (!node) return;
      const currentPath = path ? `${path}/${node.label}` : node.label;
      node.notes.forEach((note) => notes.push({ node, nodePath: currentPath, note }));
      node.children.forEach((cid) => collect(cid, currentPath));
    };
    collect(rootId, '');
    notes.sort((a, b) => b.note.timestamp - a.note.timestamp);
    return notes;
  },

  /** Export a single network (or current if none specified) as markdown. */
  exportMarkdown(networkName?: string): string {
    const net = networkName
      ? this.data.networks.find((n) => n.name.toLowerCase() === networkName.toLowerCase()) ?? this.currentNetwork()
      : this.currentNetwork();
    const lines: string[] = [`# ${net.name}`, ''];
    const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null)!;
    const walk = (nodeId: string, depth: number) => {
      const node = net.nodes[nodeId];
      if (!node) return;
      const prefix = '#'.repeat(Math.min(depth + 2, 6));
      lines.push(`${prefix} ${node.label}`);
      if (node.location) {
        lines.push(`> 📍 ${node.location.lat.toFixed(4)}, ${node.location.lng.toFixed(4)} (z${node.location.zoom})`);
      }
      node.notes.forEach((n) => lines.push(`- ${n.text} _(${n.timeString})_`));
      lines.push('');
      node.children.forEach((cid) => walk(cid, depth + 1));
    };
    walk(rootId, 0);
    return lines.join('\n');
  },

  /** Export everything as a serializable object (for backups). */
  exportAll(): CareSpaceData {
    return JSON.parse(JSON.stringify(this.data)) as CareSpaceData;
  },

  /** Import from a parsed object (replaces everything). */
  importAll(data: unknown): CareOpResult {
    if (!isCareSpaceData(data)) return { success: false, error: 'Invalid CareSpace backup' };
    this.data = JSON.parse(JSON.stringify(data)) as CareSpaceData;
    this.save();
    return { success: true };
  },

  /**
   * Merge networks from a parsed backup INTO the current CareSpace (the
   * `caremerge` command). Unlike `importAll` (full replace), this only adds
   * networks whose names don't collide with existing ones, and it respects
   * the 3-river rule — the merge stops at MAX_NETWORKS. Current-network
   * selection is left untouched: merging must never yank the user's focus.
   *
   * With `opts.renameCollisions` a colliding network is merged anyway under
   * the first free "Name (2)" / "Name (3)" suffix — for bringing in a
   * second iteration of the same river without dropping the live one.
   *
   * Node ids are preserved (each network is a self-contained tree; links
   * resolve within their own network's node dict, so cross-network id
   * collisions are harmless). Network ids are regenerated — they only need
   * to be unique for React keys / header lookups.
   */
  mergeNetworks(
    data: unknown,
    opts?: { renameCollisions?: boolean },
  ): CareOpResult<{ merged: Array<{ name: string; renamedFrom?: string }>; skipped: string[]; limitHit: boolean }> {
    if (!isCareSpaceData(data)) return { success: false, error: 'Invalid CareSpace backup' };
    const merged: Array<{ name: string; renamedFrom?: string }> = [];
    const skipped: string[] = [];
    let limitHit = false;
    for (const src of data.networks) {
      if (this.data.networks.length >= MAX_NETWORKS) {
        limitHit = true;
        break;
      }
      const collide = this.data.networks.some(
        (n) => n.name.toLowerCase() === src.name.toLowerCase(),
      );
      let finalName = src.name;
      if (collide) {
        if (!opts?.renameCollisions) {
          skipped.push(src.name);
          continue;
        }
        /* First free "(2)", "(3)"… suffix — deterministic and readable. */
        let i = 2;
        const base = src.name.replace(/\s+\(\d+\)$/, '');
        while (this.data.networks.some((n) => n.name.toLowerCase() === `${base} (${i})`.toLowerCase())) i++;
        finalName = `${base} (${i})`;
      }
      /* Deep clone + per-node legacy sanitization (same defaults as
         migrateLegacy: pre-tags/pre-links backups load cleanly). */
      const net: CareNetwork = JSON.parse(JSON.stringify(src));
      for (const node of Object.values(net.nodes)) {
        if (!Array.isArray(node.tags)) node.tags = [];
        if (typeof node.collapsed !== 'boolean') node.collapsed = false;
        if (!Array.isArray(node.links)) node.links = [];
        if (node.linkLabels && typeof node.linkLabels !== 'object') node.linkLabels = {};
      }
      net.name = finalName;
      net.id = `net_m${Date.now().toString(36)}_${this.data.networks.length}`;
      this.data.networks.push(net);
      merged.push({ name: finalName, renamedFrom: collide ? src.name : undefined });
    }
    if (merged.length > 0) this.save();
    return { success: true, data: { merged, skipped, limitHit } };
  },
};
