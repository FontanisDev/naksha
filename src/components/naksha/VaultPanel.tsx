'use client';

/**
 * Naksha — VaultPanel (Phase 2)
 *
 * The Obsidian-like READ-ONLY window onto a REAL connected directory.
 * Explicit connection only (no silent filesystem access ever): while no
 * directory is configured this panel IS the configuration surface — type
 * an absolute path, click Connect, and the tree + reader come alive.
 *
 * Read-only is structural, not cosmetic: there is no write UI anywhere in
 * this panel, and the API routes it calls expose no write verb at all —
 * the server module cannot write even if asked. Renaming/deleting/creating
 * stays the terminal's job (nano etc.) on the REAL files, and this panel
 * simply reflects the results (watcher events + manual refresh).
 *
 * States (per spec):
 *  - No directory connected → the connect form (explicit step).
 *  - Connected & available  → tree + reader, vault name + paths visible.
 *  - Connected, unavailable → honest "directory unavailable" error state
 *    (the folder was renamed/deleted/mount-gone — never invented content).
 *  - Open note changed externally → auto-reload with a visible receipt.
 *
 * Performance: mounts only while open; the SSE watcher exists only while
 * this panel (or a reader receipt) is alive; tree/reader fetches are
 * one-shot per revision.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import { useNaksha } from '@/lib/naksha/store';
import { EmptyState, SkeletonRows } from '@/components/naksha/EmptyState';
import { ScrimDialog, PanelHeader } from '@/components/naksha/PanelPrimitives';
import { vaultMarkdownToHtml } from '@/lib/naksha/vault-markdown';
import { subscribeVaultEvents } from '@/lib/naksha/vault-sse';
import { t } from '@/lib/naksha/i18n';
import {
  contextChipLabel,
  contextChipTitle,
  resolveStorageContext,
} from '@/lib/naksha/vault-context';
import type { StorageContextPref, VaultStatus } from '@/lib/naksha/types';

interface TreeEntry {
  rel: string;
  name: string;
  isDir: boolean;
  depth: number;
}

interface LoadedFile {
  rel: string;
  content: string;
  html: string;
  size: number;
  mtimeMs: number;
}

const READER_EXT = ['md', 'markdown', 'txt', 'rst'];
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'pdf', 'zip',
  'gz', 'tar', 'rar', '7z', 'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'wasm', 'exe', 'dll', 'so', 'bin',
]);

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/* Tree windowing constants — see the windowing block in VaultPanelInner.
 * TREE_ROW_H must match the rendered row box (11px mono + 4/4 padding,
 * fixed only while windowing so the spacers stay honest).
 * TREE_WINDOW_MIN matches the panel's tree fetch cap (max=300, the route
 * allows ≤400): hitting the cap IS the "huge vault" signal — an uncapped
 * tree never reaches it, a truncated one always does. */
const TREE_ROW_H = 24;
const TREE_WINDOW_MIN = 300;
const TREE_WINDOW_OVERSCAN = 12;

/* Memoized tree row — vault revisions, status polls and file opens all
 * re-render this panel; rows whose entry/open/collapsed state didn't
 * change now skip re-rendering entirely. */
const VaultTreeRow = memo(function VaultTreeRow({
  entry,
  isOpen,
  collapsedHere,
  onToggle,
  onOpen,
  fixedH,
  revCount,
}: {
  entry: TreeEntry;
  isOpen: boolean;
  collapsedHere: boolean;
  onToggle: (rel: string) => void;
  onOpen: (rel: string) => void;
  fixedH: boolean;
  revCount: number;
}) {
  const isNote = READER_EXT.includes(entry.name.split('.').pop()?.toLowerCase() ?? '');
  const clickable = entry.isDir || (isNote && !BINARY_EXT.has(entry.name.split('.').pop()?.toLowerCase() ?? ''));
  return (
    <button
      onClick={() => {
        if (entry.isDir) onToggle(entry.rel);
        else if (isNote) onOpen(entry.rel);
      }}
      className="vault-tree-row font-mono w-full text-start"
      aria-current={isOpen ? 'true' : undefined}
      style={{
        /* Phase 8 — logical: the depth indent hugs the START
         * edge so an RTL chrome mirrors the tree honestly. */
        paddingInlineStart: 8 + entry.depth * 14,
        paddingInlineEnd: 8,
        paddingTop: 4,
        paddingBottom: 4,
        fontSize: 11,
        fontFamily: 'var(--naksha-font-mono)',
        color: isOpen
          ? 'var(--naksha-gold-light)'
          : entry.isDir
            ? 'var(--naksha-text-2)'
            : isNote
              ? 'var(--naksha-text)'
              : 'var(--naksha-text-4)',
        background: isOpen ? 'color-mix(in srgb, var(--naksha-gold) 12%, transparent)' : 'transparent',
        border: 'none',
        borderLeft: isOpen ? '2px solid var(--naksha-gold)' : '2px solid transparent',
        cursor: clickable ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        /* Fixed box ONLY while windowing (spacers must line up). */
        height: fixedH ? TREE_ROW_H : undefined,
        lineHeight: fixedH ? '16px' : undefined,
        flex: fixedH ? '0 0 auto' : undefined,
      }}
    >
      <span style={{ width: 10, display: 'inline-block', color: 'var(--naksha-text-4)' }}>
        {entry.isDir ? (collapsedHere ? '▸' : '▾') : ''}
      </span>
      <span style={{ color: entry.isDir ? 'var(--naksha-gold)' : isNote ? 'var(--naksha-text-3)' : 'var(--naksha-text-4)' }}>
        {entry.isDir ? '▣' : isNote ? '▤' : '·'}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {entry.name}
        {entry.isDir ? '/' : ''}
      </span>
      {/* T7 round 3 — the revisions badge (Trilium-style): a file with
        * archived history wears a small gold ⟲ counter at the row end.
        * Click-through stays the row's own open behavior; the tooltip
        * names the terminal command that opens the history. */}
      {!entry.isDir && revCount > 0 && (
        <span
          title={`${revCount} revision${revCount === 1 ? '' : 's'} — 'vault history ${entry.rel}'`}
          aria-label={`${revCount} revision${revCount === 1 ? '' : 's'}`}
          style={{
            marginLeft: 'auto',
            flex: 'none',
            fontSize: 9,
            fontFamily: 'var(--naksha-font-mono)',
            color: 'var(--naksha-gold-light)',
            background: 'color-mix(in srgb, var(--naksha-gold) 14%, transparent)',
            border: '1px solid color-mix(in srgb, var(--naksha-gold) 28%, transparent)',
            borderRadius: 999,
            padding: '0 5px',
            lineHeight: '13px',
          }}
        >
          ⟲{revCount}
        </span>
      )}
    </button>
  );
});

export function VaultPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <VaultPanelInner onClose={onClose} />;
}

function VaultPanelInner({ onClose }: { onClose: () => void }) {
  const status = useNaksha((s) => s.vaultStatus);
  const revision = useNaksha((s) => s.vaultRevision);
  const openFile = useNaksha((s) => s.vaultOpenFile);
  /* Phase 5 — the CareSpace writable-vault designation (mirrored
   * server-side state; the toggle here is one of its two doors). */
  const careStatus = useNaksha((s) => s.careVaultStatus);
  /* Phase 3 — the resolved storage context for the strip: same pure
   * resolver the StatusBar chip and terminal receipts call, so every
   * surface names the active world identically. */
  const storagePref = useNaksha((s) => s.settings.storageContext);
  /* Phase 8 — i18n-lite trigger + labels (t() reads the same slice). */
  const uiLang = useNaksha((s) => s.settings.uiLang);
  void uiLang;
  const storageCtx = useMemo(
    () => resolveStorageContext(storagePref, status),
    [storagePref, status],
  );

  const [connectPath, setConnectPath] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  /* statusLoading is DERIVED (status === null) — no effect setState needed. */
  const statusLoading = status === null;

  const [tree, setTree] = useState<TreeEntry[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /* T7 round 3 — per-file revision counts for the ⟲ tree badges
   * (POST /api/vault/revisions with no rel = per-path summary). */
  const [revCounts, setRevCounts] = useState<Map<string, number> | null>(null);
  /* T7 round 4 — the revision viewer (Trilium's revisions-tab analog):
   * a strip under the reader header lists the open file's revisions;
   * clicking one renders its archived content with a gold banner and a
   * one-click restore. */
  interface RevEntryLite {
    id: string;
    ts: number;
    size: number;
    kind: 'app' | 'observed';
    reason: string;
    delta?: { added: number; removed: number };
  }
  const [revList, setRevList] = useState<RevEntryLite[] | null>(null);
  const [revStripOpen, setRevStripOpen] = useState(false);
  const [viewingRev, setViewingRev] = useState<{ id: string; ts: number; reason: string; html: string } | null>(null);
  const [revBusy, setRevBusy] = useState<string | null>(null);
  const [revNote, setRevNote] = useState<string | null>(null);

  const [file, setFile] = useState<LoadedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [externalNote, setExternalNote] = useState<string | null>(null);
  const [missingLink, setMissingLink] = useState<string | null>(null);

  const fileRef = useRef<LoadedFile | null>(null);
  const readerBodyRef = useRef<HTMLDivElement>(null);

  /* ── status ── */
  useEffect(() => {
    void useNaksha.getState().refreshVaultStatus();
    /* Phase 5 — the designation mirror rides the same boot pull. */
    void useNaksha.getState().refreshCareVaultStatus();
  }, []);

  /* ── SSE watcher — exists only while the panel is open. The shared
   * client (one EventSource per page) fans external frames out to every
   * subscriber, so this no longer races NodeDetailsPanel's twin stream. ── */
  useEffect(
    () => subscribeVaultEvents(() => useNaksha.getState().bumpVaultRevision()),
    [],
  );

  /* ── tree — refetch on connect/revision/availability change ── */
  const connected = !!status?.connected;
  const available = !!status?.connected && !!status?.available;

  useEffect(() => {
    if (!available) return; // render gates the tree UI; state stays stale-safe
    let alive = true;
    void fetch('/api/vault/tree?max=300', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: { ok: boolean; entries?: TreeEntry[]; error?: string }) => {
        if (!alive) return;
        if (data.ok && data.entries) {
          setTree(data.entries);
          setTreeError(null);
        } else {
          setTree([]);
          setTreeError(data.error ?? 'tree failed');
        }
      })
      .catch(() => {
        if (alive) setTreeError('network error');
      });
    return () => {
      alive = false;
    };
  }, [available, revision, connected]);

  /* ── revision counts — refetch with the same rhythm as the tree, so a
   * fresh overwrite (app or external) lights the badge on the next bump. ── */
  useEffect(() => {
    let alive = true;
    if (!available) {
      // Clear off the synchronous effect path (react-hooks/set-state-in-effect).
      void Promise.resolve().then(() => {
        if (alive) setRevCounts(null);
      });
      return () => {
        alive = false;
      };
    }
    void fetch('/api/vault/revisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((data: { ok: boolean; paths?: Array<{ rel: string; count: number }> }) => {
        if (!alive) return;
        if (data.ok && data.paths) {
          const m = new Map<string, number>();
          for (const p of data.paths) m.set(p.rel, p.count);
          setRevCounts(m);
        } else {
          setRevCounts(null);
        }
      })
      .catch(() => {
        if (alive) setRevCounts(null);
      });
    return () => {
      alive = false;
    };
  }, [available, revision]);

  /* ── revision list for the strip — refetches with the panel's rhythm ── */
  useEffect(() => {
    let alive = true;
    const rel = available && revStripOpen ? openFile : null;
    if (rel === null) {
      void Promise.resolve().then(() => {
        if (alive) setRevList(null);
      });
      return () => {
        alive = false;
      };
    }
    void fetch('/api/vault/revisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel }),
    })
      .then((r) => r.json())
      .then((data: { ok: boolean; entries?: RevEntryLite[] }) => {
        if (alive) setRevList(data.ok ? (data.entries ?? []) : []);
      })
      .catch(() => {
        if (alive) setRevList([]);
      });
    return () => {
      alive = false;
    };
  }, [available, openFile, revStripOpen, revision]);

  /* Switching files always leaves revision view (the viewer is per-file). */
  useEffect(() => {
    void Promise.resolve().then(() => {
      setViewingRev(null);
      setRevBusy(null);
    });
  }, [openFile]);

  const revAgo = (ms: number): string => {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  const openRevision = (e: RevEntryLite): void => {
    if (!openFile) return;
    setRevBusy(e.id);
    void fetch('/api/vault/revisions/content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel: openFile, id: e.id }),
    })
      .then((r) => r.json())
      .then((data: { ok: boolean; content?: string; error?: string }) => {
        if (data.ok && typeof data.content === 'string') {
          setViewingRev({ id: e.id, ts: e.ts, reason: e.reason, html: vaultMarkdownToHtml(data.content, openFile) });
        } else {
          setRevNote(data.error ?? 'revision read failed');
          window.setTimeout(() => setRevNote(null), 5000);
        }
      })
      .catch(() => {
        setRevNote('network error');
        window.setTimeout(() => setRevNote(null), 5000);
      })
      .finally(() => setRevBusy(null));
  };

  const restoreFromViewer = (): void => {
    if (!openFile || !viewingRev) return;
    setRevBusy(viewingRev.id);
    void fetch('/api/vault/revisions/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel: openFile, id: viewingRev.id }),
    })
      .then((r) => r.json())
      .then((data: { ok: boolean; error?: string }) => {
        if (data.ok) {
          setViewingRev(null);
          useNaksha.getState().bumpVaultRevision();
          setRevNote(`restored ${openFile} ← ${viewingRev.id} — the live view follows`);
        } else {
          setRevNote(data.error ?? 'restore failed');
        }
        window.setTimeout(() => setRevNote(null), 5000);
      })
      .catch(() => {
        setRevNote('network error');
        window.setTimeout(() => setRevNote(null), 5000);
      })
      .finally(() => setRevBusy(null));
  };

  /* ── open note — refetch when the file changes or revision bumps ── */
  useEffect(() => {
    if (!available || !openFile) {
      fileRef.current = null; // ref only — render gates on openFile itself
      return;
    }
    let alive = true;
    void fetch(`/api/vault/read?p=${encodeURIComponent(openFile)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then(
        (data: {
          ok: boolean;
          content?: string;
          mtimeMs?: number;
          size?: number;
          error?: string;
        }) => {
          if (!alive) return;
          if (data.ok && typeof data.content === 'string') {
            const prev = fileRef.current;
            if (prev && prev.rel === openFile && prev.mtimeMs !== data.mtimeMs) {
              const t = new Date().toLocaleTimeString();
              setExternalNote(`changed externally — reloaded at ${t}`);
              window.setTimeout(() => setExternalNote(null), 5000);
            }
            const next: LoadedFile = {
              rel: openFile,
              content: data.content,
              html: vaultMarkdownToHtml(data.content, openFile),
              size: data.size ?? 0,
              mtimeMs: data.mtimeMs ?? 0,
            };
            fileRef.current = next;
            setFile(next);
            setFileError(null);
          } else {
            fileRef.current = null;
            setFile(null);
            setFileError(data.error ?? 'read failed');
          }
        },
      )
      .catch(() => {
        if (alive) {
          setFile(null);
          setFileError('network error');
        }
      });
    return () => {
      alive = false;
    };
  }, [available, openFile, revision]);

  /* ── vault link clicks — delegated, resolved to REAL files ── */
  const onReaderClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = (e.target as HTMLElement).closest?.('.vault-link') as HTMLElement | null;
      if (!el) return;
      const target = el.dataset.vaultTarget;
      if (!target) return;
      e.preventDefault();
      void fetch(`/api/vault/resolve?q=${encodeURIComponent(target)}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((data: { ok: boolean; rel?: string | null }) => {
          if (data.ok && data.rel) {
            setMissingLink(null);
            useNaksha.getState().setVaultOpenFile(data.rel);
          } else {
            setMissingLink(target);
            window.setTimeout(() => setMissingLink(null), 5000);
          }
        })
        .catch(() => setMissingLink(target));
    },
    [],
  );

  const onReaderKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    const el = (e.target as HTMLElement).closest?.('.vault-link') as HTMLElement | null;
    if (!el) return;
    e.preventDefault();
    el.click();
  }, []);

  /* ── Esc to close ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const doConnect = useCallback(async () => {
    const p = connectPath.trim();
    if (!p) return;
    setConnecting(true);
    setConnectError(null);
    const res = await useNaksha.getState().connectVault(p);
    setConnecting(false);
    if (!res.ok) setConnectError(res.error ?? 'connect failed');
    else setConnectPath('');
  }, [connectPath]);

  const doDisconnect = useCallback(async () => {
    await useNaksha.getState().disconnectVault();
    setFile(null);
    fileRef.current = null;
    setTree(null);
  }, []);

  /* Phase 5 — designate / un-designate. Explicit click, explicit
   * receipt; the terminal door is `vault designate on|off`. */
  const [careBusy, setCareBusy] = useState(false);
  const doDesignate = useCallback(async (on: boolean) => {
    setCareBusy(true);
    const r = await useNaksha.getState().designateCareVault(on);
    setCareBusy(false);
    const s = useNaksha.getState();
    if (r.ok) {
      s.print(
        on
          ? `Designated ${s.careVaultStatus?.root ?? 'the vault'} as the CareSpace vault — CareSpace may create/rename .md notes there (never delete)`
          : 'CareSpace designation cleared — the vault is read-only again, files untouched',
        'success',
      );
    } else {
      s.print(`vault designate: ${r.error ?? 'failed'}`, 'error');
    }
  }, []);

  const toggleDir = useCallback((rel: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, []);

  /* Open a note from the tree — stable callback so memoized rows skip
   * re-rendering when the panel re-renders for unrelated reasons. */
  const openTreeFile = useCallback((rel: string) => {
    setMissingLink(null);
    useNaksha.getState().setVaultOpenFile(rel);
  }, []);

  /* ── derived tree rows (respect collapse) ──
   * Memoized: the panel re-renders on every vaultRevision bump (now
   * debounced), file open, status poll — the walk only depends on the
   * tree snapshot + collapse set. */
  const visibleRows: TreeEntry[] = useMemo(() => {
    const rows: TreeEntry[] = [];
    if (tree) {
      for (const entry of tree) {
        if (entry.depth > 0) {
          // hide children of collapsed ancestors
          const ancestors = entry.rel.split('/').slice(0, -1);
          let hidden = false;
          let prefix = '';
          for (const a of ancestors) {
            prefix = prefix ? `${prefix}/${a}` : a;
            if (collapsed.has(prefix)) {
              hidden = true;
              break;
            }
          }
          if (hidden) continue;
        }
        rows.push(entry);
      }
    }
    return rows;
  }, [tree, collapsed]);

  /* ── tree windowing ──
   * The index can reach INDEX_CAP (4000) entries; mounting every visible
   * row as a styled button on each render made big vaults janky. Below
   * TREE_WINDOW_MIN the FULL list renders exactly as before (typical
   * vaults: zero behavior change); above it, a fixed-row-height window
   * keeps the mounted DOM bounded (~50 buttons) while scrollTop drives
   * the slice. */
  const [treeScrollTop, setTreeScrollTop] = useState(0);
  const virtualizeTree = visibleRows.length >= TREE_WINDOW_MIN;
  const winStart = virtualizeTree
    ? Math.max(0, Math.floor(treeScrollTop / TREE_ROW_H) - TREE_WINDOW_OVERSCAN)
    : 0;
  const winEnd = virtualizeTree
    ? Math.min(
        visibleRows.length,
        winStart +
          Math.ceil((typeof window !== 'undefined' ? window.innerHeight : 800) / TREE_ROW_H) +
          TREE_WINDOW_OVERSCAN * 2,
      )
    : visibleRows.length;
  const onTreeScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setTreeScrollTop(e.currentTarget.scrollTop);
  }, []);

  return (
    <ScrimDialog
      onClose={onClose}
      zIndex={4400}
      width="min(1100px, 95vw)"
      height="min(720px, 88vh)"
      blur={false}
      scrimAlpha={72}
      label="Connected directory vault"
    >
      {/* ── Header: context is ALWAYS visible (spec: connected directory visible in UI) ── */}
      <PanelHeader
        left={
          <>
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                transform: 'rotate(45deg)',
                display: 'inline-block',
                flexShrink: 0,
                background: available
                  ? 'var(--naksha-success)'
                  : connected
                    ? 'var(--naksha-error)'
                    : 'var(--naksha-text-4)',
              }}
            />
            <span
              className="font-semibold"
              style={{ fontSize: 'var(--naksha-fs-md)', color: 'var(--naksha-gold-light)', whiteSpace: 'nowrap' }}
            >
              {available
                ? `${t('vault.title', 'Vault')} · ${status?.name}`
                : connected
                  ? `${t('vault.title', 'Vault')} · ${t('vault.unavailable', 'unavailable')}`
                  : `${t('vault.title', 'Vault')} · ${t('vault.notConnected', 'not connected')}`}
            </span>
            {available && status?.root && (
              <span
                className="font-mono truncate"
                style={{ fontSize: 'var(--naksha-fs-xs)', color: 'var(--naksha-text-3)' }}
                title={status.root}
              >
                {status.root}
              </span>
            )}
            <span
              className="whitespace-nowrap"
              style={{
                fontSize: 'var(--naksha-fs-xs)',
                color: careStatus?.designated ? 'var(--naksha-gold-light)' : 'var(--naksha-text-4)',
                border: `1px solid ${careStatus?.designated ? 'var(--naksha-gold-dim)' : 'var(--naksha-border)'}`,
                borderRadius: 99,
                padding: '1px 8px',
              }}
              title={
                careStatus?.designated
                  ? 'Designated CareSpace vault — explicit CareSpace commands may create/rename .md notes here (never delete)'
                  : 'Every surface in this panel is read-only — the reader API exposes no write verb; the terminal’s real nano (PTY bridge) is the only writer'
              }
            >
              {careStatus?.designated ? t('vault.careWritable', 'care-writable ♦') : t('vault.readonly', 'read-only')}
            </span>
          </>
        }
        actions={
          <>
            {available && (
              <button
                onClick={() => useNaksha.getState().bumpVaultRevision()}
                style={{
                  fontSize: 'var(--naksha-fs-xs)',
                  color: 'var(--naksha-text-2)',
                  border: '1px solid var(--naksha-border)',
                  borderRadius: 8,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  background: 'transparent',
                }}
                title="Re-read the real directory (the watcher also auto-refreshes)"
                aria-label="Refresh vault"
              >
                ↻ {t('vault.refresh', 'refresh')}
              </button>
            )}
            {connected && (
              <button
                onClick={doDisconnect}
                style={{
                  fontSize: 'var(--naksha-fs-xs)',
                  color: 'var(--naksha-error)',
                  border: '1px solid var(--naksha-border)',
                  borderRadius: 8,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  background: 'transparent',
                }}
                title="Disconnect the connected directory (no files are modified)"
                aria-label="Disconnect vault"
              >
                ⏏ {t('vault.disconnect', 'disconnect')}
              </button>
            )}
            <button
              onClick={onClose}
              aria-label="Close vault panel"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--naksha-text-3)',
                fontSize: 16,
                cursor: 'pointer',
                padding: '4px 8px',
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </>
        }
      />

      {/* ── Context strip (Phase 3) — the internal/connected separation,
             always visible: which world is active, why, and the explicit
             switch. Same resolver as the StatusBar CTX chip — one story. ── */}
        <div
          className="flex items-center gap-2.5 px-5 shrink-0 flex-wrap"
          style={{
            minHeight: 34,
            padding: '5px 0',
            borderBottom: '1px solid var(--naksha-border)',
            background: 'rgba(255,255,255,0.02)',
          }}
          role="group"
          aria-label="Active storage context and switcher"
        >
          <span
            className="font-mono"
            style={{ fontSize: 10, color: 'var(--naksha-text-4)' }}
          >
            active context:
          </span>
          <span
            className="font-mono font-semibold"
            style={{
              fontSize: 11,
              color:
                storageCtx.kind === 'connected'
                  ? 'var(--naksha-success)'
                  : storageCtx.reason === 'fallback-unavailable'
                    ? 'var(--naksha-gold)'
                    : 'var(--naksha-text-2)',
            }}
            title={contextChipTitle(storageCtx)}
          >
            {contextChipLabel(storageCtx)}
            {storageCtx.reason === 'fallback-unavailable' && ' ⚠'}
          </span>
          {storageCtx.kind === 'internal' && !connected && (
            <span className="font-mono" style={{ fontSize: 10, color: 'var(--naksha-text-4)' }}>
              — connect a directory below to add a read-only connected world
            </span>
          )}
          <span className="flex-1" />
          <span
            className="font-mono"
            style={{ fontSize: 10, color: 'var(--naksha-text-4)' }}
          >
            work in:
          </span>
          {(['internal', 'connected'] as StorageContextPref[]).map((pref) => {
            const active = storageCtx.kind === pref;
            const canUse = pref === 'internal' || available;
            return (
              <button
                key={pref}
                type="button"
                disabled={!canUse || active}
                onClick={() => useNaksha.getState().setSettings({ storageContext: pref })}
                title={
                  pref === 'internal'
                    ? active
                      ? 'internal is the active context — the browser-side virtual FS answers the terminal'
                      : 'switch the active context to the internal (browser-side) FS'
                    : canUse
                      ? active
                        ? 'connected is the active context — vault surfaces AND the terminal read verbs (ls/cd/pwd/tree/cat/grep) read the real directory'
                        : 'switch the active context to the connected directory — the terminal read verbs follow'
                      : 'no directory connected (or it is unavailable) — connect one first'
                }
                aria-pressed={active}
                aria-label={`work in ${pref} storage context`}
                className="font-mono"
                style={{
                  fontSize: 10,
                  padding: '3px 10px',
                  borderRadius: 8,
                  cursor: active ? 'default' : canUse ? 'pointer' : 'not-allowed',
                  color: active
                    ? pref === 'connected'
                      ? 'var(--naksha-success)'
                      : 'var(--naksha-bg)'
                    : canUse
                      ? 'var(--naksha-text-2)'
                      : 'var(--naksha-text-4)',
                  background: active
                    ? pref === 'connected'
                      ? 'transparent'
                      : 'var(--naksha-gold)'
                    : 'transparent',
                  border: `1px solid ${
                    active
                      ? pref === 'connected'
                        ? 'var(--naksha-success)'
                        : 'var(--naksha-gold)'
                      : 'var(--naksha-border)'
                  }`,
                }}
              >
                {pref}
                {active ? ' ✓' : ''}
              </button>
            );
          })}
        </div>

        {/* ── CareSpace vault strip (Phase 5) — the explicit writable gate.
             Off = the vault stays purely read-only. On = CareSpace may
             CREATE and RENAME .md notes here through narrowly-gated
             commands (never delete). One click each way, receipt always. ── */}
        {available && (
          <div
            className="flex items-center gap-2.5 px-5 shrink-0 flex-wrap"
            style={{
              minHeight: 34,
              padding: '5px 0',
              borderBottom: '1px solid var(--naksha-border)',
              background: careStatus?.designated
                ? 'color-mix(in srgb, var(--naksha-gold) 5%, transparent)'
                : 'rgba(255,255,255,0.02)',
            }}
            role="group"
            aria-label="CareSpace vault designation"
          >
            <span
              className="font-mono"
              style={{ fontSize: 10, color: 'var(--naksha-text-4)' }}
            >
              carespace:
            </span>
            {careStatus?.designated ? (
              <>
                <span
                  className="font-mono font-semibold"
                  style={{ fontSize: 11, color: 'var(--naksha-gold-light)' }}
                  title="CareSpace may create and rename .md notes in this directory through explicit commands (careexport / carebind / node / rennode). No delete exists."
                >
                  designated ♦ writable for CareSpace notes
                </span>
                <button
                  type="button"
                  disabled={careBusy}
                  onClick={() => void doDesignate(false)}
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    padding: '3px 10px',
                    borderRadius: 8,
                    cursor: careBusy ? 'wait' : 'pointer',
                    color: 'var(--naksha-text-2)',
                    background: 'transparent',
                    border: '1px solid var(--naksha-border)',
                  }}
                  aria-label="Remove CareSpace designation"
                  title="Revoke the writable gate — the vault becomes purely read-only again; files are untouched and bound thoughts keep their paths"
                >
                  undesignate
                </button>
                <span className="font-mono" style={{ fontSize: 10, color: 'var(--naksha-text-4)' }}>
                  — text of bound thoughts lives in these files · metadata stays internal
                </span>
                {/* Phase 7 — the writable-mode warning: when real writes are
                    armed, the panel says so in plain words, every time. */}
                <div
                  role="note"
                  aria-label="Writable vault warning"
                  className="font-mono"
                  style={{
                    flexBasis: '100%',
                    marginTop: 4,
                    padding: '6px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--naksha-gold-dim)',
                    background: 'color-mix(in srgb, var(--naksha-gold) 8%, transparent)',
                  }}
                >
                  <span style={{ fontSize: 10.5, lineHeight: 1.55, color: 'var(--naksha-gold-light)' }}>
                    ⚠ writable vault — real writes happen here: CareSpace notes (create/rename) and real
                    nano saves hit this directory on disk. No delete exists; the PTY jail (relative paths,
                    no dotfiles, realpath containment) is the only write boundary.{' '}
                    <span style={{ color: 'var(--naksha-text-3)' }}>audit it live: vault doctor · revoke: vault designate off</span>
                  </span>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={careBusy}
                  onClick={() => void doDesignate(true)}
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    padding: '3px 10px',
                    borderRadius: 8,
                    cursor: careBusy ? 'wait' : 'pointer',
                    color: 'var(--naksha-gold-light)',
                    background: 'transparent',
                    border: '1px solid var(--naksha-gold-dim)',
                  }}
                  aria-label="Designate this vault for CareSpace"
                  title="Let CareSpace create and rename .md notes in this directory. Explicit commands only; no delete; existing files overwritten only by an explicit careexport."
                >
                  ♦ designate as CareSpace vault
                </button>
                <span className="font-mono" style={{ fontSize: 10, color: 'var(--naksha-text-4)' }}>
                  — lets CareSpace write its notes here as real .md files (explicit, reversible, no deletes)
                </span>
              </>
            )}
          </div>
        )}

        {/* ── Body ── */}
        {statusLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="font-mono text-xs" style={{ color: 'var(--naksha-text-3)' }}>
              checking vault status…
            </span>
          </div>
        ) : !connected ? (
          /* ── Connect form — the explicit step (no silent FS access) ── */
          <div className="flex-1 flex items-center justify-center p-8">
            <div style={{ maxWidth: 460, width: '100%' }} className="flex flex-col gap-4">
              <div className="font-mono text-sm" style={{ color: 'var(--naksha-gold-light)' }}>
                Connect a directory
              </div>
              <p className="font-mono text-[11px] leading-relaxed" style={{ color: 'var(--naksha-text-2)' }}>
                Point Naksha at a real folder of Markdown notes (an Obsidian-style vault —
                plain files, plain folders). Browsing and reading here are strictly
                <span style={{ color: 'var(--naksha-gold)' }}> read-only</span>: no edits,
                renames, deletes, or creates from this window. Edits belong to the
                terminal&apos;s real nano (<code>nano &lt;file&gt;</code> — Phase 6 PTY bridge),
                and changes appear here automatically.
              </p>
              <input
                value={connectPath}
                onChange={(e) => setConnectPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doConnect();
                }}
                placeholder="/absolute/path/to/your/vault"
                aria-label="Absolute directory path to connect"
                className="font-mono text-xs naksha-scroll"
                style={{
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--naksha-border)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  color: 'var(--naksha-text)',
                  outline: 'none',
                }}
              />
              {connectError && (
                <div className="font-mono text-[11px]" style={{ color: 'var(--naksha-error)' }}>
                  ✗ {connectError}
                </div>
              )}
              <div className="flex items-center gap-3">
                <button
                  onClick={doConnect}
                  disabled={connecting || !connectPath.trim()}
                  className="font-mono"
                  style={{
                    fontSize: 11,
                    color: connecting || !connectPath.trim() ? 'var(--naksha-text-4)' : 'var(--naksha-bg)',
                    background: connecting || !connectPath.trim() ? 'transparent' : 'var(--naksha-gold)',
                    border: '1px solid var(--naksha-border)',
                    borderRadius: 8,
                    padding: '8px 16px',
                    cursor: connecting || !connectPath.trim() ? 'default' : 'pointer',
                  }}
                >
                  {connecting ? 'connecting…' : 'Connect directory'}
                </button>
                <span className="font-mono text-[10px]" style={{ color: 'var(--naksha-text-4)' }}>
                  terminal equivalent: vault connect &lt;path&gt;
                </span>
              </div>
            </div>
          </div>
        ) : !available ? (
          /* ── Connected but gone (renamed/deleted/unmounted) ── */
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="flex flex-col gap-3 items-center text-center">
              <div className="font-mono text-sm" style={{ color: 'var(--naksha-error)' }}>
                ⚠ Directory unavailable
              </div>
              <p className="font-mono text-[11px]" style={{ color: 'var(--naksha-text-2)' }}>
                The connected directory no longer exists at
                <span className="font-semibold" style={{ color: 'var(--naksha-text)' }}>
                  {' '}
                  {status?.root}
                </span>
                . Nothing was invented to fill the gap — reconnect once it is back, or disconnect.
              </p>
            </div>
          </div>
        ) : (
          /* ── Tree + reader ── */
          <div className="flex-1 flex min-h-0">
            {/* Tree column */}
            <div
              className="shrink-0 overflow-y-auto naksha-scroll"
              style={{
                width: 300,
                borderRight: '1px solid var(--naksha-border)',
                padding: '10px 6px',
              }}
              onScroll={virtualizeTree ? onTreeScroll : undefined}
              aria-label="Vault file tree"
            >
              <div
                className="font-mono px-2 pb-2 flex items-center justify-between"
                style={{ fontSize: 9, color: 'var(--naksha-text-4)' }}
              >
                <span>
                  {status?.mdCount ?? 0} notes · {status?.fileCount ?? 0} files
                </span>
                <span>{externalNote ? '' : 'live'}</span>
              </div>
              {treeError && (
                <div className="font-mono text-[11px] px-2 py-1" style={{ color: 'var(--naksha-error)' }}>
                  {treeError}
                </div>
              )}
              {!tree && !treeError && (
                <div style={{ padding: '10px 10px 4px' }}>
                  <SkeletonRows rows={6} />
                </div>
              )}
              {tree?.length === 0 && (
                <EmptyState
                  compact
                  icon={<FolderOpen size={18} strokeWidth={1.5} />}
                  title="Nothing here yet"
                  hint={
                    <>
                      Add .md notes to this directory and they&apos;ll appear in the tree.
                    </>
                  }
                />
              )}
              {virtualizeTree && winStart > 0 && <div aria-hidden style={{ height: winStart * TREE_ROW_H }} />}
              {visibleRows.slice(winStart, winEnd).map((e) => (
                <VaultTreeRow
                  key={e.rel}
                  entry={e}
                  isOpen={openFile === e.rel}
                  collapsedHere={collapsed.has(e.rel)}
                  onToggle={toggleDir}
                  onOpen={openTreeFile}
                  fixedH={virtualizeTree}
                  revCount={revCounts?.get(e.rel) ?? 0}
                />
              ))}
              {virtualizeTree && winEnd < visibleRows.length && (
                <div aria-hidden style={{ height: (visibleRows.length - winEnd) * TREE_ROW_H }} />
              )}
            </div>

            {/* Reader column */}
            <div className="flex-1 flex flex-col min-w-0">
              {openFile && file && (
                <div
                  className="px-5 py-2 shrink-0"
                  style={{ borderBottom: '1px solid var(--naksha-border)' }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-xs truncate" style={{ color: 'var(--naksha-gold-light)' }}>
                      {file.rel}
                    </span>
                    {/* T7 round 4 — revisions strip toggle (Trilium's
                      * revisions-tab analog). Appears only when the file
                      * HAS archived history; the count comes from the
                      * same summary the tree badges use. */}
                    {(revCounts?.get(file.rel) ?? 0) > 0 && (
                      <button
                        onClick={() => setRevStripOpen((v) => !v)}
                        aria-expanded={revStripOpen}
                        title="Toggle the revision strip — archived history of this file"
                        className="font-mono shrink-0"
                        style={{
                          marginLeft: 'auto',
                          fontSize: 9,
                          color: revStripOpen ? 'var(--naksha-gold-light)' : 'var(--naksha-gold)',
                          background: 'color-mix(in srgb, var(--naksha-gold) 12%, transparent)',
                          border: '1px solid color-mix(in srgb, var(--naksha-gold) 28%, transparent)',
                          borderRadius: 999,
                          padding: '2px 8px',
                          cursor: 'pointer',
                        }}
                      >
                        ⟲ {revCounts?.get(file.rel)} revision{revCounts?.get(file.rel) === 1 ? '' : 's'}
                      </button>
                    )}
                  </div>
                  <div className="font-mono" style={{ fontSize: 9, color: 'var(--naksha-text-4)' }}>
                    {status?.name} · {fmtSize(file.size)} · modified {new Date(file.mtimeMs).toLocaleString()}
                  </div>
                </div>
              )}
              {/* T7 round 4 — the revision strip: archived states of the
                * open file, newest first, each with its line delta. */}
              {openFile && revStripOpen && (
                <div
                  className="shrink-0 overflow-y-auto naksha-scroll"
                  style={{ maxHeight: 180, borderBottom: '1px solid var(--naksha-border)', background: 'color-mix(in srgb, var(--naksha-gold) 3%, transparent)' }}
                >
                  <div className="px-5 pt-1 font-mono" style={{ fontSize: 9, color: 'var(--naksha-text-4)' }}>
                    revisions of {openFile} — newest first · click to view · restore from the banner
                  </div>
                  {revList === null && (
                    <div className="px-5 py-2">
                      <SkeletonRows rows={2} rowHeight={16} indent={false} />
                    </div>
                  )}
                  {revList !== null && revList.length === 0 && (
                    <div className="px-5 py-1.5 font-mono" style={{ fontSize: 10, color: 'var(--naksha-text-4)' }}>
                      no revisions archived for this file yet
                    </div>
                  )}
                  {revList?.map((e, i) => (
                    <button
                      key={e.id}
                      onClick={() => openRevision(e)}
                      disabled={revBusy !== null}
                      aria-current={viewingRev?.id === e.id ? 'true' : undefined}
                      className="vault-rev-row w-full text-start font-mono flex items-center gap-2 px-5 py-1"
                      style={{
                        fontSize: 10,
                        color: viewingRev?.id === e.id ? 'var(--naksha-gold-light)' : 'var(--naksha-text-2)',
                        background: viewingRev?.id === e.id ? 'color-mix(in srgb, var(--naksha-gold) 12%, transparent)' : 'transparent',
                        border: 'none',
                        borderLeft: viewingRev?.id === e.id ? '2px solid var(--naksha-gold)' : '2px solid transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ color: 'var(--naksha-gold)' }}>[{i + 1}]</span>
                      <span style={{ color: 'var(--naksha-text-3)' }}>{e.kind === 'app' ? '✎' : '⌁'}</span>
                      <span>{revAgo(e.ts)}</span>
                      <span style={{ color: 'var(--naksha-text-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {fmtSize(e.size)} · {e.reason}
                        {e.delta ? ` · +${e.delta.added} −${e.delta.removed}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {externalNote && (
                <div
                  className="font-mono px-5 py-1.5 shrink-0"
                  style={{ fontSize: 10, color: 'var(--naksha-gold)', background: 'color-mix(in srgb, var(--naksha-gold) 8%, transparent)' }}
                  role="status"
                >
                  ⟳ {externalNote}
                </div>
              )}
              {/* T7 round 4 — the revision-viewer banner: names the archived
                * state being read, offers restore (write verb — the route
                * enforces the designated gate) and the way back. */}
              {viewingRev && (
                <div
                  className="font-mono px-5 py-1.5 shrink-0 flex items-center gap-3 flex-wrap"
                  style={{ fontSize: 10, color: 'var(--naksha-gold)', background: 'color-mix(in srgb, var(--naksha-gold) 8%, transparent)' }}
                  role="status"
                >
                  <span>
                    ⟲ viewing {viewingRev.id} · {viewingRev.reason} · from {new Date(viewingRev.ts).toLocaleTimeString()}
                  </span>
                  <button
                    onClick={restoreFromViewer}
                    disabled={revBusy !== null}
                    className="font-mono shrink-0"
                    style={{
                      fontSize: 9,
                      color: 'var(--naksha-background)',
                      background: 'var(--naksha-gold)',
                      border: 'none',
                      borderRadius: 4,
                      padding: '2px 8px',
                      cursor: revBusy ? 'wait' : 'pointer',
                      opacity: revBusy ? 0.6 : 1,
                    }}
                  >
                    restore this revision
                  </button>
                  <button
                    onClick={() => setViewingRev(null)}
                    className="font-mono shrink-0"
                    style={{
                      fontSize: 9,
                      color: 'var(--naksha-text-2)',
                      background: 'transparent',
                      border: '1px solid var(--naksha-border)',
                      borderRadius: 4,
                      padding: '2px 8px',
                      cursor: 'pointer',
                    }}
                  >
                    back to live
                  </button>
                </div>
              )}
              {revNote && (
                <div
                  className="font-mono px-5 py-1.5 shrink-0"
                  style={{ fontSize: 10, color: 'var(--naksha-gold-light)', background: 'color-mix(in srgb, var(--naksha-gold) 6%, transparent)' }}
                  role="status"
                >
                  {revNote}
                </div>
              )}
              {missingLink && (
                <div
                  className="font-mono px-5 py-1.5 shrink-0"
                  style={{ fontSize: 10, color: 'var(--naksha-error)', background: 'color-mix(in srgb, var(--naksha-error) 8%, transparent)' }}
                  role="alert"
                >
                  ✗ unresolved link: [[{missingLink}]] — no note by that name in this vault
                </div>
              )}
              <div ref={readerBodyRef} className="flex-1 overflow-y-auto naksha-scroll min-h-0">
                {!openFile ? (
                  <div className="h-full flex items-center justify-center p-8">
                    <EmptyState
                      icon={<FileText size={22} strokeWidth={1.5} />}
                      title="Select a note from the tree"
                      hint={
                        <>
                          [[wikilinks]] and relative .md links resolve to real files · terminal:{' '}
                          <code style={{ color: 'var(--naksha-gold-light)' }}>vault open &lt;path&gt;</code>
                        </>
                      }
                    />
                  </div>
                ) : fileError ? (
                  <div className="p-5 font-mono text-xs" style={{ color: 'var(--naksha-error)' }}>
                    ✗ {fileError}
                    {fileError.includes('no such file') && (
                      <div className="mt-2" style={{ color: 'var(--naksha-text-3)' }}>
                        This note was deleted or renamed externally — pick another from the tree.
                      </div>
                    )}
                  </div>
                ) : file && file.rel === openFile && viewingRev ? (
                  /* T7 round 4 — archived revision content (read-only, no
                    * link handling: a wikilink inside an old revision has
                    * no honest target). */
                  <div className="p-5" dir="auto" style={{ outline: 'none' }}>
                    <article
                      className="reader-html text-[var(--naksha-text)] text-[13px] leading-[1.7] font-mono"
                      style={{ textAlign: 'start', opacity: 0.92 }}
                      dangerouslySetInnerHTML={{ __html: viewingRev.html }}
                    />
                    <p className="font-mono mt-4" style={{ fontSize: 10, color: 'var(--naksha-text-4)' }}>
                      read-only view of {viewingRev.id} · the live file is untouched until you restore
                    </p>
                  </div>
                ) : file && file.rel === openFile ? (
                  <div
                    className="p-5"
                    onClick={onReaderClick}
                    onKeyDown={onReaderKeyDown}
                    dir="auto"
                    style={{ outline: 'none' }}
                  >
                    <article
                      className="reader-html text-[var(--naksha-text)] text-[13px] leading-[1.7] font-mono"
                      style={{ textAlign: 'start' }}
                      dangerouslySetInnerHTML={{ __html: file.html }}
                    />
                    <p className="font-mono mt-4" style={{ fontSize: 10, color: 'var(--naksha-text-4)' }}>
                      read-only view of a real file · `nano &lt;file&gt;` in the terminal edits it — this view follows (watcher)
                    </p>
                  </div>
                ) : (
                  /* Task 112 — designed load, same voice as the tree skeleton. */
                  <div className="p-5">
                    <SkeletonRows rows={6} rowHeight={20} indent={false} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      <VaultPanelStyles />
    </ScrimDialog>
  );
}

/** Component-scoped styles (rides the JS module graph — see PerfStyles note). */
function VaultPanelStyles() {
  return (
    <style>{`
      .vault-tree-row { transition: background 0.12s ease, border-color 0.12s ease; }
      .vault-tree-row:hover { background: rgba(255,255,255,0.04) !important; }
      .vault-rev-row { transition: background 0.12s ease, border-color 0.12s ease; }
      .vault-rev-row:hover { background: rgba(255,255,255,0.04) !important; }
      .vault-link {
        color: var(--naksha-gold);
        cursor: pointer;
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, var(--naksha-gold) 45%, transparent);
        text-underline-offset: 3px;
      }
      .vault-link:hover { color: var(--naksha-gold-light); }
      .vault-link:focus-visible { outline: 1px solid var(--naksha-gold); outline-offset: 2px; }
      .reader-html pre {
        background: rgba(0,0,0,0.25);
        border: 1px solid var(--naksha-border);
        border-radius: 8px;
        padding: 10px 12px;
        overflow-x: auto;
        direction: ltr;
        text-align: left;
      }
      .reader-html blockquote {
        border-inline-start: 2px solid var(--naksha-gold);
        padding-inline-start: 12px;
        margin-inline-start: 0;
        color: var(--naksha-text-2);
      }
    `}</style>
  );
}

export default VaultPanel;
