// V-CP-5 / UBP-038 — an Azure reasoning deployment whose name is not a
// reasoning model id (`prod-chat`, not `o4-mini`) was sent `max_tokens`, which
// Azure refuses for the reasoning families. `providers.<n>.outputCapParam`
// forces the parameter: `azureFactory` reads it, and `AzureOpenAIProvider`
// passes it to `buildChatCompletionsParamsAsync` as an override that wins over
// the deployment-name rule.

import type { SecretsResolver } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';

const requests: Array<Record<string, unknown>> = [];

vi.mock('openai', () => {
  class MockAzureOpenAI {
    chat = {
      completions: {
        create: async (body: Record<string, unknown>) => {
          requests.push(body);
          return {
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
            },
          };
        },
      },
    };
  }
  return { default: class {}, AzureOpenAI: MockAzureOpenAI };
});

const { azureFactory } = await import('../index');

const secrets: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};
const logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

async function bodyFor(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  requests.length = 0;
  const provider = await azureFactory({
    config: {
      provider: 'azure',
      apiKey: 'k',
      baseUrl: 'https://r.openai.azure.com',
      apiVersion: '2024-12-01-preview',
      ...config,
    },
    secrets,
    logger,
  });
  for await (const _ of provider.complete([{ role: 'user', content: 'hi' }], [], {
    maxTokens: 256,
  })) {
    // drain
  }
  return requests[0] ?? {};
}

describe('azure outputCapParam (V-CP-5)', () => {
  it('without it, a reasoning deployment under an arbitrary name is sent max_tokens', async () => {
    const body = await bodyFor({ model: 'prod-chat' });
    expect(body.max_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('max_completion_tokens forces the reasoning spelling for any deployment name', async () => {
    const body = await bodyFor({ model: 'prod-chat', outputCapParam: 'max_completion_tokens' });
    expect(body.max_completion_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('max_tokens overrides the name rule the other way', async () => {
    const body = await bodyFor({ model: 'o4-mini', outputCapParam: 'max_tokens' });
    expect(body.max_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('refuses any other value at construction', async () => {
    await expect(
      bodyFor({ model: 'prod-chat', outputCapParam: 'max_output_tokens' }),
    ).rejects.toThrow(/outputCapParam.*max_tokens or max_completion_tokens/);
  });
});
