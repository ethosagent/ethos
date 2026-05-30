import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

// SSE endpoint for WhatsApp QR-code pairing.
//
// GET /setup/whatsapp/:botId streams QR strings as they rotate and a final
// `{ paired: true }` event when the device links successfully.
//
// The WhatsApp adapter calls `setWhatsAppQr(botId, qr)` on each new QR from
// Baileys, and `setWhatsAppQr(botId, null)` once pairing completes.

type Listener = (data: string) => void;

const qrState = new Map<string, string | null>();
const listeners = new Map<string, Set<Listener>>();

export function setWhatsAppQr(botId: string, qr: string | null): void {
  qrState.set(botId, qr);
  const payload = qr ? JSON.stringify({ qr }) : JSON.stringify({ paired: true });
  const subs = listeners.get(botId);
  if (subs) {
    for (const listener of subs) {
      listener(payload);
    }
  }
}

export function setupWhatsAppRoutes() {
  const app = new Hono();

  app.get('/:botId', async (c) => {
    const botId = c.req.param('botId');

    return streamSSE(c, async (stream) => {
      let seq = 0;

      const handler: Listener = (data) => {
        seq++;
        void stream.writeSSE({ id: String(seq), data });
      };

      let subs = listeners.get(botId);
      if (!subs) {
        subs = new Set();
        listeners.set(botId, subs);
      }

      stream.onAbort(() => {
        const set = listeners.get(botId);
        if (set) {
          set.delete(handler);
          if (set.size === 0) listeners.delete(botId);
        }
      });

      // Register listener BEFORE replaying current state to avoid missing
      // a QR rotation between replay and subscribe.
      subs.add(handler);

      // Replay current QR immediately so late-joining clients see it.
      const currentQr = qrState.get(botId) ?? null;
      if (currentQr) {
        seq++;
        void stream.writeSSE({
          id: String(seq),
          data: JSON.stringify({ qr: currentQr }),
        });
      }

      // Block until the client disconnects — onAbort is the only way out.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
    });
  });

  return app;
}
