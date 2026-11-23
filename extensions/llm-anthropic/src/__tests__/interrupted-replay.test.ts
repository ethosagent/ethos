import type { Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { toAnthropicMessages } from '../index';

// Shape only: the interrupted-replay history (durable-background-jobs §9) has
// two consecutive user messages. Provider acceptance is checked in the live smoke.
describe('toAnthropicMessages — interrupted replay', () => {
  it('keeps two consecutive user messages with the tool_result block first', () => {
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
    const out = toAnthropicMessages(messages);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    const resultMsg = out[2];
    const blocks = Array.isArray(resultMsg?.content) ? resultMsg.content : [];
    expect(blocks[0]?.type).toBe('tool_result');
    expect(out[3]?.content).toBe('continue');
  });
});
