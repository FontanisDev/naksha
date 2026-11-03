/**
 * Shared vault-SSE subscription — ONE EventSource per page, ref-counted.
 *
 * VaultPanel and NodeDetailsPanel each used to open their own
 * `/api/vault/events` stream with byte-identical handlers, doubling the
 * connection count (and the hello/replay traffic) whenever both were
 * open. This module owns the single connection:
 *
 *   - first subscriber creates it,
 *   - every external frame notifies every subscriber once,
 *   - last unsubscribe closes it — preserving the events route's
 *     zero-idle-cost contract (no stream while no panel is open).
 *
 * The revision plumbing stays at the call sites: handlers call
 * `bumpVaultRevision()` themselves, exactly as before.
 */

type Handler = () => void;

let es: EventSource | null = null;
const handlers = new Set<Handler>();

function ensureStream(): void {
  if (es) return;
  es = new EventSource('/api/vault/events');
  es.onmessage = (ev: MessageEvent<string>) => {
    try {
      const data = JSON.parse(ev.data) as { kind?: string };
      if (data.kind === 'hello') return;
      for (const h of handlers) h();
    } catch {
      /* malformed frame — the next poll resyncs */
    }
  };
  es.onerror = () => {
    /* EventSource auto-reconnects; nothing to do */
  };
}

/** Subscribe to external vault changes. Returns the unsubscribe fn. */
export function subscribeVaultEvents(handler: Handler): () => void {
  handlers.add(handler);
  ensureStream();
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0 && es) {
      es.close();
      es = null;
    }
  };
}
