'use client';

/**
 * Naksha — the geographic shell entry point.
 *
 * This is the only route visible to the user (`/`). It renders the
 * <Naksha /> shell, which lays out the Map / Terminal / CareSpace
 * panes, the sticky status bar, and the overlays.
 */

import dynamic from 'next/dynamic';

// Leaflet touches `window` on import, so we render the shell
// client-only. The DotGrid background and most components are safe
// but the MapPane pulls in Leaflet which must not run during SSR.
const Naksha = dynamic(() => import('@/components/naksha/Naksha'), {
  ssr: false,
  loading: () => (
    /* UI-calm pass: quiet boot screen. No pulse animation, no neon
     * tracking — the app loads in a blink; motion here only adds noise. */
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(180deg, #0e1013 0%, #15181c 100%)',
        color: '#9aa3b2',
        fontFamily: 'var(--font-inter), system-ui, sans-serif',
        fontSize: 13,
      }}
    >
      <span style={{ opacity: 0.75 }}>naksha · loading…</span>
    </div>
  ),
});

export default function Home() {
  return <Naksha />;
}
