import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

// SSE endpoint for WhatsApp pairing.
//
// GET /setup/whatsapp/:botId streams either QR strings (as they rotate) or an
// 8-char phone-number pairing code, plus a final `{ paired: true }` event when
// the device links successfully.
//
// The WhatsApp adapter calls `setWhatsAppQr(botId, qr)` on each new QR from
// Baileys (QR mode) or `setWhatsAppPairingCode(botId, code)` once on socket
// startup (phone-number mode), and passes `null` to either once pairing
// completes.

type Listener = (data: string) => void;

const qrState = new Map<string, string | null>();
const pairingCodeState = new Map<string, string | null>();
const listeners = new Map<string, Set<Listener>>();

function emit(botId: string, payload: string): void {
  const subs = listeners.get(botId);
  if (subs) {
    for (const listener of subs) {
      listener(payload);
    }
  }
}

export function setWhatsAppQr(botId: string, qr: string | null): void {
  qrState.set(botId, qr);
  emit(botId, qr ? JSON.stringify({ qr }) : JSON.stringify({ paired: true }));
}

export function setWhatsAppPairingCode(botId: string, code: string | null): void {
  pairingCodeState.set(botId, code);
  emit(botId, code ? JSON.stringify({ pairingCode: code }) : JSON.stringify({ paired: true }));
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

      // Replay current pairing code immediately so late-joining clients see it.
      const currentPairingCode = pairingCodeState.get(botId) ?? null;
      if (currentPairingCode) {
        seq++;
        void stream.writeSSE({
          id: String(seq),
          data: JSON.stringify({ pairingCode: currentPairingCode }),
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
