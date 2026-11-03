/**
 * Naksha — Vault markdown (Phase 2)
 *
 * The Obsidian-like rendering layer for REAL vault notes. Wraps the app's
 * escape-first `markdownToHtml` (the same sanitizer the reader panel has
 * used since Task 51 — nothing here weakens it) and adds:
 *
 *  1. WIKILINKS — `[[Note Name]]`, `[[Folder/Note Name]]`, and
 *     `[[Note Name|Display Text]]` become inert `data-vault-target` spans
 *     (role="link"). Resolution to a REAL file happens on click via
 *     /api/vault/resolve — so a link can never navigate, and a link that
 *     matches nothing renders as an honest "unresolved" state instead of
 *     silently navigating somewhere wrong.
 *  2. RELATIVE MARKDOWN LINKS — `[text](./sub/note.md)` targets that point
 *     at note files become vault spans resolved RELATIVE TO THE CURRENT
 *     NOTE (standard relative semantics, still jailed to the vault by the
 *     server's safeResolve). Absolute URLs (http/https/mailto) and plain
 *     anchors are untouched.
 *
 * Security notes:
 *  - Wikilink preprocessing runs on RAW text; markdownToHtml then escapes
 *    everything before any tag exists — a `[[...]]` body containing HTML
 *    or quotes cannot inject attributes (they arrive already entity-encoded
 *    in the output, and dataset decoding handles them correctly).
 *  - The vault:// scheme never survives into the final HTML: every such
 *    anchor is rewritten to a span. No navigation, no target=_blank on
 *    internal links, no way to fetch `file://` or external URLs through it.
 */

import { markdownToHtml } from './utils';

const NOTE_EXT = /\.(md|markdown|txt|rst)$/i;

interface WikilinkParts {
  target: string;
  text: string;
}

/** Split `[[target]]` / `[[target|alias]]` (raw, pre-escape). */
function parseWikilink(inner: string): WikilinkParts | null {
  const bar = inner.indexOf('|');
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const text = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
  if (!target) return null;
  return { target, text: text || target };
}

/** URL-encode a target so it survives markdownToHtml's no-space href regex. */
function encodeTarget(t: string): string {
  return t.replace(/%/g, '%25').replace(/\s+/g, '%20');
}

/** Decode what encodeTarget did (targets arrive back from href attrs). */
function decodeTarget(t: string): string {
  return t.replace(/%20/g, ' ').replace(/%25/g, '%');
}

export function vaultMarkdownToHtml(md: string, currentRel?: string): string {
  /* 1. Wikilinks → standard links on a private scheme (spaces encoded). */
  const pre = String(md ?? '').replace(
    /\[\[([^\]]+)\]\]/g,
    (_m, inner: string) => {
      const parts = parseWikilink(inner);
      if (!parts) return _m;
      return `[${parts.text}](vault://${encodeTarget(parts.target)})`;
    },
  );

  /* 2. The app's escape-first pipeline does the actual markdown work. */
  let html = markdownToHtml(pre);

  /* 3. Rewrite the private-scheme anchors into inert vault-link spans. */
  html = html.replace(
    /<a href="vault:\/\/([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
    (_m, encTarget: string, label: string) => {
      const target = decodeTarget(encTarget);
      return `<span class="vault-link" role="link" tabindex="0" data-vault-target="${target}" title="vault link: ${target}">${label}</span>`;
    },
  );

  /* 4. Relative markdown links that point at note files → vault spans too.
   *    (http/https/mailto/#/data: and absolute paths stay as authored.) */
  html = html.replace(
    /<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
    (m, href: string, label: string) => {
      if (
        /^(https?:|mailto:|vault:|#|data:)/i.test(href) ||
        href.startsWith('/') ||
        !NOTE_EXT.test(href)
      ) {
        return m;
      }
      // Resolve relative to the current note's folder.
      const dir = currentRel ? currentRel.split('/').slice(0, -1).join('/') : '';
      const rel = dir ? `${dir}/${decodeTarget(href)}` : decodeTarget(href);
      return `<span class="vault-link" role="link" tabindex="0" data-vault-target="${rel}" title="vault link: ${rel}">${label}</span>`;
    },
  );

  return html;
}
