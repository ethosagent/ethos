// F07 (plan/phases/architecture-suggestions-2026-09-10.md) — a spoken reply is
// not a finished turn.
//
// `AgentLoop.run()` yields `done` BEFORE its turn-end work
// (`maybeConsolidateAtTurnEnd`: the context engine's `onTurnComplete`, the
// memory flush, auto-compaction). The session used to speak the reply's final
// fragment — the text after the last sentence boundary — only once the
// iterator ended, i.e. behind that work, and stayed `speaking` through it. Now
// the fragment is spoken at the terminal event, the reply completes when its
// audio has played, and the iterator is drained behind it; the NEXT turn's
// agent run waits for that drain.

import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentTurnRunner, VoiceSessionEvent } from '../types';
import { VoiceSession } from '../voice-session';
import {
  FakeVad,
  feed,
  makeClock,
  silenceFrame,
  speechFrame,
  streamingStt,
  streamingTts,
  tick,
  waitForEvent,
} from './fakes';

function speakUtterance(session: VoiceSession, clock: { advance: (ms: number) => void }): void {
  feed(session, clock, speechFrame(), 5);
  feed(session, clock, silenceFrame(), 30);
}

/** Each run answers, yields `terminal`, then parks in a tail until released. */
function tailedRunner(terminal: AgentEvent) {
  const state = { runs: 0, tailsRan: 0 };
  const gates: Array<() => void> = [];
  const runner: AgentTurnRunner = {
    async *run(): AsyncGenerator<AgentEvent> {
      state.runs++;
      // "How are you today?" follows the last boundary: the chunker holds it
      // until it is flushed.
      yield { type: 'text_delta', text: `Reply ${state.runs}. How are you today?` };
      yield terminal;
      await new Promise<void>((resolve) => gates.push(resolve));
      state.tailsRan++;
    },
  };
  return {
    runner,
    state,
    parked: () => gates.length,
    release: () => {
      while (gates.length) gates.shift()?.();
    },
  };
}

function setup(terminal: AgentEvent) {
  const clock = makeClock();
  const t = tailedRunner(terminal);
  const session = new VoiceSession({
    runner: t.runner,
    stt: streamingStt('hello'),
    tts: streamingTts(),
    vad: new FakeVad(),
    now: clock.now,
  });
  const events: VoiceSessionEvent[] = [];
  session.on((e) => events.push(e));
  const sentences = () => events.flatMap((e) => (e.type === 'reply_sentence' ? [e.text] : []));
  return { clock, t, session, events, sentences };
}

const DONE: AgentEvent = { type: 'done', text: '', turnCount: 1 };

describe('VoiceSession — the turn-end tail (F07)', () => {
  it('speaks the final fragment and completes the reply while the tail is still parked', async () => {
    const s = setup(DONE);

    speakUtterance(s.session, s.clock);
    await waitForEvent(s.events, 'reply_complete');

    expect(s.sentences()).toEqual(['Reply 1.', 'How are you today?']);
    expect(s.events.find((e) => e.type === 'reply_complete')).toMatchObject({
      text: 'Reply 1. How are you today?',
    });
    expect(s.session.getState()).toBe('listening');
    // …and the tail was not closed: it is parked, and runs once released.
    expect(s.t.parked()).toBe(1);
    s.t.release();
    await s.session.idle();
    expect(s.t.state.tailsRan).toBe(1);
  });

  // A returnDirect tool result reaches the turn only as `done.text`.
  it('speaks `done.text` when no text streamed — a returnDirect tool result', async () => {
    const clock = makeClock();
    const runner: AgentTurnRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'done', text: 'Direct answer. It is ready', turnCount: 1 };
      },
    };
    const session = new VoiceSession({
      runner,
      stt: streamingStt('hello'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
    });
    const events: VoiceSessionEvent[] = [];
    session.on((e) => events.push(e));

    speakUtterance(session, clock);
    await waitForEvent(events, 'reply_complete');

    expect(events.find((e) => e.type === 'reply_complete')).toMatchObject({
      text: 'Direct answer. It is ready',
    });
  });

  it('speaks a returnDirect answer after a streamed preamble', async () => {
    const clock = makeClock();
    const runner: AgentTurnRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'Let me look that up.' };
        yield { type: 'done', text: 'Direct answer. It is ready', turnCount: 1 };
      },
    };
    const session = new VoiceSession({
      runner,
      stt: streamingStt('hello'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
    });
    const events: VoiceSessionEvent[] = [];
    session.on((e) => events.push(e));

    speakUtterance(session, clock);
    await waitForEvent(events, 'reply_complete');

    expect(events.find((e) => e.type === 'reply_complete')).toMatchObject({
      text: 'Let me look that up. Direct answer. It is ready',
    });
  });

  it('does the same at an `error` — the fragment before it is still spoken', async () => {
    const s = setup({ type: 'error', error: 'provider exploded', code: 'llm_error' });

    speakUtterance(s.session, s.clock);
    await waitForEvent(s.events, 'reply_complete');

    expect(s.sentences()).toEqual(['Reply 1.', 'How are you today?']);
    s.t.release();
    await s.session.idle();
    expect(s.t.state.tailsRan).toBe(1);
  });

  it('starts the next turn’s agent run only after the previous tail has drained', async () => {
    const s = setup(DONE);

    speakUtterance(s.session, s.clock);
    await waitForEvent(s.events, 'reply_complete');

    // The user speaks again while the first turn's tail is still parked. The
    // reply had finished, so this is a new utterance — not a barge-in.
    speakUtterance(s.session, s.clock);
    await waitForEvent(s.events, 'utterance_committed');
    for (let i = 0; i < 10; i++) await tick();
    expect(s.events.filter((e) => e.type === 'utterance_committed')).toHaveLength(2);
    expect(s.events.some((e) => e.type === 'interrupted')).toBe(false);
    expect(s.t.state.runs).toBe(1);

    s.t.release();
    while (s.events.filter((e) => e.type === 'reply_complete').length < 2) await tick();
    expect(s.t.state.runs).toBe(2);
    expect(s.t.state.tailsRan).toBe(1);

    s.t.release();
    await s.session.idle();
    expect(s.t.state.tailsRan).toBe(2);
  });
});
