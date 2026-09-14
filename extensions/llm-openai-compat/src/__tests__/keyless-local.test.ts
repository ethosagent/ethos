// A keyless self-hosted runtime must construct. The OpenAI SDK refuses to build
// a client with no key ("Missing credentials" — its constructor tests
// `!apiKey`, so `''` fails as well), which crashed `ethos serve` at boot for a
// keyless ollama chain entry. The placeholder is local-only: a hosted endpoint
// with no key must still fail loudly.

import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../index';

describe('OpenAICompatProvider — keyless self-hosted runtimes', () => {
  for (const [name, baseUrl] of [
    ['ollama', 'http://localhost:11434/v1'],
    ['vllm', 'http://gpu-box:8000/v1'],
    ['llamacpp', 'http://localhost:8080/v1'],
    ['lmstudio', 'http://localhost:1234/v1'],
  ] as const) {
    it(`${name} with no apiKey constructs`, () => {
      expect(
        () =>
          new OpenAICompatProvider({
            name,
            model: 'qwen3:8b',
            apiKey: '',
            baseUrl,
            maxContextTokens: 32_768,
          }),
      ).not.toThrow();
    });
  }

  it('a configured key on a local runtime is sent unchanged', () => {
    const provider = new OpenAICompatProvider({
      name: 'vllm',
      model: 'qwen3:8b',
      apiKey: 'operator-key',
      baseUrl: 'http://gpu-box:8000/v1',
      maxContextTokens: 32_768,
    });
    expect((provider as unknown as { client: { apiKey: string } }).client.apiKey).toBe(
      'operator-key',
    );
  });

  it('a hosted endpoint with no key still refuses', () => {
    expect(
      () =>
        new OpenAICompatProvider({
          name: 'openrouter',
          model: 'qwen/qwen3-8b',
          apiKey: '',
          baseUrl: 'https://openrouter.ai/api/v1',
        }),
    ).toThrow(/Missing credentials/);
  });
});
