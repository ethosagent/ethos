// plan background-job-steer §4.6 — the durable steer queue, end to end: a real
// SQLiteJobStore (a second handle on the same file stands in for another
// process), the BackgroundExecutor, and a real AgentLoop with a scripted
// provider where the model's view matters.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@ethosagent/core';
import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { SQLiteJobStore } from '@ethosagent/job-store';
import type {
  BackgroundJob,
  CompletionChunk,
  CreateBackgroundJobInput,
  JobRunnerContext,
  JobSteer,
  LLMProvider,
  Message,
} from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import {
  BackgroundExecutor,
  type BackgroundExecutorConfig,
  EthosJobRunner,
  JOB_OBSERVE_MS,
} from '../index';

const OWNER = 'owner-steer';
const CHILD = 'child-steer';

function cfg(over?: Partial<BackgroundExecutorConfig>): BackgroundExecutorConfig {
  return {
    maxConcurrentJobs: 2,
    staleMs: 90_000,
    heartbeatMs: 60_000,
    queuedTtlMs: 900_000,
    maxRootBackgroundUsd: 5.0,
    pollMs: 20,
    ...over,
  };
}

function input(): CreateBackgroundJobInput {
  return {
    owner: OWNER,
    parentSessionKey: 'parent',
    rootSessionKey: 'root-steer',
    childSessionKey: CHILD,
    depth: 1,
    prompt: 'do the thing',
  };
}

const dirs: string[] = [];
const stores: SQLiteJobStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close?.();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Two handles on one jobs.db file: `a` is the owner's, `b` is "another process". */
function twoHandles(): { a: SQLiteJobStore; b: SQLiteJobStore } {
  const dir = mkdtempSync(join(tmpdir(), 'job-steer-'));
  dirs.push(dir);
  const file = join(dir, 'jobs.db');
  const a = new SQLiteJobStore(file);
  const b = new SQLiteJobStore(file);
  stores.push(a, b);
  return { a, b };
}

function textOf(m: Message): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Script {
  calls: Message[][];
  release: () => void;
  loop: AgentLoop;
  session: InMemorySessionStore;
  toolStarted: () => boolean;
}

/**
 * A real AgentLoop. `gated: 'tool'`: call 1 uses a `probe` tool whose execution
 * parks until released, call 2 answers. `gated: 'text'`: call 1 streams text and
 * parks before finishing, call 2 answers. `gated: undefined`: call 1 answers
 * with text only and the steer (already queued) forces call 2.
 */
function realLoop(gated?: 'tool' | 'text'): Script {
  const calls: Message[][] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let started = false;
  const llm: LLMProvider = {
    name: 'scripted',
    model: 'scripted-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      calls.push(messages);
      if (gated === 'tool' && calls.length === 1) {
        yield { type: 'tool_use_start', toolCallId: 'c1', toolName: 'probe' };
        yield { type: 'tool_use_delta', toolCallId: 'c1', partialJson: '{}' };
        yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: `answer ${calls.length}\n\n## Summary\nfinished.` };
      if (gated === 'text' && calls.length === 1) await gate;
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'default', name: 'Default', toolset: ['probe'] });
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'probe',
    description: 'probe',
    schema: { type: 'object' },
    capabilities: {},
    execute: async () => {
      started = true;
      await gate;
      return { ok: true, value: 'probed' };
    },
  });
  const session = new InMemorySessionStore();
  const loop = new AgentLoop({
    llm,
    tools,
    session,
    personalities,
    safety: createTestSafety(),
    compaction: { autoCompact: false },
  });
  return { calls, release: () => release(), loop, session, toolStarted: () => started };
}

async function steerStates(store: SQLiteJobStore, id: string): Promise<JobSteer[]> {
  return (await store.listSteers?.(id)) ?? [];
}

describe('background job steer queue', () => {
  it('steer-cross-process: a steer written through a second handle reaches the next LLM call', async () => {
    const { a, b } = twoHandles();
    const s = realLoop('tool');
    const exec = new BackgroundExecutor({ store: a, loop: s.loop, owner: OWNER, config: cfg() });
    const job = await a.create(input());
    exec.start();
    exec.nudge();
    await vi.waitFor(() => expect(s.toolStarted()).toBe(true), { timeout: 4000 });

    const res = await b.addSteer?.(job.id, { text: 'skip the tests', source: 'web' });
    expect(res?.ok).toBe(true);
    // No poke across processes: the owner's observe tick finds the row.
    await sleep(JOB_OBSERVE_MS + 300);
    s.release();

    await vi.waitFor(async () => expect((await a.get(job.id))?.status).toBe('done'), {
      timeout: 4000,
    });
    expect(s.calls.length).toBeGreaterThanOrEqual(2);
    expect(s.calls[1]?.map(textOf).join('\n')).toContain('[USER STEER]: skip the tests');
    const sess = await s.session.getSessionByKey(CHILD);
    const rows = await s.session.getMessages(sess?.id ?? '');
    expect(rows.some((m) => m.role === 'user_steer')).toBe(true);
    expect((await steerStates(a, job.id)).map((x) => x.state)).toEqual(['read']);
    await exec.shutdown();
  });

  it('queued then started: a steer added while queued is drained at the first seam', async () => {
    const { a } = twoHandles();
    const s = realLoop();
    const exec = new BackgroundExecutor({ store: a, loop: s.loop, owner: OWNER, config: cfg() });
    const job = await a.create(input());
    await a.addSteer?.(job.id, { text: 'queued note', source: 'cli' });
    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await a.get(job.id))?.status).toBe('done'), {
      timeout: 4000,
    });
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]?.map(textOf).join('\n')).toContain('queued note');
    expect((await steerStates(a, job.id))[0]?.state).toBe('read');
    await exec.shutdown();
  });

  it('order: steers A, B, C arrive in one user message in that order', async () => {
    const { a } = twoHandles();
    const s = realLoop();
    const exec = new BackgroundExecutor({ store: a, loop: s.loop, owner: OWNER, config: cfg() });
    const job = await a.create(input());
    for (const t of ['steer-A', 'steer-B', 'steer-C']) {
      await a.addSteer?.(job.id, { text: t, source: 'cli' });
    }
    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await a.get(job.id))?.status).toBe('done'), {
      timeout: 4000,
    });
    const joined = (s.calls[1] ?? []).map(textOf);
    const carrier = joined.find((t) => t.includes('steer-A')) ?? '';
    expect(carrier.indexOf('steer-A')).toBeLessThan(carrier.indexOf('steer-B'));
    expect(carrier.indexOf('steer-B')).toBeLessThan(carrier.indexOf('steer-C'));
    await exec.shutdown();
  });

  it('mark before finish: a steer drained at the final text-end seam is read, not unread', async () => {
    const { a, b } = twoHandles();
    const s = realLoop('text');
    const exec = new BackgroundExecutor({ store: a, loop: s.loop, owner: OWNER, config: cfg() });
    const job = await a.create(input());
    exec.start();
    exec.nudge();
    await vi.waitFor(() => expect(s.calls.length).toBe(1), { timeout: 4000 });
    await b.addSteer?.(job.id, { text: 'late but read', source: 'gateway' });
    await sleep(JOB_OBSERVE_MS + 300);
    s.release();
    await vi.waitFor(async () => expect((await a.get(job.id))?.status).toBe('done'), {
      timeout: 4000,
    });
    expect(s.calls[1]?.map(textOf).join('\n')).toContain('late but read');
    expect((await steerStates(a, job.id))[0]?.state).toBe('read');
    await exec.shutdown();
  });

  it('unread at end: a steer after the last drain ends unread and the row is terminal', async () => {
    const { a } = twoHandles();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let parked = false;
    const loop = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'done.' };
        yield { type: 'done', text: 'done.', turnCount: 1 };
        parked = true;
        await gate;
      },
    } as unknown as AgentLoop;
    const completed: BackgroundJob[] = [];
    const exec = new BackgroundExecutor({ store: a, loop, owner: OWNER, config: cfg() });
    exec.onComplete((j) => completed.push(j));
    const job = await a.create(input());
    exec.start();
    exec.nudge();
    await vi.waitFor(() => expect(parked).toBe(true), { timeout: 4000 });
    const res = await a.addSteer?.(job.id, { text: 'too late', source: 'web' });
    expect(res?.ok).toBe(true);
    release();
    await vi.waitFor(() => expect(completed.length).toBe(1), { timeout: 4000 });
    expect(completed[0]?.status).toBe('done');
    expect((await steerStates(a, job.id))[0]?.state).toBe('unread');
    await exec.shutdown();
  });

  it('stop latency: a cancel from a second handle aborts within the observe cadence', async () => {
    const { a, b } = twoHandles();
    const loop = {
      async *run(_t: string, opts: { abortSignal?: AbortSignal }): AsyncGenerator<AgentEvent> {
        while (!opts.abortSignal?.aborted) {
          await sleep(5);
          yield { type: 'text_delta', text: 'partial work ' };
        }
      },
    } as unknown as AgentLoop;
    // heartbeatMs 60_000: before the observe tick, this waited a whole heartbeat.
    const exec = new BackgroundExecutor({ store: a, loop, owner: OWNER, config: cfg() });
    const job = await a.create(input());
    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await a.get(job.id))?.status).toBe('running'), {
      timeout: 4000,
    });
    const t0 = Date.now();
    await b.requestCancel(job.id);
    await vi.waitFor(async () => expect((await a.get(job.id))?.status).toBe('aborted'), {
      timeout: 4000,
    });
    // Wall-clock, so generous: within two observe ticks, and far below the
    // 60s heartbeat a heartbeat-driven observer would have needed.
    const stopMs = Date.now() - t0;
    expect(stopMs).toBeLessThan(2 * JOB_OBSERVE_MS);
    expect(stopMs).toBeLessThan(60_000 / 10);
    const row = await a.get(job.id);
    expect(row?.error).toBe('cancelled by task_cancel');
    // D9: the partial output is kept.
    expect(row?.summary).toContain('partial work');
    await exec.shutdown();
  });

  it('pokeSteer runs the owner’s observe pass at once', async () => {
    const { a } = twoHandles();
    const s = realLoop('text');
    const exec = new BackgroundExecutor({ store: a, loop: s.loop, owner: OWNER, config: cfg() });
    const job = await a.create(input());
    exec.start();
    exec.nudge();
    await vi.waitFor(() => expect(s.calls.length).toBe(1), { timeout: 4000 });
    await a.addSteer?.(job.id, { text: 'poked', source: 'cli' });
    exec.pokeSteer(job.id);
    await sleep(100);
    s.release();
    await vi.waitFor(async () => expect((await a.get(job.id))?.status).toBe('done'), {
      timeout: 4000,
    });
    expect(s.calls[1]?.map(textOf).join('\n')).toContain('poked');
    exec.pokeSteer('no-such-job');
    await exec.shutdown();
  });

  it('an executor over a store without the steer queue still runs the job', async () => {
    const { a } = twoHandles();
    const bare = new Proxy(a, {
      get(target, prop, recv) {
        if (
          ['addSteer', 'listPendingSteers', 'markSteersRead', 'listSteers'].includes(String(prop))
        ) {
          return undefined;
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const s = realLoop();
    const exec = new BackgroundExecutor({ store: bare, loop: s.loop, owner: OWNER, config: cfg() });
    const job = await a.create(input());
    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await a.get(job.id))?.status).toBe('done'), {
      timeout: 4000,
    });
    await exec.shutdown();
  });
});

describe('EthosJobRunner forwards the steer sink (§7.3)', () => {
  it('hands ctx.steerSink to loop.run unchanged', async () => {
    const seen: Array<unknown> = [];
    const loop = {
      run: (_t: string, opts: { steerSink?: unknown }) => {
        seen.push(opts.steerSink);
        return (async function* () {})();
      },
    } as unknown as AgentLoop;
    const runner = new EthosJobRunner(loop);
    const steerSink = { push: () => false, drain: () => [], depth: () => 0 };
    const ctx = { signal: new AbortController().signal, steerSink } as unknown as JobRunnerContext;
    const { a } = twoHandles();
    const job = await a.create(input());
    for await (const _ of runner.run(job, ctx)) {
      // drain
    }
    expect(seen).toEqual([steerSink]);
    expect(runner.capabilities.steer).toBe(true);
  });
});
