/**
 * Naksha — Utility helpers
 * Pure functions, no side effects, no React/Zustand dependencies.
 */

/** Generate a short unique id with a prefix. */
export function generateId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

/** Format a Date as HH:MM (24h, tabular). */
export function formatTime(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Format a full timestamp for display (YYYY-MM-DD HH:MM). */
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const date = d.toISOString().slice(0, 10);
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} ${time}`;
}

/** Format a relative "time ago" string. */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Escape HTML special characters. */
export function escapeHtml(text: unknown): string {
  const str = String(text ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Debounce — returns a fn that calls `fn` only after `wait` ms of quiet. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): (...args: A) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

/** Throttle — calls `fn` at most once per `wait` ms (trailing edge). */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): (...args: A) => void {
  let last = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      if (trailing) {
        clearTimeout(trailing);
        trailing = null;
      }
      last = now;
      fn(...args);
    } else if (!trailing) {
      trailing = setTimeout(() => {
        last = Date.now();
        trailing = null;
        fn(...args);
      }, remaining);
    }
  };
}

/** Structured deep clone (works for our plain data, no functions/dates). */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj);
    } catch {
      // fall through to manual
    }
  }
  return JSON.parse(JSON.stringify(obj)) as T;
}

/** Format a byte size as a human-readable string. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Estimate the byte size of a string (UTF-8). */
export function byteLength(str: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  return new Blob([str]).size;
}

/** Compute approximate localStorage usage for a list of keys. */
export function storageUsage(keys: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  let total = 0;
  for (const key of keys) {
    let size = 0;
    try {
      const raw = localStorage.getItem(key);
      size = raw ? byteLength(raw) : 0;
    } catch {
      size = 0;
    }
    result[key] = size;
    total += size;
  }
  result.total = total;
  return result;
}

/** Format a coordinate pair as "35.70N 51.42E". */
export function formatCoord(lat: number, lng: number, precision = 3): string {
  const latStr = `${Math.abs(lat).toFixed(precision)}${lat >= 0 ? 'N' : 'S'}`;
  const lngStr = `${Math.abs(lng).toFixed(precision)}${lng >= 0 ? 'E' : 'W'}`;
  return `${latStr} ${lngStr}`;
}

/** Format lat & lng as separate strings. */
export function formatLat(lat: number, precision = 3): string {
  return `${Math.abs(lat).toFixed(precision)}${lat >= 0 ? 'N' : 'S'}`;
}
export function formatLng(lng: number, precision = 3): string {
  return `${Math.abs(lng).toFixed(precision)}${lng >= 0 ? 'E' : 'W'}`;
}

/** Haversine distance between two coords (km). */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** Format a distance: "12.3 km" or "845 m". */
export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

/** Format a duration: "1h 23m" or "45m". */
export function formatDuration(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Decode a WMO weather code to a friendly description. */
export function weatherDescription(code: number): string {
  const map: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
  };
  return map[code] ?? 'Unknown';
}

/** Compose a Wind direction degrees to a compass label. */
export function windDirection(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

/** Convert markdown-ish text to safe HTML (very small subset). */
export function tinyMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>');
}

/** Truncate a string with ellipsis. */
export function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/**
 * Task 51 — block-level markdown → safe HTML for the reader panel
 * (`cat -r`). Escape-first (every piece of source text goes through
 * escapeHtml BEFORE any tag is synthesized), line-state machine: fenced
 * code, headings, hr, blockquote, ul/ol, paragraphs. Inline spans are
 * delegated to tinyMarkdown (bold / italic / code), plus links and
 * images on top. ~O(n) one-shot — runs once per `cat -r`, never in a
 * loop, so the CPU cost is a rounding error.
 */
export function markdownToHtml(md: string): string {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] = [];
  let fence: { lang: string; body: string[] } | null = null;

  /* Inline spans: tinyMarkdown (escape + bold/italic/code) then link &
   * image passes. Running AFTER escaping means a URL can't inject
   * attributes — quotes/angles in the source are already entities. */
  const inline = (s: string): string =>
    tinyMarkdown(s)
      .replace(
        /!\[([^\]]*)\]\(([^)\s]+)\)/g,
        '<img src="$2" alt="$1" loading="lazy"/>',
      )
      .replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(
        `<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`,
      );
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    /* Fenced code — the body is escaped verbatim (NO inline markdown
     * inside a fence: code is code). */
    if (fence) {
      if (/^```/.test(raw.trim())) {
        out.push(
          `<pre><code>${escapeHtml(fence.body.join('\n'))}</code></pre>`,
        );
        fence = null;
      } else {
        fence.body.push(raw);
      }
      continue;
    }
    const open = raw.trim().match(/^```(\w*)/);
    if (open) {
      flushAll();
      fence = { lang: open[1] ?? '', body: [] };
      continue;
    }

    const line = raw.trimEnd();

    /* Headings — # through ######. */
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      /* Task 118 — the cap must land ON the output level, not on the
       * intermediate: min(len+1,6)+1 produced <h7> for #####/######
       * (an element that does not exist — browsers render it as an
       * unstyled inline run, none of the .reader-html heading rules
       * match). min(len+2,6) keeps every valid level identical and
       * clamps only the two deep ones onto h6. */
      const lvl = Math.min(h[1].length + 2, 6); // # → h3 (panel title is h2-adjacent), cap at h6
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }

    /* Horizontal rule. */
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      flushAll();
      out.push('<hr/>');
      continue;
    }

    /* Blockquote. */
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    }
    flushQuote();

    /* Lists — -, *, + bullets and 1. / 1) ordered. */
    const ul = line.match(/^[-*+]\s+(.*)$/);
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((ul ? ul[1] : ol![1]) ?? '');
      continue;
    }
    flushList();

    /* Blank line ends the paragraph. */
    if (!line.trim()) {
      flushPara();
      continue;
    }
    para.push(line.trim());
  }
  /* A fence left open at EOF still renders (unclosed is common in notes). */
  if (fence) out.push(`<pre><code>${escapeHtml(fence.body.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('\n');
}

/** Parse a "to"-separated pair: "alpha to beta" -> ["alpha", "beta"].
 * Wrapping quotes are stripped from both halves so quoted multi-word
 * names echo back clean in messages ("Alpha Station", not "\"Alpha Station\""). */
export function splitToPair(input: string): [string, string] | null {
  const m = input.match(/^(.+?)\s+to\s+(.+)$/i);
  if (!m) return null;
  const strip = (s: string) => s.trim().replace(/^["']|["']$/g, '');
  return [strip(m[1]), strip(m[2])];
}

/** Sleep helper. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clamp a number to [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
