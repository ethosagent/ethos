import type { DeliveryResult, OutboundMessage, PlatformAdapter } from '@ethosagent/types';

/**
 * A synthetic, single-request PlatformAdapter that captures the agent's reply
 * instead of delivering it to a platform. The webhook HTTP handler creates one
 * per request, passes it to `Gateway.handleMessage`, and reads `getReply()`
 * once the turn resolves — the accumulated text becomes the HTTP response body.
 */
export interface CapturingAdapter {
  adapter: PlatformAdapter;
  getReply(): string;
}

/**
 * Build a capturing adapter. All capability flags are off and the delivery
 * surface is a no-op except `send`, which appends `message.text` in call order.
 */
export function createCapturingAdapter(): CapturingAdapter {
  let reply = '';
  const adapter: PlatformAdapter = {
    id: 'webhook',
    displayName: 'Webhook',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 1_000_000,
    async start() {},
    async stop() {},
    async send(_chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
      reply += message.text;
      return { ok: true };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
  };
  return { adapter, getReply: () => reply };
}
