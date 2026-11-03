'use client';

/**
 * Naksha — NodeDetailsPanel
 *
 * A slide-in overlay on the CareSpace side showing the full details of
 * a selected node: all notes (with individual delete buttons), location
 * info, tags, links, and quick actions (fly to location, rename, delete).
 *
 * Triggered by right-clicking a node in the CareSpace canvas, or by the
 * `details <node>` command. Closes on Esc or clicking outside.
 *
 * Performance: only mounts when open. Pure DOM.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { StickyNote } from 'lucide-react';
import { CareSpace } from '@/lib/naksha/carespace';
import { useNaksha } from '@/lib/naksha/store';
import { EmptyState, SkeletonRows } from '@/components/naksha/EmptyState';
import { PanelHeader } from '@/components/naksha/PanelPrimitives';
import { MapEngine } from '@/lib/naksha/map-engine';
import { formatTime, timeAgo } from '@/lib/naksha/utils';
import { TAG_COLORS, TAG_PALETTE } from '@/lib/naksha/constants';
import { vaultMarkdownToHtml } from '@/lib/naksha/vault-markdown';
import { subscribeVaultEvents } from '@/lib/naksha/vault-sse';
import { careVaultReadNote } from '@/lib/naksha/care-vault';
import type { CareNode, NodeTag, UndoEntry } from '@/lib/naksha/types';

export function NodeDetailsPanel({
  nodeId,
  onClose,
}: {
  nodeId: string | null;
  onClose: () => void;
}) {
  /* Clicking a linked node in the Links section jumps the panel to that node
   * without touching the tree's currentId — a local override that resets
   * whenever the outer target changes or the panel closes. State is adjusted
   * during render (React's recommended pattern) so a prop change resets the
   * override without an effect. */
  const [overrideId, setOverrideId] = useState<string | null>(null);
  const [prevPropId, setPrevPropId] = useState(nodeId);
  if (prevPropId !== nodeId) {
    setPrevPropId(nodeId);
    setOverrideId(null);
  }
  const effectiveId = overrideId ?? nodeId;

  // Esc to close
  useEffect(() => {
    if (!effectiveId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [effectiveId, onClose]);

  if (!effectiveId) return null;
  // Keyed inner so confirm-delete state resets cleanly on node switch
  // without needing a setState-in-effect.
  return <NodeDetailsInner key={effectiveId} nodeId={effectiveId} onClose={onClose} onOpenNode={setOverrideId} />;
}

function NodeDetailsInner({
  nodeId,
  onClose,
  onOpenNode,
}: {
  nodeId: string;
  onClose: () => void;
  onOpenNode: (id: string) => void;
}) {
  const careRevision = useNaksha((s) => s.careRevision);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /* Task 49 — focus-notes arrival: when the deep link asked for it (the
   * graph's double-click) and this node HAS notes, the panel scrolls the
   * notes section to the top of the viewport and plays a ONE-SHOT gold
   * pulse on it (perf-gated — low tier gets the scroll, not the pulse).
   * Mount-time read: the inner component is keyed per node, so intent
   * can't leak across nodes. The 260ms delay lets the slideInRight
   * entrance finish before the scroll moves the stage. */
  const focusNotes = useRef(useNaksha.getState().detailsFocusNotes).current;
  const notesRef = useRef<HTMLDivElement | null>(null);
  const [notesPulse, setNotesPulse] = useState(false);
  useEffect(() => {
    if (!focusNotes) return;
    const node = CareSpace.getNode(nodeId);
    if (!node || node.notes.length === 0) return;
    const perfLow = useNaksha.getState().settings.perfMode === 'low';
    const t1 = setTimeout(() => {
      notesRef.current?.scrollIntoView({ block: 'start', behavior: perfLow ? 'auto' : 'smooth' });
      if (!perfLow) setNotesPulse(true);
    }, 260);
    const t2 = setTimeout(() => setNotesPulse(false), 1500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [focusNotes, nodeId]);

  const node: CareNode | null = nodeId ? CareSpace.getNode(nodeId) : null;

  /* ── Phase 5 — the BOUND NOTE: a thought bound to a real .md file
   * shows the FILE's content as its writing (fetched through the
   * read-only vault API, rendered with the same escape-first pipeline
   * as the vault reader). Re-fetches when the SSE watcher bumps
   * vaultRevision — an external edit surfaces here with a banner. A
   * missing file shows an honest broken state: no invented content. */
  const vaultRevision = useNaksha((s) => s.vaultRevision);
  const careMissing = useNaksha((s) => s.careVaultMissing);
  const boundRel = node?.vaultPath ?? null;
  const boundMissingFlag = boundRel ? !!careMissing[boundRel] : false;
  const [bound, setBound] = useState<{ rel: string; html: string } | null>(null);
  const [boundError, setBoundError] = useState<string | null>(null);
  const [boundBanner, setBoundBanner] = useState<string | null>(null);
  const boundRef = useRef<{ rel: string; mtimeMs: number } | null>(null);

  useEffect(() => {
    if (!boundRel) {
      boundRef.current = null;
      return;
    }
    let alive = true;
    void careVaultReadNote(boundRel).then((r) => {
      if (!alive) return;
      if (r.ok && typeof r.content === 'string') {
        const prev = boundRef.current;
        if (prev && prev.rel === boundRel && prev.mtimeMs !== r.mtimeMs) {
          const t = new Date().toLocaleTimeString();
          setBoundBanner(`changed externally — reloaded at ${t}`);
          window.setTimeout(() => setBoundBanner(null), 5000);
        }
        boundRef.current = { rel: boundRel, mtimeMs: r.mtimeMs ?? 0 };
        setBound({ rel: boundRel, html: vaultMarkdownToHtml(r.content, boundRel) });
        setBoundError(null);
      } else {
        boundRef.current = null;
        setBound(null);
        setBoundError(r.error ?? 'read failed');
      }
    });
    return () => {
      alive = false;
    };
  }, [boundRel, vaultRevision]);

  /* Phase 5 — the details panel joins the watcher contract: while a
   * bound note is shown, its subscription keeps the server watcher
   * alive even when the VaultPanel is closed, so an external edit
   * re-fetches the file here with the visible banner (the panel mounts
   * only while open — zero idle cost, same rule as Phase 2).
   * Rides the shared per-page EventSource instead of a twin stream. */
  useEffect(() => {
    if (!boundRel) return;
    return subscribeVaultEvents(() => useNaksha.getState().bumpVaultRevision());
  }, [boundRel]);

  const handleUnbind = useCallback(() => {
    if (!node?.vaultPath) return;
    const r = CareSpace.unbindNode(node.id);
    if (r.success) {
      useNaksha.getState().print(`Unbound "${node.label}" — the file was NOT touched`, 'success');
      useNaksha.getState().syncCare();
      void useNaksha.getState().refreshCareBoundState();
    }
  }, [node]);

  const handleOpenInVault = useCallback(() => {
    if (!node?.vaultPath) return;
    const s = useNaksha.getState();
    s.setVaultOpenFile(node.vaultPath);
    s.setVaultPanelOpen(true);
  }, [node]);

  /* Phase 6 — edit the REAL file with the REAL nano: opens the PTY
   * overlay for the bound path. The service re-validates the jail and
   * the create-gate; a refusal prints its honest error in the terminal. */
  const handleNanoEdit = useCallback(() => {
    if (!node?.vaultPath) return;
    const s = useNaksha.getState();
    if (s.vaultStatus?.connected === false) {
      s.print(`nano: no vault connected — the file for "${node.label}" lives in the real directory`, 'error');
      return;
    }
    s.print(`nano — [vault:${s.vaultStatus?.name ?? 'vault'}] ${node.vaultPath} · real nano, restricted mode · ^O save · ^X exit`, 'info');
    s.openNanoPty(node.vaultPath);
  }, [node]);

  /* Wikilinks inside the bound note resolve exactly like the vault
   * reader's — one delegated handler, resolved through the API. */
  const onBoundClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest?.('.vault-link') as HTMLElement | null;
    if (!el) return;
    const target = el.dataset.vaultTarget;
    if (!target) return;
    e.preventDefault();
    void fetch(`/api/vault/resolve?q=${encodeURIComponent(target)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: { ok: boolean; rel?: string | null }) => {
        const s = useNaksha.getState();
        if (data.ok && data.rel) {
          s.setVaultOpenFile(data.rel);
          s.setVaultPanelOpen(true);
        } else {
          s.print(`unresolved link: [[${target}]] — no note by that name in the vault`, 'error');
        }
      })
      .catch(() => {
        /* network hiccup — nothing to resolve against */
      });
  }, []);

  const refresh = useCallback(() => {
    useNaksha.getState().syncCare();
  }, []);

  const handleDeleteNote = useCallback(
    (index: number) => {
      if (!node) return;
      /* Snapshot BEFORE removing — `undo` restores the note. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `note ✕ ${node.label}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      CareSpace.removeNote(node.id, index);
      useNaksha.getState().setUndo(undo);
      refresh();
    },
    [node, refresh],
  );

  const handleFly = useCallback(() => {
    if (!node?.location) return;
    /* Task 44 — flyAndPulse: the panel's fly button gets the same arrival
     * pulse as every other programmatic flight (perf-low skips it). */
    MapEngine.flyAndPulse(node.location.lat, node.location.lng, node.location.zoom || 13);
    useNaksha.getState().print(`Flying to "${node.label}"`, 'info');
    onClose();
  }, [node, onClose]);

  const handleNavigate = useCallback(() => {
    if (!node) return;
    const net = CareSpace.currentNetwork();
    net.currentId = node.id;
    CareSpace.save();
    refresh();
    useNaksha.getState().print(`Navigated to: ${node.label}`, 'info');
    onClose();
  }, [node, refresh, onClose]);

  const handleDeleteNode = useCallback(() => {
    if (!node) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    /* Snapshot BEFORE removing — parity with the CLI's `rmnode` undo. */
    const undo: UndoEntry = {
      kind: 'care',
      label: `rmnode ${node.label}`,
      snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
      ts: Date.now(),
    };
    const r = CareSpace.removeNode(node.id);
    if (r.success) {
      useNaksha.getState().setUndo(undo);
      useNaksha.getState().print(`Removed "${node.label}" and ${r.data!.removedCount - 1} descendants — undo available`, 'success');
      refresh();
    }
    onClose();
  }, [node, confirmDelete, refresh, onClose]);

  const handleTag = useCallback(
    (tag: NodeTag) => {
      if (!node) return;
      /* Snapshot BEFORE retagging — `undo` restores the previous tags. */
      const undo: UndoEntry = {
        kind: 'care',
        label: `tag ${node.label} ${tag}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      CareSpace.setTag(node.id, tag);
      useNaksha.getState().setUndo(undo);
      refresh();
    },
    [node, refresh],
  );

  const handleUnlink = useCallback(
    (otherId: string) => {
      if (!node) return;
      const peer = CareSpace.getNode(otherId);
      const undo: UndoEntry = {
        kind: 'care',
        label: `unlink ${node.label} ↮ ${peer?.label ?? otherId}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.unlinkNodes(node.id, otherId);
      if (r.success) {
        useNaksha.getState().setUndo(undo);
        useNaksha.getState().print(`Unlinked "${node.label}" ↮ "${peer?.label ?? otherId}" — undo available`, 'success');
      }
      refresh();
    },
    [node, refresh],
  );

  const handleLinkLabel = useCallback(
    (otherId: string, label: string) => {
      if (!node) return;
      const peer = CareSpace.getNode(otherId);
      const undo: UndoEntry = {
        kind: 'care',
        label: `relabel ${node.label} ↔ ${peer?.label ?? otherId}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.setLinkLabel(node.id, otherId, label);
      if (r.success) {
        useNaksha.getState().setUndo(undo);
        if (label.trim()) {
          useNaksha.getState().print(`Relation "${node.label} ↔ ${peer?.label ?? otherId}" → "${label.trim()}" — undo available`, 'success');
        } else {
          useNaksha.getState().print(`Relation label cleared ("${node.label} ↔ ${peer?.label ?? otherId}") — undo available`, 'success');
        }
      }
      refresh();
    },
    [node, refresh],
  );

  if (!nodeId || !node) return null;

  const isRoot = node.parentId === null;
  /* Task 79 — the palette is the shared constant now (one spelling for
   * every tag surface), not a re-derivation from TAG_COLORS' keys. */
  const tagColors = TAG_PALETTE;

  /* Task 48 — CPU-ONLY fix: the full-screen overlay carried an INLINE
   * `backdropFilter: blur(3px)`, which the perf-low CSS overrides can't
   * reach (they target classes, not inline styles) — a live full-screen
   * blur on CPU-only machines for as long as the panel is open. Now
   * gated: perf-low machines get a plain translucent scrim. */
  const perfLow = useNaksha.getState().settings.perfMode === 'low';
  /* Task 48 — jump-arrival flash: a ONE-SHOT gold ring when the panel
   * was opened by a ⇥ deep link (fresh timestamp — self-expiring, so no
   * stale flashes and no clearing). Gated at the caller AND here; the
   * keyed remount makes this a mount-time read. */
  const flashTs = useNaksha.getState().detailsFlashTs;
  const flash = !perfLow && flashTs > 0 && Date.now() - flashTs < 1200;
  /* Phase 8 — the panel's entry animation follows the writing direction
   * (an RTL chrome slides it in from the START edge). Read at mount —
   * the moment the panel opens; dir cannot flip mid-animation. Kept as
   * plain string consts: a nested ternary template literal inside the
   * JSX style object tripped the browser-side transform (console:
   * "Expected '</>', got '@'"), so the ternary lives up here. */
  const slideIn =
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('dir') === 'rtl'
      ? 'slideInLeft'
      : 'slideInRight';
  const panelAnim = `${slideIn} 0.2s ease`;
  const panelAnimFlash = `${panelAnim}, nakshaDetailsFlash 0.9s ease-out`;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 3500,
        display: 'flex',
        justifyContent: 'flex-end',
        background: 'color-mix(in srgb, var(--naksha-scrim) 50%, transparent)',
        backdropFilter: perfLow ? 'none' : 'blur(3px)',
        WebkitBackdropFilter: perfLow ? 'none' : 'blur(3px)',
        animation: 'fadeIn 0.15s ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="naksha-glass-strong naksha-scroll"
        style={{
          width: 'min(420px, 90vw)',
          height: '100%',
          overflowY: 'auto',
          borderInlineStart: '1px solid var(--naksha-border-2)',
          borderRadius: 0,
          display: 'flex',
          flexDirection: 'column',
          /* Task 48 — the arrival ring must live in the INLINE animation
           * list: an inline `animation` beats any class animation, so a
           * class-only flash was silently swallowed by slideInRight.
           * Phase 8 — direction-aware entry (slideIn const above). */
          animation: flash ? panelAnimFlash : panelAnim,
        }}
      >
        <style>{`@keyframes slideInRight { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } } @keyframes slideInLeft { from { transform: translateX(-40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
        {/* Task 48 — the one-shot arrival ring: runs ONCE (no iteration,
            no persistent glow), only when perf tier allows. */}
        <style>{`@keyframes nakshaDetailsFlash {
          /* Task 113 — the arrival ring rides the ACTIVE accent (gold-light
           * token), not a frozen amber: keyframes resolve custom properties
           * against the animating element, and this <style> rides the JS
           * module graph (no CSS-pipeline folding). */
          0% { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--naksha-gold-light) 85%, transparent), 0 0 22px color-mix(in srgb, var(--naksha-gold-light) 45%, transparent); }
          100% { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--naksha-gold-light) 0%, transparent), 0 0 22px color-mix(in srgb, var(--naksha-gold-light) 0%, transparent); }
        }
        .naksha-details-flash { animation: nakshaDetailsFlash 0.9s ease-out 1; }
        /* Task 49 — the notes-focus pulse: a one-shot accent wash on the
           notes section when a deep link lands here deliberately (graph
           double-click on a thought with notes). Single run, no
           iteration, same accent as the panel ring — one arrival, one
           voice. */
        @keyframes nakshaNotesPulse {
          0% { background: color-mix(in srgb, var(--naksha-gold-light) 14%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--naksha-gold-light) 80%, transparent); }
          100% { background: color-mix(in srgb, var(--naksha-gold-light) 0%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--naksha-gold-light) 0%, transparent); }
        }
        .naksha-notes-pulse { animation: nakshaNotesPulse 1s ease-out 1; }`}</style>

        {/* Header — row 1 is now the shared PanelHeader bar (Task 114:
            same 52px metrics, hairline discipline and Esc chip as every
            other panel — the side-sheet's kicker row stops being a
            hand-rolled one-off). The node identity (label + breadcrumb)
            keeps its sub-header block below; both rows stay on glass-2
            with the bar's border suppressed, so the header still reads
            as one unit. */}
        <PanelHeader
          left={
            <span
              style={{
                fontSize: 'var(--naksha-fs-xs)',
                fontWeight: 500,
                color: 'var(--naksha-text-3)',
              }}
            >
              {isRoot ? 'Network Core' : 'Node'}
            </span>
          }
          onClose={onClose}
          closeLabel="node details"
          style={{ borderBottom: 'none' }}
        />
        <div
          style={{
            padding: '0 20px 16px',
            borderBottom: '1px solid var(--naksha-border)',
            background: 'var(--naksha-glass-2)',
          }}
        >
          <div
            style={{
              fontSize: 'var(--naksha-fs-lg)',
              fontWeight: 600,
              color: 'var(--naksha-gold-light)',
              lineHeight: 1.3,
              wordBreak: 'break-word',
            }}
          >
            {node.label}
          </div>
          {/* Breadcrumb path */}
          <PathBreadcrumb nodeId={node.id} />
        </div>

        {/* Stats row */}
        <div
          style={{
            display: 'flex',
            gap: 12,
            padding: '14px 20px',
            borderBottom: '1px solid var(--naksha-border)',
            fontSize: 'var(--naksha-fs-xs)',
          }}
        >
          <Stat label="children" value={node.children.length} />
          {/* Phase 5 — for a bound thought the writing is the FILE: the
           * stat says so instead of echoing the internal archive. */}
          <Stat label="notes" value={node.vaultPath ? (boundMissingFlag ? '⚠ gone' : '▤ file') : node.notes.length} />
          <Stat label="links" value={node.links.length} />
          <Stat label="location" value={node.location ? '◉' : '—'} />
        </div>

        {/* Actions */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            padding: '14px 20px',
            borderBottom: '1px solid var(--naksha-border)',
          }}
        >
          <ActionButton onClick={handleNavigate} disabled={isRoot} title="Navigate into this node">
            → Navigate
          </ActionButton>
          <ActionButton onClick={handleFly} disabled={!node.location} title="Fly to node location">
            ✈ Fly to
          </ActionButton>
          <ActionButton
            onClick={handleDeleteNode}
            disabled={isRoot}
            title={isRoot ? 'Cannot delete the core' : confirmDelete ? 'Click again to confirm' : 'Delete node'}
            danger={confirmDelete}
          >
            {confirmDelete ? '⚠ Confirm?' : '✕ Delete'}
          </ActionButton>
        </div>

        {/* Tags */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--naksha-border)' }}>
          <div
            style={{
              fontSize: 'var(--naksha-fs-xs)',
              fontWeight: 500,
              color: 'var(--naksha-text-3)',
              marginBottom: 8,
            }}
          >
            Color Tag
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <TagSwatch
              active={node.tags.length === 0}
              color="transparent"
              label="none"
              onClick={() => handleTag('none')}
            />
            {tagColors.map((tag) => (
              <TagSwatch
                key={tag}
                active={node.tags[0] === tag}
                color={TAG_COLORS[tag]}
                label={tag}
                onClick={() => handleTag(tag)}
              />
            ))}
          </div>
        </div>

        {/* Links — custom (non-hierarchical) relations, editable labels */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--naksha-border)' }}>
          <div
            style={{
              fontSize: 'var(--naksha-fs-xs)',
              fontWeight: 500,
              color: 'var(--naksha-text-3)',
              marginBottom: 8,
            }}
          >
            Links ({node.links.length})
          </div>
          {node.links.length === 0 ? (
            <div
              style={{
                padding: '10px 12px',
                color: 'var(--naksha-text-4)',
                fontSize: 'var(--naksha-fs-xs)',
                background: 'color-mix(in srgb, var(--naksha-wash) 35%, transparent)',
                border: '1px dashed var(--naksha-border)',
                borderRadius: 6,
              }}
            >
              no relations yet — <code style={{ color: 'var(--naksha-gold-light)' }}>link {node.label.slice(0, 18)} to &lt;node&gt; as &lt;label&gt;</code>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {node.links.map((otherId) => {
                const other = CareSpace.getNode(otherId);
                if (!other) return null;
                const currentLabel = CareSpace.getLinkLabel(node.id, otherId) ?? '';
                return (
                  <div
                    key={otherId}
                    className="naksha-link-row"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      background: 'color-mix(in srgb, var(--naksha-wash) 50%, transparent)',
                      border: '1px solid var(--naksha-border)',
                      borderRadius: 6,
                      padding: '6px 8px',
                    }}
                  >
                    {/* Violet ⇄ glyph matches the tree/graph link language */}
                    <span style={{ color: '#b39ddb', fontSize: 'var(--naksha-fs-sm)', flexShrink: 0 }} title="custom link">
                      ⇄
                    </span>
                    <button
                      onClick={() => onOpenNode(otherId)}
                      title="Open this node's details"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--naksha-gold-light)',
                        fontSize: 'var(--naksha-fs-xs)',
                        cursor: 'pointer',
                        padding: 0,
                        maxWidth: 110,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        textAlign: 'left',
                        flexShrink: 0,
                      }}
                    >
                      {other.label}
                    </button>
                    <input
                      defaultValue={currentLabel}
                      placeholder="add relation…"
                      maxLength={40}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur();
                        }
                      }}
                      onBlur={(e) => {
                        if (e.target.value !== currentLabel) handleLinkLabel(otherId, e.target.value);
                      }}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        background: 'var(--naksha-glass-2, rgba(26, 22, 17, 0.6))',
                        border: '1px solid var(--naksha-border)',
                        borderRadius: 4,
                        color: 'var(--naksha-gold-light, #ffe55c)',
                        fontSize: 'var(--naksha-fs-xs)',
                        padding: '3px 8px',
                        outline: 'none',
                      }}
                    />
                    <button
                      onClick={() => handleUnlink(otherId)}
                      title="Remove this link"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--naksha-text-4)',
                        cursor: 'pointer',
                        fontSize: 'var(--naksha-fs-md)',
                        padding: '0 2px',
                        lineHeight: 1,
                        flexShrink: 0,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--naksha-error)')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--naksha-text-4)')}
                    >
                      ⌫
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Bound real note (Phase 5) — the file IS this thought's
             writing. Read-only here (real edits are nano's job, Phase 6);
             external changes arrive via the watcher and reload with a
             visible banner; a deleted file shows a broken state, never
             invented content. ── */}
        {node.vaultPath && (
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--naksha-border)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
                gap: 8,
              }}
            >
              <span
                style={{
                  fontSize: 'var(--naksha-fs-xs)',
                  fontWeight: 500,
                  color: boundMissingFlag ? 'var(--naksha-error)' : 'var(--naksha-gold)',
                }}
              >
                {boundMissingFlag ? '⚠ bound note · file missing' : '▤ bound note'}
              </span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={handleNanoEdit}
                  title="Edit the REAL file with the real nano (PTY bridge — restricted to the connected directory; ^O saves to disk)"
                  className="font-mono"
                  style={{
                    fontSize: 'var(--naksha-fs-xs)',
                    color: 'var(--naksha-gold)',
                    background: 'color-mix(in srgb, var(--naksha-gold) 8%, transparent)',
                    border: '1px solid var(--naksha-gold-dim)',
                    borderRadius: 6,
                    padding: '2px 8px',
                    cursor: 'pointer',
                  }}
                >
                  ✎ nano
                </button>
                <button
                  onClick={handleOpenInVault}
                  title="Open this file in the vault panel reader"
                  className="font-mono"
                  style={{
                    fontSize: 'var(--naksha-fs-xs)',
                    color: 'var(--naksha-text-2)',
                    background: 'transparent',
                    border: '1px solid var(--naksha-border)',
                    borderRadius: 6,
                    padding: '2px 8px',
                    cursor: 'pointer',
                  }}
                >
                  vault ↗
                </button>
                <button
                  onClick={handleUnbind}
                  title="Detach this thought from the file (the file itself stays on disk, untouched)"
                  className="font-mono"
                  style={{
                    fontSize: 'var(--naksha-fs-xs)',
                    color: 'var(--naksha-text-2)',
                    background: 'transparent',
                    border: '1px solid var(--naksha-border)',
                    borderRadius: 6,
                    padding: '2px 8px',
                    cursor: 'pointer',
                  }}
                >
                  unbind
                </button>
              </span>
            </div>
            <div
              className="font-mono"
              style={{
                fontSize: 'var(--naksha-fs-xs)',
                color: 'var(--naksha-text-3)',
                marginBottom: 8,
                wordBreak: 'break-all',
              }}
              title={node.vaultPath}
            >
              {node.vaultPath} · the file is the writing — ✎ nano edits it in place
            </div>
            {boundBanner && (
              <div
                className="font-mono px-3 py-1 mb-2"
                role="status"
                style={{
                  fontSize: 'var(--naksha-fs-xs)',
                  color: 'var(--naksha-gold-light)',
                  background: 'color-mix(in srgb, var(--naksha-gold) 10%, transparent)',
                  border: '1px solid var(--naksha-gold-dim)',
                  borderRadius: 6,
                }}
              >
                ⟳ {boundBanner}
              </div>
            )}
            {boundMissingFlag || (boundError && /no such file/i.test(boundError)) ? (
              <div
                className="font-mono px-3 py-2"
                role="alert"
                style={{
                  fontSize: 'var(--naksha-fs-xs)',
                  lineHeight: 1.6,
                  color: 'var(--naksha-error)',
                  background: 'color-mix(in srgb, var(--naksha-error) 8%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--naksha-error) 35%, transparent)',
                  borderRadius: 6,
                }}
              >
                ⚠ the bound file is missing on disk — nothing is shown rather than
                inventing content. It was deleted or renamed outside Naksha:
                rebind it (<code>carebind {node.label} &lt;path.md&gt;</code>) or detach (unbind).
              </div>
            ) : boundError ? (
              <div
                className="font-mono px-3 py-2"
                style={{
                  fontSize: 'var(--naksha-fs-xs)',
                  color: 'var(--naksha-error)',
                  background: 'color-mix(in srgb, var(--naksha-error) 8%, transparent)',
                  borderRadius: 6,
                }}
              >
                ✗ {boundError}
              </div>
            ) : bound && bound.rel === node.vaultPath ? (
              <div
                onClick={onBoundClick}
                dir="auto"
                className="naksha-scroll"
                style={{
                  maxHeight: 320,
                  overflowY: 'auto',
                  border: '1px solid var(--naksha-border)',
                  borderRadius: 8,
                  background: 'color-mix(in srgb, var(--naksha-wash) 35%, transparent)',
                  padding: '12px 14px',
                  outline: 'none',
                }}
              >
                <article
                  className="reader-html text-[var(--naksha-text)] text-[12.5px] leading-[1.7] font-mono"
                  style={{ textAlign: 'start' }}
                  dangerouslySetInnerHTML={{ __html: bound.html }}
                />
              </div>
            ) : (
              /* Task 112 — a note-shaped load beats a bare mono line: the
               * skeleton rows announce themselves (role=status) and die the
               * moment the real HTML arrives. */
              <div style={{ padding: '8px 0' }}>
                <SkeletonRows rows={4} rowHeight={20} indent={false} />
              </div>
            )}
          </div>
        )}

        {/* Notes */}
        <div ref={notesRef} className={notesPulse ? 'naksha-notes-pulse' : undefined} style={{ padding: '14px 20px', flex: 1 }}>
          {node.vaultPath && node.notes.length === 0 ? null : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
            }}
          >
            <span
              style={{
                fontSize: 'var(--naksha-fs-xs)',
                fontWeight: 500,
                color: 'var(--naksha-text-3)',
              }}
            >
              {node.vaultPath ? `Archived internal notes (${node.notes.length})` : `Notes (${node.notes.length})`}
            </span>
          </div>
          )}
          {node.vaultPath && node.notes.length === 0 ? null : node.notes.length === 0 ? (
            <EmptyState
              compact
              icon={<StickyNote size={18} strokeWidth={1.5} />}
              title="No notes yet"
              hint={
                <>
                  Use <code style={{ color: 'var(--naksha-gold-light)' }}>save &lt;text&gt; to {node.label}</code>
                </>
              }
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[...node.notes].reverse().map((note, i) => {
                const realIndex = node.notes.length - 1 - i;
                return (
                  <div
                    key={`${note.timestamp}-${i}`}
                    style={{
                      background: 'color-mix(in srgb, var(--naksha-wash) 50%, transparent)',
                      border: '1px solid var(--naksha-border)',
                      /* Phase 8 — logical: the gold edge hugs the START
                       * side so RTL notes keep their accent bar. */
                      borderInlineStart: '2px solid var(--naksha-gold-dim)',
                      borderRadius: '0 6px 6px 0',
                      padding: '10px 14px',
                      position: 'relative',
                    }}
                  >
                    <div
                      dir="auto"
                      className="naksha-note-auto"
                      style={{
                        fontSize: 'var(--naksha-fs-md)',
                        lineHeight: 1.6,
                        color: 'var(--naksha-text)',
                        wordBreak: 'break-word',
                        whiteSpace: 'pre-wrap',
                        paddingInlineEnd: 24,
                      }}
                    >
                      {note.text}
                    </div>
                    <div
                      style={{
                        fontSize: 'var(--naksha-fs-xs)',
                        color: 'var(--naksha-text-4)',
                        marginTop: 6,
                      }}
                    >
                      {note.timeString} · {timeAgo(note.timestamp)}
                    </div>
                    <button
                      onClick={() => handleDeleteNote(realIndex)}
                      title="Delete note"
                      style={{
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--naksha-text-4)',
                        cursor: 'pointer',
                        fontSize: 'var(--naksha-fs-md)',
                        padding: 2,
                        lineHeight: 1,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--naksha-error)')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--naksha-text-4)')}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer meta */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--naksha-border)',
            background: 'var(--naksha-glass-2, rgba(26, 22, 17, 0.6))', /* Task 95 — theme glass footer */
            fontSize: 'var(--naksha-fs-xs)',
            color: 'var(--naksha-text-4)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>created {timeAgo(node.createdAt)}</span>
          <span>updated {timeAgo(node.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

function PathBreadcrumb({ nodeId }: { nodeId: string }) {
  const path = (() => {
    const net = CareSpace.currentNetwork();
    const out: string[] = [];
    let cur: CareNode | null = net.nodes[nodeId] ?? null;
    while (cur) {
      out.unshift(cur.label);
      cur = cur.parentId ? net.nodes[cur.parentId] : null;
    }
    return out;
  })();
  return (
    <div
      style={{
        fontSize: 'var(--naksha-fs-xs)',
        color: 'var(--naksha-text-3)',
        marginTop: 6,
        wordBreak: 'break-word',
      }}
    >
      {path.map((p, i) => (
        <span key={i}>
          {i > 0 && <span style={{ color: 'var(--naksha-text-4)' }}> / </span>}
          {p}
        </span>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ color: 'var(--naksha-text-4)', fontSize: 'var(--naksha-fs-xs)' }}>{label}</span>
      <span style={{ color: 'var(--naksha-gold-light)', fontSize: 'var(--naksha-fs-md)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: disabled
          ? 'transparent'
          : danger
            ? 'rgba(192, 91, 77, 0.12)'
            : 'color-mix(in srgb, var(--naksha-gold) 8%, transparent)',
        border: `1px solid ${disabled ? 'var(--naksha-border)' : danger ? 'var(--naksha-error)' : 'var(--naksha-border-2)'}`,
        borderRadius: 5,
        padding: '6px 12px',
        fontSize: 'var(--naksha-fs-xs)',
        color: disabled
          ? 'var(--naksha-text-4)'
          : danger
            ? 'var(--naksha-error)'
            : 'var(--naksha-gold-light)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all 0.15s ease',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function TagSwatch({
  active,
  color,
  label,
  onClick,
}: {
  active: boolean;
  color: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: color === 'transparent' ? 'rgba(255,255,255,0.04)' : color,
        border: active
          ? '2px solid var(--naksha-gold-light)'
          : `1px solid ${color === 'transparent' ? 'var(--naksha-border-2)' : color}`,
        cursor: 'pointer',
        padding: 0,
        boxShadow: active ? '0 0 8px color-mix(in srgb, var(--naksha-gold-light) 40%, transparent)' : 'none',
        transition: 'all 0.15s ease',
      }}
    />
  );
}

export default NodeDetailsPanel;
