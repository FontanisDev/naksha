/**
 * Naksha — EmptyState & SkeletonRows
 *
 * The designed replacements for raw mono strings in empty panels.
 * One voice for every "nothing here yet": a small icon, one calm
 * sentence, one optional hint line. One gentle pulse for list-shaped
 * loads (the ONLY infinite animation left in the app, and it dies the
 * moment real content arrives).
 */

import type { CSSProperties, ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  hint,
  compact = false,
  style,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  compact?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: compact ? '20px 16px' : '48px 24px',
        textAlign: 'center',
        ...style,
      }}
    >
      {icon && (
        <div style={{ color: 'var(--naksha-text-4)', marginBottom: 2 }} aria-hidden>
          {icon}
        </div>
      )}
      <div style={{ color: 'var(--naksha-text-2)', fontSize: 'var(--naksha-fs-sm)' }}>{title}</div>
      {hint && (
        <div
          style={{
            color: 'var(--naksha-text-4)',
            fontSize: 'var(--naksha-fs-xs)',
            maxWidth: 380,
            lineHeight: 1.6,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

const SKEL_WIDTHS = [72, 55, 84, 62, 48, 76, 58];

/** Quiet placeholder rows while a list-shaped resource loads. */
export function SkeletonRows({
  rows = 5,
  rowHeight = 22,
  gap = 6,
  indent = true,
  style,
}: {
  rows?: number;
  rowHeight?: number;
  gap?: number;
  indent?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap, padding: '8px 2px', ...style }}
      role="status"
      aria-label="Loading"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{
            height: rowHeight,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingInlineStart: indent ? (i % 3) * 12 : 0,
          }}
        >
          <div className="naksha-skel" style={{ width: 10, height: 10, borderRadius: 3, flexShrink: 0 }} />
          <div
            className="naksha-skel"
            style={{ width: `${SKEL_WIDTHS[i % SKEL_WIDTHS.length]}%`, height: 8, borderRadius: 4 }}
          />
        </div>
      ))}
    </div>
  );
}
