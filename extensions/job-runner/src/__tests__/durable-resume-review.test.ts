import { SQLiteJobStore } from '@ethosagent/job-store';
import type {
  AgentEvent,
  BackgroundJob,
  CreateBackgroundJobInput,
  JobRunnerContext,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { JOB_OBSERVE_MS } from '../index';
import {
  AFFINITY,
  exec,
  FakeRunner,
  RELEASED,
  type Script,
  started,
  untilAbort,
} from './resume-fixtures';

// Review fixes for durable-background-jobs: run-scoped cleanup, fenced terminal
// writes, sweeps from a non-resumable process, and the resume-context fallback.

const noEvents: AgentEvent[] = [];

const parked: Script = async function* (ctx) {
  yield* noEvents;
  await untilAbort(ctx.signal);
};

function input(over: Partial<CreateBackgroundJobInput> = {}): CreateBackgroundJobInput {
  return {
    owner: 'owner-1',
    parentSessionKey: 'parent',
    rootSessionKey: 'root-review',
    childSessionKey: 'child-review',
    depth: 1,
    prompt: 'do the thing',
    runner: 'fake-auto',
    ...over,
  };
}

/** A row another process's claim ended up running: running, stamped resumable. */
async function stampedRunning(store: SQLiteJobStore, owner: string): Promise<BackgroundJob> {
  const created = await store.create(input());
  const claimed = await store.claimNextQueued(owner);
  if (!claimed) throw new Error('claim failed');
  await store.setResumeAffinity(created.id, AFFINITY);
  return claimed;
}

describe('run-scoped cleanup', () => {
  it('an old run settling does not untrack its successor: shutdown still aborts run #2', async () => {
    const store = new SQLiteJobStore(':memory:');
    let oldSettled = false;
    const runner = new FakeRunner(async function* (ctx, n) {
      yield* noEvents;
      await untilAbort(ctx.signal);
      if (n === 1) {
        // Outlive the re-adoption so the old run's cleanup runs AFTER run #2 registers.
        await new Promise((r) => setTimeout(r, 300));
        oldSettled = true;
      }
    });
    const e = await exec(store, runner, 'owner-1');
    const job = await store.create(input());
    e.start();
    e.nudge();
    await started(runner);
    expect(await store.requeueForResume(job.id, { reason: 'crash', maxResumes: 3 })).toBe(true);
    await started(runner, 2);
    await vi.waitFor(() => expect(oldSettled).toBe(true), { timeout: JOB_OBSERVE_MS * 4 });
    // Let the old run's `.finally` run.
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.ctxs[1]?.signal.aborted).toBe(false);

    await e.shutdown();
    expect(runner.ctxs[1]?.signal.aborted).toBe(true);
    expect((await store.get(job.id))?.status).toBe('queued');
  });
});

describe('a live run cannot finish a row it no longer owns', () => {
  it('the steal scenario does not write `done` over the new run nor fire onComplete', async () => {
    const store = new SQLiteJobStore(':memory:');
    let release: (() => void) | undefined;
    const runner = new FakeRunner(async function* (ctx, n) {
      if (n === 1) {
        await new Promise<void>((r) => {
          release = r;
        });
        yield { type: 'text_delta', text: 'old output' };
        yield { type: 'done', text: 'old output', turnCount: 1 };
        return;
      }
      await untilAbort(ctx.signal);
    });
    const e = await exec(store, runner, 'owner-1');
    const onComplete = vi.fn();
    e.onComplete(onComplete);
    const job = await store.create(input());
    e.start();
    e.nudge();
    await started(runner);
    await store.requeueForResume(job.id, { reason: 'crash', maxResumes: 3 });
    await started(runner, 2);
    // Run #1 finishes naturally before its observe tick notices the steal.
    release?.();
    await new Promise((r) => setTimeout(r, 150));

    const row = await store.get(job.id);
    expect(row?.status).toBe('running');
    expect(row?.summary).toBeUndefined();
    expect(onComplete).not.toHaveBeenCalled();
    await e.shutdown();
  });

  it('a claim that moved on to a terminal state is also ownership loss', async () => {
    const store = new SQLiteJobStore(':memory:');
    const finish = vi.spyOn(store, 'finish');
    const runner = new FakeRunner(parked);
    const e = await exec(store, runner, 'owner-1');
    const job = await store.create(input());
    e.start();
    e.nudge();
    await started(runner);
    await store.requeueForResume(job.id, { reason: 'crash', maxResumes: 3 });
    await store.claimNextQueued('owner-2', { adopt: RELEASED });
    await store.finish(job.id, 'done', { summary: 'by the new claim' });
    finish.mockClear();

    await vi.waitFor(() => expect(runner.ctxs[0]?.signal.aborted).toBe(true), {
      timeout: JOB_OBSERVE_MS * 4,
    });
    expect(finish).not.toHaveBeenCalled();
    expect((await store.get(job.id))?.summary).toBe('by the new claim');
    await e.shutdown();
  });
});

describe('sweeps and resume from a non-resumable process', () => {
  it('requeues a stamped row under its original label and does not claim it itself', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await stampedRunning(store, 'owner-1');
    const runner = new FakeRunner(parked);
    const e = await exec(
      store,
      runner,
      'chat-owner',
      { resumeAffinity: undefined, affinity: undefined },
      {
        staleMs: -1,
      },
    );
    await e.bootSweep();
    const row = await store.get(job.id);
    expect(row?.status).toBe('queued');
    expect(row?.owner).toBe(RELEASED);
    expect(runner.ctxs).toHaveLength(0);
    await e.shutdown();
  });

  it('a crash sweep by a peer with the same affinity resumes with reason crash and the interrupted tools', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await stampedRunning(store, 'owner-1');
    await store.appendEvent(job.id, 'tool_headline', { toolName: 'terminal' });
    const runner = new FakeRunner(parked);
    const e2 = await exec(store, runner, 'owner-2', {}, { staleMs: -1 });
    await e2.bootSweep();
    await started(runner);
    expect(runner.ctxs[0]?.resume).toEqual({
      attempt: 1,
      reason: 'crash',
      interruptedTools: ['terminal'],
    });
    const row = await store.get(job.id);
    expect(row?.status).toBe('running');
    expect(row?.owner).toBe('owner-2');
    await e2.shutdown();
  });
});

describe('suspend and carried spend', () => {
  it('a runner that throws while the executor drains is requeued, silently', async () => {
    const store = new SQLiteJobStore(':memory:');
    const runner = new FakeRunner(async function* (ctx) {
      yield* noEvents;
      await untilAbort(ctx.signal);
      throw new Error('torn down mid-turn');
    });
    const e = await exec(store, runner, 'owner-1');
    const onComplete = vi.fn();
    e.onComplete(onComplete);
    const job = await store.create(input());
    e.start();
    e.nudge();
    await started(runner);
    await e.shutdown();
    const row = await store.get(job.id);
    expect(row?.status).toBe('queued');
    expect(row?.owner).toBe(RELEASED);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("the root aggregate gate counts the job's own carried spend", async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await stampedRunning(store, 'owner-1');
    await store.updateSpend(job.id, 5.5);
    await store.requeueForResume(job.id, { reason: 'restart', maxResumes: 3 });
    const runner = new FakeRunner(parked);
    const e = await exec(store, runner, 'owner-2');
    await e.bootSweep();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('failed'), {
      timeout: 3000,
    });
    expect((await store.get(job.id))?.error).toMatch(
      /spend cap \$5 reached \(already spent \$5\.5\)/,
    );
    expect(runner.ctxs).toHaveLength(0);
    await e.shutdown();
  });
});

describe('resume context', () => {
  it('an unreadable `requeued` trail still resumes with a fallback context', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await stampedRunning(store, 'owner-1');
    await store.requeueForResume(job.id, { reason: 'crash', maxResumes: 3 });
    vi.spyOn(store, 'getEvents').mockRejectedValue(new Error('disk I/O error'));
    const runner = new FakeRunner(parked);
    const e = await exec(store, runner, 'owner-2');
    await e.bootSweep();
    await started(runner);
    expect(runner.ctxs[0]?.resume).toEqual({ attempt: 1, reason: 'restart', interruptedTools: [] });
    await e.shutdown();
  });
});

/** Hand the row to another claim under a live run: requeue it, then a peer adopts it. */
async function stealRow(store: SQLiteJobStore, id: string): Promise<void> {
  await store.requeueForResume(id, { reason: 'crash', maxResumes: 3 });
  await store.claimNextQueued('owner-2', { adopt: RELEASED });
}

/** A runner that ignores abort for `holdMs`, calling `onAbort` the moment it fires. */
function stubborn(onAbort: (ctx: JobRunnerContext) => void, holdMs = 400): FakeRunner {
  return new FakeRunner(async function* (ctx) {
    yield* noEvents;
    await untilAbort(ctx.signal);
    onAbort(ctx);
    await new Promise((r) => setTimeout(r, holdMs));
  });
}

describe('a lost run goes quiet', () => {
  it('stops its heartbeat the moment it loses the row', async () => {
    const store = new SQLiteJobStore(':memory:');
    const heartbeat = vi.spyOn(store, 'heartbeat');
    const runner = stubborn(() => heartbeat.mockClear());
    const e = await exec(store, runner, 'owner-1');
    const job = await store.create(input());
    e.start();
    e.nudge();
    await started(runner);
    await stealRow(store, job.id);
    await vi.waitFor(() => expect(runner.ctxs[0]?.signal.aborted).toBe(true), {
      timeout: JOB_OBSERVE_MS * 4,
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(heartbeat).not.toHaveBeenCalled();
    await e.shutdown();
  });

  it('does not mark steers read after losing the row', async () => {
    const store = new SQLiteJobStore(':memory:');
    const markRead = vi.spyOn(store, 'markSteersRead');
    const job = await store.create(input());
    await store.addSteer(job.id, { text: 'left', source: 'web' });
    const runner = stubborn((ctx) => {
      ctx.steerSink.drain();
    });
    const e = await exec(store, runner, 'owner-1');
    e.start();
    e.nudge();
    await started(runner);
    await stealRow(store, job.id);
    await vi.waitFor(() => expect(runner.ctxs[0]?.signal.aborted).toBe(true), {
      timeout: JOB_OBSERVE_MS * 4,
    });
    await new Promise((r) => setTimeout(r, JOB_OBSERVE_MS * 2));
    expect(markRead).not.toHaveBeenCalled();
    await e.shutdown();
  });

  it('appends no artifact or log rows once the row is lost', async () => {
    const store = new SQLiteJobStore(':memory:');
    const runner = stubborn((ctx) => {
      ctx.emitArtifact({ path: 'a.txt', change: 'modified', added: 1, removed: 0 });
      ctx.appendLog('stderr', 'late line');
    });
    const e = await exec(store, runner, 'owner-1');
    const job = await store.create(input());
    e.start();
    e.nudge();
    await started(runner);
    await stealRow(store, job.id);
    await vi.waitFor(() => expect(runner.ctxs[0]?.signal.aborted).toBe(true), {
      timeout: JOB_OBSERVE_MS * 4,
    });
    await new Promise((r) => setTimeout(r, 150));
    const events = await store.getEvents(job.id, {});
    expect(events.filter((ev) => ev.eventType === 'artifact_change')).toHaveLength(0);
    expect(events.filter((ev) => ev.eventType === 'runner_log')).toHaveLength(0);
    await e.shutdown();
  });

  it('cannot park the row its successor now holds', async () => {
    const store = new SQLiteJobStore(':memory:');
    const runner = new FakeRunner(parked);
    const e = await exec(store, runner, 'owner-1');
    const job = await store.create(input());
    e.start();
    e.nudge();
    await started(runner);
    await stealRow(store, job.id);
    // Before the observe tick notices: the old run's question still reaches the executor.
    await e.markJobBlocked(job.id, 'q-1');
    expect((await store.get(job.id))?.status).toBe('running');
    await e.shutdown();
  });

  it('losing the row does not cancel the same-process successor questions', async () => {
    const store = new SQLiteJobStore(':memory:');
    const cancelInteractions = vi.fn(async () => {});
    const runner = new FakeRunner(parked);
    const e = await exec(store, runner, 'owner-1', { cancelInteractions });
    const job = await store.create(input());
    e.start();
    e.nudge();
    await started(runner);
    await stealRow(store, job.id);
    await vi.waitFor(() => expect(runner.ctxs[0]?.signal.aborted).toBe(true), {
      timeout: JOB_OBSERVE_MS * 4,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelInteractions).not.toHaveBeenCalled();
    await e.shutdown();
  });
});
