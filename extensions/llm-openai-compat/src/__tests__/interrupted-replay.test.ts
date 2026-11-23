import type { Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { toOpenAIMessages } from '../index';

// Shape only: the interrupted-replay history (durable-background-jobs §9) must
// map to assistant(tool_calls) -> tool -> user. Provider acceptance is checked
// in the live smoke.
describe('toOpenAIMessages — interrupted replay', () => {
  it('maps the interrupted result to a tool message, then the prompt as a user message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tcA', name: 'read_file', input: { path: '/a' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tcA', content: '[interrupted]', is_error: true },
        ],
      },
      { role: 'user', content: 'continue' },
    ];
    const out = toOpenAIMessages(messages);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    const assistant = out[1];
    expect(assistant?.role === 'assistant' ? assistant.tool_calls?.length : 0).toBe(1);
  });
});
