// Lane 5(ii) — the compression summarizer's provider gets the SAME
// window/profile threading as the main provider. Asserted at the factory
// seam: a stub factory records the config it is constructed with, and the
// probe path is exercised cache-first with a fetch stub that fails the test
// on any network call.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultLLMProviderRegistry, withUsageScope } from '@ethosagent/core';
import { SQLiteUsageLedger } from '@ethosagent/session-sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider, Message, Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildCompressionSummarizer, type WiringConfig } from '../index';
import { windowProbeCachePath } from '../local-models';
import { createUsageMeter } from '../usage-meter';
import { PASSTHROUGH_METER, usageChunk } from './helpers/usage-test-kit';

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLog,
};

const BASE_URL = 'http://localhost:11434/v1';

function stubProvider(config: Record<string, unknown>): LLMProvider {
  return {
    name: String(config.provider),
    model: String(config.model),
    maxContextTokens: typeof config.maxContextTokens === 'number' ? config.maxContextTokens : 0,
    supportsCaching: false,
    supportsThinking: false,
    complete(
      _messages: Message[],
      _tools: Tool[],
      _opts?: unknown,
    ): AsyncIterable<CompletionChunk> {
      return (async function* () {
        yield { type: 'text_delta', text: 'a summary' } as CompletionChunk;
      })();
    },
  } as unknown as LLMProvider;
}

function registryRecording(seen: Record<string, unknown>[]): DefaultLLMProviderRegistry {
  const registry = new DefaultLLMProviderRegistry();
  registry.register('ollama', ({ config }) => {
    seen.push(config as Record<string, unknown>);
    return stubProvider(config as Record<string, unknown>);
  });
  return registry;
}

/** Warm probe cache so window resolution never touches the network. */
async function warmCache(storage: InMemoryStorage, model: string, contextWindow: number) {
  await storage.mkdir('/data/cache');
  await storage.write(
    windowProbeCachePath('/data'),
    JSON.stringify({
      version: 1,
      entries: {
        [`${BASE_URL}::${model}`]: { contextWindow, source: 'allocation', probedAt: Date.now() },
      },
    }),
  );
}

const forbiddenFetch = (async () => {
  throw new Error('TEST FAILURE: network call attempted on a warm cache');
}) as unknown as typeof fetch;

describe('Lane 5(ii) — buildCompressionSummarizer window/profile threading', () => {
  it('constructs the summarizer provider with the resolved window and profile', async () => {
    const seen: Record<string, unknown>[] = [];
    const registry = registryRecording(seen);
    const storage = new InMemoryStorage();
    await warmCache(storage, 'aux-model', 20_000);

    const config: WiringConfig = {
      provider: 'ollama',
      model: 'main-model',
      apiKey: 'local',
      baseUrl: BASE_URL,
      auxiliaryCompression: { model: 'aux-model' },
      models: { 'ollama/aux-model': { toolCallFormat: 'openai', maxOutputTokens: 512 } },
    };
    const summarize = buildCompressionSummarizer(
      registry,
      config,
      undefined,
      noopLog,
      {
        storage,
        dataDir: '/data',
        fetchImpl: forbiddenFetch,
      },
      PASSTHROUGH_METER,
    );
    const result = await summarize([{ role: 'user', content: 'hello' }], 100);

    expect(result).toBe('a summary');
    expect(seen).toHaveLength(1);
    const providerConfig = seen[0] ?? {};
    expect(providerConfig.model).toBe('aux-model');
    // The mis-sizing fix: the cached served window, not the 128k inherit.
    expect(providerConfig.maxContextTokens).toBe(20_000);
    // Profile fields, threaded the same way the main provider gets them.
    expect(providerConfig.toolCallFormat).toBe('openai');
    expect(providerConfig.maxOutputTokens).toBe(512);
  });

  it('builds the provider once and reuses it across calls', async () => {
    const seen: Record<string, unknown>[] = [];
    const registry = registryRecording(seen);
    const storage = new InMemoryStorage();
    await warmCache(storage, 'aux-model', 20_000);

    const config: WiringConfig = {
      provider: 'ollama',
      model: 'main-model',
      apiKey: 'local',
      baseUrl: BASE_URL,
      auxiliaryCompression: { model: 'aux-model' },
    };
    const summarize = buildCompressionSummarizer(
      registry,
      config,
      undefined,
      noopLog,
      {
        storage,
        dataDir: '/data',
        fetchImpl: forbiddenFetch,
      },
      PASSTHROUGH_METER,
    );
    await summarize([{ role: 'user', content: 'one' }], 100);
    await summarize([{ role: 'user', content: 'two' }], 100);
    expect(seen).toHaveLength(1);
  });

  it('omits maxContextTokens when no window resolves (no probe context, no catalog hit)', async () => {
    const seen: Record<string, unknown>[] = [];
    const registry = registryRecording(seen);

    const config: WiringConfig = {
      provider: 'ollama',
      model: 'main-model',
      apiKey: 'local',
      baseUrl: BASE_URL,
      auxiliaryCompression: { model: 'aux-model' },
    };
    // No windowProbe context at all → resolution falls through with no value;
    // the provider keeps its own default rather than a fabricated one.
    const summarize = buildCompressionSummarizer(
      registry,
      config,
      undefined,
      noopLog,
      undefined,
      PASSTHROUGH_METER,
    );
    await summarize([{ role: 'user', content: 'hello' }], 100);

    const providerConfig = seen[0] ?? {};
    expect('maxContextTokens' in providerConfig).toBe(false);
  });
});

// U12 (plan background-usage-accounting §10) — the reproducing case: a
// compaction on the auxiliary model used to land in observability.db only, so
// the bot's daily cap never saw it. The summarizer's provider is now metered
// as `compaction`; core opens the usage scope around the compaction await
// (`turnUsageCharges`, packages/core/src/agent-loop/usage-charges.ts), which is
// mirrored here with `withUsageScope`, so the row carries the compacting
// turn's session key and the bot's spend read rises by the summarizer's cost.
describe('U12 — an auxiliary compaction is billed to the bot', () => {
  it('writes one compaction ledger row on the compacting turn, raising that bot spend', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ethos-u12-'));
    const ledger = new SQLiteUsageLedger(join(dir, 'sessions.db'));
    try {
      const registry = new DefaultLLMProviderRegistry();
      registry.register('ollama', ({ config }) => ({
        ...stubProvider(config as Record<string, unknown>),
        complete: async function* (): AsyncGenerator<CompletionChunk> {
          yield { type: 'text_delta', text: 'a summary' };
          yield usageChunk(900, 80, 0.042);
        },
      }));
      const meter = createUsageMeter({ recorder: ledger, defaults: { botKey: 'bot-a' } });
      const config: WiringConfig = {
        provider: 'ollama',
        model: 'main-model',
        apiKey: 'local',
        auxiliaryCompression: { model: 'aux-model' },
      };
      const summarize = buildCompressionSummarizer(
        registry,
        config,
        undefined,
        noopLog,
        undefined,
        meter,
      );
      const since = new Date(Date.now() - 1000);
      const sessionKey = 'telegram:bot-a:42';
      const before = ledger.spendSince({ since, keyPrefix: 'telegram:bot-a:' });
      await withUsageScope({ attribution: { sessionId: 's-42', sessionKey } }, () =>
        summarize([{ role: 'user', content: 'a long middle' }], 100),
      );
      const after = ledger.spendSince({ since, keyPrefix: 'telegram:bot-a:' });
      expect(after.turnUtilityUsd - before.turnUtilityUsd).toBeCloseTo(0.042, 9);
      expect(ledger.spendSince({ since, botKey: 'bot-a' }).turnUtilityUsd).toBeCloseTo(0.042, 9);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
