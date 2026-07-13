// §3 — llmJudgeScorer requests grammar-constrained JSON only when the provider
// declares capabilities.structuredOutput; otherwise it keeps the original
// "reply 1 or 0" prompt + parse, byte-identical to before.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { llmJudgeScorer } from '../scorers';

interface Captured {
  options: CompletionOptions | null;
  messages: Message[] | null;
}

function makeProvider(
  reply: string,
  opts: { structuredOutput?: boolean; captured?: Captured },
): LLMProvider {
  return {
    name: 'mock',
    model: 'mock',
    maxContextTokens: 8_192,
    supportsCaching: false,
    supportsThinking: false,
    capabilities: opts.structuredOutput
      ? { streaming: true, toolCalling: true, structuredOutput: true }
      : { streaming: true, toolCalling: true },
    async *complete(
      messages: Message[],
      _tools: ToolDefinitionLite[],
      options: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      if (opts.captured) {
        opts.captured.options = options;
        opts.captured.messages = messages;
      }
      yield { type: 'text_delta', text: reply };
    },
    async countTokens() {
      return 0;
    },
  };
}

const EXPECTED = { id: 't', expected: 'the answer is 42', match: 'llm' as const };

describe('llmJudgeScorer — capability gating (§3)', () => {
  it('capable model → attaches the response-format providerOptions and parses JSON', async () => {
    const captured: Captured = { options: null, messages: null };
    const provider = makeProvider('{"meets": true}', { structuredOutput: true, captured });
    const score = await llmJudgeScorer(provider)('42', EXPECTED);

    expect(score).toBe(1);
    const rf = captured.options?.providerOptions?.['openai-compat']?.responseFormat as
      | Record<string, unknown>
      | undefined;
    expect(rf?.name).toBe('judge_verdict');
    expect(rf?.schema).toBeDefined();
  });

  it('capable model returning meets:false → score 0', async () => {
    const provider = makeProvider('{"meets": false}', { structuredOutput: true });
    expect(await llmJudgeScorer(provider)('nope', EXPECTED)).toBe(0);
  });

  it('capable model returning prose → falls back to the textual parse', async () => {
    const provider = makeProvider('1', { structuredOutput: true });
    expect(await llmJudgeScorer(provider)('42', EXPECTED)).toBe(1);
  });

  it('non-capable model → no providerOptions, original prompt + parse (unchanged)', async () => {
    const captured: Captured = { options: null, messages: null };
    const provider = makeProvider('1', { captured });
    const score = await llmJudgeScorer(provider)('42', EXPECTED);

    expect(score).toBe(1);
    expect(captured.options?.providerOptions).toBeUndefined();
    expect(captured.options?.maxTokens).toBe(5);
    const content = captured.messages?.[0]?.content;
    expect(typeof content === 'string' && content.includes('"1" (yes) or "0" (no)')).toBe(true);
  });
});
