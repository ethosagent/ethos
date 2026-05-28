import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
export function sseRoutes(opts) {
  const app = new Hono();
  app.get('/sessions/:id', async (c) => {
    const sessionId = c.req.param('id');
    const lastIdHeader = c.req.header('Last-Event-ID');
    const sinceSeq = parseLastEventId(lastIdHeader);
    return streamSSE(c, async (stream) => {
      let unsubscribe = null;
      stream.onAbort(() => {
        if (unsubscribe) unsubscribe();
      });
      unsubscribe = opts.chat.subscribe(sessionId, sinceSeq, async (buffered) => {
        // Stream is closed once `onAbort` fires; writes after that no-op safely
        // because `streamSSE` guards them.
        //
        // No `event:` field on purpose. Setting it to a non-default name makes
        // the browser's `EventSource.onmessage` skip the frame — only matching
        // `addEventListener('<type>', ...)` would catch it. The client parses
        // the type out of the JSON `data` payload (every event has a
        // discriminator `type` field), so an explicit `event:` line is redundant
        // AND breaks the default handler. Curl users still see the type via
        // `data:` content.
        await stream.writeSSE({
          id: String(buffered.seq),
          data: JSON.stringify(buffered.event),
        });
      });
      // Block forever — `onAbort` is the only way out.
      await new Promise(() => {});
    });
  });
  return app;
}
function parseLastEventId(raw) {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
