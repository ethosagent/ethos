// UBP-019 — a user row persists its inline image/document blocks before the
// LLM call. When the provider rejected that turn (a PDF over its page limit,
// say), no assistant row followed, so block aging — which counts assistant
// turns — never retired the block, and every later message resent it and
// failed the same way until /new. A block the provider DETERMINISTICALLY
// rejected is now replayed as a line naming it; the loop records which rows
// that was (`recordVisionRejection`, agent-loop/vision-rejection.ts). A turn
// that failed transiently (overload, 429, timeout, abort) records nothing, so
// the user's "try again" resends the attachment (V-CP-3). A replayed block the
// CURRENT model cannot read is degraded the same way when the caller passes
// that model's capabilities.

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
import { ageVisionBlocks, degradeRejectedRows } from '../agent-loop/vision-aging';
import { isDeterministicRejection, VISION_REJECTED_KEY } from '../agent-loop/vision-rejection';
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

/** A vision provider that fails the FIRST request carrying a document with `err`, then answers. */
function failsOnceOnDocument(captured: Message[][], err: unknown): LLMProvider {
  let failed = false;
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
      if (hasDoc && !failed) {
        failed = true;
        throw err;
      }
      yield { type: 'text_delta', text: 'page 1 says hello' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Turn 1 creates the session. Then a user row carrying the PDF is persisted
 * (as context assembly does before the call) and turn 2 sends it: the provider
 * fails that call. Turn 3 is the user's follow-up.
 */
async function rejectThenRetry(llm: LLMProvider, key: string) {
  const session = new InMemorySessionStore();
  const loop = new AgentLoop({ llm, session, safety: createTestSafety() });
  await collect(loop.run('first', { sessionKey: key }));
  const s = await session.getSessionByKey(key);
  if (!s) throw new Error('no session');
  const pdfRow = await session.appendMessage({
    sessionId: s.id,
    role: 'user',
    content: 'summarize this',
    contentBlocks: [PDF],
  });
  const failedTurn = await collect(loop.run('please', { sessionKey: key }));
  const followUp = await collect(loop.run('ok, just summarize page 1', { sessionKey: key }));
  const metadata = (await session.getSession(s.id))?.metadata;
  return { failedTurn, followUp, metadata, pdfRowId: pdfRow.id };
}

describe('UBP-019 / V-CP-3 — only a deterministic rejection retires a block', () => {
  it('after a 400 rejection the next turn does not resend the document', async () => {
    const captured: Message[][] = [];
    const { failedTurn, followUp, metadata, pdfRowId } = await rejectThenRetry(
      rejectsDocuments(captured),
      'cli:rej',
    );
    expect(failedTurn.find((e) => e.type === 'error')).toMatchObject({ code: 'llm_error' });
    expect(metadata?.[VISION_REJECTED_KEY]).toEqual([pdfRowId]);
    const sent = captured.at(-1);
    expect(hasBlock(sent, 'document')).toBe(false);
    expect(JSON.stringify(sent)).toContain(
      '[document not resent: big.pdf — the provider rejected the turn it came with]',
    );
    expect(followUp.some((e) => e.type === 'error')).toBe(false);
  });

  it.each([
    ['529 overloaded', statusError(529, 'Overloaded')],
    ['429 rate limit', statusError(429, 'rate limit exceeded')],
    ['503 unavailable', statusError(503, 'service unavailable')],
    ['a timeout', new Error('Request timed out')],
    ['a network error', new Error('socket hang up')],
    ['an abort', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })],
  ])('after %s the follow-up resends the document', async (_label, err) => {
    const captured: Message[][] = [];
    const { failedTurn, followUp, metadata } = await rejectThenRetry(
      failsOnceOnDocument(captured, err),
      'cli:transient',
    );
    expect(failedTurn.some((e) => e.type === 'error')).toBe(true);
    expect(metadata?.[VISION_REJECTED_KEY]).toBeUndefined();
    expect(hasBlock(captured.at(-1), 'document')).toBe(true);
    expect(followUp.some((e) => e.type === 'error')).toBe(false);
  });

  it('ageVisionBlocks alone no longer degrades an unanswered block', () => {
    const messages: Message[] = [
      { role: 'user', content: [PDF, { type: 'text', text: 'summarize' }] },
      { role: 'user', content: 'page 1 only' },
    ];
    expect(ageVisionBlocks(messages)).toBe(messages);
  });

  it('degradeRejectedRows replaces only the recorded rows’ blocks, in place', () => {
    const rows = [
      { id: 'a', sessionId: 's', role: 'user' as const, content: 'x', contentBlocks: [PDF] },
      { id: 'b', sessionId: 's', role: 'user' as const, content: 'y', contentBlocks: [IMG] },
    ].map((r) => ({ ...r, timestamp: new Date(0) }));
    const out = degradeRejectedRows(rows, new Set(['a']));
    expect(out[0]?.contentBlocks).toEqual([
      {
        type: 'text',
        text: '[document not resent: big.pdf — the provider rejected the turn it came with]',
      },
    ]);
    expect(out[1]).toBe(rows[1]);
    expect(degradeRejectedRows(rows, new Set())).toBe(rows);
  });

  it('isDeterministicRejection: 400/413/415/422 yes; transient, auth and unknown no', () => {
    expect(isDeterministicRejection(statusError(400, 'bad'))).toBe(true);
    expect(isDeterministicRejection(statusError(413, 'too big'))).toBe(true);
    expect(isDeterministicRejection(new Error('400 invalid_request_error: pages'))).toBe(true);
    expect(isDeterministicRejection(statusError(422, 'x'))).toBe(true);
    for (const status of [408, 429, 500, 502, 503, 504, 529, 401, 403, 404]) {
      expect(isDeterministicRejection(statusError(status, 'x'))).toBe(false);
    }
    expect(isDeterministicRejection(new Error('request id abc4001 failed'))).toBe(false);
    expect(isDeterministicRejection(new Error('socket hang up'))).toBe(false);
    // A structured transient status wins over a 400 in the text.
    expect(isDeterministicRejection(statusError(503, 'upstream said 400'))).toBe(false);
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
