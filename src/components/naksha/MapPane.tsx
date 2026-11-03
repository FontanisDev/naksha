'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import { MapEngine } from '@/lib/naksha/map-engine';
import { useNaksha } from '@/lib/naksha/store';
import { CareSpace } from '@/lib/naksha/carespace';
import { MAP_LAYERS, TAG_COLORS } from '@/lib/naksha/constants';
import { debounce } from '@/lib/naksha/utils';
import type { MapLayerKey, UndoEntry } from '@/lib/naksha/types';

/**
 * Naksha — MapPane
 *
 * The left-half Leaflet map pane. The map itself is imperative — React
 * only mirrors display state (layer / zoom / coord) into the glass chips
 * and forwards CustomEvents from the MapEngine into the store.
 *
 * Performance:
 *  - The Leaflet instance is created exactly once (empty deps effect).
 *  - Subscriptions use slice selectors so chip re-renders are isolated.
 *  - Resize is debounced 150ms before calling invalidateSize().
 *  - CustomEvents from MapEngine are dispatched on the container element
 *    (throttled to 100ms inside the engine), so we just relay them.
 *  - The node info card (Task 36) is static paint: no blur, no transition,
 *    no animation — it closes on the first map move instead of tracking.
 */

/** Payload carried by one located node — keyed by `netId:nodeId` so the
 *  same node id in two merged rivers stays two distinct markers. Task 37:
 *  `color` is the node's first tag color (workspace sketch provenance) —
 *  undefined keeps the layer's violet identity. Task 40: `lastNote` is
 *  the node's most recent note text — the card previews it inline so
 *  reading the latest context costs zero pane switches. */
interface NodeMarkerPayload {
  key: string;
  label: string;
  netName: string;
  notes: number;
  tags: string[];
  lat: number;
  lng: number;
  zoom?: number;
  color?: string;
  lastNote?: string;
}

/** Task 38 — module-scope composite-key resolver. The once-registered map
 *  click listener (place-by-click) and the card actions share ONE
 *  implementation without dependency-array gymnastics — everything it
 *  touches (CareSpace) is a module import, so no stale closures exist. */
function resolveCardNodeByKey(key: string) {
  const sep = key.indexOf(':');
  if (sep <= 0) return null;
  const netId = key.slice(0, sep);
  const nodeId = key.slice(sep + 1);
  const net = CareSpace.networks().find((n) => n.id === netId);
  if (!net) return null;
  const node = net.nodes[nodeId];
  if (!node) return null;
  return { net, node };
}

/** Task 38 — shared place pipeline: writes the thought's location from a
 *  map click (place-by-click) or the map center (◎ Move to center), with
 *  undo snapshot, honest failure, and the same terminal print either way.
 *  Passes the resolved river's id so nodes in MERGED non-current rivers
 *  write to THEIR network (pinLocation used to be current-net-scoped). */
function placeNodeAtKey(key: string, lat: number, lng: number, via: 'click' | 'center', snapLabel?: string): boolean {
  const found = resolveCardNodeByKey(key);
  if (!found) return false;
  const zoom = MapEngine.getZoom();
  const undo: UndoEntry = {
    kind: 'care',
    label: `place ${found.node.label.slice(0, 18)}`,
    snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
    ts: Date.now(),
  };
  const r = CareSpace.pinLocation(found.node.id, lat, lng, Math.round(zoom), found.net.id);
  if (!r.success) {
    useNaksha.getState().print(r.error ?? 'Could not place the thought', 'error');
    return false;
  }
  useNaksha.getState().setUndo(undo);
  useNaksha.getState().syncCare();
  const latStr = `${Math.abs(lat).toFixed(3)}${lat >= 0 ? 'N' : 'S'}`;
  const lngStr = `${Math.abs(lng).toFixed(3)}${lng >= 0 ? 'E' : 'W'}`;
  /* Task 40: a magnetic commit writes the CAPTURED marker's coordinates —
     the receipt names the anchor so the co-location is on the record. */
  const where = snapLabel
    ? `your click · snapped to "${snapLabel}"`
    : via === 'click'
      ? 'your click'
      : 'map center';
  useNaksha
    .getState()
    .print(`◎ "${found.node.label}" placed at ${where} @ ${latStr} ${lngStr} — undo available`, 'success');
  return true;
}

/** Task 38 — static gradient hints for the netlayer picker rows. Pure CSS
 *  strings (no images, no canvas, zero runtime cost) — each swatch evokes
 *  the layer's palette at a glance so the picker reads like a map legend. */
const LAYER_SWATCH: Record<MapLayerKey, string> = {
  standard: 'linear-gradient(135deg, #a8c69f 0%, #d8d0b8 58%, #9db8c9 100%)',
  hot: 'linear-gradient(135deg, #f2c98a 0%, #e8e0d4 55%, #a0c4de 100%)',
  satellite: 'linear-gradient(135deg, #2e3d2a 0%, #4a5942 55%, #1f2a1c 100%)',
  topographic: 'linear-gradient(135deg, #d9c9a3 0%, #b89d72 55%, #8f9a6a 100%)',
  dark: 'linear-gradient(135deg, #3a342c 0%, #1a1614 55%, #2a2622 100%)',
};

/* Leaf chips — the only readers of mapZoom / mapCoord in this pane.
 * They subscribe to the store directly, so Leaflet's 10 Hz pan/zoom
 * relays no longer re-render MapPane (markers, picker, cards, map
 * container reconciliation) — just these two pills. */
const ZoomChip = memo(function ZoomChip() {
  const mapZoom = useNaksha((s) => s.mapZoom);
  return <Chip label="Z" value={String(mapZoom)} />;
});
const CoordChip = memo(function CoordChip() {
  const mapCoord = useNaksha((s) => s.mapCoord);
  return <Chip label="" value={mapCoord} mono />;
});

export function MapPane() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);

  // Slice selectors — each chip only re-renders when its own value changes.
  const mapLayer = useNaksha((s) => s.mapLayer);

  /* ──────────────────────────────────────────────────────────────
     Lifecycle — mount the map exactly once
     ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    // Attach Leaflet (returns the L.Map; we don't need to hold it here).
    MapEngine.attach(container);
    /* Apply the PERSISTED layer choice — MapEngine.attach falls back to
     * the build-time DEFAULT_MAP_LAYER, which ignored settings.mapDefaultLayer
     * (and, since Task 33, the per-theme basemap). Re-asserting the setting
     * here makes `settings mapDefaultLayer standard` survive reloads and
     * light themes start on light tiles. */
    const persistedLayer = useNaksha.getState().settings.mapDefaultLayer;
    if (persistedLayer && persistedLayer !== 'dark') {
      MapEngine.setLayer(persistedLayer);
    }
    useNaksha.getState().setMapReady(true);

    // The container may still be settling into its flex slot. Invalidate
    // size after a short tick so Leaflet picks up the real dimensions.
    const earlyInvalidate = setTimeout(() => MapEngine.invalidateSize(), 100);
    const lateInvalidate = setTimeout(() => MapEngine.invalidateSize(), 500);

    /* ── CustomEvent relays → store ── */
    const onCoord = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      useNaksha.getState().setMapCoord(detail);
    };
    const onZoom = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail;
      useNaksha.getState().setMapZoom(detail);
    };
    // mapcenter: no-op here — view history is pushed only by explicit
    // goto / route / save commands (which already do their own pushView).
    const onCenter = () => {};

    container.addEventListener('naksha:mapcoord', onCoord as EventListener);
    container.addEventListener('naksha:mapzoom', onZoom as EventListener);
    container.addEventListener('naksha:mapcenter', onCenter as EventListener);

    // Seed the initial zoom display from the engine.
    useNaksha.getState().setMapZoom(MapEngine.getZoom());

    /* ── ResizeObserver, debounced 150ms ── */
    const debouncedInvalidate = debounce(() => {
      MapEngine.invalidateSize();
    }, 150);
    const resizeObserver = new ResizeObserver(() => {
      debouncedInvalidate();
    });
    resizeObserver.observe(container);

    /* ── Cleanup ── */
    return () => {
      clearTimeout(earlyInvalidate);
      clearTimeout(lateInvalidate);
      container.removeEventListener('naksha:mapcoord', onCoord as EventListener);
      container.removeEventListener('naksha:mapzoom', onZoom as EventListener);
      container.removeEventListener('naksha:mapcenter', onCenter as EventListener);
      resizeObserver.disconnect();
      MapEngine.detach();
      useNaksha.getState().setMapReady(false);
    };
  }, []);

  /* ──────────────────────────────────────────────────────────────
     Layer switching
     ────────────────────────────────────────────────────────────── */
  const handleLayerChange = (key: MapLayerKey) => {
    MapEngine.setLayer(key);
    useNaksha.getState().setMapLayer(key);
    /* Persist the explicit choice — the divergence signal for the
       theme-aware basemap migration (Task 33). */
    useNaksha.getState().setSettings({ mapDefaultLayer: key });
  };

  /* ──────────────────────────────────────────────────────────────
     CareSpace node markers (Task 34) — thoughts with a place.
     Re-synced on careRevision (any CareSpace edit), on toggle, and on
     map readiness. DIFFED inside the engine by the composite key, so a
     revision bump that changes nothing spatial costs one loop.
     Task 36: keys are `netId:nodeId` — after `caremerge --rename` two
     rivers can hold IDENTICAL node ids; bare ids collided (the second
     river's markers were silently dropped, clicks resolved to the
     first river). Payloads live in a ref so the click handler can open
     the info card without re-walking the tree.
     ────────────────────────────────────────────────────────────── */
  const careRevision = useNaksha((s) => s.careRevision);
  const showNodesOnMap = useNaksha((s) => s.settings.showNodesOnMap);
  const mapReady = useNaksha((s) => s.mapReady);
  const payloadsRef = useRef(new Map<string, NodeMarkerPayload>());
  const [openCard, setOpenCard] = useState<{ card: NodeMarkerPayload; pos: { left: number; top: number } } | null>(
    null,
  );

  useEffect(() => {
    if (!mapReady) return;
    if (!showNodesOnMap) {
      MapEngine.clearNodeMarkers();
      payloadsRef.current.clear();
      return;
    }
    payloadsRef.current.clear();
    const located: Array<{
      key: string;
      label: string;
      netName: string;
      lat: number;
      lng: number;
      notes: number;
      color?: string;
    }> = [];
    for (const net of CareSpace.networks()) {
      for (const [id, node] of Object.entries(net.nodes)) {
        if (node.location) {
          const firstTag = node.tags.filter((t) => t && t !== 'none')[0];
          const payload: NodeMarkerPayload = {
            key: `${net.id}:${id}`,
            label: node.label,
            netName: net.name,
            notes: node.notes.length,
            tags: node.tags.filter((t) => t && t !== 'none'),
            lat: node.location.lat,
            lng: node.location.lng,
            zoom: node.location.zoom,
            color: firstTag ? TAG_COLORS[firstTag] : undefined,
            /* Task 40 — the latest note rides the payload so the card can
               preview it without a Reader pane round-trip. */
            lastNote: node.notes.length ? node.notes[node.notes.length - 1].text : undefined,
          };
          payloadsRef.current.set(payload.key, payload);
          located.push({
            key: payload.key,
            label: payload.label,
            netName: payload.netName,
            lat: payload.lat,
            lng: payload.lng,
            notes: payload.notes,
            color: payload.color,
          });
        }
      }
    }
    MapEngine.syncNodeMarkers(located, (key) => {
      // Marker click → open the thought's info card (Task 36). The card's
      // ⇥ Go button performs the cross-network navigate that the click
      // used to do directly — one extra tap buys notes + tags preview.
      const p = payloadsRef.current.get(key);
      if (p) setOpenCard({ card: p, pos: computeCardPos(p.lat, p.lng) });
    });
  }, [careRevision, showNodesOnMap, mapReady]);

  /** Cross-network navigate (the ⇥ Go action of the info card). Finds the
   *  river BY NETWORK ID from the composite key — node ids alone are not
   *  unique across merged rivers (Task 36). */
  const goToNode = useCallback((key: string) => {
    const sep = key.indexOf(':');
    if (sep <= 0) return;
    const netId = key.slice(0, sep);
    const nodeId = key.slice(sep + 1);
    const net = CareSpace.networks().find((n) => n.id === netId);
    if (!net || !net.nodes[nodeId]) return;
    if (net.name !== CareSpace.currentNetwork().name) {
      CareSpace.switchNetwork(net.name);
    }
    net.currentId = nodeId;
    CareSpace.save();
    useNaksha.getState().syncCare();
    useNaksha.getState().print(`↦ node: ${net.nodes[nodeId].label}`, 'info');
    setOpenCard(null);
  }, []);

  /** Shared composite-key resolver for the card's mutation actions
   *  (Task 37: ◎ Move to center / ✕ Unpin · Task 38: ✛ Place by click /
   *  ✎ Rename). Delegates to the module-scope resolver — returns the node
   *  within its own river, or null when the snapshot is stale (network
   *  dropped while the card was open) — callers just bail. */
  const resolveCardNode = useCallback((key: string) => resolveCardNodeByKey(key), []);

  /* Task 38 — place-by-click mode. Armed from the marker card; the NEXT
   * map click writes the node's location (the once-registered mapclick
   * listener intercepts via placeArmedRef). `placeArmed` state only
   * drives the crosshair hint label — zero idle cost while disarmed.
   * Task 39: the armed payload carries the node's first tag color so the
   * hint + ghost pin inherit the sketch provenance tint (violet default). */
  const [placeArmed, setPlaceArmed] = useState<{ key: string; color: string } | null>(null);
  const placeArmedRef = useRef<string | null>(null);
  /* Task 39 — cursor ghost: a ref'd element moved by DIRECT style writes
   * on a throttled mousemove (50ms) — no setState, no React re-render,
   * nothing on the render path. The ghost only exists while armed. */
  const ghostPinRef = useRef<HTMLDivElement | null>(null);
  /* Task 40 — magnetic placement: while armed, the throttled mousemove
   * scans the marker layer for a capture target and parks it here; the
   * click handler reads it ONCE at commit time. Pure refs — the magnet
   * never touches the React render path. ghostTint remembers the node's
   * provenance colors so the ring can snap between gold (locked) and
   * provenance (free) without re-deriving them every mousemove. */
  const magnetRef = useRef<{ key: string; lat: number; lng: number; label: string } | null>(null);
  const ghostTintRef = useRef<{ ring: string; fill: string }>({ ring: 'color-mix(in srgb, var(--naksha-purple) 90%, transparent)', fill: 'color-mix(in srgb, var(--naksha-purple) 18%, transparent)' });
  const setGhostVisible = useCallback((v: boolean) => {
    const g = ghostPinRef.current;
    if (g) g.style.display = v ? 'block' : 'none';
  }, []);
  const armPlaceMode = useCallback((key: string) => {
    placeArmedRef.current = key;
    const found = resolveCardNodeByKey(key);
    const firstTag = found?.node.tags.filter((t) => t && t !== 'none')[0];
    const color = (firstTag && TAG_COLORS[firstTag]) || 'color-mix(in srgb, var(--naksha-purple) 90%, transparent)';
    setPlaceArmed({ key, color });
    setGhostVisible(true);
    magnetRef.current = null;
    /* Tint the ghost ring to match — direct style writes at HANDLER time
     * (never render), so the ghost inherits the node's sketch provenance
     * color exactly like the hint label does. Hex tags get an 18%-alpha
     * fill; the violet fallback already carries its own alpha. Task 40:
     * the tint is ALSO parked in a ref so the magnet's mousemove can
     * restore it after a lock releases (gold → provenance → gold…). */
    const fill = color.startsWith('#') ? `${color}2e` : 'color-mix(in srgb, var(--naksha-purple) 18%, transparent)';
    ghostTintRef.current = { ring: color, fill };
    const ghost = ghostPinRef.current;
    if (ghost) {
      const ring = ghost.firstElementChild as HTMLElement | null;
      if (ring) {
        ring.style.borderColor = color;
        ring.style.background = fill;
      }
      /* The snap label hides until a capture engages it again. */
      const snapTag = ghost.lastElementChild as HTMLElement | null;
      if (snapTag && snapTag !== ring) snapTag.style.display = 'none';
    }
    setOpenCard(null);
    useNaksha
      .getState()
      .print(`✛ Place mode — click anywhere on the map to move "${found?.node.label ?? 'node'}" there (Esc cancels)`, 'info');
  }, [setGhostVisible]);
  useEffect(() => {
    if (!placeArmed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        placeArmedRef.current = null;
        magnetRef.current = null;
        setGhostVisible(false);
        setPlaceArmed(null);
        useNaksha.getState().print('Place mode cancelled — nothing moved', 'muted');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [placeArmed, setGhostVisible]);

  /* mapclick — registered exactly once like the mount effect, but kept in
   * its own effect (declared AFTER the place-mode refs) so the click
   * handler serves place-by-click AND the terminal-focus fallback:
   * when a placement is armed, the FIRST click becomes the thought's
   * location (the engine now hands us the LatLng); otherwise it focuses
   * the terminal, exactly as before Task 38.
   * Task 39 — the same effect tracks the CURSOR GHOST while armed: a
   * throttled (50ms) direct style.transform write on the ref'd element,
   * zero React involvement. Hidden the instant the mode resolves. */
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;
    const onClick = (e: Event) => {
      const armedKey = placeArmedRef.current;
      if (armedKey) {
        placeArmedRef.current = null;
        setGhostVisible(false);
        setPlaceArmed(null);
        const detail = (e as CustomEvent<{ lat?: number; lng?: number }>).detail;
        if (detail && typeof detail.lat === 'number' && typeof detail.lng === 'number') {
          /* Task 40 — magnetic commit: if the magnet captured a marker,
           * write the CAPTURED coordinates (the click was close enough to
           * express "same place as this") and name the anchor in the
           * receipt. Otherwise the raw click coordinates, as before. */
          const magnet = magnetRef.current;
          magnetRef.current = null;
          placeNodeAtKey(armedKey, magnet ? magnet.lat : detail.lat, magnet ? magnet.lng : detail.lng, 'click', magnet?.label);
          return;
        }
      }
      const input = document.getElementById('naksha-terminal-input');
      input?.focus();
    };
    let lastGhost = 0;
    const onMove = (e: MouseEvent) => {
      const ghost = ghostPinRef.current;
      if (!ghost || ghost.style.display !== 'block') return;
      const now = Date.now();
      if (now - lastGhost < 50) return;
      lastGhost = now;
      const r = container.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      /* Task 40 — magnetic placement: the nearest EXISTING thought-marker
       * within SNAP_RADIUS container-px captures the ghost. Pure
       * projection math (latLngToContainerPoint) — no DOM reads, no
       * React involvement; the ring turns gold and a small tag names the
       * capture target so the lock is unmistakable. Armed node can never
       * capture itself. */
      const SNAP_RADIUS = 26;
      const armedKey = placeArmedRef.current;
      const targets = MapEngine.getNodeMarkerScreenPositions();
      let best: { key: string; x: number; y: number; lat: number; lng: number; label: string; color?: string } | null = null;
      let bestD = SNAP_RADIUS;
      for (const t of targets) {
        if (t.key === armedKey) continue;
        const d = Math.hypot(t.x - cx, t.y - cy);
        if (d <= bestD) {
          bestD = d;
          const p = payloadsRef.current.get(t.key);
          best = { key: t.key, x: t.x, y: t.y, lat: t.lat, lng: t.lng, label: p?.label ?? '', color: p?.color };
        }
      }
      magnetRef.current = best ? { key: best.key, lat: best.lat, lng: best.lng, label: best.label } : null;
      /* Ghost wrapper tracks the anchor point raw — the ring inside
       * self-centers via its own translate(-8px,-8px), so the same
       * coordinate parks the ring on the cursor AND on a captured
       * marker with no extra math. */
      const gx = best ? best.x : cx;
      const gy = best ? best.y : cy;
      ghost.style.transform = `translate(${gx}px, ${gy}px)`;
      const ring = ghost.firstElementChild as HTMLElement | null;
      if (ring) {
        if (best) {
          ring.style.borderColor = 'rgba(230, 180, 100, 0.95)';
          ring.style.background = 'rgba(230, 180, 100, 0.2)';
        } else {
          ring.style.borderColor = ghostTintRef.current.ring;
          ring.style.background = ghostTintRef.current.fill;
        }
      }
      /* Capture tag: names the anchor under the locked ghost (direct
       * textContent write — React never re-renders for any of this).
       * Task 41 — provenance chain extension: the tag wears the TARGET's
       * own tint (its first tag / workspace sketch color) when it has
       * one, so the lock reads as “you are grabbing THAT thought”; the
       * ring stays gold — the lock signal — regardless. Untagged targets
       * keep the gold family (locked = gold, everywhere). */
      const snapTag = ghost.lastElementChild as HTMLElement | null;
      if (snapTag && snapTag !== ring) {
        if (best) {
          const tint = best.color ?? 'rgba(230, 180, 100, 0.95)';
          snapTag.textContent = `⌖ ${best.label}`;
          snapTag.style.color = tint;
          snapTag.style.borderColor = best.color ? tint : 'rgba(230, 180, 100, 0.5)';
          snapTag.style.display = 'block';
        } else {
          snapTag.style.display = 'none';
        }
      }
    };
    container.addEventListener('naksha:mapclick', onClick as EventListener);
    container.addEventListener('mousemove', onMove);
    return () => {
      container.removeEventListener('naksha:mapclick', onClick as EventListener);
      container.removeEventListener('mousemove', onMove);
    };
  }, [setGhostVisible]);

  /** ◎ Move to center — relocate this thought's place to the CURRENT map
   *  center (Task 38: shares the module place pipeline, so merged-river
   *  nodes write to their OWN network and failures print honestly). The
   *  card anchors at the marker, but the crosshair shows where the
   *  center actually is; this closes the "the sketch moved, the thought
   *  should follow" loop without the terminal. */
  const relocateCardNode = useCallback((key: string) => {
    const c = MapEngine.getCenter();
    if (placeNodeAtKey(key, c.lat, c.lng, 'center')) setOpenCard(null);
  }, []);

  /** ✕ Unpin — remove this thought's location entirely (undo parity).
   *  Until now a located node could only be MOVED, never unplaced. */
  const unpinCardNode = useCallback((key: string) => {
    const found = resolveCardNode(key);
    if (!found) return;
    const undo: UndoEntry = {
      kind: 'care',
      label: `unpin ${found.node.label.slice(0, 18)}`,
      snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
      ts: Date.now(),
    };
    const r = CareSpace.unpinLocation(found.node.id, found.net.id);
    if (!r.success) {
      useNaksha.getState().print(r.error ?? 'Could not unpin', 'error');
      return;
    }
    useNaksha.getState().setUndo(undo);
    useNaksha.getState().syncCare();
    useNaksha.getState().print(`✕ "${found.node.label}" unpinned — the thought lost its place (undo available)`, 'info');
    setOpenCard(null);
  }, [resolveCardNode]);

  /* Task 38 — ✎ rename in place. The card's label swaps to an inline mono
   * input (uncontrolled — zero re-render per keystroke); Enter or blur
   * commits, Esc cancels. The write is river-scoped (the resolved net's
   * own node — not CareSpace.renameNode, which is current-net-only) and
   * the marker payload + card label update LIVE, so the tree, the marker
   * tooltip and the card all agree without a marker-layer resync dance. */
  const [renaming, setRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameCancelledRef = useRef(false);
  const commitCardRename = useCallback(() => {
    const key = openCard?.card.key;
    const el = renameInputRef.current;
    setRenaming(false);
    if (!key || !el) return;
    const newLabel = el.value.trim();
    const found = resolveCardNodeByKey(key);
    if (!found || !newLabel || newLabel === found.node.label) return;
    const oldLabel = found.node.label;
    const undo: UndoEntry = {
      kind: 'care',
      label: `rennode ${oldLabel.slice(0, 18)}`,
      snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
      ts: Date.now(),
    };
    found.node.label = newLabel;
    found.node.updatedAt = Date.now();
    CareSpace.save();
    useNaksha.getState().setUndo(undo);
    useNaksha.getState().syncCare();
    useNaksha.getState().print(`✎ "${oldLabel}" renamed → "${newLabel}" — undo available`, 'success');
    const p = payloadsRef.current.get(key);
    if (p) {
      p.label = newLabel;
      setOpenCard((c) => (c && c.card.key === key ? { card: { ...p }, pos: c.pos } : c));
    }
  }, [openCard]);

  /* Task 39 — “+ note here”: append a note WITHOUT leaving the map or
   * opening the tree. Same inline-input pattern as rename (Enter/blur
   * commits, Esc cancels via the cancelled flag). The write is
   * river-scoped (addNote's optional netId), carries undo, and the
   * card's note count updates LIVE. */
  const [noting, setNoting] = useState(false);
  const noteInputRef = useRef<HTMLInputElement | null>(null);
  const noteCancelledRef = useRef(false);
  const commitCardNote = useCallback(() => {
    const key = openCard?.card.key;
    const el = noteInputRef.current;
    setNoting(false);
    if (!key || !el) return;
    const text = el.value.trim();
    const found = resolveCardNodeByKey(key);
    if (!found || !text) return;
    const undo: UndoEntry = {
      kind: 'care',
      label: `note ${found.node.label.slice(0, 18)}`,
      snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
      ts: Date.now(),
    };
    const r = CareSpace.addNote(found.node.id, text, found.net.id);
    if (!r.success) {
      useNaksha.getState().print(r.error ?? 'Could not add the note', 'error');
      return;
    }
    useNaksha.getState().setUndo(undo);
    useNaksha.getState().syncCare();
    useNaksha.getState().print(`✍ note appended to "${found.node.label}" — undo available`, 'success');
    const p = payloadsRef.current.get(key);
    if (p) {
      p.notes = r.data ?? p.notes + 1;
      /* Task 40 — the fresh note becomes the card's inline preview. */
      p.lastNote = text;
      setOpenCard((c) => (c && c.card.key === key ? { card: { ...p }, pos: c.pos } : c));
    }
  }, [openCard]);

  /* Info card lifetime: the first map move (pan OR zoom) closes it —
   * tracking the anchor live would cost a re-render per move event,
   * which is exactly what CPU-only machines can't afford. Esc closes
   * too (mirrors every other overlay). Visibility is DERIVED from the
   * layer toggle (no setState-in-effect): turning mapnodes off hides
   * the card in the same render; a stale snapshot can only resurface
   * via an immediate off→on flip with zero map interaction, and the
   * first move/Esc/click dismisses it anyway. */
  const visibleCard = showNodesOnMap ? openCard : null;
  useEffect(() => {
    if (!visibleCard) return;
    const container = mapContainerRef.current;
    const close = () => setOpenCard(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    container?.addEventListener('naksha:mapcoord', close as EventListener);
    container?.addEventListener('naksha:mapzoom', close as EventListener);
    document.addEventListener('keydown', onKey);
    return () => {
      container?.removeEventListener('naksha:mapcoord', close as EventListener);
      container?.removeEventListener('naksha:mapzoom', close as EventListener);
      document.removeEventListener('keydown', onKey);
    };
  }, [visibleCard]);

  /* ──────────────────────────────────────────────────────────────
     netlayer GUI parity (Task 36) — the current network's basemap
     binding, surfaced as a violet chip. Click = `netlayer clear`
     (same undo snapshot + prints). Re-renders come from careRevision,
     which every care mutation already bumps — zero idle cost.
     ────────────────────────────────────────────────────────────── */
  const boundLayer = careRevision >= 0 ? CareSpace.currentNetwork()?.mapLayer ?? null : null;

  /* Task 37: the ◈ chip's BODY opens a layer PICKER (bind from the GUI,
   * not just unbind) — the ✕ keeps its unbind role. The picker is a
   * static-paint popup (no blur / no transition) that closes on pick,
   * Esc, or the first map move — same lifetime rules as the info card.
   * Task 40 — the picker is RIVER-SCOPED: pickerNetId targets a specific
   * network (null = current, the chip's own flow). The CareSpace header
   * ◈ badge dispatches 'naksha:open-netlayer-picker' with its river's id
   * and the SAME picker re-anchors to that river — rebinding any river
   * from the tree pane without a single extra command. */
  const [layerPickerOpen, setLayerPickerOpen] = useState(false);
  const [pickerNetId, setPickerNetId] = useState<string | null>(null);
  const pickerNet = useMemo(
    () => (pickerNetId ? CareSpace.networks().find((n) => n.id === pickerNetId) ?? null : CareSpace.currentNetwork()),
    // careRevision re-derives after every care mutation (bind/rename/…).
    [pickerNetId, careRevision],
  );
  useEffect(() => {
    const openFor = (e: Event) => {
      const netId = (e as CustomEvent<{ netId?: string }>).detail?.netId;
      setPickerNetId(netId ?? null);
      setLayerPickerOpen(true);
    };
    window.addEventListener('naksha:open-netlayer-picker', openFor);
    return () => window.removeEventListener('naksha:open-netlayer-picker', openFor);
  }, []);
  const bindNetLayer = useCallback((key: MapLayerKey, netId?: string | null) => {
    const net = netId ? CareSpace.networks().find((n) => n.id === netId) : CareSpace.currentNetwork();
    if (!net) return;
    const undo: UndoEntry = {
      kind: 'care',
      label: `netlayer ${key}`,
      snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
      ts: Date.now(),
    };
    net.mapLayer = key;
    CareSpace.save();
    useNaksha.getState().setUndo(undo);
    useNaksha.getState().syncCare();
    /* Only the CURRENT river's binding retunes the live map — binding a
       dormant river just records the preference (its `use` applies it,
       same contract as the terminal's netlayer). */
    if (net.id === CareSpace.currentNetwork().id) {
      MapEngine.setLayer(key);
      useNaksha.getState().setMapLayer(key);
      useNaksha.getState().setSettings({ mapDefaultLayer: key });
    }
    useNaksha
      .getState()
      .print(
        net.id === CareSpace.currentNetwork().id
          ? `Network "${net.name}" bound to ${key} basemap — undo available`
          : `River "${net.name}" bound to ${key} basemap (applies on 'use ${net.name}') — undo available`,
        'success',
      );
    setLayerPickerOpen(false);
    setPickerNetId(null);
  }, []);
  /* Task 41 — remote pickers gain a "⇥ use" row: switching to the target
   * river is one click from the SAME popup that binds it (the terminal's
   * `use` semantics mirrored — the river's own bound basemap, if any,
   * applies on arrival). Zero idle cost: rendered only while the picker
   * is open for a non-current river. */
  const switchToPickerNet = useCallback((netId: string) => {
    const net = CareSpace.networks().find((n) => n.id === netId);
    if (!net || net.id === CareSpace.currentNetwork().id) return;
    const r = CareSpace.switchNetwork(net.name);
    if (!r.success) {
      useNaksha.getState().print(r.error ?? 'Could not switch rivers', 'error');
      return;
    }
    useNaksha.getState().syncCare();
    const cur = CareSpace.currentNetwork();
    if (cur.mapLayer && cur.mapLayer !== MapEngine.currentLayer) {
      MapEngine.setLayer(cur.mapLayer);
      useNaksha.getState().setMapLayer(cur.mapLayer);
      useNaksha.getState().setSettings({ mapDefaultLayer: cur.mapLayer });
      useNaksha.getState().print(`Basemap → ${cur.mapLayer} (network preference — 'netlayer clear' unbinds)`, 'muted');
    }
    useNaksha.getState().print(`Switched to river "${cur.name}"`, 'success');
    setLayerPickerOpen(false);
    setPickerNetId(null);
  }, []);
  /* ✕ Unbind — river-scoped (Task 40: the picker's clear row and the
     CareSpace badge flow can target a NON-current river too). */
  const unbindNetLayer = useCallback((netId?: string) => {
    const net = netId ? CareSpace.networks().find((n) => n.id === netId) : CareSpace.currentNetwork();
    if (!net?.mapLayer) return;
    const undo: UndoEntry = {
      kind: 'care',
      label: 'netlayer clear',
      snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
      ts: Date.now(),
    };
    delete net.mapLayer;
    CareSpace.save();
    useNaksha.getState().setUndo(undo);
    useNaksha.getState().syncCare();
    useNaksha
      .getState()
      .print(
        net.id === CareSpace.currentNetwork().id
          ? `Network "${net.name}" follows the theme default again — undo available`
          : `River "${net.name}" follows the theme default again — undo available`,
        'success',
      );
    setLayerPickerOpen(false);
    setPickerNetId(null);
  }, []);
  useEffect(() => {
    if (!layerPickerOpen) return;
    const container = mapContainerRef.current;
    const close = () => setLayerPickerOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    container?.addEventListener('naksha:mapcoord', close as EventListener);
    container?.addEventListener('naksha:mapzoom', close as EventListener);
    document.addEventListener('keydown', onKey);
    return () => {
      container?.removeEventListener('naksha:mapcoord', close as EventListener);
      container?.removeEventListener('naksha:mapzoom', close as EventListener);
      document.removeEventListener('keydown', onKey);
    };
  }, [layerPickerOpen]);

  const layerKeys = Object.keys(MAP_LAYERS) as MapLayerKey[];

  return (
    <div
      className="relative flex-1 overflow-hidden"
      style={{
        borderRadius: 'var(--radius-lg)',
      }}
    >
      {/* The Leaflet mount point — fills the container */}
      <div ref={mapContainerRef} className="absolute inset-0 z-[1]" />

      {/* ──────────────────────────────────────────────────────────
          Overlay layer — wrapper ignores pointer events so the map
          stays interactive; interactive bits re-enable them.
          ────────────────────────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-0 z-[400]">
        {/* Crosshair at center — minimal (no breathing pulse, just a thin cross) */}
        <div className="absolute left-1/2 top-1/2 z-[500] -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          <div className="relative h-8 w-8">
            <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-[var(--naksha-gold)] opacity-30" />
            <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-[var(--naksha-gold)] opacity-30" />
            <div className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--naksha-gold)] opacity-60" />
          </div>
        </div>

        {/* Task 38/39 — place-mode hint: a static label pinned beside the
            crosshair while a placement is armed, TINTED with the node's
            provenance tag color (violet when untagged). No animation, no
            tracking — it disappears the instant the mode resolves. */}
        {placeArmed && (
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 z-[510]"
            style={{ transform: 'translate(20px, 20px)' }}
          >
            <span
              style={{
                fontFamily: 'var(--naksha-font-mono, monospace)',
                fontSize: 'var(--naksha-fs-xs)',
                color: placeArmed.color,
                background: 'var(--naksha-glass-strong)',
                border: `1px solid ${placeArmed.color}`,
                borderRadius: 4,
                padding: '2px 7px',
                letterSpacing: '0.04em',
              }}
            >
              ✛ click to place · esc to cancel
            </span>
          </div>
        )}

        {/* Task 39 — cursor ghost pin: rendered ONCE (display:none), moved
            by direct style.transform writes from the throttled mousemove
            in the mapclick effect — React never re-renders for cursor
            movement. Tint comes from the arm handler via direct style
            writes too, so it matches the hint exactly. */}
        <div
          ref={ghostPinRef}
          aria-hidden
          style={{
            display: 'none',
            position: 'absolute',
            left: 0,
            top: 0,
            zIndex: 505,
            pointerEvents: 'none',
            willChange: 'transform',
          }}
        >
          <div
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              border: '2px solid color-mix(in srgb, var(--naksha-purple) 90%, transparent)',
              background: 'color-mix(in srgb, var(--naksha-purple) 18%, transparent)',
              transform: 'translate(-8px, -8px)',
              boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.45)',
            }}
          />
          {/* Task 40 — magnetic capture tag: hidden until the magnet locks
              onto an existing marker; the throttled mousemove names the
              anchor here via direct textContent writes (zero React). */}
          <div
            style={{
              display: 'none',
              position: 'absolute',
              top: 12,
              left: 0,
              transform: 'translateX(-50%)',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--naksha-font-mono, monospace)',
              fontSize: 9,
              color: 'var(--naksha-gold)',
              background: 'var(--naksha-glass-strong)',
              border: '1px solid color-mix(in srgb, var(--naksha-gold) 50%, transparent)',
              borderRadius: 4,
              padding: '1px 6px',
              letterSpacing: '0.04em',
            }}
          />
        </div>

        {/* Layer switcher (top-left) — a ◈ marks the layer the CURRENT
            network is bound to (netlayer GUI parity, Task 36) */}
        <div className="pointer-events-auto absolute left-3 top-3 z-[510]">
          <div className="flex flex-wrap gap-1 rounded-full border border-[var(--naksha-border)] bg-[color-mix(in_srgb,var(--naksha-bg)_82%,transparent)] p-1 backdrop-blur">
            {layerKeys.map((key) => {
              const isActive = key === mapLayer;
              const isBound = boundLayer === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleLayerChange(key)}
                  aria-pressed={isActive}
                  title={
                    MAP_LAYERS[key].name +
                    (isBound
                      ? ` — ◈ bound to network "${CareSpace.currentNetwork()?.name}" ('netlayer clear' unbinds)`
                      : '')
                  }
                  className={[
                    'flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[length:var(--naksha-fs-xs)] transition-colors',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--naksha-gold)]',
                    isActive
                      ? 'border border-[var(--naksha-gold)] bg-[color-mix(in_srgb,var(--naksha-gold)_18%,transparent)] text-[var(--naksha-gold-light)]'
                      : 'border border-transparent text-[var(--naksha-text-2)] hover:bg-[color-mix(in_srgb,var(--naksha-gold)_8%,transparent)] hover:text-[var(--naksha-text)]',
                  ].join(' ')}
                >
                  {/* Task 39 — the legend swatches from the netlayer picker
                      now lead every switcher pill: the switcher reads like
                      a map legend at a glance. Static CSS gradient, no
                      image, painted once per render. */}
                  <span
                    aria-hidden
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      background: LAYER_SWATCH[key],
                      border: '1px solid rgba(255, 255, 255, 0.14)',
                      flexShrink: 0,
                    }}
                  />
                  {MAP_LAYERS[key].name}
                  {isBound && (
                    <span
                      aria-hidden
                      style={{ color: 'var(--naksha-purple)', marginLeft: 3 }}
                    >
                      ◈
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Info chip stack (top-right). Zoom + coord ride leaf
            components (below) so a pan or pinch re-renders two tiny
            chips instead of this whole subtree at event rate. */}
        <div className="absolute right-3 top-3 z-[510] flex flex-col items-end gap-1.5">
          <ZoomChip />
          <CoordChip />
          <Chip label="" value={MAP_LAYERS[mapLayer].name} />
          {boundLayer && (
            <button
              type="button"
              onClick={() => {
                setPickerNetId(null);
                setLayerPickerOpen((v) => !v);
              }}
              title={`Network "${CareSpace.currentNetwork()?.name}" remembers this basemap — click to change it (✕ = unbind, 'netlayer clear')`}
              className="pointer-events-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[length:var(--naksha-fs-xs)] cursor-pointer"
              style={{
                borderColor: 'color-mix(in srgb, var(--naksha-purple) 45%, transparent)',
                background: 'color-mix(in srgb, var(--naksha-purple) 12%, transparent)',
                color: 'var(--naksha-purple)',
              }}
            >
              <span aria-hidden>◈</span>
              <span className="font-medium">{MAP_LAYERS[boundLayer].name}</span>
              <span
                aria-hidden
                role="button"
                title={`Unbind — "${CareSpace.currentNetwork()?.name}" follows the theme default again`}
                onClick={(e) => {
                  e.stopPropagation();
                  unbindNetLayer();
                }}
                style={{
                  opacity: 0.7,
                  cursor: 'pointer',
                  padding: '0 2px',
                  borderLeft: '1px solid color-mix(in srgb, var(--naksha-purple) 35%, transparent)',
                }}
              >
                ✕
              </span>
            </button>
          )}
          {/* Task 37/40 — netlayer PICKER: bind ANY river's basemap from
              the GUI (chip = current river; the CareSpace ◈ badge opens it
              for its own river). Static paint, closes on pick / Esc / map
              move. */}
          {layerPickerOpen && pickerNet && (
            <div
              className="pointer-events-auto absolute"
              style={{
                top: 84,
                right: 12,
                width: 196,
                background: 'var(--naksha-glass-strong)',
                border: '1px solid color-mix(in srgb, var(--naksha-purple) 40%, transparent)',
                borderRadius: 8,
                boxShadow: 'var(--naksha-shadow-elevated)',
                padding: '6px',
                fontFamily: 'var(--naksha-font-mono, monospace)',
                fontSize: 11,
                zIndex: 530,
              }}
              role="menu"
              aria-label="Bind basemap to network"
            >
              <div
                style={{
                  color: 'var(--naksha-purple)',
                  fontSize: 'var(--naksha-fs-xs)',
                  padding: '2px 6px 4px',
                }}
              >
                ◈ Bind basemap — {pickerNet.name.slice(0, 18)}
                {pickerNet.id !== CareSpace.currentNetwork().id && (
                  <span style={{ color: 'var(--naksha-text-3)' }}> · remote</span>
                )}
              </div>
              {/* Task 41 — one-click switch to a remote river from the same
                  popup that binds it (gold = navigation intent, matching
                  the card's ⇥ Go). Only rendered for non-current rivers. */}
              {pickerNet.id !== CareSpace.currentNetwork().id && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => switchToPickerNet(pickerNet.id)}
                  className="flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 font-mono"
                  style={{
                    border: '1px solid color-mix(in srgb, var(--naksha-gold) 35%, transparent)',
                    background: 'color-mix(in srgb, var(--naksha-gold) 10%, transparent)',
                    color: 'var(--naksha-gold)',
                    textAlign: 'left',
                    fontSize: 11,
                    cursor: 'pointer',
                    marginBottom: 3,
                  }}
                  title={`Switch to "${pickerNet.name}" — its bound basemap (if any) applies on arrival`}
                >
                  <span>⇥ use “{pickerNet.name.slice(0, 14)}”</span>
                  <span style={{ color: 'var(--naksha-text-3)', fontSize: 9 }}>switch</span>
                </button>
              )}
              {/* Task 42 — river CYCLING: with more remote rivers beyond
                  this one, a muted ⇥ next row retargets the SAME popup to
                  the next river in line (wrapping, never landing on the
                  current river). Repeated clicks walk every dormant river
                  without touching the terminal or the tree — the keyboard/
                  mouse-only flow stays one gesture per river. */}
              {(() => {
                if (pickerNet.id === CareSpace.currentNetwork().id) return null;
                const nets = CareSpace.networks();
                if (nets.length < 3) return null;
                const idx = nets.findIndex((n) => n.id === pickerNet.id);
                const others = nets.filter((n) => n.id !== CareSpace.currentNetwork().id && n.id !== pickerNet.id);
                if (others.length === 0) return null;
                /* Task 44 — a recency-ordered cycle ("start from the last
                 * river you visited") was analyzed and REJECTED: with
                 * MAX_NETWORKS = 3 the non-current, non-picker pool always
                 * holds exactly ONE river, so recency and array order are
                 * provably equivalent in every reachable state. Kept the
                 * deterministic walk; see worklog Task 44. */
                const next = nets[(idx + 1) % nets.length];
                const target = next.id === CareSpace.currentNetwork().id ? others[0] : next;
                return (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setPickerNetId(target.id)}
                    className="flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 font-mono"
                    style={{
                      border: 'none',
                      color: 'var(--naksha-text-3)',
                      textAlign: 'left',
                      fontSize: 11,
                      cursor: 'pointer',
                      marginBottom: 3,
                    }}
                    title={`Cycle to river "${target.name}" — same popup, next river`}
                  >
                    <span>⇥ next “{target.name.slice(0, 14)}”</span>
                    <span style={{ color: 'var(--naksha-text-4)', fontSize: 9 }}>cycle</span>
                  </button>
                );
              })()}
              {layerKeys.map((key) => {
                const isBound = key === pickerNet.mapLayer;
                return (
                  <button
                    key={key}
                    type="button"
                    role="menuitem"
                    onClick={() => bindNetLayer(key, pickerNet.id)}
                    className="flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 font-mono"
                    style={{
                      background: isBound ? 'color-mix(in srgb, var(--naksha-purple) 14%, transparent)' : 'transparent',
                      border: 'none',
                      color: isBound ? 'var(--naksha-purple)' : 'var(--naksha-text-2)',
                      textAlign: 'left',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                    title={
                      isBound
                        ? 'Already bound — pick another layer to rebind'
                        : `Bind "${pickerNet.name}" to ${MAP_LAYERS[key].name}`
                    }
                  >
                    <span className="flex items-center gap-1.5">
                      {/* Task 38 — static palette swatch per layer: the
                          picker reads like a map legend. Pure CSS gradient,
                          no image fetch, painted once when the picker opens. */}
                      <span
                        aria-hidden
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 3,
                          background: LAYER_SWATCH[key],
                          border: '1px solid rgba(255, 255, 255, 0.14)',
                          flexShrink: 0,
                        }}
                      />
                      {isBound ? '◈ ' : ''}
                      {MAP_LAYERS[key].name}
                    </span>
                    <span style={{ color: 'var(--naksha-text-3)', fontSize: 9 }}>
                      {isBound ? 'bound' : 'bind →'}
                    </span>
                  </button>
                );
              })}
              {/* Task 40 — clear row: unbinding no longer requires the
                  terminal (or even the river being current). Only shows
                  when the target river actually carries a binding. */}
              {pickerNet.mapLayer && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => unbindNetLayer(pickerNet.id)}
                  className="flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 font-mono"
                  style={{
                    border: 'none',
                    borderTop: '1px solid color-mix(in srgb, var(--naksha-purple) 20%, transparent)',
                    marginTop: 3,
                    paddingTop: 5,
                    color: 'var(--naksha-error)',
                    textAlign: 'left',
                    fontSize: 'var(--naksha-fs-xs)',
                    cursor: 'pointer',
                  }}
                  title={`Unbind — "${pickerNet.name}" follows the theme default again ('netlayer clear' parity, undo available)`}
                >
                  <span>✕ follow theme default</span>
                  <span style={{ color: 'var(--naksha-text-3)', fontSize: 9 }}>clear</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Thought info card (Task 36) — static paint, closes on move.
               Fully inline styles: the Turbopack CSS pipeline is frozen for
               NEW globals.css rules (Task 31), so new classes never reach
               the served chunk. No blur / no transition — CPU-only safe. ── */}
        {visibleCard && (
          <div
            className="pointer-events-auto absolute z-[520]"
            style={{
              left: visibleCard.pos.left,
              top: visibleCard.pos.top,
              width: 252,
              background: 'var(--naksha-glass-strong)',
              border: '1px solid var(--naksha-border-2, rgba(212, 160, 23, 0.25))',
              /* Task 37: "painted edge" — a 3px left border in the node's
                 provenance tag color (violet when untagged) ties the card
                 to the tinted marker ring and the original sketch color. */
              borderLeft: `3px solid ${visibleCard.card.color ?? 'color-mix(in srgb, var(--naksha-purple) 90%, transparent)'}`,
              borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
              padding: '8px 10px',
              fontFamily: 'var(--naksha-font-mono, monospace)',
              fontSize: 11,
              lineHeight: 1.45,
            }}
            role="dialog"
            aria-label={`Node ${visibleCard.card.label}`}
          >
            <div className="flex items-start justify-between gap-2">
              {renaming ? (
                <input
                  ref={renameInputRef}
                  defaultValue={visibleCard.card.label}
                  autoFocus
                  spellCheck={false}
                  maxLength={80}
                  aria-label="Rename node"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitCardRename();
                    } else if (e.key === 'Escape') {
                      e.stopPropagation();
                      renameCancelledRef.current = true;
                      setRenaming(false);
                    }
                  }}
                  onBlur={() => {
                    if (renameCancelledRef.current) {
                      renameCancelledRef.current = false;
                      return;
                    }
                    commitCardRename();
                  }}
                  style={{
                    width: '100%',
                    minWidth: 0,
                    background: 'color-mix(in srgb, var(--naksha-gold) 12%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--naksha-gold) 45%, transparent)',
                    borderRadius: 4,
                    color: 'var(--naksha-gold)',
                    fontFamily: 'inherit',
                    fontSize: 11,
                    padding: '2px 6px',
                    outline: 'none',
                  }}
                />
              ) : (
                <span
                  className="truncate font-medium"
                  style={{ color: 'var(--naksha-cream)', maxWidth: 168 }}
                  title={visibleCard.card.label}
                >
                  ◈ {visibleCard.card.label}
                </span>
              )}
              <span
                className="whitespace-nowrap"
                style={{ color: 'var(--naksha-purple)', fontSize: 'var(--naksha-fs-xs)' }}
              >
                [{visibleCard.card.netName}]
              </span>
            </div>
            <div style={{ color: 'var(--naksha-text-2)', marginTop: 3 }}>
              ◉ {formatCoord(visibleCard.card.lat, 'NS')} {formatCoord(visibleCard.card.lng, 'EW')}
              {visibleCard.card.zoom ? ` · z${visibleCard.card.zoom}` : ''}
            </div>
            <div style={{ color: 'var(--naksha-text-3)', marginTop: 2 }}>
              {visibleCard.card.notes} note{visibleCard.card.notes === 1 ? '' : 's'}
              {visibleCard.card.tags.length > 0 &&
                ` · #${visibleCard.card.tags.slice(0, 3).join(' #')}`}
            </div>
            {/* Task 40 — last-note preview: the node's most recent note
                text, one muted terminal-style line under the count. Reads
                like a `tail -1` of the thought's log; the full log still
                lives in the tree/reader. */}
            {visibleCard.card.lastNote && (
              <div
                title={visibleCard.card.lastNote}
                style={{
                  color: 'var(--naksha-text-3)',
                  marginTop: 3,
                  fontSize: 'var(--naksha-fs-xs)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  opacity: 0.85,
                }}
              >
                ╰ “{visibleCard.card.lastNote.length > 60 ? `${visibleCard.card.lastNote.slice(0, 60)}…` : visibleCard.card.lastNote}”
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 6 }}>
              <button
                type="button"
                onClick={() => goToNode(visibleCard.card.key)}
                className="cursor-pointer rounded px-1.5 py-0.5 font-mono"
                style={{
                  border: '1px solid color-mix(in srgb, var(--naksha-gold) 40%, transparent)',
                  background: 'color-mix(in srgb, var(--naksha-gold) 12%, transparent)',
                  color: 'var(--naksha-gold-light)',
                  fontSize: 'var(--naksha-fs-xs)',
                }}
              >
                ⇥ Go to node
              </button>
              <button
                type="button"
                onClick={() => armPlaceMode(visibleCard.card.key)}
                className="cursor-pointer rounded px-1.5 py-0.5 font-mono"
                style={{
                  border: '1px solid color-mix(in srgb, var(--naksha-gold) 40%, transparent)',
                  background: 'color-mix(in srgb, var(--naksha-gold) 12%, transparent)',
                  color: 'var(--naksha-gold-light)',
                  fontSize: 'var(--naksha-fs-xs)',
                }}
                title="Arm place mode — your NEXT map click becomes this thought's location (Esc cancels). More precise than Move to center."
              >
                ✛ Place by click
              </button>
              <button
                type="button"
                onClick={() => setRenaming(true)}
                className="cursor-pointer rounded px-1.5 py-0.5 font-mono"
                style={{
                  border: '1px solid rgba(245, 234, 208, 0.3)',
                  background: 'rgba(245, 234, 208, 0.07)',
                  color: 'var(--naksha-text, #eef1f7)',
                  fontSize: 'var(--naksha-fs-xs)',
                }}
                title="Rename this thought without leaving the map — Enter commits, Esc cancels (undo available)"
              >
                ✎ Rename
              </button>
              <button
                type="button"
                onClick={() => setNoting(true)}
                className="cursor-pointer rounded px-1.5 py-0.5 font-mono"
                style={{
                  border: '1px solid rgba(126, 158, 194, 0.4)',
                  background: 'rgba(126, 158, 194, 0.1)',
                  color: 'rgba(154, 184, 214, 0.95)',
                  fontSize: 'var(--naksha-fs-xs)',
                }}
                title="Append a note to this thought without leaving the map — Enter commits, Esc cancels (undo available)"
              >
                ✍ Note
              </button>
              <button
                type="button"
                onClick={() => relocateCardNode(visibleCard.card.key)}
                className="cursor-pointer rounded px-1.5 py-0.5 font-mono"
                style={{
                  border: '1px solid color-mix(in srgb, var(--naksha-purple) 40%, transparent)',
                  background: 'color-mix(in srgb, var(--naksha-purple) 10%, transparent)',
                  color: 'var(--naksha-purple)',
                  fontSize: 'var(--naksha-fs-xs)',
                }}
                title="Relocate this thought to the current map center (the crosshair marks the target) — pinnode parity, undo available"
              >
                ◎ Move to center
              </button>
              <button
                type="button"
                onClick={() => unpinCardNode(visibleCard.card.key)}
                className="cursor-pointer rounded px-1.5 py-0.5 font-mono"
                style={{
                  border: '1px solid rgba(192, 91, 77, 0.35)',
                  background: 'rgba(192, 91, 77, 0.08)',
                  color: 'rgba(224, 132, 122, 0.95)',
                  fontSize: 'var(--naksha-fs-xs)',
                }}
                title="Remove this thought's location — the marker disappears (undo available)"
              >
                ✕ Unpin
              </button>
            </div>
            {/* Task 39 — inline note input: appears under the actions when
                "✍ Note" is armed. Blue steel family (the notes' identity in
                the tree's gold pill is the only exception). Enter/blur
                commits, Esc cancels; the card stays open either way so a
                second note can follow immediately. */}
            {noting && (
              <input
                ref={noteInputRef}
                defaultValue=""
                autoFocus
                spellCheck={false}
                maxLength={500}
                placeholder="note text · Enter to append"
                aria-label="New note text"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitCardNote();
                  } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    noteCancelledRef.current = true;
                    setNoting(false);
                  }
                }}
                onBlur={() => {
                  if (noteCancelledRef.current) {
                    noteCancelledRef.current = false;
                    return;
                  }
                  commitCardNote();
                }}
                style={{
                  width: '100%',
                  marginTop: 6,
                  background: 'color-mix(in srgb, var(--naksha-info) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--naksha-info) 45%, transparent)',
                  borderRadius: 4,
                  color: 'var(--naksha-text, #eef1f7)',
                  fontFamily: 'inherit',
                  fontSize: 11,
                  padding: '3px 6px',
                  outline: 'none',
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** `35.712N 51.475E` style coordinate — same format the terminal uses. */
function formatCoord(v: number, hemi: 'NS' | 'EW'): string {
  return `${Math.abs(v).toFixed(3)}${v >= 0 ? hemi[0] : hemi[1]}`;
}

/** Anchor the info card to its marker: project the LatLng into container
 *  pixels and clamp the 252px card inside the pane (above the marker;
 *  flips below when there is no room). Called from the marker CLICK
 *  handler only — never during render (react-hooks/refs) — and the card
 *  closes on the first map move, so the projection can't go stale. */
function computeCardPos(lat: number, lng: number): { left: number; top: number } {
  const CARD_W = 252;
  const CARD_H = 118;
  if (!MapEngine.map) return { left: 16, top: 64 };
  const cp = MapEngine.map.latLngToContainerPoint([lat, lng]);
  const size = MapEngine.map.getContainer();
  const w = size.clientWidth || 800;
  const h = size.clientHeight || 600;
  let left = cp.x - CARD_W / 2;
  left = Math.max(8, Math.min(left, w - CARD_W - 8));
  let top = cp.y - 24 - CARD_H;
  if (top < 8) top = cp.y + 24;
  top = Math.max(8, Math.min(top, h - CARD_H - 8));
  return { left, top };
}

/* ──────────────────────────────────────────────────────────────────
   Small glass chip — pill with a label + value
   ────────────────────────────────────────────────────────────────── */
function Chip({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-[var(--naksha-border)] bg-[color-mix(in_srgb,var(--naksha-bg)_82%,transparent)] px-2.5 py-1 font-mono text-[length:var(--naksha-fs-xs)] text-[var(--naksha-text-2)] backdrop-blur">
      {label ? (
        <span className="text-[var(--naksha-text-3)]">{label}</span>
      ) : null}
      <span
        className={[
          'text-[var(--naksha-gold)] font-medium',
          mono ? 'tabular-nums' : '',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  );
}

export default MapPane;
