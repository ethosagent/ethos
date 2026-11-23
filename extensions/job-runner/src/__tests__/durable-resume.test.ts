import { SQLiteJobStore } from '@ethosagent/job-store';
import type { AgentEvent, CreateBackgroundJobInput } from '@ethosagent/types';
import { JOB_ABORTED_BY_SHUTDOWN } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type BackgroundExecutorConfig,
  type BackgroundExecutorDeps,
  JOB_OBSERVE_MS,
} from '../index';
import {
  CAPS,
  exec,
  FakeRunner,
  RELEASED,
  type Script,
  started,
  untilAbort,
} from './resume-fixtures';

// durable-background-jobs L4/L5 — the executor's suspend / resume contract:
// a graceful stop requeues an eligible run instead of aborting it, the next
// executor with the same affinity continues it, spend carries, and every
// ineligible shape keeps today's abort. The runner is a fake registered as
// 'fake-auto' (the executor resolves 'ethos' to its built-in default runner and
// never consults the registry for that name).

const usage = (usd: number): AgentEvent => ({
  type: 'usage',
  inputTokens: 1,
  outputTokens: 1,
  estimatedCostUsd: usd,
});

/** Yields `events`, then parks until the run is aborted. */
function parked(events: AgentEvent[] = []): Script {
  return async function* (ctx) {
    for (const e of events) yield e;
    await untilAbort(ctx.signal);
  };
}

function input(over: Partial<CreateBackgroundJobInput> = {}): CreateBackgroundJobInput {
  return {
    owner: 'owner-1',
    parentSessionKey: 'parent',
    rootSessionKey: 'root-resume',
    childSessionKey: 'child-resume',
    depth: 1,
    prompt: 'do the thing',
    runner: 'fake-auto',
    ...over,
  };
}

const eventTypes = async (store: SQLiteJobStore, id: string): Promise<string[]> =>
  (await store.getEvents(id)).map((e) => e.eventType);

describe('shutdown suspends an eligible run', () => {
  it('requeues it, counts the resume, ends the trail with `requeued`, and stays silent', async () => {
    const store = new SQLiteJobStore(':memory:');
    const runner = new FakeRunner(parked());
    const e1 = await exec(store, runner, 'owner-1');
    const onComplete = vi.fn();
    e1.onComplete(onComplete);
    const job = await store.create(input());
    const steer = await store.addSteer(job.id, { text: 'also do X', source: 'cli' });
    expect(steer.ok).toBe(true);

    e1.start();
    e1.nudge();
    await started(runner);
    await e1.shutdown();

    const row = await store.get(job.id);
    expect(row?.status).toBe('queued');
    expect(row?.owner).toBe(RELEASED);
    expect(row?.resumeCount).toBe(1);
    const events = await store.getEvents(job.id);
    expect(events.at(-1)?.eventType).toBe('requeued');
    expect(events.at(-1)?.payload).toEqual({
      reason: 'restart',
      attempt: 1,
      interruptedTools: [],
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect((await store.listSteers(job.id)).map((s) => s.state)).toEqual(['pending']);
  });

  it('a second executor with the same affinity claims it and hands the runner ctx.resume', async () => {
    const store = new SQLiteJobStore(':memory:');
    const runner = new FakeRunner(async function* (ctx, n) {
      if (n === 1) {
        yield { type: 'tool_start', toolCallId: 't1', toolName: 'terminal', args: { cmd: 'ls' } };
      }
      await untilAbort(ctx.signal);
    });
    const e1 = await exec(store, runner, 'owner-1');
    const job = await store.create(input());
    e1.start();
    e1.nudge();
    await vi.waitFor(
      async () => expect(await eventTypes(store, job.id)).toContain('tool_headline'),
      {
        timeout: 3000,
      },
    );
    await e1.shutdown();

    const e2 = await exec(store, runner, 'owner-2');
    e2.start();
    await started(runner, 2);
    expect(runner.ctxs[0]?.resume).toBeUndefined();
    expect(runner.ctxs[1]?.resume).toEqual({
      reason: 'restart',
      attempt: 1,
      interruptedTools: ['terminal'],
    });
    expect((await store.get(job.id))?.owner).toBe('owner-2');
    await e2.shutdown();
  });

  it('carries spend across the resume, and the cap applies to the total', async () => {
    const store = new SQLiteJobStore(':memory:');
    const runner = new FakeRunner(async function* (ctx, n) {
      yield usage(n === 1 ? 0.3 : 0.2);
      await untilAbort(ctx.signal);
    });
    const e1 = await exec(store, runner, 'owner-1');
    const j1 = await store.create(input());
    e1.start();
    e1.nudge();
    await vi.waitFor(async () => expect((await store.get(j1.id))?.spendUsd).toBeCloseTo(0.3), {
      timeout: 3000,
    });
    await e1.shutdown();
    const e2 = await exec(store, runner, 'owner-2');
    e2.start();
    await vi.waitFor(async () => expect((await store.get(j1.id))?.spendUsd).toBeCloseTo(0.5), {
      timeout: 3000,
    });
    await e2.shutdown();

    const store2 = new SQLiteJobStore(':memory:');
    const runner2 = new FakeRunner(async function* (ctx, n) {
      yield usage(n === 1 ? 0.3 : 0.2);
      await untilAbort(ctx.signal);
    });
    const f1 = await exec(store2, runner2, 'owner-1');
    const j2 = await store2.create(input({ maxCostUsd: 0.45 }));
    f1.start();
    f1.nudge();
    await vi.waitFor(async () => expect((await store2.get(j2.id))?.spendUsd).toBeCloseTo(0.3), {
      timeout: 3000,
    });
    await f1.shutdown();
    const f2 = await exec(store2, runner2, 'owner-2');
    f2.start();
    await vi.waitFor(async () => expect((await store2.get(j2.id))?.status).toBe('failed'), {
      timeout: 3000,
    });
    expect((await store2.get(j2.id))?.error).toContain('exceeded max_cost_usd');
    await f2.shutdown();
  });
});

describe('shutdown keeps today’s abort when the run is not resumable', () => {
  async function expectAborted(
    deps: Partial<BackgroundExecutorDeps>,
    config: Partial<BackgroundExecutorConfig>,
    jobOver: Partial<CreateBackgroundJobInput>,
    runner = new FakeRunner(parked()),
  ): Promise<void> {
    const store = new SQLiteJobStore(':memory:');
    const e = await exec(store, runner, 'owner-1', deps, config);
    const onComplete = vi.fn();
    e.onComplete(onComplete);
    const job = await store.create(input(jobOver));
    e.start();
    e.nudge();
    await started(runner);
    await e.shutdown();
    const row = await store.get(job.id);
    expect(row?.status).toBe('aborted');
    expect(row?.error).toBe(JOB_ABORTED_BY_SHUTDOWN);
    expect(onComplete).toHaveBeenCalledTimes(1);
  }

  it('a noResume job', () => expectAborted({}, {}, { noResume: true }));
  it('a pid (unstable) affinity', () => expectAborted({ resumeAffinity: undefined }, {}, {}));
  it('resumeOnRestart false', () => expectAborted({}, { resumeOnRestart: false }, {}));
  it('a runner without autoResume', () => {
    const { autoResume: _drop, ...noAuto } = CAPS;
    return expectAborted({}, {}, {}, new FakeRunner(parked(), noAuto));
  });
});

describe('executor wiring of the durable-resume store surface', () => {
  it('markTainted writes `tainted` immediately, before the run ends', async () => {
    const store = new SQLiteJobStore(':memory:');
    const runner = new FakeRunner(async function* (ctx) {
      ctx.markTainted?.();
      yield usage(0);
      await untilAbort(ctx.signal);
    });
    const e = await exec(store, runner, 'owner-1');
    const job = await store.create(input());
    e.start();
    e.nudge();
    await vi.waitFor(async () => expect((await store.get(job.id))?.tainted).toBe(true), {
      timeout: 3000,
    });
    expect((await store.get(job.id))?.status).toBe('running');
    await e.shutdown();
  });

  it('a run whose row was requeued under it stops without finishing', async () => {
    const store = new SQLiteJobStore(':memory:');
    const finish = vi.spyOn(store, 'finish');
    const runner = new FakeRunner(parked());
    const e = await exec(store, runner, 'owner-1');
    const onComplete = vi.fn();
    e.onComplete(onComplete);
    const job = await store.create(input());
    e.start();
    e.nudge();
    await started(runner);
    // What another executor's stale sweep does to a late heartbeat (D13).
    expect(await store.requeueForResume(job.id, { reason: 'crash', maxResumes: 3 })).toBe(true);

    await vi.waitFor(() => expect(runner.ctxs[0]?.signal.aborted).toBe(true), {
      timeout: JOB_OBSERVE_MS * 4,
    });
    expect(finish).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(await eventTypes(store, job.id)).not.toContain('finished');
    await e.shutdown();
  });

  it('sweeps pass maxResumes to reclaimStale and resumeTtlMs to expireQueued', async () => {
    const store = new SQLiteJobStore(':memory:');
    const reclaim = vi.spyOn(store, 'reclaimStale');
    const expire = vi.spyOn(store, 'expireQueued');
    const e = await exec(store, new FakeRunner(parked()), 'owner-1');
    e.start();
    await vi.waitFor(() => expect(reclaim.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
    for (const call of reclaim.mock.calls) expect(call).toEqual([90_000, { maxResumes: 3 }]);
    for (const call of expire.mock.calls)
      expect(call).toEqual([900_000, { resumeTtlMs: 86_400_000 }]);
    await e.shutdown();

    const reclaim2 = vi.spyOn(store, 'reclaimStale');
    reclaim2.mockClear();
    const e2 = await exec(store, new FakeRunner(parked()), 'owner-2', {
      resumeAffinity: undefined,
    });
    await e2.bootSweep();
    // A non-resumable process still requeues (the row's stamped affinity decides who
    // adopts); see `durable-resume-review.test.ts` for the end-to-end half.
    expect(reclaim2).toHaveBeenCalledWith(90_000, { maxResumes: 3 });
    await e2.shutdown();
  });
});
