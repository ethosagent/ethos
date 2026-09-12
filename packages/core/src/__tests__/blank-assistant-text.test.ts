// The Anthropic Messages API rejects a text content block that holds only
// whitespace ("text content blocks must contain non-whitespace text"). A model
// that emits "\n\n" before its tool call used to have that preamble sent back
// as its own text block — in the same turn's next request, and again on every
// later turn's replay of history. Non-blank text is never altered.

import type { AgentEvent, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { type CapturedCall, makeScriptedLLM, makeTool } from './golden/scripted-llm';
import { createTestSafety } from './helpers/test-safety';

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _ of gen) {
  }
}

/** Turn 1: `preamble` + a `side` tool call, then a reply. Turn 2: one reply. */
async function run(preamble: string): Promise<CapturedCall[]> {
  const captured: CapturedCall[] = [];
  const tools = new DefaultToolRegistry();
  tools.register(makeTool('side', 'side-value'));
  const loop = new AgentLoop({
    llm: makeScriptedLLM(
      [
        {
          text: preamble,
          toolCalls: [{ id: 'tc1', name: 'side', input: {} }],
          finishReason: 'tool_use',
        },
        { text: 'first reply', finishReason: 'end_turn' },
        { text: 'second reply', finishReason: 'end_turn' },
      ],
      captured,
    ),
    tools,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
  });
  await drain(loop.run('first', { sessionKey: 'cli:blank' }));
  await drain(loop.run('second', { sessionKey: 'cli:blank' }));
  return captured;
}

/** The assistant message carrying the tool_use, as a request sent it. */
function toolUseMessage(messages: Message[] | undefined): Message | undefined {
  return messages?.find(
    (m) =>
      m.role === 'assistant' &&
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === 'tool_use'),
  );
}

describe('whitespace-only assistant text is never sent as a text block', () => {
  it('a blank preamble before a tool call: dropped in-turn and on replay', async () => {
    const captured = await run('\n\n  ');

    const expected: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tc1', name: 'side', input: {} }],
    };
    // Same turn, the request after the tool ran.
    expect(toolUseMessage(captured[1]?.messages)).toEqual(expected);
    // Next turn, rebuilt from the session store.
    expect(toolUseMessage(captured[2]?.messages)).toEqual(expected);
  });

  it('a non-blank preamble is kept exactly, whitespace and all', async () => {
    const captured = await run('  Let me check.\n');

    const expected: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: '  Let me check.\n' },
        { type: 'tool_use', id: 'tc1', name: 'side', input: {} },
      ],
    };
    expect(toolUseMessage(captured[1]?.messages)).toEqual(expected);
    expect(toolUseMessage(captured[2]?.messages)).toEqual(expected);
  });
});
