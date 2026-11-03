/**
 * GET /api/vault/events — Server-Sent Events stream of external changes.
 *
 * The watcher (mtime poller + fs.watch accelerator) only runs while at
 * least one SSE client is connected; closing the VaultPanel disconnects
 * and the whole system returns to zero idle cost. Manual refresh always
 * exists as the fallback (list/read hit the live filesystem every time).
 */

import { startWatching, addClient, removeClient, recentEvents } from '@/lib/server/vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // (Re)arm the watcher from the persisted config before streaming.
  await startWatching();
  const encoder = new TextEncoder();
  let client: ((ev: unknown) => void) | null = null;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          if (client) removeClient(client);
        }
      };
      client = send;
      addClient(client);
      send({ kind: 'hello', path: '', ts: Date.now() });
      // Replay the recent ring so a just-opened panel sees fresh history.
      for (const ev of recentEvents().slice(-5)) send(ev);
      // 25s SSE *comment* ping (`: …` frames never reach onmessage):
      // keeps middleboxes from reaping an idle stream, and turns a
      // dead socket into a write error instead of a silent zombie client.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          if (client) removeClient(client);
        }
      }, 25_000);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (client) removeClient(client);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
