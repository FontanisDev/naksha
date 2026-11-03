'use client';

/**
 * Naksha — NodeQuickJump
 *
 * A fuzzy node finder (like Ctrl+P in VS Code). Opens with Ctrl+P or the
 * `jump` command. Lets you instantly navigate to any node in the current
 * network by typing a few letters. Shows the breadcrumb path for each
 * match so you can distinguish same-named nodes.
 *
 * Performance: only mounts when open. Pure DOM, no canvas.
 */

import { useMemo, useState, useCallback, useEffect } from 'react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command';
import { CareSpace } from '@/lib/naksha/carespace';
import { useNaksha } from '@/lib/naksha/store';
import type { CareNode } from '@/lib/naksha/types';

interface JumpEntry {
  id: string;
  label: string;
  path: string;
  notes: number;
  hasLocation: boolean;
  networkName: string;
  networkColor: string;
}

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  // Fuzzy: every char of query appears in order in text
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function buildPath(nodeId: string): string {
  const net = CareSpace.currentNetwork();
  const parts: string[] = [];
  let cur: CareNode | null = net.nodes[nodeId] ?? null;
  while (cur) {
    parts.unshift(cur.label);
    cur = cur.parentId ? net.nodes[cur.parentId] : null;
  }
  return parts.join(' / ');
}

export interface NodePick {
  networkName: string;
  nodeId: string;
  label: string;
}

export function NodeQuickJump({
  open,
  onOpenChange,
  pickMode = false,
  onPick,
  pickTitle,
  pickDescription,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When true, selecting a node calls `onPick` instead of navigating —
   *  used by the Workspace "⇒ Node" attach flow (and any future
   *  pick-a-node surface). The dialog never mutates CareSpace in this
   *  mode; the caller owns the mutation + undo snapshot. */
  pickMode?: boolean;
  onPick?: (pick: NodePick) => void;
  /** Optional wording overrides — the Workspace "↳ under node…" flow
   *  reuses this dialog to pick a PARENT instead of an attach target. */
  pickTitle?: string;
  pickDescription?: string;
}) {
  const [query, setQuery] = useState('');
  const careRevision = useNaksha((s) => s.careRevision);
  /* Task 100 — the query re-seeds on EVERY open transition. Before this
   * the dialog wore its last filter on reopen (the Task 98 palette
   * disease, second host: the keyed <div> below remounts DOM, never this
   * component's state). setJumpOpen rewrites jumpQuery each call, so the
   * Ctrl+P toggle opens empty while `jump <text>` opens searching. The
   * seed runs as the React-endorsed render-adjust idiom (guarded setState
   * while rendering, no effect) — the lint's set-state-in-effect rule
   * rejects the effect form. */
  const jumpQuery = useNaksha((s) => s.jumpQuery);
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setQuery(jumpQuery);
  }

  // Collect all nodes from ALL networks (so you can jump across networks too).
  const allEntries = useMemo<JumpEntry[]>(() => {
    if (!open) return [];
    void careRevision; // re-collect on care changes
    const entries: JumpEntry[] = [];
    for (const net of CareSpace.networks()) {
      const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null);
      if (!rootId) continue;
      const walk = (nodeId: string) => {
        const node = net.nodes[nodeId];
        if (!node) return;
        entries.push({
          id: node.id,
          label: node.label,
          path: buildPathForNet(net.nodes, nodeId),
          notes: node.notes.length,
          hasLocation: !!node.location,
          networkName: net.name,
          networkColor: net.color,
        });
        node.children.forEach(walk);
      };
      walk(rootId);
    }
    return entries;
  }, [open, careRevision]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allEntries;
    return allEntries.filter(
      (e) => fuzzyMatch(query, e.label) || fuzzyMatch(query, e.path),
    );
  }, [allEntries, query]);

  // Group by network for display
  const grouped = useMemo(() => {
    const groups: Record<string, JumpEntry[]> = {};
    for (const e of filtered) {
      if (!groups[e.networkName]) groups[e.networkName] = [];
      groups[e.networkName].push(e);
    }
    return groups;
  }, [filtered]);

  const handleSelect = useCallback(
    (entry: JumpEntry) => {
      // Pick mode: hand the choice to the caller, mutate nothing here.
      if (pickMode && onPick) {
        onPick({ networkName: entry.networkName, nodeId: entry.id, label: entry.label });
        onOpenChange(false);
        return;
      }
      // Switch to the entry's network, then set currentId.
      const net = CareSpace.networks().find((n) => n.name === entry.networkName);
      if (!net) return;
      if (CareSpace.currentNetwork().name !== entry.networkName) {
        CareSpace.switchNetwork(net.name);
      }
      net.currentId = entry.id;
      CareSpace.save();
      useNaksha.getState().syncCare();
      useNaksha.getState().print(`Jumped to: ${entry.label}`, 'info');
      onOpenChange(false);
    },
    [onOpenChange, onPick, pickMode],
  );

  const dialogKey = open ? 'open' : 'closed';

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={pickMode ? pickTitle || 'Attach to Node' : 'Jump to Node'}
      description={
        pickMode
          ? pickDescription ||
            'Pick the node this shape should attach to — it gets pinned at the shape\u2019s real-world position.'
          : 'Search and jump to any CareSpace node. Fuzzy match on name or path.'
      }
      className="naksha-glass-strong !rounded-xl border-[var(--naksha-border-2)] max-w-[560px]"
    >
      <div key={dialogKey}>
        <JumpStyles />
        {/* In pickMode the dialog may open above the fullscreen Workspace
            overlay (z-[3000]) — radix defaults to z-50, which renders it
            INVISIBLE under the workspace. Mount a scoped z-bump while the
            pick dialog is open (removed with it, so normal jump/palette
            stacking is untouched). */}
        {pickMode && open && (
          <style>{`
            [data-slot="dialog-overlay"], [data-slot="dialog-content"] {
              z-index: 5000 !important;
            }
          `}</style>
        )}
        <CommandInput
          placeholder="Type a node name or path…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No nodes found.</CommandEmpty>
          {Object.entries(grouped).map(([netName, entries]) => (
            <CommandGroup
              key={netName}
              heading={netName}
            >
              {entries.slice(0, 50).map((e) => (
                <JumpItem key={e.id} entry={e} onSelect={handleSelect} />
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        <CommandSeparator />
        <div
          style={{
            padding: '8px 12px',
            fontSize: 'var(--naksha-fs-xs)',
            color: 'var(--naksha-text-4)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>{pickMode ? '↑↓ navigate · ↵ attach · Esc cancel' : '↑↓ navigate · ↵ jump · Esc close'}</span>
          <span>{filtered.length} {filtered.length === 1 ? 'match' : 'matches'}</span>
        </div>
      </div>
    </CommandDialog>
  );
}

function buildPathForNet(nodes: Record<string, CareNode>, nodeId: string): string {
  const parts: string[] = [];
  let cur: CareNode | null = nodes[nodeId] ?? null;
  while (cur) {
    parts.unshift(cur.label);
    cur = cur.parentId ? nodes[cur.parentId] : null;
  }
  return parts.join(' / ');
}

function JumpItem({
  entry,
  onSelect,
}: {
  entry: JumpEntry;
  onSelect: (e: JumpEntry) => void;
}) {
  return (
    <CommandItem
      value={`${entry.label} ${entry.path}`}
      onSelect={() => onSelect(entry)}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: entry.networkColor,
          flexShrink: 0,
          boxShadow: `0 0 4px ${entry.networkColor}66`,
        }}
      />
      <span
        style={{
          fontWeight: 500,
          color: 'var(--naksha-gold-light)',
          minWidth: '100px',
          fontSize: 'var(--naksha-fs-sm)',
        }}
      >
        {entry.label}
      </span>
      <span
        style={{
          color: 'var(--naksha-text-3)',
          fontSize: 'var(--naksha-fs-xs)',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.path}
      </span>
      {entry.notes > 0 && (
        <span
          style={{
            color: 'var(--naksha-gold)',
            fontSize: 'var(--naksha-fs-xs)',
          }}
        >
          {entry.notes}
        </span>
      )}
      {entry.hasLocation && (
        <span style={{ color: 'var(--naksha-info)', fontSize: 'var(--naksha-fs-xs)' }}>◉</span>
      )}
    </CommandItem>
  );
}

function JumpStyles() {
  return (
    <style>{`
      [data-slot="dialog-content"] {
        background: var(--naksha-glass-strong) !important;
        backdrop-filter: blur(20px) saturate(140%) !important;
        -webkit-backdrop-filter: blur(20px) saturate(140%) !important;
        border: 1px solid var(--naksha-border-2) !important;
        box-shadow: var(--naksha-shadow-elevated) !important;
      }
      [data-slot="dialog-overlay"] {
        background: color-mix(in srgb, var(--naksha-scrim) 70%, transparent) !important;
        backdrop-filter: blur(4px) !important;
        -webkit-backdrop-filter: blur(4px) !important;
      }
      [cmdk-input] {
        color: var(--naksha-text) !important;
        font-size: var(--naksha-fs-md) !important;
      }
      [cmdk-input]::placeholder { color: var(--naksha-text-4) !important; }
      [cmdk-group-heading] {
        color: var(--naksha-text-3) !important;
        font-size: var(--naksha-fs-xs) !important;
        font-weight: 500 !important;
                padding: 8px 12px 4px !important;
      }
      [cmdk-item] {
        color: var(--naksha-text-2) !important;
        font-size: var(--naksha-fs-sm) !important;
        border-radius: 6px !important;
        padding: 8px 12px !important;
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
      }
      [cmdk-item][data-selected="true"] {
        background: color-mix(in srgb, var(--naksha-gold) 12%, transparent) !important;
        color: var(--naksha-gold-light) !important;
      }
      [cmdk-empty] {
        color: var(--naksha-text-4) !important;
        font-size: var(--naksha-fs-sm) !important;
        padding: 24px !important;
        text-align: center !important;
      }
      [cmdk-list] { max-height: 360px !important; overflow-y: auto !important; }
      [cmdk-list]::-webkit-scrollbar { width: 6px; }
      [cmdk-list]::-webkit-scrollbar-thumb {
        background: var(--naksha-border-2);
        border-radius: 3px;
      }
    `}</style>
  );
}

export default NodeQuickJump;
