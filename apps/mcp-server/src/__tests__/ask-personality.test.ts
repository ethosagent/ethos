// A `returnDirect` tool's answer reaches a turn only as `done.text`, after any
// preamble the model streamed before calling the tool. `text = ev.text || text`
// replaced the streamed preamble with the answer; the MCP caller gets both now
// (`answerSuffix`, @ethosagent/types).

import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { askPersonality } from '../tools/ask-personality';

function loopOf(events: AgentEvent[]): AgentLoop {
  return {
    run: async function* (): AsyncGenerator<AgentEvent> {
      for (const e of events) yield e;
    },
  } as unknown as AgentLoop;
}

describe('askPersonality — the whole answer', () => {
  it('keeps a streamed preamble and appends a returnDirect answer', async () => {
    const result = await askPersonality(
      loopOf([
        { type: 'text_delta', text: 'Let me look that up.' },
        { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 },
      ]),
      { personality_id: 'engineer', prompt: 'look it up' },
    );
    expect(result.text).toBe('Let me look that up.\n\nDIRECT ANSWER');
    expect(result.turnCount).toBe(1);
  });

  it('a normal turn is unchanged, and a bare returnDirect answer still arrives', async () => {
    expect(
      (
        await askPersonality(
          loopOf([
            { type: 'text_delta', text: 'the answer' },
            { type: 'done', text: 'the answer', turnCount: 1 },
          ]),
          { personality_id: 'engineer', prompt: 'hi' },
        )
      ).text,
    ).toBe('the answer');
    expect(
      (
        await askPersonality(loopOf([{ type: 'done', text: 'DIRECT ANSWER', turnCount: 1 }]), {
          personality_id: 'engineer',
          prompt: 'hi',
        })
      ).text,
    ).toBe('DIRECT ANSWER');
  });
});
