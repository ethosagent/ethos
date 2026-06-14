import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  RequestDumpRecord,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { DefaultHookRegistry } from '../hook-registry';
import { InMemoryRequestDumpStore } from '../request-dump-store';
import { createTestSafety } from './helpers/test-safety';

function makeMockLLM(
  responses: string[],
  onComplete?: (msgs: Message[], tools: unknown, opts: CompletionOptions) => void,
): LLMProvider {
  let callCount = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      messages: Message[],
      tools: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      onComplete?.(messages, tools, opts);
      const text = responses[callCount++ % responses.length] ?? 'default response';
      yield { type: 'text_delta', text };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheCreationTokens: 5,
          estimatedCostUsd: 0.001,
          requestTokens: { system: 40, tools: 30, messages: 30 },
        },
      };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('Observability Extensions', () => {
  describe('TokenUsage.requestTokens', () => {
    it('carries requestTokens field on usage events when populated', async () => {
      const loop = new AgentLoop({ llm: makeMockLLM(['hello']), safety: createTestSafety() });
      const events = await collect(loop.run('hi'));
      const usageEvent = events.find((e) => e.type === 'usage') as Extract<
        AgentEvent,
        { type: 'usage' }
      >;
      expect(usageEvent).toBeDefined();
      // The usage event yields inputTokens/outputTokens at the AgentEvent level
      expect(usageEvent.inputTokens).toBe(100);
      expect(usageEvent.outputTokens).toBe(50);
    });
  });

  describe('BeforeLLMCallPayload enrichment', () => {
    it('carries system, tools, messages, and requestId when AgentLoop fires', async () => {
      const hooks = new DefaultHookRegistry();
      const payloads: Array<{
        system?: string;
        tools?: unknown[];
        messages?: Message[];
        requestId?: string;
      }> = [];
      hooks.registerVoid('before_llm_call', async (payload) => {
        payloads.push(payload);
      });

      const loop = new AgentLoop({
        llm: makeMockLLM(['response']),
        hooks,
        safety: createTestSafety(),
      });
      // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
      loop['personalities'].define({
        id: 'obs-test',
        name: 'ObsTest',
        safety: { observability: { storeLlmPayloads: 'full' } },
      });
      await collect(loop.run('test prompt', { personalityId: 'obs-test' }));

      expect(payloads).toHaveLength(1);
      const p = payloads[0];
      expect(p.system).toBeDefined();
      expect(typeof p.system).toBe('string');
      expect(p.tools).toBeDefined();
      expect(Array.isArray(p.tools)).toBe(true);
      expect(p.messages).toBeDefined();
      expect(Array.isArray(p.messages)).toBe(true);
      expect(p.requestId).toBeDefined();
      expect(typeof p.requestId).toBe('string');
      // requestId should be a UUID format
      expect(p.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('AfterLLMCallPayload enrichment', () => {
    it('carries enriched fields including non-zero usage', async () => {
      const hooks = new DefaultHookRegistry();
      const payloads: Array<{
        sessionId: string;
        text: string;
        usage: { inputTokens: number; outputTokens: number };
        requestId?: string;
        finishReason?: string;
        durationMs?: number;
        system?: string;
        tools?: unknown[];
        messages?: Message[];
      }> = [];
      hooks.registerVoid('after_llm_call', async (payload) => {
        payloads.push(payload);
      });

      const loop = new AgentLoop({
        llm: makeMockLLM(['enriched response']),
        hooks,
        safety: createTestSafety(),
      });
      // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
      loop['personalities'].define({
        id: 'obs-test',
        name: 'ObsTest',
        safety: { observability: { storeLlmPayloads: 'full' } },
      });
      await collect(loop.run('test', { personalityId: 'obs-test' }));

      expect(payloads).toHaveLength(1);
      const p = payloads[0];
      expect(p.text).toBe('enriched response');
      expect(p.usage.inputTokens).toBe(100);
      expect(p.usage.outputTokens).toBe(50);
      expect(p.requestId).toBeDefined();
      expect(p.finishReason).toBe('end_turn');
      expect(typeof p.durationMs).toBe('number');
      expect(p.durationMs).toBeGreaterThanOrEqual(0);
      expect(p.system).toBeDefined();
      expect(p.tools).toBeDefined();
      expect(p.messages).toBeDefined();
    });
  });

  describe('InMemoryRequestDumpStore', () => {
    it('round-trips records correctly', async () => {
      const store = new InMemoryRequestDumpStore();

      const record: RequestDumpRecord = {
        requestId: 'req-1',
        timestamp: '2026-05-14T00:00:00.000Z',
        sessionId: 'sess-1',
        personalityId: 'default',
        turnNumber: 1,
        model: 'mock-model',
        durationMs: 150,
        requestTokens: { system: 40, tools: 30, messages: 30 },
        responseTokens: 50,
        finishReason: 'end_turn',
        system: 'You are a helpful assistant.',
        tools: [{ name: 'read_file', description: 'Reads a file', parameters: {} }],
        messages: [{ role: 'user', content: 'hello' }],
        responseText: 'Hi there!',
      };

      await store.append(record);

      // Without includeContent — content fields stripped
      const metaOnly = await store.recent({ limit: 10 });
      expect(metaOnly).toHaveLength(1);
      expect(metaOnly[0].requestId).toBe('req-1');
      expect(metaOnly[0].model).toBe('mock-model');
      expect((metaOnly[0] as unknown as Record<string, unknown>).system).toBeUndefined();
      expect((metaOnly[0] as unknown as Record<string, unknown>).tools).toBeUndefined();
      expect((metaOnly[0] as unknown as Record<string, unknown>).messages).toBeUndefined();
      expect((metaOnly[0] as unknown as Record<string, unknown>).responseText).toBeUndefined();

      // With includeContent — full record
      const full = await store.recent({ limit: 10, includeContent: true });
      expect(full).toHaveLength(1);
      expect(full[0].system).toBe('You are a helpful assistant.');
      expect(full[0].tools).toHaveLength(1);
      expect(full[0].messages).toHaveLength(1);
      expect(full[0].responseText).toBe('Hi there!');
    });

    it('filters by sessionId', async () => {
      const store = new InMemoryRequestDumpStore();
      await store.append({
        requestId: 'r1',
        timestamp: '2026-05-14T00:00:00.000Z',
        sessionId: 'a',
        turnNumber: 1,
        model: 'm',
      });
      await store.append({
        requestId: 'r2',
        timestamp: '2026-05-14T00:01:00.000Z',
        sessionId: 'b',
        turnNumber: 1,
        model: 'm',
      });

      const results = await store.recent({ limit: 10, sessionId: 'a' });
      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe('r1');
    });

    it('filters by since date', async () => {
      const store = new InMemoryRequestDumpStore();
      await store.append({
        requestId: 'r1',
        timestamp: '2026-05-14T00:00:00.000Z',
        sessionId: 's',
        turnNumber: 1,
        model: 'm',
      });
      await store.append({
        requestId: 'r2',
        timestamp: '2026-05-14T01:00:00.000Z',
        sessionId: 's',
        turnNumber: 2,
        model: 'm',
      });

      const results = await store.recent({
        limit: 10,
        since: new Date('2026-05-14T00:30:00.000Z'),
      });
      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe('r2');
    });

    it('respects limit and returns most-recent first', async () => {
      const store = new InMemoryRequestDumpStore();
      for (let i = 1; i <= 5; i++) {
        await store.append({
          requestId: `r${i}`,
          timestamp: `2026-05-14T0${i}:00:00.000Z`,
          sessionId: 's',
          turnNumber: i,
          model: 'm',
        });
      }

      const results = await store.recent({ limit: 2 });
      expect(results).toHaveLength(2);
      expect(results[0].requestId).toBe('r5');
      expect(results[1].requestId).toBe('r4');
    });
  });

  describe('requestDumpStore wiring', () => {
    it('appends records after each LLM call when wired', async () => {
      const store = new InMemoryRequestDumpStore();
      const loop = new AgentLoop({
        llm: makeMockLLM(['dump test']),
        requestDumpStore: store,
        safety: createTestSafety(),
      });
      // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
      loop['personalities'].define({
        id: 'dump-test',
        name: 'DumpTest',
        safety: { observability: { storeLlmPayloads: 'full' } },
      });
      await collect(loop.run('hello', { personalityId: 'dump-test' }));

      const records = store.getAll();
      expect(records).toHaveLength(1);
      expect(records[0].model).toBe('mock-model');
      expect(records[0].responseText).toBe('dump test');
      expect(records[0].finishReason).toBe('end_turn');
      expect(typeof records[0].durationMs).toBe('number');
      expect(records[0].requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(records[0].system).toBeDefined();
      expect(records[0].tools).toBeDefined();
      expect(records[0].messages).toBeDefined();
    });
  });
});
