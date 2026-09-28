// V-CP-2 / UBP-033 (plan/phases/upstream-bug-parity.md) — a reply the output
// token cap cut off must not reach a channel looking complete. Core marks it
// with a `_loop` `tool_progress` (`MAX_TOKENS_REPLY_NOTICE`,
// packages/core/src/agent-loop/output-cap.ts, yielded by `settleTextEnd`), but
// the gateway rendered that line only as a transient streaming progress line
// that the final edit replaced, and the non-streaming path never read it. The
// delivered text now ends with the notice on both paths
// (`Gateway.runTurn` → `deliverAnswer`, which imports core's
// `MAX_TOKENS_REPLY_NOTICE` rather than keeping a copy).

import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
  MAX_TOKENS_REPLY_NOTICE,
} from '@ethosagent/core';
import type {
  CompletionChunk,
  DeliveryResult,
  InboundMessage,
  LLMProvider,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { Gateway } from '../index';

function llmStopping(finishReason: 'max_tokens' | 'end_turn'): LLMProvider {
  return {
    name: 'scripted',
    model: 'scripted-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'Step 1: open the file. Step 2: ed' };
      yield { type: 'done', finishReason };
    },
    async countTokens() {
      return 1;
    },
  };
}

function recordingAdapter(streaming: boolean) {
  const sends: string[] = [];
  const edits: string[] = [];
  const adapter = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    canSendTyping: false,
    canEditMessage: streaming,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    ...(streaming
      ? {
          editMessage: vi.fn(
            async (_chatId: string, messageId: string, text: string): Promise<DeliveryResult> => {
              edits.push(text);
              return { ok: true, messageId };
            },
          ),
        }
      : {}),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return { adapter, sends, edits };
}

function harness(finishReason: 'max_tokens' | 'end_turn', streaming: boolean) {
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'default', name: 'Default', toolset: [] });
  const loop = new AgentLoop({
    llm: llmStopping(finishReason),
    tools: new DefaultToolRegistry(),
    session: new InMemorySessionStore(),
    personalities,
    safety: createTestSafety(),
    compaction: { autoCompact: false },
  });
  const out = recordingAdapter(streaming);
  const gw = new Gateway({
    bots: [{ botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' } }],
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    streamingEditIntervalMs: 0,
  });
  return { gw, out };
}

function msg(): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'walk me through it',
    isDm: true,
    isGroupMention: false,
    botKey: 'bot-a',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
  };
}

describe('a reply cut off at the output cap says so on the channel (V-CP-2)', () => {
  it('non-streaming: the one send ends with the cut-off notice', async () => {
    const h = harness('max_tokens', false);
    await h.gw.handleMessage(msg(), h.out.adapter);
    expect(h.out.sends).toHaveLength(1);
    expect(h.out.sends[0]).toBe(`Step 1: open the file. Step 2: ed\n\n${MAX_TOKENS_REPLY_NOTICE}`);
  });

  it('streaming: the final edit keeps the cut-off notice', async () => {
    const h = harness('max_tokens', true);
    await h.gw.handleMessage(msg(), h.out.adapter);
    // Streamed: one draft send, the final lands as an edit of it.
    expect(h.out.sends).toHaveLength(1);
    expect(h.out.edits.at(-1)).toBe(
      `Step 1: open the file. Step 2: ed\n\n${MAX_TOKENS_REPLY_NOTICE}`,
    );
  });

  it('a reply that finished normally carries no notice', async () => {
    const h = harness('end_turn', false);
    await h.gw.handleMessage(msg(), h.out.adapter);
    expect(h.out.sends).toEqual(['Step 1: open the file. Step 2: ed']);
  });
});
