'use client';

/**
 * Naksha — ShortcutsOverlay
 *
 * A `?`-key overlay showing all keyboard shortcuts. Pure presentational,
 * only mounts when open. Uses the warm glassmorphism design system.
 */

import { useEffect } from 'react';
import { ScrimDialog, PanelHeader } from '@/components/naksha/PanelPrimitives';

interface Shortcut {
  keys: string;
  action: string;
  category: string;
}

const SHORTCUTS: Shortcut[] = [
  // Global
  { keys: '/', action: 'Focus terminal input', category: 'Global' },
  { keys: '⌘/Ctrl + K', action: 'Open command palette', category: 'Global' },
  { keys: '⌘/Ctrl + P', action: 'Jump to node (fuzzy finder)', category: 'Global' },
  { keys: '?', action: 'Show this shortcuts overlay', category: 'Global' },
  { keys: 'Esc', action: 'Close overlays / cancel', category: 'Global' },
  { keys: '⌘/Ctrl + Z', action: 'Undo last destructive action', category: 'Global' },
  { keys: '⇧⌘/Ctrl + Z', action: 'Redo (re-apply what was undone)', category: 'Global' },
  // Terminal
  { keys: 'Enter', action: 'Execute command', category: 'Terminal' },
  { keys: 'Tab', action: 'Complete command name', category: 'Terminal' },
  { keys: '↑ / ↓', action: 'Navigate command history', category: 'Terminal' },
  { keys: 'Ctrl + R', action: 'Reverse search history', category: 'Terminal' },
  { keys: 'Ctrl + L', action: 'Clear terminal', category: 'Terminal' },
  { keys: 'Ctrl + C', action: 'Clear current input', category: 'Terminal' },
  // CareSpace
  { keys: 'Click node', action: 'Navigate into node', category: 'CareSpace' },
  { keys: 'Right-click node', action: 'Open node details', category: 'CareSpace' },
  { keys: 'Double-click node', action: 'Open node details', category: 'CareSpace' },
  { keys: 'Click ▶/▼', action: 'Collapse / expand branch', category: 'CareSpace' },
  { keys: 'Click header', action: 'Switch network', category: 'CareSpace' },
  { keys: 'Hover node', action: 'Show notes tooltip', category: 'CareSpace' },
  // Map
  { keys: 'Click map', action: 'Return focus to terminal', category: 'Map' },
  { keys: 'Scroll', action: 'Zoom map', category: 'Map' },
  { keys: 'Drag', action: 'Pan map', category: 'Map' },
  // Nano
  { keys: 'Ctrl + S', action: 'Save file in nano', category: 'Nano Editor' },
  { keys: 'Esc', action: 'Save and exit nano', category: 'Nano Editor' },
];

const CATEGORY_COLORS: Record<string, string> = {
  Global: 'var(--naksha-gold)',
  Terminal: 'var(--naksha-net-1)',
  CareSpace: 'var(--naksha-net-2)',
  Map: 'var(--naksha-net-3)',
  'Nano Editor': 'var(--naksha-warm)',
};

export function ShortcutsOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
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

  if (!open) return null;

  // Group by category
  const groups: Record<string, Shortcut[]> = {};
  SHORTCUTS.forEach((s) => {
    if (!groups[s.category]) groups[s.category] = [];
    groups[s.category].push(s);
  });

  return (
    <ScrimDialog
      onClose={onClose}
      zIndex={5000}
      width="min(620px, 90vw)"
      maxHeight="80vh"
      scroll={false}
      label="Keyboard shortcuts"
    >
      <PanelHeader title="Keyboard Shortcuts" onClose={onClose} closeLabel="shortcuts" />

      {/* Body */}
        <div
          className="naksha-scroll"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 20px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px 24px',
          }}
        >
          {Object.entries(groups).map(([cat, items]) => (
            <div key={cat}>
              <div
                style={{
                  fontSize: 'var(--naksha-fs-xs)',
                  fontWeight: 600,
                  color: CATEGORY_COLORS[cat] || 'var(--naksha-text-3)',
                  marginBottom: 8,
                  paddingBottom: 4,
                  borderBottom: `1px solid ${CATEGORY_COLORS[cat] || 'var(--naksha-border)'}`,
                  opacity: 0.85,
                }}
              >
                {cat}
              </div>
              {items.map((s, i) => (
                <div
                  key={`${cat}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 0',
                    fontSize: 'var(--naksha-fs-sm)',
                  }}
                >
                  <span style={{ color: 'var(--naksha-text-2)' }}>{s.action}</span>
                  <kbd
                    style={{
                      fontFamily: 'var(--naksha-font-mono)',
                      fontSize: 'var(--naksha-fs-xs)',
                      color: 'var(--naksha-gold-light)',
                      background: 'color-mix(in srgb, var(--naksha-gold) 8%, transparent)',
                      border: '1px solid var(--naksha-border-2)',
                      borderRadius: 4,
                      padding: '2px 8px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
    </ScrimDialog>
  );
}

export default ShortcutsOverlay;
