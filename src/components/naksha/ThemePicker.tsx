'use client';

/**
 * Naksha — ThemePicker
 *
 * A visual theme swatch picker. Opens with the `themes` command (when
 * no arg is given) or via the command palette. Shows all 7 themes as
 * cards with color swatches + names + descriptions. Clicking a card
 * switches the theme instantly.
 *
 * Performance: only mounts when open. Pure DOM.
 */

import { useEffect } from 'react';
import { THEMES, getTheme } from '@/lib/naksha/themes';
import { useNaksha } from '@/lib/naksha/store';
import { ScrimDialog, PanelHeader } from '@/components/naksha/PanelPrimitives';

export function ThemePicker({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const currentThemeId = useNaksha((s) => s.settings.themeId);

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

  const handleSelect = (themeId: string) => {
    useNaksha.getState().setSettings({ themeId });
    const theme = getTheme(themeId);
    useNaksha.getState().print(`Theme: ${theme.name} — ${theme.description}`, 'success');
    onClose();
  };

  return (
    /* Task 99 — naksha-scrim: same perf-low hook as the other scrims. */
    <ScrimDialog
      onClose={onClose}
      zIndex={4500}
      width="min(720px, 92vw)"
      maxHeight="85vh"
      label="Theme picker"
    >
      {/* Header */}
      <PanelHeader
        title="Choose a Theme"
        meta={`${THEMES.length} palettes · click to apply`}
        dot="var(--naksha-gold)"
        onClose={onClose}
        closeLabel="theme picker"
      />

        {/* Theme grid */}
        <div
          style={{
            padding: '20px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: '14px',
            overflowY: 'auto',
          }}
        >
          {THEMES.map((theme) => {
            const isActive = theme.id === currentThemeId;
            return (
              <button
                key={theme.id}
                onClick={() => handleSelect(theme.id)}
                aria-pressed={isActive}
                style={{
                  background: isActive
                    ? 'color-mix(in srgb, var(--naksha-gold) 8%, transparent)'
                    : 'color-mix(in srgb, var(--naksha-wash) 50%, transparent)',
                  border: isActive
                    ? '1px solid var(--naksha-gold)'
                    : '1px solid var(--naksha-border)',
                  borderRadius: '10px',
                  padding: '14px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  transition: 'all 0.15s ease',
                  position: 'relative',
                  boxShadow: isActive
                    ? '0 0 16px color-mix(in srgb, var(--naksha-gold) 25%, transparent), inset 0 1px 0 rgba(238, 241, 247, 0.1)'
                    : 'none',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.borderColor = 'var(--naksha-border-2)';
                    /* v138 T3 — was the frozen old amber-night glass literal
                     * rgba(50,45,38,0.6); rides the theme token now. */
                    e.currentTarget.style.background = 'var(--naksha-glass-2)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.borderColor = 'var(--naksha-border)';
                    e.currentTarget.style.background = 'color-mix(in srgb, var(--naksha-wash) 50%, transparent)';
                  }
                }}
              >
                {/* Active badge */}
                {isActive && (
                  <span
                    style={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      fontSize: 'var(--naksha-fs-xs)',
                      color: 'var(--naksha-gold-light)',
                      background: 'color-mix(in srgb, var(--naksha-gold) 18%, transparent)',
                      border: '1px solid var(--naksha-gold)',
                      borderRadius: 3,
                      padding: '1px 6px',
                    }}
                  >
                    active
                  </span>
                )}

                {/* Swatch preview — 4 color dots */}
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  {theme.swatch.map((color, i) => (
                    <span
                      key={i}
                      style={{
                        width: '22px',
                        height: '22px',
                        borderRadius: '50%',
                        background: color,
                        border: '1px solid rgba(255,255,255,0.1)',
                      }}
                    />
                  ))}
                </div>

                {/* Name */}
                <div
                  style={{
                    fontSize: 'var(--naksha-fs-md)',
                    fontWeight: 600,
                    color: isActive ? 'var(--naksha-gold-light)' : 'var(--naksha-text)',
                  }}
                >
                  {theme.name}
                </div>

                {/* Description */}
                <div
                  style={{
                    fontSize: 'var(--naksha-fs-xs)',
                    color: 'var(--naksha-text-3)',
                    lineHeight: 1.5,
                  }}
                >
                  {theme.description}
                </div>

                {/* Mini preview — a tiny mock background using the theme's colors */}
                <div
                  style={{
                    height: 32,
                    borderRadius: 5,
                    marginTop: 2,
                    background: `
                      radial-gradient(ellipse 80% 50% at 50% 110%, ${theme.vars['--breath-1']}, transparent 60%),
                      linear-gradient(180deg, ${theme.vars['--bg-gradient-top']} 0%, ${theme.vars['--naksha-bg']} 50%, ${theme.vars['--bg-gradient-bottom']} 100%)
                    `,
                    position: 'relative',
                    overflow: 'hidden',
                    border: '1px solid rgba(255,255,255,0.05)',
                  }}
                >
                  {/* Tiny dot grid simulation */}
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      backgroundImage: `radial-gradient(circle, ${theme.vars['--naksha-dot-color']} 1px, transparent 1px)`,
                      backgroundSize: '8px 8px',
                      opacity: 0.8,
                    }}
                  />
                </div>
              </button>
            );
          })}
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
          <span>Click any theme to apply instantly</span>
          <span>Or use `theme &lt;id&gt;` in terminal</span>
        </div>
    </ScrimDialog>
  );
}

export default ThemePicker;
