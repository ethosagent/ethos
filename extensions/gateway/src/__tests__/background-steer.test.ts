import type { AgentLoop } from '@ethosagent/core';
import { type BackgroundExecutor, createJobControl } from '@ethosagent/job-runner';
import type {
  AddSteerResult,
  BackgroundJob,
  BackgroundJobEvent,
  BackgroundJobEventType,
  CreateBackgroundJobInput,
  InboundMessage,
  JobSteer,
  JobSteerSource,
  JobStore,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

// ---------------------------------------------------------------------------
// Helpers (same shape as background-wake.test.ts)
// ---------------------------------------------------------------------------

async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

function stubAdapter(): PlatformAdapter {
  return {
    id: 'test',
    displayName: 'Test',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ ok: true, messageId: '1' }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'test',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
    ...overrides,
  };
}

const ID_A = '3f2a1b9c-aaaa-4aaa-8aaa-000000000001';
const ID_B = '9d8e7f60-bbbb-4bbb-8bbb-000000000002';

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  const id = overrides.id ?? ID_A;
  return {
    id,
    owner: 'proc-1',
    parentSessionKey: 'parent',
    rootSessionKey: 'root',
    childSessionKey: `child:${id.slice(0, 8)}`,
    depth: 1,
    status: 'running',
    prompt: 'crawl the docs',
    spendUsd: 0.5,
    createdAt: Date.now(),
    originPlatform: 'test',
    originBotKey: 'b1',
    originChatId: 'chat-1',
    roomAudience: 'private',
    ...overrides,
  };
}

/** In-memory `JobStore` with the optional steer/tail methods the gateway reaches through `JobControl`. */
class FakeJobStore implements JobStore {
  jobs = new Map<string, BackgroundJob>();
  steersByJob = new Map<string, JobSteer[]>();
  eventsByJob = new Map<string, BackgroundJobEvent[]>();
  cancelled: string[] = [];
  addSteerCalls: Array<{ jobId: string; text: string; source: JobSteerSource; user?: string }> = [];
  private seq = 0;
  private steerSeq = 0;

  seed(job: BackgroundJob): BackgroundJob {
    this.jobs.set(job.id, job);
    return job;
  }
  seedSteer(jobId: string, text: string, state: JobSteer['state']): void {
    const list = this.steersByJob.get(jobId) ?? [];
    list.push({
      id: ++this.steerSeq,
      jobId,
      text,
      state,
      source: 'gateway',
      createdAt: Date.now(),
    });
    this.steersByJob.set(jobId, list);
  }
  seedEvent(jobId: string, eventType: BackgroundJobEventType, payload: Record<string, unknown>) {
    const list = this.eventsByJob.get(jobId) ?? [];
    list.push({
      id: list.length + 1,
      jobId,
      seq: list.length + 1,
      eventType,
      payload,
      createdAt: Date.now(),
    });
    this.eventsByJob.set(jobId, list);
  }

  async create(input: CreateBackgroundJobInput): Promise<BackgroundJob> {
    return this.seed({
      spendUsd: 0,
      createdAt: Date.now(),
      ...input,
      id: `0000000${++this.seq}-new`,
      status: 'queued',
    } as BackgroundJob);
  }
  async get(id: string) {
    return this.jobs.get(id) ?? null;
  }
  async claimNextQueued() {
    return null;
  }
  async heartbeat() {}
  async updateSpend() {}
  async requestCancel(id: string) {
    this.cancelled.push(id);
  }
  async markBlocked() {}
  async resumeFromBlocked() {}
  async finish() {}
  async listByRoot() {
    return [];
  }
  async countActiveByRoot() {
    return 0;
  }
  async countActiveByPersonality() {
    return 0;
  }
  async countActive() {
    return 0;
  }
  async reclaimStale() {
    return [];
  }
  async expireQueued() {
    return [];
  }
  async listRunningRemote() {
    return [];
  }
  async pruneTerminal() {
    return 0;
  }
  async listUndelivered() {
    return [];
  }
  async claimDelivery(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.deliveredAt !== undefined) return false;
    job.deliveredAt = Date.now();
    return true;
  }
  async releaseDelivery(id: string) {
    const job = this.jobs.get(id);
    if (job) job.deliveredAt = undefined;
  }
  async claimNotice() {
    return true;
  }
  async releaseNotice() {}
  async appendEvent() {}
  async getEvents(jobId: string, opts?: { limit?: number }) {
    const all = this.eventsByJob.get(jobId) ?? [];
    return opts?.limit ? all.slice(-opts.limit) : all;
  }
  async addSteer(
    jobId: string,
    input: { text: string; source: JobSteerSource; requesterUserId?: string },
  ): Promise<AddSteerResult> {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found' };
    if (!['queued', 'running', 'blocked'].includes(job.status)) {
      return { ok: false, reason: 'finished', status: job.status };
    }
    this.addSteerCalls.push({
      jobId,
      text: input.text,
      source: input.source,
      ...(input.requesterUserId ? { user: input.requesterUserId } : {}),
    });
    this.seedSteer(jobId, input.text, 'pending');
    const steer = (this.steersByJob.get(jobId) ?? []).at(-1) as JobSteer;
    return { ok: true, steer };
  }
  async listSteers(jobId: string) {
    return this.steersByJob.get(jobId) ?? [];
  }
  /** Exact four-field match, newest first — `threadId` undefined matches only no-thread rows. */
  async listByOrigin(
    origin: { platform: string; botKey: string; chatId: string; threadId?: string },
    opts?: { limit?: number },
  ) {
    const rows = [...this.jobs.values()]
      .filter(
        (j) =>
          j.originPlatform === origin.platform &&
          j.originBotKey === origin.botKey &&
          j.originChatId === origin.chatId &&
          j.originThreadId === origin.threadId,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    return opts?.limit ? rows.slice(0, opts.limit) : rows;
  }
}

function fakeExecutor() {
  const handlers: Array<(job: BackgroundJob) => void> = [];
  const exec = {
    owner: 'proc-1',
    nudge: vi.fn(),
    pokeSteer: vi.fn(),
    onComplete: vi.fn((h: (job: BackgroundJob) => void) => {
      handlers.push(h);
      return () => {};
    }),
  };
  return {
    exec,
    executor: exec as unknown as BackgroundExecutor,
    fire: (job: BackgroundJob) => {
      for (const h of handlers) h(job);
    },
  };
}

function gatedLoop() {
  const gates: Array<() => void> = [];
  const state = { started: 0 };
  const loop = {
    run: vi.fn(async function* () {
      state.started++;
      await new Promise<void>((res) => gates.push(res));
      yield { type: 'text_delta' as const, text: 'reply' };
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
  return {
    loop: loop as unknown as AgentLoop,
    state,
    releaseAll: () => {
      while (gates.length) gates.shift()?.();
    },
  };
}

function setup() {
  const g = gatedLoop();
  const ex = fakeExecutor();
  const adapter = stubAdapter();
  const store = new FakeJobStore();
  const jobControl = createJobControl({ store, executor: ex.exec });
  const gw = new Gateway({
    bots: [
      {
        botKey: 'b1',
        loop: g.loop,
        binding: { type: 'personality', name: 'default' },
        backgroundExecutor: ex.executor,
        jobStore: store,
        jobControl,
      },
    ],
    adapters: new Map([['test', adapter]]),
    clarifySweepIntervalMs: 0,
  });
  const say = async (text: string, overrides: Partial<InboundMessage> = {}) => {
    await gw.handleMessage(makeMessage({ text, ...overrides }), adapter);
    const calls = (adapter.send as ReturnType<typeof vi.fn>).mock.calls;
    return String(calls.at(-1)?.[1]?.text ?? '');
  };
  return { g, ex, adapter, store, gw, say };
}

const sentTexts = (adapter: PlatformAdapter): string[] =>
  (adapter.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[1]?.text)
    .filter((t): t is string => typeof t === 'string');

// ---------------------------------------------------------------------------

describe('Gateway — /background steer', () => {
  it('queues a steer for a job in the origin lane and acks', async () => {
    const t = setup();
    t.store.seed(makeJob());
    const reply = await t.say('/background steer 3f2a1b9c skip the tests');
    expect(reply).toBe('↩ noted for job 3f2a1b9c — it reads this at its next step.');
    expect(t.store.addSteerCalls).toEqual([
      { jobId: ID_A, text: 'skip the tests', source: 'gateway', user: 'user-1' },
    ]);
    expect(t.ex.exec.pokeSteer).toHaveBeenCalledWith(ID_A);
  });

  it('is not found from another chat, another thread, or another bot', async () => {
    const t = setup();
    t.store.seed(makeJob({ originChatId: 'chat-2' }));
    expect(await t.say('/background steer 3f2a1b9c x')).toBe('no job 3f2a1b9c in this chat');

    const u = setup();
    u.store.seed(makeJob({ originThreadId: 't1' }));
    expect(await u.say('/background steer 3f2a1b9c x')).toBe('no job 3f2a1b9c in this chat');

    const v = setup();
    v.store.seed(makeJob({ originBotKey: 'b2' }));
    expect(await v.say('/background steer 3f2a1b9c x')).toBe('no job 3f2a1b9c in this chat');
    for (const x of [t, u, v]) expect(x.store.addSteerCalls).toHaveLength(0);
  });

  it('is not found from a group for a job stamped private (D11), found for a shared one', async () => {
    const t = setup();
    t.store.seed(makeJob({ roomAudience: 'private' }));
    t.store.seed(makeJob({ id: ID_B, roomAudience: 'shared', createdAt: Date.now() - 10 }));
    const group = { isDm: false, isGroupMention: true } as const;
    expect(await t.say('/background steer 3f2a1b9c x', group)).toBe('no job 3f2a1b9c in this chat');
    expect(t.store.addSteerCalls).toHaveLength(0);
    const full = await t.say(`/background steer ${ID_B} hi`, group);
    expect(full).toContain('noted for job 9d8e7f60');
    expect(t.store.addSteerCalls.map((c) => c.jobId)).toEqual([ID_B]);
  });

  it('treats `steer the boat` (no ref) as a prompt and launches a job', async () => {
    const t = setup();
    await t.say('/background steer the boat');
    const created = [...t.store.jobs.values()];
    expect(created).toHaveLength(1);
    expect(created[0]?.prompt).toBe('steer the boat');
    expect(t.store.addSteerCalls).toHaveLength(0);
  });

  it('lists the candidates for an ambiguous prefix and steers neither', async () => {
    const t = setup();
    t.store.seed(makeJob());
    t.store.seed(makeJob({ id: '3f2a1b9c-cccc-4ccc-8ccc-000000000003' }));
    const reply = await t.say('/background steer 3f2a1b9c x');
    expect(reply).toContain('matches several jobs');
    expect(reply).toContain('3f2a1b9c, 3f2a1b9c');
    expect(t.store.addSteerCalls).toHaveLength(0);
  });

  it('refuses with the exact texts for unsupported, finished and full', async () => {
    const t = setup();
    t.store.seed(makeJob({ runner: 'claude' }));
    expect(await t.say('/background steer 3f2a1b9c x')).toBe(
      "job 3f2a1b9c runs on claude, which can't take steers — /background stop 3f2a1b9c to stop it",
    );
    const u = setup();
    u.store.seed(makeJob({ status: 'done' }));
    expect(await u.say('/background steer 3f2a1b9c x')).toBe(
      'job 3f2a1b9c already finished (done)',
    );
    const v = setup();
    v.store.seed(makeJob());
    v.store.addSteer = async () => ({ ok: false, reason: 'full' });
    expect(await v.say('/background steer 3f2a1b9c x')).toBe(
      'job 3f2a1b9c already has 32 unread steers — wait for it to catch up',
    );
  });

  it('shows usage for a ref with no text', async () => {
    const t = setup();
    t.store.seed(makeJob());
    expect(await t.say('/background steer 3f2a1b9c')).toBe(
      '✗ Usage: /background steer <id> <text>',
    );
  });
});

describe('Gateway — stop', () => {
  it('/background stop <ref> and /stop <ref> request a cancel and leave the lane turn alone', async () => {
    const t = setup();
    t.store.seed(makeJob());
    expect(await t.say('/background stop 3f2a1b9c')).toBe('✓ Stopping job 3f2a1b9c.');
    expect(await t.say('/stop 3f2a1b9c')).toBe('✓ Stopping job 3f2a1b9c.');
    expect(t.store.cancelled).toEqual([ID_A, ID_A]);
  });

  it('says a finished job already finished', async () => {
    const t = setup();
    t.store.seed(makeJob({ status: 'done' }));
    expect(await t.say('/stop 3f2a1b9c')).toBe('job 3f2a1b9c already finished (done)');
    expect(t.store.cancelled).toHaveLength(0);
  });

  it('plain /stop with nothing running names the lane jobs', async () => {
    const t = setup();
    t.store.seed(makeJob());
    t.store.seed(makeJob({ id: ID_B, status: 'done', createdAt: Date.now() - 5 }));
    expect(await t.say('/stop')).toBe(
      'nothing is running — background: 3f2a1b9c (running) · /stop <id> to stop one',
    );
    expect(t.store.cancelled).toHaveLength(0);
  });

  it('plain /stop with nothing running and no jobs is unchanged', async () => {
    const t = setup();
    expect(await t.say('/stop')).toBe('nothing is running');
  });

  it('/stop <unmatched ref> falls back to the plain stop', async () => {
    const t = setup();
    expect(await t.say('/stop deadbeef')).toBe('nothing is running');
  });

  it('plain /stop with a running turn aborts the lane and leaves the job untouched', async () => {
    const t = setup();
    t.store.seed(makeJob());
    const turn = t.gw.handleMessage(makeMessage({ text: 'go' }), t.adapter);
    await waitUntil(() => t.g.state.started === 1);
    const reply = await t.say('/stop');
    expect(reply).toBe('✓ Stopped.');
    expect(t.store.cancelled).toHaveLength(0);
    t.g.releaseAll();
    await turn;
  });

  it('a group cannot stop a private job (same text as no job)', async () => {
    const t = setup();
    t.store.seed(makeJob({ roomAudience: 'private' }));
    const reply = await t.say('/stop 3f2a1b9c', { isDm: false, isGroupMention: true });
    // Falls through to the plain stop: nothing running, and the private job is not named.
    expect(reply).toBe('nothing is running');
    expect(t.store.cancelled).toHaveLength(0);
  });
});

describe('Gateway — /background list and tail', () => {
  it('lists active lane jobs with id, status, label and spend', async () => {
    const t = setup();
    t.store.seed(makeJob({ label: 'crawl' }));
    t.store.seed(makeJob({ id: ID_B, status: 'done', createdAt: Date.now() - 5 }));
    const reply = await t.say('/background list');
    expect(reply).toContain('3f2a1b9c · running · crawl · $0.50');
    expect(reply).not.toContain('3f2a1b9c · done');
  });

  it('tail starts with the header and stays under 1500 chars, keeping the newest lines', async () => {
    const t = setup();
    t.store.seed(makeJob());
    for (let i = 0; i < 40; i++) {
      t.store.seedEvent(ID_A, 'text', { text: `${i} ${'word '.repeat(80)}` });
    }
    t.store.seedEvent(ID_A, 'tool_headline', { toolName: 'web_search', arg: 'newest' });
    const reply = await t.say('/background tail 3f2a1b9c');
    expect(reply.startsWith('job 3f2a1b9c · running · $0.50\n')).toBe(true);
    expect(reply.length).toBeLessThanOrEqual(1500);
    expect(reply).toContain('tool: web_search newest');
  });

  it('tail drops runner_log and artifact_change', async () => {
    const t = setup();
    t.store.seed(makeJob());
    t.store.seedEvent(ID_A, 'runner_log', { text: 'SECRET-STDOUT' });
    t.store.seedEvent(ID_A, 'artifact_change', { path: 'SECRET-DIFF' });
    t.store.seedEvent(ID_A, 'tool_headline', { toolName: 'shell' });
    const reply = await t.say('/background tail 3f2a1b9c');
    expect(reply).toContain('tool: shell');
    expect(reply).not.toContain('SECRET');
  });

  it('a shared room tailing a private job gets the no-job text', async () => {
    const t = setup();
    t.store.seed(makeJob({ roomAudience: 'private' }));
    t.store.seedEvent(ID_A, 'text', { text: 'private output' });
    const reply = await t.say('/background tail 3f2a1b9c', { isDm: false, isGroupMention: true });
    expect(reply).toBe('no job 3f2a1b9c in this chat');
  });
});

describe('Gateway — completion notice carries unread steers (D8)', () => {
  it('appends at most 3 truncated lines and the count', async () => {
    const t = setup();
    const job = t.store.seed(makeJob({ status: 'done', summary: 'all done' }));
    t.store.seedSteer(ID_A, 'first correction', 'unread');
    t.store.seedSteer(ID_A, 'already read one', 'read');
    t.store.seedSteer(ID_A, `second ${'x'.repeat(300)}`, 'unread');
    t.store.seedSteer(ID_A, 'third', 'unread');
    t.store.seedSteer(ID_A, 'fourth', 'unread');
    t.ex.fire(job);
    await waitUntil(() => sentTexts(t.adapter).some((s) => s.startsWith('background job ')));
    const notice = sentTexts(t.adapter).find((s) => s.startsWith('background job ')) ?? '';
    expect(notice).toContain('(4 messages arrived after it stopped reading:');
    expect(notice).toContain('"first correction"');
    expect(notice).toContain('"third"');
    expect(notice).not.toContain('fourth');
    expect(notice).not.toContain('already read one');
    expect(notice).toContain('+1 more');
    expect(notice).not.toContain('x'.repeat(130));
  });

  it('a done job with no unread steers has an unchanged notice', async () => {
    const t = setup();
    const job = t.store.seed(makeJob({ status: 'done', summary: 'all done' }));
    t.ex.fire(job);
    await waitUntil(() => sentTexts(t.adapter).some((s) => s.startsWith('background job ')));
    const notice = sentTexts(t.adapter).find((s) => s.startsWith('background job ')) ?? '';
    expect(notice).not.toContain('arrived after');
  });

  it('a user-cancelled job gets no notice even with unread steers', async () => {
    const t = setup();
    const job = t.store.seed(
      makeJob({ status: 'aborted', error: 'cancelled by task_cancel', summary: 'partial' }),
    );
    t.store.seedSteer(ID_A, 'late', 'unread');
    t.ex.fire(job);
    await new Promise((r) => setTimeout(r, 20));
    expect(sentTexts(t.adapter).filter((s) => s.startsWith('background job '))).toHaveLength(0);
  });
});
