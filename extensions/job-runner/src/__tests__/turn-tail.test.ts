// F07 (plan/phases/architecture-suggestions-2026-09-10.md) — a background
// job's `done` event is not its finished turn.
//
// The default runner (`EthosJobRunner`) returns `AgentLoop.run()` itself, and
// AgentLoop yields `done` BEFORE its turn-end work (`maybeConsolidateAtTurnEnd`:
// the context engine's `onTurnComplete`, the memory flush, auto-compaction).
// The executor used to `break` on `done`, which closes the generator and skips
// that work. It now drains the iterator before the terminal transition.

import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { SQLiteJobStore } from '@ethosagent/job-store';
import type { CreateBackgroundJobInput } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundExecutor, type BackgroundExecutorConfig } from '../index';

const OWNER = 'owner-tail';

function cfg(): BackgroundExecutorConfig {
  return {
    maxConcurrentJobs: 2,
    staleMs: 90_000,
    heartbeatMs: 15,
    queuedTtlMs: 900_000,
    maxRootBackgroundUsd: 5.0,
    pollMs: 20,
  };
}

function createInput(): CreateBackgroundJobInput {
  return {
    owner: OWNER,
    parentSessionKey: 'parent',
    rootSessionKey: 'root-tail',
    childSessionKey: 'child-tail',
    depth: 1,
    prompt: 'do the thing',
  };
}

/**
 * A loop whose turn answers, yields `done`, then parks in a tail until released.
 * `streamText: false` answers only in `done.text` — a returnDirect tool result;
 * `preamble` streams that text first, as a model does before calling the tool.
 */
function tailedLoop(opts: { streamText?: boolean; preamble?: string } = {}) {
  const state = { parked: false, tailRan: false };
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loop = {
    async *run(): AsyncGenerator<AgentEvent> {
      const text = 'worked on it\n\n## Summary\nThe thing is done.';
      if (opts.preamble) yield { type: 'text_delta', text: opts.preamble };
      else if (opts.streamText !== false) yield { type: 'text_delta', text };
      yield { type: 'done', text, turnCount: 1 };
      state.parked = true;
      await gate;
      state.tailRan = true;
    },
  } as unknown as AgentLoop;
  return { loop, state, release: () => release?.() };
}

describe('BackgroundExecutor drains the child turn past `done` (F07)', () => {
  it('runs the turn-end tail, and finishes the job only once it has', async () => {
    const store = new SQLiteJobStore(':memory:');
    const t = tailedLoop();
    const exec = new BackgroundExecutor({ store, loop: t.loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();

    // The tail is running and the job still holds its slot.
    await vi.waitFor(() => expect(t.state.parked).toBe(true), { timeout: 2000 });
    expect((await store.get(job.id))?.status).toBe('running');

    t.release();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });
    expect(t.state.tailRan).toBe(true);
    expect((await store.get(job.id))?.summary).toBe('The thing is done.');

    await exec.shutdown();
  });

  it('takes the summary from `done.text` when no text streamed — a returnDirect tool result', async () => {
    const store = new SQLiteJobStore(':memory:');
    const t = tailedLoop({ streamText: false });
    const exec = new BackgroundExecutor({ store, loop: t.loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(() => expect(t.state.parked).toBe(true), { timeout: 2000 });
    t.release();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });
    expect((await store.get(job.id))?.summary).toBe('The thing is done.');

    await exec.shutdown();
  });

  it('a returnDirect answer after a streamed preamble is still the job’s output', async () => {
    const store = new SQLiteJobStore(':memory:');
    const t = tailedLoop({ preamble: 'Let me look that up.' });
    const exec = new BackgroundExecutor({ store, loop: t.loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(() => expect(t.state.parked).toBe(true), { timeout: 2000 });
    t.release();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });
    expect((await store.get(job.id))?.summary).toBe('The thing is done.');

    await exec.shutdown();
  });

  // A `task_cancel` observed while the tail drains takes the same branch as a
  // shutdown: the answer is already complete, so the job finishes `done`.
  it('a cancel during the tail does not turn a finished job into an aborted one', async () => {
    const store = new SQLiteJobStore(':memory:');
    const t = tailedLoop();
    const exec = new BackgroundExecutor({ store, loop: t.loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(() => expect(t.state.parked).toBe(true), { timeout: 2000 });

    await store.requestCancel(job.id);
    // Several heartbeats (15 ms each) so the executor observes the cancel.
    await new Promise((r) => setTimeout(r, 80));
    t.release();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });
    expect((await store.get(job.id))?.summary).toBe('The thing is done.');

    await exec.shutdown();
  });

  // Draining widens the window between `done` and the terminal transition to
  // the length of the tail. A shutdown landing in it must not throw away an
  // answer the turn already produced.
  it('a shutdown during the tail does not turn a finished job into an aborted one', async () => {
    const store = new SQLiteJobStore(':memory:');
    const t = tailedLoop();
    const exec = new BackgroundExecutor({ store, loop: t.loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(() => expect(t.state.parked).toBe(true), { timeout: 2000 });

    const stopping = exec.shutdown();
    t.release();
    await stopping;

    const finished = await store.get(job.id);
    expect(finished?.status).toBe('done');
    expect(finished?.summary).toBe('The thing is done.');
    expect(t.state.tailRan).toBe(true);
  });
});
