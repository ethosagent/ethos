import type {
  ContextEngine,
  ContextEngineCompactInput,
  ContextEngineCompactOutput,
  ContextEngineExternalWrite,
  ContextEngineRemovedEntry,
  Message,
  PersonalityConfig,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { maybeCompact } from '../agent-loop/compaction';
import { validateContextEngine } from '../context-engines/conformance';
import { DefaultContextEngineRegistry } from '../context-engines/registry';

// ---------------------------------------------------------------------------
// Inline third-party engine: keyword_preserving
//
// Keeps messages whose text content contains any keyword from
// personality.context_engine_options?.keywords. Always keeps the first and
// last messages. Drops everything else and optionally pages out dropped
// messages via the store handle.
// ---------------------------------------------------------------------------

function createKeywordPreservingEngine(): ContextEngine & { compactCalled: boolean } {
  let compactCalled = false;

  return {
    get compactCalled() {
      return compactCalled;
    },
    set compactCalled(v: boolean) {
      compactCalled = v;
    },
    name: 'keyword_preserving',

    async compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput> {
      compactCalled = true;
      const { messages, personality, store } = opts;
      const keywords: string[] =
        ((personality.context_engine_options as Record<string, unknown> | undefined)
          ?.keywords as string[]) ?? [];

      if (messages.length <= 2 || keywords.length === 0) {
        return { messages, notes: 'no compaction needed' };
      }

      const kept: Message[] = [];
      const removed: ContextEngineRemovedEntry[] = [];
      const externalWrites: ContextEngineExternalWrite[] = [];

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg) continue;
        const isFirst = i === 0;
        const isLast = i === messages.length - 1;

        if (isFirst || isLast) {
          kept.push(msg);
          continue;
        }

        const text =
          typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                  .map((b) => b.text)
                  .join(' ')
              : '';

        const hasKeyword = keywords.some((kw) => text.toUpperCase().includes(kw.toUpperCase()));

        if (hasKeyword) {
          kept.push(msg);
        } else {
          removed.push({ index: i, reason: 'paged_out' });
          if (store) {
            const key = `paged-out-${i}.json`;
            await store.write(key, JSON.stringify(msg));
            externalWrites.push({ key, tokenCount: Math.ceil(text.length / 4) });
          }
        }
      }

      const droppedCount = messages.length - kept.length;
      return {
        messages: kept,
        notes: `keyword_preserving: kept ${kept.length}, dropped ${droppedCount}`,
        removed,
        externalWrites: externalWrites.length > 0 ? externalWrites : undefined,
      };
    },

    shouldCompact(input: ContextEngineCompactInput): boolean {
      const keywords: string[] =
        ((input.personality.context_engine_options as Record<string, unknown> | undefined)
          ?.keywords as string[]) ?? [];
      return keywords.length > 0 && input.messages.length > 2;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: text };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Third-party context engine: keyword_preserving', () => {
  it('registers via registry and is discoverable', () => {
    const engine = createKeywordPreservingEngine();
    const registry = new DefaultContextEngineRegistry();
    registry.register(engine);

    expect(registry.get('keyword_preserving')).toBe(engine);
    const names = registry.names();
    expect(names).toContain('keyword_preserving');
    expect(names).toContain('drop_oldest');
    expect(names).toContain('semantic_summary');
    expect(names).toContain('reference_preserving');
    expect(names).toContain('tiered_summary');
    expect(names).toHaveLength(5);
  });

  it('runs through the compaction pipeline', async () => {
    const engine = createKeywordPreservingEngine();
    const registry = new DefaultContextEngineRegistry();
    registry.register(engine);

    // Build messages that exceed the 80% pressure gate.
    // maxContextTokens = 2000 → pressureGate = 1600 tokens → 6400 chars.
    // We need system prompt + all messages > 6400 chars total.
    const padding = 'x'.repeat(800);
    const messages: Message[] = [
      userMsg(`IMPORTANT: first message with keyword ${padding}`),
      assistantMsg(`just filler text here ${padding}`),
      userMsg(`ordinary message without keywords ${padding}`),
      assistantMsg(`more filler content ${padding}`),
      userMsg(`CRITICAL alert: something happened ${padding}`),
      assistantMsg(`another boring reply ${padding}`),
      userMsg(`nothing special in this one ${padding}`),
      assistantMsg(`filler again ${padding}`),
      userMsg(`this is IMPORTANT context ${padding}`),
      assistantMsg(`last message in the conversation ${padding}`),
    ];

    const systemPrompt = 'You are a helpful assistant.';

    // Storage mock that tracks writes
    const storeWrites: Array<{ key: string; value: string }> = [];
    const storageMock = {
      read: async () => null,
      write: async (path: string, content: string) => {
        storeWrites.push({ key: path, value: content });
      },
      list: async () => [],
      // biome-ignore lint/suspicious/noExplicitAny: standard test mock
    } as any;

    const sessionMock = {
      recordCompression: async () => ({}),
      updateUsage: async () => {},
      recordCompactionTurn: async () => {},
      // biome-ignore lint/suspicious/noExplicitAny: standard test mock
    } as any;

    const personality: PersonalityConfig = {
      id: 'test',
      name: 'Test',
      context_engine: 'keyword_preserving',
      context_engine_options: { keywords: ['IMPORTANT', 'CRITICAL'] },
    };

    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 2000 } as any,
        contextEngines: registry,
        session: sessionMock,
        storage: storageMock,
        dataDir: '/mock/data',
      },
      messages,
      systemPrompt,
      personality,
      { sessionId: 's1', sessionKey: 'cli:s1', turnNumber: 1, lastCompactionTurn: 0 },
    );

    // Engine was actually invoked
    expect(engine.compactCalled).toBe(true);

    // Output was compacted — fewer messages than input
    expect(result.messages.length).toBeLessThan(messages.length);

    // Messages with keywords survived
    const allText = result.messages.map((m) => (typeof m.content === 'string' ? m.content : ''));
    expect(allText.some((t) => t.includes('IMPORTANT'))).toBe(true);
    expect(allText.some((t) => t.includes('CRITICAL'))).toBe(true);

    // First and last messages survived
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[result.messages.length - 1]).toBe(messages[messages.length - 1]);

    // Store received writes for dropped messages
    expect(storeWrites.length).toBeGreaterThan(0);
  });

  it('passes the conformance harness', async () => {
    const engine = createKeywordPreservingEngine();
    const result = await validateContextEngine(engine);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('shouldCompact: framework gate is the floor', async () => {
    const engine = createKeywordPreservingEngine();
    const registry = new DefaultContextEngineRegistry();
    registry.register(engine);

    // Messages below the 80% pressure gate.
    // maxContextTokens = 2000 → pressureGate = 1600 tokens → 6400 chars.
    // Keep total well below that.
    const messages: Message[] = [
      userMsg('hello'),
      assistantMsg('hi'),
      userMsg('short message'),
      assistantMsg('short reply'),
    ];

    const sessionMock = {
      recordCompression: async () => ({}),
      updateUsage: async () => {},
      recordCompactionTurn: async () => {},
      // biome-ignore lint/suspicious/noExplicitAny: standard test mock
    } as any;

    const personality: PersonalityConfig = {
      id: 'test',
      name: 'Test',
      context_engine: 'keyword_preserving',
      context_engine_options: { keywords: ['IMPORTANT'] },
    };

    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 2000 } as any,
        contextEngines: registry,
        session: sessionMock,
      },
      messages,
      '',
      personality,
      { sessionId: 's2', sessionKey: 'cli:s2', turnNumber: 1, lastCompactionTurn: 0 },
    );

    // Framework gate prevented compaction — messages unchanged
    expect(result.messages).toBe(messages);

    // Engine was NOT invoked
    expect(engine.compactCalled).toBe(false);
  });
});
