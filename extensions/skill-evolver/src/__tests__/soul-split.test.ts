import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { draftSoulSplit } from '../soul-split';

const RESPONSE =
  'CORE:\nI am the engineer. I value correctness.\n\nEXPRESSION:\nI write terse, code-first replies.\n\nRATIONALE: split identity from voice.';

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

describe('draftSoulSplit', () => {
  it('embeds the soul prose, sets a guarded system prompt, and parses the partition', async () => {
    const captured: { system?: string; messages?: Message[] } = {};
    const llm = makeLLM(captured);

    const soul = 'I am SENTINEL-MARKER, the systems engineer who values correctness above all.';
    const proposal = await draftSoulSplit(soul, llm);

    expect(captured.system?.toLowerCase()).toContain('do not invent');
    expect(captured.system).toContain('Core');
    expect(captured.system).toContain('unsure');

    expect(proposal.core).toBe('I am the engineer. I value correctness.');
    expect(proposal.expression).toBe('I write terse, code-first replies.');
    expect(proposal.rationale).toBe('split identity from voice.');

    expect(String(captured.messages?.[0]?.content)).toContain('SENTINEL-MARKER');
  });
});
