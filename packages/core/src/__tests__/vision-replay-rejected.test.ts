// UBP-019 — a user row persists its inline image/document blocks before the
// LLM call. When the provider rejected that turn (a PDF over its page limit,
// say), no assistant row followed, so block aging — which counts assistant
// turns — never retired the block, and every later message resent it and
// failed the same way until /new. A block whose turn got no reply is now
// replayed as a line naming it. A replayed block the CURRENT model cannot read
// is degraded the same way when the caller passes that model's capabilities.

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Message,
  MessageContent,
  ProviderCapabilities,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { ageVisionBlocks } from '../agent-loop/vision-aging';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { createTestSafety } from './helpers/test-safety';

const PDF: Extract<MessageContent, { type: 'document' }> = {
  type: 'document',
  mediaType: 'application/pdf',
  data: 'JVBERi0xLjQ=',
  filename: 'big.pdf',
};
const IMG: Extract<MessageContent, { type: 'image' }> = {
  type: 'image',
  mediaType: 'image/png',
  data: 'aGVsbG8=',
  filename: 'shot.png',
};

const VISION: ProviderCapabilities = {
  streaming: true,
  toolCalling: true,
  parallelToolCalls: true,
  visionImages: true,
  visionDocuments: true,
  thinking: false,
  promptCaching: false,
  cacheBreakpoints: false,
  systemPromptStyle: 'top-level',
  tokenCounting: 'estimated',
  contractVersion: 1,
};

/** A vision provider that rejects any request carrying a document block. */
function rejectsDocuments(captured: Message[][]): LLMProvider {
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    capabilities: VISION,
    async *complete(messages: Message[]): AsyncGenerator<CompletionChunk> {
      captured.push(JSON.parse(JSON.stringify(messages)));
      const hasDoc = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'document'),
      );
      if (hasDoc) throw new Error('400 invalid_request_error: A maximum of 100 PDF pages');
      yield { type: 'text_delta', text: 'page 1 says hello' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function hasBlock(messages: Message[] | undefined, type: 'image' | 'document'): boolean {
  return (messages ?? []).some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === type),
  );
}

describe('UBP-019 — a block whose turn got no reply is not replayed', () => {
  it('the next turn does not resend a document the provider rejected', async () => {
    const captured: Message[][] = [];
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: rejectsDocuments(captured),
      session,
      safety: createTestSafety(),
    });
    // Turn 1 creates the session; its reply is the one that got rejected: a
    // user row carrying the PDF, and no assistant row after it.
    await collect(loop.run('first', { sessionKey: 'cli:rej' }));
    const s = await session.getSessionByKey('cli:rej');
    if (!s) throw new Error('no session');
    await session.appendMessage({
      sessionId: s.id,
      role: 'user',
      content: 'summarize this',
      contentBlocks: [PDF],
    });

    const events = await collect(loop.run('ok, just summarize page 1', { sessionKey: 'cli:rej' }));
    const sent = captured.at(-1);
    expect(hasBlock(sent, 'document')).toBe(false);
    expect(JSON.stringify(sent)).toContain('big.pdf');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('ageVisionBlocks degrades a block followed by another user message with no reply', () => {
    const messages: Message[] = [
      { role: 'user', content: [PDF, { type: 'text', text: 'summarize' }] },
      { role: 'user', content: 'page 1 only' },
    ];
    const out = ageVisionBlocks(messages);
    expect(hasBlock(out, 'document')).toBe(false);
    expect(out[0]?.content).toEqual([
      { type: 'text', text: '[document not resent: big.pdf — the turn it came with got no reply]' },
      { type: 'text', text: 'summarize' },
    ]);
  });

  it('a block whose turn WAS answered keeps it inside the recency window', () => {
    const messages: Message[] = [
      { role: 'user', content: [IMG, { type: 'text', text: 'what is this' }] },
      { role: 'assistant', content: 'a cat' },
      { role: 'user', content: 'what colour?' },
    ];
    expect(ageVisionBlocks(messages)).toBe(messages);
  });
});

describe('UBP-019 — a replayed block the current model cannot read is degraded', () => {
  const answered: Message[] = [
    { role: 'user', content: [IMG, PDF, { type: 'text', text: 'look' }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'and now?' },
  ];

  it('no vision at all → both blocks become lines naming them', () => {
    const out = ageVisionBlocks(answered, undefined, {
      vision: { images: false, documents: false },
    });
    expect(hasBlock(out, 'image')).toBe(false);
    expect(hasBlock(out, 'document')).toBe(false);
    expect(JSON.stringify(out)).toContain('shot.png');
  });

  it('images but not documents → only the document degrades', () => {
    const out = ageVisionBlocks(answered, undefined, {
      vision: { images: true, documents: false },
    });
    expect(hasBlock(out, 'image')).toBe(true);
    expect(hasBlock(out, 'document')).toBe(false);
  });

  it('full vision (or no capabilities given) → unchanged', () => {
    expect(
      ageVisionBlocks(answered, undefined, { vision: { images: true, documents: true } }),
    ).toBe(answered);
    expect(ageVisionBlocks(answered)).toBe(answered);
  });
});

describe("UBP-019 — the loop passes the current model's vision to block aging", () => {
  it('a text-only model gets the named-attachment line, not the replayed image', async () => {
    const captured: Message[][] = [];
    const textOnly: LLMProvider = {
      name: 'scripted',
      model: 'text-only',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      capabilities: { ...VISION, visionImages: false, visionDocuments: false },
      async *complete(messages: Message[]): AsyncGenerator<CompletionChunk> {
        captured.push(JSON.parse(JSON.stringify(messages)));
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() {
        return 1;
      },
    };
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm: textOnly, session, safety: createTestSafety() });
    await collect(loop.run('first', { sessionKey: 'cli:tier' }));
    const s = await session.getSessionByKey('cli:tier');
    if (!s) throw new Error('no session');
    // An earlier turn (on a vision model) sent an image and was answered.
    await session.appendMessage({
      sessionId: s.id,
      role: 'user',
      content: 'what is this',
      contentBlocks: [IMG],
    });
    await session.appendMessage({ sessionId: s.id, role: 'assistant', content: 'a cat' });

    await collect(loop.run('what colour?', { sessionKey: 'cli:tier' }));
    const sent = captured.at(-1);
    expect(hasBlock(sent, 'image')).toBe(false);
    expect(JSON.stringify(sent)).toContain(
      '[image not sent: shot.png — this model cannot read images]',
    );
  });
});
