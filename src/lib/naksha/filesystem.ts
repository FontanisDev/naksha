/**
 * Naksha — Virtual File System
 * A Unix-like tree persisted in localStorage. Supports:
 *   ls, cd, pwd, tree, cat, nano, mkdir, touch, rm [-r], echo (> >>)
 *   cp [-r], mv, grep [-r], export/import (backup)
 *
 * No React/Zustand dependency — pure logic. The Zustand store wraps
 * this and notifies subscribers on mutations.
 */

import type {
  FSDir,
  FSFile,
  FSListResult,
  FSNode,
  FSOpResult,
  FSReadResult,
} from './types';
import { STORAGE_KEYS } from './constants';
import { Storage } from './storage';

const ROOT_KEY = '__root__';

function makeDir(): FSDir {
  return { type: 'dir', contents: {} };
}

function makeFile(content = ''): FSFile {
  return { type: 'file', content };
}

function createDefaultStructure(): FSDir {
  return {
    type: 'dir',
    contents: {
      home: {
        type: 'dir',
        contents: {
          'README.md': {
            type: 'file',
            content: `# Naksha Shell

Welcome to your personal geographic shell.

This is a virtual Unix-like file system that persists in your browser.

## Quick Start
- Type 'help' to see all available commands
- Use 'ls' to list directory contents
- Use 'cat README.md' to read this file
- Use 'nano <filename>' to edit files

## Features
- Full virtual file system with persistence (cp, mv, grep, export/import)
- Interactive map with routing & geocoding
- CareSpace hierarchical thought management (3 networks)
- Focus mode for distraction-free work
- View history (back / fwd / stream)

Enjoy exploring!
`,
          },
          '.config': {
            type: 'dir',
            contents: {
              'settings.json': {
                type: 'file',
                content: `{
  "theme": "warm-dark",
  "terminal_font": "JetBrains Mono",
  "map_default_layer": "hot",
  "caresolution": 38,
  "mapsplit": 50,
  "carespace_max_networks": 3
}
`,
              },
            },
          },
        },
      },
      tmp: {
        type: 'dir',
        contents: {},
      },
    },
  };
}

/**
 * File System — a singleton-ish engine. Use `FileSystem.init()` once,
 * then call methods directly. The Zustand store reads/writes via this.
 */
/* ── Debounced persistence plumbing (same discipline as CareSpace.save:
 * every mutation used to stringify the whole tree synchronously — a
 * terminal session that touches the FS N times paid N full serializations.
 * Bursts now coalesce into one trailing write, flushed on pagehide /
 * visibilitychange. ── */
let fsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let fsSaveFlushArmed = false;

function fsSaveSchedule(): void {
  if (typeof window === 'undefined') return;
  if (!fsSaveFlushArmed) {
    fsSaveFlushArmed = true;
    const flush = () => {
      if (fsSaveTimer !== null) FileSystem.saveNow();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
  if (fsSaveTimer !== null) clearTimeout(fsSaveTimer);
  fsSaveTimer = setTimeout(() => {
    fsSaveTimer = null;
    FileSystem.saveNow();
  }, 400);
}

export const FileSystem = {
  /* Task 118 — the tree lives behind a self-healing getter: dev HMR
   * re-evaluates this module (module-level state resets to an empty
   * tree) while the store's `ready` flag survives, so the old
   * init-once-from-store-boot contract left a LIVE fs with NO home —
   * every op failed with "No such directory" until a full reload.
   * Now a cold instance heals on first read, wherever that read comes
   * from. The setter marks warmth: assigning a whole tree (replace,
   * import) declares that state authoritative. */
  _root: makeDir(),
  currentPath: ['home'] as string[],
  _ready: false,

  get root(): FSDir {
    if (!this._ready) this.init();
    return this._root;
  },
  set root(v: FSDir) {
    this._root = v;
    this._ready = true;
  },

  init(): void {
    if (this._ready) return; // idempotent — the getter re-enters safely
    this._ready = true; // armed FIRST: internal reads below never re-enter
    const stored = Storage.get<FSDir | null>(STORAGE_KEYS.filesystem, null);
    if (stored && stored.type === 'dir' && stored.contents) {
      this.root = stored;
    } else {
      this.root = createDefaultStructure();
      this.save();
    }
    if (!this.getNode(['home'])) {
      this.root.contents['home'] = makeDir();
      this.save();
    }
  },

  save(): void {
    /* Perf: debounced — see the plumbing above. */
    fsSaveSchedule();
  },

  /** Synchronous persistence (escape hatch; nothing uses it today). */
  saveNow(): void {
    if (fsSaveTimer !== null) {
      clearTimeout(fsSaveTimer);
      fsSaveTimer = null;
    }
    Storage.set(STORAGE_KEYS.filesystem, this.root);
  },

  /** Reset to factory defaults (used by `import` and emergency recovery). */
  replace(newRoot: FSDir): void {
    if (!newRoot || newRoot.type !== 'dir' || !newRoot.contents) {
      throw new Error('Invalid file system structure');
    }
    this.root = newRoot;
    this.currentPath = ['home'];
    this.save();
  },

  /** Get a node at an absolute path array. Returns null if not found. */
  getNode(path: string[]): FSNode | null {
    if (path.length === 0) return this.root;
    let current: FSNode = this.root;
    for (const segment of path) {
      if (current.type !== 'dir' || !current.contents) return null;
      const next = current.contents[segment];
      if (!next) return null;
      current = next;
    }
    return current;
  },

  /** Resolve a path string (with ~, /, .., .) to an absolute path array. */
  resolvePath(pathStr?: string): string[] {
    if (!pathStr || pathStr === '.') return [...this.currentPath];
    if (pathStr === '~' || pathStr === '~/') return ['home'];
    let parts: string[];
    if (pathStr.startsWith('/')) {
      parts = pathStr.split('/').filter((p) => p && p !== '.');
    } else if (pathStr.startsWith('~/')) {
      parts = ['home', ...pathStr.slice(2).split('/').filter((p) => p && p !== '.')];
    } else {
      parts = [...this.currentPath, ...pathStr.split('/').filter((p) => p && p !== '.')];
    }
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '..') resolved.pop();
      else if (part !== '.') resolved.push(part);
    }
    return resolved;
  },

  /** Get the current working directory as a display string (`~`, `/home/...`). */
  getCurrentPath(): string {
    const p = '/' + this.currentPath.join('/');
    return p === '/home' ? '~' : p;
  },

  changeDirectory(pathStr: string): FSOpResult {
    const target = this.resolvePath(pathStr);
    const node = this.getNode(target);
    if (!node) return { success: false, error: `No such directory: ${pathStr}` };
    if (node.type !== 'dir') return { success: false, error: `Not a directory: ${pathStr}` };
    this.currentPath = target;
    return { success: true };
  },

  listDirectory(pathStr?: string): FSListResult {
    const target = pathStr ? this.resolvePath(pathStr) : this.currentPath;
    const node = this.getNode(target);
    if (!node) return { success: false, error: `No such file or directory: ${pathStr || '.'}` };
    if (node.type === 'file') return { success: true, isFile: true, name: pathStr };
    const entries = Object.keys(node.contents).sort((a, b) => {
      const aDir = node.contents[a].type === 'dir';
      const bDir = node.contents[b].type === 'dir';
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
    return { success: true, entries, node };
  },

  readFile(pathStr: string): FSReadResult {
    const target = this.resolvePath(pathStr);
    const node = this.getNode(target);
    if (!node) return { success: false, error: `No such file: ${pathStr}` };
    if (node.type === 'dir') return { success: false, error: `Is a directory: ${pathStr}` };
    return { success: true, content: node.content || '' };
  },

  writeFile(pathStr: string, content: string, append = false): FSOpResult {
    const target = this.resolvePath(pathStr);
    const fileName = target.pop();
    if (!fileName) return { success: false, error: 'Invalid file path' };
    const parent = this.getNode(target);
    if (!parent || parent.type !== 'dir') {
      return { success: false, error: `No such directory: ${pathStr}` };
    }
    if (!parent.contents[fileName]) {
      parent.contents[fileName] = makeFile('');
    } else if (parent.contents[fileName].type === 'dir') {
      return { success: false, error: `Is a directory: ${pathStr}` };
    }
    const file = parent.contents[fileName];
    if (file.type === 'file') {
      if (append && file.content) file.content += '\n' + content;
      else file.content = content;
    }
    this.save();
    return { success: true };
  },

  makeDirectory(pathStr: string): FSOpResult {
    const target = this.resolvePath(pathStr);
    const dirName = target.pop();
    if (!dirName) return { success: false, error: 'Invalid directory name' };
    const parent = this.getNode(target);
    if (!parent || parent.type !== 'dir') {
      return { success: false, error: `No such directory: ${pathStr}` };
    }
    if (parent.contents[dirName]) return { success: false, error: `Already exists: ${dirName}` };
    parent.contents[dirName] = makeDir();
    this.save();
    return { success: true };
  },

  touchFile(pathStr: string): FSOpResult {
    const target = this.resolvePath(pathStr);
    const fileName = target.pop();
    if (!fileName) return { success: false, error: 'Invalid file name' };
    const parent = this.getNode(target);
    if (!parent || parent.type !== 'dir') {
      return { success: false, error: `No such directory: ${pathStr}` };
    }
    if (!parent.contents[fileName]) {
      parent.contents[fileName] = makeFile('');
      this.save();
    }
    return { success: true };
  },

  remove(pathStr: string, recursive = false): FSOpResult {
    const target = this.resolvePath(pathStr);
    const name = target.pop();
    if (!name) return { success: false, error: 'Invalid path' };
    const parent = this.getNode(target);
    if (!parent || parent.type !== 'dir' || !parent.contents[name]) {
      return { success: false, error: `No such file or directory: ${pathStr}` };
    }
    const node = parent.contents[name];
    if (
      node.type === 'dir' &&
      Object.keys(node.contents).length > 0 &&
      !recursive
    ) {
      return { success: false, error: `Directory not empty. Use rm -r: ${pathStr}` };
    }
    delete parent.contents[name];
    this.save();
    return { success: true };
  },

  /** Copy a file or directory (recursive copy supported via `-r` flag in cmd). */
  copy(srcStr: string, dstStr: string): FSOpResult {
    const srcPath = this.resolvePath(srcStr);
    const srcNode = this.getNode(srcPath);
    if (!srcNode) return { success: false, error: `No such file or directory: ${srcStr}` };

    const dstPath = this.resolvePath(dstStr);
    const dstName = dstPath.pop()!;
    const dstParent = this.getNode(dstPath);
    if (!dstParent || dstParent.type !== 'dir') {
      return { success: false, error: `No such directory: ${dstStr}` };
    }
    if (dstParent.contents[dstName]) {
      return { success: false, error: `Already exists: ${dstName}` };
    }
    // Deep clone the source so the copy is independent.
    dstParent.contents[dstName] = JSON.parse(JSON.stringify(srcNode)) as FSNode;
    this.save();
    return { success: true };
  },

  /** Move / rename a file or directory. */
  move(srcStr: string, dstStr: string): FSOpResult {
    const srcPath = this.resolvePath(srcStr);
    const srcName = srcPath.pop()!;
    const srcParent = this.getNode(srcPath);
    if (!srcParent || srcParent.type !== 'dir' || !srcParent.contents[srcName]) {
      return { success: false, error: `No such file or directory: ${srcStr}` };
    }
    const node = srcParent.contents[srcName];

    const dstPath = this.resolvePath(dstStr);
    const dstName = dstPath.pop()!;
    const dstParent = this.getNode(dstPath);
    if (!dstParent || dstParent.type !== 'dir') {
      return { success: false, error: `No such directory: ${dstStr}` };
    }
    if (dstParent.contents[dstName] && srcParent !== dstParent && dstName !== srcName) {
      return { success: false, error: `Already exists: ${dstName}` };
    }
    delete srcParent.contents[srcName];
    dstParent.contents[dstName] = node;
    this.save();
    return { success: true };
  },

  /** Grep for a pattern in a file (or recursively in a directory). */
  grep(pattern: string, pathStr: string, recursive = false): { matches: Array<{ file: string; line: number; text: string }> } | { error: string } {
    const target = this.resolvePath(pathStr);
    const node = this.getNode(target);
    if (!node) return { error: `No such file or directory: ${pathStr}` };
    const matches: Array<{ file: string; line: number; text: string }> = [];
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch (err) {
      return { error: `Invalid pattern: ${(err as Error).message}` };
    }
    const walk = (n: FSNode, p: string[]) => {
      if (n.type === 'file') {
        const lines = (n.content || '').split('\n');
        lines.forEach((line, i) => {
          if (regex.test(line)) {
            matches.push({ file: '/' + p.join('/'), line: i + 1, text: line.trim() });
          }
        });
      } else if (n.type === 'dir' && recursive) {
        for (const [name, child] of Object.entries(n.contents)) {
          walk(child, [...p, name]);
        }
      }
    };
    walk(node, target);
    return { matches };
  },

  /** Build a `tree`-style string. */
  getTreeString(pathStr?: string): string | null {
    const target = pathStr ? this.resolvePath(pathStr) : this.currentPath;
    const start = this.getNode(target);
    if (!start) return null;
    const lines: string[] = [pathStr || '.'];
    const build = (node: FSNode, prefix: string) => {
      if (node.type !== 'dir') return;
      const entries = Object.keys(node.contents).sort((a, b) => {
        const aDir = node.contents[a].type === 'dir';
        const bDir = node.contents[b].type === 'dir';
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.localeCompare(b);
      });
      entries.forEach((name, i) => {
        const isLast = i === entries.length - 1;
        const entry = node.contents[name];
        const connector = isLast ? '└── ' : '├── ';
        const typeInd = entry.type === 'dir' ? '/' : '';
        lines.push(`${prefix}${connector}${name}${typeInd}`);
        if (entry.type === 'dir') build(entry, prefix + (isLast ? '    ' : '│   '));
      });
    };
    build(start, '');
    return lines.join('\n');
  },

  /** Task 50 — machine-readable tree walk for the interactive `tree`
   *  command: flat entries with ABSOLUTE paths + depth, dirs first and
   *  name-sorted within each level (the same order rules as
   *  getTreeString, so both views agree). The command layer turns each
   *  entry into a clickable fs row (dir → cd, file → cat); absolute
   *  paths keep rows from a subtree listing valid after the walk.
   *  maxEntries caps pathological trees — the terminal keeps ~500 lines
   *  anyway, but a 5000-row walk would churn the store for nothing. */
  getTreeEntries(
    pathStr?: string,
    maxEntries = 300,
  ): Array<{ path: string; name: string; isDir: boolean; depth: number }> | null {
    const target = pathStr ? this.resolvePath(pathStr) : this.currentPath;
    const start = this.getNode(target);
    if (!start || start.type !== 'dir') return null;
    const out: Array<{ path: string; name: string; isDir: boolean; depth: number }> = [];
    const walk = (node: FSDir, parts: string[], depth: number) => {
      const entries = Object.keys(node.contents).sort((a, b) => {
        const aDir = node.contents[a].type === 'dir';
        const bDir = node.contents[b].type === 'dir';
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.localeCompare(b);
      });
      for (const name of entries) {
        if (out.length >= maxEntries) return;
        const entry = node.contents[name];
        const entryParts = [...parts, name];
        out.push({ path: '/' + entryParts.join('/'), name, isDir: entry.type === 'dir', depth });
        if (entry.type === 'dir') walk(entry, entryParts, depth + 1);
      }
    };
    walk(start, target, 0);
    return out;
  },

  /** Approximate size of a file content. */
  formatSize(content: string): string {
    const bytes = new Blob([content]).size;
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  },

  /** Export the entire FS as a JSON-serializable object. */
  exportAll(): FSDir {
    return JSON.parse(JSON.stringify(this.root)) as FSDir;
  },

  /** Import from a parsed object (replaces the entire FS). */
  importAll(data: FSDir): FSOpResult {
    if (!data || data.type !== 'dir' || !data.contents) {
      return { success: false, error: 'Invalid backup format' };
    }
    this.root = JSON.parse(JSON.stringify(data)) as FSDir;
    this.currentPath = ['home'];
    if (!this.getNode(['home'])) {
      this.root.contents['home'] = makeDir();
    }
    this.save();
    return { success: true };
  },
};

// keep root accessible for testing without exposing internals.
export const FS_ROOT_KEY = ROOT_KEY;
