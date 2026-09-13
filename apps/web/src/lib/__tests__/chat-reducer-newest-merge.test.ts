// `history-newest-merged` — the newest page of history fetched again because
// the session grew outside this tab's stream (a `cron.fired` turn).
//
// When the page starts inside what is loaded, everything from that row to the
// end is replaced by the page and every older loaded page is kept. When it
// does not (more than a page of new history arrived), the page replaces the
// whole history. Either way the turn in flight is left alone.

import type { StoredMessage } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  applyEvent,
  type ChatState,
  initialChatState,
  newestPageIsContiguous,
} from '../chat-reducer';

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
function turn(n: number, answer = `answer ${n}`): StoredMessage[] {
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
      content: answer,
      toolCalls: [{ id: `tc${n}`, name: 'read_file', input: {} }],
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

/** Turns 1-2 paged in ahead of the newest page, turns 3-4. */
function loaded(): ChatState {
  const newest = applyAction(initialChatState, {
    type: 'history-loaded',
    messages: [...turn(3), ...turn(4)],
  });
  return applyAction(newest, { type: 'history-older-loaded', messages: [...turn(1), ...turn(2)] });
}

const ids = (s: ChatState) => s.messages.map((m) => m.id);

describe('history-newest-merged', () => {
  it('replaces from the page’s first row to the end and keeps the older loaded pages', () => {
    const base = loaded();
    const s = applyAction(base, {
      type: 'history-newest-merged',
      messages: [...turn(4, 'answer 4, revised'), ...turn(5)],
    });

    expect(ids(s)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
    // Older rows and their trails are the very same objects.
    expect(s.messages.slice(0, 6)).toEqual(base.messages.slice(0, 6));
    expect(s.messages[0]).toBe(base.messages[0]);
    expect(s.trail.a1).toBe(base.trail.a1);
    // The replaced range comes from the page.
    const a4 = s.messages[7];
    expect(a4?.role === 'assistant' ? a4.blocks : null).toEqual([
      { kind: 'text', content: 'answer 4, revised' },
    ]);
    expect(s.trail.a5).toHaveLength(1);
  });

  it('drops locally finalised rows the page now carries under their persisted ids', () => {
    let s = loaded();
    s = applyAction(s, {
      type: 'submit-user-message',
      id: 'user-local',
      text: 'hi',
      timestamp: 90,
    });
    s = applyEvent(s, { type: 'text_delta', text: 'hello' }, 91);
    s = applyEvent(s, { type: 'done', text: 'hello', turnCount: 1 }, 92);
    const localTurnId = s.messages.at(-1)?.id ?? '';
    expect(ids(s)).toContain('user-local');

    s = applyAction(s, { type: 'history-newest-merged', messages: [...turn(4), ...turn(5)] });

    expect(ids(s)).not.toContain('user-local');
    expect(ids(s)).not.toContain(localTurnId);
    expect(ids(s).slice(-4)).toEqual(['u4', 'a4', 'u5', 'a5']);
  });

  it('replaces everything when the page does not start inside what is loaded', () => {
    const s = applyAction(loaded(), {
      type: 'history-newest-merged',
      messages: [...turn(7), ...turn(8)],
    });
    expect(ids(s)).toEqual(['u7', 'a7', 'u8', 'a8']);
    expect(Object.keys(s.trail).sort()).toEqual(['a7', 'a8']);
  });

  it('leaves the turn in flight, its trail, streaming, phase, runs and clarify state untouched', () => {
    let live = applyAction(loaded(), {
      type: 'submit-user-message',
      id: 'user-live',
      text: 'still going',
      timestamp: 100,
    });
    live = applyEvent(
      live,
      { type: 'tool_start', toolCallId: 'tc-live', toolName: 'web_search', args: {} },
      101,
    );
    const liveTurnId = live.currentTurn?.id ?? '';
    expect(live.trail[liveTurnId]).toHaveLength(1);

    for (const page of [
      [...turn(4), ...turn(5)],
      [...turn(7), ...turn(8)],
    ]) {
      const s = applyAction(live, { type: 'history-newest-merged', messages: page });
      expect(s.currentTurn).toBe(live.currentTurn);
      expect(s.trail[liveTurnId]).toBe(live.trail[liveTurnId]);
      expect(s.isStreaming).toBe(live.isStreaming);
      expect(s.phase).toBe(live.phase);
      expect(s.abortedTurn).toBe(live.abortedTurn);
      expect(s.runs).toBe(live.runs);
      expect(s.clarifyQueue).toBe(live.clarifyQueue);
      expect(s.pendingClarifies).toBe(live.pendingClarifies);
      expect(s.pendingApprovals).toBe(live.pendingApprovals);
    }
  });

  it('an empty page changes nothing', () => {
    const base = loaded();
    expect(applyAction(base, { type: 'history-newest-merged', messages: [] })).toBe(base);
  });
});

describe('newestPageIsContiguous', () => {
  it('says whether the page starts inside the loaded history', () => {
    const { messages } = loaded();
    expect(newestPageIsContiguous(messages, [...turn(4), ...turn(5)])).toBe(true);
    expect(newestPageIsContiguous(messages, [...turn(7), ...turn(8)])).toBe(false);
    expect(newestPageIsContiguous(messages, [])).toBeNull();
  });
});
