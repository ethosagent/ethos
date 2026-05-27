import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

// SSE endpoint for WhatsApp QR-code pairing.
//
// GET /setup/whatsapp streams QR strings as they rotate and a final
// `{ paired: true }` event when the device links successfully.
//
// The WhatsApp adapter calls `setWhatsAppQr(qr)` on each new QR from
// Baileys, and `setWhatsAppQr(null)` once pairing completes.

type Listener = (data: string) => void;

let currentQr: string | null = null;
const listeners = new Set<Listener>();

export function setWhatsAppQr(qr: string | null): void {
  currentQr = qr;
  const payload = qr
    ? JSON.stringify({ qr })
    : JSON.stringify({ paired: true });
  for (const listener of listeners) {
    listener(payload);
  }
}

export function setupWhatsAppRoutes() {
  const app = new Hono();

  app.get('/', async (c) => {
    return streamSSE(c, async (stream) => {
      let seq = 0;

      const handler: Listener = (data) => {
        seq++;
        void stream.writeSSE({ id: String(seq), data });
      };

      stream.onAbort(() => {
        listeners.delete(handler);
      });

      // Replay current QR immediately so late-joining clients see it.
      if (currentQr) {
        seq++;
        void stream.writeSSE({
          id: String(seq),
          data: JSON.stringify({ qr: currentQr }),
        });
      }

      listeners.add(handler);

      // Block forever — onAbort is the only way out.
      await new Promise<void>(() => {});
    });
  });

  return app;
}
