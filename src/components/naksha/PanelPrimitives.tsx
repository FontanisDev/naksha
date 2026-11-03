/**
 * Naksha — Panel primitives (Task 112)
 *
 * The five scrim modals (Stats, Shortcuts, ThemePicker, Perf, Vault) each
 * hand-rolled the same ~40-line scaffold — scrim div, centered glass panel,
 * 48-vs-52px header, Esc chip — and the copies had drifted: z-indexes
 * scattered 3500–5000, header heights 48/52, glow on some header dots and
 * not others, letter-spacing leftovers from the ALL-CAPS era. One scaffold,
 * one header, one Esc chip; the drift becomes impossible.
 *
 * Deliberately NOT migrated (different geometry by design): the timeline
 * fullscreen surface, the NodeDetails side-sheet (its own slide-in +
 * perf-low blur contract), the Workspace cursor menu, and the
 * mounted-but-hidden chrome (CommandPalette / NodeQuickJump / ReaderPanel).
 *
 * Calm-down notes carried in from earlier rounds: header dots keep the
 * diamond identity but LOSE the glow shadow (same treatment as the
 * StatusBar dots in round 1), titles drop letter-spacing, and the header
 * inherits the body's Inter — chrome is not mono.
 */

import type { CSSProperties, ReactNode } from 'react';

/** Common Esc-chip close button used by the centered modals. */
export function PanelEscButton({
  onClose,
  closeLabel,
}: {
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <button
      onClick={onClose}
      aria-label={`Close ${closeLabel} (Esc)`}
      style={{
        background: 'transparent',
        border: '1px solid var(--naksha-border-2)',
        borderRadius: 4,
        padding: '4px 12px',
        fontSize: 'var(--naksha-fs-xs)',
        color: 'var(--naksha-text-3)',
        cursor: 'pointer',
      }}
    >
      Esc
    </button>
  );
}

/**
 * Scrim + centered glass dialog. The click-outside-to-close contract every
 * modal already honors (scrim click = onClose, panel click stops
 * propagation) lives here once.
 */
export function ScrimDialog({
  onClose,
  zIndex,
  width,
  height,
  maxHeight,
  blur = true,
  scrimAlpha = 70,
  label,
  scroll = true,
  panelClassName,
  panelStyle,
  children,
}: {
  onClose: () => void;
  /** Kept per-modal on purpose — stacking order is behavior, not style. */
  zIndex: number;
  width: string;
  height?: string;
  maxHeight?: string;
  /** VaultPanel arrives without the blur; the rest blur 8px. */
  blur?: boolean;
  scrimAlpha?: number;
  /** Dialog aria-label (also names the Esc chip's aria-label). */
  label: string;
  scroll?: boolean;
  panelClassName?: string;
  panelStyle?: CSSProperties;
  children: ReactNode;
}) {
  const blurValue = blur ? 'blur(8px)' : undefined;
  return (
    /* Task 99 — naksha-scrim: the perf-low blur kill list targets
     * classes, so the backdrop keeps the class hook. */
    <div
      onClick={onClose}
      className="naksha-scrim"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: `color-mix(in srgb, var(--naksha-scrim) ${scrimAlpha}%, transparent)`,
        backdropFilter: blurValue,
        WebkitBackdropFilter: blurValue,
        animation: 'fadeIn 0.15s ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`naksha-glass-strong${scroll ? ' naksha-scroll' : ''}${panelClassName ? ` ${panelClassName}` : ''}`}
        role="dialog"
        aria-label={label}
        style={{
          width,
          height,
          maxHeight,
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          ...panelStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The standard 52px modal header: hairline bottom border, glass-2 strip,
 * diamond dot (no glow) + sentence-case title + optional meta on the left,
 * optional actions + Esc chip on the right. Pass `left` to replace the
 * dot/title/meta cluster wholesale (VaultPanel's status header does).
 */
export function PanelHeader({
  title,
  meta,
  dot,
  left,
  actions,
  onClose,
  closeLabel,
  style,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  /** Diamond dot color; omit to render no dot. */
  dot?: string;
  left?: ReactNode;
  actions?: ReactNode;
  /** When set, the standard Esc chip renders after `actions`. */
  onClose?: () => void;
  closeLabel?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        height: 52,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        gap: 12,
        borderBottom: '1px solid var(--naksha-border)',
        background: 'var(--naksha-glass-2)',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        {left ??
          (
            <>
              {dot && (
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: dot,
                    transform: 'rotate(45deg)',
                    display: 'inline-block',
                    flexShrink: 0,
                  }}
                />
              )}
              <span
                style={{
                  fontSize: 'var(--naksha-fs-md)',
                  fontWeight: 600,
                  color: 'var(--naksha-gold-light)',
                  whiteSpace: 'nowrap',
                }}
              >
                {title}
              </span>
              {meta && (
                <span style={{ fontSize: 'var(--naksha-fs-xs)', color: 'var(--naksha-text-3)' }}>
                  {meta}
                </span>
              )}
            </>
          )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {actions}
        {onClose && closeLabel && <PanelEscButton onClose={onClose} closeLabel={closeLabel} />}
      </div>
    </div>
  );
}
