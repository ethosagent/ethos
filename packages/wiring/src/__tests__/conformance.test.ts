import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { runConformance, validateToolCallBuffering } from '../conformance/index';

function createMockProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    name: 'test-provider',
    model: 'test-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    capabilities: {
      streaming: true,
      toolCalling: true,
      contractVersion: 1,
    },
    async *complete(
      _messages: Message[],
      _tools: ToolDefinitionLite[],
      _options: CompletionOptions,
    ) {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'end_turn' as const };
    },
    async countTokens() {
      return 0;
    },
    ...overrides,
  };
}

describe('conformance harness', () => {
  it('passes for a well-formed provider', async () => {
    const result = await runConformance(createMockProvider());
    expect(result.passed).toBe(true);
    for (const check of result.checks) {
      expect(check.passed).toBe(true);
    }
  });

  it('fails when required fields are missing', async () => {
    const result = await runConformance(createMockProvider({ name: '' }));
    const check = result.checks.find((c) => c.name === 'required-fields');
    expect(check?.passed).toBe(false);
    expect(check?.message).toContain('name');
  });

  it('fails when capabilities not declared', async () => {
    const provider = createMockProvider();
    // Remove capabilities
    Object.defineProperty(provider, 'capabilities', { value: undefined });
    const result = await runConformance(provider);
    const check = result.checks.find((c) => c.name === 'capabilities-declared');
    expect(check?.passed).toBe(false);
  });

  it('detects capability/boolean mismatch', async () => {
    const provider = createMockProvider({
      supportsCaching: true,
      capabilities: {
        streaming: true,
        toolCalling: true,
        promptCaching: false, // mismatch with supportsCaching: true
        contractVersion: 1,
      },
    });
    const result = await runConformance(provider);
    const check = result.checks.find((c) => c.name === 'capabilities-consistency');
    expect(check?.passed).toBe(false);
    expect(check?.message).toContain('promptCaching');
  });
});

describe('validateToolCallBuffering', () => {
  it('passes for valid tool call sequence', () => {
    const chunks: CompletionChunk[] = [
      { type: 'tool_use_start', toolCallId: 'tc1', toolName: 'test' },
      { type: 'tool_use_delta', toolCallId: 'tc1', partialJson: '{"a":' },
      { type: 'tool_use_delta', toolCallId: 'tc1', partialJson: '"b"}' },
      { type: 'tool_use_end', toolCallId: 'tc1', inputJson: '{"a":"b"}' },
      { type: 'done', finishReason: 'tool_use' },
    ];
    const result = validateToolCallBuffering(chunks);
    expect(result.passed).toBe(true);
  });

  it('fails for unmatched tool_use_start', () => {
    const chunks: CompletionChunk[] = [
      { type: 'tool_use_start', toolCallId: 'tc1', toolName: 'test' },
      { type: 'done', finishReason: 'end_turn' },
    ];
    const result = validateToolCallBuffering(chunks);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('without matching tool_use_end');
  });

  it('fails for orphan tool_use_delta', () => {
    const chunks: CompletionChunk[] = [
      { type: 'tool_use_delta', toolCallId: 'tc-unknown', partialJson: '{}' },
    ];
    const result = validateToolCallBuffering(chunks);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('unknown toolCallId');
  });

  it('passes for multiple parallel tool calls', () => {
    const chunks: CompletionChunk[] = [
      { type: 'tool_use_start', toolCallId: 'tc1', toolName: 'a' },
      { type: 'tool_use_start', toolCallId: 'tc2', toolName: 'b' },
      { type: 'tool_use_delta', toolCallId: 'tc1', partialJson: '{}' },
      { type: 'tool_use_delta', toolCallId: 'tc2', partialJson: '{}' },
      { type: 'tool_use_end', toolCallId: 'tc1', inputJson: '{}' },
      { type: 'tool_use_end', toolCallId: 'tc2', inputJson: '{}' },
      { type: 'done', finishReason: 'tool_use' },
    ];
    const result = validateToolCallBuffering(chunks);
    expect(result.passed).toBe(true);
  });
});
