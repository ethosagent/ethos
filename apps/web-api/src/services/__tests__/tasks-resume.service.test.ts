// durable-background-jobs C3 — TasksService.resume over a real SQLiteJobStore
// and the real createJobControl.

import type { CreateBackgroundJobInput, JobRunner, JobRunnerRegistry } from '@ethosagent/types';
import { type CreateAgentLoopResult, createJobControl, SQLiteJobStore } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { TasksService } from '../tasks.service';

const NO_RESUME = {
  interactionKinds: [],
  answerScopes: [],
  takeover: 'none',
  resume: 'none',
  steer: false,
  sandbox: 'none',
  transport: 'in-process',
} as const;

type Control = NonNullable<CreateAgentLoopResult['jobControl']>;

function input(over?: Partial<CreateBackgroundJobInput>): CreateBackgroundJobInput {
  return {
    owner: 'o',
    parentSessionKey: 'p',
    rootSessionKey: 'r',
    childSessionKey: 'c',
    depth: 1,
    prompt: 'x',
    roomAudience: 'private',
    ...over,
  };
}

async function claimed(store: SQLiteJobStore, over?: Partial<CreateBackgroundJobInput>) {
  await store.create(input(over));
  const job = await store.claimNextQueued('o');
  if (!job) throw new Error('claim failed');
  return job;
}

function build(registry?: JobRunnerRegistry) {
  const store = new SQLiteJobStore(':memory:');
  const control: Control = createJobControl({
    store,
    ...(registry ? { runners: registry } : {}),
    executor: {
      pokeSteer() {},
      requeueStale: (id) => store.requeueStale(id, 'released:web:host:serve'),
    },
  });
  return {
    store,
    svc: new TasksService({ store, control, ...(registry ? { runners: registry } : {}) }),
  };
}

describe('TasksService.resume', () => {
  it('requeues a stale Ethos row', async () => {
    const { store, svc } = build();
    const job = await claimed(store);
    await store.reclaimStale(-1);
    expect(await svc.resume(job.id)).toEqual({ ok: true });
    expect((await store.get(job.id))?.status).toBe('queued');
  });

  it('refuses a done row with not_stale', async () => {
    const { store, svc } = build();
    const job = await claimed(store);
    await store.finish(job.id, 'done', { summary: 's' });
    expect(await svc.resume(job.id)).toMatchObject({
      ok: false,
      reason: 'not_stale',
      status: 'done',
    });
  });

  it('refuses a runner that cannot resume', async () => {
    const runner = {
      name: 'fake',
      capabilities: { ...NO_RESUME },
    } as unknown as JobRunner;
    const registry = {
      get: (n: string) => (n === 'fake' ? runner : undefined),
    } as unknown as JobRunnerRegistry;
    const { store, svc } = build(registry);
    const job = await claimed(store, { runner: 'fake' });
    await store.reclaimStale(-1);
    expect(await svc.resume(job.id)).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('unknown id is not_found', async () => {
    const { svc } = build();
    expect(await svc.resume('nope')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('without a control it is not_available', async () => {
    const store = new SQLiteJobStore(':memory:');
    expect(await new TasksService({ store }).resume('x')).toEqual({
      ok: false,
      reason: 'not_available',
    });
    expect(await new TasksService({}).resume('x')).toEqual({ ok: false, reason: 'not_available' });
  });
});
