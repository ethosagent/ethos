import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  buildConsolidationUpdates,
  type ConsolidationResult,
  consolidateMemory,
} from '../memory-consolidation';

function makeLLM(
  response: string,
  captured: { system?: string; messages?: Message[] } = {},
): LLMProvider {
  return {
    name: 'mock',
    model: 'mock',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete(
      messages: Message[],
      _tools: unknown[],
      options: { system?: string },
    ): AsyncIterable<CompletionChunk> {
      captured.messages = messages;
      captured.system = options.system;
      return (async function* () {
        yield { type: 'text_delta', text: response };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    },
    async countTokens() {
      return 0;
    },
  };
}

describe('consolidateMemory', () => {
  it('parses MEMORY and USER sections into both distilled fields', async () => {
    const response = 'MEMORY:\nProject uses pnpm + vitest.\n\nUSER:\nPrefers terse answers.';
    const llm = makeLLM(response);

    const result = await consolidateMemory(
      { memory: 'old memory', user: 'old user', recentContext: 'today...' },
      llm,
    );

    expect(result.memory).toBe('Project uses pnpm + vitest.');
    expect(result.user).toBe('Prefers terse answers.');
  });

  it('keeps current user content when the USER section is missing', async () => {
    const response = 'MEMORY:\nNew distilled project context.';
    const llm = makeLLM(response);

    const result = await consolidateMemory(
      { memory: 'old memory', user: 'durable user profile', recentContext: 'today...' },
      llm,
    );

    expect(result.memory).toBe('New distilled project context.');
    expect(result.user).toBe('durable user profile');
  });

  it('uses a system prompt with the do-not-invent + personality-scoped instruction', async () => {
    const captured: { system?: string; messages?: Message[] } = {};
    const llm = makeLLM('MEMORY:\nx\n\nUSER:\ny', captured);

    await consolidateMemory({ memory: '', user: '', recentContext: 'ctx' }, llm);

    expect(captured.system).toContain('do not invent');
    expect(captured.system).toContain('Personality-scoped');
  });
});

describe('buildConsolidationUpdates', () => {
  it('emits replace updates only for changed, non-empty keys', () => {
    const current = { memory: 'old memory', user: 'old user' };
    const next: ConsolidationResult = { memory: 'new memory', user: 'old user' };

    const updates = buildConsolidationUpdates(current, next);

    expect(updates).toEqual([{ action: 'replace', key: 'MEMORY.md', content: 'new memory' }]);
  });

  it('is idempotent — identical distillation yields []', () => {
    const current = { memory: 'same memory', user: 'same user' };
    const next: ConsolidationResult = { memory: 'same memory', user: 'same user' };

    expect(buildConsolidationUpdates(current, next)).toEqual([]);
  });

  it('never emits a destructive replace for empty distilled content', () => {
    const current = { memory: 'keep me', user: 'keep me too' };
    const next: ConsolidationResult = { memory: '', user: '   ' };

    expect(buildConsolidationUpdates(current, next)).toEqual([]);
  });
});
