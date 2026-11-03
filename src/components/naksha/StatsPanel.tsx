'use client';

/**
 * Naksha — StatsPanel
 *
 * A visual statistics panel for CareSpace. Shows:
 *   • Network distribution (nodes + notes per network)
 *   • Top nodes by note count (bar chart)
 *   • Activity timeline (notes per day, last 7 days)
 *   • Tag distribution
 *
 * Triggered by the `statsview` command. Closes on Esc.
 *
 * Performance: only mounts when open. Pure SVG/CSS — no canvas.
 */

import { useEffect, useMemo } from 'react';
import { CareSpace } from '@/lib/naksha/carespace';
import { useNaksha } from '@/lib/naksha/store';
import { TAG_COLORS } from '@/lib/naksha/constants';
import { ScrimDialog, PanelHeader } from '@/components/naksha/PanelPrimitives';

interface NodeStat {
  label: string;
  notes: number;
  path: string;
  networkName: string;
  networkColor: string;
}

interface DayActivity {
  label: string;
  count: number;
  date: Date;
}

interface TagStat {
  tag: string;
  count: number;
  color: string;
}

interface NetworkStat {
  name: string;
  color: string;
  nodes: number;
  notes: number;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function StatsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const careRevision = useNaksha((s) => s.careRevision);

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

  // Compute all stats once per open (or when careRevision changes)
  const stats = useMemo(() => {
    if (!open) return null;
    void careRevision;

    // Network distribution
    const networks: NetworkStat[] = CareSpace.networks().map((net) => {
      const nodes = Object.keys(net.nodes).length;
      const notes = Object.values(net.nodes).reduce((s, n) => s + n.notes.length, 0);
      return { name: net.name, color: net.color, nodes, notes };
    });

    // Top nodes by note count
    const allNodes: NodeStat[] = [];
    for (const net of CareSpace.networks()) {
      const rootId = Object.keys(net.nodes).find((id) => net.nodes[id].parentId === null);
      if (!rootId) continue;
      const walk = (nodeId: string, path: string) => {
        const node = net.nodes[nodeId];
        if (!node) return;
        const currentPath = path ? `${path}/${node.label}` : node.label;
        if (node.notes.length > 0) {
          allNodes.push({
            label: node.label,
            notes: node.notes.length,
            path: currentPath,
            networkName: net.name,
            networkColor: net.color,
          });
        }
        node.children.forEach((cid) => walk(cid, currentPath));
      };
      walk(rootId, '');
    }
    const topNodes = allNodes.sort((a, b) => b.notes - a.notes).slice(0, 8);
    const maxNotes = topNodes[0]?.notes ?? 1;

    // Activity timeline (last 7 days)
    const now = Date.now();
    const days: DayActivity[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = startOfDay(now - i * 86400000);
      const dayEnd = dayStart + 86400000;
      const dayLabel = new Date(dayStart).toLocaleDateString('en-US', { weekday: 'short' });
      let count = 0;
      for (const net of CareSpace.networks()) {
        for (const node of Object.values(net.nodes)) {
          for (const note of node.notes) {
            if (note.timestamp >= dayStart && note.timestamp < dayEnd) count++;
          }
        }
      }
      days.push({ label: dayLabel, count, date: new Date(dayStart) });
    }
    const maxDayCount = Math.max(...days.map((d) => d.count), 1);

    // Tag distribution
    const tagMap = new Map<string, number>();
    for (const net of CareSpace.networks()) {
      for (const node of Object.values(net.nodes)) {
        for (const tag of node.tags) {
          if (tag === 'none') continue;
          tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1);
        }
      }
    }
    const tags: TagStat[] = Array.from(tagMap.entries()).map(([tag, count]) => ({
      tag,
      count,
      color: TAG_COLORS[tag] ?? '#888',
    }));

    const totalNodes = networks.reduce((s, n) => s + n.nodes, 0);
    const totalNotes = networks.reduce((s, n) => s + n.notes, 0);

    return { networks, topNodes, maxNotes, days, maxDayCount, tags, totalNodes, totalNotes };
  }, [open, careRevision]);

  if (!open || !stats) return null;

  return (
    <ScrimDialog
      onClose={onClose}
      zIndex={4400}
      width="min(760px, 94vw)"
      maxHeight="88vh"
      label="CareSpace statistics"
    >
      {/* Header */}
      <PanelHeader
        title="CareSpace Statistics"
        meta={`${stats.totalNodes} ${stats.totalNodes === 1 ? 'node' : 'nodes'} · ${stats.totalNotes} ${stats.totalNotes === 1 ? 'note' : 'notes'} · ${stats.networks.length} ${stats.networks.length === 1 ? 'network' : 'networks'}`}
        dot="var(--naksha-gold)"
        onClose={onClose}
        closeLabel="statistics"
      />

      {/* Body */}
        <div style={{ padding: '20px', overflowY: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          {/* Network distribution */}
          <Section title="Networks" color="var(--naksha-gold)">
            {stats.networks.map((net) => {
              const totalAll = stats.totalNotes || 1;
              const pct = (net.notes / totalAll) * 100;
              return (
                <div key={net.name} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: net.color }} />
                    <span style={{ fontSize: 'var(--naksha-fs-xs)', color: 'var(--naksha-text)', flex: 1 }}>
                      {net.name}
                    </span>
                    <span style={{ fontSize: 'var(--naksha-fs-xs)', color: 'var(--naksha-text-3)' }}>
                      {net.nodes}n · {net.notes} notes
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${pct}%`,
                        background: net.color,
                        borderRadius: 3,
                        transition: 'width 0.3s ease',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </Section>

          {/* Top nodes by notes */}
          <Section title="Top Nodes (by notes)" color="var(--naksha-net-1)">
            {stats.topNodes.length === 0 ? (
              <div style={{ color: 'var(--naksha-text-4)', fontSize: 'var(--naksha-fs-xs)' }}>
                No notes yet.
              </div>
            ) : (
              stats.topNodes.map((node, i) => {
                const pct = (node.notes / stats.maxNotes) * 100;
                return (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      <span style={{ fontSize: 'var(--naksha-fs-xs)', color: 'var(--naksha-gold-light)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {node.label}
                      </span>
                      <span style={{ fontSize: 'var(--naksha-fs-xs)', color: 'var(--naksha-text-3)' }}>
                        {node.notes}
                      </span>
                    </div>
                    <div style={{ height: 5, background: 'rgba(255,255,255,0.04)', borderRadius: 3, overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${pct}%`,
                          background: node.networkColor,
                          borderRadius: 3,
                        }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </Section>

          {/* Activity timeline (7 days) */}
          <Section title="Activity (7 days)" color="var(--naksha-net-3)">
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 80, paddingTop: 8 }}>
              {stats.days.map((day, i) => {
                const h = Math.max(2, (day.count / stats.maxDayCount) * 60);
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <div
                      style={{
                        width: '100%',
                        height: h,
                        background: day.count > 0
                          ? 'linear-gradient(180deg, var(--naksha-gold-light), var(--naksha-gold))'
                          : 'rgba(255,255,255,0.05)',
                        borderRadius: '3px 3px 0 0',
                        boxShadow: day.count > 0 ? '0 0 4px color-mix(in srgb, var(--naksha-gold) 30%, transparent)' : 'none',
                        transition: 'height 0.3s ease',
                      }}
                      title={`${day.count} notes`}
                    />
                    <span style={{ fontSize: 'var(--naksha-fs-xs)', color: 'var(--naksha-text-4)' }}>
                      {day.label.slice(0, 2)}
                    </span>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* Tag distribution */}
          <Section title="Color Tags" color="var(--naksha-net-2)">
            {stats.tags.length === 0 ? (
              <div style={{ color: 'var(--naksha-text-4)', fontSize: 'var(--naksha-fs-xs)' }}>
                No tags assigned.
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {stats.tags.map((t) => (
                  <div
                    key={t.tag}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px',
                      background: 'color-mix(in srgb, var(--naksha-wash) 50%, transparent)',
                      border: `1px solid ${t.color}33`,
                      borderRadius: 12,
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color }} />
                    <span style={{ fontSize: 'var(--naksha-fs-xs)', color: 'var(--naksha-text-2)' }}>
                      {t.tag}
                    </span>
                    <span style={{ fontSize: 'var(--naksha-fs-xs)', color: 'var(--naksha-gold-light)', fontWeight: 600 }}>
                      {t.count}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 20px',
            borderTop: '1px solid var(--naksha-border)',
            background: 'var(--naksha-glass-2, rgba(26, 22, 17, 0.6))', /* Task 95 — theme glass footer */
            fontSize: 'var(--naksha-fs-xs)',
            color: 'var(--naksha-text-4)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>Generated {new Date().toLocaleString()}</span>
          <span>Use `stats` for text summary · `statsview` for this panel</span>
        </div>
    </ScrimDialog>
  );
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 'var(--naksha-fs-xs)',
          fontWeight: 600,
          color,
          marginBottom: 12,
          paddingBottom: 4,
          borderBottom: `1px solid ${color}44`,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

export default StatsPanel;
