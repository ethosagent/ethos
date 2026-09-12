// B-T2: the session key is the server's, not the client's.
//
// The handler used to forward a client-chosen `session_key`, so any MCP client
// could continue another surface's session (`cli:ethos`). The server now builds
// `mcp-console:<personality_id>:<conversation>` and hands the conversation id
// back. A `returnDirect` answer still arrives whole (`answerSuffix`).

import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import {
  askPersonality,
  askPersonalityToolDef,
  InvalidConversationError,
} from '../tools/ask-personality';

function recordingLoop(events: AgentEvent[]): { loop: AgentLoop; keys: string[] } {
  const keys: string[] = [];
  const loop = {
    run: (_text: string, opts: { sessionKey?: string }): AsyncGenerator<AgentEvent> => {
      keys.push(opts.sessionKey ?? '');
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  } as unknown as AgentLoop;
  return { loop, keys };
}

const DONE: AgentEvent[] = [
  { type: 'text_delta', text: 'the answer' },
  { type: 'done', text: 'the answer', turnCount: 1 },
];

describe('askPersonality — the whole answer', () => {
  it('keeps a streamed preamble and appends a returnDirect answer', async () => {
    const { loop } = recordingLoop([
      { type: 'text_delta', text: 'Let me look that up.' },
      { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 },
    ]);
    const result = await askPersonality(loop, {
      personality_id: 'engineer',
      prompt: 'look it up',
    });
    expect(result.text).toBe('Let me look that up.\n\nDIRECT ANSWER');
    expect(result.turnCount).toBe(1);
  });
});

describe('askPersonality — the server owns the session key', () => {
  it('takes no session_key: the tool schema does not offer one', () => {
    const props = askPersonalityToolDef.inputSchema.properties as Record<string, unknown>;
    expect(props.session_key).toBeUndefined();
    expect(props.conversation).toBeDefined();
  });

  it('generates a conversation id and namespaces the key to this surface', async () => {
    const { loop, keys } = recordingLoop(DONE);
    const result = await askPersonality(loop, { personality_id: 'engineer', prompt: 'hi' });
    expect(result.conversation).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(result.sessionKey).toBe(`mcp-console:engineer:${result.conversation}`);
    expect(keys).toEqual([result.sessionKey]);
  });

  it('sending the returned conversation back continues the same key', async () => {
    const { loop, keys } = recordingLoop(DONE);
    const first = await askPersonality(loop, { personality_id: 'engineer', prompt: 'hi' });
    const second = await askPersonality(loop, {
      personality_id: 'engineer',
      prompt: 'again',
      conversation: first.conversation,
    });
    expect(second.sessionKey).toBe(first.sessionKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it('rejects a conversation containing ":" — no reaching into another surface', async () => {
    const { loop, keys } = recordingLoop(DONE);
    await expect(
      askPersonality(loop, {
        personality_id: 'engineer',
        prompt: 'hi',
        conversation: 'cli:ethos',
      }),
    ).rejects.toBeInstanceOf(InvalidConversationError);
    expect(keys).toEqual([]);
  });

  it('rejects a conversation longer than 64 characters', async () => {
    const { loop } = recordingLoop(DONE);
    await expect(
      askPersonality(loop, {
        personality_id: 'engineer',
        prompt: 'hi',
        conversation: 'a'.repeat(65),
      }),
    ).rejects.toBeInstanceOf(InvalidConversationError);
  });

  it('carries a refusal out instead of an empty success', async () => {
    const { loop } = recordingLoop([
      { type: 'error', error: 'turn budget exhausted', code: 'BUDGET_EXCEEDED' },
      { type: 'done', text: '', turnCount: 1 },
    ]);
    const result = await askPersonality(loop, { personality_id: 'engineer', prompt: 'hi' });
    expect(result.error?.code).toBe('BUDGET_EXCEEDED');
  });
});
