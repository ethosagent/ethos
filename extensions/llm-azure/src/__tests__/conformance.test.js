// Azure provider conformance — mirrors llm-openai-compat/__tests__/conformance.
// AzureOpenAIProvider duplicates the streaming/tool-call logic from
// OpenAICompatProvider but constructs an `AzureOpenAI` client instead of an
// `OpenAI` client. This test pins both the chunk contract (only canonical
// CompletionChunk types) and the Azure-specific constructor wiring
// (apiVersion + endpoint flow into the SDK client).
import { describe, expect, it, vi } from 'vitest';

const CANONICAL_TYPES = new Set([
  'text_delta',
  'thinking_delta',
  'tool_use_start',
  'tool_use_delta',
  'tool_use_end',
  'usage',
  'done',
]);
const fakeChunks = { current: [] };
const lastAzureCtor = {};
vi.mock('openai', () => {
  class MockAzureOpenAI {
    chat = {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            for (const c of fakeChunks.current) yield c;
          },
        }),
      },
    };
    constructor(args) {
      lastAzureCtor.args = args;
    }
  }
  // The shared `openai` module is mocked wholesale, so we must provide
  // BOTH the named `AzureOpenAI` export (used by llm-azure) and the
  // default `OpenAI` export (referenced transitively via the sibling
  // llm-openai-compat package's `toOpenAIMessages` typings).
  return { default: class {}, AzureOpenAI: MockAzureOpenAI };
});
async function collect(provider) {
  const chunks = [];
  for await (const c of provider.complete([], [], {})) chunks.push(c);
  return chunks;
}
describe('AzureOpenAIProvider', () => {
  it('passes endpoint + apiVersion + apiKey to the AzureOpenAI client', async () => {
    const { AzureOpenAIProvider } = await import('../index');
    new AzureOpenAIProvider({
      name: 'azure',
      apiKey: 'k',
      endpoint: 'https://my-resource.openai.azure.com',
      apiVersion: '2024-10-21',
      model: 'gpt-4o-deployment',
    });
    expect(lastAzureCtor.args).toMatchObject({
      apiKey: 'k',
      endpoint: 'https://my-resource.openai.azure.com',
      apiVersion: '2024-10-21',
    });
  });
  it('only yields canonical CompletionChunk types', async () => {
    fakeChunks.current = [
      { choices: [{ delta: { content: 'hello' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'echo' } }],
            },
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    const { AzureOpenAIProvider } = await import('../index');
    const provider = new AzureOpenAIProvider({
      name: 'azure',
      apiKey: 'k',
      endpoint: 'https://my-resource.openai.azure.com',
      apiVersion: '2024-10-21',
      model: 'gpt-4o-deployment',
    });
    const chunks = await collect(provider);
    for (const c of chunks) {
      expect(CANONICAL_TYPES.has(c.type)).toBe(true);
    }
    expect(chunks.find((c) => c.type === 'text_delta')).toBeDefined();
    expect(chunks.find((c) => c.type === 'tool_use_start')).toBeDefined();
    expect(chunks.find((c) => c.type === 'tool_use_delta')).toBeDefined();
    expect(chunks.find((c) => c.type === 'tool_use_end')).toBeDefined();
    expect(chunks.find((c) => c.type === 'usage')).toBeDefined();
    expect(chunks.find((c) => c.type === 'done')).toBeDefined();
  });
  it('countTokens returns a positive integer for non-empty messages', async () => {
    const { AzureOpenAIProvider } = await import('../index');
    const provider = new AzureOpenAIProvider({
      name: 'azure',
      apiKey: 'k',
      endpoint: 'https://my-resource.openai.azure.com',
      apiVersion: '2024-10-21',
      model: 'gpt-4o-deployment',
    });
    const n = await provider.countTokens([{ role: 'user', content: 'hello world from Azure' }]);
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });
});
