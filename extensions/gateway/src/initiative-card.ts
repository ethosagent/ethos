import type {
  DeliveryResult,
  InitiativeDigest,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';

/**
 * The optional button surface of an adapter (`TelegramAdapter`, `SlackAdapter`): renders the owner
 * digest with its `init:` buttons. `text` is the Markdown the ledger holds and the fallback the
 * adapter sends when it cannot build the card. Structural, like the outbox card contract, so the
 * channel adapter contract in `@ethosagent/types` is unchanged.
 */
export interface InitiativeCardAdapter {
  sendInitiativeDigest(
    chatId: string,
    digest: InitiativeDigest,
    fallback: { text: string; threadId?: string },
  ): Promise<DeliveryResult>;
}

export const isInitiativeCardAdapter = (
  a: PlatformAdapter,
): a is PlatformAdapter & InitiativeCardAdapter =>
  typeof (a as Partial<InitiativeCardAdapter>).sendInitiativeDigest === 'function';

/**
 * What `Gateway.notifyTrackedOutcome` reports. `owed`: unconfirmed, but a durable `pending` ledger
 * row exists and the delivery sweep re-sends it, so the caller must not retry. `failed`: nothing
 * durable was written (refused, no ledger, or the ledger write failed).
 */
export type NotifyOutcome = 'confirmed' | 'held' | 'owed' | 'failed';

export const outcomeOf = (sent: {
  confirmed: boolean;
  obligationId: string | null;
}): NotifyOutcome =>
  sent.confirmed ? 'confirmed' : sent.obligationId === null ? 'failed' : 'owed';

/** An owner digest goes out as a button card on an adapter that renders one; the rest is the plain send. */
export function sendCardOrText(
  adapter: PlatformAdapter,
  chatId: string,
  message: OutboundMessage,
  card?: InitiativeDigest,
): Promise<DeliveryResult> {
  if (!card || !isInitiativeCardAdapter(adapter)) return adapter.send(chatId, message);
  return adapter.sendInitiativeDigest(chatId, card, {
    text: message.text,
    ...(message.threadId ? { threadId: message.threadId } : {}),
  });
}
