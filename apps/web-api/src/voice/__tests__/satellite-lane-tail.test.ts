// F07 (plan/phases/architecture-suggestions-2026-09-10.md) — a spoken reply is
// not a finished turn.
//
// `AgentLoop.run()` yields `done` BEFORE its turn-end work
// (`maybeConsolidateAtTurnEnd`: the context engine's `onTurnComplete`, the
// memory flush, auto-compaction). The lane used to speak the reply's final
// fragment — the text after the last sentence boundary — and send `reply_text`
// and `turn_end` only once the iterator ended, i.e. behind that work, leaving
// the room's microphone deaf through it. Now all three happen at the terminal
// event, and the iterator is drained behind them; the NEXT turn's agent run
// waits for that drain.
//
// Driven on `SatelliteLane` directly, not over a socket: what is under test is
// the ordering of frames against a parked turn tail, and a socket adds nothing
// to that but latency.

import { satelliteLaneKey } from '@ethosagent/core';
import type { AgentEvent } from '@ethosagent/types';
import { pcm16ToBytes, type SatelliteServerFrame } from '@ethosagent/web-contracts';
import { describe, expect, it, vi } from 'vitest';
import type { WakeRoutingTable } from '../../repositories/config.repository';
import { SatelliteLane, type SatelliteLaneDeps } from '../satellite-lane';
import { SatelliteRegistry } from '../satellite-registry';

const TABLE: WakeRoutingTable = {
  routes: [
    {
      id: 'eng',
      phrase: 'hey engineer',
      personalityId: 'engineer',
      privileged: false,
      enabled: true,
      implicit: false,
    },
  ],
  nodes: {},
  settings: {
    engine: 'fallback',
    sensitivity: 0.5,
    confirmationFrames: 2,
    edgeStt: false,
    idleTimeoutMs: 30_000,
    wakeEnabled: true,
  },
};

function harness(terminal: AgentEvent, opts: { streamText?: boolean | string } = {}) {
  const frames: SatelliteServerFrame[] = [];
  const synthesized: string[] = [];
  const state = { runs: 0, tailsRan: 0 };
  const gates: Array<() => void> = [];
  const deps: SatelliteLaneDeps = {
    transcribe: () => Promise.resolve({ text: 'how are my positions', provider: 'fake-stt' }),
    synthesize: async function* (text: string) {
      synthesized.push(text);
      yield { audio: new Uint8Array([1, 2]), format: 'opus' as const, provider: 'fake-tts' };
    },
    resolvePersonality: () => Promise.resolve({ exists: true, privileged: false }),
    runTurn: (): AsyncIterable<AgentEvent> => {
      state.runs++;
      const n = state.runs;
      return (async function* () {
        // "How are you today?" follows the last sentence boundary: the chunker
        // holds it until it is flushed.
        if (typeof opts.streamText === 'string') {
          yield { type: 'text_delta' as const, text: opts.streamText };
        } else if (opts.streamText !== false) {
          yield { type: 'text_delta' as const, text: `Reply ${n}. How are you today?` };
        }
        yield terminal;
        await new Promise<void>((resolve) => gates.push(resolve));
        state.tailsRan++;
      })();
    },
    voiceMode: () => Promise.resolve('mirror_inbound'),
    laneKey: (nodeId, personalityId) => satelliteLaneKey('web', nodeId, personalityId),
  };
  const lane = new SatelliteLane({
    laneId: 'lane-1',
    deps,
    registry: new SatelliteRegistry({ readTable: () => Promise.resolve(TABLE) }),
    send: (frame) => frames.push(frame),
  });
  lane.handle(
    {
      t: 'register',
      nodeId: 'kitchen',
      displayName: 'Kitchen Pi',
      protocolVersion: 1,
      capabilities: {
        edgeStt: false,
        playback: true,
        captureSampleRate: 16_000,
        phraseMatch: true,
      },
      wakeEnabled: true,
    },
    new Uint8Array(),
  );
  const utter = (n: number) => {
    const wakeId = `w${n}`;
    const utteranceId = `u${n}`;
    lane.handle(
      {
        t: 'wake',
        wakeId,
        phrase: 'hey engineer',
        routeId: 'eng',
        personalityId: 'engineer',
      },
      new Uint8Array(),
    );
    lane.handle(
      { t: 'utterance_start', wakeId, utteranceId, sampleRate: 16_000 },
      new Uint8Array(),
    );
    lane.handle({ t: 'audio', utteranceId, seq: 0 }, pcm16ToBytes(Int16Array.from([1, 2, 3])));
    lane.handle({ t: 'utterance_end', utteranceId }, new Uint8Array());
    return utteranceId;
  };
  const sent = (t: SatelliteServerFrame['t'], utteranceId: string) =>
    frames.filter((f) => f.t === t && 'utteranceId' in f && f.utteranceId === utteranceId);
  return {
    lane,
    frames,
    synthesized,
    state,
    utter,
    sent,
    parked: () => gates.length,
    release: () => {
      while (gates.length) gates.shift()?.();
    },
  };
}

const DONE: AgentEvent = { type: 'done', text: '', turnCount: 1 };

describe('SatelliteLane — the turn-end tail (F07)', () => {
  it('speaks the final fragment and ends the turn while the tail is still parked', async () => {
    const h = harness(DONE);
    const u1 = h.utter(1);

    await vi.waitFor(() => expect(h.sent('turn_end', u1)).toHaveLength(1));
    expect(h.sent('reply_text', u1)).toMatchObject([{ text: 'Reply 1. How are you today?' }]);
    expect(h.synthesized).toEqual(['Reply 1.', 'How are you today?']);
    // The tail was not closed: it is parked, and runs once released.
    expect(h.parked()).toBe(1);
    h.release();
    await vi.waitFor(() => expect(h.state.tailsRan).toBe(1));
    h.lane.close();
  });

  // A returnDirect tool result reaches the turn only as `done.text`.
  it('speaks `done.text` when no text streamed — a returnDirect tool result', async () => {
    const h = harness(
      { type: 'done', text: 'Direct answer. It is ready', turnCount: 1 },
      { streamText: false },
    );
    const u1 = h.utter(1);

    await vi.waitFor(() => expect(h.sent('turn_end', u1)).toHaveLength(1));
    expect(h.sent('reply_text', u1)).toMatchObject([{ text: 'Direct answer. It is ready' }]);
    h.release();
    await vi.waitFor(() => expect(h.state.tailsRan).toBe(1));
    h.lane.close();
  });

  it('speaks a returnDirect answer after a streamed preamble', async () => {
    const h = harness(
      { type: 'done', text: 'Direct answer. It is ready', turnCount: 1 },
      { streamText: 'Let me look that up.' },
    );
    const u1 = h.utter(1);

    await vi.waitFor(() => expect(h.sent('turn_end', u1)).toHaveLength(1));
    expect(h.sent('reply_text', u1)).toMatchObject([
      { text: 'Let me look that up. Direct answer. It is ready' },
    ]);
    h.release();
    await vi.waitFor(() => expect(h.state.tailsRan).toBe(1));
    h.lane.close();
  });

  it('does the same at an `error`', async () => {
    const h = harness({ type: 'error', error: 'provider exploded', code: 'llm_error' });
    const u1 = h.utter(1);

    await vi.waitFor(() => expect(h.sent('turn_end', u1)).toHaveLength(1));
    expect(h.sent('error', u1)).toMatchObject([{ code: 'turn_failed' }]);
    expect(h.synthesized).toEqual(['Reply 1.', 'How are you today?']);
    h.release();
    await vi.waitFor(() => expect(h.state.tailsRan).toBe(1));
    h.lane.close();
  });

  it('starts the next turn’s agent run only after the previous tail has drained', async () => {
    const h = harness(DONE);
    const u1 = h.utter(1);
    await vi.waitFor(() => expect(h.sent('turn_end', u1)).toHaveLength(1));

    const u2 = h.utter(2);
    await vi.waitFor(() => expect(h.sent('transcript', u2)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.state.runs).toBe(1);

    h.release();
    await vi.waitFor(() => expect(h.sent('turn_end', u2)).toHaveLength(1));
    expect(h.state.runs).toBe(2);
    // The first turn's tail was drained, not cut short, even though the second
    // utterance superseded it.
    expect(h.state.tailsRan).toBe(1);
    h.release();
    await vi.waitFor(() => expect(h.state.tailsRan).toBe(2));
    h.lane.close();
  });
});
