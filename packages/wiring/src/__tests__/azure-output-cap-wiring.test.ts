// V-CP-5 / UBP-038 — `providers.<n>.outputCapParam` reaches the Azure provider
// on both spellings of the chain: a hop in a chain of two, and the top-level
// fields, which count as entry 0 when entry 0 is the same provider (the rule
// `serverCompaction` follows). Set on any other provider it is ignored with a
// warning.

import { ChainedProvider } from '@ethosagent/core';
import type { LLMProvider, Logger } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createLLM } from '../index';

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

/** The override an `AzureOpenAIProvider` was built with (private field). */
function capParamOf(provider: LLMProvider | undefined): string | undefined {
  return (provider as unknown as { outputCapParam?: string } | undefined)?.outputCapParam;
}

const AZURE = {
  provider: 'azure',
  apiKey: 'k',
  model: 'prod-chat',
  baseUrl: 'https://r.openai.azure.com',
  apiVersion: '2024-12-01-preview',
} as const;

describe('createLLM — providers.<n>.outputCapParam', () => {
  it('reaches the azure hop of a chain', async () => {
    const llm = await createLLM({
      ...AZURE,
      providers: [
        { ...AZURE, id: 'az', outputCapParam: 'max_completion_tokens' },
        { provider: 'openrouter', id: 'router', apiKey: 'k', model: 'm' },
      ],
    });
    expect(llm).toBeInstanceOf(ChainedProvider);
    expect(capParamOf((llm as ChainedProvider).entryProvider('az'))).toBe('max_completion_tokens');
  });

  it('reaches the top-level provider from entry 0 of the same provider', async () => {
    const llm = await createLLM({
      ...AZURE,
      providers: [{ ...AZURE, outputCapParam: 'max_completion_tokens' }],
    });
    expect(capParamOf(llm)).toBe('max_completion_tokens');
  });

  it('is absent when not configured', async () => {
    expect(capParamOf(await createLLM(AZURE))).toBeUndefined();
  });

  it('warns when set on a non-azure entry', async () => {
    const warnings: string[] = [];
    await createLLM(
      {
        provider: 'openrouter',
        model: 'm',
        apiKey: 'k',
        providers: [
          { provider: 'openrouter', apiKey: 'k', model: 'm', outputCapParam: 'max_tokens' },
        ],
      },
      undefined,
      recordingLogger(warnings),
    );
    expect(
      warnings.some((w) => w.includes('outputCapParam is honoured only on an azure entry')),
    ).toBe(true);
  });
});
