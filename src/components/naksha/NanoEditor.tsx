'use client';

/**
 * Naksha — NanoEditor
 *
 * A modal overlay covering the terminal pane only (NOT the whole screen).
 * Rendered conditionally on `nanoOpen` to avoid any DOM cost while closed.
 *
 * Behavior:
 *  - Mount: reads file content via FileSystem.readFile(nanoFile) into
 *    local state (lazily-initialized useState), autofocuses the textarea.
 *  - Ctrl+S / Cmd+S: preventDefault, write the file, print success.
 *  - Esc: preventDefault, save first, then close and return focus to
 *    the terminal input (#naksha-terminal-input).
 *  - Click on the overlay background refocuses the textarea.
 *
 * Layout: absolute inset-0 z-[100] flex flex-col — header (36px) + body
 * textarea (flex-1). Task 95: the surface rides var(--naksha-bg) paper.
 *
 * Implementation note:
 *  We split the component into a thin `<NanoEditor>` shell (handles the
 *  open/close gate) and a `<NanoEditorInner>` that mounts only while
 *  open. This lets us use lazy `useState` initializers to read the file
 *  content exactly once per open session — no `setState` inside an
 *  effect, no cascading renders.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNaksha } from '@/lib/naksha/store';
import { FileSystem } from '@/lib/naksha/filesystem';

export function NanoEditor() {
  const open = useNaksha((s) => s.nanoOpen);
  if (!open) return null;
  return <NanoEditorInner />;
}

function NanoEditorInner() {
  const file = useNaksha((s) => s.nanoFile);
  const setNanoOpen = useNaksha((s) => s.setNanoOpen);

  // Lazy initial load — runs once per mount (per open session).
  const [value, setValue] = useState<string>(() => {
    if (!file) return '';
    const res = FileSystem.readFile(file);
    return res.success && typeof res.content === 'string' ? res.content : '';
  });
  const [loadError, setLoadError] = useState<string | null>(() => {
    if (!file) return null;
    const res = FileSystem.readFile(file);
    return res.success ? null : (res.error ?? null);
  });
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  /* Phase 6 — the internal editor now speaks the same visual language as
   * the PTY one: a world chip, a dirty dot, a byte count. Behavior is
   * untouched — Ctrl+S/Esc semantics, sync load, unchanged receipts. */
  const [savedValue, setSavedValue] = useState<string>(() => {
    if (!file) return '';
    const res = FileSystem.readFile(file);
    return res.success && typeof res.content === 'string' ? res.content : '';
  });

  // Autofocus on mount.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const save = useCallback(() => {
    if (!file) return false;
    const res = FileSystem.writeFile(file, value);
    if (res.success) {
      useNaksha.getState().print(`Saved: ${file}`, 'success');
      setSavedValue(value);
      return true;
    }
    useNaksha.getState().print(
      `Save failed: ${res.error ?? 'unknown error'}`,
      'error',
    );
    return false;
  }, [file, value]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Save: Ctrl+S or Cmd+S
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        save();
        return;
      }
      // Esc: save then close.
      if (e.key === 'Escape') {
        e.preventDefault();
        save();
        setNanoOpen(false);
        // Return focus to terminal input.
        requestAnimationFrame(() => {
          const term = document.getElementById(
            'naksha-terminal-input',
          ) as HTMLInputElement | null;
          term?.focus();
        });
      }
    },
    [save, setNanoOpen],
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only refocus when clicking the overlay itself (not the textarea).
      if (e.target === e.currentTarget) {
        taRef.current?.focus();
      }
    },
    [],
  );

  // `setLoadError` is currently write-only — keep it referenced so the
  // lint rule doesn't complain about an unused setter (we may surface
  // load errors to the header in a future iteration).
  void setLoadError;

  return (
    <div
      /* Task 95 — theme paper, not the frozen near-black Tailwind literal:
       * every ink inside rides theme vars and ghosted on light papers.
       * The backdrop-blur dies with the opacity — a 97%-opaque fullscreen
       * editor blurs nothing (CPU perf budget). */
      className="absolute inset-0 z-[100] flex flex-col"
      style={{ background: 'color-mix(in srgb, var(--naksha-bg) 97%, transparent)' }}
      onClick={handleOverlayClick}
      role="dialog"
      /* Task 111 — aria-modal REMOVED: nothing here traps focus (no Tab
       * cycling exists — Tab leaves the pane like any other surface),
       * and Task 108's rule says an announced contract the UI doesn't
       * keep is worse than silence. role="dialog" + the label + the
       * autofocus + the focus-return on Esc are the honest parts; the
       * modal claim was the one dishonest pixel. */
      aria-label={`Editing ${file || 'file'}`}
    >
      {/* Header — 36px */}
      <div className="flex items-center justify-between h-9 px-4 border-b border-[var(--naksha-border)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[var(--naksha-text-4)] font-mono text-[length:var(--naksha-fs-xs)]">
            nano
          </span>
          <span
            className="font-mono text-[10px] px-1.5 py-px rounded text-[var(--naksha-text-3)]"
            style={{ border: '1px solid var(--naksha-border)' }}
            title="the internal (browser-side) virtual filesystem — a different world from the connected vault"
          >
            [internal]
          </span>
          <span className="text-[var(--naksha-gold)] font-mono text-xs truncate">
            {file || '(untitled)'}
          </span>
          {value !== savedValue && (
            <span
              className="font-mono text-[10px]"
              style={{ color: 'var(--naksha-gold-light)' }}
              title="unsaved changes — Ctrl+S writes the internal FS"
            >
              ● unsaved
            </span>
          )}
          {loadError && (
            <span className="text-[var(--naksha-error)] font-mono text-[10px] truncate">
              · {loadError}
            </span>
          )}
        </div>
        <span className="text-[var(--naksha-text-4)] font-mono text-[10px] whitespace-nowrap">
          {new Blob([value]).size} B · Ctrl+S save · Esc exit
        </span>
      </div>

      {/* Body — textarea fills the rest */}
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        spellCheck={false}
        aria-label="File content editor"
        className="flex-1 w-full bg-transparent border-none outline-none resize-none text-[var(--naksha-text)] font-mono text-[13px] leading-[1.7] p-4 caret-[var(--naksha-gold)] whitespace-pre naksha-scroll"
      />
    </div>
  );
}

export default NanoEditor;
