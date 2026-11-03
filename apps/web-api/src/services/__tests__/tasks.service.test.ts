import type {
  BackgroundJob,
  BackgroundJobEvent,
  BackgroundJobEventType,
  CreateBackgroundJobInput,
  GetJobEventsOptions,
  JobSteer,
  JobStore,
  RunnerCapabilities,
} from '@ethosagent/types';
import type { CreateAgentLoopResult } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { TasksService } from '../tasks.service';

// Minimal in-memory JobStore double — only the methods TasksService touches
// (listByRoot / get / getEvents / requestCancel) carry behaviour; the rest are
// contract-satisfying stubs.
class FakeJobStore implements JobStore {
  jobs = new Map<string, BackgroundJob>();
  events = new Map<string, BackgroundJobEvent[]>();
  canceled: string[] = [];

  seed(job: BackgroundJob, events: BackgroundJobEvent[] = []): void {
    this.jobs.set(job.id, job);
    this.events.set(job.id, events);
  }

  async create(_input: CreateBackgroundJobInput): Promise<BackgroundJob> {
    throw new Error('not used');
  }
  async get(id: string): Promise<BackgroundJob | null> {
    return this.jobs.get(id) ?? null;
  }
  async claimNextQueued(): Promise<BackgroundJob | null> {
    return null;
  }
  async heartbeat(): Promise<void> {}
  async updateSpend(): Promise<void> {}
  async requestCancel(id: string): Promise<void> {
    this.canceled.push(id);
  }
  async markBlocked(): Promise<void> {}
  async resumeFromBlocked(): Promise<void> {}
  async finish(): Promise<void> {}
  async listByRoot(rootSessionKey: string): Promise<BackgroundJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.rootSessionKey === rootSessionKey)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async countActiveByRoot(): Promise<number> {
    return 0;
  }
  async countActiveByPersonality(): Promise<number> {
    return 0;
  }
  async countActive(): Promise<number> {
    return 0;
  }
  async reclaimStale(): Promise<BackgroundJob[]> {
    return [];
  }
  async expireQueued(): Promise<BackgroundJob[]> {
    return [];
  }
  async listRunningRemote(): Promise<BackgroundJob[]> {
    return [];
  }
  async pruneTerminal(): Promise<number> {
    return 0;
  }
  async listUndelivered(): Promise<BackgroundJob[]> {
    return [];
  }
  async claimDelivery(): Promise<boolean> {
    return true;
  }
  async releaseDelivery(): Promise<void> {}
  async claimNotice(): Promise<boolean> {
    return true;
  }
  async releaseNotice(): Promise<void> {}
  async appendEvent(): Promise<void> {}
  async getEvents(jobId: string, opts?: GetJobEventsOptions): Promise<BackgroundJobEvent[]> {
    const list = this.events.get(jobId) ?? [];
    // The service reads a bounded tail (I21); the double honours it rather than
    // returning everything and letting a broken bound pass unnoticed.
    const cursor = opts?.afterSeq;
    const after = cursor === undefined ? list : list.filter((e) => e.seq > cursor);
    return opts?.limit === undefined ? after : after.slice(-opts.limit);
  }
}

type Control = NonNullable<CreateAgentLoopResult['jobControl']>;

const STEER_CAPS: RunnerCapabilities = {
  interactionKinds: [],
  answerScopes: [],
  takeover: 'none',
  resume: 'none',
  steer: true,
  sandbox: 'none',
  transport: 'in-process',
};

/** Records calls and returns canned outcomes; the real JobControl lives in job-runner. */
function fakeControl(over: Partial<Control> = {}): Control & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    capabilitiesFor: () => STEER_CAPS,
    steer: async (_job, req) => {
      calls.push(`steer:${req.source}:${req.requesterAudience}:${req.text}`);
      return { ok: true, steerId: 7 };
    },
    stop: async (_job, req) => {
      calls.push(`stop:${req.requesterAudience}`);
      return { ok: true, wasRunning: true };
    },
    tail: async (_job, req) => {
      calls.push(`tail:${req.audience}:${req.afterSeq}:${req.limit}`);
      return { ok: true, events: [makeEvent({ id: 9, seq: 5, eventType: 'text' })] };
    },
    steers: async (): Promise<JobSteer[]> => [
      { id: 7, jobId: 'job-1', text: 'hi', state: 'pending', source: 'web', createdAt: 5 },
    ],
    ...over,
  };
}

function makeJob(over: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'job-1',
    owner: 'proc-a',
    parentSessionKey: 'web:parent',
    rootSessionKey: 'web:root',
    childSessionKey: 'web:parent:job:x:job-1',
    depth: 1,
    status: 'running',
    prompt: 'do the thing',
    spendUsd: 0.42,
    createdAt: 1000,
    startedAt: 1100,
    ...over,
  };
}

function makeEvent(over: Partial<BackgroundJobEvent> = {}): BackgroundJobEvent {
  return {
    id: 1,
    jobId: 'job-1',
    seq: 0,
    eventType: 'queued' as BackgroundJobEventType,
    payload: {},
    createdAt: 1000,
    ...over,
  };
}

describe('TasksService', () => {
  it('list returns [] when no rootSessionKey (no global list in the frozen contract)', async () => {
    const store = new FakeJobStore();
    store.seed(makeJob());
    const svc = new TasksService({ store });
    expect(await svc.list()).toEqual([]);
  });

  it('list scopes to root and maps undefined optionals to null', async () => {
    const store = new FakeJobStore();
    store.seed(makeJob({ id: 'a', createdAt: 2000 }));
    store.seed(makeJob({ id: 'b', createdAt: 1000, rootSessionKey: 'web:other' }));
    const svc = new TasksService({ store });

    const rows = await svc.list('web:root');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.id).toBe('a');
    // undefined optionals become explicit null on the wire
    expect(row?.label).toBeNull();
    expect(row?.personalityId).toBeNull();
    expect(row?.maxCostUsd).toBeNull();
    expect(row?.finishedAt).toBeNull();
    expect(row?.startedAt).toBe(1100);
    expect(row?.spendUsd).toBe(0.42);
  });

  it('get merges the job with its ordered event trail', async () => {
    const store = new FakeJobStore();
    store.seed(makeJob({ label: 'sync', summary: 'done well', personalityId: 'scout' }), [
      makeEvent({ seq: 0, eventType: 'queued' }),
      makeEvent({ id: 2, seq: 1, eventType: 'done', payload: { spendUsd: 0.42 } }),
    ]);
    const svc = new TasksService({ store });

    const detail = await svc.get('job-1');
    expect(detail?.prompt).toBe('do the thing');
    expect(detail?.summary).toBe('done well');
    expect(detail?.error).toBeNull();
    expect(detail?.events).toHaveLength(2);
    expect(detail?.events[1]?.eventType).toBe('done');
  });

  it('get returns null for a missing job', async () => {
    const svc = new TasksService({ store: new FakeJobStore() });
    expect(await svc.get('nope')).toBeNull();
  });

  it('cancel requests cancellation and reports ok', async () => {
    const store = new FakeJobStore();
    store.seed(makeJob());
    const svc = new TasksService({ store });
    expect(await svc.cancel('job-1')).toEqual({ ok: true });
    expect(store.canceled).toEqual(['job-1']);
  });

  it('degrades gracefully when no store is wired', async () => {
    const svc = new TasksService({});
    expect(await svc.list('web:root')).toEqual([]);
    expect(await svc.get('job-1')).toBeNull();
    expect(await svc.cancel('job-1')).toEqual({ ok: false });
  });

  describe('with a JobControl', () => {
    it('steer maps the outcome and steers as a private web requester', async () => {
      const store = new FakeJobStore();
      store.seed(makeJob());
      const control = fakeControl();
      const svc = new TasksService({ store, control });
      expect(await svc.steer('job-1', 'only apps/')).toEqual({ ok: true, steerId: 7 });
      expect(control.calls).toEqual(['steer:web:private:only apps/']);
    });

    it('steer passes a refusal through and reports not_found / not_available', async () => {
      const store = new FakeJobStore();
      store.seed(makeJob());
      const control = fakeControl({
        steer: async () => ({ ok: false, reason: 'finished', status: 'done' }),
      });
      expect(await new TasksService({ store, control }).steer('job-1', 'x')).toEqual({
        ok: false,
        reason: 'finished',
        status: 'done',
      });
      expect(await new TasksService({ store, control }).steer('nope', 'x')).toEqual({
        ok: false,
        reason: 'not_found',
      });
      expect(await new TasksService({ store }).steer('job-1', 'x')).toEqual({
        ok: false,
        reason: 'not_available',
      });
    });

    it('get carries capabilities for a default-runner row and the steers', async () => {
      const store = new FakeJobStore();
      store.seed(makeJob()); // no `runner` field: the default-runner row
      const detail = await new TasksService({ store, control: fakeControl() }).get('job-1');
      expect(detail?.capabilities?.steer).toBe(true);
      expect(detail?.steers).toEqual([
        {
          id: 7,
          jobId: 'job-1',
          text: 'hi',
          state: 'pending',
          source: 'web',
          requesterUserId: null,
          createdAt: 5,
          readAt: null,
        },
      ]);
    });

    it('get without a control reports no capabilities and no steers', async () => {
      const store = new FakeJobStore();
      store.seed(makeJob());
      const detail = await new TasksService({ store }).get('job-1');
      expect(detail?.capabilities).toBeNull();
      expect(detail?.steers).toEqual([]);
    });

    it('events returns rows after the cursor through the operator tail', async () => {
      const store = new FakeJobStore();
      store.seed(makeJob());
      const control = fakeControl();
      const res = await new TasksService({ store, control }).events('job-1', 4, 100);
      expect(res.ok && res.events.map((e) => e.seq)).toEqual([5]);
      expect(control.calls).toEqual(['tail:operator:4:100']);
    });

    it('events without a control reads the store after the cursor', async () => {
      const store = new FakeJobStore();
      store.seed(makeJob(), [
        makeEvent({ id: 1, seq: 1 }),
        makeEvent({ id: 2, seq: 2 }),
        makeEvent({ id: 3, seq: 3 }),
      ]);
      const res = await new TasksService({ store }).events('job-1', 1);
      expect(res.ok && res.events.map((e) => e.seq)).toEqual([2, 3]);
      expect(await new TasksService({ store }).events('nope')).toEqual({
        ok: false,
        reason: 'not_found',
      });
    });

    it('cancel routes through stop, and is not ok for a finished job', async () => {
      const store = new FakeJobStore();
      store.seed(makeJob());
      const control = fakeControl();
      expect(await new TasksService({ store, control }).cancel('job-1')).toEqual({ ok: true });
      expect(control.calls).toEqual(['stop:private']);
      expect(store.canceled).toEqual([]);
      const finished = fakeControl({
        stop: async () => ({ ok: false, reason: 'finished', status: 'done' }),
      });
      expect(await new TasksService({ store, control: finished }).cancel('job-1')).toEqual({
        ok: false,
      });
    });
  });
});
