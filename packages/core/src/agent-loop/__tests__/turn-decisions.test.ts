// Unit tests for the decision-event merge (../turn-decisions, plan
// decision-provider-personality §15.3, PD17, PD20).

import type { AgentEvent, DecisionSink, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { declaresDecisionSites, TurnDecisions, withDecisionEvents } from '../turn-decisions';

type DecisionBody = Parameters<DecisionSink['emit']>[0];

const PERSONALITY: PersonalityConfig = {
  id: 'p',
  name: 'P',
  decisions: { provider: 'typesafe', sites: { injection: 'shadow' } },
};

const body = (id: string): DecisionBody => ({
  id,
  phase: 'settled',
  site: 'injection',
  provider: 'stub',
  mode: 'shadow',
  outcome: 'ok',
  latencyMs: 1,
});

const label = (e: AgentEvent) => (e.type === 'decision' ? `d:${e.id}` : e.type);

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<string[]> {
  const out: string[] = [];
  for await (const e of gen) out.push(label(e));
  return out;
}

describe('declaresDecisionSites', () => {
  it('needs a provider and at least one site that is not off', () => {
    expect(declaresDecisionSites(PERSONALITY)).toBe(true);
    expect(declaresDecisionSites({ id: 'x', name: 'X' })).toBe(false);
    expect(
      declaresDecisionSites({ id: 'x', name: 'X', decisions: { sites: { router: 'on' } } }),
    ).toBe(false);
    expect(
      declaresDecisionSites({
        id: 'x',
        name: 'X',
        decisions: { provider: 'typesafe', sites: { router: 'off' } },
      }),
    ).toBe(false);
  });
});

describe('TurnDecisions', () => {
  it('hands out no sink until armed, and stamps what core knows once armed', () => {
    const d = new TurnDecisions();
    expect(d.sinkFor('c1')).toBeUndefined();
    d.arm(PERSONALITY, 'trace-9');
    const sink = d.sinkFor('c1');
    // A site cannot overwrite the stamps, whatever it passes at runtime.
    sink?.emit({ ...body('a'), personalityId: 'forged', toolCallId: 'forged' } as DecisionBody);
    expect(d.take()).toEqual([
      { ...body('a'), type: 'decision', personalityId: 'p', toolCallId: 'c1', traceId: 'trace-9' },
    ]);
  });

  it('a router sink (no toolCallId) drops a forged toolCallId', () => {
    const d = new TurnDecisions();
    d.arm(PERSONALITY, undefined);
    d.sinkFor()?.emit({ ...body('r'), toolCallId: 'forged', traceId: 'forged' } as DecisionBody);
    const [event] = d.take();
    expect(event).not.toHaveProperty('toolCallId');
    expect(event).not.toHaveProperty('traceId');
  });

  it('holds until release, except for a forced (tail) take', () => {
    const d = new TurnDecisions();
    d.arm(PERSONALITY, undefined);
    d.hold();
    d.sinkFor()?.emit(body('a'));
    expect(d.take()).toEqual([]);
    expect(d.take(true).map((e) => e.id)).toEqual(['a']);
  });

  it('drops emissions after close without throwing', () => {
    const d = new TurnDecisions();
    d.arm(PERSONALITY, undefined);
    const sink = d.sinkFor();
    d.close();
    expect(() => sink?.emit(body('late'))).not.toThrow();
    expect(d.take(true)).toEqual([]);
  });
});

describe('withDecisionEvents', () => {
  it('drains queued decisions before the next inner event, and the rest in the tail', async () => {
    const d = new TurnDecisions();
    d.arm(PERSONALITY, undefined);
    const sink = d.sinkFor();
    async function* inner(): AsyncGenerator<AgentEvent> {
      yield { type: 'text_delta', text: 'a' };
      sink?.emit(body('1'));
      yield { type: 'done', text: 'a', turnCount: 1 };
      sink?.emit(body('tail'));
    }
    expect(await collect(withDecisionEvents(d, inner()))).toEqual([
      'text_delta',
      'd:1',
      'done',
      'd:tail',
    ]);
  });

  it('yields a decision while the inner generator is still awaiting (PD20)', async () => {
    const d = new TurnDecisions();
    d.arm(PERSONALITY, undefined);
    const sink = d.sinkFor();
    let release: () => void = () => {};
    async function* inner(): AsyncGenerator<AgentEvent> {
      sink?.emit(body('started'));
      await new Promise<void>((r) => {
        release = r;
      });
      yield { type: 'done', text: '', turnCount: 1 };
    }
    const gen = withDecisionEvents(d, inner());
    const first = await gen.next();
    expect(first.value && label(first.value)).toBe('d:started');
    release();
    const second = await gen.next();
    expect(second.value && label(second.value)).toBe('done');
    expect((await gen.next()).done).toBe(true);
  });

  it('unarmed: passes events straight through', async () => {
    const d = new TurnDecisions();
    async function* inner(): AsyncGenerator<AgentEvent> {
      yield { type: 'text_delta', text: 'a' };
      yield { type: 'done', text: 'a', turnCount: 1 };
    }
    expect(await collect(withDecisionEvents(d, inner()))).toEqual(['text_delta', 'done']);
  });

  it('propagates an inner throw', async () => {
    const d = new TurnDecisions();
    d.arm(PERSONALITY, undefined);
    async function* inner(): AsyncGenerator<AgentEvent> {
      yield { type: 'text_delta', text: 'a' };
      throw new Error('boom');
    }
    await expect(collect(withDecisionEvents(d, inner()))).rejects.toThrow('boom');
  });

  it('a consumer that stops early closes the inner generator', async () => {
    const d = new TurnDecisions();
    d.arm(PERSONALITY, undefined);
    let finalized = false;
    async function* inner(): AsyncGenerator<AgentEvent> {
      try {
        yield { type: 'text_delta', text: 'a' };
        yield { type: 'done', text: 'a', turnCount: 1 };
      } finally {
        finalized = true;
      }
    }
    for await (const _e of withDecisionEvents(d, inner())) break;
    expect(finalized).toBe(true);
  });
});

describe('persistence (§15.5)', () => {
  it('persists settled events only, and a failing store never throws into the site', async () => {
    const written: string[] = [];
    const ok = { appendDecision: async (_s: string, e: { id: string }) => written.push(e.id) };
    const d = new TurnDecisions(undefined, ok as never);
    d.arm(PERSONALITY, 'trace', 'session-1');
    const sink = d.sinkFor('t1');
    sink?.emit({ ...body('s1'), phase: 'started' });
    sink?.emit(body('s1'));
    expect(written).toEqual(['s1']);

    for (const store of [
      {
        appendDecision: () => {
          throw new Error('sync');
        },
      },
      { appendDecision: async () => Promise.reject(new Error('async')) },
    ]) {
      const failing = new TurnDecisions(undefined, store as never);
      failing.arm(PERSONALITY, 'trace', 'session-1');
      expect(() => failing.sinkFor('t1')?.emit(body('x'))).not.toThrow();
      // The live stream is unaffected by the store.
      expect(failing.take().map((e) => e.id)).toEqual(['x']);
    }
  });

  it('writes nothing without a session id or without appendDecision', () => {
    const written: string[] = [];
    const store = { appendDecision: async (_s: string, e: { id: string }) => written.push(e.id) };
    const noSession = new TurnDecisions(undefined, store as never);
    noSession.arm(PERSONALITY, 'trace');
    noSession.sinkFor()?.emit(body('a'));
    const noMethod = new TurnDecisions(undefined, {} as never);
    noMethod.arm(PERSONALITY, 'trace', 's');
    expect(() => noMethod.sinkFor()?.emit(body('b'))).not.toThrow();
    expect(written).toEqual([]);
  });
});
