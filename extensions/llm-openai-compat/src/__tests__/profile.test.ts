// §7 — the provider consumes profile fields threaded via its config:
// `maxOutputTokens` becomes a default `max_tokens` (a per-call `maxTokens`
// wins), and `toolCallFormat: 'text-xml'` strips structured tools.

import type { CompletionChunk, ToolDefinitionLite } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';

interface CreateParams {
  max_tokens?: number;
  tools?: unknown[];
  messages: Array<{ role: string; content?: string }>;
}

const captured: { current: CreateParams | null } = { current: null };
const lastParams = (): CreateParams | null => captured.current;

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: async (params: CreateParams) => {
          captured.current = params;
          return {
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: 'ok' } }] };
              yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
            },
          };
        },
      },
    };
  }
  return { default: MockOpenAI };
});

async function drain(iter: AsyncIterable<CompletionChunk>) {
  for await (const _ of iter) {
    // consume
  }
}

const TOOL: ToolDefinitionLite = {
  name: 'echo',
  description: 'echo',
  parameters: { type: 'object', properties: {} },
};

describe('OpenAICompatProvider — §7 profile fields', () => {
  it('applies maxOutputTokens as the default max_tokens when the caller omits it', async () => {
    captured.current = null;
    const { OpenAICompatProvider } = await import('../index');
    const provider = new OpenAICompatProvider({
      name: 'mock',
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-4o-mini',
      maxOutputTokens: 2048,
    });
    await drain(provider.complete([], [], {}));
    expect(lastParams()?.max_tokens).toBe(2048);
  });

  it('a per-call maxTokens wins over the maxOutputTokens default', async () => {
    captured.current = null;
    const { OpenAICompatProvider } = await import('../index');
    const provider = new OpenAICompatProvider({
      name: 'mock',
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-4o-mini',
      maxOutputTokens: 2048,
    });
    await drain(provider.complete([], [], { maxTokens: 512 }));
    expect(lastParams()?.max_tokens).toBe(512);
  });

  it('no maxOutputTokens → no max_tokens injected (unchanged)', async () => {
    captured.current = null;
    const { OpenAICompatProvider } = await import('../index');
    const provider = new OpenAICompatProvider({
      name: 'mock',
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-4o-mini',
    });
    await drain(provider.complete([], [], {}));
    expect(lastParams()?.max_tokens).toBeUndefined();
  });

  it('toolCallFormat "text-xml" strips structured tools from the request', async () => {
    captured.current = null;
    const { OpenAICompatProvider } = await import('../index');
    const provider = new OpenAICompatProvider({
      name: 'mock',
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-4o-mini',
      toolCallFormat: 'text-xml',
    });
    await drain(provider.complete([], [TOOL], {}));
    expect(lastParams()?.tools).toBeUndefined();
    // Tool docs are folded into a system message instead.
    expect(lastParams()?.messages.some((m) => m.role === 'system')).toBe(true);
  });

  it('default toolCallFormat "openai" keeps structured tools', async () => {
    captured.current = null;
    const { OpenAICompatProvider } = await import('../index');
    const provider = new OpenAICompatProvider({
      name: 'mock',
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-4o-mini',
    });
    await drain(provider.complete([], [TOOL], {}));
    expect(lastParams()?.tools?.length).toBe(1);
  });
});
