// durable-background-jobs C2 — JobControl.resume: audience gate (D11), status,
// capability and executor seam.

import { SQLiteJobStore } from '@ethosagent/job-store';
import type {
  CreateBackgroundJobInput,
  JobRunner,
  JobRunnerRegistry,
  RunnerCapabilities,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createJobControl, ETHOS_RUNNER_CAPABILITIES } from '../index';

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

async function staleJob(store: SQLiteJobStore, over?: Partial<CreateBackgroundJobInput>) {
  await store.create(input(over));
  const claimed = await store.claimNextQueued('o');
  if (!claimed) throw new Error('claim failed');
  await store.reclaimStale(-1);
  const job = await store.get(claimed.id);
  if (job?.status !== 'stale') throw new Error(`expected stale, got ${job?.status}`);
  return job;
}

function setup(registry?: JobRunnerRegistry) {
  const store = new SQLiteJobStore(':memory:');
  const requeued: string[] = [];
  const control = createJobControl({
    store,
    ...(registry ? { runners: registry } : {}),
    executor: {
      pokeSteer() {},
      requeueStale: async (id) => {
        requeued.push(id);
        return store.requeueStale(id, 'released:web:host:serve');
      },
    },
  });
  return { store, control, requeued };
}

describe('JobControl.resume', () => {
  it('requeues a stale Ethos row', async () => {
    const { store, control, requeued } = setup();
    const job = await staleJob(store);
    expect(await control.resume(job, { requesterAudience: 'private' })).toEqual({ ok: true });
    expect(requeued).toEqual([job.id]);
    expect((await store.get(job.id))?.status).toBe('queued');
  });

  it('refuses a row that is not stale and reports its status', async () => {
    const { store, control } = setup();
    await store.create(input());
    const job = await store.claimNextQueued('o');
    if (!job) throw new Error('claim failed');
    expect(await control.resume(job, { requesterAudience: 'private' })).toEqual({
      ok: false,
      reason: 'not_stale',
      status: 'running',
    });
  });

  it('refuses a runner whose capabilities say resume none', async () => {
    const caps: RunnerCapabilities = { ...ETHOS_RUNNER_CAPABILITIES, resume: 'none' };
    const runner = { name: 'fake', capabilities: caps } as unknown as JobRunner;
    const registry = {
      get: (n: string) => (n === 'fake' ? runner : undefined),
    } as unknown as JobRunnerRegistry;
    const { store, control } = setup(registry);
    const job = await staleJob(store, { runner: 'fake' });
    expect(await control.resume(job, { requesterAudience: 'private' })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('refuses a session-resume runner that cannot auto-resume (Pi re-sends the prompt)', async () => {
    const caps: RunnerCapabilities = {
      ...ETHOS_RUNNER_CAPABILITIES,
      resume: 'session',
      autoResume: false,
    };
    const runner = { name: 'fake', capabilities: caps } as unknown as JobRunner;
    const registry = {
      get: (n: string) => (n === 'fake' ? runner : undefined),
    } as unknown as JobRunnerRegistry;
    const { store, control, requeued } = setup(registry);
    const job = await staleJob(store, { runner: 'fake' });
    expect(await control.resume(job, { requesterAudience: 'private' })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(requeued).toEqual([]);
  });

  it('reports not_available when the executor cannot requeue', async () => {
    const store = new SQLiteJobStore(':memory:');
    const control = createJobControl({ store, executor: { pokeSteer() {} } });
    const job = await staleJob(store);
    expect(await control.resume(job, { requesterAudience: 'private' })).toMatchObject({
      ok: false,
      reason: 'not_available',
    });
  });

  it('a shared-room requester cannot resume a private job (D11): not_found', async () => {
    const { store, control, requeued } = setup();
    const job = await staleJob(store);
    expect(await control.resume(job, { requesterAudience: 'shared' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(requeued).toEqual([]);
  });
});
