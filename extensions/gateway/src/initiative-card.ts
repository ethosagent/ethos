import type { DeliveryResult, InitiativeDigest, PlatformAdapter } from '@ethosagent/types';

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
