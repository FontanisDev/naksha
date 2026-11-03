/**
 * Naksha — Vault path helpers (Phase 4)
 *
 * Pure client-side resolution for the terminal's SEPARATE working
 * directory inside the connected real directory (the vault world).
 *
 * Design contract:
 *  - The vault cwd is jailed at the connected root by construction:
 *    `..` segments CLAMP at the root (like a chroot shell), so no
 *    client-side resolution can ever produce a rel path outside the
 *    vault. The server re-validates every path through safeResolve —
 *    this module is ergonomics, not the security boundary.
 *  - Pure module: no React, no store import, no fetch. The command
 *    handlers and the terminal click verbs both speak this dialect so
 *    a typed path and a clicked row land in the same place.
 *  - Never fakes: resolution returns a REL path (or an honest error);
 *    reading/listing always happens through the vault API.
 */

/** Clean a stored/typed vault rel path: collapse duplicate slashes,
 *  strip leading/trailing separators and `./` noise. Returns '' for
 *  the vault root. Does NOT interpret `..` (resolveVaultPath does). */
export function normalizeVaultRel(p: string): string {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
}

export type VaultPathResult =
  | { ok: true; rel: string }
  | { ok: false; error: string };

/**
 * Resolve `target` (as typed by the user) against the current vault
 * cwd — a jailed join with `..` clamping at the root:
 *   '' | '~' | '/'             → the vault root (this world's home)
 *   '.'                        → the cwd (Unix `.` means "here")
 *   'Notes/x.md'               → cwd + Notes/x.md
 *   '/Notes/x.md'              → root + Notes/x.md (leading / = root)
 *   '..' | 'a/../b'            → clamped inside the root, never out
 * Returns the normalized rel ('' = root) or an honest error.
 */
export function resolveVaultPath(cwd: string, target: string): VaultPathResult {
  if (target.includes('\0')) return { ok: false, error: 'invalid path' };
  let t = target.trim();
  // The shell dialect: a typed path may arrive wrapped in matching
  // quotes (real note names have spaces — "Main Purpose.md"). Unwrap
  // once, at the shared layer, so every typed verb speaks the same
  // quoting rules `carebind` already does (Phase 9 QA fix — cat/nano
  // used to see the quote characters and miss the file).
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    t = t.slice(1, -1).trim();
  }
  // The vault's home symbols: empty, tilde, bare slash.
  if (t === '' || t === '~' || t === '/') return { ok: true, rel: '' };
  // Unix `.` means "here": bare `ls` / `tree` / `grep <pat> .` must
  // honor the vault cwd, not silently jump to the root. (Phase 9 QA
  // fix — it used to return the root, so a bare `ls` deep in the vault
  // listed the top while `pwd` said otherwise.)
  if (t === '.') return { ok: true, rel: normalizeVaultRel(cwd) };
  // `~/sub` and `/sub` both anchor at the vault root (the vault IS the
  // home of this world — there is nothing above it to reach).
  t = t.replace(/^(~|\/)\/?/, '');
  const base = normalizeVaultRel(cwd).split('/').filter(Boolean);
  const segs = normalizeVaultRel(t).split('/').filter(Boolean);
  const stack = [...base];
  for (const seg of segs) {
    if (seg === '..') {
      // Clamp at the root: `cd ..` at the top stays at the top (a jail,
      // stated honestly in receipts — not an error).
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return { ok: true, rel: stack.join('/') };
}

/** Absolute display path for pwd/receipts: `/abs/root` or
 *  `/abs/root/rel/segments`. */
export function vaultPwdAbs(root: string, cwd: string): string {
  const rel = normalizeVaultRel(cwd);
  return rel ? `${root.replace(/\/$/, '')}/${rel}` : root;
}

/** Compact prompt label for the vault world's cwd: the vault name at
 *  the root, `name/last-segment` deeper (zsh muscle-memory; the full
 *  rel rides the title attribute). */
export function vaultPromptCwd(cwd: string, name: string): string {
  const rel = normalizeVaultRel(cwd);
  if (!rel) return name || 'vault';
  const last = rel.split('/').pop() ?? rel;
  return `${name || 'vault'}/${last}`;
}

/** Which world a typed fs path belongs to at parse time — used by the
 *  terminal input to keep `~` meaning "the active world's home".
 *  (`.` is deliberately NOT a home symbol — it resolves to the cwd.) */
export function isVaultHomeSymbol(t: string): boolean {
  const s = t.trim();
  return s === '' || s === '~' || s === '/';
}
