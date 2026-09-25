// openclaw-9.5-adoption item 7 (D32) — `providers.<n>.serverCompaction` reaches
// the provider that sends the edit AND the loop that skips its own compaction,
// through one mark (`markServerCompaction`). The trigger defaults to the local
// gate's own threshold (`pressureGateTokens`), so the switch changes who
// compacts, not when. Honoured on `anthropic` entries only.

import {
  ChainedProvider,
  pressureGateTokens,
  providerEntriesOf,
  servesServerCompaction,
} from '@ethosagent/core';
import type { LLMProvider, Logger } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createLLM, type WiringConfig } from '../index';

function recordingLogger(warnings: string[]): Logger {
  const log: Logger = {
    info: () => {},
    warn: (m: string) => warnings.push(m),
    error: () => {},
    debug: () => {},
    child: () => log,
  };
  return log;
}

/** The trigger an `AnthropicProvider` instance was built with (private field). */
function triggerOf(provider: LLMProvider | undefined): number | undefined {
  return (provider as unknown as { serverCompaction?: { triggerTokens: number } } | undefined)
    ?.serverCompaction?.triggerTokens;
}

const TOP = { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-test' };

describe('createLLM — providers.<n>.serverCompaction', () => {
  it('marks the anthropic hop and defaults its trigger to the local gate threshold', async () => {
    const llm = await createLLM({
      ...TOP,
      providers: [
        { provider: 'anthropic', id: 'claude', apiKey: 'sk-ant-test', serverCompaction: true },
        { provider: 'openrouter', id: 'router', apiKey: 'k', model: 'm' },
      ],
    });
    expect(llm).toBeInstanceOf(ChainedProvider);
    expect(servesServerCompaction(llm, { key: 'claude' })).toBe(true);
    expect(servesServerCompaction(llm, { key: 'router' })).toBe(false);
    const hop = (llm as ChainedProvider).entryProvider('claude');
    expect(triggerOf(hop)).toBe(pressureGateTokens(200_000));
    expect(providerEntriesOf(llm)?.map((e) => e.key)).toEqual(['claude', 'router']);
  });

  it('uses an explicit serverCompactionTriggerTokens', async () => {
    const llm = await createLLM({
      ...TOP,
      providers: [
        {
          provider: 'anthropic',
          apiKey: 'sk-ant-test',
          serverCompaction: true,
          serverCompactionTriggerTokens: 120_000,
        },
      ],
    });
    expect(servesServerCompaction(llm)).toBe(true);
    expect(triggerOf(llm)).toBe(120_000);
  });

  it('follows the resolved compaction pressure and ceiling', async () => {
    const config: WiringConfig = {
      ...TOP,
      compaction: { pressure: 0.5, maxContextTokens: 90_000 },
      providers: [{ provider: 'anthropic', apiKey: 'sk-ant-test', serverCompaction: true }],
    };
    const llm = await createLLM(config);
    expect(triggerOf(llm)).toBe(pressureGateTokens(200_000, 0.5, 90_000));
    expect(triggerOf(llm)).toBe(90_000);
  });

  it('warns and compacts locally when the entry is not anthropic', async () => {
    const warnings: string[] = [];
    const llm = await createLLM(
      {
        provider: 'openrouter',
        model: 'm',
        apiKey: 'k',
        providers: [{ provider: 'openrouter', apiKey: 'k', model: 'm', serverCompaction: true }],
      },
      undefined,
      recordingLogger(warnings),
    );
    expect(servesServerCompaction(llm)).toBe(false);
    expect(
      warnings.some((w) => w.includes('serverCompaction is honoured only on an anthropic')),
    ).toBe(true);
  });

  it('leaves a provider without the flag unmarked', async () => {
    const llm = await createLLM(TOP);
    expect(servesServerCompaction(llm)).toBe(false);
    expect(triggerOf(llm)).toBeUndefined();
  });
});
