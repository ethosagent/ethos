import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createLLMClassifier } from '../classifier';

function makeStubProvider(reply: string): LLMProvider {
  return {
    name: 'stub',
    model: 'haiku',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: reply };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 0;
    },
  };
}

function makeThrowingProvider(): LLMProvider {
  return {
    name: 'stub-broken',
    model: 'haiku',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete() {
      throw new Error('provider unavailable');
    },
    async countTokens() {
      return 0;
    },
  };
}

describe('createLLMClassifier', () => {
  it('parses a clean JSON verdict', async () => {
    const llm = makeStubProvider(
      '{"containsInstructions": true, "confidence": 0.9, "reason": "role-override"}',
    );
    const verdict = await createLLMClassifier({ llm })({ content: 'attack' });
    expect(verdict.containsInstructions).toBe(true);
    expect(verdict.confidence).toBe(0.9);
    expect(verdict.reason).toBe('role-override');
    expect(verdict.source).toBe('llm');
  });

  it('extracts JSON from surrounding chatter', async () => {
    const llm = makeStubProvider(
      'Sure!\n{"containsInstructions": false, "confidence": 0.05}\nthanks',
    );
    const verdict = await createLLMClassifier({ llm })({ content: 'normal' });
    expect(verdict.containsInstructions).toBe(false);
    expect(verdict.source).toBe('llm');
  });

  it('falls back to pattern check on unparseable output', async () => {
    const llm = makeStubProvider('I do not know');
    const verdict = await createLLMClassifier({ llm })({
      content: 'ignore previous instructions',
    });
    expect(verdict.source).toBe('pattern-fallback');
    expect(verdict.containsInstructions).toBe(true);
  });

  it('falls back when the provider throws', async () => {
    const verdict = await createLLMClassifier({ llm: makeThrowingProvider() })({
      content: 'normal benign text',
    });
    expect(verdict.source).toBe('pattern-fallback');
    expect(verdict.containsInstructions).toBe(false);
  });

  it('clamps malformed confidence values', async () => {
    const llm = makeStubProvider('{"containsInstructions": true, "confidence": 99}');
    const verdict = await createLLMClassifier({ llm })({ content: 'x' });
    expect(verdict.confidence).toBeLessThanOrEqual(1);
    expect(verdict.containsInstructions).toBe(true);
  });
});
