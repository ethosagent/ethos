import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { draftExpressionUpdate } from '../expression-draft';

const RESPONSE =
  'I write terse, code-first replies that lead with the answer.\nRATIONALE: evidence showed users want answers first.';

function makeLLM(captured: { system?: string; messages?: Message[] }): LLMProvider {
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
        yield { type: 'text_delta', text: RESPONSE };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    },
    async countTokens() {
      return 0;
    },
  };
}

describe('draftExpressionUpdate', () => {
  it('asserts Core is immutable, includes inputs, and parses the rationale', async () => {
    const captured: { system?: string; messages?: Message[] } = {};
    const llm = makeLLM(captured);

    const draft = await draftExpressionUpdate(
      {
        core: 'I am the engineer.',
        currentExpression: 'old expression',
        evidence: 'recent turns...',
      },
      llm,
    );

    expect(captured.system).toContain('Core has NOT changed');

    const userMessage = captured.messages?.[0]?.content;
    expect(typeof userMessage).toBe('string');
    const userText = String(userMessage);
    expect(userText).toContain('I am the engineer.');
    expect(userText).toContain('old expression');
    expect(userText).toContain('recent turns...');

    expect(draft.newExpression).toBe(
      'I write terse, code-first replies that lead with the answer.',
    );
    expect(draft.rationale).toBe('evidence showed users want answers first.');
  });
});
