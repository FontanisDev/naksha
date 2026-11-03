/**
 * Naksha — TerminalPane
 *
 * The center terminal pane — the primary interaction surface of the whole
 * app. A glass panel split into three parts:
 *
 *   1. Header (40px) — "TERMINAL" label + current working directory.
 *   2. Output (flex 1, scrollable) — renders `TermLine[]` from the store.
 *   3. Input row (flex-shrink: 0) — prompt `$` + an uncontrolled text input
 *      with full keyboard handling (Enter, Tab, ↑/↓, Ctrl+R, Ctrl+L, Ctrl+C,
 *      Esc) and a reverse-i-search overlay.
 *
 * Performance notes:
 *  - Subscribes to only the slices it renders, via individual selectors so
 *    Zustand only re-renders when those specific refs change.
 *  - The output list is capped at MAX_TERM_LINES in the store (500), so a
 *    plain `.map` with stable `key={line.id}` is fine.
 *  - Auto-scroll is throttled via requestAnimationFrame and gated on a
 *    "near-bottom" ref so we don't yank users reading scrollback.
 *  - The welcome message runs exactly once (ref-guarded) and only when the
 *    buffer is empty.
 */

'use client';

import { memo, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ChangeEvent } from 'react';
import { useNaksha } from '@/lib/naksha/store';
import { CommandRunner } from '@/lib/naksha/commands';
import { buildArgSkeleton } from '@/lib/naksha/arg-skeleton';
import { CareSpace } from '@/lib/naksha/carespace';
import { MapEngine } from '@/lib/naksha/map-engine';
import { FileSystem } from '@/lib/naksha/filesystem';
import { setTermCols } from '@/lib/naksha/termcols';
import { markdownToHtml } from '@/lib/naksha/utils';
import { detectDirection } from '@/lib/naksha/direction';
import { contextReceiptTag, resolveStorageContext } from '@/lib/naksha/vault-context';
import { resolveVaultPath, vaultPromptCwd } from '@/lib/naksha/vault-path';
import { vaultMarkdownToHtml } from '@/lib/naksha/vault-markdown';
import type { TermLine, UndoEntry } from '@/lib/naksha/types';

const NEAR_BOTTOM_THRESHOLD_PX = 60;

export default function TerminalPane() {
  /* ── Sliced store subscriptions (each picks one ref so re-renders are
       minimal — Zustand compares with Object.is by default) ── */
  const lines = useNaksha((s) => s.lines);
  const cwd = useNaksha((s) => s.cwd);
  const reverseSearch = useNaksha((s) => s.reverseSearch);
  const reverseQuery = useNaksha((s) => s.reverseQuery);
  const reverseResult = useNaksha((s) => s.reverseResult);
  const terminalFont = useNaksha((s) => s.settings.terminalFont);
  /* Phase 4 — the world the input line stands in: the resolved context
   * picks the prompt chip ([internal] / [connected:name]) and whether
   * the cwd display shows the internal path or the vault-world cwd. */
  const storageContextPref = useNaksha((s) => s.settings.storageContext);
  const vaultStatus = useNaksha((s) => s.vaultStatus);
  const vaultCwd = useNaksha((s) => s.vaultCwd);
  const activeContext = resolveStorageContext(storageContextPref, vaultStatus);

  /* ── Refs ── */
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Tracks whether the user is parked near the bottom of the output. */
  const isNearBottomRef = useRef(true);
  /** rAF throttle flag for the scroll handler. */
  const scrollScheduledRef = useRef(false);
  /** Guards the welcome-message effect against double-fire in StrictMode /
       hot reloads. */
  const welcomeShownRef = useRef(false);

  const fontClass = terminalFont === 'serif' ? 'font-serif' : 'font-mono';

  /* ════════════════════════════════════════════════════════════════
     Task 93 — width-aware sheets. The history element's width is the
     terminal's honest column budget: a ResizeObserver converts it to
     chars (container px-4 = 32px, .term-line padding = 8px, the mono
     advance measured from the live computed font — never hardcoded
     7.8, so a future font-size change self-corrects) and feeds
     termcols.ts, whose value the print sheets read at render time.
     One observer, one canvas measure per resize; zero per-print cost.
     ════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    const ctx = document.createElement('canvas').getContext('2d');
    const measure = () => {
      const first = el.querySelector('.term-line');
      let charW = 7.8; /* 13px × 0.6em — JetBrains Mono's advance, the sane fallback */
      if (ctx && first) {
        ctx.font = `${getComputedStyle(first).fontSize} ${getComputedStyle(first).fontFamily}`;
        const w = ctx.measureText('0'.repeat(20)).width / 20;
        if (w > 0) charW = w;
      }
      setTermCols(Math.floor((el.clientWidth - 40) / charW));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ════════════════════════════════════════════════════════════════
     Auto-scroll on new lines — but only if the user is already near
     the bottom (so reading scrollback isn't interrupted).
     ════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    if (isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines.length]);

  /* ════════════════════════════════════════════════════════════════
     Near-bottom tracking — rAF-throttled so a fast scroll burst only
     recomputes once per frame.
     ════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;

    const onScroll = () => {
      if (scrollScheduledRef.current) return;
      scrollScheduledRef.current = true;
      requestAnimationFrame(() => {
        scrollScheduledRef.current = false;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        isNearBottomRef.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD_PX;
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  /* ════════════════════════════════════════════════════════════════
     Task 42 — click-to-fly: ONE delegated click listener on the output
     container (mount-once) handles every `.term-fly` row. Lines that
     carry a fly payload (today: `near` rows) render data-fly-* attrs;
     the handler reads the dataset and hands the coordinates straight to
     the map engine. ZERO per-line React handlers and no re-renders — a
     click costs one closest() + one flyTo, idle cost stays zero.

     Task 46 — the same listener also branches on `.term-jump` rows:
     ⇥ jump rows land the CareSpace TREE on a node (switching rivers and
     dropping out of graph view when needed) — the return path for the
     graph's right-click receipt. One listener, two verbs: ↗ moves the
     MAP, ⇥ moves the TREE.

     Task 47 — branch order is now badge → jump → fly: a jump row for a
     LOCATED thought carries a nested `.term-flybadge` chip at its tail
     (the ↗ verb on the same row). closest() from the chip would reach
     the enclosing `.term-jump` first, so the badge MUST be checked
     before the jump branch — clicking the chip flies the MAP, clicking
     anywhere else on the row lands the TREE. The jump itself is now a
     full deep-link: it also opens the node's details panel, so "⇥ open
     this thought" = tree selection + details side-by-side.

     Task 48 — the mirror chip: a FLY row (near results) can carry a
     nested `.term-jumpbadge` (⇥) that opens the thought in the tree.
     Resolution order is now CHIP → CHIP → row → row (jumpbadge,
     flybadge, jump, fly): the two chips are checked before either row
     verb, because closest() from a chip walks up through its row. Each
     chip keeps its own verb regardless of what the row beneath it does.

     Task 53 — three more nouns join the dialect, same contract:
     · `.term-killchip` (✕) — nests on `pins` and `views` rows; chip =
       delpin/rmview (destructive rust tint), row click stays the
       primary verb (fly / apply).
     · `.term-viewrow` — a saved-view row applies itself (the exact
       `view <name>` surface: flyToView + layer sync).
     · `.term-filterchip` — the boxed count on `shapes` owner rows
       re-runs `shapes <node>`; the row's own click is still the ⇥
       tree landing.
     Chips are STILL checked before row verbs (a kill/filter chip
     nests inside its row); the chip chain is now five long.

     Task 85 — every chip is a DOOR, not just a click target: all five
     render focusable (tabIndex + role=button) and one delegated
     keydown (Enter/Space) runs the same chain the click path speaks —
     the terminal's handover vocabulary works without a mouse.
     ════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    /* Jump verb — shared by `.term-jump` rows and `.term-jumpbadge`
     * chips (both carry data-jump-*). Lands the tree, opens details. */
    const doJump = (jumpEl: HTMLElement) => {
      const nodeId = jumpEl.dataset.jumpNode ?? '';
      if (!nodeId) return false;
      const riverName = jumpEl.dataset.jumpRiver ?? '';
      const nets = CareSpace.networks();
      const net = (riverName && nets.find((n) => n.name === riverName)) || nets[CareSpace.data.currentNetworkIndex];
      const node = net?.nodes[nodeId];
      if (!net || !node) {
        useNaksha.getState().print('⇥ that thought is gone — nothing to jump to', 'muted');
        return true;
      }
      const isCrossRiver = net !== nets[CareSpace.data.currentNetworkIndex];
      if (isCrossRiver) CareSpace.switchNetwork(net.name);
      net.currentId = nodeId;
      CareSpace.save();
      const s = useNaksha.getState();
      s.syncCare();
      /* Landing in the tree IS the verb: if the user is in graph view
       * the pane switches back so the selection is actually visible. */
      if (s.careViewMode !== 'tree') s.setCareViewMode('tree');
      /* Task 47/48 — deep-link: the details panel opens with the landing
       * (flash ring when perf allows), so a jump answers "what is this
       * thought?" in the same click. */
      s.setDetailsNodeId(nodeId, s.settings.perfMode !== 'low');
      s.print(`⇥ tree → "${node.label}"${isCrossRiver ? ` · ${net.name}` : ''} · details`, 'muted');
      return true;
    };
    /* Fly verb — shared by `.term-fly` rows and `.term-flybadge` chips
     * (both carry data-fly-*). Moves the map, pulses the arrival. */
    const doFly = (flyEl: HTMLElement) => {
      const lat = parseFloat(flyEl.dataset.flyLat ?? '');
      const lng = parseFloat(flyEl.dataset.flyLng ?? '');
      if (isNaN(lat) || isNaN(lng)) return false;
      const zoom = parseInt(flyEl.dataset.flyZoom ?? '', 10);
      /* Task 43 — flyAndPulse: on the fly's own moveend, the nearest
       * marker to the destination pulses once (skipped at perf-low),
       * so the landing is visible on a busy map. */
      MapEngine.flyAndPulse(lat, lng, isNaN(zoom) ? 13 : zoom);
      const label = flyEl.dataset.flyLabel ?? '';
      useNaksha
        .getState()
        .print(
          label
            ? `↗ flying to "${label}" — ${Math.abs(lat).toFixed(3)}${lat >= 0 ? 'N' : 'S'} ${Math.abs(lng).toFixed(3)}${lng >= 0 ? 'E' : 'W'}`
            : `↗ flying to ${Math.abs(lat).toFixed(3)}${lat >= 0 ? 'N' : 'S'} ${Math.abs(lng).toFixed(3)}${lng >= 0 ? 'E' : 'W'}`,
          'muted',
        );
      /* Task 73 — arrival → persistence rides EVERY flight now: the
       * Task 72 goto covenant, ported to the shared fly verb. A labeled
       * arrival (near rows, pins, search hits, wiki, weather — every
       * payload names its target since this round) wears the saveview
       * chip prefilled with the target's first token, so pinning the
       * camera needs no retyping. Token is punctuation-stripped so POI
       * names land as clean view names. */
      const firstToken = label.replace(/^["']|["']$/g, '').split(/\s+/)[0]?.replace(/[,.;:!?]+$/, '');
      if (firstToken) {
        useNaksha.getState().print('  keep this camera:', 'muted', {
          chips: [{ cmd: `saveview ${firstToken}`, label: '⌂ save view', title: `run: saveview ${firstToken} — pin the camera where you just landed` }],
        });
      }
      return true;
    };
    /* Task 49 — the FILESYSTEM verb: `ls` rows carry data-fs-* (absolute
     * path + dir|file). A folder click is a `cd` (with its own receipt
     * line — bare `cd` only moves the prompt); a file click is a `cat`
     * printed straight into the history. Same dumb-div listener, same
     * one-verb-per-row contract.
     * Phase 4 — rows printed from the CONNECTED directory carry
     * data-fs-world="vault" (rel paths): their clicks resolve through
     * the vault API against the vault-world cwd, never the internal
     * FS. A vault click while the active context is internal still
     * opens the real row (rows carry their world) — with a hint that
     * the terminal's typed verbs currently route elsewhere. */
    const doFs = (el: HTMLElement) => {
      const path = el.dataset.fsPath ?? '';
      const kind = el.dataset.fsKind ?? '';
      const world = el.dataset.fsWorld ?? '';
      if (!path) return false;
      const s = useNaksha.getState();
      if (world === 'vault') {
        const st = useNaksha.getState();
        const ctx = resolveStorageContext(st.settings.storageContext, st.vaultStatus);
        const vs = st.vaultStatus;
        if (!vs?.connected || !vs.available) {
          s.print('that row belongs to a vault that is no longer available', 'muted');
          return true;
        }
        if (kind === 'dir') {
          const resolved = resolveVaultPath(st.vaultCwd, path);
          if (!resolved.ok) { s.print(`cd: ${resolved.error}`, 'error'); return true; }
          st.setVaultCwd(resolved.rel);
          s.print(`⇥ [vault:${vs.name}] ${vs.root}${resolved.rel ? `/${resolved.rel}` : ''}`, 'muted');
          if (ctx.kind !== 'connected') {
            s.print("  (the active context is internal — 'context connected' routes the terminal's typed verbs here)", 'muted');
          }
          return true;
        }
        // File row → cat the REAL file through the API.
        void (async () => {
          try {
            const resolved = resolveVaultPath(st.vaultCwd, path);
            if (!resolved.ok || !resolved.rel) { s.print(`cat: ${resolved.ok ? 'is a directory' : resolved.error}`, 'error'); return; }
            const res = await fetch(`/api/vault/read?p=${encodeURIComponent(resolved.rel)}`, { cache: 'no-store' });
            const data = (await res.json()) as { ok: boolean; content?: string; size?: number; error?: string };
            if (!data.ok || typeof data.content !== 'string') {
              s.print(`cat: [vault:${vs.name}] ${data.error ?? 'read failed'}`, 'error');
              return;
            }
            s.print(`⇥ cat [vault:${vs.name}] ${resolved.rel}`, 'muted');
            if (!data.content) { s.print('(empty file)', 'muted'); return; }
            s.print(data.content, 'file-output');
          } catch (err) {
            s.print(`vault read failed: ${(err as Error).message}`, 'error');
          }
        })();
        return true;
      }
      if (kind === 'dir') {
        const r = FileSystem.changeDirectory(path);
        if (r.success) {
          s.syncFs();
          s.print(`⇥ ${FileSystem.getCurrentPath()}`, 'muted');
        } else {
          s.print(r.error ?? 'cd failed', 'error');
        }
        return true;
      }
      const f = FileSystem.readFile(path);
      if (f.success && f.content != null) {
        s.print(`⇥ cat ${path}`, 'muted');
        s.print(f.content, 'file-output');
      } else {
        s.print(f.error ?? 'read failed', 'error');
      }
      return true;
    };
    /* Task 52 — the DELETE verb: a `notes` row carries data-del-* (node
     * id + the note's chronological index — the same number `delnote`
     * takes). Full undo parity with the command: snapshot → removeNote →
     * receipt. The row hover strikes the text through, so the verb is
     * legible before the click lands. */
    const doDel = (el: HTMLElement) => {
      const nodeId = el.dataset.delNode ?? '';
      const idx = parseInt(el.dataset.delIndex ?? '', 10);
      if (!nodeId || isNaN(idx)) return false;
      const s = useNaksha.getState();
      const node = CareSpace.getNode(nodeId);
      if (!node) {
        s.print('✕ that note\u2019s thought is not in the current river — switch first', 'muted');
        return true;
      }
      const victim = node.notes[idx];
      if (!victim) { s.print(`✕ note #${idx} is already gone`, 'muted'); return true; }
      const undo: UndoEntry = {
        kind: 'care',
        label: `delnote ${node.label.slice(0, 18)} #${idx}`,
        snapshot: JSON.parse(JSON.stringify(CareSpace.data)),
        ts: Date.now(),
      };
      const r = CareSpace.removeNote(nodeId, idx);
      if (r.success) {
        s.setUndo(undo);
        s.print(`✕ deleted note #${idx} on "${node.label}" — undo available`, 'success');
        s.syncCare();
      } else s.print(r.error ?? 'Could not delete note', 'error');
      return true;
    };
    /* Task 52 — the READER verb: a ▤ chip on reader-eligible `ls` file
     * rows opens the file in the reader panel (the exact surface `cat -r`
     * uses). The row's own click stays a raw cat — the chip is the
     * rendered twin, not a replacement.
     * Phase 4 — vault rows (data-read-world="vault") read the REAL file
     * through the API and render with the vault wikilink pipeline. */
    const doRead = (el: HTMLElement) => {
      const path = el.dataset.readPath ?? '';
      const world = el.dataset.readWorld ?? '';
      if (!path) return false;
      if (world === 'vault') {
        const st = useNaksha.getState();
        const vs = st.vaultStatus;
        if (!vs?.connected || !vs.available) {
          useNaksha.getState().print('that row belongs to a vault that is no longer available', 'muted');
          return true;
        }
        void (async () => {
          try {
            const resolved = resolveVaultPath(st.vaultCwd, path);
            if (!resolved.ok || !resolved.rel) { useNaksha.getState().print(`read: ${resolved.ok ? 'is a directory' : resolved.error}`, 'error'); return; }
            const res = await fetch(`/api/vault/read?p=${encodeURIComponent(resolved.rel)}`, { cache: 'no-store' });
            const data = (await res.json()) as { ok: boolean; content?: string; error?: string };
            if (!data.ok || typeof data.content !== 'string') {
              useNaksha.getState().print(`read: [vault:${vs.name}] ${data.error ?? 'read failed'}`, 'error');
              return;
            }
            useNaksha.getState().openReader({
              kind: 'file',
              title: resolved.rel.split('/').pop() ?? resolved.rel,
              body: vaultMarkdownToHtml(data.content, resolved.rel),
              /* Phase 8 — per-note direction from the RAW text. */
              direction: detectDirection(data.content) ?? 'ltr',
            });
            useNaksha.getState().print(`▤ reader — [vault:${vs.name}] ${resolved.rel} · press Esc to close`, 'success');
          } catch (err) {
            useNaksha.getState().print(`vault read failed: ${(err as Error).message}`, 'error');
          }
        })();
        return true;
      }
      const f = FileSystem.readFile(path);
      if (!f.success || f.content == null) {
        useNaksha.getState().print(f.error ?? 'read failed', 'error');
        return true;
      }
      useNaksha.getState().openReader({
        kind: 'file',
        title: path.split('/').pop() ?? path,
        body: markdownToHtml(f.content),
        /* Phase 8 — per-note direction from the RAW text. */
        direction: detectDirection(f.content) ?? 'ltr',
      });
      useNaksha.getState().print(`▤ reader — ${path} · press Esc to close`, 'success');
      return true;
    };
    /* Task 53 — the KILL chip: a ✕ on `pins` and `views` rows that
     * removes that pin / view — full command parity with delpin and
     * rmview, destructive rust tint so the verb reads before the
     * click. The row's own click stays its primary verb.
     * Task 54 — UNDO parity: the kill snapshots pins + views BEFORE
     * removing (cheap plain-data pair), so `undo` restores what the
     * chip destroyed — the same safety the care verbs have. */
    const doKill = (el: HTMLElement) => {
      const pin = parseInt(el.dataset.killPin ?? '', 10);
      const view = el.dataset.killView ?? '';
      const s = useNaksha.getState();
      if (!isNaN(pin)) {
        const undo: UndoEntry = {
          kind: 'mapdata',
          label: `delpin ${pin}`,
          snapshot: MapEngine.snapshotMapData(),
          ts: Date.now(),
        };
        const r = MapEngine.removePin(pin);
        if (r.success) {
          s.setUndo(undo);
          s.print(`✕ pin ${pin} removed — undo available`, 'success');
        } else s.print(r.error ?? 'delpin failed', 'error');
        return true;
      }
      if (view) {
        const undo: UndoEntry = {
          kind: 'mapdata',
          label: `rmview ${view}`,
          snapshot: MapEngine.snapshotMapData(),
          ts: Date.now(),
        };
        const r = MapEngine.removeView(view);
        if (r.success) {
          s.setUndo(undo);
          s.print(`✕ view "${view}" removed — undo available`, 'success');
        } else s.print(r.error ?? 'rmview failed', 'error');
        return true;
      }
      return false;
    };
    /* Task 53 — the APPLY verb: a `views` row applies itself — the
     * exact `view <name>` surface (flyToView + layer sync + receipt).
     * One click flies the saved viewport, no retyping.
     * Task 54 — the receipt row itself is a ↗ fly row: it carries the
     * view's coordinates so the landing line re-flies on click (an
     * accidental dismissal of the flight is one click to redo). */
    const doApplyView = (el: HTMLElement) => {
      const name = el.dataset.viewName ?? '';
      if (!name) return false;
      const v = MapEngine.listViews().find((x) => x.name === name);
      const r = MapEngine.flyToView(name);
      const s = useNaksha.getState();
      if (r.success) {
        const st = MapEngine.getState();
        s.setMapLayer(st.layer);
        /* Task 55 — the receipt wears the ≡ drill-down chip: one click
         * re-runs `views` without retyping (the same filter dialect the
         * shapes owner rows speak). */
        s.print(
          `⇥ view "${name}" — flying`,
          'muted',
          {
            ...(v ? { fly: { lat: v.lat, lng: v.lng, zoom: Math.round(v.zoom), label: name } } : {}),
            filter: { cmd: 'views' },
          },
        );
      } else s.print(r.error ?? 'view failed', 'error');
      return true;
    };
    /* Task 53 — the FILTER chip: the boxed count on a `shapes` owner
     * row re-runs `shapes <node>` — the drill-down form of the very
     * command that printed it. Echoes the command like a typed line
     * (but does NOT pollute history — clicks are not keystrokes). */
    const doFilter = (el: HTMLElement) => {
      const cmd = el.dataset.filterCmd ?? '';
      if (!cmd) return false;
      const s = useNaksha.getState();
      s.print(cmd, 'cmd');
      void CommandRunner.execute(cmd);
      return true;
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      /* Chips first (Task 48 order: ⇥ chip, ↗ chip; Task 52 adds ▤) —
       * closest() from a chip walks up through its row, so the chips
       * must win before the row-level branches below. */
      const jumpBadge = t.closest('.term-jumpbadge') as HTMLElement | null;
      if (jumpBadge && doJump(jumpBadge)) return;
      const flyBadge = t.closest('.term-flybadge') as HTMLElement | null;
      if (flyBadge && doFly(flyBadge)) return;
      const readBadge = t.closest('.term-readbadge') as HTMLElement | null;
      if (readBadge && doRead(readBadge)) return;
      /* Task 53 — the two new chips: ✕ kill (pins/views) and the count
       * filter (shapes owners). Both nest inside their row, so they
       * must win before the row-level branches below. */
      const killChip = t.closest('.term-killchip') as HTMLElement | null;
      if (killChip && doKill(killChip)) return;
      const filterChip = t.closest('.term-filterchip') as HTMLElement | null;
      if (filterChip && doFilter(filterChip)) return;
      /* Row-level verbs: ✕ delete row (Task 52 — checked before fsrow
       * for symmetry with the chips; the two never share a row so order
       * among rows is free), view apply row (Task 53), ⇥ fs row (cd/cat
       * — Task 49), ⇥ jump row (tree landing + details), then the
       * original ↗ fly row. */
      const delRow = t.closest('.term-delrow') as HTMLElement | null;
      if (delRow && doDel(delRow)) return;
      const viewRow = t.closest('.term-viewrow') as HTMLElement | null;
      if (viewRow && doApplyView(viewRow)) return;
      const fsRow = t.closest('.term-fsrow') as HTMLElement | null;
      if (fsRow && doFs(fsRow)) return;
      const jumpEl = t.closest('.term-jump') as HTMLElement | null;
      if (jumpEl && doJump(jumpEl)) return;
      const flyEl = t.closest('.term-fly') as HTMLElement | null;
      if (flyEl) doFly(flyEl);
    };
    el.addEventListener('click', onClick);
    /* Task 85 — the doors open by keyboard too: every chip renders as a
     * focusable button (tabIndex + role), and one delegated keydown —
     * beside the delegated click, zero per-chip listeners — runs the
     * SAME handler a click would. Enter or Space; Space preventDefaults
     * so a focused chip never scrolls the history instead of acting. */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      /* Same precedence as onClick — chips win before row-level verbs
       * (rows are not focusable, but the order keeps one truth). */
      const jumpBadge = t.closest('.term-jumpbadge') as HTMLElement | null;
      if (jumpBadge && doJump(jumpBadge)) { e.preventDefault(); return; }
      const flyBadge = t.closest('.term-flybadge') as HTMLElement | null;
      if (flyBadge && doFly(flyBadge)) { e.preventDefault(); return; }
      const readBadge = t.closest('.term-readbadge') as HTMLElement | null;
      if (readBadge && doRead(readBadge)) { e.preventDefault(); return; }
      const killChip = t.closest('.term-killchip') as HTMLElement | null;
      if (killChip && doKill(killChip)) { e.preventDefault(); return; }
      const filterChip = t.closest('.term-filterchip') as HTMLElement | null;
      if (filterChip && doFilter(filterChip)) e.preventDefault();
    };
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKey);
    };
  }, []);

  /* ════════════════════════════════════════════════════════════════
     Welcome message — runs exactly once, only when the buffer is
     empty (avoids duplicating on hot reloads / re-mounts).
     ════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (welcomeShownRef.current) return;
    welcomeShownRef.current = true;

    const s = useNaksha.getState();
    if (s.lines.length > 0) return;

    s.print('Naksha — Geographic Shell', 'header');
    s.print('');
    s.print('A terminal-based workspace for maps, files, and thoughts.', 'muted');
    s.print('');
    /* Task 67 — the welcome teaches in CHIPS now: every quoted command
     * becomes a one-click word (the Task 66 chips payload, zero new
     * machinery). The receipt IS the command line — from the very first
     * screen, reading about a verb and running it are the same gesture.
     * Task 93 — the leads shrink so lead + chips hold ONE line at the
     * default pane's ~35 columns (the welcome is the app's face; a
     * wrapped chip row is not the first impression it should make).
     * The rivers and the constellation split into a two-line pair —
     * same poetry, honest width. */
    s.print('Getting started:', 'highlight');
    s.print('  every command:', 'output', {
      chips: [{ cmd: 'help', label: 'help', title: 'run: help — the full command index' }],
    });
    s.print('  fly to a place:', 'output', {
      chips: [{ cmd: 'goto tehran', label: 'goto tehran', title: 'run: goto tehran — fly the map to a place' }],
    });
    s.print('  first thought:', 'output', {
      chips: [{ cmd: 'node My Project', label: 'node My Project', title: 'run: node My Project — create a thought under the root' }],
    });
    s.print('  the rivers:', 'output', {
      chips: [
        { cmd: 'care', label: 'care', title: 'run: care — list your networks (rivers)' },
      ],
    });
    s.print('  the constellation:', 'output', {
      chips: [
        { cmd: 'workspace', label: 'workspace', title: 'run: workspace — star-constellation drawing (Esc exits)' },
      ],
    });
    s.print('');
    s.print('All data persists in your browser. Press / to focus.', 'muted');
    s.print('');
  }, []);

  /* ════════════════════════════════════════════════════════════════
     Global '/' shortcut — focus the terminal input unless the user
     is already typing somewhere, or focus/nano mode is active.
     ════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/') return;

      const s = useNaksha.getState();
      if (s.focusActive || s.nanoOpen) return;

      const ae = document.activeElement as HTMLElement | null;
      if (ae) {
        const tag = ae.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) {
          return;
        }
      }

      e.preventDefault();
      inputRef.current?.focus();
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /* ════════════════════════════════════════════════════════════════
     Task 80 — global ⌘/Ctrl+Z: the undo slot's KEYBOARD door. Every
     destructive verb already parks a snapshot in the slot and the
     terminal's `undo` verb speaks the consume contract; the keyboard
     now speaks it too — one history, one head, two doors. It rides
     CommandRunner.execute('undo') so the receipt prints exactly as
     the verb does (and programmatic executes don't pollute history,
     the same contract the command palette rides). Inputs keep their
     native text undo — the interception only fires when no editable
     element holds focus. Task 81 — ⇧⌘Z is the redo twin: same guard,
     forward direction, the SAME line of history.
     ════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      const s = useNaksha.getState();
      if (s.nanoOpen) return; // the nano editor owns its own keys
      const ae = document.activeElement as HTMLElement | null;
      if (ae) {
        const tag = ae.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) {
          return; // text undo belongs to the text
        }
      }
      e.preventDefault();
      /* Task 81 — the twin doors: ⌘Z walks back, ⇧⌘Z walks forward.
       * Both ride CommandRunner.execute so the receipts (and the
       * truncation rule) are the verb's own. */
      void CommandRunner.execute(e.shiftKey ? 'redo' : 'undo');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /* ════════════════════════════════════════════════════════════════
     Helpers
     ════════════════════════════════════════════════════════════════ */

  /** Move the caret to the end of the input (used after history fill). */
  const moveCaretToEnd = () => {
    const el = inputRef.current;
    if (!el) return;
    const len = el.value.length;
    el.setSelectionRange(len, len);
  };

  /** Echo a command, push it to history, reset history index. */
  const echoAndRecord = (cmd: string) => {
    const s = useNaksha.getState();
    /* Phase 4 — the echoed command NAMES the world it ran in (the same
     * contextReceiptTag the receipts speak): the scrollback becomes a
     * routing audit trail — `[vault:test-vault] ls` vs `[internal] ls` —
     * while history stores the RAW command. */
    const tag = contextReceiptTag(resolveStorageContext(s.settings.storageContext, s.vaultStatus));
    s.print(cmd ? `${tag} ${cmd}` : cmd, 'cmd');
    s.pushHistory(cmd);
    s.setHistoryIndex(useNaksha.getState().history.length);
  };

  /* ════════════════════════════════════════════════════════════════
     Input onChange — only used to feed reverse-i-search while it's
     active. The input is otherwise uncontrolled (we read
     `e.currentTarget.value` directly in the keydown handler).
     ════════════════════════════════════════════════════════════════ */
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const s = useNaksha.getState();
    if (s.reverseSearch) {
      s.updateReverseSearch(e.target.value);
    }
  };

  /* ════════════════════════════════════════════════════════════════
     Input keydown — the heart of the terminal.
     ════════════════════════════════════════════════════════════════ */
  const onKeyDown = async (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const s = useNaksha.getState();

    /* ── Ctrl / Meta combos ── */
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();

      if (key === 'r') {
        e.preventDefault();
        if (!s.reverseSearch) {
          s.startReverseSearch();
          if (inputRef.current) inputRef.current.value = '';
        } else {
          // Already in reverse search — re-run with the current query.
          s.updateReverseSearch(inputRef.current?.value ?? '');
        }
        return;
      }

      if (key === 'l') {
        e.preventDefault();
        s.clear();
        return;
      }

      if (key === 'c') {
        // Ctrl+C — just clear the current input line (no signal handling).
        if (inputRef.current) inputRef.current.value = '';
        if (s.reverseSearch) s.endReverseSearch();
        return;
      }
    }

    /* ── Esc ── */
    if (e.key === 'Escape') {
      if (s.reverseSearch) {
        s.endReverseSearch();
        if (inputRef.current) inputRef.current.value = '';
      } else {
        inputRef.current?.focus();
      }
      return;
    }

    /* ── Enter ── */
    if (e.key === 'Enter') {
      e.preventDefault();

      // Reverse-i-search: execute the matched command, if any.
      if (s.reverseSearch) {
        const result = s.reverseResult;
        s.endReverseSearch();
        if (inputRef.current) inputRef.current.value = '';
        if (result.trim()) {
          echoAndRecord(result);
          await CommandRunner.execute(result);
        }
        return;
      }

      const cmd = e.currentTarget.value.trim();
      if (inputRef.current) inputRef.current.value = '';

      if (!cmd) {
        // Empty enter — just print a fresh prompt line.
        useNaksha.getState().print('', 'cmd');
        return;
      }

      echoAndRecord(cmd);
      await CommandRunner.execute(cmd);
      return;
    }

    /* ── Tab completion ── */
    if (e.key === 'Tab') {
      e.preventDefault();
      if (s.reverseSearch) return;

      const val = e.currentTarget.value;
      if (!val.trim()) return;

      /* Layer 1 — verb completion (no space typed yet). */
      if (!val.includes(' ')) {
        const token = val.trim();
        const all = CommandRunner.getAllCommandNames();
        const matches = all.filter((c) => c.startsWith(token));

        if (matches.length === 1) {
          if (inputRef.current) inputRef.current.value = matches[0] + ' ';
          requestAnimationFrame(moveCaretToEnd);
        } else if (matches.length > 1) {
          s.print(matches.join('  '), 'muted');
        }
        return;
      }

      /* Layer 1.5 — skeleton slots (Task 103). A skeleton prefill (a
       * palette pick of a multi-slot verb) leaves a two-space gap at
       * every unfilled slot. While any gap remains, TAB is a FORM
       * NAVIGATOR, not the token-completer: at a gap it completes that
       * gap's own slot (node pools etc. — the gap↔slot mapping is
       * ordinal: filled slots consume their gaps, so gap k among the
       * REMAINING gaps maps to slot n−remaining+k); elsewhere it jumps
       * to the next gap's fill caret, or the trailing end. Layer 2's
       * token-counting heuristic cannot see empty slots (they produce
       * no tokens) — it must not run mid-skeleton. */
      const caret = e.currentTarget.selectionStart ?? val.length;
      const gaps = [...val.matchAll(/ {2,}/g)];
      if (gaps.length > 0) {
        const head = val.trim().split(/\s+/)[0].toLowerCase();
        const def = CommandRunner.get(head);
        const sk = def ? buildArgSkeleton(def.usage) : null;
        const slotTokens = sk?.slotTokens ?? [];
        const gapIdx = gaps.findIndex(
          (g) => g.index < caret && caret <= g.index + g[0].length,
        );

        if (gapIdx === -1) {
          /* Between gaps — advance to the next slot's fill caret, or to
           * the trailing end when only an end-space remains. */
          const target =
            gaps.map((g) => g.index + 1).find((p) => p > caret) ??
            (val.endsWith(' ') && caret < val.length ? val.length : null);
          if (target != null) inputRef.current?.setSelectionRange(target, target);
          return;
        }

        const g = gaps[gapIdx];
        const k = slotTokens.length - gaps.length + gapIdx;
        const slotToken = k >= 0 && k < slotTokens.length ? slotTokens[k] : null;
        const cands =
          slotToken && def ? CommandRunner.getArgCandidates(def, slotToken) ?? [] : [];
        const partial = val.slice(g.index + 1, caret).trim();
        const matches = partial
          ? cands.filter((c) => c.toLowerCase().startsWith(partial.toLowerCase()))
          : cands;
        if (matches.length === 1) {
          /* Fill THIS gap: keep the gap's first space (separator), splice
           * the candidate over whatever partial sits before the caret. */
          const filled = val.slice(0, g.index + 1) + matches[0] + val.slice(caret);
          if (inputRef.current) inputRef.current.value = filled;
          const np = g.index + 1 + matches[0].length;
          inputRef.current?.setSelectionRange(np, np);
          return;
        }
        if (matches.length > 1) {
          s.print(matches.join('  '), 'muted');
          return;
        }
        /* Free-form slot (no candidates) — TAB advances out of the gap. */
        const target =
          gaps
            .slice(gapIdx + 1)
            .map((gg) => gg.index + 1)
            .find((p) => p > caret) ??
          (val.endsWith(' ') && caret < val.length ? val.length : null);
        if (target != null) inputRef.current?.setSelectionRange(target, target);
        return;
      }

      /* Layer 2 — argument completion (Task 95). The usage string maps
       * the tail: 'caregraph [tree|graph]' offers its literals, node-ish
       * slots offer the CareSpace labels, 'view' offers saved views.
       * Free-form slots (<place>, <path>, <text>) stay silent — a wrong
       * suggestion is worse than none. */
      const parts = val.trim().split(/\s+/);
      const partial = val.endsWith(' ') ? '' : parts[parts.length - 1];
      const slotIdx = val.endsWith(' ') ? parts.length - 1 : parts.length - 2;
      const def = CommandRunner.get(parts[0].toLowerCase());
      if (!def) return;
      const slots = def.usage.split(/\s+/).slice(1);
      const slot = slots[slotIdx];
      if (!slot) return;
      const cands = CommandRunner.getArgCandidates(def, slot);
      if (!cands || cands.length === 0) return;

      const lower = partial.toLowerCase();
      const matches = cands.filter((c) => c.toLowerCase().startsWith(lower));
      if (matches.length === 1) {
        if (inputRef.current) {
          /* Trailing space = the separator is already typed; otherwise the
           * completed token's head is every part but the last. */
          const head = val.endsWith(' ') ? val : parts.slice(0, -1).join(' ') + ' ';
          inputRef.current.value = head + matches[0] + ' ';
        }
        requestAnimationFrame(moveCaretToEnd);
      } else if (matches.length > 1) {
        s.print(matches.join('  '), 'muted');
      }
      return;
    }

    /* ── Arrow Up — previous history entry ── */
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (s.reverseSearch) return;
      CommandRunner.historyPrevious();
      if (inputRef.current) {
        inputRef.current.value = CommandRunner.getCurrentHistoryEntry();
        requestAnimationFrame(moveCaretToEnd);
      }
      return;
    }

    /* ── Arrow Down — next history entry ── */
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (s.reverseSearch) return;
      CommandRunner.historyNext();
      if (inputRef.current) {
        inputRef.current.value = CommandRunner.getCurrentHistoryEntry();
        requestAnimationFrame(moveCaretToEnd);
      }
      return;
    }
  };

  /* ════════════════════════════════════════════════════════════════
     Render
     ════════════════════════════════════════════════════════════════ */
  return (
    <div
      className="naksha-glass flex min-w-0 flex-col"
      style={{ height: '100%', minHeight: 0, maxWidth: '100%' }}
      role="region"
      aria-label="Terminal"
    >
      {/* Task 30: ledger line numbers for echoed commands, via CSS counters.
          Lives in a component-scoped <style> because this dev environment's Turbopack
          CSS pipeline is FROZEN (globals.css edits never reach the served
          chunk — verified twice across sessions); JS modules hot-reload fine. */}
      <TerminalStyles />
      {/* ── Header (40px) — Task 113: flat glass-2 strip like every other
          pane header (the gradient sheen + inset shadow died with the
          StatusBar calm-down; the header just kept them), quiet dot
          without glow, sentence-case Inter title. ── */}
      <div
        className="flex h-10 flex-shrink-0 items-center justify-between border-b border-[var(--naksha-border)] px-4"
        style={{
          background: 'var(--naksha-glass-2)',
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--naksha-gold)]"
            aria-hidden="true"
          />
          <span className="text-[length:var(--naksha-fs-xs)] font-medium text-[var(--naksha-text-3)]">
            Terminal
          </span>
        </div>
        <span
          className="max-w-[60%] truncate font-mono text-[length:var(--naksha-fs-xs)] text-[var(--naksha-gold)]"
          /* Phase 4 — the header names the ACTIVE world's directory:
           * the vault root + jailed rel cwd when connected, the internal
           * path otherwise (same element, one truth). */
          title={
            activeContext.kind === 'connected'
              ? `${activeContext.root ?? ''}${vaultCwd ? `/${vaultCwd}` : ''} — the connected real directory`
              : cwd
          }
        >
          {activeContext.kind === 'connected'
            ? `⌂ ${activeContext.name ?? 'vault'}${vaultCwd ? `/${vaultCwd}` : ''}`
            : cwd}
        </span>
      </div>

      {/* ── Output (scrollable) ── */}
      <div
        ref={outputRef}
        className={`naksha-term-history naksha-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-2 ${fontClass} text-[13px] leading-[1.7] text-[var(--naksha-text)]`}
        aria-live="polite"
        aria-relevant="additions"
      >
        {lines.map((line) => (
          <TermLineRow key={line.id} line={line} />
        ))}
        <TermSpinnerLine />
      </div>

      {/* ── Reverse-i-search overlay ── */}
      {reverseSearch && (
        <div className="min-w-0 flex-shrink-0 truncate border-t border-[var(--naksha-border)] bg-[var(--naksha-glass-2)] px-4 py-1 font-mono text-[11px] text-[var(--naksha-info)]">
          (reverse-i-search):{' '}
          <span className="text-[var(--naksha-gold-light)]">{reverseQuery || '·'}</span>
          {' → '}
          <span>{reverseResult || '—'}</span>
        </div>
      )}

      {/* ── Input row ── */}
      <div className="term-inputrow flex min-w-0 flex-shrink-0 items-center gap-2 border-t border-[var(--naksha-border)] bg-[var(--naksha-glass-2)] px-4 py-2">
        {/* Phase 4 — the world chip: `[internal]` or `[connected:name]`
            always visible, so the input line cannot lie about where the
            typed fs verbs will run (the full root rides the title). The
            cwd next to it shows the ACTIVE world's directory — the
            internal zsh-style path, or the vault-world cwd. */}
        {activeContext.kind === 'connected' ? (
          <span
            className={`min-w-0 shrink truncate text-[11px] font-bold text-[var(--naksha-gold)] opacity-80 ${fontClass}`}
            title={`terminal routes to the real directory: ${activeContext.root ?? '?'} · 'context internal' routes back`}
            aria-label={`Storage context connected to ${activeContext.name ?? 'vault'}`}
          >
            [connected:{activeContext.name ?? '?'}]
          </span>
        ) : (
          <span
            className={`min-w-0 shrink truncate text-[11px] font-bold ${activeContext.reason === 'fallback-unavailable' ? 'text-[var(--naksha-gold-light)]' : 'text-[var(--naksha-text-2)] opacity-70'} ${fontClass}`}
            title={
              activeContext.reason === 'fallback-unavailable'
                ? `the saved 'connected' vault is unavailable — the terminal runs on the internal FS until it returns`
                : `terminal routes to the internal (browser-side) FS`
            }
            aria-label={
              activeContext.reason === 'fallback-unavailable'
                ? 'Storage context internal — the connected vault is unavailable, fell back to internal'
                : 'Storage context internal'
            }
          >
            [internal]
          </span>
        )}
        <span
          className={`term-cwd min-w-0 whitespace-nowrap font-bold text-[13px] text-[var(--naksha-gold)] ${fontClass}`}
          aria-hidden="true"
          title={activeContext.kind === 'connected' ? `${activeContext.root ?? ''}${vaultCwd ? `/${vaultCwd}` : ''}` : cwd}
        >
          {/* zsh-style working-directory prompt: `~` at the FS root,
              `~/name` one level deep (full path on hover). Expert
              muscle-memory: the prompt tells you WHERE you are without
              reading the header strip. Connected context shows the
              vault-world cwd instead (same dialect, other world). */}
          {activeContext.kind === 'connected'
            ? `${vaultPromptCwd(vaultCwd, activeContext.name ?? 'vault')} ❯`
            : `${cwd === '~' ? '~' : `~/${cwd.split('/').filter(Boolean).pop() ?? ''}`} ❯`}
        </span>
        <input
          id="naksha-terminal-input"
          ref={inputRef}
          type="text"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          autoFocus
          aria-label="Terminal command input"
          onChange={onChange}
          onKeyDown={onKeyDown}
          className={`min-w-0 flex-1 border-none bg-transparent px-0 text-[13px] text-[var(--naksha-text)] caret-[var(--naksha-gold)] outline-none placeholder:text-[var(--naksha-text-4)] ${fontClass}`}
        />
      </div>
    </div>
  );
}

/**
 * TermLineRow — ONE memoized row of the terminal buffer.
 *
 * Perf: the old renderer inlined this body inside `lines.map`, so every
 * store update to `lines` re-ran the full payload destructuring (~15
 * fields) and JSX build for EVERY row. As a `memo` component keyed on
 * the line's identity (line objects are immutable — `print` never
 * mutates them), a row re-renders only when that specific line changes;
 * appending line N costs one new row render, not 500.
 */
const TermLineRow = memo(function TermLineRow({ line }: { line: TermLine }) {
    /* Task 42 — fly payload → data attributes for the delegated
   * click listener above. No per-line handlers, no context. */
  const fly = line.data?.fly;
  /* Task 46 — ⇥ jump payload → the tree-landing twin of the fly
   * row. Same dumb-div render, same delegated listener. */
  const jump = line.data?.jump;
  /* Task 47 — nested ↗ fly badge: rendered at the row's tail when
   * the thought has a pin. A span with data-fly-* attrs — the
   * delegated listener checks `.term-flybadge` before the jump
   * row, so chip = map fly, text = tree landing. */
  const flyBadge = line.data?.flyBadge;
  /* Task 48 — the mirror chip: a ⇥ chip at the tail of a FLY row
   * (near results) — chip = tree landing + details, text stays
   * the row's primary fly verb. */
  const jumpBadge = line.data?.jumpBadge;
  /* Task 49 — the FILESYSTEM verb: an `ls` row (dir or file) —
   * click = cd into the folder / cat the file. Same dumb-div
   * render: class + data attributes, the delegated listener does
   * the work. */
  const fs = line.data?.fs;
  /* Task 52 — the DELETE verb: a `notes` row (data-del-*) — click
   * = delete that note with undo. The row hover strikes through. */
  const del = line.data?.del;
  /* Task 52 — the READER chip: a ▤ chip on reader-eligible file
   * rows — click = open in the reader panel (cat -r's surface). */
  const read = line.data?.read;
  /* Task 53 — the three new payloads: kill chip (✕ on pins and
   * views rows), view apply row, and the shapes count filter
   * chip. Same dumb-div render, same delegated listener. */
  const kill = line.data?.kill;
  const view = line.data?.view;
  const filter = line.data?.filter;
  /* Task 66 — the PLURAL twin: an array of word-chips (demo's try
   * line, stats' per-river line). Each renders with the SAME
   * .term-filterchip class + data-filter-cmd attribute, so the
   * delegated listener treats every one as a filter chip — echo
   * + run, zero new click code. */
  const chips = line.data?.chips;
  /* Task 44 — provenance bullet: a tinted ● prefix (the thought's
   * first-tag color, same rule as map markers and graph dots).
   * Pure render — a span, not a handler; the row stays a dumb div. */
  const bullet = line.data?.bullet;
  const bulletHollow = line.data?.bulletHollow === true;
  return (
    <div
      /* Phase 8 — OUTPUT rows carry dir="auto" so a Persian
       * result line renders right-to-left readably while the
       * first strong character decides per line (the Unicode
       * first-strong rule). Command echoes (type 'cmd') are
       * pinned dir="ltr" — an UNSET dir would INHERIT the chrome's
       * rtl and bidi-reorder the Latin command syntax (caught in
       * QA: the ledger gutter swapped ends and `> file` ran to
       * the wrong side). The input row is untouched too. */
      dir={line.type === 'cmd' ? 'ltr' : 'auto'}
      className={`term-line ${line.type}${fly ? ' term-fly' : ''}${jump ? ' term-jump' : ''}${fs ? ' term-fsrow' : ''}${del ? ' term-delrow' : ''}${view ? ' term-viewrow' : ''}`}
      data-fly-lat={fly ? fly.lat : undefined}
      data-fly-lng={fly ? fly.lng : undefined}
      data-fly-zoom={fly ? fly.zoom : undefined}
      data-fly-label={fly ? (fly.label ?? line.text.trim().split(/\s{2,}/).pop()) : undefined}
      data-jump-node={jump ? jump.nodeId : undefined}
      data-jump-river={jump ? jump.river : undefined}
      data-fs-path={fs ? fs.path : undefined}
      data-fs-kind={fs ? fs.kind : undefined}
      data-fs-world={fs ? fs.world : undefined}
      data-del-node={del ? del.nodeId : undefined}
      data-del-index={del ? del.index : undefined}
      data-view-name={view ? view.name : undefined}
      title={
        fly
          ? 'click to fly the map here'
          : jump
            ? 'click to open this thought in the tree'
            : del
              ? 'click to delete this note (undo available)'
              : view
                ? 'click to apply this view · ✕ removes it'
                : fs
                  ? fs.kind === 'dir'
                    ? 'click to enter this folder'
                    : 'click to read this file · ▤ opens the reader panel'
                  : undefined
      }
    >
      {line.type === 'cmd' ? (
        <>
          <span className="prompt">❯</span>
          {line.text}
        </>
      ) : (
        <>
          {bullet && (
            <span aria-hidden="true" style={{ color: bullet, marginRight: '0.35em' }}>
              {/* Task 87 — ○ for absence (the hollow ring), ● for
                  a worn color — the two bullets read as one
                  dialect across graph and terminal. */}
              {bulletHollow ? '○' : '●'}
            </span>
          )}
          <ColoredText text={line.text} />
          {flyBadge && (
            <span
              className="term-flybadge"
              data-fly-lat={flyBadge.lat}
              data-fly-lng={flyBadge.lng}
              data-fly-zoom={flyBadge.zoom}
              data-fly-label={flyBadge.label}
              title="↗ fly the map to this thought's pin (Enter runs it too)"
              /* Task 111 — a glyph is not a name: every badge/ chip
               * in this log was a role=button NAMED by its arrow,
               * with the words hiding in the title. The names now
               * carry the verb; the glyphs stay visible. */
              aria-label="Fly the map to this thought's pin"
              tabIndex={0}
              role="button"
            >
              ↗
            </span>
          )}
          {jumpBadge && (
            <span
              className={`term-jumpbadge${jumpBadge.tint ? ' term-tintbadge' : ''}`}
              data-jump-node={jumpBadge.nodeId}
              data-jump-river={jumpBadge.river}
              /* Task 68 — a tinted badge wears its TARGET's hue
               * (the thought it lands on) via the same --chip-tint
               * var the filter chips use; violet stays the default
               * for untinted badges — the tree dialect, unchanged. */
              style={jumpBadge.tint ? ({ '--chip-tint': jumpBadge.tint } as React.CSSProperties) : undefined}
              /* Task 59 — the chip tooltip speaks the ROW's mark:
               * the counted ▤N / ● the row wears is the same fact
               * the chip names, from the same payload (no second
               * story). Unmarked rows keep the plain title. */
              title={`⇥ open${jumpBadge.label ? ` "${jumpBadge.label}"` : ' this thought'}${jumpBadge.mark ? ` ${jumpBadge.mark}` : ''} in the tree (Enter runs it too)`}
              /* Task 111 — the chip names its LANDING (the same
               * words the title speaks, minus the glyph and the
               * parenthetical lesson). */
              aria-label={`Open${jumpBadge.label ? ` "${jumpBadge.label}"` : ' this thought'}${jumpBadge.mark ? ` ${jumpBadge.mark}` : ''} in the tree`}
              tabIndex={0}
              role="button"
            >
              ⇥
            </span>
          )}
          {read && (
            <span
              className="term-readbadge"
              data-read-path={read.path}
              data-read-world={read.world}
              title="▤ read this file in the reader panel (what cat -r opens) — Enter runs it too"
              aria-label="Read this file in the reader panel"
              tabIndex={0}
              role="button"
            >
              ▤
            </span>
          )}
          {filter && (
            <span
              className="term-filterchip"
              data-filter-cmd={filter.cmd}
              /* Task 65 — label/title overrides: a filter chip can
               * speak its own glyph (near rows wear ⚑N) while the
               * verb underneath stays the exact same re-run. */
              title={filter.title ?? "filter the inventory to this thought's sketches"}
              /* Task 111 — ⚑N / ≡ glyphs got their words the same
               * way; the title is already the sentence. */
              aria-label={filter.title ?? "filter the inventory to this thought's sketches"}
              tabIndex={0}
              role="button"
            >
              {filter.label ?? '≡'}
            </span>
          )}
          {chips?.map((c, i) => (
            <span
              key={`${line.id}-chip-${i}`}
              className={`term-filterchip${c.tint ? ' term-tintchip' : ''}${c.kbd ? ' term-kbdchip' : ''}`}
              data-filter-cmd={c.cmd}
              title={c.title ?? `run: ${c.cmd}`}
              tabIndex={0}
              role="button"
              /* Task 111 — keycap chips (⌘Z / ⇧⌘Z) read as KEYS on
               * purpose (Task 93's width budget: "the glyph IS the
               * verb; the title carries the words") — but a keycap
               * is not an action NAME. AT hears the title's words;
               * the visible glyph never changes. */
              aria-label={c.kbd ? (c.title ?? `run: ${c.cmd}`) : undefined}
              /* Task 67 — a tinted chip wears its river's hue via
               * one CSS var; the stylesheet (not JS) does the color
               * mixing, so hover stays gold with zero inline math. */
              style={c.tint ? ({ '--chip-tint': c.tint } as React.CSSProperties) : undefined}
            >
              {c.label}
            </span>
          ))}
          {kill && (
            <span
              className="term-killchip"
              data-kill-pin={kill.pin ?? undefined}
              data-kill-view={kill.view ?? undefined}
              title={kill.pin != null ? `✕ run: delpin ${kill.pin} — Enter runs it too` : `✕ run: rmview ${kill.view} — Enter runs it too`}
              /* Task 111 — the destructive chip says what it
               * destroys, by name, not by glyph. */
              aria-label={kill.pin != null ? `Delete pin ${kill.pin}` : `Delete view ${kill.view}`}
              tabIndex={0}
              role="button"
            >
              ✕
            </span>
          )}
        </>
      )}
    </div>
  );
});

/**
 * TermSpinnerLine — the network-command loading spinner.
 *
 * Perf: the spinner used to be a real entry in `lines`, animated by a
 * 10 Hz interval that re-mapped the whole 500-row buffer per tick. It
 * now lives in its own `termSpinner` store slice: this tiny component
 * is the only thing that re-renders while a command is in flight.
 */
function TermSpinnerLine() {
  const spinner = useNaksha((s) => s.termSpinner);
  if (!spinner) return null;
  return (
    <div className="term-line info term-spinner" dir="auto">
      <ColoredText text={spinner.message} />
    </div>
  );
}

/**
 * ColoredText — renders a terminal line with optional inline color
 * segments using a tiny markup built from Unicode private-use area
 * characters (guaranteed not to appear in normal text and NOT stripped
 * by the browser like ASCII control chars are):
 *   \uE000<color>\uE001<text>\uE002
 * Plain text (no markers) renders as-is. The `ls` command uses this
 * to color file-type icons (▸ gold, ✎ cream, ⚙ info, etc.).
 *
 * The markup is only ever produced by our own commands — never from
 * user input — so there's no XSS surface. All text is escaped by React.
 */
const COLOR_START = '\uE000';
const COLOR_MID = '\uE001';
const COLOR_END = '\uE002';

function ColoredText({ text }: { text: string }) {
  // Fast path: no markup, just render the string.
  if (text.indexOf(COLOR_START) === -1) return <>{text}</>;

  const segments: Array<{ text: string; color?: string }> = [];
  let i = 0;
  let buf = '';
  let currentColor: string | undefined;
  let inColor = false;
  let readingColor = false;

  while (i < text.length) {
    const ch = text[i];
    if (ch === COLOR_START) {
      if (buf) {
        segments.push({ text: buf, color: currentColor });
        buf = '';
      }
      inColor = true;
      readingColor = true;
      currentColor = '';
    } else if (ch === COLOR_MID && readingColor) {
      // Color value is now complete in `currentColor`.
      // Switch to reading the colored text into `buf`.
      readingColor = false;
      buf = '';
    } else if (ch === COLOR_END && inColor) {
      segments.push({ text: buf, color: currentColor });
      buf = '';
      currentColor = undefined;
      inColor = false;
    } else if (readingColor) {
      // We're reading the color value — append to currentColor, NOT buf.
      currentColor += ch;
    } else {
      buf += ch;
    }
    i++;
  }
  if (buf) segments.push({ text: buf, color: currentColor });

  return (
    <>
      {segments.map((seg, idx) =>
        seg.color ? (
          <span key={idx} style={{ color: seg.color }}>
            {seg.text}
          </span>
        ) : (
          <span key={idx}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** Component-scoped stylesheet: ledger line numbers on echoed commands.
 *  CSS-counter driven — no JS, no re-render cost. Kept here (not in
 *  globals.css) because the dev environment CSS pipeline is frozen; see Task 29/30. */
function TerminalStyles() {
  return (
    <style>{`
      .naksha-term-history { counter-reset: naksha-cmd; }
      .naksha-term-history .term-line.cmd { counter-increment: naksha-cmd; }
      .naksha-term-history .term-line.cmd::before {
        content: counter(naksha-cmd, decimal-leading-zero);
        display: inline-block;
        min-width: 24px;
        margin-right: 2px;
        color: color-mix(in srgb, var(--naksha-gold) 40%, transparent);
        font-weight: 400;
        font-size: 10px;
        vertical-align: 1px;
        letter-spacing: 0.5px;
      }
      /* perf-low: keep the ledger quiet but still visible (no animations to
         disable here — counters are static by nature). */
      html[data-perf="low"] .naksha-term-history .term-line.cmd::before {
        color: color-mix(in srgb, var(--naksha-gold) 30%, transparent);
      }
      /* Task 34 — CPU-only interaction cost: every command re-renders up to
         MAX_TERM_LINES (500) line nodes. content-visibility lets the engine
         SKIP layout + paint for lines scrolled out of the viewport — long
         outputs (help / whereis / cat) cost the same as short ones on
         CPU-only machines. contain-intrinsic-size keeps the scrollbar from
         jumping while offscreen lines are skipped. Applied to ALL tiers —
         it is a pure win (static, no animation) — but the history container
         must be the viewport boundary: overflow + a definite height make it
         one. */
      .naksha-term-history {
        contain: layout style;
      }
      /* webDevReview — prompt-row focus glow: while the terminal input is
         focused (the app's most-typed surface), the row's top hairline
         warms to gold and the cwd arrow brightens — a "this line is
         listening" affordance that disappears the moment focus leaves.
         Static :focus-within rules only — no transitions, the CPU rule
         holds (and the low tier keeps them too: pure paint). The cwd's
         base glow moved here from an inline style so focus-within can
         deepen it. */
      .term-inputrow .term-cwd {
        text-shadow: 0 0 8px color-mix(in srgb, var(--naksha-gold) 40%, transparent);
      }
      .term-inputrow:focus-within {
        border-top-color: color-mix(in srgb, var(--naksha-gold) 38%, transparent);
        box-shadow: inset 0 1px 0 color-mix(in srgb, var(--naksha-gold) 20%, transparent);
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--naksha-gold) 4.5%, transparent), transparent 70%),
          var(--naksha-glass-2);
      }
      .term-inputrow:focus-within .term-cwd {
        color: var(--naksha-gold-light);
        text-shadow: 0 0 10px color-mix(in srgb, var(--naksha-gold) 60%, transparent);
      }
      /* webDevReview — horizontal-clip guard: a long pre-formatted
         file-output line (white-space:pre + overflow-x:auto in the global
         sheet) once inflated the whole pane's scrollWidth, so a browser
         focus-scroll shifted the section and clipped every line's left
         edge. Capping the line at its container kills the overflow at the
         source (per-line horizontal scrolling still works). */
      .naksha-term-history .term-line.file-output {
        max-width: 100%;
        min-width: 0;
      }
      .naksha-term-history .term-line {
        content-visibility: auto;
        contain-intrinsic-size: auto 19px;
      }
      /* Task 46 — ⇥ jump rows: the tree-landing twin of .term-fly. Same
         interaction dialect (gold inset bar on hover), zero transitions
         (background/box-shadow flip instantly — CPU-only safe). Kept in
         this component-scoped sheet because JS modules hot-reload
         reliably in this dev environment, globals.css does not. */
      .naksha-term-history .term-line.term-jump {
        cursor: pointer;
      }
      /* Task T2 (v138) — the in-flight spinner row reads as "live": a gold
         left hairline (the same inset-bar dialect as the jump rows) plus a
         slightly dimmed voice separates in-flight receipts from settled
         output. Static paint — no animation (the 10 Hz glyph rotation
         happens inside the spinner's own store slice); safe on all tiers. */
      .naksha-term-history .term-line.term-spinner,
      .term-inputrow .term-line.term-spinner {
        box-shadow: inset 2px 0 0 color-mix(in srgb, var(--naksha-gold) 45%, transparent);
        opacity: 0.85;
      }
      /* The ⇥ glyph itself wears gold — the verb is the accent. */
      .naksha-term-history .term-line.term-jump::first-letter {
        color: var(--naksha-gold);
      }
      .naksha-term-history .term-line.term-jump:hover {
        background: color-mix(in srgb, var(--naksha-gold) 8%, transparent);
        box-shadow: inset 2px 0 0 color-mix(in srgb, var(--naksha-gold) 45%, transparent);
      }
      .naksha-term-history .term-line.term-jump:focus-visible {
        outline: 1px solid color-mix(in srgb, var(--naksha-gold) 50%, transparent);
        outline-offset: -1px;
      }
      /* Task 47 — nested ↗ fly badge on jump rows: the chip IS the ↗ verb
         on the same row. Quiet gold outline at rest (it must not shout at
         every row of the tree), solid fill on hover — the chip lights up
         while the row's inset bar shows the landing verb underneath. No
         transitions (instant flips, CPU-only safe), no new paint cost at
         rest beyond one bordered span per located row. */
      .naksha-term-history .term-flybadge {
        margin-left: 0.6em;
        padding: 0 0.3em;
        color: color-mix(in srgb, var(--naksha-gold) 62%, transparent);
        border: 1px solid color-mix(in srgb, var(--naksha-gold) 25%, transparent);
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
      }
      .naksha-term-history .term-flybadge:hover {
        color: var(--naksha-gold-light);
        background: color-mix(in srgb, var(--naksha-gold) 14%, transparent);
        border-color: color-mix(in srgb, var(--naksha-gold) 60%, transparent);
      }
      /* Task 48 — the mirror ⇥ chip on fly rows: violet = the tree side
         of the bridge (the same violet that marks tree selection), so
         the two chips read as two DESTINATIONS, not two sizes of the
         same thing. Same quiet-outline dialect, same instant hover. */
      .naksha-term-history .term-jumpbadge {
        margin-left: 0.6em;
        padding: 0 0.3em;
        color: rgba(167, 139, 250, 0.7);
        border: 1px solid rgba(167, 139, 250, 0.3);
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
      }
      .naksha-term-history .term-jumpbadge:hover {
        color: #c4b5fd;
        background: rgba(167, 139, 250, 0.15);
        border-color: rgba(167, 139, 250, 0.65);
      }
      /* Task 68 — the TINTED badge: a ⇥ chip carrying --chip-tint wears
         its TARGET's identity hue (the thought it lands on — first tag
         color, the same rule map markers and graph dots speak). Placed
         after .term-jumpbadge so the tint wins the base state; the
         violet :hover above (higher specificity) keeps its contract —
         hover always says "this is a tree chip", the base color says
         "this is WHOSE thought". */
      .naksha-term-history .term-tintbadge {
        color: var(--chip-tint);
        border-color: color-mix(in srgb, var(--chip-tint) 40%, transparent);
      }
      /* Task 49 — filesystem rows: the ls dialect. Folders and files are
         clickable with the SAME gold interaction language as jump rows
         (instant hover flip, no transition — CPU-only safe). The row
         wears a slightly quieter hover than jump rows so a long listing
         doesn't strobe gold while the cursor travels down it. */
      .naksha-term-history .term-line.term-fsrow {
        cursor: pointer;
      }
      .naksha-term-history .term-line.term-fsrow:hover {
        background: color-mix(in srgb, var(--naksha-gold) 5%, transparent);
        box-shadow: inset 2px 0 0 color-mix(in srgb, var(--naksha-gold) 30%, transparent);
      }
      /* Task 52 — the READER chip (▤) on reader-eligible file rows: a
         cool info-tinted chip — deliberately NOT gold (raw cat stays the
         row's gold verb) and NOT violet (no tree involved) — so the three
         chips read as three destinations: tree ⇥, map ↗, reader ▤.
         Same quiet-outline dialect, instant hover, no transitions. */
      .naksha-term-history .term-readbadge {
        margin-left: 0.6em;
        padding: 0 0.3em;
        color: rgba(115, 176, 209, 0.72);
        border: 1px solid rgba(115, 176, 209, 0.3);
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
      }
      .naksha-term-history .term-readbadge:hover {
        color: #a8d3ea;
        background: rgba(115, 176, 209, 0.15);
        border-color: rgba(115, 176, 209, 0.65);
      }
      /* Task 52 — the DELETE verb on notes rows: hover strikes the note
         through and tints it rust — destructive verbs must look
         destructive BEFORE the click, not after. Instant flips only. */
      .naksha-term-history .term-line.term-delrow {
        cursor: pointer;
      }
      .naksha-term-history .term-line.term-delrow:hover {
        background: rgba(192, 91, 77, 0.09);
        box-shadow: inset 2px 0 0 rgba(192, 91, 77, 0.4);
        text-decoration: line-through;
        text-decoration-color: rgba(192, 91, 77, 0.55);
        text-decoration-thickness: 1px;
      }
      /* Task 53 — the KILL chip (✕) on pins and views rows: destructive
         rust tint, same family as the delrow hover. Instant flip, no
         transitions — the verb reads BEFORE the click. */
      .naksha-term-history .term-killchip {
        margin-left: 0.6em;
        padding: 0 0.3em;
        color: rgba(192, 91, 77, 0.62);
        border: 1px solid rgba(192, 91, 77, 0.28);
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
      }
      .naksha-term-history .term-killchip:hover {
        color: #e8a49c;
        background: rgba(192, 91, 77, 0.16);
        border-color: rgba(192, 91, 77, 0.7);
      }
      /* Task 53 — the VIEW row: applying a saved view is a MAP verb, so
         the hover wears the gold interaction language (like fsrow), a
         quiet tint + inset bar — distinct from the destructive kill
         chip that shares the row. Instant flip, CPU-safe. */
      .naksha-term-history .term-line.term-viewrow {
        cursor: pointer;
      }
      .naksha-term-history .term-line.term-viewrow:hover {
        background: color-mix(in srgb, var(--naksha-gold) 5%, transparent);
        box-shadow: inset 2px 0 0 color-mix(in srgb, var(--naksha-gold) 30%, transparent);
      }
      /* Task 53 — the FILTER chip (≡) on shapes owner rows: a boxed
         count that re-runs the shapes filter for one thought. Muted
         outline that fills gold on hover — a drill-down verb, quieter
         than the row's own tree landing. Instant flip, no transitions. */
      .naksha-term-history .term-filterchip {
        margin-left: 0.6em;
        padding: 0 0.3em;
        color: rgba(160, 160, 150, 0.7);
        border: 1px solid rgba(160, 160, 150, 0.3);
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
      }
      /* Task 93 — the KEYCAP twin: chips whose payload is a keyboard
         verb (⌘Z undo / ⇧⌘Z redo on hist rows) read as keys, not
         pills — a faint keycap body (theme-bg mix) with a bottom bevel
         (inset shadow = the key's front edge). Static paint, no new
         transitions (the CPU rule holds); hover joins the gold family
         via the base chip's rule, unchanged. */
      .naksha-term-history .term-kbdchip {
        color: var(--naksha-text-2);
        background: color-mix(in srgb, var(--naksha-bg) 55%, transparent);
        border-color: rgba(160, 160, 150, 0.42);
        box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.16);
        padding: 0 0.45em;
      }
      .naksha-term-history .term-kbdchip:hover {
        color: var(--naksha-gold-light);
        background: color-mix(in srgb, var(--naksha-gold) 14%, transparent);
        border-color: color-mix(in srgb, var(--naksha-gold) 60%, transparent);
      }
      .naksha-term-history .term-filterchip:hover {
        color: var(--naksha-gold-light);
        background: color-mix(in srgb, var(--naksha-gold) 14%, transparent);
        border-color: color-mix(in srgb, var(--naksha-gold) 60%, transparent);
      }
      /* Task 67 — the TINTED twin: a chip carrying --chip-tint (stats'
         per-river chips ride their river's hue) colors itself from the
         var; color-mix softens the border without JS math. Placed after
         .term-filterchip so the tint wins the base state, while the
         :hover rule above (higher specificity) keeps hover gold — the
         shared verb surface never changes color contract mid-hover. */
      .naksha-term-history .term-tintchip {
        color: var(--chip-tint);
        border-color: color-mix(in srgb, var(--chip-tint) 45%, transparent);
      }
      /* Task 85 — a focusable chip needs a visible lock: the chip family
         draws the same gold keyboard-only ring the mini-btns speak
         (globals.css family), so a tabbed chip reads as a control, not
         an accident. Paint-only — the CPU rule holds. */
      .naksha-term-history .term-filterchip:focus-visible,
      .naksha-term-history .term-jumpbadge:focus-visible,
      .naksha-term-history .term-flybadge:focus-visible,
      .naksha-term-history .term-readbadge:focus-visible,
      .naksha-term-history .term-killchip:focus-visible {
        outline: 1px solid color-mix(in srgb, var(--naksha-gold) 65%, transparent);
        outline-offset: 1px;
      }
    `}</style>
  );
}
