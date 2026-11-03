'use client';

/**
 * Naksha — ReaderPanel
 *
 * A slide-in panel anchored to the map side. Visible when
 * `useNaksha((s) => s.reader.open)` is true. Uses a CSS opacity +
 * pointer-events transition (200ms) so the panel fades in/out cleanly.
 *
 * Body content depends on `reader.kind`:
 *  - 'wiki'    → render `reader.body` as HTML (already escaped upstream)
 *                + "Read full article ↗" link at the bottom.
 *  - 'weather' → structured weather card (place / temperature / description
 *                / wind) read from `reader.weather`.
 *  - 'web'     → an iframe sandbox pointing at `reader.link`, with a
 *                small warning above (some sites block framing).
 *  - 'file'    → Task 51 — a filesystem text/markdown file opened by
 *                `cat -r`, rendered from pre-converted safe HTML.
 *
 * Esc (global keydown listener added while open) closes the panel.
 */

import { useEffect, useRef } from 'react';
import { useNaksha } from '@/lib/naksha/store';

export function ReaderPanel() {
  const open = useNaksha((s) => s.reader.open);
  const kind = useNaksha((s) => s.reader.kind);
  const title = useNaksha((s) => s.reader.title);
  const body = useNaksha((s) => s.reader.body);
  const link = useNaksha((s) => s.reader.link);
  const image = useNaksha((s) => s.reader.image);
  const weather = useNaksha((s) => s.reader.weather);
  const direction = useNaksha((s) => s.reader.direction);
  const closeReader = useNaksha((s) => s.closeReader);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Global Esc closes the panel while it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeReader();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeReader]);

  /* Task 107 — scroll carry: the scroll container is a persistent DOM
   * node, so opening article B while article A was scrolled shows B
   * MID-TEXT (verified live: Kyoto scrolled to 99 → Tokyo clamped to
   * 10 — the reader opened on the article's belly). Reset to the top
   * whenever the content identity changes; the same contract a browser
   * tab honors on navigation. */
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open, kind, title, body]);

  return (
    <aside
      className={`absolute top-2 end-2 bottom-2 w-[min(420px,40vw)] z-[600] flex flex-col naksha-glass-strong rounded-lg overflow-hidden transition-opacity duration-200 ${
        open
          ? 'opacity-100 pointer-events-auto'
          : 'opacity-0 pointer-events-none'
      }`}
      role="complementary"
      aria-label="Reader panel"
      aria-hidden={!open}
      /* Task 107 — aria-hidden alone LIED about the closed panel: the
       * Esc button (and, when open-hidden, the article links/iframe)
       * stayed tabbable inside content that assistive tech was told to
       * ignore — focus landing in hidden content is the classic
       * aria-hidden violation. `inert` (React 19 boolean prop) removes
       * focusability AND a11y exposure in one honest gesture. */
      inert={!open}
    >
      {/* ─── Header (40px) ─── */}
      <div className="flex items-center justify-between h-10 px-4 border-b border-[var(--naksha-border)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[var(--naksha-gold)] text-[length:var(--naksha-fs-xs)]">
            Reader
          </span>
          {kind && (
            <>
              <span className="text-[var(--naksha-text-4)] text-[length:var(--naksha-fs-xs)]">·</span>
              <span className="text-[var(--naksha-gold)] text-[length:var(--naksha-fs-xs)]">
                {kind}
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={closeReader}
          className="text-[var(--naksha-text-3)] hover:text-[var(--naksha-gold)] text-xs font-mono transition-colors px-1.5 py-0.5 rounded focus:outline-none focus:ring-1 focus:ring-[var(--naksha-border-3)]"
          aria-label="Close reader (Esc)"
        >
          Esc
        </button>
      </div>

      {/* ─── Body (scrollable) ─── */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto naksha-scroll p-4 min-h-0">
        {!open ? null : kind === 'wiki' ? (
          <WikiContent title={title} body={body} image={image} link={link} />
        ) : kind === 'weather' ? (
          <WeatherContent weather={weather} body={body} />
        ) : kind === 'web' ? (
          <WebContent link={link} />
        ) : kind === 'file' ? (
          <FileContent title={title} body={body} direction={direction} />
        ) : (
          <p className="text-[var(--naksha-text-4)] font-mono text-xs">
            No content.
          </p>
        )}
      </div>
    </aside>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Content renderers
   ───────────────────────────────────────────────────────────────────── */

/* Task 51 — `cat -r` lands here: the file's markdown was converted to
 * safe HTML upstream (markdownToHtml — escape-first), so this is a pure
 * render. The ✎ glyph mirrors the ls/tree icon for text files, and the
 * footer hints at the two verbs (reader vs raw).
 * Phase 8 — `direction` was detected from the RAW note text at open
 * time (first strong character over the first non-empty lines) and
 * lands on the article: a Persian note reads right-to-left, headings
 * and lists align to the start edge, while code blocks stay LTR (the
 * .reader-html rules in globals.css pin pre/code to ltr + plaintext
 * prose). Undefined (legacy opens) falls back to dir=auto, which the
 * browser resolves from the same first-strong rule. */
function FileContent({ title, body, direction }: { title: string; body: string; direction?: 'ltr' | 'rtl' }) {
  return (
    <article className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-[var(--naksha-text-3)] font-mono text-xs">✎</span>
        <h2 className="font-mono text-sm text-[var(--naksha-cream)] font-medium leading-snug truncate">
          {title}
        </h2>
      </div>
      <div
        className="reader-html text-[var(--naksha-text)] text-[13px] leading-[1.7] font-mono"
        dir={direction ?? 'auto'}
        style={{ textAlign: 'start' }}
        dangerouslySetInnerHTML={{ __html: body }}
      />
      {/* Task 118 — the heading mapping is now stated where the
       * surprise happens: markdown authors watched `#` render mid-scale
       * and had no way to know the panel books h2 for its own title.
       * One honest line, same footer, same breath as the raw-cat hint. */}
      <p className="text-[var(--naksha-text-4)] font-mono text-[10px] mt-1">
        rendered from markdown · headings step down one (<span className="text-[var(--naksha-gold)]">#</span> → h3, panel books h2) · plain <span className="text-[var(--naksha-gold)]">cat</span> prints raw
      </p>
    </article>
  );
}

function WikiContent({
  title,
  body,
  image,
  link,
}: {
  title: string;
  body: string;
  image?: string;
  link?: string;
}) {
  return (
    <article className="flex flex-col gap-3">
      {image && (
        <img
          src={image}
          alt={title || 'article thumbnail'}
          className="w-full max-h-48 object-cover rounded-md border border-[var(--naksha-border)]"
          loading="lazy"
        />
      )}
      {title && (
        <h2 className="font-mono text-base text-[var(--naksha-cream)] font-medium leading-snug">
          {title}
        </h2>
      )}
      <div
        className="reader-html text-[var(--naksha-text)] text-[13px] leading-[1.7] font-mono"
        dangerouslySetInnerHTML={{ __html: body }}
      />
      {/* Task 107 — target="_blank" was silent to AT: the visible
       * name said "read", the actual behavior was "read in a NEW
       * TAB". The accessible name now carries the jump. */}
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[var(--naksha-gold)] hover:text-[var(--naksha-gold-light)] text-xs font-mono transition-colors mt-2"
          aria-label="Read full article (opens in new tab)"
        >
          Read full article ↗
        </a>
      )}
    </article>
  );
}

function WeatherContent({
  weather,
  body,
}: {
  weather?: import('@/lib/naksha/types').WeatherReport;
  body: string;
}) {
  if (!weather) {
    // Fallback: show raw body text if no structured weather data.
    return (
      <p className="text-[var(--naksha-text-2)] font-mono text-[13px] whitespace-pre-wrap">
        {body || 'No weather data.'}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[var(--naksha-text-3)] text-[length:var(--naksha-fs-xs)]">
            Place
          </p>
          <p className="text-[var(--naksha-cream)] font-mono text-base">
            {weather.place}
          </p>
        </div>
      </div>
      <div className="flex items-baseline gap-3">
        <span className="text-[var(--naksha-gold)] font-mono text-5xl font-medium tabular-nums leading-none">
          {Math.round(weather.temperature)}°
        </span>
        <span className="text-[var(--naksha-text-2)] font-mono text-sm">
          C
        </span>
      </div>
      <p className="text-[var(--naksha-text)] font-mono text-sm">
        {weather.description}
      </p>
      <div className="grid grid-cols-2 gap-3 mt-2">
        <div className="rounded-md border border-[var(--naksha-border)] bg-[color-mix(in_srgb,var(--naksha-wash)_50%,transparent)] p-3">
          <p className="text-[var(--naksha-text-3)] text-[length:var(--naksha-fs-xs)]">
            Wind
          </p>
          <p className="text-[var(--naksha-text)] font-mono text-sm tabular-nums">
            {weather.windspeed.toFixed(0)} km/h
          </p>
        </div>
        <div className="rounded-md border border-[var(--naksha-border)] bg-[color-mix(in_srgb,var(--naksha-wash)_50%,transparent)] p-3">
          <p className="text-[var(--naksha-text-3)] text-[length:var(--naksha-fs-xs)]">
            Direction
          </p>
          <p className="text-[var(--naksha-text)] font-mono text-sm tabular-nums">
            {weather.winddir}°
          </p>
        </div>
      </div>
      <p className="text-[var(--naksha-text-4)] font-mono text-[10px] mt-1">
        Code {weather.weatherCode}
      </p>
    </div>
  );
}

function WebContent({ link }: { link?: string }) {
  if (!link) {
    return (
      <p className="text-[var(--naksha-text-4)] font-mono text-xs">
        No URL provided.
      </p>
    );
  }
  return (
    <div className="flex flex-col h-full gap-2 min-h-[300px]">
      <p className="text-[var(--naksha-text-4)] font-mono text-[10px]">
        Note: some sites block embedding.{' '}
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--naksha-gold)] hover:text-[var(--naksha-gold-light)] transition-colors"
          aria-label="Open externally (opens in new tab)"
        >
          Open externally ↗
        </a>
      </p>
      <iframe
        src={link}
        title="Reader web view"
        className="w-full flex-1 border border-[var(--naksha-border)] rounded-md min-h-[300px]"
        sandbox="allow-scripts allow-same-origin allow-forms"
        loading="lazy"
      />
    </div>
  );
}

export default ReaderPanel;
