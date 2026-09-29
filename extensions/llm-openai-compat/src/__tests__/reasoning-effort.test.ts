// Presence §4 — `CompletionOptions.effort` reaches Chat Completions as
// `reasoning_effort` (openai SDK `ChatCompletionCreateParamsBase.reasoning_effort`)
// only for an OpenAI reasoning-family model on api.openai.com. Everywhere else
// the field is ignored and the body is unchanged.

import type { CompletionOptions } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildChatCompletionsParams } from '../transport';

const hi = [{ role: 'user' as const, content: 'hi' }];

function body(
  model: string,
  options: CompletionOptions,
  opts?: Parameters<typeof buildChatCompletionsParams>[4],
): string {
  return JSON.stringify(buildChatCompletionsParams(hi, [], options, model, opts).oaiParams);
}

describe('reasoning_effort (openai-compat)', () => {
  it('sends the effort to an OpenAI reasoning model on api.openai.com', () => {
    const sent = JSON.parse(body('gpt-5.6-sol', { effort: 'high' }, { openAiFirstParty: true }));
    expect(sent.reasoning_effort).toBe('high');
    const low = JSON.parse(body('o3', { effort: 'low' }, { openAiFirstParty: true }));
    expect(low.reasoning_effort).toBe('low');
  });

  it("maps 'off' to 'low', the lowest effort every OpenAI reasoning model accepts", () => {
    const sent = JSON.parse(body('o4-mini', { effort: 'off' }, { openAiFirstParty: true }));
    expect(sent.reasoning_effort).toBe('low');
  });

  it('ignores effort for a non-reasoning model, another host, or a local runtime', () => {
    expect(body('gpt-4o-mini', { effort: 'high' }, { openAiFirstParty: true })).toBe(
      body('gpt-4o-mini', {}, { openAiFirstParty: true }),
    );
    expect(body('openai/gpt-5.6-sol', { effort: 'high' })).toBe(body('openai/gpt-5.6-sol', {}));
    expect(body('gpt-5.6-sol', { effort: 'high' })).toBe(body('gpt-5.6-sol', {}));
    expect(body('qwen3:8b', { effort: 'high' }, { localRuntime: 'ollama' })).toBe(
      body('qwen3:8b', {}, { localRuntime: 'ollama' }),
    );
  });

  it('sends nothing to reasoning-family ids known to refuse reasoning_effort', () => {
    for (const id of [
      'gpt-5-chat-latest',
      'gpt-5-chat',
      'o1-mini',
      'o1-mini-2024-09-12',
      'o1-preview',
      'o1-preview-2024-09-12',
    ]) {
      expect(body(id, { effort: 'high' }, { openAiFirstParty: true }), id).toBe(
        body(id, {}, { openAiFirstParty: true }),
      );
    }
  });

  it("gpt-5-pro accepts only 'high', whatever the effort", () => {
    for (const effort of ['off', 'low', 'medium', 'high'] as const) {
      const sent = JSON.parse(body('gpt-5-pro', { effort }, { openAiFirstParty: true }));
      expect(sent.reasoning_effort, effort).toBe('high');
    }
    const dated = JSON.parse(
      body('gpt-5-pro-2025-10-06', { effort: 'low' }, { openAiFirstParty: true }),
    );
    expect(dated.reasoning_effort).toBe('high');
  });

  it('with no effort the body carries no reasoning_effort', () => {
    expect(body('gpt-5.6-sol', {}, { openAiFirstParty: true })).not.toContain('reasoning_effort');
  });
});
