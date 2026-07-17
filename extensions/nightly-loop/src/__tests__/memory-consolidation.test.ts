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

  it('parses `### slug` sections + a SCORES block into scored sections', async () => {
    const response = [
      'MEMORY:',
      '### project-ethos',
      'Working on Ethos memory system.',
      '',
      '### daughter-priya',
      'Daughter: Priya (b. 2019)',
      '',
      'USER:',
      '### identity',
      'Name: Mitesh',
      '',
      'SCORES:',
      'project-ethos: 0.6',
      'daughter-priya: 0.9',
      'identity: 1.0',
    ].join('\n');

    const result = await consolidateMemory(
      { memory: '', user: '', recentContext: 'x' },
      makeLLM(response),
    );

    expect(result.scored).toBe(true);
    expect(result.memorySections).toEqual([
      { slug: 'project-ethos', content: 'Working on Ethos memory system.', score: 0.6 },
      { slug: 'daughter-priya', content: 'Daughter: Priya (b. 2019)', score: 0.9 },
    ]);
    expect(result.userSections).toEqual([
      { slug: 'identity', content: 'Name: Mitesh', score: 1.0 },
    ]);
    // USER body must not bleed into the trailing SCORES block.
    expect(result.user).toBe('### identity\nName: Mitesh');
  });

  it('degrades to scored=false when no SCORES block is present', async () => {
    const response = 'MEMORY:\n### a\nbody\n\nUSER:\n### b\nother';
    const result = await consolidateMemory(
      { memory: '', user: '', recentContext: 'x' },
      makeLLM(response),
    );
    expect(result.scored).toBe(false);
  });

  it('degrades to scored=false on a garbage response and preserves current content', async () => {
    const result = await consolidateMemory(
      { memory: 'keep memory', user: 'keep user', recentContext: 'x' },
      makeLLM('total nonsense with no labels'),
    );
    expect(result.scored).toBe(false);
    expect(result.memory).toBe('keep memory');
    expect(result.user).toBe('keep user');
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
