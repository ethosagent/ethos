// UBP-033 — the model profile's output cap (`models.<provider>/<model>.maxOutputTokens`)
// reaches the Anthropic provider on BOTH construction paths: the plugin factory
// (no rotation keys) and the inline `AuthRotatingProvider` pool `createLLM`
// builds when `rotationKeys` is non-empty. Before the fix the pool dropped it,
// so every pooled key sent the default `max_tokens`.

import { describe, expect, it } from 'vitest';
import { createLLM } from '../index';

function pooledCaps(provider: unknown): Array<number | undefined> {
  const pool = (provider as { providers: Array<{ maxOutputTokens: number | undefined }> })
    .providers;
  return pool.map((p) => p.maxOutputTokens);
}

describe('createLLM — maxOutputTokens reaches the Anthropic rotation pool (UBP-033)', () => {
  const model = 'claude-sonnet-4-20250514';
  const models = { [`anthropic/${model}`]: { maxOutputTokens: 4096 } };

  it('non-rotating provider gets the profile cap (control)', async () => {
    const provider = await createLLM({ provider: 'anthropic', model, apiKey: 'k', models });
    expect((provider as { maxOutputTokens?: number }).maxOutputTokens).toBe(4096);
  });

  it('every pooled key gets the profile cap', async () => {
    const provider = await createLLM({
      provider: 'anthropic',
      model,
      apiKey: 'k1',
      rotationKeys: [{ apiKey: 'k2', priority: 50 }],
      models,
    });
    expect(pooledCaps(provider)).toEqual([4096, 4096]);
  });
});
