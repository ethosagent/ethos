// Posting `emit_card` cards to a card-capable adapter (plan telegram-live-cards L5).
//
// The gateway is the single owner of outbound (D3): it reads `tool_end.structured.card` in the
// event pump, validates it, and calls `CardCapableAdapter.postCard`. The adapter never sees an
// agent event and adds no dedup of its own (`.claude/rules/gateway-dedup.md`).
//
//  - A card post is best-effort and owes no delivery-ledger obligation (D4): prose is the
//    durable answer, and an editable message has no redelivery target after a restart. A failed
//    post is recorded (`gateway.card_post_failed`) and the answer still lands.
//  - Dedup is `sha256(canonical envelope)` scoped to the inbound message (D5), with reservation
//    semantics: `shouldSend` reserves, a failed post `release`s. An identical card answering a
//    different message still posts.
//  - Data cards post at `tool_end`; `recommend_actions` is held and posts after the final answer
//    settles, so its buttons sit under the answer (D13).
//
// Pinned by `__tests__/card-post.test.ts`.

import { createHash } from 'node:crypto';
import type { AgentEvent, CardCapableAdapter, PlatformAdapter } from '@ethosagent/types';
import { type CardEnvelope, CardEnvelopeSchema } from '@ethosagent/web-contracts';
import type { DedupScope, MessageDedupCache } from './dedup';
import type { GatewayObservability } from './gateway-types';

/** Tools a channel turn never sees because no channel can draw them (`render_ui` canvases). */
export const CANVAS_EXCLUDED_TOOLS: readonly string[] = ['render_ui'];

/** True when `adapter` can draw a card natively — the structural `CardCapableAdapter` check. */
export function isCardCapable(
  adapter: PlatformAdapter,
): adapter is PlatformAdapter & CardCapableAdapter {
  return 'postCard' in adapter && typeof adapter.postCard === 'function';
}

/** JSON with object keys sorted, so two envelopes that differ only in key order hash alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The dedup content for a card: stable across key order, never the plaintext. */
export function cardDedupKey(card: CardEnvelope): string {
  return `card:${createHash('sha256').update(canonicalJson(card)).digest('hex')}`;
}

export interface TurnCardPosterOptions {
  adapter: PlatformAdapter & CardCapableAdapter;
  platform: string;
  botKey: string;
  chatId: string;
  threadId: string | undefined;
  sessionKey: string;
  /** The reply-path scope: the inbound message these cards answer (UBP-014). */
  scope: DedupScope;
  dedup: MessageDedupCache;
  observability: GatewayObservability | undefined;
  /** True while the room is a silent-opt-in room: no card is posted into it. */
  silent: () => boolean;
}

type ToolEnd = Extract<AgentEvent, { type: 'tool_end' }>;

/** One turn's cards. Posts are serialized, so they reach the chat in the order the model made them. */
export class TurnCardPoster {
  private chain: Promise<void> = Promise.resolve();
  private readonly held: CardEnvelope[] = [];

  constructor(private readonly opts: TurnCardPosterOptions) {}

  /** Feed a `tool_end`. Validates, then posts a data card now or holds a `recommend_actions`. */
  onToolEnd(event: ToolEnd): void {
    if (!event.ok || !event.structured || !('card' in event.structured)) return;
    if (this.opts.silent()) return;
    const parsed = CardEnvelopeSchema.safeParse(event.structured.card);
    if (!parsed.success) {
      this.opts.observability?.recordSafetyBlock({
        code: 'gateway.card_invalid',
        cause: 'emit_card produced an envelope that does not match CardEnvelopeSchema',
        details: {
          platform: this.opts.platform,
          botKey: this.opts.botKey,
          toolName: event.toolName,
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
      });
      return;
    }
    if (parsed.data.kind === 'recommend_actions') {
      this.held.push(parsed.data);
      return;
    }
    this.enqueue(parsed.data);
  }

  /** Resolves once every card posted so far has settled. Call before sending the final answer. */
  drain(): Promise<void> {
    return this.chain;
  }

  /** Post the held `recommend_actions` cards. Call after the final answer was delivered. */
  async flushHeld(): Promise<void> {
    for (const card of this.held.splice(0)) this.enqueue(card);
    await this.chain;
  }

  private enqueue(card: CardEnvelope): void {
    this.chain = this.chain.then(() => this.post(card));
  }

  private async post(card: CardEnvelope): Promise<void> {
    const { dedup, sessionKey, scope } = this.opts;
    const key = cardDedupKey(card);
    if (!dedup.shouldSend(sessionKey, key, scope)) return;
    try {
      const res = await this.opts.adapter.postCard({
        chatId: this.opts.chatId,
        ...(this.opts.threadId ? { threadId: this.opts.threadId } : {}),
        card,
      });
      if (res.ok) return;
      dedup.release(sessionKey, key, scope);
      this.recordFailure(card, res.error);
    } catch (err) {
      dedup.release(sessionKey, key, scope);
      this.recordFailure(card, err instanceof Error ? err.message : String(err));
    }
  }

  private recordFailure(card: CardEnvelope, error: string | undefined): void {
    this.opts.observability?.recordSafetyBlock({
      code: 'gateway.card_post_failed',
      cause: 'the adapter could not post a card; the answer still lands',
      details: {
        platform: this.opts.platform,
        botKey: this.opts.botKey,
        chatId: this.opts.chatId,
        kind: card.kind,
        error: error ?? 'unknown',
      },
    });
  }
}
