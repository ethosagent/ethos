// V-CP-5 / UBP-038 — the vision fallback's OpenAI branch talks to
// api.openai.com (the SDK's default base URL), where `max_completion_tokens`
// is the output cap for every model and OpenAI's reasoning families (gpt-5.x,
// o-series) refuse `max_tokens` with a 400. Same rule as `outputCapParam`
// (extensions/llm-openai-compat/src/transport.ts) for a first-party endpoint.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: Array<Record<string, unknown>> = [];

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          created.push(params);
          return { choices: [{ message: { content: '{"x":10,"y":20}' } }] };
        },
      },
    };
  },
}));

import { resolveByVision } from '../vision-resolver';

describe('resolveByVision — OpenAI output cap (V-CP-5)', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it.each(['gpt-5.6-sol', 'o4-mini', 'gpt-4o', undefined])(
    'sends max_completion_tokens, never max_tokens (model %s)',
    async (model) => {
      const out = await resolveByVision('aGVsbG8=', 'the Submit button', undefined, {
        apiKey: 'k',
        provider: 'openai',
        ...(model ? { model } : {}),
      });
      expect(out).toMatchObject({ x: 10, y: 20 });
      expect(created).toHaveLength(1);
      expect(created[0]).toHaveProperty('max_completion_tokens', 64);
      expect(created[0]).not.toHaveProperty('max_tokens');
    },
  );
});
