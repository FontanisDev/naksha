'use client';

/**
 * Naksha — CommandPalette
 *
 * A Cmd/Ctrl+K command palette for quick access to all Naksha commands.
 * Uses shadcn/ui's Command (cmdk) component styled with the warm
 * glassmorphism design system.
 *
 * Features:
 *   • Fuzzy search across all registered commands.
 *   • Grouped by category (File System, CareSpace, Map, System).
 *   • Keyboard navigation (↑/↓, Enter, Esc).
 *   • Shows the command's usage + description.
 *   • Executes the command on the terminal and closes.
 *   • Recent commands pinned to the top.
 *
 * Performance: only mounts when `open` is true (no idle cost).
 */

import { useMemo, useState, useCallback } from 'react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command';
import { CommandRunner } from '@/lib/naksha/commands';
import { useNaksha } from '@/lib/naksha/store';
import { Storage } from '@/lib/naksha/storage';
import { buildArgSkeleton } from '@/lib/naksha/arg-skeleton';

interface PaletteCommand {
  name: string;
  description: string;
  usage: string;
  category: 'fs' | 'care' | 'map' | 'system' | 'focus';
}

interface PaletteAlias {
  name: string;
  target: string;
}

const RECENT_KEY = 'naksha_palette_recent';
const BOOKMARKS_KEY = 'naksha_palette_bookmarks';
const MAX_RECENT = 5;
const MAX_BOOKMARKS = 20;

const CATEGORY_LABELS: Record<PaletteCommand['category'], string> = {
  fs: 'File System',
  care: 'CareSpace',
  map: 'Map',
  system: 'System',
  focus: 'Workspace',
};

const CATEGORY_ICONS: Record<PaletteCommand['category'], string> = {
  fs: '📂',
  care: '🌳',
  map: '🗺',
  system: '⚙',
  focus: '✦',
};

function loadRecent(): string[] {
  return Storage.get<string[]>(RECENT_KEY, []);
}

/* Task 100/101 — the ONE-CLICK contract, hoisted to module scope (Task 102):
 * runCommand reads it to choose run-vs-prefill, and PaletteItem reads it to
 * mark the two-step rows with their args chip — the prefill path is now
 * VISIBLE before the click, not a surprise after it. Kept in lockstep with
 * the registry by `bun run audit:noarg` (also wired as a pre-commit hook):
 * drift between this set and the documented usage grammar fails the build.
 * Every registry verb whose BARE invocation is meaningful runs on click;
 * the deliberate two-steps (demo mutates CareSpace, pin wants a typed
 * label, palette looping from inside itself, snap gated on focus notes)
 * stay out and wear the chip. */
const NO_ARG_COMMANDS = new Set([
  /* help · sheets */
  'help', 'clear', 'about', 'cheatsheet', 'shortcuts', 'allout',
  /* care · reports & views */
  'care', 'caregraph', 'careout', 'carein', 'caremerge', 'list',
  'lsnode', 'treenode', 'details', 'notes', 'links', 'shapes',
  'timeline', 'tlview', 'stats', 'statsview', 'tags',
  /* map · read-only & camera (pinat: bare = current thought at the
   * crosshair — a complete gesture, label derives from the node) */
  'pins', 'clearpins', 'back', 'fwd', 'stream', 'views', 'where',
  'whereami', 'near', 'jump', 'copycoords', 'measures', 'layer',
  'netlayer', 'elevation', 'weather', 'pinat',
  /* ledger */
  'history', 'hist', 'undo', 'redo',
  /* fs · list/export */
  'storage', 'export', 'exporthtml', 'exportpdf', 'exporttree',
  'import', 'pwd', 'ls', 'tree', 'copytree',
  /* system · panels & toggles */
  'focus', 'done', 'exit', 'perfpanel', 'perf', 'theme', 'themes',
  'themepicker', 'settings', 'workspace', 'ws', 'mapnodes', 'alias',
  /* vault (Phase 2) — connected real directory, read-only */
  'vault',
  /* context (Phase 3) — internal vs connected storage worlds */
  'context',
]);

function saveRecent(names: string[]): void {
  Storage.set(RECENT_KEY, names.slice(0, MAX_RECENT));
}

function loadBookmarks(): string[] {
  return Storage.get<string[]>(BOOKMARKS_KEY, []);
}

function saveBookmarks(names: string[]): void {
  Storage.set(BOOKMARKS_KEY, names.slice(0, MAX_BOOKMARKS));
}

function toggleBookmark(name: string, current: string[]): string[] {
  if (current.includes(name)) {
    return current.filter((n) => n !== name);
  }
  return [name, ...current].slice(0, MAX_BOOKMARKS);
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [bookmarks, setBookmarks] = useState<string[]>(() => loadBookmarks());
  const recent = useMemo(() => loadRecent(), [open]);
  /* Task 103 — the stale-filter disease, THIRD HOST. Task 98 taught
   * closePalette to clear the query; Task 100 taught NodeQuickJump to
   * re-seed on open. But the global Ctrl+K TOGGLE (Naksha.tsx) flips
   * the store's paletteOpen DIRECTLY — it never walks closePalette —
   * so close-by-toggle left `query` wearing the old filter and the
   * next Ctrl+K reopened pre-filtered (field-verified: "caregraph "
   * survived the toggle round trip). Rather than chase every close
   * path, the query re-seeds on the OPEN transition itself — the
   * React-endorsed render-adjust idiom (guarded setState while
   * rendering, no effect), the same sanctioned form as NodeQuickJump.
   * Every open is fresh BY CONSTRUCTION, whatever closed it. */
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && query !== '') setQuery('');
  }
  /* Task 37: user-defined aliases (`alias ll=ls`) surface as their own
   * palette group — the palette listed only the 90+ registry commands, so
   * a personalized alias was invisible exactly where users look first.
   * Subscribing to the slice means re-render ONLY on alias edits; the
   * palette mounts on open, so idle cost stays zero. */
  const aliases = useNaksha((s) => s.aliases);

  const allCommands = useMemo<PaletteCommand[]>(() => {
    // Ensure commands are registered before reading. init() is idempotent.
    CommandRunner.init();
    const grouped = CommandRunner.grouped();
    const flat: PaletteCommand[] = [];
    (['fs', 'care', 'map', 'system', 'focus'] as const).forEach((cat) => {
      grouped[cat].forEach((c) => {
        flat.push({
          name: c.name,
          description: c.description,
          usage: c.usage,
          category: cat,
        });
      });
    });
    return flat;
  }, []);

  const recentCommands = useMemo(() => {
    if (recent.length === 0) return [];
    return recent
      .map((name) => allCommands.find((c) => c.name === name))
      .filter((c): c is PaletteCommand => c != null);
  }, [recent, allCommands]);

  const aliasList = useMemo<PaletteAlias[]>(() => {
    const q = query.toLowerCase().trim();
    return Object.entries(aliases)
      .filter(([name, target]) => !q || name.toLowerCase().includes(q) || target.toLowerCase().includes(q))
      .map(([name, target]) => ({ name, target }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [aliases, query]);

  /* Task 98 — ONE close verb: clear the query, then close. The keyed-div
   * remount below was meant to reset the input, but `query` is state of
   * THIS component — remounting children can't touch it, so the palette
   * reopened wearing the previous filter ("goto" survived close+open,
   * verified). Every close path (run, alias, Escape/outside) now walks
   * the same door, and a reopen starts from a clean slate. */
  const closePalette = useCallback(() => {
    setQuery('');
    onOpenChange(false);
  }, [onOpenChange]);

  const runAlias = useCallback(
    (alias: PaletteAlias) => {
      closePalette();
      /* Execute the ALIAS NAME — CommandRunner expands it (and forwards
       * any trailing args the alias carries, e.g. `g=goto`). */
      useNaksha.getState().print(alias.name, 'cmd');
      useNaksha.getState().pushHistory(alias.name);
      CommandRunner.execute(alias.name);
      const next = [alias.name, ...recent.filter((n) => n !== alias.name)].slice(0, MAX_RECENT);
      saveRecent(next);
    },
    [recent, closePalette],
  );

  const bookmarkedCommands = useMemo(() => {
    if (bookmarks.length === 0) return [];
    return bookmarks
      .map((name) => allCommands.find((c) => c.name === name))
      .filter((c): c is PaletteCommand => c != null);
  }, [bookmarks, allCommands]);

  const handleToggleBookmark = useCallback(
    (cmd: PaletteCommand) => {
      setBookmarks((prev) => {
        const next = toggleBookmark(cmd.name, prev);
        saveBookmarks(next);
        return next;
      });
    },
    [],
  );

  const runCommand = useCallback(
    (cmd: PaletteCommand) => {
      // If the command needs arguments, just type it into the terminal
      // with a trailing space so the user can type the args. If it takes
      // no args, execute directly. The set above is the audited contract
      // (Tasks 100–102): one-click for every verb whose bare form is
      // meaningful, a visible args chip on the two-step rows, and
      // `audit:noarg` failing loudly when either side drifts.
      // Task 103: multi-slot positional verbs prefill the ARG SKELETON
      // (shared builder in arg-skeleton.ts — the chip's clause becomes
      // the terminal's starting grid), with the caret in the first gap.

      closePalette();

      if (NO_ARG_COMMANDS.has(cmd.name)) {
        // Echo + execute
        useNaksha.getState().print(cmd.name, 'cmd');
        useNaksha.getState().pushHistory(cmd.name);
        CommandRunner.execute(cmd.name);
        /* Task 99 — recency records RUNS, not interest. The saveRecent
         * used to ride BOTH branches, so a command the user merely
         * GLANCED at (picked from the palette, got the usage card +
         * prefill, then abandoned) ranked up in Recent without ever
         * executing — the group's meaning ("what you ran") quietly
         * became "what you clicked". Needs-arg commands that run
         * habitually still surface: prefix matching finds them by
         * name, and ★ bookmarks are the designed slot for intent. */
        const next = [cmd.name, ...recent.filter((n) => n !== cmd.name)].slice(0, MAX_RECENT);
        saveRecent(next);
      } else {
        // Print the command as a prompt and pre-fill the terminal input
        // so the user can type arguments. No recency here — the command
        // has NOT run; the terminal's Enter will be the run.
        useNaksha.getState().print(`${cmd.usage}`, 'highlight');
        useNaksha.getState().print(`  ${cmd.description}`, 'muted');
        // Focus the terminal and pre-fill
        setTimeout(() => {
          const input = document.getElementById('naksha-terminal-input') as HTMLInputElement | null;
          if (input) {
            const sk = buildArgSkeleton(cmd.usage);
            input.value = sk ? sk.text : `${cmd.name} `;
            input.focus();
            const len = input.value.length;
            // Skeleton: caret lands in the FIRST gap's fill position;
            // plain prefill: caret at the end (both as before for those).
            const caret = sk ? sk.slots[0] : len;
            input.setSelectionRange(caret, caret);
          }
        }, 50);
      }
    },
    [recent, closePalette],
  );

  // (Task 98: the query reset lives in closePalette — see the comment
  // above runAlias. The keyed div below still remounts styles/list per
  // open, which is fine, but the input's value is THIS component's
  // state, so the remount alone never cleared it.)

  // Group commands by category, filtered by query.
  // Within each group, results are WEIGHTED — bookmarks first, then recency
  // (newest command wins), then name-match quality (exact > prefix >
  // substring). Registration order only breaks ties, so the commands the
  // user actually lives in surface before the long tail.
  const grouped = useMemo(() => {
    const q = query.toLowerCase().trim();
    const recentIdx = new Map<string, number>();
    recent.forEach((n, i) => recentIdx.set(n, recent.length - i)); // higher = more recent
    const bmSet = new Set(bookmarks);
    const weight = (c: PaletteCommand): number => {
      let s = 0;
      if (bmSet.has(c.name)) s += 100;
      const ri = recentIdx.get(c.name);
      if (ri) s += ri * 10;
      if (q) {
        const name = c.name.toLowerCase();
        if (name === q) s += 50;
        else if (name.startsWith(q)) s += 25;
        else if (name.includes(q)) s += 10;
      }
      return s;
    };
    const filter = (c: PaletteCommand) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.usage.toLowerCase().includes(q);
    const groups: Record<string, PaletteCommand[]> = {};
    for (const c of allCommands) {
      if (!filter(c)) continue;
      const label = CATEGORY_LABELS[c.category];
      if (!groups[label]) groups[label] = [];
      groups[label].push(c);
    }
    for (const label of Object.keys(groups)) {
      groups[label].sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name));
    }
    /* Groups themselves are ranked by their best item's weight — when the
     * user types "care", the CareSpace group outranks File System's "cat"
     * (prefix match) instead of category registration order deciding. */
    const ranked = Object.entries(groups).sort(
      ([, a], [, b]) => Math.max(...b.map(weight)) - Math.max(...a.map(weight)),
    );
    return Object.fromEntries(ranked);
  }, [allCommands, query, recent, bookmarks]);

  return (
    <CommandDialog
      open={open}
      /* Task 98 — Escape and outside-click close through the same door:
         clear the query first (closePalette), then close. */
      onOpenChange={(o) => (o ? onOpenChange(o) : closePalette())}
      title="Naksha Command Palette"
      description="Search and run any command. Arrow keys to navigate, Enter to run."
      className="naksha-glass-strong !rounded-xl border-[var(--naksha-border-2)] max-w-[560px]"
    >
      {/* Task 98 — the keyed wrapper stays (it remounts the list/styles
          fresh per open), but the query reset itself lives in
          closePalette — the input's value is this component's state,
          and no child remount can clear a parent's state. */}
      <div key={open ? 'open' : 'closed'}>
        <PaletteStyles />
        <CommandInput
          placeholder="Type a command name or description…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No commands found.</CommandEmpty>
          {aliasList.length > 0 && (
            <CommandGroup heading="Aliases">
              {aliasList.map((a) => (
                <CommandItem
                  key={`alias-${a.name}`}
                  value={`alias ${a.name} ${a.target}`}
                  onSelect={() => runAlias(a)}
                  className="palette-alias-item"
                >
                  <span className="palette-icon" style={{ fontSize: 'var(--naksha-fs-md)', opacity: 0.8 }}>
                    ↳
                  </span>
                  <span style={{ fontWeight: 500, color: 'var(--naksha-gold-light)', minWidth: '90px' }}>
                    {a.name}
                  </span>
                  <span style={{ color: 'var(--naksha-text-3)', fontSize: 'var(--naksha-fs-xs)', flex: 1 }}>
                    → {a.target}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {bookmarkedCommands.length > 0 && query === '' && (
            <CommandGroup heading="★ Bookmarks">
              {bookmarkedCommands.map((c) => (
                <PaletteItem
                  key={`bm-${c.name}`}
                  cmd={c}
                  onRun={runCommand}
                  isBookmarked={true}
                  onToggleBookmark={handleToggleBookmark}
                />
              ))}
            </CommandGroup>
          )}
          {recentCommands.length > 0 && query === '' && (
            <CommandGroup heading="Recent">
              {recentCommands.map((c) => (
                <PaletteItem
                  key={`recent-${c.name}`}
                  cmd={c}
                  onRun={runCommand}
                  isBookmarked={bookmarks.includes(c.name)}
                  onToggleBookmark={handleToggleBookmark}
                />
              ))}
            </CommandGroup>
          )}
          {Object.entries(grouped).map(([label, cmds]) => (
            <CommandGroup key={label} heading={label}>
              {cmds.map((c) => (
                <PaletteItem
                  key={c.name}
                  cmd={c}
                  onRun={runCommand}
                  isBookmarked={bookmarks.includes(c.name)}
                  onToggleBookmark={handleToggleBookmark}
                />
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
          <span>↑↓ navigate · ↵ run · Esc close</span>
          <span>
            {allCommands.length} commands
            {aliasList.length > 0 ? ` · ${aliasList.length} aliases` : ''}
          </span>
        </div>
      </div>
    </CommandDialog>
  );
}

/** Inline stylesheet for the cmdk palette — warm glass theme. */
function PaletteStyles() {
  return (
    <style>{`
      /* Override shadcn's default white dialog background with warm glass */
      [data-slot="dialog-content"] {
        background: var(--naksha-glass-strong) !important;
        backdrop-filter: blur(20px) saturate(140%) !important;
        -webkit-backdrop-filter: blur(20px) saturate(140%) !important;
        border: 1px solid var(--naksha-border-2) !important;
        box-shadow: var(--naksha-shadow-elevated) !important;
      }
      /* Task 29 fix: re-assert centering — the shadcn fixed top-50% left-50%
         translate utility chain was losing the cascade in some builds
         (palette dropped to the page bottom). This rule rides the JS module
         graph so it always wins, independent of the CSS pipeline. */
      [data-slot="dialog-content"] {
        position: fixed !important;
        top: 50% !important;
        left: 50% !important;
        transform: none !important;
        translate: -50% -50% !important;
        width: min(560px, calc(100vw - 2rem)) !important;
        max-height: min(420px, 70vh) !important;
      }
      [data-slot="dialog-overlay"] {
        background: color-mix(in srgb, var(--naksha-scrim) 70%, transparent) !important;
        backdrop-filter: blur(4px) !important;
        -webkit-backdrop-filter: blur(4px) !important;
      }
      [data-slot="dialog-close"] {
        color: var(--naksha-text-3) !important;
      }
      [data-slot="dialog-close"]:hover {
        color: var(--naksha-gold) !important;
        opacity: 1 !important;
      }
      [cmdk-root] {
        background: transparent !important;
        color: var(--naksha-text) !important;
      }
      [cmdk-input] {
        color: var(--naksha-text) !important;
        font-family: var(--naksha-font-mono) !important;
        font-size: var(--naksha-fs-md) !important;
      }
      [cmdk-input]::placeholder {
        color: var(--naksha-text-4) !important;
      }
      [cmdk-group-heading] {
        color: var(--naksha-text-3) !important;
        font-size: var(--naksha-fs-xs) !important;
        font-weight: 500 !important;
        letter-spacing: 0.2px !important;
        padding: 8px 12px 4px !important;
      }
      /* UI-calm pass: the @@ … @@ diff-hunk decorations and ALL-CAPS
       * transform are gone — group headers are now quiet sentence-case
       * labels. Hierarchy does the work, not costume. */
      [cmdk-item] {
        color: var(--naksha-text-2) !important;
        font-family: var(--naksha-font-mono) !important;
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
      [cmdk-item][data-selected="true"] .palette-icon {
        color: var(--naksha-gold) !important;
      }
      [cmdk-empty] {
        color: var(--naksha-text-4) !important;
        font-size: var(--naksha-fs-sm) !important;
        padding: 24px !important;
        text-align: center !important;
      }
      [cmdk-list] {
        max-height: 360px !important;
        overflow-y: auto !important;
      }
      [cmdk-list]::-webkit-scrollbar { width: 6px; }
      [cmdk-list]::-webkit-scrollbar-thumb {
        background: var(--naksha-border-2);
        border-radius: 3px;
      }
    `}</style>
  );
}

function PaletteItem({
  cmd,
  onRun,
  isBookmarked = false,
  onToggleBookmark,
}: {
  cmd: PaletteCommand;
  onRun: (cmd: PaletteCommand) => void;
  isBookmarked?: boolean;
  onToggleBookmark?: (cmd: PaletteCommand) => void;
}) {
  return (
    <CommandItem
      value={`${cmd.name} ${cmd.description} ${cmd.usage}`}
      onSelect={() => onRun(cmd)}
    >
      <span className="palette-icon" style={{ fontSize: 'var(--naksha-fs-md)', opacity: 0.8 }}>
        {CATEGORY_ICONS[cmd.category]}
      </span>
      <span style={{ fontWeight: 500, color: 'var(--naksha-gold-light)', minWidth: '90px' }}>
        {cmd.name}
      </span>
      <span style={{ color: 'var(--naksha-text-3)', fontSize: 'var(--naksha-fs-xs)', flex: 1 }}>
        {cmd.description}
      </span>
      {/* Task 102 — the two-step rows wear their args: the chip shows the
       * usage's argument clause (<place>, [label], to [node]) so the user
       * knows BEFORE the click that this row types into the terminal
       * instead of running — and what to type. Bare deliberate two-steps
       * (demo, palette) get the generic token. One-click rows stay bare:
       * no chip = runs, the quiet rows are the complete gestures. Static
       * text, zero blur, zero animation — safe at the low perf tier.
       * Task 103 — color: text-4 measured 1.69:1 on the dialog (1.37:1
       * on the selected tint) — a severe AA fail for load-bearing
       * grammar text; text-3 still fails (2.79). text-2 passes both row
       * states (6.24 / 5.05) and stays subordinate at 10px mono. The
       * inactive bookmark star keeps text-4 deliberately: it is an
       * inactive affordance (hover restores it), not information. */}
      {!NO_ARG_COMMANDS.has(cmd.name) && (
        <span
          style={{
            fontFamily: 'var(--naksha-font-mono)',
            fontSize: 'var(--naksha-fs-xs)',
            color: 'var(--naksha-text-2)',
            border: '1px solid var(--naksha-border)',
            borderRadius: '4px',
            padding: '1px 6px',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {cmd.usage.startsWith(cmd.name)
            ? cmd.usage.slice(cmd.name.length).trim() || '⇥ Enter to run'
            : cmd.usage}
        </span>
      )}
      {onToggleBookmark && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onToggleBookmark(cmd);
          }}
          onMouseDown={(e) => e.preventDefault()}
          title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
          style={{
            background: 'transparent',
            border: 'none',
            color: isBookmarked ? 'var(--naksha-gold-light)' : 'var(--naksha-text-4)',
            fontSize: 'var(--naksha-fs-md)',
            cursor: 'pointer',
            padding: '0 4px',
            lineHeight: 1,
            opacity: isBookmarked ? 1 : 0.5,
            transition: 'opacity 0.15s ease, color 0.15s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { if (!isBookmarked) e.currentTarget.style.opacity = '0.5'; }}
        >
          {isBookmarked ? '★' : '☆'}
        </button>
      )}
    </CommandItem>
  );
}

export default CommandPalette;
