'use client';

/**
 * Naksha — TimelineView
 *
 * A visual chronological timeline of all CareSpace notes across all
 * networks. Opens as a fullscreen overlay (like Focus Mode) showing
 * notes grouped by day, with a vertical gold spine and node-colored
 * dots for each entry.
 *
 * Triggered by the `timeline view` command (or `tlview`).
 * Closes on Esc or `done`.
 *
 * Performance: only mounts when open. Pure DOM (no canvas) — the
 * note count is typically small. Scrolls naturally.
 */

import { useEffect, useMemo } from 'react';
import { NotebookText } from 'lucide-react';
import { CareSpace } from '@/lib/naksha/carespace';
import { useNaksha } from '@/lib/naksha/store';
import { EmptyState } from '@/components/naksha/EmptyState';
import { PanelHeader } from '@/components/naksha/PanelPrimitives';
import { formatTime, timeAgo } from '@/lib/naksha/utils';

interface TimelineEntry {
  text: string;
  timestamp: number;
  timeString: string;
  nodeLabel: string;
  nodePath: string;
  networkName: string;
  networkColor: string;
  nodeId: string;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(ts: number): string {
  const today = startOfDay(Date.now());
  const that = startOfDay(ts);
  const diff = (today - that) / 86_400_000;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return new Date(ts).toLocaleDateString('en-US', { weekday: 'long' });
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function TimelineView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const careRevision = useNaksha((s) => s.careRevision);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Collect all notes from all networks, sorted newest-first.
  const entries = useMemo<TimelineEntry[]>(() => {
    if (!open) return [];
    void careRevision; // re-collect on care changes
    const out: TimelineEntry[] = [];
    for (const net of CareSpace.networks()) {
      const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null);
      if (!rootId) continue;
      const walk = (nodeId: string, path: string) => {
        const node = net.nodes[nodeId];
        if (!node) return;
        const currentPath = path ? `${path}/${node.label}` : node.label;
        for (const note of node.notes) {
          out.push({
            text: note.text,
            timestamp: note.timestamp,
            timeString: note.timeString,
            nodeLabel: node.label,
            nodePath: currentPath,
            networkName: net.name,
            networkColor: net.color,
            nodeId: node.id,
          });
        }
        node.children.forEach((cid) => walk(cid, currentPath));
      };
      walk(rootId, '');
    }
    out.sort((a, b) => b.timestamp - a.timestamp);
    return out;
  }, [open, careRevision]);

  // Group by day
  const grouped = useMemo(() => {
    const groups: Array<{ day: string; items: TimelineEntry[] }> = [];
    let currentDay = '';
    for (const e of entries) {
      const dl = dayLabel(e.timestamp);
      if (dl !== currentDay) {
        groups.push({ day: dl, items: [] });
        currentDay = dl;
      }
      groups[groups.length - 1].items.push(e);
    }
    return groups;
  }, [entries]);

  if (!open) return null;

  return (
    <div
      /* Task 111 — the fullscreen surface joins the dialog-sweep
       * discipline: it announces itself (role + label) but does NOT
       * claim aria-modal — nothing traps focus here, Esc is the
       * door, and an announced contract the UI doesn't keep is worse
       * than silence (Task 108's rule). */
      role="dialog"
      aria-label="Timeline — every note across all networks, newest first"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 4000,
        display: 'flex',
        flexDirection: 'column',
        /* Task 95 — the root rides the THEME paper (color-mix re-resolves
         * on theme change), replacing the frozen near-black slab that
         * ghosted the themed inks on light papers. The blur(20px) is
         * dropped, not themed: a 97%-opaque fullscreen surface has
         * nothing behind it worth blurring, and the CPU perf budget
         * says every pointless backdrop-filter dies. */
        background: 'color-mix(in srgb, var(--naksha-bg) 97%, transparent)',
      }}
    >
      {/* Header — Task 113: the shared PanelHeader (no glow, no tracking,
          shared Esc chip) at the fullscreen surface's own metrics. */}
      <PanelHeader
        title="Timeline"
        meta={`${entries.length} ${entries.length === 1 ? 'note' : 'notes'} · across ${CareSpace.networks().length} ${CareSpace.networks().length === 1 ? 'network' : 'networks'}`}
        dot="var(--naksha-gold)"
        onClose={onClose}
        closeLabel="timeline"
        style={{ height: 56, padding: '0 24px' }}
      />

      {/* Body */}
      <div
        className="naksha-scroll"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '32px 24px',
        }}
      >
        {entries.length === 0 ? (
          <EmptyState
            icon={<NotebookText size={22} strokeWidth={1.5} />}
            title="No notes yet"
            style={{ padding: '80px 20px' }}
            hint={
              <>
                Use <code style={{ color: 'var(--naksha-gold-light)' }}>save &lt;text&gt; to &lt;node&gt;</code> to
                capture thoughts.
              </>
            }
          />
        ) : (
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            {grouped.map((group) => (
              <div key={group.day} style={{ marginBottom: 32 }}>
                {/* Day header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    marginBottom: 16,
                  }}
                >
                  <span
                    style={{
                      fontSize: 'var(--naksha-fs-xs)',
                      fontWeight: 600,
                      color: 'var(--naksha-gold-light)',
                    }}
                  >
                    {group.day}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      height: 1,
                      background: 'linear-gradient(90deg, var(--naksha-border-2), transparent)',
                    }}
                  />
                  <span
                    style={{
                      fontSize: 'var(--naksha-fs-xs)',
                      color: 'var(--naksha-text-4)',
                    }}
                  >
                    {group.items.length}
                  </span>
                </div>

                {/* Entries */}
                <div style={{ position: 'relative', paddingLeft: 28 }}>
                  {/* Vertical spine */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 7,
                      top: 0,
                      bottom: 0,
                      width: 1,
                      background: 'linear-gradient(180deg, var(--naksha-border-2) 0%, var(--naksha-border) 100%)',
                    }}
                  />
                  {group.items.map((e, i) => (
                    <TimelineEntry key={`${e.nodeId}-${e.timestamp}-${i}`} entry={e} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineEntry({ entry }: { entry: TimelineEntry }) {
  return (
    <div
      style={{
        position: 'relative',
        marginBottom: 18,
        paddingLeft: 0,
      }}
    >
      {/* Dot on the spine */}
      <span
        style={{
          position: 'absolute',
          left: -25,
          top: 6,
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: entry.networkColor,
          border: '2px solid var(--naksha-bg)',
        }}
      />
      {/* Time */}
      <div
        style={{
          fontSize: 'var(--naksha-fs-xs)',
          color: 'var(--naksha-text-3)',
          marginBottom: 4,
        }}
      >
        {entry.timeString} · {timeAgo(entry.timestamp)}
      </div>
      {/* Note text */}
      <div
        style={{
          fontSize: 'var(--naksha-fs-md)',
          lineHeight: 1.6,
          color: 'var(--naksha-text)',
          background: 'color-mix(in srgb, var(--naksha-wash) 50%, transparent)',
          border: '1px solid var(--naksha-border)',
          borderLeft: `2px solid ${entry.networkColor}`,
          borderRadius: '0 6px 6px 0',
          padding: '10px 14px',
          marginBottom: 4,
        }}
      >
        {entry.text}
      </div>
      {/* Node path */}
      <div
        style={{
          fontSize: 'var(--naksha-fs-xs)',
          color: 'var(--naksha-text-3)',
        }}
      >
        <span style={{ color: entry.networkColor }}>●</span> {entry.networkName} / {entry.nodePath}
      </div>
    </div>
  );
}

export default TimelineView;
