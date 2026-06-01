import type { Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { toResponsesInput, toResponsesTools } from '../responses-adapter';

describe('toResponsesInput', () => {
  it('converts a simple string message', () => {
    const messages: Message[] = [{ role: 'user', content: 'hello' }];
    const result = toResponsesInput(messages);
    expect(result).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('converts tool_use blocks to function_call items', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me help.' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: '/foo' } },
        ],
      },
    ];
    const result = toResponsesInput(messages);
    expect(result).toEqual([
      { role: 'assistant', content: 'Let me help.' },
      {
        type: 'function_call',
        id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"/foo"}',
      },
    ]);
  });

  it('converts tool_result blocks to function_call_output items', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents here' }],
      },
    ];
    const result = toResponsesInput(messages);
    expect(result).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: 'file contents here' },
    ]);
  });

  it('handles mixed text and tool blocks in a single message', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is the result:' },
          { type: 'tool_result', tool_use_id: 'call_1', content: 'done' },
          { type: 'text', text: 'And more context.' },
        ],
      },
    ];
    const result = toResponsesInput(messages);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'user', content: 'Here is the result:' });
    expect(result[1]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'done' });
    expect(result[2]).toEqual({ role: 'user', content: 'And more context.' });
  });
});

describe('toResponsesTools', () => {
  it('converts tool definitions to Responses API format', () => {
    const tools = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];
    const result = toResponsesTools(tools);
    expect(result).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
  });
});
