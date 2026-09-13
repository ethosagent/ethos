// `history-older-loaded` — one next-older page of paged history
// (`sessions.messages`) folded in ahead of what the reducer already holds.
//
// A page is whole turns starting at a user row, so it parses on its own; the
// reducer prepends what it does not already have and adds that page's trails
// without overwriting any the live surface has since amended. Nothing about the
// turn in flight moves.

import type { SessionCard, StoredMessage } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  type AssistantTurn,
  applyAction,
  applyEvent,
  type ChatState,
  initialChatState,
} from '../chat-reducer';
import type { TrailAction } from '../trail';

function stored(over: Partial<StoredMessage> & Pick<StoredMessage, 'id' | 'role'>): StoredMessage {
  return {
    sessionId: 's1',
    content: '',
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    timestamp: new Date(0).toISOString(),
    ...over,
  };
}

/** One whole turn: the question, an answer that calls a tool, and its result. */
function turn(n: number): StoredMessage[] {
  const t = n * 10;
  return [
    stored({
      id: `u${n}`,
      role: 'user',
      content: `question ${n}`,
      timestamp: new Date(t).toISOString(),
    }),
    stored({
      id: `a${n}`,
      role: 'assistant',
      content: `answer ${n}`,
      toolCalls: [{ id: `tc${n}`, name: 'read_file', input: { path: `f${n}` } }],
      timestamp: new Date(t + 1).toISOString(),
    }),
    stored({
      id: `r${n}`,
      role: 'tool_result',
      content: `result ${n}`,
      toolCallId: `tc${n}`,
      toolName: 'read_file',
      isError: false,
      timestamp: new Date(t + 2).toISOString(),
    }),
  ];
}

const alert = (message: string): SessionCard['envelope'] => ({
  kind: 'alert',
  specVersion: 1,
  payload: { severity: 'info', message },
});

function loaded(): ChatState {
  return applyAction(initialChatState, {
    type: 'history-loaded',
    messages: [...turn(3), ...turn(4)],
  });
}

const ids = (s: ChatState) => s.messages.map((m) => m.id);

describe('history-older-loaded', () => {
  it('prepends the older page, oldest first, ahead of what is loaded', () => {
    const s = applyAction(loaded(), {
      type: 'history-older-loaded',
      messages: [...turn(1), ...turn(2)],
    });
    expect(ids(s)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
  });

  it('skips rows whose ids are already present', () => {
    const s = applyAction(loaded(), {
      type: 'history-older-loaded',
      messages: [...turn(2), ...turn(3)],
    });
    expect(ids(s)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
  });

  it("adds the page's trails and keeps every trail the state already has", () => {
    const amended: TrailAction = {
      kind: 'action',
      toolCallId: 'tc3',
      toolName: 'read_file',
      args: {},
      status: 'ok',
      durationMs: 42,
    };
    const base: ChatState = { ...loaded(), trail: { ...loaded().trail, a3: [amended] } };

    const s = applyAction(base, {
      type: 'history-older-loaded',
      messages: [...turn(2), ...turn(3)],
    });

    expect(s.trail.a3).toEqual([amended]);
    expect(s.trail.a4).toBe(base.trail.a4);
    const older = s.trail.a2?.[0];
    expect(older?.kind === 'action' ? older.toolCallId : null).toBe('tc2');
  });

  it("places the page's cards inside the page's own turns", () => {
    const s = applyAction(loaded(), {
      type: 'history-older-loaded',
      messages: turn(1),
      cards: [{ toolCallId: 'tc1', seq: 0, envelope: alert('from turn one') }],
    });
    const first = s.messages.find((m): m is AssistantTurn => m.id === 'a1');
    expect(first?.blocks.map((b) => b.kind)).toEqual(['text', 'card']);
    const newest = s.messages.find((m): m is AssistantTurn => m.id === 'a4');
    expect(newest?.blocks.map((b) => b.kind)).toEqual(['text']);
  });

  it('leaves the turn in flight, streaming and phase untouched', () => {
    let live = applyAction(loaded(), {
      type: 'submit-user-message',
      id: 'user-live',
      text: 'still going',
      timestamp: 100,
    });
    live = applyEvent(live, { type: 'text_delta', text: 'partial' }, 101);

    const s = applyAction(live, { type: 'history-older-loaded', messages: turn(1) });

    expect(s.currentTurn).toBe(live.currentTurn);
    expect(s.isStreaming).toBe(live.isStreaming);
    expect(s.phase).toBe(live.phase);
    expect(s.runs).toBe(live.runs);
    expect(s.clarifyQueue).toBe(live.clarifyQueue);
    expect(s.pendingClarifies).toBe(live.pendingClarifies);
    expect(ids(s).slice(0, 2)).toEqual(['u1', 'a1']);
    expect(ids(s).at(-1)).toBe('user-live');
  });

  it('returns the same state when the page adds nothing new', () => {
    const base = loaded();
    const s = applyAction(base, { type: 'history-older-loaded', messages: turn(3) });
    expect(s).toBe(base);
  });
});
