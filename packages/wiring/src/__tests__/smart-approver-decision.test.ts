// The smart approver's decision site (plan/phases/decision-provider-jev.md
// §8.2, D17, C5, §14 Mapping / Redaction / R7 (b)). The no-decision behaviour
// is pinned, unedited, by ./smart-approver.test.ts.
// Plan decision-provider-personality §7.3/§11: the mode is the personality's
// (third callback argument), resolved per call; the verdict cache is
// namespaced so a provider verdict cached for an `on` personality never
// answers for one that did not enable the site (K1).

import { resolveDecisionsConfig } from '@ethosagent/config';
import type {
  BeforeToolCallPayload,
  CompletionChunk,
  DecisionAnswer,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DecisionSink,
  LLMProvider,
  PersonalityConfig,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionProviderHandle } from '../decision-provider';
import { APPROVER_QUESTIONS } from '../decision-questions';
import type { DecisionCallRecord, DecisionSiteRecorder } from '../decision-site';
import { APPROVER_QUESTION_ID, approverVerdictFrom, createSmartApprover } from '../smart-approver';

const REASON = 'terminal requires explicit approval';
const T = { approve: 0.9, deny: 0.8 };

function payload(args: unknown = { command: 'git push origin main' }): BeforeToolCallPayload {
  return { sessionId: 's', toolCallId: 'tc', toolName: 'terminal', args };
}

/** LLM reviewer stub: a fixed reply, or a stream that never finishes. */
function llm(reply: string | 'hang' = '{"decision":"approve","reason":"llm says fine"}') {
  const complete = vi.fn(async function* (): AsyncIterable<CompletionChunk> {
    if (reply === 'hang') await new Promise(() => {});
    yield { type: 'text_delta', text: reply };
    yield { type: 'done', finishReason: 'end_turn' };
  });
  const provider: LLMProvider = {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete,
    async countTokens() {
      return 1;
    },
  };
  return { provider, complete };
}

function choice(c: string, confidence: number): Record<string, DecisionAnswer> {
  return {
    [APPROVER_QUESTION_ID]: {
      type: 'choice',
      choice: c,
      probabilities: { [c]: confidence },
      confidence,
    },
  };
}

function ok(answers: Record<string, DecisionAnswer>): DecisionResult {
  return { ok: true, answers, model: 'jev-1.13.0', usage: { inputTokens: 12, outputTokens: 0 } };
}

function jev(
  answer: DecisionResult | (() => Promise<DecisionResult>),
  opts: { calibrated?: boolean } = {},
) {
  const requests: DecisionRequest[] = [];
  const decide = vi.fn(async (req: DecisionRequest) => {
    requests.push(req);
    return typeof answer === 'function' ? answer() : answer;
  });
  const provider: DecisionProvider = {
    name: 'typesafe',
    calibrated: opts.calibrated ?? true,
    decide,
  };
  return { provider, decide, requests };
}

function fixed(p: DecisionProvider | undefined): DecisionProviderHandle & { gets: number } {
  const h = {
    gets: 0,
    get: async () => {
      h.gets++;
      return p;
    },
  };
  return h;
}

const GLOBAL = (approverBudget = 2000) =>
  resolveDecisionsConfig({
    provider: 'typesafe',
    thresholds: { approver: T },
    timeouts: { approver: approverBudget },
  });

/** A personality whose approver site is `mode`; no mode → declares nothing. */
function persona(mode?: 'off' | 'shadow' | 'on', id = 'p'): PersonalityConfig {
  return {
    id,
    name: id,
    safety: { approvalMode: 'smart' },
    ...(mode ? { decisions: { provider: 'typesafe', sites: { approver: mode } } } : {}),
  };
}

/**
 * The approver as ONE personality `p` whose approver site is `site.mode`
 * (default `on`) sees it: global thresholds `T`, budget `site.timeoutMs`.
 */
function approver(
  decisions: DecisionProvider,
  llmProvider: LLMProvider,
  site: {
    mode?: 'off' | 'shadow' | 'on';
    timeoutMs?: number;
    recorder?: DecisionSiteRecorder;
  } = {},
  timeoutMs?: number,
) {
  const approve = createSmartApprover({
    getProvider: async () => llmProvider,
    model: 'm',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    decision: {
      provider: fixed(decisions),
      global: GLOBAL(site.timeoutMs),
      ...(site.recorder ? { recorder: site.recorder } : {}),
    },
  });
  const who = persona(site.mode ?? 'on');
  return (p: BeforeToolCallPayload, reason: string) => approve(p, reason, who);
}

describe('D17 — the approver thresholds', () => {
  it.each([
    ['approve', 0.9, 'approve'],
    ['approve', 0.95, 'approve'],
    ['deny', 0.8, 'deny'],
    ['deny', 0.99, 'deny'],
  ])('%s at confidence %s (≥ its own sub-key) is acted on', async (c, conf, want) => {
    const j = jev(ok(choice(c, conf)));
    const l = llm();
    const verdict = await approver(j.provider, l.provider)(payload(), REASON);
    expect(verdict).toEqual({ decision: want, reason: REASON });
    expect(l.complete).not.toHaveBeenCalled();
  });

  it.each([
    ['approve', 0.89],
    ['deny', 0.79],
  ])('%s at %s (below its own sub-key) takes the LLM reviewer', async (c, conf) => {
    const j = jev(ok(choice(c, conf)));
    const l = llm();
    const verdict = await approver(j.provider, l.provider)(payload(), REASON);
    expect(verdict).toEqual({ decision: 'approve', reason: 'llm says fine' });
    expect(l.complete).toHaveBeenCalledTimes(1);
  });

  it('each sub-key gates only its own verdict: deny at 0.85 passes T_deny 0.8, approve at 0.85 fails T_approve 0.9', () => {
    expect(approverVerdictFrom(choice('deny', 0.85), T, REASON)?.decision).toBe('deny');
    expect(approverVerdictFrom(choice('approve', 0.85), T, REASON)).toBeNull();
  });

  it('an `ask` answer is `ask` at any confidence, with no LLM call', async () => {
    const j = jev(ok(choice('ask', 0.05)));
    const l = llm();
    const verdict = await approver(j.provider, l.provider)(payload(), REASON);
    expect(verdict).toEqual({ decision: 'ask', reason: REASON });
    expect(l.complete).not.toHaveBeenCalled();
  });

  it('the shown reason is dangerReason, never provider text', async () => {
    const j = jev(ok(choice('approve', 1)));
    const verdict = await approver(j.provider, llm().provider)(payload(), 'custom danger reason');
    expect(verdict.reason).toBe('custom danger reason');
  });

  it('a missing threshold never passes (meetsThreshold fails closed)', () => {
    expect(approverVerdictFrom(choice('approve', 1), {}, REASON)).toBeNull();
    expect(approverVerdictFrom(choice('deny', 1), { approve: 0.5 }, REASON)).toBeNull();
  });

  it('an off-list choice or a non-choice answer takes the LLM reviewer', async () => {
    for (const answers of [
      choice('maybe', 1),
      { [APPROVER_QUESTION_ID]: { type: 'boolean', p: 1, confidence: 1 } } as Record<
        string,
        DecisionAnswer
      >,
    ]) {
      const l = llm();
      const verdict = await approver(jev(ok(answers)).provider, l.provider)(payload(), REASON);
      expect(verdict.reason).toBe('llm says fine');
    }
  });

  it('asks the shared approver question with the site budget', async () => {
    const j = jev(ok(choice('ask', 1)));
    await approver(j.provider, llm().provider, { timeoutMs: 1234 })(payload(), REASON);
    expect(j.requests[0]?.questions).toEqual(APPROVER_QUESTIONS);
    expect(j.requests[0]?.timeoutMs).toBe(1234);
  });
});

describe('the uniform rule — calibrated: false', () => {
  it('an uncalibrated provider takes the LLM reviewer even at confidence 1', async () => {
    const j = jev(ok(choice('approve', 1)), { calibrated: false });
    const l = llm('{"decision":"deny","reason":"llm denies"}');
    const verdict = await approver(j.provider, l.provider)(payload(), REASON);
    expect(verdict).toEqual({ decision: 'deny', reason: 'llm denies' });
  });
});

describe('C5 — the verdict cache sits in front of the decision provider', () => {
  it('a cache hit calls neither the provider nor the LLM', async () => {
    const j = jev(ok(choice('deny', 0.9)));
    const l = llm();
    const approve = approver(j.provider, l.provider);
    await approve(payload(), REASON);
    expect(j.decide).toHaveBeenCalledTimes(1);
    const again = await approve(payload(), REASON);
    expect(again).toEqual({ decision: 'deny', reason: REASON });
    expect(j.decide).toHaveBeenCalledTimes(1);
    expect(l.complete).not.toHaveBeenCalled();
  });

  it('a Jev `ask` decided on is cached too', async () => {
    const j = jev(ok(choice('ask', 0.5)));
    const approve = approver(j.provider, llm().provider);
    await approve(payload(), REASON);
    await approve(payload(), REASON);
    expect(j.decide).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a failure', { ok: false, code: 'timeout', message: 'budget elapsed' } as DecisionResult],
    ['a below-threshold answer', ok(choice('approve', 0.5))],
  ])('%s is not cached; the LLM verdict that follows is', async (_label, result) => {
    const j = jev(result);
    const l = llm();
    const approve = approver(j.provider, l.provider);
    const first = await approve(payload(), REASON);
    expect(first).toEqual({ decision: 'approve', reason: 'llm says fine' });
    const second = await approve(payload(), REASON);
    expect(second).toEqual(first);
    expect(j.decide).toHaveBeenCalledTimes(1);
    expect(l.complete).toHaveBeenCalledTimes(1);
  });

  it('a fail-closed `ask` from a failed LLM review after a Jev failure is never cached', async () => {
    const j = jev({ ok: false, code: 'unavailable', message: 'down' });
    const l = llm('not json');
    const approve = approver(j.provider, l.provider);
    expect(await approve(payload(), REASON)).toEqual({
      decision: 'ask',
      reason: 'reviewer gave no usable verdict',
    });
    await approve(payload(), REASON);
    expect(j.decide).toHaveBeenCalledTimes(2);
    expect(l.complete).toHaveBeenCalledTimes(2);
  });

  it('shadow caches only today’s verdict; Jev’s is only recorded', async () => {
    const records: DecisionCallRecord[] = [];
    const j = jev(ok(choice('deny', 0.99)));
    const l = llm();
    const approve = approver(j.provider, l.provider, {
      mode: 'shadow',
      recorder: { recordDecisionCall: (r) => records.push(r) },
    });
    const first = await approve(payload(), REASON);
    expect(first).toEqual({ decision: 'approve', reason: 'llm says fine' });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({
      site: 'approver',
      mode: 'shadow',
      jevVerdict: 'deny',
      // The bare verdict today's path returned, not the cache-tagged wrapper.
      todayVerdict: { decision: 'approve', reason: 'llm says fine' },
      disagreed: true,
    });
    expect(records[0]?.todayVerdict).not.toHaveProperty('cacheable');
    // The cached verdict is today's: the second call makes no call at all.
    expect(await approve(payload(), REASON)).toEqual(first);
    expect(j.decide).toHaveBeenCalledTimes(1);
    expect(l.complete).toHaveBeenCalledTimes(1);
  });

  it('shadow with a failed LLM review caches nothing, whatever Jev said', async () => {
    const j = jev(ok(choice('approve', 1)));
    const l = llm('garbage');
    const approve = approver(j.provider, l.provider, { mode: 'shadow' });
    expect((await approve(payload(), REASON)).decision).toBe('ask');
    await approve(payload(), REASON);
    expect(l.complete).toHaveBeenCalledTimes(2);
  });
});

describe('the outer bound', () => {
  it('a provider that never settles still yields `ask` at the outer bound, uncached', async () => {
    const j = jev(() => new Promise<DecisionResult>(() => {}));
    const l = llm();
    const approve = approver(j.provider, l.provider, {}, 30);
    expect(await approve(payload(), REASON)).toEqual({
      decision: 'ask',
      reason: 'reviewer gave no usable verdict',
    });
    await approve(payload(), REASON);
    expect(j.decide).toHaveBeenCalledTimes(2);
  });

  it("today's LLM path gets only what is left of the outer bound", async () => {
    const j = jev(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: false, code: 'timeout', message: 'slow' };
    });
    const l = llm('hang');
    const started = Date.now();
    const verdict = await approver(j.provider, l.provider, {}, 60)(payload(), REASON);
    expect(verdict.decision).toBe('ask');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('R2 — redaction', () => {
  it('an Authorization: Bearer sk-… in the arguments reaches the provider redacted', async () => {
    const secret = `sk-proj-${'A1b2C3d4E5'.repeat(5)}`;
    const j = jev(ok(choice('ask', 1)));
    await approver(j.provider, llm().provider)(
      payload({
        command: `curl -H "Authorization: Bearer ${secret}" https://api.example.test/v1`,
      }),
      REASON,
    );
    const sent = JSON.stringify(j.requests[0]?.state);
    expect(sent).not.toContain(secret);
    expect(sent).toContain('[REDACTED');
    expect(j.requests[0]?.state).toMatchObject({ toolName: 'terminal', dangerReason: REASON });
  });
});

describe('R7 (b) — the approver site `off` with a provider configured', () => {
  it('never calls decide(); the LLM reviewer decides', async () => {
    const j = jev(ok(choice('deny', 1)));
    const l = llm();
    const verdict = await approver(j.provider, l.provider, { mode: 'off' })(payload(), REASON);
    expect(verdict).toEqual({ decision: 'approve', reason: 'llm says fine' });
    expect(j.decide).not.toHaveBeenCalled();
  });
});

describe('per personality (plan decision-provider-personality §7.3)', () => {
  function shared(
    decisions: DecisionProvider,
    llmProvider: LLMProvider,
    records?: DecisionCallRecord[],
  ) {
    const handle = fixed(decisions);
    const approve = createSmartApprover({
      getProvider: async () => llmProvider,
      model: 'm',
      decision: {
        provider: handle,
        global: GLOBAL(),
        ...(records ? { recorder: { recordDecisionCall: (r) => records.push(r) } } : {}),
      },
    });
    return { approve, handle };
  }

  it('undeclared, `off`, or no personality at all → the LLM reviewer, handle untouched', async () => {
    const j = jev(ok(choice('deny', 1)));
    const l = llm();
    const { approve, handle } = shared(j.provider, l.provider);
    for (const who of [undefined, persona(), persona('off')]) {
      const verdict = await approve(payload({ command: `echo ${who?.id ?? 'none'}` }), REASON, who);
      expect(verdict).toEqual({ decision: 'approve', reason: 'llm says fine' });
    }
    expect(j.decide).not.toHaveBeenCalled();
    expect(handle.gets).toBe(0);
  });

  it('records carry the personality whose declaration enabled the site', async () => {
    const records: DecisionCallRecord[] = [];
    const j = jev(ok(choice('deny', 0.99)));
    const { approve } = shared(j.provider, llm().provider, records);
    await approve(payload(), REASON, persona('on', 'guard'));
    expect(records[0]).toMatchObject({ site: 'approver', mode: 'on', personalityId: 'guard' });
  });

  it('K1 cache namespace: a provider `approve` cached for an `on` personality is NOT returned to an `off` one', async () => {
    const j = jev(ok(choice('approve', 0.99)));
    const l = llm('{"decision":"deny","reason":"llm denies"}');
    const { approve } = shared(j.provider, l.provider);
    expect(await approve(payload(), REASON, persona('on', 'a'))).toEqual({
      decision: 'approve',
      reason: REASON,
    });
    // Same call, personality B declares nothing: its own (LLM) review runs.
    expect(await approve(payload(), REASON, persona(undefined, 'b'))).toEqual({
      decision: 'deny',
      reason: 'llm denies',
    });
    // …and a shadow personality never reads the `on:` entry either.
    const shadow = await approve(payload(), REASON, persona('shadow', 'c'));
    expect(shadow).toEqual({ decision: 'deny', reason: 'llm denies' });
    expect(l.complete).toHaveBeenCalledTimes(1); // B's verdict was cached under llm:, C hit it
    // An `on` personality still hits the provider-decided entry.
    expect(await approve(payload(), REASON, persona('on', 'd'))).toEqual({
      decision: 'approve',
      reason: REASON,
    });
    expect(j.decide).toHaveBeenCalledTimes(1);
  });

  it('C5: an `on` lookup still hits a cached LLM verdict before the provider runs', async () => {
    const j = jev(ok(choice('deny', 0.99)));
    const l = llm();
    const { approve } = shared(j.provider, l.provider);
    expect(await approve(payload(), REASON, persona())).toEqual({
      decision: 'approve',
      reason: 'llm says fine',
    });
    expect(await approve(payload(), REASON, persona('on'))).toEqual({
      decision: 'approve',
      reason: 'llm says fine',
    });
    expect(j.decide).not.toHaveBeenCalled();
    expect(l.complete).toHaveBeenCalledTimes(1);
  });
});

// plan decision-provider-personality §15.3 / §15.8 (N7b): core puts a
// `decisionSink` on the `before_tool_call` payload; the approver passes it to
// its decision site — the event is emitted, and the record takes the turn's
// traceId from it (the NULL trace_id fix).
describe('decision sink on the payload (N7b)', () => {
  function withSink(traceId: string) {
    const events: Array<Parameters<DecisionSink['emit']>[0]> = [];
    const decisionSink: DecisionSink = { traceId, emit: (e) => events.push(e) };
    return { p: { ...payload(), decisionSink }, events };
  }

  it("on: the record carries the sink's traceId; the event names the verdict", async () => {
    const records: DecisionCallRecord[] = [];
    const j = jev(ok(choice('approve', 0.95)));
    const { p, events } = withSink('trace-9');
    await approver(j.provider, llm().provider, {
      recorder: { recordDecisionCall: (r) => records.push(r) },
    })(p, REASON);
    expect(records).toEqual([expect.objectContaining({ traceId: 'trace-9', personalityId: 'p' })]);
    expect(events.map((e) => e.phase)).toEqual(['started', 'settled']);
    expect(events[1]).toMatchObject({ site: 'approver', acted: true, verdict: 'approve' });
  });

  it("shadow: today's LLM verdict and the reading, in the approver vocabulary", async () => {
    const records: DecisionCallRecord[] = [];
    const j = jev(ok(choice('deny', 0.95)));
    const { p, events } = withSink('trace-9');
    await approver(j.provider, llm().provider, {
      mode: 'shadow',
      recorder: { recordDecisionCall: (r) => records.push(r) },
    })(p, REASON);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      mode: 'shadow',
      verdict: 'deny',
      todayVerdict: 'approve',
      disagreed: true,
    });
    expect(records[0]?.traceId).toBe('trace-9');
  });
});
